// pi-session-manager: pi sessions that run in the background, each in its own process.
// The manager overlay lists them, previews them, and opens one in this terminal.
// Open it with /sessions or the shortcut (alt+s, or ⌥S on macOS).
//
// The extension runs in two modes (spec §11). In a worker, it belongs to a background
// session, and the manager switches the client of the worker to another session. In plain
// pi, it is a client: opening a session parks the TUI of pi and attaches the terminal.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	getAgentDir,
	getPackageDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getNativeClipboard, type KeyId, type OverlayOptions } from "@earendil-works/pi-tui";
import { attachLoop, describeEnd } from "./client.ts";
import type { Inheritance } from "./control.ts";
import { formatBreakdown, type FooterEntry } from "./footer.ts";
import { displayKey, isMacOptionShortcut, loadKeyConfig, type KeyConfig, type ModifierProbe } from "./keys.ts";
import { blockReason, inferToolPaths } from "./locks.ts";
import { debug } from "./log.ts";
import { statePaths, type BootContext } from "./paths.ts";
import { Registry } from "./registry.ts";
import { activityOf, RemoteSource, titleOf, type Row, type SessionSource } from "./remote-source.ts";
import { readManagerSettings } from "./settings.ts";
import { totalTokens } from "./transcript.ts";
import {
	fmtAgo,
	fmtCost,
	fmtDuration,
	fmtTokens,
	ManagerView,
	shortPath,
	StatusBar,
	type ManagerOptions,
	type ManagerResult,
} from "./ui.ts";
import type { WorkerBridge } from "./worker.ts";

// pi binds ctrl+r to app.session.rename, so the default is alt+s. Settings can change it.
let KEYS: KeyConfig = loadKeyConfig(path.join(getAgentDir(), "settings.json"), process.env);
/** The shortcut as the platform writes it, for hints and notices. */
let SHORTCUT = displayKey(KEYS.shortcut, process.platform);
const WIDGET_KEY = "pi-session-manager";
const FOOTER_KEY = "pi-session-manager";
const SOURCE_KEY = Symbol.for("pi-session-manager.source");
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SUBCOMMANDS: [string, string][] = [
	["new", "Start a session. With a task, it runs in the background."],
	["list", "Show the status of every session"],
	["open", "Open a session in this terminal by name"],
	["rename", "Rename this session"],
	["stop", "Stop a session by name. Its file stays."],
	["resume", "Open a saved pi session file as a background session"],
	["bg", "Move this session to the background and attach to it"],
	["detach", "Leave this background session. It keeps running."],
];

type Ctx = ExtensionContext | ExtensionCommandContext;
type Notice = ManagerOptions["notice"];

/** The worker that runs this session, when pi runs as a background worker (spec §7.4). */
function workerBridge(): WorkerBridge | undefined {
	return (globalThis as Record<symbol, WorkerBridge | undefined>)[Symbol.for("pi-session-manager.worker")];
}

function packageVersion(): string {
	try {
		return JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

/** One session list per process. pi loads the extension again on /new, /resume, and /reload. */
function getSource(): RemoteSource {
	const g = globalThis as Record<symbol, RemoteSource | undefined>;
	let source = g[SOURCE_KEY];
	if (!source) {
		const context: BootContext = { piDir: getPackageDir(), root: ROOT, version: packageVersion() };
		const currentId = process.env.PI_SESSION_MANAGER_WORKER || undefined;
		source = new RemoteSource(statePaths(getAgentDir()), context, { currentId, unref: true });
		// Plain pi starts no supervisor until the user asks for a session.
		source.watch();
		g[SOURCE_KEY] = source;
	}
	return source;
}

/** State of one extension instance. */
interface Instance {
	pi: ExtensionAPI;
	source: RemoteSource;
	/** Stop functions for the parts that session_shutdown removes. */
	cleanup: (() => void)[];
	managerOpen: boolean;
	warnedKeys: boolean;
	/** Plain pi runs the client loop of startDetached or of a routed resume. */
	clientLoop: boolean;
}

export default function sessionManager(pi: ExtensionAPI) {
	KEYS = loadKeyConfig(path.join(getAgentDir(), "settings.json"), process.env);
	SHORTCUT = displayKey(KEYS.shortcut, process.platform);
	const self: Instance = { pi, source: getSource(), cleanup: [], managerOpen: false, warnedKeys: false, clientLoop: false };

	pi.registerCommand("sessions", {
		description: "Manage background sessions (new, list, open, rename, stop, resume, detach)",
		getArgumentCompletions: (prefix: string) => completeArgs(self.source, prefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => runCommand(self, args.trim(), ctx),
	});

	// SAFETY: loadKeyConfig only returns shortcuts that match the KeyId grammar of pi-tui.
	pi.registerShortcut(KEYS.shortcut as KeyId, {
		description: "Open the session manager",
		handler: async (ctx: ExtensionContext) => openManager(self, ctx),
	});

	pi.on("session_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		installSessionUi(self, ctx);
		if (!workerBridge()) routeAtStart(self, event.reason, ctx);
	});

	// A worker takes its locks in its own inline extension. Plain pi takes them here (spec §9).
	if (!process.env.PI_SESSION_MANAGER_WORKER) {
		pi.on("tool_call", async (event, ctx) => {
			const paths = inferToolPaths(event.toolName, event.input);
			if (!paths.length) return undefined;
			const label = `plain pi in ${shortPath(ctx.cwd || process.cwd())}`;
			const answer = await self.source.acquireLock(paths, ctx.cwd || process.cwd(), event.toolCallId, label);
			return answer.granted ? undefined : { block: true, reason: blockReason(answer) };
		});
		pi.on("tool_result", (event) => {
			self.source.releaseLock(event.toolCallId);
			return undefined;
		});
	}

	pi.on("session_shutdown", () => {
		for (const stop of self.cleanup.splice(0)) {
			try {
				stop();
			} catch (error) {
				debug(error);
			}
		}
	});
}

/** The status bar, the footer breakdown, the notices about other sessions, and the macOS shortcut. */
function installSessionUi(self: Instance, ctx: ExtensionContext): void {
	for (const stop of self.cleanup.splice(0)) stop();
	self.cleanup.push(installStatusBar(self.source, ctx));
	self.cleanup.push(installFooterBreakdown(self.source, ctx));
	self.cleanup.push(watchOthers(self.source, ctx));
	// A worker has no keyboard. Its client handles the macOS key.
	if (!workerBridge()) {
		const stop = installMacOptionKey(self, ctx);
		if (stop) self.cleanup.push(stop);
	}
	if (self.warnedKeys) return;
	self.warnedKeys = true;
	for (const warning of KEYS.warnings) ctx.ui.notify(warning, "warning");
}

function installStatusBar(source: SessionSource, ctx: ExtensionContext): () => void {
	ctx.ui.setWidget(
		WIDGET_KEY,
		(tui: any, theme: any) => {
			const bar = new StatusBar(source, theme, () => tui.requestRender(), SHORTCUT);
			const unsubscribe = source.subscribe(() => tui.requestRender());
			return {
				render: (width: number) => bar.render(width),
				invalidate: () => bar.invalidate(),
				dispose: () => {
					unsubscribe();
					bar.dispose();
				},
			};
		},
		{ placement: "belowEditor" },
	);
	return () => ctx.ui.setWidget(WIDGET_KEY, undefined);
}

/**
 * Keep a per-session token breakdown in the footer. Updates come at most once a second.
 */
function installFooterBreakdown(source: SessionSource, ctx: ExtensionContext): () => void {
	let shown = "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	const update = () => {
		timer = undefined;
		const entries: FooterEntry[] = source.list().map((r) => ({
			name: titleOf(r),
			tokens: totalTokens(r.usage),
			contextPercent: r.usage?.contextPercent ?? null,
			cost: r.usage?.cost ?? 0,
			current: r.id === source.currentId,
			saved: r.state === "saved" || r.state === "failed",
		}));
		const text = formatBreakdown(entries, ctx.ui.theme);
		if (text === shown) return;
		shown = text;
		try {
			ctx.ui.setStatus(FOOTER_KEY, text || undefined);
		} catch (error) {
			debug(error);
		}
	};
	const unsubscribe = source.subscribe(() => {
		timer ??= setTimeout(update, 1000);
		timer.unref?.();
	});
	update();
	return () => {
		unsubscribe();
		if (timer) clearTimeout(timer);
		timer = undefined;
		ctx.ui.setStatus(FOOTER_KEY, undefined);
	};
}

/** Tell the user when another session finishes or needs input. Nobody else looks at it then. */
function watchOthers(source: SessionSource, ctx: ExtensionContext): () => void {
	const seen = new Map<string, Row["state"]>();
	for (const row of source.list()) seen.set(row.id, row.state);
	return source.subscribe(() => {
		for (const row of source.list()) {
			const before = seen.get(row.id);
			seen.set(row.id, row.state);
			if (before === undefined || before === row.state || row.id === source.currentId || row.attached) continue;
			const title = titleOf(row);
			if (row.state === "waiting") {
				const what = row.promptTitle ? `: ${row.promptTitle}` : "";
				ctx.ui.notify(`? "${title}" needs your input${what}. Press ${SHORTCUT} to open it.`, "warning");
			} else if (before === "working" && row.state === "idle") {
				const took = row.lastRunMs ? ` in ${fmtDuration(row.lastRunMs)}` : "";
				if (row.lastOutcome === "error") ctx.ui.notify(`✗ "${title}" failed: ${row.error ?? "error"}`, "error");
				else if (row.lastOutcome === "aborted") ctx.ui.notify(`■ "${title}" was interrupted`, "warning");
				else ctx.ui.notify(`✓ "${title}" finished${took}`, "info");
			} else if (row.state === "failed") {
				ctx.ui.notify(`✗ "${title}" stopped: ${row.error ?? "the worker died"}`, "error");
			}
		}
	});
}

/** pi's macOS native helper, or undefined when pi runs elsewhere or without it (for example over SSH). */
function macModifierProbe(): ModifierProbe | undefined {
	if (process.platform !== "darwin") return undefined;
	try {
		const helper: any = getNativeClipboard();
		if (typeof helper?.isModifierPressed !== "function") return undefined;
		return (name) => {
			try {
				return helper.isModifierPressed(name) === true;
			} catch (error) {
				debug(error);
				return false;
			}
		};
	} catch (error) {
		debug(error);
		return undefined;
	}
}

/**
 * Open the manager when a macOS terminal turns Option+S into "ß". Terminals that
 * send alt+s, such as ones with "Option as Meta" turned on, use the normal shortcut.
 */
function installMacOptionKey(self: Instance, ctx: ExtensionContext): (() => void) | undefined {
	if (!KEYS.macOptionChars.length) return undefined;
	const pressed = macModifierProbe();
	if (!pressed) return undefined;
	return ctx.ui.onTerminalInput((data) => {
		if (self.managerOpen || !isMacOptionShortcut(data, KEYS.macOptionChars, pressed)) return undefined;
		void openManager(self, ctx).catch((error) => debug(error));
		return { consume: true };
	});
}

/** The model, thinking level, and tools that a new session takes over from this one. */
function inheritFrom(ctx: Ctx): Inheritance {
	const inherit: Inheritance = {};
	if (ctx.model) inherit.model = { provider: ctx.model.provider, id: ctx.model.id };
	if (ctx.thinkingLevel) inherit.thinkingLevel = ctx.thinkingLevel;
	try {
		const tools = (ctx as ExtensionCommandContext).getSystemPromptOptions?.()?.selectedTools;
		if (Array.isArray(tools)) inherit.tools = [...tools];
	} catch (error) {
		debug(error);
	}
	return inherit;
}

async function openManager(self: Instance, ctx: Ctx, initial?: "resume" | "new"): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(statusReport(self.source), "info");
		return;
	}
	const result = await showManager(self, ctx, { initial });
	if (result?.type === "open") await openSession(self.source, ctx, result.id);
}

/** The manager overlay. `full` covers the whole screen, for the client loop of plain pi. */
async function showManager(
	self: Instance,
	ctx: Ctx,
	options: { initial?: "resume" | "new"; notice?: Notice; full?: boolean } = {},
): Promise<ManagerResult> {
	const { source } = self;
	if (self.managerOpen) return undefined;
	self.managerOpen = true;
	// The user asks for sessions now. Start the supervisor if none runs.
	source.ensureConnected().catch((error) => debug(error));
	const overlayOptions: OverlayOptions = options.full
		? { width: "100%", maxHeight: "100%", anchor: "center" }
		: { width: "94%", minWidth: 60, maxHeight: "92%", anchor: "center" };
	try {
		const show = () =>
			ctx.ui.custom<ManagerResult>(
				(tui, theme, _keybindings, done) =>
					new ManagerView({
						tui,
						theme,
						source,
						cwd: ctx.cwd || process.cwd(),
						done,
						initial: options.initial,
						notice: options.notice,
						inherit: () => inheritFrom(ctx),
					}),
				{ overlay: true, overlayOptions },
			);
		const bridge = workerBridge();
		return bridge ? await bridge.ownPrompt(show) : await show();
	} finally {
		self.managerOpen = false;
	}
}

/** Show a session in this terminal. A worker hands its client over. Plain pi attaches. */
async function openSession(source: SessionSource, ctx: Ctx, id: string): Promise<void> {
	const bridge = workerBridge();
	if (bridge) {
		if (id !== bridge.id) bridge.switchTo(id);
		return;
	}
	await attachFromPi(source, ctx, id);
}

/**
 * Park the TUI of plain pi inside a custom UI and give the terminal to a worker. The TUI
 * comes back when the user detaches, and a notice says how the attach ended.
 */
async function attachFromPi(source: SessionSource, ctx: Ctx, id: string): Promise<void> {
	const ended = await attachParked(source, ctx, id);
	if (ended) ctx.ui.notify(ended.text, ended.type);
}

/** The attach of attachFromPi. Returns how it ended instead of showing it. */
async function attachParked(source: SessionSource, ctx: Ctx, id: string): Promise<Notice> {
	let ended: Notice;
	await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
		try {
			tui.stop();
		} catch (error) {
			debug(error);
		}
		attachLoop((next) => source.attach(next), id)
			.then(({ result, id: last }) => {
				const text = describeEnd(result, last, `/sessions open ${source.get(last)?.name ?? last}`);
				ended = { text, type: result.kind === "error" ? "error" : "info" };
			})
			.catch((error) => {
				ended = { text: String(error?.message ?? error), type: "error" };
			})
			.finally(() => {
				try {
					tui.start();
					tui.requestRender(true);
				} catch (error) {
					debug(error);
				}
				done();
			});
		return { render: () => [], invalidate: () => {} };
	});
	return ended;
}

/**
 * Plain pi as a pure client (spec §5.2): attach, then the manager, until the user closes the
 * manager. Then pi ends. Its own session never gets a message.
 */
async function runClientLoop(self: Instance, ctx: ExtensionContext, first?: string, why?: string): Promise<void> {
	if (self.clientLoop) return;
	self.clientLoop = true;
	let next = first;
	let notice: Notice;
	try {
		for (;;) {
			if (next) notice = await attachParked(self.source, ctx, next);
			// The first notice also says why this pi attached on its own.
			if (why && notice) notice = { ...notice, text: `${why} ${notice.text}` };
			why = undefined;
			const result = await showManager(self, ctx, { notice, full: true });
			if (!result) break;
			next = result.id;
		}
	} finally {
		self.clientLoop = false;
	}
	ctx.shutdown();
}

/**
 * At startup, plain pi either opens the manager (startDetached), or attaches when it opened
 * the session file of a listed session (spec Q6). Two processes on one file fork the
 * conversation, so pi must not keep that file for itself.
 */
function routeAtStart(self: Instance, reason: string, ctx: ExtensionContext): void {
	if (reason !== "startup" && reason !== "resume") return;
	let file: string | undefined;
	try {
		file = ctx.sessionManager.getSessionFile();
	} catch (error) {
		debug(error);
	}
	const paths = statePaths(getAgentDir());
	const listed = file && existsSync(file) ? new Registry(paths.sessions).load().find((r) => r.sessionFile === file) : undefined;
	const detached = reason === "startup" && readManagerSettings(path.join(getAgentDir(), "settings.json")).startDetached;
	if (!listed && !detached) return;
	const why = listed ? `"${listed.name ?? listed.firstPrompt ?? listed.id}" runs in the background, so pi attached to it.` : undefined;
	// The TUI starts after session_start. The client loop needs it.
	setTimeout(() => {
		runClientLoop(self, ctx, listed?.id, why).catch((error) => {
			debug(error);
			ctx.ui.notify(String(error?.message ?? error), "error");
		});
	}, 0);
}

/**
 * /sessions bg: plain pi hands its session to a worker (spec §13). pi starts a new empty
 * session first, so it never writes to the file again. Then a worker opens the file, and
 * this terminal attaches to it.
 */
async function backgroundCommand(self: Instance, ctx: ExtensionCommandContext): Promise<void> {
	if (workerBridge()) {
		ctx.ui.notify("This session already runs in the background. Use /sessions detach to leave it.", "info");
		return;
	}
	if (!ctx.isIdle()) {
		ctx.ui.notify("Wait for the run to end, or press esc, then move the session.", "warning");
		return;
	}
	// Plain data only: the context goes stale with the session switch.
	const file = ctx.sessionManager.getSessionFile();
	const cwd = ctx.cwd || process.cwd();
	const inherit = inheritFrom(ctx);
	const name = ctx.sessionManager.getSessionName?.();
	const source = self.source;
	await source.ensureConnected();
	if (!file || !existsSync(file)) {
		// pi writes no file before the first message. There is nothing to move, so start fresh.
		const row = await source.create({ cwd, name, ...inherit });
		await attachFromPi(source, ctx, row.id);
		return;
	}
	let fresh: ExtensionCommandContext | undefined;
	const { cancelled } = await ctx.newSession({
		withSession: async (next) => {
			fresh = next;
		},
	});
	if (cancelled || !fresh) {
		ctx.ui.notify("The session stays here. Another extension cancelled the switch.", "warning");
		return;
	}
	const target: ExtensionCommandContext = fresh;
	try {
		const row = await source.create({ cwd, sessionFile: file, ...inherit });
		await attachFromPi(source, target, row.id);
	} catch (error: any) {
		target.ui.notify(`The session did not move: ${error?.message ?? error}. Its file stays. /resume opens it here.`, "error");
	}
}

function statusReport(source: SessionSource): string {
	const rows = source.list();
	if (!rows.length) return source.problem ?? "No sessions.";
	const lines = rows.map((r, i) => {
		const current = r.id === source.currentId ? " (this session)" : "";
		const usage = `${fmtTokens(totalTokens(r.usage))} tok · ${fmtCost(r.usage?.cost ?? 0)}`;
		return `${i + 1}. ${titleOf(r)}${current} · ${describeState(r)} · ${shortPath(r.cwd)} · ${usage} · ${fmtAgo(r.lastActivityAt)}`;
	});
	return [`${lines.length} session(s):`, ...lines].join("\n");
}

function describeState(r: Row): string {
	if (r.state === "failed") return `failed: ${r.error ?? "the worker died"}`;
	if (r.state === "saved") return "saved";
	if (r.state === "starting") return "starting";
	const activity = activityOf(r);
	if (activity === "waiting") return "needs input";
	if (activity !== "working") return r.lastOutcome ?? "ready";
	const elapsed = r.runStartedAt ? fmtDuration(Date.now() - r.runStartedAt) : "";
	const tool = r.tool ? ` · ${r.tool.name}` : "";
	return `working ${elapsed}${tool}`;
}

function completeArgs(source: SessionSource, prefix: string) {
	const [sub = "", ...rest] = prefix.split(/\s+/);
	if (!rest.length) {
		const items = SUBCOMMANDS.flatMap(([name, description]) =>
			name.startsWith(sub) ? [{ value: `${name} `, label: name, description }] : [],
		);
		return items.length ? items : null;
	}
	if (sub !== "open" && sub !== "switch" && sub !== "stop") return null;
	const query = rest.join(" ").toLowerCase();
	const items = source.list().flatMap((r) => {
		const name = r.name || titleOf(r);
		if (!name.toLowerCase().includes(query)) return [];
		return [{ value: `${sub} ${name}`, label: name, description: `${describeState(r)} · ${shortPath(r.cwd)}` }];
	});
	return items.length ? items : null;
}

type SubcommandHandler = (self: Instance, ctx: ExtensionCommandContext, value: string) => Promise<void>;

async function newCommand(self: Instance, ctx: ExtensionCommandContext, value: string): Promise<void> {
	const cwd = ctx.cwd || process.cwd();
	const row = await self.source.create({ cwd, task: value || undefined, ...inheritFrom(ctx) });
	if (!value) {
		await openSession(self.source, ctx, row.id);
		return;
	}
	ctx.ui.notify(`Started "${titleOf(row)}" in the background. Press ${SHORTCUT} to manage it.`, "info");
}

async function listCommand(self: Instance, ctx: ExtensionCommandContext): Promise<void> {
	await self.source.ensureConnected().catch((error) => debug(error));
	ctx.ui.notify(statusReport(self.source), "info");
}

async function openCommand(self: Instance, ctx: ExtensionCommandContext, value: string): Promise<void> {
	await self.source.ensureConnected();
	const target = value ? self.source.get(value) : undefined;
	if (!target) {
		ctx.ui.notify(value ? `No session matches "${value}".` : "Usage: /sessions open <name>", "warning");
		return;
	}
	await openSession(self.source, ctx, target.id);
}

async function renameCommand(self: Instance, ctx: ExtensionCommandContext, value: string): Promise<void> {
	if (!value) {
		ctx.ui.notify("Usage: /sessions rename <new name>", "warning");
		return;
	}
	self.pi.setSessionName(value);
	ctx.ui.notify(`Renamed this session to "${value}".`, "info");
}

async function stopCommand(self: Instance, ctx: ExtensionCommandContext, value: string): Promise<void> {
	await self.source.ensureConnected();
	const target = value ? self.source.get(value) : undefined;
	if (!target) {
		ctx.ui.notify(value ? `No session matches "${value}".` : "Usage: /sessions stop <name>", "warning");
		return;
	}
	const title = titleOf(target);
	await self.source.stop(target.id);
	ctx.ui.notify(`Stopped "${title}". Its session file stays.`, "info");
}

async function detachCommand(_self: Instance, ctx: ExtensionCommandContext): Promise<void> {
	const bridge = workerBridge();
	if (!bridge) {
		ctx.ui.notify("This session runs in this terminal. Only a background session can detach.", "warning");
		return;
	}
	bridge.detach();
}

const SUBCOMMAND_HANDLERS: Record<string, SubcommandHandler> = {
	"": (self, ctx) => openManager(self, ctx),
	new: newCommand,
	list: listCommand,
	status: listCommand,
	open: openCommand,
	switch: openCommand,
	attach: openCommand,
	rename: renameCommand,
	stop: stopCommand,
	kill: stopCommand,
	resume: (self, ctx) => openManager(self, ctx, "resume"),
	bg: backgroundCommand,
	background: backgroundCommand,
	detach: detachCommand,
};

async function runCommand(self: Instance, args: string, ctx: ExtensionCommandContext) {
	const [sub = "", ...rest] = args.split(/\s+/);
	const handler = SUBCOMMAND_HANDLERS[sub.toLowerCase()];
	if (!handler) {
		ctx.ui.notify(`Unknown subcommand "${sub}". Try: ${SUBCOMMANDS.map(([n]) => n).join(", ")}.`, "warning");
		return;
	}
	try {
		await handler(self, ctx, rest.join(" ").trim());
	} catch (error: any) {
		debug(error);
		ctx.ui.notify(String(error?.message || error), "error");
	}
}
