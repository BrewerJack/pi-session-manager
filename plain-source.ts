// PlainSource: the session list as plain pi shows it. The session of plain pi itself is the
// top row, marked "(this session)", like the main session of 0.3. All other rows come from the
// supervisor. A worker and pi-sm use the RemoteSource directly, because the supervisor already
// lists their sessions.
import { findRow, type CreateOptions, type Row, type SessionSource } from "./remote-source.ts";
import { firstUserText, lastExchange, transcriptOf, usageOf, type TranscriptItem } from "./transcript.ts";

/** The id of the plain row. The supervisor never makes ids of this form. */
export const PLAIN_ID = `plain-${process.pid}`;

const TRANSCRIPT_MAX = 120;

/** What the plain row reads from pi, and what it can do in pi. index.ts binds it to the pi context. */
export interface PlainSession {
	cwd(): string;
	entries(): readonly any[];
	branch(): readonly any[];
	sessionFile(): string | undefined;
	sessionId(): string | undefined;
	name(): string | undefined;
	modelLabel(): string | undefined;
	contextPercent(): number | null;
	busy(): boolean;
	send(text: string, busy: boolean): void | Promise<void>;
	rename(name: string): void;
	interrupt(): void;
}

export const PLAIN_STOP_TEXT = "This is the session of plain pi. Use /quit to end it, or /sessions bg to move it to the background.";
export const PLAIN_PIN_TEXT = "Only background sessions take a pin. /sessions bg moves this session to the background.";

export class PlainSource implements SessionSource {
	readonly currentId = PLAIN_ID;
	private session?: PlainSession;
	private cached?: Row;
	private readonly listeners = new Set<() => void>();
	private readonly inner: SessionSource;
	private readonly piDir: string;
	private readonly startedAt = Date.now();

	constructor(inner: SessionSource, piDir: string) {
		this.inner = inner;
		this.piDir = piDir;
	}

	get problem(): string | undefined {
		return this.inner.problem;
	}

	/** Attach the row to a pi session, or remove the row with undefined. */
	bind(session: PlainSession | undefined): void {
		this.session = session;
		this.changed();
	}

	/** pi reports a change of the plain session. The next list() builds the row again. */
	changed(): void {
		this.cached = undefined;
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// One broken listener must not stop the others.
			}
		}
	}

	/** The row of plain pi, or undefined when bind() got no session. */
	row(): Row | undefined {
		if (!this.session) return undefined;
		this.cached ??= this.build(this.session);
		return this.cached;
	}

	list(): Row[] {
		const own = this.row();
		const rest = this.inner.list();
		return own ? [own, ...rest] : rest;
	}

	get(idOrName: string): Row | undefined {
		const own = this.row();
		if (idOrName === PLAIN_ID) return own;
		// Background sessions win a tie. The plain row matches only when no other row does.
		return this.inner.get(idOrName) ?? (own ? findRow([own], idOrName) : undefined);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		const stopInner = this.inner.subscribe(listener);
		return () => {
			this.listeners.delete(listener);
			stopInner();
		};
	}

	transcript(id: string): TranscriptItem[] | undefined {
		if (id !== PLAIN_ID) return this.inner.transcript(id);
		try {
			return this.session ? transcriptOf(this.session.branch(), TRANSCRIPT_MAX) : undefined;
		} catch {
			return undefined;
		}
	}

	ensureConnected(): Promise<void> {
		return this.inner.ensureConnected();
	}

	create(options: CreateOptions): Promise<Row> {
		return this.inner.create(options);
	}

	async send(id: string, text: string): Promise<void> {
		if (id !== PLAIN_ID) return this.inner.send(id, text);
		const session = this.need();
		await session.send(text, session.busy());
		this.changed();
	}

	async interrupt(id: string): Promise<void> {
		if (id !== PLAIN_ID) return this.inner.interrupt(id);
		this.need().interrupt();
		this.changed();
	}

	async rename(id: string, name: string): Promise<void> {
		if (id !== PLAIN_ID) return this.inner.rename(id, name);
		this.need().rename(name);
		this.changed();
	}

	async stop(id: string): Promise<void> {
		if (id !== PLAIN_ID) return this.inner.stop(id);
		throw new Error(PLAIN_STOP_TEXT);
	}

	async pin(id: string, pinned: boolean): Promise<void> {
		if (id !== PLAIN_ID) return this.inner.pin(id, pinned);
		throw new Error(PLAIN_PIN_TEXT);
	}

	attach(id: string): Promise<{ id: string; socket: string }> {
		if (id !== PLAIN_ID) return this.inner.attach(id);
		return Promise.reject(new Error("This session already shows in this terminal."));
	}

	private need(): PlainSession {
		if (!this.session) throw new Error("The session of plain pi is not ready.");
		return this.session;
	}

	private build(session: PlainSession): Row {
		const read = <T>(get: () => T, fallback: T): T => {
			try {
				return get();
			} catch {
				return fallback;
			}
		};
		const entries = read(() => session.entries(), []);
		const branch = read(() => session.branch(), []);
		const { prompt, reply } = read(() => lastExchange(branch), {});
		const last = entries.length ? Date.parse(String(entries[entries.length - 1]?.timestamp ?? "")) : NaN;
		return {
			id: PLAIN_ID,
			plain: true,
			cwd: read(() => session.cwd(), ""),
			state: read(() => session.busy(), false) ? "working" : "idle",
			sessionFile: read(() => session.sessionFile(), undefined),
			sessionId: read(() => session.sessionId(), undefined),
			name: read(() => session.name(), undefined),
			firstPrompt: firstUserText(entries),
			pinned: false,
			createdAt: this.startedAt,
			lastActivityAt: Number.isFinite(last) ? last : this.startedAt,
			piDir: this.piDir,
			modelLabel: read(() => session.modelLabel(), undefined),
			usage: { ...usageOf(entries), contextPercent: read(() => session.contextPercent(), null) },
			lastPrompt: prompt,
			lastReply: reply,
			attached: false,
		};
	}
}
