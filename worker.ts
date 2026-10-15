// Worker: runs one pi session in its own process and draws it to a SocketTerminal.
// Clients attach over a Unix socket. Detach, /quit, and a closed client all leave the
// session alive. Only SIGTERM stops the worker.
//
// worker-boot.mjs loads this file through the jiti of pi. pi itself comes in as `sdk`
// and `tui`, so the worker shares one module instance with pi and its extensions.
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { format } from "node:util";
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

export interface WorkerOptions {
	id: string;
	/** Socket that clients attach to. */
	socket: string;
	/** JSON file with the pid, socket, and session file of this worker. */
	infoFile: string;
	logFile: string;
	cwd: string;
	sessionFile?: string;
	task?: string;
	/** Root of the pi package, for modules that pi does not export. */
	piDir: string;
}

export interface WorkerInfo {
	id: string;
	pid: number;
	socket: string;
	cwd: string;
	sessionFile?: string;
	sessionId?: string;
	startedAt: number;
}

export async function runWorker(sdk: Sdk, tui: TuiDeps, options: WorkerOptions): Promise<void> {
	const log = openLog(options.logFile);
	routeConsoleToLog(log);
	process.on("SIGHUP", () => log("SIGHUP ignored"));
	process.on("unhandledRejection", (error) => log("unhandledRejection", error));

	const agentDir = sdk.getAgentDir();
	const sessionManager = options.sessionFile
		? sdk.SessionManager.open(options.sessionFile, undefined, undefined)
		: sdk.SessionManager.create(options.cwd, undefined, {});
	const runtime = await sdk.createAgentSessionRuntime(createRuntimeFactory(sdk), {
		cwd: sessionManager.getCwd?.() || options.cwd,
		agentDir,
		sessionManager,
	});
	await applyNetworkSettings(options.piDir, runtime.services.settingsManager, log);

	const terminal = new SocketTerminal(tui);
	const mode = new sdk.InteractiveMode(runtime, {
		migratedProviders: [],
		modelFallbackMessage: runtime.modelFallbackMessage,
		initialMessage: options.task?.trim() || undefined,
		initialImages: [],
		initialMessages: [],
		terminal,
	});
	const attachments = new Attachments(mode, terminal, log);
	attachments.patchShutdown();

	await mode.init();
	// No client holds the session yet. Stop the TUI so it does not render for nobody.
	attachments.parkUi();

	const server = await listen(options.socket, (socket) => attachments.accept(socket));
	writeInfo(options, runtime);
	const cleanup = () => {
		server.close();
		rmSync(options.socket, { force: true });
		rmSync(options.infoFile, { force: true });
	};
	process.on("exit", cleanup);
	log(`worker ${options.id} ready on ${options.socket}`);

	await mode.run();
}

// ---------------------------------------------------------------------------
// Runtime

/** The createRuntime of pi's main, without CLI flags and without a trust prompt. */
function createRuntimeFactory(sdk: Sdk) {
	const trustStore = new sdk.ProjectTrustStore(sdk.getAgentDir());
	return async ({ cwd, agentDir, sessionManager, sessionStartEvent }: any) => {
		const projectTrusted = !sdk.hasTrustRequiringProjectResources(cwd) || trustStore.get(cwd) === true;
		const settingsManager = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted });
		const services = await sdk.createAgentSessionServices({ cwd, agentDir, settingsManager });
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

function writeInfo(options: WorkerOptions, runtime: any): void {
	const sm = runtime.session.sessionManager;
	const info: WorkerInfo = {
		id: options.id,
		pid: process.pid,
		socket: options.socket,
		cwd: sm.getCwd?.() || options.cwd,
		sessionFile: sm.getSessionFile?.(),
		sessionId: sm.getSessionId?.(),
		startedAt: Date.now(),
	};
	// Readers never see a half-written file: write a temp file, then rename it.
	const temp = `${options.infoFile}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(info, null, "\t"), { mode: 0o600 });
	renameSync(temp, options.infoFile);
}

// ---------------------------------------------------------------------------
// Attachments: at most one client holds the session at a time.

class Attachments {
	private current?: net.Socket;
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

	/** /quit, ctrl+d, and ctrl+c twice detach the client. SIGTERM still runs the real shutdown. */
	patchShutdown(): void {
		const original = this.mode.shutdown.bind(this.mode);
		this.mode.shutdown = async (options?: { fromSignal?: boolean }) => {
			if (options?.fromSignal) return original(options);
			this.detach("quit");
		};
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
					if (!message) {
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

// ---------------------------------------------------------------------------
// Socket and log

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

type Log = (...values: unknown[]) => void;

function openLog(file: string): Log {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	return (...values: unknown[]) => {
		try {
			appendFileSync(file, `${new Date().toISOString()} ${format(...values)}\n`);
		} catch {
			// The log is best effort.
		}
	};
}

/** The worker has no terminal. Text that pi or extensions print goes to the log instead. */
function routeConsoleToLog(log: Log): void {
	console.log = (...values: unknown[]) => log(...values);
	console.info = (...values: unknown[]) => log(...values);
	console.warn = (...values: unknown[]) => log("warn:", ...values);
	console.error = (...values: unknown[]) => log("error:", ...values);
}
