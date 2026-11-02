// SessionSource: what the manager overlay, the status bar, and the footer read (spec §11).
// RemoteSource implements it over the control socket of the supervisor. It keeps a copy of
// all records, which the supervisor updates with changed and removed events.
import path from "node:path";
import type { Connection, CreateRequest, Inheritance, Message, PublicRecord } from "./control.ts";
import type { LockAnswer } from "./locks.ts";
import { loadEnvAllow, pickEnv } from "./env.ts";
import type { BootContext, StatePaths } from "./paths.ts";
import { connectSupervisor } from "./supervisor-client.ts";
import type { TranscriptItem } from "./transcript.ts";

/** `plain` marks the session of plain pi itself, which the supervisor does not run. */
export type Row = PublicRecord & { plain?: boolean };
export type Activity = "idle" | "working" | "waiting";

export interface CreateOptions extends Inheritance {
	cwd: string;
	task?: string;
	name?: string;
	sessionFile?: string;
}

export interface SessionSource {
	/** The session that runs in this process, if any. */
	readonly currentId?: string;
	/** Why the list can be out of date. Undefined while the connection is fine. */
	readonly problem?: string;
	list(): Row[];
	get(idOrName: string): Row | undefined;
	subscribe(listener: () => void): () => void;
	/** The last known transcript. A call also fetches a fresh one when the session changed. */
	transcript(id: string): TranscriptItem[] | undefined;
	/** Connect, and start the supervisor when none runs. */
	ensureConnected(): Promise<void>;
	create(options: CreateOptions): Promise<Row>;
	send(id: string, text: string): Promise<void>;
	interrupt(id: string): Promise<void>;
	rename(id: string, name: string): Promise<void>;
	stop(id: string): Promise<void>;
	pin(id: string, pinned: boolean): Promise<void>;
	/** The socket of the worker. A saved session starts first. */
	attach(id: string): Promise<{ id: string; socket: string }>;
}

export function activityOf(row: Row): Activity {
	if (row.state === "waiting") return "waiting";
	return row.state === "working" ? "working" : "idle";
}

export function titleOf(row: Row): string {
	return row.name || row.firstPrompt || "new session";
}

/** By exact id, then name, then id prefix, then title prefix. The supervisor matches the same way. */
export function findRow(rows: readonly Row[], idOrName: string): Row | undefined {
	const needle = idOrName.trim().toLowerCase();
	if (!needle) return undefined;
	return (
		rows.find((r) => r.id === idOrName) ??
		rows.find((r) => r.name?.toLowerCase() === needle) ??
		rows.find((r) => r.id.toLowerCase().startsWith(needle)) ??
		rows.find((r) => titleOf(r).toLowerCase().startsWith(needle))
	);
}

const RECONNECT_MS = 3_000;
const TRANSCRIPT_MAX = 120;

export class RemoteSource implements SessionSource {
	readonly currentId?: string;
	problem?: string = "Connecting to the supervisor…";
	private connection?: Connection;
	private connecting?: Promise<void>;
	private readonly rows = new Map<string, Row>();
	private readonly listeners = new Set<() => void>();
	private readonly transcripts = new Map<string, { key: string; items: TranscriptItem[] }>();
	private readonly fetching = new Set<string>();
	private retryTimer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private inFlight = 0;
	private readonly paths: StatePaths;
	private readonly context: BootContext;
	/** Inside pi, the connection must not keep the process alive. pi-sm needs it to. */
	private readonly unref: boolean;

	constructor(paths: StatePaths, context: BootContext, options: { currentId?: string; unref?: boolean } = {}) {
		this.paths = paths;
		this.context = context;
		this.currentId = options.currentId;
		this.unref = options.unref ?? false;
	}

	/** Connect without starting a supervisor. Retries in the background until one runs. */
	watch(): void {
		void this.connect(false).catch(() => this.scheduleRetry());
	}

	ensureConnected(): Promise<void> {
		if (this.connection && !this.connection.isClosed) return Promise.resolve();
		return this.connect(true);
	}

	dispose(): void {
		this.disposed = true;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.connection?.close();
		this.listeners.clear();
	}

	list(): Row[] {
		return [...this.rows.values()].sort((a, b) => a.createdAt - b.createdAt);
	}

	get(idOrName: string): Row | undefined {
		return this.rows.get(idOrName) ?? findRow(this.list(), idOrName);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	transcript(id: string): TranscriptItem[] | undefined {
		const row = this.rows.get(id);
		if (!row) return undefined;
		const key = `${row.lastActivityAt}:${row.state}`;
		const cached = this.transcripts.get(id);
		if (cached?.key !== key && !this.fetching.has(id) && this.connection) {
			this.fetching.add(id);
			this.connection
				.request<{ items: TranscriptItem[] }>({ type: "transcript", session: id, max: TRANSCRIPT_MAX })
				.then(({ items }) => {
					this.transcripts.set(id, { key, items });
					this.notify();
				})
				.catch(() => this.transcripts.set(id, { key, items: cached?.items ?? [] }))
				.finally(() => this.fetching.delete(id));
		}
		return cached?.items;
	}

	async create(options: CreateOptions): Promise<Row> {
		const allow = loadEnvAllow(path.join(this.paths.agentDir, "settings.json"));
		const request: CreateRequest = { ...options, env: pickEnv(process.env, allow), piDir: this.context.piDir };
		const { record } = await this.request<{ record: Row }>({ type: "create", request }, 120_000);
		this.rows.set(record.id, record);
		this.notify();
		return record;
	}

	async send(id: string, text: string): Promise<void> {
		await this.request({ type: "send", session: id, text }, 120_000);
	}

	async interrupt(id: string): Promise<void> {
		await this.request({ type: "interrupt", session: id });
	}

	async rename(id: string, name: string): Promise<void> {
		await this.request({ type: "rename", session: id, name });
	}

	async stop(id: string): Promise<void> {
		await this.request({ type: "stop", session: id }, 60_000);
	}

	async pin(id: string, pinned: boolean): Promise<void> {
		await this.request({ type: "pin", session: id, pinned });
	}

	attach(id: string): Promise<{ id: string; socket: string }> {
		return this.request({ type: "attach", session: id }, 120_000);
	}

	/**
	 * Locks for a write of plain pi (spec §9). Without a supervisor, no session runs in the
	 * background, so nothing can conflict. A late answer lets the write go ahead.
	 */
	async acquireLock(paths: string[], cwd: string, toolCallId: string, label: string): Promise<LockAnswer> {
		const connection = this.connection;
		if (!connection || connection.isClosed) return { granted: true };
		this.inFlight++;
		connection.socket.ref();
		try {
			return await connection.request<LockAnswer>({ type: "lock.acquire", paths, cwd, toolCallId, label }, 5_000);
		} catch {
			return { granted: true };
		} finally {
			this.inFlight--;
			if (this.unref && this.inFlight === 0) connection.socket.unref();
		}
	}

	/** Saved sessions for session files. A file that a listed session uses returns that session. */
	async importSaved(files: string[]): Promise<Row[]> {
		const allow = loadEnvAllow(path.join(this.paths.agentDir, "settings.json"));
		const message = { type: "import", files, piDir: this.context.piDir, env: pickEnv(process.env, allow) };
		const { records } = await this.request<{ records: Row[] }>(message);
		for (const row of records) this.rows.set(row.id, row);
		this.notify();
		return records;
	}

	releaseLock(toolCallId: string): void {
		this.connection?.send({ type: "lock.release", toolCallId });
	}

	// --- Connection -------------------------------------------------------

	private async request<T = Record<string, unknown>>(message: Message, timeoutMs = 30_000): Promise<T> {
		await this.ensureConnected();
		const connection = this.connection!;
		// An unref'd socket lets the process end while it waits. Hold it during the request.
		this.inFlight++;
		connection.socket.ref();
		try {
			return await connection.request<T>(message, timeoutMs);
		} finally {
			this.inFlight--;
			if (this.unref && this.inFlight === 0) connection.socket.unref();
		}
	}

	private connect(start: boolean): Promise<void> {
		this.connecting ??= this.open(start).finally(() => {
			this.connecting = undefined;
		});
		return this.connecting;
	}

	private async open(start: boolean): Promise<void> {
		if (this.disposed) throw new Error("The session list is closed.");
		const handle = await connectSupervisor(this.paths, this.context, { start });
		const connection = handle.connection;
		if (this.unref) connection.socket.unref();
		connection.onMessage((message) => {
			this.event(message);
			return undefined;
		});
		const { sessions } = await connection.request<{ sessions: Row[] }>({ type: "subscribe" });
		this.rows.clear();
		for (const row of sessions) this.rows.set(row.id, row);
		this.connection = connection;
		this.problem = undefined;
		connection.socket.on("close", () => {
			if (this.connection !== connection) return;
			this.connection = undefined;
			this.problem = "Lost the connection to the supervisor. Reconnecting…";
			this.notify();
			this.scheduleRetry();
		});
		this.notify();
	}

	private event(message: Message): void {
		if (message.type === "changed" && message.record && typeof message.record === "object") {
			const row = message.record as Row;
			this.rows.set(row.id, row);
			this.notify();
		} else if (message.type === "removed" && typeof message.session === "string") {
			this.rows.delete(message.session);
			this.transcripts.delete(message.session);
			this.notify();
		}
	}

	private scheduleRetry(): void {
		if (this.disposed || this.retryTimer) return;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			void this.connect(false).catch(() => {
				this.problem = "The supervisor does not run.";
				this.notify();
				this.scheduleRetry();
			});
		}, RECONNECT_MS);
		this.retryTimer.unref?.();
	}

	private notify(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// One broken listener must not stop the others.
			}
		}
	}
}
