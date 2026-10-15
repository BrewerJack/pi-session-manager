// Worker: runs one pi session in its own process and draws it to a SocketTerminal.
// Clients attach over a Unix socket. Detach, /quit, and a closed client all leave the
// session alive. A stop from the supervisor, or SIGTERM, ends the worker.
//
// boot.mjs loads this file through the jiti of pi. pi itself comes in as `sdk` and
// `tui`, so the worker shares one module instance with pi and its extensions.
import { mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	connect,
	type Connection,
	type Inheritance,
	type Message,
	type Outcome,
	type ReplyData,
	type WorkerUpdate,
} from "./control.ts";
import { openLog, routeConsoleToLog, type Log } from "./filelog.ts";
import {
	encodeFrame,
	encodeJsonFrame,
	FrameDecoder,
	FrameType,
	parseJson,
	type AttachHello,
	type Detached,
	type DetachReason,
	type TerminalSize,
} from "./protocol.ts";
import { applyNetworkSettings, createRuntimeFactory } from "./runtime.ts";
import { SocketTerminal, type TuiDeps } from "./socket-terminal.ts";
import { firstUserText, lastExchange, summarizeToolArgs, transcriptOf, type Usage } from "./transcript.ts";

type Sdk = typeof import("@earendil-works/pi-coding-agent");

/** A worker without a supervisor for this long ends itself (spec §7.6). */
const ORPHAN_AFTER_MS = 60_000;
const RECONNECT_MS = 2_000;
/** Streaming text goes to the supervisor at most this often (spec §8.5). */
const REPLY_THROTTLE_MS = 250;

export interface WorkerOptions {
	id: string;
	/** Control socket of the supervisor. */
	supervisor: string;
	/** Socket that clients attach to. */
	socket: string;
	logFile: string;
	cwd: string;
	sessionFile?: string;
	task?: string;
	name?: string;
	inherit: Inheritance;
	/** Root of the pi package, for modules that pi does not export. */
	piDir: string;
}

export function parseWorkerArgs(argv: string[], piDir: string): WorkerOptions {
	const { values } = parseArgs({
		args: argv,
		options: {
			id: { type: "string" },
			supervisor: { type: "string" },
			socket: { type: "string" },
			log: { type: "string" },
			cwd: { type: "string" },
			session: { type: "string" },
			task: { type: "string" },
			name: { type: "string" },
			model: { type: "string" },
			thinking: { type: "string" },
			tools: { type: "string" },
		},
	});
	const { id, supervisor, socket, log, cwd } = values;
	if (!id || !supervisor || !socket || !log || !cwd) {
		throw new Error("worker needs --id, --supervisor, --socket, --log, and --cwd.");
	}
	const inherit: Inheritance = {};
	const slash = values.model?.indexOf("/") ?? -1;
	if (values.model && slash > 0) inherit.model = { provider: values.model.slice(0, slash), id: values.model.slice(slash + 1) };
	if (values.thinking) inherit.thinkingLevel = values.thinking;
	if (values.tools !== undefined) inherit.tools = values.tools.split(",").filter(Boolean);
	return {
		id,
		supervisor,
		socket,
		logFile: log,
		cwd,
		sessionFile: values.session,
		task: values.task,
		name: values.name,
		inherit,
		piDir,
	};
}

export async function runWorker(sdk: Sdk, tui: TuiDeps, options: WorkerOptions): Promise<void> {
	const log = openLog(options.logFile);
	routeConsoleToLog(log);
	process.on("SIGHUP", () => log("SIGHUP ignored"));
	process.on("unhandledRejection", (error) => log("unhandledRejection", error));

	const run = new RunState();
	run.log = log;
	let runtime: any;
	let attachments: Attachments | undefined;
	const session = () => runtime?.session;
	const link = new SupervisorLink(options, log, {
		stop: () => attachments?.stop("stopped"),
		orphan: () => attachments?.stop("stopped", "The supervisor is gone.") ?? process.exit(0),
		request: (message) => answer(session(), run, message),
	});
	run.isAttached = () => attachments?.attached ?? false;

	const agentDir = sdk.getAgentDir();
	const sessionManager = options.sessionFile
		? sdk.SessionManager.open(options.sessionFile, undefined, undefined)
		: sdk.SessionManager.create(options.cwd, undefined, {});
	const factory = createRuntimeFactory(sdk, options.piDir, reporter(link, run, session), options.inherit, log);
	runtime = await sdk.createAgentSessionRuntime(factory, {
		cwd: sessionManager.getCwd?.() || options.cwd,
		agentDir,
		sessionManager,
	});
	await applyNetworkSettings(options.piDir, runtime.services.settingsManager, log);
	const sm = runtime.session.sessionManager;
	if (options.name?.trim() && !sm.getSessionName?.()) runtime.session.setSessionName(options.name.trim());
	link.update({ ...sessionMeta(sm), ...sessionFacts(runtime.session), state: "idle" });

	const terminal = new SocketTerminal(tui);
	const mode = new sdk.InteractiveMode(runtime, {
		migratedProviders: [],
		modelFallbackMessage: runtime.modelFallbackMessage,
		initialMessage: options.task?.trim() || undefined,
		initialImages: [],
		initialMessages: [],
		terminal,
	});
	attachments = new Attachments(mode, terminal, log, run, (patch) => link.update(patch));
	attachments.patchShutdown();
	publishBridge(options.id, attachments, run);

	const hangupBefore = new Set(process.listeners("SIGHUP"));
	await mode.init();
	// pi shuts down on SIGHUP. A worker has no terminal to lose, so it keeps running (spec §8.3).
	for (const listener of process.listeners("SIGHUP")) {
		if (!hangupBefore.has(listener)) process.off("SIGHUP", listener);
	}
	// No client holds the session yet. Stop the TUI so it does not render for nobody.
	attachments.parkUi();

	const server = await listen(options.socket, (socket) => attachments?.accept(socket));
	process.on("exit", () => {
		server.close();
		rmSync(options.socket, { force: true });
	});
	log(`worker ${options.id} ready on ${options.socket}`);
	link.start();

	await mode.run();
}

// ---------------------------------------------------------------------------
// Requests from the supervisor (spec §10.1)

async function answer(session: any, run: RunState, message: Message): Promise<ReplyData> {
	if (!session) throw new Error("The session is not ready.");
	switch (message.type) {
		case "send": {
			const text = String(message.text ?? "").trim();
			if (!text) throw new Error("The message is empty.");
			// A busy session queues the message until the run ends.
			const options = session.isStreaming ? { deliverAs: "followUp" } : undefined;
			session.sendUserMessage(text, options).catch((error: unknown) => run.log?.("send failed", error));
			return {};
		}
		case "interrupt":
			await session.abort();
			return {};
		case "rename":
			session.setSessionName(String(message.name ?? "").trim());
			return {};
		case "transcript": {
			const items = transcriptOf(session.sessionManager.getBranch(), Number(message.max) || 120);
			if (run.running && run.reply?.trim()) items.push({ kind: "assistant", text: run.reply.trim() });
			return { items };
		}
		case "stats":
			return { usage: usageOf(session) ?? null };
		default:
			throw new Error(`Unknown request "${message.type}".`);
	}
}

// ---------------------------------------------------------------------------
// State reports: an inline extension forwards session events to the supervisor (spec §8.5).

function sessionMeta(sm: any): WorkerUpdate {
	const meta: WorkerUpdate = {};
	try {
		meta.sessionFile = sm.getSessionFile?.() ?? undefined;
		meta.sessionId = sm.getSessionId?.() ?? undefined;
		meta.name = sm.getSessionName?.() || undefined;
		meta.cwd = sm.getCwd?.() || undefined;
		meta.firstPrompt = firstUserText(sm.getEntries?.() ?? []);
	} catch {
		// Partial metadata is still useful.
	}
	return meta;
}

/** Token use from pi, which also knows the context use. */
function usageOf(session: any): Usage | undefined {
	try {
		const s = session.getSessionStats();
		return {
			input: s.tokens.input,
			output: s.tokens.output,
			cacheRead: s.tokens.cacheRead,
			cacheWrite: s.tokens.cacheWrite,
			cost: s.cost,
			userMessages: s.userMessages,
			assistantMessages: s.assistantMessages,
			toolCalls: s.toolCalls,
			contextTokens: s.contextUsage?.tokens ?? null,
			contextWindow: s.contextUsage?.contextWindow ?? null,
			contextPercent: s.contextUsage?.percent ?? null,
		};
	} catch {
		return undefined;
	}
}

function modelLabel(session: any): string | null {
	const id: string | undefined = session?.model?.id;
	if (!id) return null;
	const thinking: string | undefined = session.thinkingLevel;
	return thinking && thinking !== "off" ? `${id} · ${thinking}` : id;
}

/** Model, usage, and the last exchange: what the list shows of a session. */
function sessionFacts(session: any): WorkerUpdate {
	const facts: WorkerUpdate = { modelLabel: modelLabel(session) };
	const usage = usageOf(session);
	if (usage) facts.usage = usage;
	try {
		const { prompt, reply } = lastExchange(session.sessionManager.getBranch());
		facts.lastPrompt = prompt ?? null;
		facts.lastReply = reply ?? null;
	} catch {
		// The list keeps the previous values.
	}
	return facts;
}

/** What the worker knows about the current run. The reporter writes it, the attach recap reads it. */
export class RunState {
	/** The context of the current session, for notices. */
	ctx?: ExtensionContext;
	log?: Log;
	running = false;
	runStartedAt?: number;
	settledAt?: number;
	lastRunMs?: number;
	lastOutcome?: Outcome;
	error?: string;
	dialogs = 0;
	/** The tail of the reply that streams in. */
	reply?: string;
	/** Custom UIs of this package that must not count as dialogs. */
	ownPrompts = 0;
	ignoredPromptEnds = 0;
	isAttached: () => boolean = () => false;
}

function reporter(link: SupervisorLink, run: RunState, session: () => any) {
	return (pi: ExtensionAPI) => {
		const state = () => (run.dialogs > 0 ? "waiting" : run.running ? "working" : "idle");
		let replyTimer: ReturnType<typeof setTimeout> | undefined;
		const flushReply = () => {
			replyTimer = undefined;
			if (run.running && run.reply) link.update({ reply: run.reply });
		};
		const clearReply = () => {
			if (replyTimer) clearTimeout(replyTimer);
			replyTimer = undefined;
			run.reply = undefined;
		};

		pi.on("session_start", (_event, ctx) => {
			run.ctx = ctx;
			run.running = false;
			run.dialogs = 0;
			clearReply();
			link.update({ ...sessionMeta(ctx.sessionManager), ...sessionFacts(session()), state: state(), tool: null, reply: null });
		});
		pi.on("session_info_changed", (event) => link.update({ name: event.name || null }));
		pi.on("model_select", () => link.update({ modelLabel: modelLabel(session()) }));
		pi.on("thinking_level_select", () => link.update({ modelLabel: modelLabel(session()) }));
		pi.on("agent_start", () => {
			run.running = true;
			run.runStartedAt = Date.now();
			run.error = undefined;
			clearReply();
			link.update({ state: state(), error: null, lastOutcome: null, runStartedAt: run.runStartedAt, tool: null });
		});
		pi.on("message_update", (event) => {
			const message: any = event.message;
			if (message?.role !== "assistant") return;
			const parts = Array.isArray(message.content) ? message.content : [];
			run.reply = parts
				.flatMap((p: any) => (p?.type === "text" && typeof p.text === "string" ? [p.text] : []))
				.join(" ")
				.slice(-2000);
			replyTimer ??= setTimeout(flushReply, REPLY_THROTTLE_MS);
		});
		pi.on("message_end", (event, ctx) => {
			const message: any = event.message;
			if (message?.role === "assistant" && message.stopReason === "error" && message.errorMessage) {
				run.error = String(message.errorMessage);
			}
			clearReply();
			// pi writes the session file at the first message. Report its path then.
			const meta = message?.role === "user" ? sessionMeta(ctx.sessionManager) : {};
			link.update({ ...meta, ...sessionFacts(session()), reply: null });
		});
		pi.on("tool_execution_start", (event) => {
			if (event.parentToolCallId) return;
			const detail = summarizeToolArgs(event.toolName, event.args);
			link.update({ tool: { name: event.toolName, detail, startedAt: Date.now() } });
		});
		pi.on("tool_execution_end", (event) => {
			if (!event.parentToolCallId) link.update({ tool: null });
		});
		pi.on("agent_settled", (event) => {
			const now = Date.now();
			run.running = false;
			run.settledAt = now;
			run.lastRunMs = run.runStartedAt ? now - run.runStartedAt : undefined;
			run.lastOutcome = event.aborted ? "aborted" : run.error ? "error" : "done";
			clearReply();
			link.update({
				...sessionFacts(session()),
				state: state(),
				lastOutcome: run.lastOutcome,
				error: run.error ?? null,
				lastRunMs: run.lastRunMs ?? null,
				runStartedAt: null,
				tool: null,
				reply: null,
				unread: run.isAttached() ? null : true,
			});
		});
		pi.on("ui_prompt_start", (event: any) => {
			// The manager overlay of this package is a custom UI too. It is no dialog of the session.
			if (event.kind === "custom" && run.ownPrompts > 0) {
				run.ownPrompts--;
				run.ignoredPromptEnds++;
				return;
			}
			run.dialogs++;
			link.update({ state: state(), promptTitle: event.title || null });
		});
		pi.on("ui_prompt_end", (event: any) => {
			if (event.kind === "custom" && run.ignoredPromptEnds > 0) {
				run.ignoredPromptEnds--;
				return;
			}
			run.dialogs = Math.max(0, run.dialogs - 1);
			link.update({ state: state(), ...(run.dialogs ? {} : { promptTitle: null }) });
		});
	};
}

function fmtSpan(ms: number): string {
	const sec = Math.max(0, Math.floor(ms / 1000));
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const hour = Math.floor(min / 60);
	if (hour < 24) return `${hour}h ${min % 60}m`;
	return `${Math.floor(hour / 24)}d`;
}

/**
 * One line for a client that attaches: the last outcome, and the time since the user last
 * looked (spec §7.3). Nothing when nothing happened since then.
 */
export function recap(run: RunState, lastSeenAt: number | undefined, now = Date.now()): { text: string; type: "info" | "warning" | "error" } | undefined {
	const looked = lastSeenAt ? ` You last looked ${fmtSpan(now - lastSeenAt)} ago.` : "";
	if (run.dialogs > 0) return { text: `? This session waits for your input.${looked}`, type: "warning" };
	if (run.running) {
		const since = run.runStartedAt ? ` for ${fmtSpan(now - run.runStartedAt)}` : "";
		return lastSeenAt ? { text: `Still working${since}.${looked}`, type: "info" } : undefined;
	}
	if (!run.lastOutcome || !run.settledAt || (lastSeenAt && run.settledAt <= lastSeenAt)) return undefined;
	const ago = `${fmtSpan(now - run.settledAt)} ago`;
	const took = run.lastRunMs ? ` after ${fmtSpan(run.lastRunMs)}` : "";
	if (run.lastOutcome === "error") return { text: `✗ Failed ${ago}: ${run.error ?? "error"}.${looked}`, type: "error" };
	if (run.lastOutcome === "aborted") return { text: `■ Interrupted ${ago}.${looked}`, type: "warning" };
	return { text: `✓ Done ${ago}${took}.${looked}`, type: "info" };
}

/** The extension of this package reaches the worker through this object (spec §7.4). */
export interface WorkerBridge {
	id: string;
	/** Detach the client that holds this session. */
	detach(): void;
	/** Detach the client and tell it to attach to another session. */
	switchTo(id: string): void;
	/** Run a custom UI of this package, which must not count as a dialog of the session. */
	ownPrompt<T>(show: () => Promise<T>): Promise<T>;
}

export const WORKER_BRIDGE_KEY = Symbol.for("pi-session-manager.worker");

function publishBridge(id: string, attachments: Attachments, run: RunState): void {
	const bridge: WorkerBridge = {
		id,
		detach: () => attachments.detach("quit"),
		switchTo: (target) => attachments.switchTo(target),
		ownPrompt: async (show) => {
			run.ownPrompts++;
			try {
				return await show();
			} finally {
				// pi may not report the custom UI as a prompt. Drop the unused marker then.
				if (run.ownPrompts > 0) run.ownPrompts--;
			}
		},
	};
	(globalThis as Record<symbol, unknown>)[WORKER_BRIDGE_KEY] = bridge;
}

// ---------------------------------------------------------------------------
// SupervisorLink: the control connection of the worker. It reconnects when the
// supervisor restarts, and ends the worker after a minute without one.

interface LinkActions {
	stop: () => void;
	orphan: () => void;
	/** Every request other than stop. */
	request: (message: Message) => Promise<ReplyData>;
}

class SupervisorLink {
	private connection?: Connection;
	/** Everything reported so far. A new connection receives it with the hello. */
	private snapshot: WorkerUpdate = {};
	private lostSince = Date.now();
	private retry?: ReturnType<typeof setTimeout>;
	private readonly options: WorkerOptions;
	private readonly log: Log;
	private readonly actions: LinkActions;

	constructor(options: WorkerOptions, log: Log, actions: LinkActions) {
		this.options = options;
		this.log = log;
		this.actions = actions;
	}

	start(): void {
		void this.connect();
	}

	update(patch: WorkerUpdate): void {
		Object.assign(this.snapshot, patch);
		this.connection?.send({ type: "worker.update", update: patch });
	}

	private async connect(): Promise<void> {
		let connection: Connection;
		try {
			connection = await connect(this.options.supervisor);
		} catch {
			this.scheduleRetry();
			return;
		}
		connection.onMessage((message) => {
			if (message.type !== "stop") return this.actions.request(message);
			setImmediate(() => this.actions.stop());
			return {};
		});
		connection.socket.on("close", () => {
			if (this.connection !== connection) return;
			this.connection = undefined;
			this.lostSince = Date.now();
			this.log("lost the supervisor. Reconnecting.");
			this.scheduleRetry();
		});
		try {
			await connection.request(
				{
					type: "worker.hello",
					workerId: this.options.id,
					pid: process.pid,
					socket: this.options.socket,
					update: this.snapshot,
				},
				10_000,
			);
		} catch (error) {
			// The supervisor answered, but does not know this session. Nobody can reach it.
			this.log("supervisor refused the worker:", error);
			connection.close();
			if (!connection.isClosed) this.actions.orphan();
			else this.scheduleRetry();
			return;
		}
		this.connection = connection;
		this.log("connected to the supervisor");
	}

	private scheduleRetry(): void {
		if (this.retry) return;
		if (Date.now() - this.lostSince > ORPHAN_AFTER_MS) {
			this.log("no supervisor for a minute. Ending.");
			this.actions.orphan();
			return;
		}
		this.retry = setTimeout(() => {
			this.retry = undefined;
			void this.connect();
		}, RECONNECT_MS);
	}
}

// ---------------------------------------------------------------------------
// Attachments: at most one client holds the session at a time.

class Attachments {
	private current?: net.Socket;
	private stopping = false;
	/** When a client last let go of the session. */
	private lastSeenAt?: number;
	private readonly mode: any;
	private readonly terminal: SocketTerminal;
	private readonly log: Log;
	private readonly run: RunState;
	private readonly report: (patch: WorkerUpdate) => void;

	constructor(mode: any, terminal: SocketTerminal, log: Log, run: RunState, report: (patch: WorkerUpdate) => void) {
		this.mode = mode;
		this.terminal = terminal;
		this.log = log;
		this.run = run;
		this.report = report;
	}

	private get ui(): any {
		return this.mode.ui;
	}

	get attached(): boolean {
		return this.current !== undefined;
	}

	/**
	 * /quit, ctrl+d, and ctrl+c twice detach the client. A stop and SIGTERM run the real shutdown.
	 * shutdown is a private member of InteractiveMode. Without it, /quit ends the worker (spec §8.3).
	 */
	patchShutdown(): void {
		if (typeof this.mode.shutdown !== "function") {
			this.log("warning: InteractiveMode has no shutdown(). /quit ends this session.");
			return;
		}
		const original = this.mode.shutdown.bind(this.mode);
		this.mode.shutdown = async (options?: { fromSignal?: boolean }) => {
			if (options?.fromSignal || this.stopping) return original(options);
			this.detach("quit");
		};
	}

	/** End the session: give the terminal back, then let pi shut down and exit. */
	stop(reason: DetachReason, message?: string): void {
		if (this.stopping) return;
		this.log(`stopping${message ? `: ${message}` : ""}`);
		this.detach(reason, message);
		this.stopping = true;
		void this.mode.shutdown();
	}

	parkUi(): void {
		if (this.terminal.attached) return;
		try {
			this.ui.stop();
		} catch (error) {
			this.log("ui.stop failed", error);
		}
	}

	accept(socket: net.Socket): void {
		const decoder = new FrameDecoder();
		let hello = false;
		socket.on("data", (chunk: Buffer) => {
			let frames;
			try {
				frames = decoder.push(chunk);
			} catch (error) {
				this.log("bad frame", error);
				socket.destroy();
				return;
			}
			for (const frame of frames) {
				if (!hello) {
					const message = frame.type === FrameType.hello ? parseJson<AttachHello>(frame) : undefined;
					if (!message || this.stopping) {
						socket.destroy();
						return;
					}
					hello = true;
					this.attach(socket, message);
				} else if (socket !== this.current) {
					return;
				} else if (frame.type === FrameType.data) {
					this.terminal.input(frame.payload.toString("utf8"));
				} else if (frame.type === FrameType.resize) {
					const size = parseJson<TerminalSize>(frame);
					if (size) this.terminal.resize(size);
				}
			}
		});
		socket.on("close", () => {
			if (socket === this.current) this.release();
		});
		socket.on("error", (error) => this.log("client socket error", error));
	}

	private attach(socket: net.Socket, hello: AttachHello): void {
		if (this.current) this.detach("taken");
		this.current = socket;
		try {
			this.ui.stop();
		} catch (error) {
			this.log("ui.stop before attach failed", error);
		}
		this.terminal.attach((data) => {
			if (!socket.destroyed) socket.write(encodeFrame(FrameType.data, data));
		}, sizeOf(hello));
		this.ui.start();
		this.ui.requestRender(true);
		this.log(`client attached (${hello.columns}x${hello.rows})`);
		this.report({ attached: true, unread: null });
		this.postRecap();
	}

	private postRecap(): void {
		const line = recap(this.run, this.lastSeenAt);
		if (!line) return;
		try {
			this.run.ctx?.ui.notify(line.text, line.type);
		} catch (error) {
			this.log("recap failed", error);
		}
	}

	/** The manager in this worker picked another session. The client attaches there next. */
	switchTo(id: string): void {
		const socket = this.current;
		if (!socket) return;
		if (!socket.destroyed) socket.write(encodeJsonFrame(FrameType.switch, { id }));
		this.detach("quit");
	}

	/** Restore the client terminal, tell the client why, and close the connection. */
	detach(reason: DetachReason, message?: string): void {
		const socket = this.current;
		if (!socket) return;
		try {
			this.ui.stop();
		} catch (error) {
			this.log("ui.stop on detach failed", error);
		}
		const detached: Detached = message ? { reason, message } : { reason };
		if (!socket.destroyed) socket.end(encodeJsonFrame(FrameType.detached, detached));
		this.current = undefined;
		this.lastSeenAt = Date.now();
		this.terminal.detach();
		this.report({ attached: false });
		this.log(`client detached: ${reason}`);
	}

	/** The client went away. It took its terminal along, so nothing needs a restore. */
	private release(): void {
		this.current = undefined;
		this.lastSeenAt = Date.now();
		this.terminal.detach();
		this.report({ attached: false });
		try {
			this.ui.stop();
		} catch (error) {
			this.log("ui.stop after close failed", error);
		}
		this.log("client closed the connection");
	}
}

function sizeOf(size: TerminalSize): TerminalSize {
	const columns = Number.isFinite(size.columns) && size.columns > 0 ? Math.floor(size.columns) : 80;
	const rows = Number.isFinite(size.rows) && size.rows > 0 ? Math.floor(size.rows) : 24;
	return { columns, rows };
}

function listen(socketPath: string, onConnection: (socket: net.Socket) => void): Promise<net.Server> {
	mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
	rmSync(socketPath, { force: true });
	return new Promise((resolve, reject) => {
		const server = net.createServer(onConnection);
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve(server);
		});
	});
}
