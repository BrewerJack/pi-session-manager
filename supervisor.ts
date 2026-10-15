// Supervisor: one process per agent dir. It keeps the session records, starts and stops
// workers, and answers clients (spec §5 and §7). It holds no session of its own.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
	connect,
	Connection,
	publicRecord,
	TRANSIENT_FIELDS,
	type CreateRequest,
	type Inheritance,
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
import { appendSessionName, branchOf, nameOf, readSessionFile } from "./session-file.ts";
import { firstUserText, lastExchange, oneLine, transcriptOf, usageOf } from "./transcript.ts";

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
	inherit?: Inheritance;
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
	/** Every open connection, so close() does not wait for clients that stay connected. */
	private readonly connections = new Set<Connection>();
	/** Clients that receive changed and removed events. */
	private readonly subscribers = new Set<Connection>();
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
		const closed = new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
		for (const connection of this.connections) connection.close();
		await closed;
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
		this.connections.add(connection);
		let workerId: string | undefined;
		connection.onMessage((message) => {
			if (message.type === "worker.hello") {
				workerId = String(message.workerId ?? "");
				return this.workerHello(workerId, message, connection);
			}
			if (message.type === "worker.update" && workerId) return this.workerUpdate(workerId, message.update as WorkerUpdate);
			return this.clientRequest(message, connection);
		});
		connection.socket.on("close", () => {
			this.connections.delete(connection);
			this.subscribers.delete(connection);
			if (workerId) this.workerDisconnected(workerId, connection);
		});
	}

	private clientRequest(message: Message, connection: Connection): ReplyData | Promise<ReplyData> {
		const session = String(message.session ?? "");
		switch (message.type) {
			case "hello":
				return { version: this.options.version, pid: process.pid };
			case "list":
				return { sessions: this.list().map(publicRecord) };
			case "subscribe":
				this.subscribers.add(connection);
				return { sessions: this.list().map(publicRecord) };
			case "send":
				return this.send(session, String(message.text ?? "")).then(() => ({}));
			case "interrupt":
				return this.forward(this.mustFind(session), { type: "interrupt" });
			case "rename":
				return this.rename(session, String(message.name ?? "")).then(() => ({}));
			case "pin":
				return this.pin(session, message.pinned === true);
			case "transcript":
				return this.transcript(session, Number(message.max) || 120);
			case "stats":
				return this.stats(session);
			case "create":
				return this.create(message.request as CreateRequest).then((record) => ({ record: publicRecord(record) }));
			case "stop":
				return this.stop(session).then(() => ({}));
			case "attach":
				return this.attach(session);
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
		const inherit: Inheritance = { model: request.model, thinkingLevel: request.thinkingLevel, tools: request.tools };
		await this.launch({ record, task: request.task, name: request.name, inherit });
		return this.records.get(record.id) ?? record;
	}

	private mustFind(idOrName: string): SessionRecord {
		const record = this.find(idOrName);
		if (!record) throw new Error(`No session matches "${idOrName}".`);
		return record;
	}

	/** Pass a request to the worker of a live session. */
	private async forward(record: SessionRecord, message: Message, timeoutMs = 10_000): Promise<ReplyData> {
		const connection = this.live.get(record.id)?.connection;
		if (!connection) throw new Error(`"${record.name ?? record.id}" has no running worker.`);
		return (await connection.request(message, timeoutMs)) ?? {};
	}

	/** Send a user message. A saved session starts first. A busy one queues it (spec §10.1). */
	async send(idOrName: string, text: string): Promise<void> {
		if (!text.trim()) throw new Error("The message is empty.");
		const record = this.mustFind(idOrName);
		await this.wake(record);
		await this.forward(record, { type: "send", text });
	}

	async rename(idOrName: string, name: string): Promise<void> {
		const record = this.mustFind(idOrName);
		const trimmed = name.trim();
		if (!trimmed) throw new Error("The name is empty.");
		if (this.live.get(record.id)?.connection) {
			await this.forward(record, { type: "rename", name: trimmed });
		} else if (record.sessionFile && existsSync(record.sessionFile)) {
			appendSessionName(record.sessionFile, trimmed);
		}
		record.name = trimmed;
		this.save(record);
	}

	private pin(idOrName: string, pinned: boolean): ReplyData {
		const record = this.mustFind(idOrName);
		record.pinned = pinned;
		this.save(record);
		return {};
	}

	/** The conversation of a session: from its worker, or from the file of a saved session. */
	private async transcript(idOrName: string, max: number): Promise<ReplyData> {
		const record = this.mustFind(idOrName);
		if (this.live.get(record.id)?.connection) return this.forward(record, { type: "transcript", max });
		if (!record.sessionFile || !existsSync(record.sessionFile)) return { items: [] };
		return { items: transcriptOf(branchOf(readSessionFile(record.sessionFile).entries), max) };
	}

	private async stats(idOrName: string): Promise<ReplyData> {
		const record = this.mustFind(idOrName);
		if (this.live.get(record.id)?.connection) return this.forward(record, { type: "stats" });
		if (!record.sessionFile || !existsSync(record.sessionFile)) return { usage: record.usage ?? null };
		return { usage: { ...usageOf(readSessionFile(record.sessionFile).entries), contextPercent: record.usage?.contextPercent ?? null } };
	}

	/**
	 * A saved session from a session file, without a worker (spec §11.1). A file that a
	 * listed session uses returns that session.
	 */
	addSaved(file: string, piDir: string, env: Record<string, string> = {}): SessionRecord {
		const existing = this.list().find((r) => r.sessionFile === file);
		if (existing) return existing;
		const { header, entries } = readSessionFile(file);
		const cwd = header?.cwd && path.isAbsolute(header.cwd) ? header.cwd : homedir();
		const now = Date.now();
		const branch = branchOf(entries);
		const { prompt, reply } = lastExchange(branch);
		const record: SessionRecord = {
			id: newSessionId(cwd, now),
			cwd,
			state: "saved",
			sessionFile: file,
			sessionId: header?.id,
			name: nameOf(entries),
			firstPrompt: firstUserText(entries),
			pinned: false,
			createdAt: now,
			lastActivityAt: fileTime(file) ?? now,
			env,
			piDir,
			usage: usageOf(entries),
			lastPrompt: prompt,
			lastReply: reply,
		};
		this.save(record);
		return record;
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
		const patch = update ?? {};
		this.merge(record, patch);
		record.lastActivityAt = Date.now();
		// Streaming text and tool changes come often. Only lasting fields reach the disk.
		const lasting = Object.keys(patch).some((key) => !(TRANSIENT_FIELDS as readonly string[]).includes(key));
		this.save(record, lasting);
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
		for (const key of TRANSIENT_FIELDS) delete record[key];
		record.runStartedAt = undefined;
		record.promptTitle = undefined;
		this.save(record);
		this.log(`worker ${id} ended, session is ${record.state}${error ? `: ${error}` : ""}`);
	}

	private forget(id: string): void {
		const known = this.records.delete(id);
		this.live.delete(id);
		this.registry.remove(id);
		rmSync(workerSocket(this.paths, id), { force: true });
		if (!known) return;
		this.log(`session ${id} removed`);
		this.publish({ type: "removed", session: id });
	}

	private publish(message: Message): void {
		for (const connection of this.subscribers) connection.send(message);
	}

	private merge(record: SessionRecord, update: WorkerUpdate): void {
		for (const [key, value] of Object.entries(update)) {
			if (value === null) delete (record as any)[key];
			else if (value !== undefined) (record as any)[key] = value;
		}
	}

	private save(record: SessionRecord, toDisk = true): void {
		this.records.set(record.id, record);
		this.publish({ type: "changed", record: publicRecord(record) });
		if (!toDisk) return;
		const lasting: SessionRecord = { ...record };
		for (const key of TRANSIENT_FIELDS) delete lasting[key];
		try {
			this.registry.write(lasting);
		} catch (error) {
			this.log(`record ${record.id} not saved`, error);
		}
	}
}

/** The default worker spawn: boot.mjs in its own process group, output to the worker log. */
export function spawnWorker({ record, task, name, inherit }: StartWorker, supervisor: Supervisor): ChildProcess {
	const { paths, bootFile } = supervisor.options;
	const log = workerLog(paths, record.id);
	const args = [bootFile, "worker", "--pi-dir", record.piDir, "--id", record.id];
	args.push("--supervisor", paths.supervisorSocket, "--socket", workerSocket(paths, record.id));
	args.push("--log", log, "--cwd", record.cwd);
	if (record.sessionFile) args.push("--session", record.sessionFile);
	if (task?.trim()) args.push("--task", task);
	if (name?.trim()) args.push("--name", name.trim());
	if (inherit?.model) args.push("--model", `${inherit.model.provider}/${inherit.model.id}`);
	if (inherit?.thinkingLevel) args.push("--thinking", inherit.thinkingLevel);
	if (inherit?.tools) args.push("--tools", inherit.tools.join(","));
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

function fileTime(file: string): number | undefined {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return undefined;
	}
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
