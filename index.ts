// pi-session-manager: run several agents in one pi process and manage them from a
// Claude-Code-style overlay. Open it with /sessions or alt+s.
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	debug,
	getHost,
	inferToolPaths,
	patchWorkingIndicator,
	summarizeToolArgs,
	textOf,
	titleOf,
	type LiveSession,
	type Outcome,
	type SessionHost,
} from "./host.ts";
import { fmtAgo, fmtCost, fmtDuration, fmtTokens, ManagerView, shortPath, StatusBar, type ManagerResult } from "./ui.ts";

// pi binds ctrl+r to app.session.rename, so use a key that no built-in action claims.
const SHORTCUT = "alt+s";
const WIDGET_KEY = "pi-session-manager";
const SUBCOMMANDS: [string, string][] = [
	["new", "Start an agent. With a task, it runs in the background."],
	["list", "Show the status of every live session"],
	["switch", "Switch to a live session by name"],
	["rename", "Rename the current session"],
	["stop", "Stop a live child session by name"],
	["resume", "Open a saved session as a live child"],
];

type Ctx = ExtensionContext | ExtensionCommandContext;

export default function sessionManager(pi: ExtensionAPI) {
	const host = getHost();
	patchWorkingIndicator(host);

	const bind = (ctx: Ctx): LiveSession => host.bind(ctx, pi);

	pi.registerCommand("sessions", {
		description: "Manage live agent sessions (new, list, switch, rename, stop, resume)",
		getArgumentCompletions: (prefix: string) => completeArgs(host, prefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => runCommand(pi, host, args.trim(), ctx),
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Open the session manager",
		handler: async (ctx: ExtensionContext) => openManager(pi, host, ctx),
	});

	pi.on("session_start", (_event, ctx) => {
		bind(ctx);
		if (ctx.mode === "tui") installStatusBar(ctx, host);
		host.notify();
	});

	pi.on("session_info_changed", (event, ctx) => {
		const r = bind(ctx);
		r.sessionName = event.name || undefined;
		host.notify();
	});

	pi.on("model_select", (_event, ctx) => {
		bind(ctx).statsCache = undefined;
		host.notifySoon();
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		bind(ctx);
		host.notifySoon();
	});

	pi.on("agent_start", (_event, ctx) => {
		const r = bind(ctx);
		const now = Date.now();
		r.running = true;
		r.runStartedAt = now;
		r.lastActivityAt = now;
		r.lastOutcome = undefined;
		r.error = undefined;
		r.tool = undefined;
		host.notify();
	});

	pi.on("message_update", (event, ctx) => {
		const message: any = event.message;
		if (message?.role !== "assistant") return;
		const r = bind(ctx);
		r.streamingText = textOf(message.content).slice(-4000);
		r.lastActivityAt = Date.now();
		host.notifySoon();
	});

	pi.on("message_end", (event, ctx) => {
		const message: any = event.message;
		const r = bind(ctx);
		r.streamingText = undefined;
		r.lastActivityAt = Date.now();
		r.statsCache = undefined;
		if (message?.role === "user" && !r.firstPrompt) r.firstPrompt = textOf(message.content).trim().slice(0, 200);
		if (message?.role === "assistant" && message.stopReason === "error" && message.errorMessage) {
			r.error = String(message.errorMessage);
		}
		host.notifySoon();
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (event.parentToolCallId) return;
		const r = bind(ctx);
		r.tool = {
			id: event.toolCallId,
			name: event.toolName,
			detail: summarizeToolArgs(event.toolName, event.args),
			startedAt: Date.now(),
		};
		r.lastActivityAt = Date.now();
		host.notifySoon();
	});

	pi.on("tool_execution_end", (event, ctx) => {
		const r = bind(ctx);
		if (r.tool?.id === event.toolCallId) r.tool = undefined;
		r.lastActivityAt = Date.now();
		host.notifySoon();
	});

	pi.on("agent_settled", (event, ctx) => {
		const r = bind(ctx);
		const outcome: Outcome = event.aborted ? "aborted" : r.error ? "error" : "done";
		finishRun(host, r, outcome);
	});

	pi.on("ui_prompt_start", (event, ctx) => {
		const r = bind(ctx);
		// Our own overlay and the parent handoff are custom UIs too. Skip them.
		if (event.kind === "custom" && r.ownPromptPending > 0) {
			r.ownPromptPending--;
			r.ignoredPromptEnds++;
			return;
		}
		r.promptDepth++;
		r.promptTitle = event.title;
		r.lastActivityAt = Date.now();
		if (r.id !== host.activeId) {
			const what = event.title ? `: ${event.title}` : "";
			host.notifyActive(`? "${titleOf(r)}" needs your input${what}. Press ${SHORTCUT} to switch.`, "warning");
		}
		host.notify();
	});

	pi.on("ui_prompt_end", (event, ctx) => {
		const r = bind(ctx);
		if (event.kind === "custom" && r.ignoredPromptEnds > 0) {
			r.ignoredPromptEnds--;
			return;
		}
		r.promptDepth = Math.max(0, r.promptDepth - 1);
		if (!r.promptDepth) r.promptTitle = undefined;
		host.notify();
	});

	pi.on("tool_call", (event, ctx) => {
		const r = bind(ctx);
		const paths = inferToolPaths(event.toolName, event.input);
		if (!paths.length) return undefined;
		const result = host.locks.acquire(r.id, paths, ctx.cwd || r.cwd);
		if (!result.ok) {
			const owners = [...new Set(result.conflicts.map((c) => titleOf(host.get(c.by) ?? r)))];
			const held = [...new Set(result.conflicts.map((c) => shortPath(c.heldPath)))];
			return {
				block: true,
				reason: `Another live session (${owners.join(", ")}) is writing ${held.join(", ")}. Wait for it to finish, or work elsewhere.`,
			};
		}
		host.locks.heldByToolCall.set(event.toolCallId, { sessionId: r.id, paths: result.paths });
		return undefined;
	});

	pi.on("tool_result", (event) => {
		host.locks.releaseByToolCall(event.toolCallId);
		return undefined;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const r = bind(ctx);
		host.locks.release(r.id);
		try {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		} catch (error) {
			debug(error);
		}
		host.notify();
	});
}

function finishRun(host: SessionHost, r: LiveSession, outcome: Outcome): void {
	if (!r.running) return;
	const now = Date.now();
	r.running = false;
	r.tool = undefined;
	r.streamingText = undefined;
	r.lastOutcome = outcome;
	r.lastRunMs = r.runStartedAt ? now - r.runStartedAt : undefined;
	r.lastActivityAt = now;
	r.statsCache = undefined;
	if (r.id !== host.activeId) {
		r.unread = true;
		const took = r.lastRunMs ? ` in ${fmtDuration(r.lastRunMs)}` : "";
		if (outcome === "done") host.notifyActive(`✓ "${titleOf(r)}" finished${took}`, "info");
		else if (outcome === "error") host.notifyActive(`✗ "${titleOf(r)}" failed: ${r.error ?? "error"}`, "error");
		else host.notifyActive(`■ "${titleOf(r)}" was interrupted`, "warning");
	}
	host.notify();
}

function installStatusBar(ctx: ExtensionContext, host: SessionHost): void {
	ctx.ui.setWidget(
		WIDGET_KEY,
		(tui: any, theme: any) => {
			const bar = new StatusBar(host, theme, () => tui.requestRender(), SHORTCUT);
			const unsubscribe = host.subscribe(() => tui.requestRender());
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
}

async function openManager(
	pi: ExtensionAPI,
	host: SessionHost,
	ctx: Ctx,
	initial?: "resume" | "new",
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(statusReport(host), "info");
		return;
	}
	const r = host.bind(ctx, pi);
	r.ownPromptPending++;
	let result: ManagerResult;
	try {
		result = await ctx.ui.custom<ManagerResult>(
			(tui, theme, _keybindings, done) =>
				new ManagerView({ tui, theme, host, ctx, done, initial, shortcut: SHORTCUT }),
			{ overlay: true, overlayOptions: { width: "94%", minWidth: 60, maxHeight: "92%", anchor: "center" } },
		);
	} finally {
		// If pi did not report the overlay as a prompt, drop the unused marker.
		if (r.ownPromptPending > 0) r.ownPromptPending--;
	}
	await applyResult(host, ctx, result);
}

async function applyResult(host: SessionHost, ctx: Ctx, result: ManagerResult): Promise<void> {
	if (!result) return;
	try {
		if (result.type === "switch") await host.activateFromContext(ctx, result.id);
		else if (result.type === "kill") await host.stopChild(result.id);
	} catch (error: any) {
		ctx.ui.notify(String(error?.message || error), "error");
	}
}

function statusReport(host: SessionHost): string {
	const lines = host.list().map((r, i) => {
		const s = host.stats(r);
		const activity = host.activity(r);
		const state =
			r.state === "error"
				? `error: ${r.error}`
				: activity === "working"
					? `working ${r.runStartedAt ? fmtDuration(Date.now() - r.runStartedAt) : ""}${r.tool ? ` · ${r.tool.name}` : ""}`
					: activity === "waiting"
						? "needs input"
						: (r.lastOutcome ?? "ready");
		const current = r.id === host.activeId ? " (current)" : "";
		const usage = `${fmtTokens(s.input + s.output + s.cacheRead + s.cacheWrite)} tok · ${fmtCost(s.cost)}`;
		return `${i + 1}. ${titleOf(r)}${current} · ${state} · ${shortPath(r.cwd)} · ${usage} · ${fmtAgo(r.lastActivityAt)}`;
	});
	return [`${lines.length} live session(s):`, ...lines].join("\n");
}

function completeArgs(host: SessionHost, prefix: string) {
	const [sub = "", ...rest] = prefix.split(/\s+/);
	if (!rest.length) {
		const items = SUBCOMMANDS.filter(([name]) => name.startsWith(sub)).map(([name, description]) => ({
			value: `${name} `,
			label: name,
			description,
		}));
		return items.length ? items : null;
	}
	if (sub !== "switch" && sub !== "stop") return null;
	const query = rest.join(" ").toLowerCase();
	const items = host
		.list()
		.filter((r) => sub === "switch" || r.kind === "child")
		.map((r) => ({ name: r.sessionName || titleOf(r), r }))
		.filter(({ name }) => name.toLowerCase().includes(query))
		.map(({ name, r }) => ({
			value: `${sub} ${name}`,
			label: name,
			description: `${host.activity(r)} · ${shortPath(r.cwd)}`,
		}));
	return items.length ? items : null;
}

async function runCommand(pi: ExtensionAPI, host: SessionHost, args: string, ctx: ExtensionCommandContext) {
	const [sub = "", ...rest] = args.split(/\s+/);
	const value = rest.join(" ").trim();
	host.bind(ctx, pi);
	try {
		switch (sub.toLowerCase()) {
			case "":
				return await openManager(pi, host, ctx);
			case "new": {
				const cwd = ctx.cwd || process.cwd();
				if (!value) {
					const child = await host.createChild({ cwd, ctx });
					return await applyResult(host, ctx, { type: "switch", id: child.id });
				}
				const child = await host.createChild({ cwd, ctx, task: value });
				ctx.ui.notify(`Started agent "${titleOf(child)}" in the background. Press ${SHORTCUT} to manage it.`, "info");
				return;
			}
			case "list":
			case "status":
				ctx.ui.notify(statusReport(host), "info");
				return;
			case "switch": {
				const target = value ? host.get(value) : undefined;
				if (!target) {
					ctx.ui.notify(value ? `No live session matches "${value}".` : "Usage: /sessions switch <name>", "warning");
					return;
				}
				return await applyResult(host, ctx, { type: "switch", id: target.id });
			}
			case "rename": {
				if (!value) {
					ctx.ui.notify("Usage: /sessions rename <new name>", "warning");
					return;
				}
				host.rename(host.bind(ctx, pi), value);
				ctx.ui.notify(`Renamed this session to "${value}".`, "info");
				return;
			}
			case "stop":
			case "kill": {
				const target = value ? host.get(value) : undefined;
				if (!target || target.kind !== "child") {
					ctx.ui.notify(value ? `No live child session matches "${value}".` : "Usage: /sessions stop <name>", "warning");
					return;
				}
				const title = titleOf(target);
				await host.stopChild(target.id);
				ctx.ui.notify(`Stopped "${title}".`, "info");
				return;
			}
			case "resume":
				return await openManager(pi, host, ctx, "resume");
			default:
				ctx.ui.notify(`Unknown subcommand "${sub}". Try: ${SUBCOMMANDS.map(([n]) => n).join(", ")}.`, "warning");
		}
	} catch (error: any) {
		debug(error);
		ctx.ui.notify(String(error?.message || error), "error");
	}
}
