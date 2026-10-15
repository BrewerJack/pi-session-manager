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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connect, type Connection, type ReplyData, type WorkerUpdate } from "./control.ts";
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
import { SocketTerminal, type TuiDeps } from "./socket-terminal.ts";

type Sdk = typeof import("@earendil-works/pi-coding-agent");

/** A worker without a supervisor for this long ends itself (spec §7.6). */
const ORPHAN_AFTER_MS = 60_000;
const RECONNECT_MS = 2_000;

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
		},
	});
	const { id, supervisor, socket, log, cwd } = values;
	if (!id || !supervisor || !socket || !log || !cwd) {
		throw new Error("worker needs --id, --supervisor, --socket, --log, and --cwd.");
	}
	return { id, supervisor, socket, logFile: log, cwd, sessionFile: values.session, task: values.task, name: values.name, piDir };
}

export async function runWorker(sdk: Sdk, tui: TuiDeps, options: WorkerOptions): Promise<void> {
	const log = openLog(options.logFile);
	routeConsoleToLog(log);
	process.on("SIGHUP", () => log("SIGHUP ignored"));
	process.on("unhandledRejection", (error) => log("unhandledRejection", error));

	let attachments: Attachments | undefined;
	const link = new SupervisorLink(options, log, {
		stop: () => attachments?.stop("stopped"),
		orphan: () => attachments?.stop("stopped", "The supervisor is gone.") ?? process.exit(0),
	});

	const agentDir = sdk.getAgentDir();
	const sessionManager = options.sessionFile
		? sdk.SessionManager.open(options.sessionFile, undefined, undefined)
		: sdk.SessionManager.create(options.cwd, undefined, {});
	const runtime = await sdk.createAgentSessionRuntime(createRuntimeFactory(sdk, reporter(link)), {
		cwd: sessionManager.getCwd?.() || options.cwd,
		agentDir,
		sessionManager,
	});
	await applyNetworkSettings(options.piDir, runtime.services.settingsManager, log);
	const sm = runtime.session.sessionManager;
	if (options.name?.trim() && !sm.getSessionName?.()) runtime.session.setSessionName(options.name.trim());
	link.update({ ...sessionMeta(sm), state: "idle" });

	const terminal = new SocketTerminal(tui);
	const mode = new sdk.InteractiveMode(runtime, {
		migratedProviders: [],
		modelFallbackMessage: runtime.modelFallbackMessage,
		initialMessage: options.task?.trim() || undefined,
		initialImages: [],
		initialMessages: [],
		terminal,
	});
	attachments = new Attachments(mode, terminal, log);
	attachments.patchShutdown();

	await mode.init();
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
// Runtime

/** The createRuntime of pi's main, without CLI flags and without a trust prompt. */
function createRuntimeFactory(sdk: Sdk, extension: (pi: ExtensionAPI) => void) {
	const trustStore = new sdk.ProjectTrustStore(sdk.getAgentDir());
	return async ({ cwd, agentDir, sessionManager, sessionStartEvent }: any) => {
		const projectTrusted = !sdk.hasTrustRequiringProjectResources(cwd) || trustStore.get(cwd) === true;
		const settingsManager = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted });
		const services = await sdk.createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager,
			resourceLoaderOptions: { extensionFactories: [extension] },
		});
		if (!projectTrusted) {
			services.diagnostics.push({ type: "warning", message: `Project resources are not trusted: ${cwd}` });
		}
		const created = await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
		return { ...created, services, diagnostics: services.diagnostics };
	};
}

/** pi's main applies these after it creates the runtime. The public API of pi lacks them. */
async function applyNetworkSettings(piDir: string, settingsManager: any, log: Log): Promise<void> {
	try {
		const url = new URL(`file://${path.join(piDir, "dist/core/http-dispatcher.js")}`);
		const http = await import(url.href);
		http.applyHttpProxySettings?.(settingsManager.getGlobalSettings().httpProxy);
		http.configureHttpDispatcher?.(settingsManager.getHttpIdleTimeoutMs());
	} catch (error) {
		log("network settings skipped", error);
	}
}

// ---------------------------------------------------------------------------
// State reports: an inline extension forwards session events to the supervisor (spec §8.5).

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part: any) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : [])).join(" ");
}

function oneLine(text: string, max = 200): string {
	return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function sessionMeta(sm: any): WorkerUpdate {
	const meta: WorkerUpdate = {};
	try {
		meta.sessionFile = sm.getSessionFile?.() ?? undefined;
		meta.sessionId = sm.getSessionId?.() ?? undefined;
		meta.name = sm.getSessionName?.() || undefined;
		meta.cwd = sm.getCwd?.() || undefined;
		for (const entry of sm.getEntries?.() ?? []) {
			if (entry?.type !== "message" || entry.message?.role !== "user") continue;
			const text = oneLine(textOf(entry.message.content));
			if (text) {
				meta.firstPrompt = text;
				break;
			}
		}
	} catch {
		// Partial metadata is still useful.
	}
	return meta;
}

function reporter(link: SupervisorLink) {
	return (pi: ExtensionAPI) => {
		let running = false;
		let dialogs = 0;
		let error: string | undefined;
		const state = () => (dialogs > 0 ? "waiting" : running ? "working" : "idle");
		pi.on("session_start", (_event, ctx) => {
			running = false;
			dialogs = 0;
			link.update({ ...sessionMeta(ctx.sessionManager), state: state() });
		});
		pi.on("session_info_changed", (event) => link.update({ name: event.name || null }));
		pi.on("agent_start", () => {
			running = true;
			error = undefined;
			link.update({ state: state(), error: null, lastOutcome: null });
		});
		pi.on("message_end", (event, ctx) => {
			const message: any = event.message;
			if (message?.role === "assistant" && message.stopReason === "error" && message.errorMessage) {
				error = String(message.errorMessage);
			}
			// pi writes the session file at the first message. Report its path then.
			if (message?.role === "user") link.update(sessionMeta(ctx.sessionManager));
		});
		pi.on("agent_settled", (event) => {
			running = false;
			const lastOutcome = event.aborted ? "aborted" : error ? "error" : "done";
			link.update({ state: state(), lastOutcome, error: error ?? null });
		});
		pi.on("ui_prompt_start", () => {
			dialogs++;
			link.update({ state: state() });
		});
		pi.on("ui_prompt_end", () => {
			dialogs = Math.max(0, dialogs - 1);
			link.update({ state: state() });
		});
	};
}

// ---------------------------------------------------------------------------
// SupervisorLink: the control connection of the worker. It reconnects when the
// supervisor restarts, and ends the worker after a minute without one.

class SupervisorLink {
	private connection?: Connection;
	/** Everything reported so far. A new connection receives it with the hello. */
	private snapshot: WorkerUpdate = {};
	private lostSince = Date.now();
	private retry?: ReturnType<typeof setTimeout>;
	private readonly options: WorkerOptions;
	private readonly log: Log;
	private readonly actions: { stop: () => void; orphan: () => void };

	constructor(options: WorkerOptions, log: Log, actions: { stop: () => void; orphan: () => void }) {
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
		connection.onMessage((message): ReplyData => {
			if (message.type !== "stop") throw new Error(`Unknown request "${message.type}".`);
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
	private readonly mode: any;
	private readonly terminal: SocketTerminal;
	private readonly log: Log;

	constructor(mode: any, terminal: SocketTerminal, log: Log) {
		this.mode = mode;
		this.terminal = terminal;
		this.log = log;
	}

	private get ui(): any {
		return this.mode.ui;
	}

	/** /quit, ctrl+d, and ctrl+c twice detach the client. A stop and SIGTERM run the real shutdown. */
	patchShutdown(): void {
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
		this.terminal.detach();
		this.log(`client detached: ${reason}`);
	}

	/** The client went away. It took its terminal along, so nothing needs a restore. */
	private release(): void {
		this.current = undefined;
		this.terminal.detach();
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
