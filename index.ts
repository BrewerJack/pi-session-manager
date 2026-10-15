// pi-session-manager: pi sessions that run in the background, each in its own process.
// The manager overlay lists them, previews them, and opens one in this terminal.
// Open it with /sessions or the shortcut (alt+s, or ⌥S on macOS).
//
// The extension runs in two modes (spec §11). In a worker, it belongs to a background
// session, and the manager switches the client of the worker to another session. In plain
// pi, it is a client: opening a session parks the TUI of pi and attaches the terminal.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	getAgentDir,
	getPackageDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getNativeClipboard, type KeyId } from "@earendil-works/pi-tui";
import { attachLoop, describeEnd } from "./client.ts";
import type { Inheritance } from "./control.ts";
import { formatBreakdown, type FooterEntry } from "./footer.ts";
import { displayKey, isMacOptionShortcut, loadKeyConfig, type KeyConfig, type ModifierProbe } from "./keys.ts";
import { debug } from "./log.ts";
import { statePaths, type BootContext } from "./paths.ts";
import { activityOf, RemoteSource, titleOf, type Row, type SessionSource } from "./remote-source.ts";
import { totalTokens } from "./transcript.ts";
import { fmtAgo, fmtCost, fmtDuration, fmtTokens, ManagerView, shortPath, StatusBar, type ManagerResult } from "./ui.ts";
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
	["detach", "Leave this background session. It keeps running."],
];

type Ctx = ExtensionContext | ExtensionCommandContext;

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
}

export default function sessionManager(pi: ExtensionAPI) {
	KEYS = loadKeyConfig(path.join(getAgentDir(), "settings.json"), process.env);
	SHORTCUT = displayKey(KEYS.shortcut, process.platform);
	const self: Instance = { pi, source: getSource(), cleanup: [], managerOpen: false, warnedKeys: false };

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

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") installSessionUi(self, ctx);
	});

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
	const { source } = self;
	if (ctx.mode !== "tui") {
		ctx.ui.notify(statusReport(source), "info");
		return;
	}
	if (self.managerOpen) return;
	self.managerOpen = true;
	// The user asks for sessions now. Start the supervisor if none runs.
	source.ensureConnected().catch((error) => debug(error));
	let result: ManagerResult;
	try {
		const show = () =>
			ctx.ui.custom<ManagerResult>(
				(tui, theme, _keybindings, done) =>
					new ManagerView({ tui, theme, source, cwd: ctx.cwd || process.cwd(), done, initial, inherit: () => inheritFrom(ctx) }),
				{ overlay: true, overlayOptions: { width: "94%", minWidth: 60, maxHeight: "92%", anchor: "center" } },
			);
		const bridge = workerBridge();
		result = bridge ? await bridge.ownPrompt(show) : await show();
	} finally {
		self.managerOpen = false;
	}
	if (result?.type === "open") await openSession(source, ctx, result.id);
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
 * comes back when the user detaches, and the notice says how the attach ended.
 */
async function attachFromPi(source: SessionSource, ctx: Ctx, id: string): Promise<void> {
	let ended: { text: string; type: "info" | "warning" | "error" } | undefined;
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
	if (ended) ctx.ui.notify(ended.text, ended.type);
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
