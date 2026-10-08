// Live-session host: keeps several pi sessions alive in one process and hands the
// terminal to one of them at a time.
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	getPackageDir,
	hasTrustRequiringProjectResources,
	InteractiveMode,
	ProjectTrustStore,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionFromServicesOptions,
} from "@earendil-works/pi-coding-agent";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { LockManager } from "./locks.ts";
import { debug } from "./log.ts";

export { inferToolPaths } from "./locks.ts";
export { debug } from "./log.ts";

export const PARENT_ID = "__parent__";
const HOST_KEY = "__PI_SESSION_MANAGER_HOST__";
const SPINNER_PATCHED: unique symbol = Symbol.for("pi-session-manager.spinnerPatched");
const STATS_TTL_MS = 1000;

type Ctx = any;
type Api = any;

export type Activity = "idle" | "working" | "waiting";
type LiveState = "active" | "background" | "starting" | "stopped" | "error";
export type Outcome = "done" | "aborted" | "error";

interface ToolActivity {
	id: string;
	name: string;
	detail: string;
	startedAt: number;
}

export interface SessionStatsView {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	contextTokens: number | null;
	contextWindow: number | null;
	contextPercent: number | null;
}

export interface TranscriptItem {
	kind: "user" | "assistant" | "thinking" | "tool" | "toolError" | "info";
	text: string;
}

export interface LiveSession {
	id: string;
	kind: "parent" | "child";
	cwd: string;
	state: LiveState;
	sessionFile?: string;
	sessionId?: string;
	sessionName?: string;
	firstPrompt?: string;
	createdAt: number;
	lastActivityAt: number;
	running: boolean;
	runStartedAt?: number;
	lastRunMs?: number;
	lastOutcome?: Outcome;
	tool?: ToolActivity;
	streamingText?: string;
	unread: boolean;
	promptDepth: number;
	promptTitle?: string;
	ownPromptPending: number;
	ignoredPromptEnds: number;
	error?: string;
	context?: Ctx;
	pi?: Api;
	runtime?: any;
	mode?: any;
	view?: ChildView;
	terminal?: GatedTerminal;
	inheritance?: any;
	runPromise?: Promise<void>;
	expectedStop?: boolean;
	statsCache?: { at: number; value: SessionStatsView };
}

// ---------------------------------------------------------------------------
// Small helpers

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part: any) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join(" ");
}

function oneLine(text: string, max = 200): string {
	return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function firstUserText(sessionManager: any): string | undefined {
	try {
		for (const entry of sessionManager?.getEntries?.() ?? []) {
			if (entry?.type !== "message" || entry.message?.role !== "user") continue;
			const text = oneLine(textOf(entry.message.content));
			if (text) return text;
		}
	} catch (error) {
		debug(error);
	}
	return undefined;
}

export function summarizeToolArgs(toolName: string, args: any): string {
	if (!args || typeof args !== "object") return "";
	const pick = (...keys: string[]) => {
		for (const key of keys) {
			if (typeof args[key] === "string" && args[key].trim()) return args[key];
		}
		return undefined;
	};
	const value =
		(toolName === "bash" ? pick("command") : undefined) ??
		pick("path", "file_path", "filePath", "pattern", "query", "url", "command", "task", "prompt") ??
		Object.values(args).find((v) => typeof v === "string" && v.trim());
	return typeof value === "string" ? oneLine(value.split("\n")[0] ?? "", 120) : "";
}

function sanitizeName(name: string): string {
	return (
		String(name || "")
			.trim()
			.replace(/[^a-zA-Z0-9_.-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "session"
	);
}

function resetExtendedKeyboardModesForHandoff(): void {
	try {
		process.stdout.write("\x1b[<999u\x1b[>4;0m");
	} catch (error) {
		debug(error);
	}
}

// ---------------------------------------------------------------------------
// Runtime inheritance: children start with the model, thinking level, and tools
// of the session that created them.

/** The options that a child session takes over from the session that created it. */
type ChildSessionOptions = Partial<
	Pick<CreateAgentSessionFromServicesOptions, "model" | "thinkingLevel" | "scopedModels" | "tools">
>;

let modelResolverPromise: Promise<any> | null = null;
const inheritanceBySessionManager = new WeakMap<object, any>();

async function loadModelResolver(): Promise<any> {
	modelResolverPromise ??= import(
		pathToFileURL(path.join(getPackageDir(), "dist/core/model-resolver.js")).href
	);
	return modelResolverPromise;
}

function sameModel(a: any, b: any): boolean {
	if (!a || !b) return false;
	return a.provider === b.provider && a.id === b.id;
}

function hasExistingMessages(sessionManager: any): boolean {
	return (sessionManager.buildSessionContext?.().messages?.length ?? 0) > 0;
}

function collectInheritance(ctx?: Ctx): any {
	if (!ctx) return {};
	try {
		const promptOptions = ctx.getSystemPromptOptions?.() ?? {};
		const sessionOptions: any = {};
		if (Array.isArray(promptOptions.selectedTools)) sessionOptions.tools = [...promptOptions.selectedTools];
		if (ctx.model) sessionOptions.model = ctx.model;
		if (ctx.thinkingLevel) sessionOptions.thinkingLevel = ctx.thinkingLevel;
		return { ctx, sessionOptions };
	} catch (error) {
		debug(error);
		return {};
	}
}

function createInheritedSettingsManager(cwd: string, agentDir: string, inheritance: any) {
	const diagnostics: any[] = [];
	const sameCwd = inheritance?.ctx?.cwd && path.resolve(inheritance.ctx.cwd) === path.resolve(cwd);
	let projectTrusted = true;
	if (sameCwd) {
		try {
			projectTrusted = inheritance.ctx.isProjectTrusted?.() ?? true;
		} catch (error) {
			debug(error);
		}
	} else if (hasTrustRequiringProjectResources(cwd)) {
		projectTrusted = new ProjectTrustStore(agentDir).get(cwd) === true;
		if (!projectTrusted) {
			diagnostics.push({ type: "warning", message: `Project resources in child cwd are not trusted: ${cwd}` });
		}
	}
	return { settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted }), diagnostics };
}

async function resolveChildSessionOptions(
	services: any,
	sessionManager: any,
	inheritance: any,
): Promise<ChildSessionOptions> {
	const inherited: ChildSessionOptions = { ...(inheritance?.sessionOptions ?? {}) };
	const existing = hasExistingMessages(sessionManager);
	// A session with history keeps its own model and thinking level.
	let options: ChildSessionOptions = { ...inherited };
	if (existing) {
		options = {};
		if (inherited.tools) options.tools = inherited.tools;
	}
	// Each child owns its model runtime. Look the inherited model up there.
	if (options.model) {
		options.model = services.modelRegistry?.find?.(options.model.provider, options.model.id) ?? options.model;
	}
	const patterns = services.settingsManager?.getEnabledModels?.();
	if (!patterns?.length) return options;
	const { resolveModelScope } = await loadModelResolver();
	const scopedModels = await resolveModelScope(patterns, services.modelRegistry);
	if (!scopedModels.length) return options;
	options.scopedModels = scopedModels;
	if (!existing) {
		const inherited = inheritance?.sessionOptions?.model;
		const savedProvider = services.settingsManager?.getDefaultProvider?.();
		const savedModelId = services.settingsManager?.getDefaultModel?.();
		const saved = savedProvider && savedModelId ? services.modelRegistry.find(savedProvider, savedModelId) : undefined;
		const selected =
			scopedModels.find((s: any) => sameModel(s.model, inherited)) ??
			scopedModels.find((s: any) => sameModel(s.model, saved)) ??
			scopedModels[0];
		options.model = selected.model;
		if (selected.thinkingLevel) options.thinkingLevel = selected.thinkingLevel;
	}
	return options;
}

const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }: any) => {
	const host = getHost();
	const active = host.activeId !== PARENT_ID ? host.get(host.activeId) : undefined;
	let inheritance = inheritanceBySessionManager.get(sessionManager);
	// /new and /resume inside a child build a fresh SessionManager. Reattach the
	// inheritance of the active child before pi constructs the session.
	if (!inheritance && active?.kind === "child") {
		inheritance = active.inheritance ?? collectInheritance(active.context);
		inheritanceBySessionManager.set(sessionManager, inheritance);
		active.inheritance = inheritance;
	}
	inheritance ??= {};
	const inherited = createInheritedSettingsManager(cwd, agentDir, inheritance);
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		settingsManager: inherited.settingsManager,
	});
	services.diagnostics.push(...inherited.diagnostics);
	let sessionOptions: any = {};
	try {
		sessionOptions = await resolveChildSessionOptions(services, sessionManager, inheritance);
	} catch (error) {
		services.diagnostics.push({
			type: "warning",
			message: `Failed to resolve inherited child session options: ${String(error)}`,
		});
	}
	const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, ...sessionOptions });
	return { ...result, services, diagnostics: services.diagnostics };
};

// ---------------------------------------------------------------------------
// GatedTerminal is the terminal that a child InteractiveMode draws to. While its
// gate stays closed, it drops output and input. A child can therefore run, bind
// extensions, and keep its TUI current in the background. It never touches the screen.

class GatedTerminal {
	private readonly inner: any = new ProcessTerminal();
	private open = false;
	private innerStarted = false;
	private title?: string;
	private progress = false;

	constructor() {
		// Forward members outside the Terminal interface to the real terminal.
		return new Proxy(this, {
			get(target, property, receiver) {
				if (property in target) return Reflect.get(target, property, receiver);
				const value = target.inner[property];
				return typeof value === "function" ? value.bind(target.inner) : value;
			},
		});
	}

	get isOpen(): boolean {
		return this.open;
	}
	get columns(): number {
		return this.inner.columns;
	}
	get rows(): number {
		return this.inner.rows;
	}
	get kittyProtocolActive(): boolean {
		return this.inner.kittyProtocolActive;
	}
	get modifyOtherKeysActive(): boolean {
		return this.inner.modifyOtherKeysActive;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		if (this.open && !this.innerStarted) {
			this.innerStarted = true;
			this.inner.start(onInput, onResize);
		}
	}

	stop(): void {
		if (!this.innerStarted) return;
		this.innerStarted = false;
		this.inner.stop();
	}

	drainInput(maxMs?: number, idleMs?: number): Promise<void> {
		return this.innerStarted ? this.inner.drainInput(maxMs, idleMs) : Promise.resolve();
	}

	write(data: string): void {
		if (this.open) this.inner.write(data);
	}
	moveBy(lines: number): void {
		if (this.open) this.inner.moveBy(lines);
	}
	hideCursor(): void {
		if (this.open) this.inner.hideCursor();
	}
	showCursor(): void {
		if (this.open) this.inner.showCursor();
	}
	clearLine(): void {
		if (this.open) this.inner.clearLine();
	}
	clearFromCursor(): void {
		if (this.open) this.inner.clearFromCursor();
	}
	clearScreen(): void {
		if (this.open) this.inner.clearScreen();
	}
	setTitle(title: string): void {
		this.title = title;
		if (this.open) this.inner.setTitle(title);
	}
	setProgress(active: boolean): void {
		this.progress = active;
		if (this.open) this.inner.setProgress(active);
	}
	setProgramStatus(status: unknown): void {
		if (this.open) this.inner.setProgramStatus?.(status);
	}

	openGate(): void {
		this.open = true;
		if (this.title) this.inner.setTitle(this.title);
		this.inner.setProgress(this.progress);
	}

	closeGate(): void {
		this.stop();
		this.open = false;
	}
}

// ---------------------------------------------------------------------------
// ChildView drives one child InteractiveMode. Every child starts headless.
// The show() and hide() methods move the real terminal in and out.

class ChildView {
	shown = false;
	stopped = false;

	constructor(
		private readonly record: LiveSession,
		private readonly host: SessionHost,
	) {}

	private get ui(): any {
		return this.record.mode?.ui;
	}

	launch(): void {
		const record = this.record;
		// InteractiveMode.init() prints model-scope details with console.log before
		// its first await. Keep that text off the screen of the active session.
		const log = console.log;
		console.log = () => {};
		try {
			record.runPromise = record.mode.run().catch((error: any) => {
				record.state = record.expectedStop ? "stopped" : "error";
				record.error = String(error?.message || error);
				this.host.locks.release(record.id);
				this.host.notify();
			});
		} finally {
			console.log = log;
		}
		// Stop the hidden TUI once init finishes, so it does not render for nothing.
		const startedAt = Date.now();
		const timer = setInterval(() => {
			const done = record.mode?.isInitialized || Date.now() - startedAt > 15_000;
			if (!done && !this.stopped) return;
			clearInterval(timer);
			if (!this.shown && !this.stopped) {
				try {
					this.ui?.stop?.();
				} catch (error) {
					debug(error);
				}
			}
		}, 50);
	}

	show(): void {
		if (this.stopped) return;
		const ui = this.ui;
		try {
			// With the gate closed, this only marks the TUI stopped. Then start it for real.
			ui?.stop?.();
		} catch (error) {
			debug(error);
		}
		this.record.terminal?.openGate();
		this.shown = true;
		try {
			ui?.start?.();
			ui?.requestRender?.(true);
		} catch (error) {
			debug(error);
		}
	}

	hide(): void {
		if (!this.shown) return;
		try {
			this.ui?.stop?.();
			resetExtendedKeyboardModesForHandoff();
		} catch (error) {
			debug(error);
		}
		this.record.terminal?.closeGate();
		this.shown = false;
	}

	async dispose(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		try {
			this.record.mode?.stop?.();
		} catch (error) {
			debug(error);
		}
		this.shown = false;
		this.record.terminal?.closeGate();
		try {
			await this.record.runtime?.dispose?.();
		} catch (error) {
			debug(error);
		}
	}
}

// ---------------------------------------------------------------------------
// SessionHost

export interface CreateChildOptions {
	cwd: string;
	ctx?: Ctx;
	task?: string;
	name?: string;
	sessionManager?: any;
}

export class SessionHost {
	activeId = PARENT_ID;
	records = new Map<string, LiveSession>();
	subscribers = new Set<() => void>();
	locks = new LockManager();
	parentTui: any = null;
	parentDone: (() => void) | null = null;
	parentHandoffActive = false;
	activationInProgress: Promise<void> | null = null;
	queuedActivation: string | null = null;
	workingIndicator: { frames?: string[]; intervalMs?: number } | undefined;
	/** The manager overlay is open in some session. */
	managerOpen = false;
	/** Shortcut warnings reached the user once. */
	warnedKeys = false;
	private notifyScheduled = false;
	/** The main session. It lives as long as the process. */
	readonly parent: LiveSession;

	constructor() {
		const now = Date.now();
		this.parent = {
			id: PARENT_ID,
			kind: "parent",
			cwd: process.cwd(),
			state: "active",
			createdAt: now,
			lastActivityAt: now,
			running: false,
			unread: false,
			promptDepth: 0,
			ownPromptPending: 0,
			ignoredPromptEnds: 0,
		};
		this.records.set(PARENT_ID, this.parent);
	}

	get(idOrName: string): LiveSession | undefined {
		const direct = this.records.get(idOrName);
		if (direct) return direct;
		const needle = idOrName.trim().toLowerCase();
		if (!needle) return undefined;
		const live = this.list();
		return (
			live.find((r) => r.sessionName?.toLowerCase() === needle) ??
			live.find((r) => r.id.toLowerCase().startsWith(needle)) ??
			live.find((r) => titleOf(r).toLowerCase().startsWith(needle))
		);
	}

	list(): LiveSession[] {
		const children = [...this.records.values()].filter((r) => r.kind === "child" && r.state !== "stopped");
		return [this.parent, ...children];
	}

	subscribe(listener: () => void): () => void {
		this.subscribers.add(listener);
		return () => this.subscribers.delete(listener);
	}

	notify(): void {
		for (const listener of [...this.subscribers]) {
			try {
				listener();
			} catch (error) {
				debug(error);
			}
		}
	}

	/** Coalesce bursts of streaming updates into one notification. */
	notifySoon(): void {
		if (this.notifyScheduled) return;
		this.notifyScheduled = true;
		setTimeout(() => {
			this.notifyScheduled = false;
			this.notify();
		}, 100);
	}

	/** Show a notice in whichever session currently owns the terminal. */
	notifyActive(message: string, type: "info" | "warning" | "error" = "info"): void {
		try {
			this.records.get(this.activeId)?.context?.ui?.notify?.(message, type);
		} catch (error) {
			debug(error);
		}
	}

	activity(record: LiveSession): Activity {
		if (record.promptDepth > 0) return "waiting";
		return record.running ? "working" : "idle";
	}

	sessionManagerOf(record: LiveSession): any {
		try {
			return record.runtime?.session?.sessionManager ?? record.context?.sessionManager;
		} catch {
			return undefined;
		}
	}

	refreshMeta(record: LiveSession): void {
		const sm = this.sessionManagerOf(record);
		if (!sm) return;
		try {
			const sessionId = sm.getSessionId?.();
			if (sessionId && record.sessionId && sessionId !== record.sessionId) {
				record.firstPrompt = undefined;
				record.statsCache = undefined;
			}
			record.sessionId = sessionId ?? record.sessionId;
			record.sessionFile = sm.getSessionFile?.() ?? record.sessionFile;
			record.sessionName = sm.getSessionName?.() || undefined;
			record.cwd = sm.getCwd?.() || record.cwd;
			record.firstPrompt ??= firstUserText(sm);
		} catch (error) {
			debug(error);
		}
	}

	/** Find (or adopt) the record that owns this extension context. */
	bind(ctx: Ctx, pi?: Api): LiveSession {
		let sessionId: string | undefined;
		let sessionFile: string | undefined;
		try {
			sessionId = ctx.sessionManager?.getSessionId?.();
			sessionFile = ctx.sessionManager?.getSessionFile?.();
		} catch (error) {
			debug(error);
		}
		const matches = (r: LiveSession) =>
			(sessionId && r.sessionId === sessionId) || (sessionFile && r.sessionFile === sessionFile);
		let record = [...this.records.values()].find((r) => r.kind === "child" && matches(r));
		if (!record && matches(this.parent)) record = this.parent;
		if (!record) {
			// /new or /resume inside the active child changes its identity before we
			// can match it. Route that context to the active child, or else to the parent.
			const active = this.activeId !== PARENT_ID ? this.records.get(this.activeId) : undefined;
			record = active?.kind === "child" ? active : this.parent;
		}
		record.context = ctx;
		if (pi) record.pi = pi;
		if (record.kind === "parent") {
			try {
				record.cwd = ctx.cwd || record.cwd;
				record.sessionId = sessionId ?? record.sessionId;
				record.sessionFile = sessionFile ?? record.sessionFile;
			} catch (error) {
				debug(error);
			}
		}
		this.refreshMeta(record);
		return record;
	}

	async createChild(opts: CreateChildOptions): Promise<LiveSession> {
		if (opts.ctx) this.bind(opts.ctx);
		const sessionManager = opts.sessionManager ?? SessionManager.create(opts.cwd, undefined, {});
		const inheritance = collectInheritance(opts.ctx);
		const now = Date.now();
		const slug = sanitizeName(opts.name || path.basename(opts.cwd));
		const id = `${slug}-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
		const record: LiveSession = {
			id,
			kind: "child",
			cwd: opts.cwd,
			state: "starting",
			createdAt: now,
			lastActivityAt: now,
			running: false,
			unread: false,
			promptDepth: 0,
			ownPromptPending: 0,
			ignoredPromptEnds: 0,
			inheritance,
			firstPrompt: opts.task ? oneLine(opts.task) : undefined,
		};
		this.records.set(id, record);
		this.notify();
		inheritanceBySessionManager.set(sessionManager, inheritance);
		try {
			const runtime = await createAgentSessionRuntime(createRuntime, {
				cwd: opts.cwd,
				agentDir: getAgentDir(),
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "startup" },
			});
			const terminal = new GatedTerminal();
			const mode = new InteractiveMode(runtime, {
				migratedProviders: [],
				modelFallbackMessage: runtime.modelFallbackMessage,
				initialMessage: opts.task?.trim() || undefined,
				initialImages: [],
				initialMessages: [],
				terminal,
			});
			record.runtime = runtime;
			record.mode = mode;
			record.terminal = terminal;
			record.view = new ChildView(record, this);
			record.state = "background";
			if (opts.name) runtime.session.setSessionName(opts.name);
			this.refreshMeta(record);
			record.view.launch();
		} catch (error: any) {
			record.state = "error";
			record.error = String(error?.message || error);
			this.notify();
			throw error;
		}
		this.notify();
		return record;
	}

	async openSaved(sessionPath: string, ctx?: Ctx): Promise<LiveSession> {
		const existing = this.list().find((r) => r.sessionFile === sessionPath);
		if (existing) return existing;
		const sessionManager = SessionManager.open(sessionPath, undefined, undefined);
		const cwd = sessionManager.getCwd?.() || process.cwd();
		return this.createChild({ cwd, ctx, sessionManager });
	}

	async stopChild(idOrName: string): Promise<void> {
		const record = this.get(idOrName);
		if (!record || record.kind !== "child") throw new Error("session not found");
		const wasActive = this.activeId === record.id;
		record.expectedStop = true;
		record.state = "stopped";
		this.locks.release(record.id);
		try {
			if (record.running) await record.runtime?.session?.abort?.();
		} catch (error) {
			debug(error);
		}
		if (wasActive) record.view?.hide();
		await record.view?.dispose();
		this.records.delete(record.id);
		this.notify();
		if (wasActive) await this.activate(PARENT_ID);
	}

	async activate(target: string): Promise<void> {
		const record = this.get(target);
		if (!record) throw new Error(`session not found: ${target}`);
		if (this.activationInProgress) {
			this.queuedActivation = record.id;
			await this.activationInProgress;
			return;
		}
		this.activationInProgress = this.doActivate(record).finally(() => {
			this.activationInProgress = null;
		});
		await this.activationInProgress;
		const queued = this.queuedActivation;
		this.queuedActivation = null;
		if (queued && queued !== this.activeId) await this.activate(queued);
	}

	private async doActivate(target: LiveSession): Promise<void> {
		if (target.id === this.activeId) return;
		const current = this.records.get(this.activeId);
		if (current?.kind === "child") current.view?.hide();
		if (current) current.state = "background";
		target.unread = false;
		if (target.kind === "parent") {
			this.activeId = PARENT_ID;
			target.state = "active";
			try {
				this.parentTui?.terminal?.setProgress?.(false);
				this.parentTui?.start?.();
				this.parentTui?.requestRender?.(true);
			} catch (error) {
				debug(error);
			}
			const done = this.parentDone;
			this.parentTui = null;
			this.parentDone = null;
			this.parentHandoffActive = false;
			this.notify();
			done?.();
			return;
		}
		this.activeId = target.id;
		target.state = "active";
		target.view?.show();
		this.notify();
	}

	/** The parent TUI is not ours to stop directly. Park it inside a custom UI. */
	async enterFromParent(ctx: Ctx, targetId: string): Promise<void> {
		if (this.parentHandoffActive) return this.activate(targetId);
		const parent = this.parent;
		parent.ownPromptPending++;
		await ctx.ui.custom((tui: any, _theme: any, _kb: any, done: () => void) => {
			this.parentTui = tui;
			this.parentDone = done;
			this.parentHandoffActive = true;
			try {
				tui.stop();
				resetExtendedKeyboardModesForHandoff();
			} catch (error) {
				debug(error);
			}
			void this.activate(targetId).catch((error: any) => {
				try {
					tui.start();
					tui.requestRender(true);
				} catch (error) {
					debug(error);
				}
				this.parentHandoffActive = false;
				this.parentTui = null;
				this.parentDone = null;
				ctx.ui.notify(String(error?.message || error), "error");
				done();
			});
			return { render: () => [], invalidate: () => {}, dispose: () => {} };
		});
		// If pi did not report this custom UI as a prompt, drop the unused marker.
		if (parent.ownPromptPending > 0) parent.ownPromptPending--;
	}

	async activateFromContext(ctx: Ctx, targetId: string): Promise<void> {
		const current = this.bind(ctx).id;
		if (current === PARENT_ID && targetId !== PARENT_ID) await this.enterFromParent(ctx, targetId);
		else await this.activate(targetId);
	}

	// --- Per-session operations -------------------------------------------

	rename(record: LiveSession, name: string): void {
		const trimmed = name.trim();
		if (!trimmed) return;
		const session = record.runtime?.session;
		if (session) session.setSessionName(trimmed);
		else if (record.pi) record.pi.setSessionName(trimmed);
		else throw new Error("This session cannot be renamed yet.");
		record.sessionName = trimmed;
		this.notify();
	}

	send(record: LiveSession, text: string): void {
		const message = text.trim();
		if (!message) return;
		const session = record.runtime?.session;
		const busy = session ? session.isStreaming : record.running;
		const options = busy ? { deliverAs: "followUp" as const } : undefined;
		record.lastActivityAt = Date.now();
		record.firstPrompt ??= oneLine(message);
		if (session) {
			void session.sendUserMessage(message, options).catch((error: any) => {
				record.error = String(error?.message || error);
				this.notify();
			});
		} else if (record.pi) {
			record.pi.sendUserMessage(message, options);
		} else {
			throw new Error("This session cannot receive messages yet.");
		}
		this.notify();
	}

	async interrupt(record: LiveSession): Promise<void> {
		const session = record.runtime?.session;
		if (session) await session.abort();
		else record.context?.abort?.();
	}

	stats(record: LiveSession): SessionStatsView {
		const now = Date.now();
		if (record.statsCache && now - record.statsCache.at < STATS_TTL_MS) return record.statsCache.value;
		const value = this.computeStats(record);
		record.statsCache = { at: now, value };
		return value;
	}

	private computeStats(record: LiveSession): SessionStatsView {
		const out: SessionStatsView = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			userMessages: 0,
			assistantMessages: 0,
			toolCalls: 0,
			contextTokens: null,
			contextWindow: null,
			contextPercent: null,
		};
		try {
			const session = record.runtime?.session;
			if (session) {
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
			}
			for (const entry of record.context?.sessionManager?.getEntries?.() ?? []) {
				if (entry?.type !== "message") continue;
				const msg = entry.message;
				if (msg?.role === "user") out.userMessages++;
				if (msg?.role !== "assistant") continue;
				out.assistantMessages++;
				if (Array.isArray(msg.content)) {
					out.toolCalls += msg.content.filter((p: any) => p?.type === "toolCall").length;
				}
				const u = msg.usage;
				if (!u) continue;
				out.input += u.input ?? 0;
				out.output += u.output ?? 0;
				out.cacheRead += u.cacheRead ?? 0;
				out.cacheWrite += u.cacheWrite ?? 0;
				out.cost += u.cost?.total ?? 0;
			}
			const usage = record.context?.getContextUsage?.();
			if (usage) {
				out.contextTokens = usage.tokens;
				out.contextWindow = usage.contextWindow;
				out.contextPercent = usage.percent;
			}
		} catch (error) {
			debug(error);
		}
		return out;
	}

	modelLabel(record: LiveSession): string {
		try {
			const session = record.runtime?.session;
			const model = session?.model ?? record.context?.model;
			const thinking = session?.thinkingLevel ?? record.context?.thinkingLevel;
			if (!model) return "";
			return thinking && thinking !== "off" ? `${model.id} · ${thinking}` : model.id;
		} catch {
			return "";
		}
	}

	transcript(record: LiveSession, maxItems = 80): TranscriptItem[] {
		const items: TranscriptItem[] = [];
		try {
			const branch = this.sessionManagerOf(record)?.getBranch?.() ?? [];
			for (const entry of branch) {
				if (entry?.type === "compaction") {
					items.push({ kind: "info", text: "— conversation compacted —" });
					continue;
				}
				if (entry?.type !== "message") continue;
				const msg = entry.message;
				if (msg?.role === "user") {
					const text = textOf(msg.content).trim();
					if (text) items.push({ kind: "user", text });
				} else if (msg?.role === "assistant" && Array.isArray(msg.content)) {
					for (const part of msg.content) {
						if (part?.type === "text" && part.text?.trim()) {
							items.push({ kind: "assistant", text: part.text.trim() });
						} else if (part?.type === "toolCall") {
							const detail = summarizeToolArgs(part.name, part.arguments);
							items.push({ kind: "tool", text: detail ? `${part.name} ${detail}` : part.name });
						}
					}
					if (msg.stopReason === "error" && msg.errorMessage) {
						items.push({ kind: "toolError", text: oneLine(msg.errorMessage, 300) });
					}
				} else if (msg?.role === "toolResult" && msg.isError) {
					items.push({ kind: "toolError", text: oneLine(textOf(msg.content), 300) || `${msg.toolName} failed` });
				} else if (msg?.role === "bashExecution") {
					items.push({ kind: "tool", text: `! ${oneLine(String(msg.command ?? ""), 200)}` });
				}
			}
		} catch (error) {
			debug(error);
		}
		if (record.running && record.streamingText?.trim()) {
			items.push({ kind: "assistant", text: record.streamingText.trim() });
		}
		return items.slice(-maxItems);
	}

	lastReply(record: LiveSession): string | undefined {
		if (record.running && record.streamingText?.trim()) return record.streamingText.trim();
		const items = this.transcript(record, 40);
		for (let i = items.length - 1; i >= 0; i--) {
			const item = items[i];
			if (item?.kind === "assistant") return item.text;
		}
		return undefined;
	}

	lastPrompt(record: LiveSession): string | undefined {
		const items = this.transcript(record, 80);
		for (let i = items.length - 1; i >= 0; i--) {
			const item = items[i];
			if (item?.kind === "user") return oneLine(item.text);
		}
		return record.firstPrompt;
	}
}

export function titleOf(record: LiveSession): string {
	return record.sessionName || record.firstPrompt || (record.kind === "parent" ? "main session" : "new session");
}

export function getHost(): SessionHost {
	// One host per process, shared by the extension instances of every session.
	const g = globalThis as typeof globalThis & Record<string, SessionHost | undefined>;
	const host = g[HOST_KEY] ?? new SessionHost();
	g[HOST_KEY] = host;
	return host;
}

type IndicatorOptions = { frames?: string[]; intervalMs?: number };

/** The members of InteractiveMode.prototype that the spinner patch touches. */
interface PatchableMode {
	setWorkingIndicator?: (this: unknown, options?: IndicatorOptions) => unknown;
	[SPINNER_PATCHED]?: boolean;
}

/** Mirror the working-indicator frames of pi, so the status bar spinner matches. */
export function patchWorkingIndicator(host: SessionHost): void {
	// SAFETY: setWorkingIndicator is a private method of InteractiveMode. The typeof check
	// below skips the patch if a pi release renames or removes it.
	const proto = InteractiveMode.prototype as unknown as PatchableMode;
	if (proto[SPINNER_PATCHED] || typeof proto.setWorkingIndicator !== "function") return;
	const original = proto.setWorkingIndicator;
	proto.setWorkingIndicator = function (this: unknown, options?: IndicatorOptions) {
		const source = [...host.records.values()].find((r) => r.mode === this);
		const teardown =
			options === undefined && source !== undefined && (source.expectedStop || source.state === "stopped");
		if (!teardown) {
			host.workingIndicator = options;
			host.notify();
		}
		return original.call(this, options);
	};
	proto[SPINNER_PATCHED] = true;
}
