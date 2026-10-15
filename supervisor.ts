// Supervisor: one process per agent dir. It keeps the session records, starts and stops
// workers, and answers clients (spec §5 and §7). It holds no session of its own.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
	connect,
	Connection,
	type CreateRequest,
	type Message,
	type ReplyData,
	type SessionRecord,
	type WorkerUpdate,
} from "./control.ts";
import { workerEnv } from "./env.ts";
import { openLog, routeConsoleToLog, type Log } from "./filelog.ts";
import {
	agentDirFrom,
	newSessionId,
	statePaths,
	workerLog,
	workerSocket,
	type BootContext,
	type StatePaths,
} from "./paths.ts";
import { Registry } from "./registry.ts";

const CREATE_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 10_000;
const SWEEP_MS = 5_000;

export interface SupervisorPidFile {
	pid: number;
	version: string;
	socket: string;
	startedAt: number;
}

export interface StartWorker {
	record: SessionRecord;
	task?: string;
	name?: string;
}

export interface SupervisorOptions {
	paths: StatePaths;
	version: string;
	/** boot.mjs of this package. The default worker spawn runs it. */
	bootFile: string;
	log: Log;
	/** Tests replace the worker spawn. */
	spawnWorker?: (start: StartWorker, supervisor: Supervisor) => ChildProcess;
	createTimeoutMs?: number;
	sweepMs?: number;
	/** Runs after a "shutdown" request closed the supervisor. */
	onShutdown?: () => void;
}

interface Live {
	connection?: Connection;
	child?: ChildProcess;
	/** The supervisor ends this worker. "forget" also removes the session, "keep" leaves it saved. */
	ending?: "forget" | "keep";
	/** A create or wake waits for the worker to say hello. */
	ready?: { resolve: () => void; reject: (error: Error) => void };
}

export class Supervisor {
	readonly options: SupervisorOptions;
	private readonly registry: Registry;
	private readonly records = new Map<string, SessionRecord>();
	private readonly live = new Map<string, Live>();
	private server?: net.Server;
	private sweepTimer?: ReturnType<typeof setInterval>;

	constructor(options: SupervisorOptions) {
		this.options = options;
		this.registry = new Registry(options.paths.sessions);
	}

	get paths(): StatePaths {
		return this.options.paths;
	}

	private get log(): Log {
		return this.options.log;
	}

	/** Returns false when another supervisor already serves this agent dir. */
	async start(): Promise<boolean> {
		const { paths } = this;
		for (const dir of [paths.root, paths.sessions, paths.workers, paths.sockets]) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
		if (await answers(paths.supervisorSocket)) return false;
		rmSync(paths.supervisorSocket, { force: true });
		for (const record of this.registry.load()) this.records.set(record.id, record);
		this.reconcile();
		this.server = net.createServer((socket) => this.accept(new Connection(socket)));
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(paths.supervisorSocket, () => {
				this.server!.off("error", reject);
				resolve();
			});
		});
		const pidFile: SupervisorPidFile = {
			pid: process.pid,
			version: this.options.version,
			socket: paths.supervisorSocket,
			startedAt: Date.now(),
		};
		writeFileSync(paths.supervisorPid, JSON.stringify(pidFile, null, "\t"), { mode: 0o600 });
		this.sweepTimer = setInterval(() => this.sweep(), this.options.sweepMs ?? SWEEP_MS);
		this.sweepTimer.unref?.();
		this.log(`supervisor ${this.options.version} (pid ${process.pid}) listens on ${paths.supervisorSocket}`);
		return true;
	}

	/** Stop listening. Workers keep running unless keepWorkers is false. */
	async close(keepWorkers: boolean): Promise<void> {
		if (!keepWorkers) {
			const running = this.list().filter((r) => r.pid);
			await Promise.all(running.map((r) => this.endWorker(r, "keep").catch((error) => this.log("end worker", error))));
		}
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		for (const live of this.live.values()) live.connection?.close();
		await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
		rmSync(this.paths.supervisorSocket, { force: true });
		rmSync(this.paths.supervisorPid, { force: true });
		this.log(`supervisor stopped${keepWorkers ? ", workers kept" : ""}`);
	}

	list(): SessionRecord[] {
		return [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt);
	}

	/** By exact id, then name, then id prefix, then first prompt prefix. */
	find(idOrName: string): SessionRecord | undefined {
		const direct = this.records.get(idOrName);
		if (direct) return direct;
		const needle = idOrName.trim().toLowerCase();
		if (!needle) return undefined;
		const all = this.list();
		return (
			all.find((r) => r.name?.toLowerCase() === needle) ??
			all.find((r) => r.id.toLowerCase().startsWith(needle)) ??
			all.find((r) => (r.name ?? r.firstPrompt ?? "").toLowerCase().startsWith(needle))
		);
	}

	// --- Requests -------------------------------------------------------

	private accept(connection: Connection): void {
		let workerId: string | undefined;
		connection.onMessage((message) => {
			if (message.type === "worker.hello") {
				workerId = String(message.workerId ?? "");
				return this.workerHello(workerId, message, connection);
			}
			if (message.type === "worker.update" && workerId) return this.workerUpdate(workerId, message.update as WorkerUpdate);
			return this.clientRequest(message);
		});
		connection.socket.on("close", () => {
			if (workerId) this.workerDisconnected(workerId, connection);
		});
	}

	private clientRequest(message: Message): ReplyData | Promise<ReplyData> {
		switch (message.type) {
			case "hello":
				return { version: this.options.version, pid: process.pid };
			case "list":
				return { sessions: this.list() };
			case "create":
				return this.create(message.request as CreateRequest).then((record) => ({ record }));
			case "stop":
				return this.stop(String(message.session ?? "")).then(() => ({}));
			case "attach":
				return this.attach(String(message.session ?? ""));
			case "shutdown":
				setImmediate(() => {
					void this.close(message.keepWorkers === true).then(() => this.options.onShutdown?.());
				});
				return {};
			default:
				throw new Error(`Unknown request "${message.type}".`);
		}
	}

	async create(request: CreateRequest): Promise<SessionRecord> {
		if (!request?.cwd || !path.isAbsolute(request.cwd)) throw new Error("create needs an absolute cwd.");
		if (!request.piDir) throw new Error("create needs piDir.");
		// Two workers on one session file would fork the conversation without notice.
		const existing = request.sessionFile ? this.list().find((r) => r.sessionFile === request.sessionFile) : undefined;
		if (existing) {
			if (request.task?.trim()) throw new Error(`Session ${existing.id} already uses this file. Attach to it instead.`);
			await this.wake(existing);
			return existing;
		}
		const now = Date.now();
		const record: SessionRecord = {
			id: newSessionId(request.cwd, now),
			cwd: request.cwd,
			state: "starting",
			sessionFile: request.sessionFile,
			name: request.name?.trim() || undefined,
			firstPrompt: request.task?.trim() ? oneLine(request.task) : undefined,
			pinned: false,
			createdAt: now,
			lastActivityAt: now,
			env: request.env ?? {},
			piDir: request.piDir,
		};
		this.save(record);
		await this.launch({ record, task: request.task, name: request.name });
		return this.records.get(record.id) ?? record;
	}

	/** Start a saved or failed session again. A live session needs nothing. */
	async wake(record: SessionRecord): Promise<void> {
		const live = this.live.get(record.id);
		if (live?.connection) return;
		if (live?.ready) {
			await new Promise<void>((resolve, reject) => {
				const previous = live.ready!;
				live.ready = {
					resolve: () => (previous.resolve(), resolve()),
					reject: (error) => (previous.reject(error), reject(error)),
				};
			});
			return;
		}
		if (record.sessionFile && !existsSync(record.sessionFile)) {
			throw new Error(`The session file of "${record.name ?? record.id}" is gone.`);
		}
		record.state = "starting";
		record.error = undefined;
		this.save(record);
		await this.launch({ record });
	}

	async attach(idOrName: string): Promise<{ id: string; socket: string }> {
		const record = this.find(idOrName);
		if (!record) throw new Error(`No session matches "${idOrName}".`);
		await this.wake(record);
		return { id: record.id, socket: workerSocket(this.paths, record.id) };
	}

	/** End the worker and remove the session. Its session file stays. */
	async stop(idOrName: string): Promise<void> {
		const record = this.find(idOrName);
		if (!record) throw new Error(`No session matches "${idOrName}".`);
		await this.endWorker(record, "forget");
		this.forget(record.id);
	}

	/** Ask the worker to shut down, then signal it if it does not. */
	private async endWorker(record: SessionRecord, ending: "forget" | "keep"): Promise<void> {
		const live = this.live.get(record.id) ?? {};
		this.live.set(record.id, live);
		live.ending = ending;
		live.ready?.reject(new Error("The session was stopped."));
		live.ready = undefined;
		const pid = record.pid;
		if (live.connection) {
			await live.connection.request({ type: "stop" }, STOP_TIMEOUT_MS).catch((error) => this.log("stop request", error));
		}
		if (pid && isAlive(pid)) {
			if (!(await waitForExit(pid, STOP_TIMEOUT_MS))) {
				this.log(`worker ${record.id} ignored the stop. Sending SIGTERM.`);
				signal(pid, "SIGTERM");
				if (!(await waitForExit(pid, 5_000))) signal(pid, "SIGKILL");
			}
		}
		// The exit handler settles the record. A worker of an earlier supervisor has none.
		if (this.records.get(record.id)?.pid) this.gone(record.id);
	}

	// --- Workers --------------------------------------------------------

	private launch(start: StartWorker): Promise<void> {
		const { record } = start;
		const live = this.live.get(record.id) ?? {};
		this.live.set(record.id, live);
		live.ending = undefined;
		const ready = new Promise<void>((resolve, reject) => {
			live.ready = { resolve, reject };
		});
		const timer = setTimeout(() => {
			live.ready?.reject(new Error(`The worker did not start in time. See ${workerLog(this.paths, record.id)}`));
		}, this.options.createTimeoutMs ?? CREATE_TIMEOUT_MS);
		timer.unref?.();
		let child: ChildProcess;
		try {
			child = (this.options.spawnWorker ?? spawnWorker)(start, this);
		} catch (error) {
			clearTimeout(timer);
			live.ready = undefined;
			this.gone(record.id, `The worker did not spawn: ${String(error)}`);
			return Promise.reject(error);
		}
		live.child = child;
		record.pid = child.pid;
		this.save(record);
		child.once("exit", (code, signalName) => {
			if (live.child !== child) return;
			live.child = undefined;
			if (this.records.get(record.id)?.pid !== child.pid) return;
			const how = signalName ? `signal ${signalName}` : `code ${code}`;
			live.ready?.reject(new Error(`The worker exited with ${how}. See ${workerLog(this.paths, record.id)}`));
			this.gone(record.id, code === 0 && !signalName ? undefined : `The worker exited with ${how}.`);
		});
		return ready.finally(() => {
			clearTimeout(timer);
			live.ready = undefined;
		});
	}

	private workerHello(id: string, message: Message, connection: Connection): ReplyData {
		const record = this.records.get(id);
		const live = this.live.get(id);
		if (!record || live?.ending) throw new Error(`The supervisor does not know session ${id}.`);
		const entry = live ?? {};
		this.live.set(id, entry);
		entry.connection?.close();
		entry.connection = connection;
		record.pid = Number(message.pid) || record.pid;
		this.merge(record, (message.update as WorkerUpdate) ?? {});
		if (record.state === "starting" || record.state === "saved" || record.state === "failed") record.state = "idle";
		this.save(record);
		entry.ready?.resolve();
		this.log(`worker ${id} (pid ${record.pid}) connected`);
		return { id };
	}

	private workerUpdate(id: string, update: WorkerUpdate): ReplyData {
		const record = this.records.get(id);
		if (!record) return {};
		this.merge(record, update ?? {});
		record.lastActivityAt = Date.now();
		this.save(record);
		return {};
	}

	private workerDisconnected(id: string, connection: Connection): void {
		const live = this.live.get(id);
		if (live?.connection !== connection) return;
		live.connection = undefined;
		const pid = this.records.get(id)?.pid;
		if (!pid || !isAlive(pid)) this.gone(id);
		// A live worker without a connection reconnects, or the sweep notices its exit.
	}

	/** Records that name a process: keep live ones for reconnect, settle dead ones (spec §7.6). */
	private reconcile(): void {
		for (const record of this.records.values()) {
			if (record.pid && isAlive(record.pid)) continue;
			if (record.pid || record.state === "starting") this.gone(record.id);
		}
	}

	private sweep(): void {
		for (const record of this.records.values()) {
			if (!record.pid || this.live.get(record.id)?.connection) continue;
			if (!isAlive(record.pid)) this.gone(record.id);
		}
	}

	/** The worker process ended. A requested stop forgets the session. Otherwise it becomes saved or failed. */
	private gone(id: string, error?: string): void {
		const record = this.records.get(id);
		if (!record) return;
		const live = this.live.get(id);
		rmSync(workerSocket(this.paths, id), { force: true });
		if (live?.ending === "forget") {
			this.forget(id);
			return;
		}
		live?.connection?.close();
		this.live.delete(id);
		// pi writes the session file at the first message. Without it, nothing can come back.
		if (!record.sessionFile || !existsSync(record.sessionFile)) {
			this.log(`worker ${id} ended before the first message${error ? `: ${error}` : ""}`);
			this.forget(id);
			return;
		}
		const busy = record.state === "working" || record.state === "waiting" || record.state === "starting";
		// An idle session lost nothing. A busy one lost its run (spec §7.6).
		record.state = busy ? "failed" : "saved";
		if (busy && error) record.error = error;
		record.pid = undefined;
		this.save(record);
		this.log(`worker ${id} ended, session is ${record.state}${error ? `: ${error}` : ""}`);
	}

	private forget(id: string): void {
		const known = this.records.delete(id);
		this.live.delete(id);
		this.registry.remove(id);
		rmSync(workerSocket(this.paths, id), { force: true });
		if (known) this.log(`session ${id} removed`);
	}

	private merge(record: SessionRecord, update: WorkerUpdate): void {
		for (const [key, value] of Object.entries(update)) {
			if (value === null) delete (record as any)[key];
			else if (value !== undefined) (record as any)[key] = value;
		}
	}

	private save(record: SessionRecord): void {
		this.records.set(record.id, record);
		try {
			this.registry.write(record);
		} catch (error) {
			this.log(`record ${record.id} not saved`, error);
		}
	}
}

/** The default worker spawn: boot.mjs in its own process group, output to the worker log. */
export function spawnWorker({ record, task, name }: StartWorker, supervisor: Supervisor): ChildProcess {
	const { paths, bootFile } = supervisor.options;
	const log = workerLog(paths, record.id);
	const args = [bootFile, "worker", "--pi-dir", record.piDir, "--id", record.id];
	args.push("--supervisor", paths.supervisorSocket, "--socket", workerSocket(paths, record.id));
	args.push("--log", log, "--cwd", record.cwd);
	if (record.sessionFile) args.push("--session", record.sessionFile);
	if (task?.trim()) args.push("--task", task);
	if (name?.trim()) args.push("--name", name.trim());
	const fd = openSync(log, "a", 0o600);
	try {
		const child = spawn(process.execPath, args, {
			cwd: existsSync(record.cwd) ? record.cwd : homedir(),
			detached: true,
			stdio: ["ignore", fd, fd],
			env: workerEnv(process.env, record.env, record.id),
		});
		child.unref();
		return child;
	} finally {
		closeSync(fd);
	}
}

// ---------------------------------------------------------------------------
// Process helpers

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists, but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function signal(pid: number, name: NodeJS.Signals): void {
	try {
		process.kill(pid, name);
	} catch {
		// The process ended on its own.
	}
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (isAlive(pid)) {
		if (Date.now() > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return true;
}

async function answers(socketPath: string): Promise<boolean> {
	try {
		const connection = await connect(socketPath);
		connection.socket.destroy();
		return true;
	} catch {
		return false;
	}
}

function oneLine(text: string, max = 200): string {
	return text.replace(/\s+/g, " ").trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// Entry point, called by boot.mjs

export async function runSupervisor(context: BootContext, argv: string[]): Promise<void> {
	parseArgs({ args: argv, options: {}, strict: true });
	const paths = statePaths(agentDirFrom());
	const log = openLog(paths.supervisorLog);
	routeConsoleToLog(log);
	process.on("uncaughtException", (error) => {
		log("uncaughtException", error);
		process.exit(1);
	});
	process.on("unhandledRejection", (error) => log("unhandledRejection", error));
	process.on("SIGHUP", () => log("SIGHUP ignored"));
	process.on("SIGINT", () => log("SIGINT ignored"));
	const supervisor = new Supervisor({
		paths,
		version: context.version,
		bootFile: path.join(context.root, "boot.mjs"),
		log,
		onShutdown: () => process.exit(0),
	});
	// SIGTERM ends only the supervisor. Workers wait for the next one (spec §7.6).
	process.on("SIGTERM", () => void supervisor.close(true).finally(() => process.exit(0)));
	if (!(await supervisor.start())) {
		log("another supervisor already listens. Exiting.");
		process.exit(0);
	}
}
