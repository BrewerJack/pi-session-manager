// Control channel between clients, the supervisor, and workers: one JSON record per line.
// Readers split only on "\n", never with readline, which also splits on U+2028 and U+2029.
import net from "node:net";
import type { Usage } from "./transcript.ts";

export type Outcome = "done" | "aborted" | "error";

/** The states of spec §6.2. */
export type SessionState = "starting" | "working" | "waiting" | "idle" | "saved" | "failed";

export interface ToolActivity {
	name: string;
	detail: string;
	startedAt: number;
}

/** One session as the supervisor stores it in sessions/<id>.json (spec §6.1). */
export interface SessionRecord {
	id: string;
	cwd: string;
	state: SessionState;
	sessionFile?: string;
	sessionId?: string;
	name?: string;
	firstPrompt?: string;
	pid?: number;
	pinned: boolean;
	createdAt: number;
	lastActivityAt: number;
	lastOutcome?: Outcome;
	error?: string;
	/** The allowed variables of the client that created the session (spec §6.3). */
	env: Record<string, string>;
	/** The pi package that runs the worker. */
	piDir: string;
	/** Model and thinking level, as the list shows them. */
	modelLabel?: string;
	usage?: Usage;
	/** The last user prompt and assistant reply, for the preview. */
	lastPrompt?: string;
	lastReply?: string;
	runStartedAt?: number;
	lastRunMs?: number;
	/** The title of the dialog that waits for the user. */
	promptTitle?: string;
	/** A run ended while no client held the session. */
	unread?: boolean;
	// The fields below change often or only matter while the worker lives. They stay out of the file.
	/** The running tool. */
	tool?: ToolActivity;
	/** The tail of the reply that streams in. */
	reply?: string;
	/** A client holds the session. */
	attached?: boolean;
	/** Paths that the session holds locks on (spec §9). */
	locks?: string[];
}

/** Record fields that never reach the disk. */
export const TRANSIENT_FIELDS = ["tool", "reply", "attached", "locks"] as const;

/** A record without the fields that clients do not need. The env can hold secrets. */
export type PublicRecord = Omit<SessionRecord, "env">;

export function publicRecord(record: SessionRecord): PublicRecord {
	const { env: _env, ...rest } = record;
	return rest;
}

type Reported = Omit<SessionRecord, "id" | "env" | "piDir" | "pinned" | "createdAt" | "lastActivityAt" | "pid" | "locks">;

/** What a worker reports about its session. null clears a field, because JSON drops undefined. */
export type WorkerUpdate = { [K in keyof Reported]?: Reported[K] | null };

/** What a new session takes over from the session that starts it (spec §7.2). */
export interface Inheritance {
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	tools?: string[];
}

export interface CreateRequest extends Inheritance {
	cwd: string;
	task?: string;
	name?: string;
	sessionFile?: string;
	env: Record<string, string>;
	piDir: string;
}

export interface Message {
	type: string;
	/** Correlates a request with its response. */
	id?: number;
	[key: string]: unknown;
}

export interface Response extends Message {
	type: "response";
	id: number;
	ok: boolean;
	data?: any;
	error?: string;
}

export function encodeLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/** Splits a byte stream into JSON records. Bad lines go to onError and the rest go on. */
export class LineDecoder {
	private buffer: Buffer = Buffer.alloc(0);

	push(chunk: Buffer, onError?: (line: string) => void): unknown[] {
		this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
		const out: unknown[] = [];
		let start = 0;
		let newline = this.buffer.indexOf(0x0a, start);
		while (newline !== -1) {
			let line = this.buffer.toString("utf8", start, newline);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.trim()) {
				try {
					out.push(JSON.parse(line));
				} catch {
					onError?.(line);
				}
			}
			start = newline + 1;
			newline = this.buffer.indexOf(0x0a, start);
		}
		this.buffer = this.buffer.subarray(start);
		return out;
	}
}

/** The data of a successful response. */
export type ReplyData = Record<string, unknown>;

type Handler = (message: Message, connection: Connection) => ReplyData | Promise<ReplyData> | undefined;

/**
 * A JSONL connection with requests and responses. A handler that returns a value or a
 * promise answers the request. A handler that throws answers with an error.
 */
export class Connection {
	readonly socket: net.Socket;
	private readonly decoder = new LineDecoder();
	private readonly pending = new Map<number, { resolve: (r: Response) => void; reject: (e: Error) => void }>();
	private nextId = 1;
	private handler?: Handler;
	private closed = false;

	constructor(socket: net.Socket) {
		this.socket = socket;
		socket.on("data", (chunk: Buffer) => {
			for (const value of this.decoder.push(chunk)) {
				if (value && typeof value === "object") this.dispatch(value as Message);
			}
		});
		socket.on("close", () => {
			this.closed = true;
			for (const { reject } of this.pending.values()) reject(new Error("The connection closed."));
			this.pending.clear();
		});
		socket.on("error", () => {
			// "close" follows and rejects the pending requests.
		});
	}

	get isClosed(): boolean {
		return this.closed || this.socket.destroyed;
	}

	onMessage(handler: Handler): void {
		this.handler = handler;
	}

	send(message: Message): void {
		if (!this.isClosed) this.socket.write(encodeLine(message));
	}

	/** Send a request and wait for its response. Rejects when the answer says ok: false. */
	request<T = any>(message: Message, timeoutMs = 30_000): Promise<T> {
		if (this.isClosed) return Promise.reject(new Error("The connection closed."));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`No answer to "${message.type}" in ${Math.round(timeoutMs / 1000)} s.`));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, {
				resolve: (response) => {
					clearTimeout(timer);
					if (response.ok) resolve(response.data as T);
					else reject(new Error(response.error || `"${message.type}" failed.`));
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.socket.write(encodeLine({ ...message, id }));
		});
	}

	/** End the connection. A peer that does not end its side within a second gets cut off. */
	close(): void {
		if (this.socket.destroyed) return;
		this.socket.end();
		setTimeout(() => this.socket.destroy(), 1000).unref?.();
	}

	private dispatch(message: Message): void {
		if (message.type === "response" && typeof message.id === "number") {
			const waiter = this.pending.get(message.id);
			this.pending.delete(message.id);
			waiter?.resolve(message as Response);
			return;
		}
		const id = message.id;
		const answer = (ok: boolean, data?: unknown, error?: string) => {
			if (typeof id === "number") this.send({ type: "response", id, ok, data, error });
		};
		let result: ReplyData | Promise<ReplyData> | undefined;
		try {
			result = this.handler?.(message, this);
		} catch (error) {
			answer(false, undefined, errorText(error));
			return;
		}
		Promise.resolve(result).then(
			(data) => answer(true, data),
			(error) => answer(false, undefined, errorText(error)),
		);
	}
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Connect to a Unix socket. Rejects when nobody listens. */
export function connect(socketPath: string): Promise<Connection> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(socketPath);
		socket.once("connect", () => {
			socket.off("error", reject);
			resolve(new Connection(socket));
		});
		socket.once("error", reject);
	});
}
