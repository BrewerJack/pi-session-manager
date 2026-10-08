// Session manager UI: a Claude-Code-style overlay that lists live sessions with
// status, usage, and a preview. It also has a detail screen and a status bar.
import { homedir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	Input,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";
import {
	debug,
	PARENT_ID,
	titleOf,
	type LiveSession,
	type SessionHost,
	type TranscriptItem,
} from "./host.ts";
import {
	FileExplorer,
	isCtrl,
	renderInputChild,
	ResumeSessionPicker,
	setInputValueAtEnd,
	type SavedSessionInfo,
} from "./pickers.ts";

type Theme = any;
type Ctx = any;

export type ManagerResult = { type: "switch"; id: string } | { type: "kill"; id: string } | undefined;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 100;
const PREVIEW_ROWS = 5;

// ---------------------------------------------------------------------------
// Formatting helpers

export function fmtTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtCost(cost: number): string {
	if (!cost) return "$0.00";
	return cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
}

export function fmtDuration(ms: number): string {
	const sec = Math.max(0, Math.floor(ms / 1000));
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ${sec % 60}s`;
	return `${Math.floor(min / 60)}h ${min % 60}m`;
}

export function fmtAgo(ts: number): string {
	const sec = Math.floor((Date.now() - ts) / 1000);
	if (sec < 10) return "just now";
	if (sec < 60) return `${sec}s ago`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hour = Math.floor(min / 60);
	if (hour < 24) return `${hour}h ago`;
	return `${Math.floor(hour / 24)}d ago`;
}

export function shortPath(p: string): string {
	const home = homedir();
	if (p === home) return "~";
	return p.startsWith(home + "/") ? `~${p.slice(home.length)}` : p;
}

function fit(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width), "…");
}

function pad(text: string, width: number): string {
	const t = fit(text, width);
	return t + " ".repeat(Math.max(0, width - visibleWidth(t)));
}

/** Left text and right text on one line, with the left side truncated first. */
function spread(left: string, right: string, width: number): string {
	const rightW = visibleWidth(right);
	if (rightW >= width) return fit(right, width);
	const l = fit(left, width - rightW - 1);
	return l + " ".repeat(Math.max(1, width - visibleWidth(l) - rightW)) + right;
}

function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	for (const para of text.split("\n")) {
		if (!para.trim()) {
			out.push("");
			continue;
		}
		out.push(...wrapTextWithAnsi(para, Math.max(4, width)));
	}
	return out;
}

// ---------------------------------------------------------------------------
// Status glyphs shared by the manager and the status bar

function spinnerFrame(host: SessionHost, theme: Theme, frame: number): string {
	const frames = host.workingIndicator?.frames;
	if (frames !== undefined) return frames.length ? (frames[frame % frames.length] ?? "") : "";
	return theme.fg("accent", SPINNER[frame % SPINNER.length] ?? "");
}

function statusIcon(host: SessionHost, r: LiveSession, theme: Theme, frame: number): string {
	if (r.state === "error") return theme.fg("error", "✗");
	if (r.state === "starting") return theme.fg("dim", "◌");
	if (r.state === "saved") return theme.fg("dim", "◇");
	const activity = host.activity(r);
	if (activity === "waiting") return theme.bold(theme.fg("warning", "?"));
	if (activity === "working") return spinnerFrame(host, theme, frame) || theme.fg("accent", "●");
	if (r.lastOutcome === "error") return theme.fg("error", "✗");
	if (r.lastOutcome === "aborted") return theme.fg("warning", "■");
	if (r.lastOutcome === "done") return theme.fg("success", "✓");
	return theme.fg("dim", "○");
}

function statusText(host: SessionHost, r: LiveSession, theme: Theme): string {
	if (r.state === "error") return theme.fg("error", `error: ${r.error ?? "failed"}`);
	if (r.state === "starting") return theme.fg("dim", "starting…");
	if (r.state === "saved") return theme.fg("dim", "saved · ⏎ starts it");
	const activity = host.activity(r);
	if (activity === "waiting") {
		return theme.fg("warning", r.promptTitle ? `needs input · ${r.promptTitle}` : "needs input");
	}
	if (activity === "working") {
		if (r.tool) return theme.fg("muted", `${r.tool.name}${r.tool.detail ? ` ${r.tool.detail}` : ""}`);
		return theme.fg("muted", r.streamingText ? "responding…" : "thinking…");
	}
	if (r.lastOutcome === "error") return theme.fg("error", "failed");
	if (r.lastOutcome === "aborted") return theme.fg("warning", "interrupted");
	if (r.unread) return theme.fg("success", "done · unread");
	if (r.lastOutcome === "done") return theme.fg("success", "done");
	return theme.fg("dim", "ready");
}

function timeText(host: SessionHost, r: LiveSession): string {
	if (host.activity(r) !== "idle" && r.runStartedAt) return fmtDuration(Date.now() - r.runStartedAt);
	return fmtAgo(r.lastActivityAt);
}

// ---------------------------------------------------------------------------
// Box drawing

class Box {
	constructor(
		private readonly theme: Theme,
		readonly width: number,
	) {}

	get inner(): number {
		return Math.max(1, this.width - 4);
	}

	private b(s: string): string {
		return this.theme.fg("borderAccent", s);
	}

	top(title: string, right = ""): string {
		const t = title ? ` ${title} ` : "";
		const r = right ? ` ${right} ` : "";
		const fill = Math.max(0, this.width - 3 - visibleWidth(t) - visibleWidth(r));
		return this.b("╭─") + t + this.b("─".repeat(fill)) + r + this.b("╮");
	}

	line(content = ""): string {
		return this.b("│") + " " + pad(content, this.inner) + " " + this.b("│");
	}

	sep(label = ""): string {
		const l = label ? ` ${label} ` : "";
		const fill = Math.max(0, this.width - 3 - visibleWidth(l));
		return this.b("├─") + this.theme.fg("dim", l) + this.b("─".repeat(fill)) + this.b("┤");
	}

	bottom(right = ""): string {
		const r = right ? ` ${right} ` : "";
		const fill = Math.max(0, this.width - 3 - visibleWidth(r));
		return this.b("╰") + this.b("─".repeat(fill)) + r + this.b("─╯");
	}
}

function hints(theme: Theme, pairs: [string, string][], width: number): string {
	const parts = pairs.map(([key, label]) => theme.fg("dim", key) + theme.fg("muted", ` ${label}`));
	let out = "";
	for (const part of parts) {
		const next = out ? `${out}${theme.fg("dim", " · ")}${part}` : part;
		if (visibleWidth(next) > width - 2) break;
		out = next;
	}
	return " " + out;
}

// ---------------------------------------------------------------------------
// Manager overlay

type PromptKind = "new" | "rename" | "message";

interface PromptState {
	kind: PromptKind;
	targetId?: string;
	input: Input;
}

export interface ManagerOptions {
	tui: any;
	theme: Theme;
	host: SessionHost;
	ctx: Ctx;
	done: (result: ManagerResult) => void;
	initial?: "resume" | "new";
	shortcut?: string;
}

export class ManagerView implements Component, Focusable {
	private readonly tui: any;
	private readonly theme: Theme;
	private readonly host: SessionHost;
	private readonly ctx: Ctx;
	private readonly done: (result: ManagerResult) => void;
	private readonly filter = new Input();
	private filtering = false;
	private screen: "list" | "detail" = "list";
	private selectedId: string;
	private prompt?: PromptState;
	private confirmKillId?: string;
	private sub?: FileExplorer | ResumeSessionPicker;
	private flash?: { text: string; type: "info" | "warning" | "error"; at: number };
	private detailScroll = 0;
	private frame = 0;
	private closed = false;
	private busy = false;
	private _focused = false;
	private readonly timer: ReturnType<typeof setInterval>;
	private readonly unsubscribe: () => void;

	constructor(opts: ManagerOptions) {
		this.tui = opts.tui;
		this.theme = opts.theme;
		this.host = opts.host;
		this.ctx = opts.ctx;
		this.done = opts.done;
		const sessions = this.sessions();
		// Start on the most interesting session that is not the current one.
		const pick =
			sessions.find((r) => r.id !== this.host.activeId && this.host.activity(r) === "waiting") ??
			sessions.find((r) => r.id !== this.host.activeId && r.unread) ??
			sessions.find((r) => r.id !== this.host.activeId) ??
			sessions[0];
		this.selectedId = pick?.id ?? PARENT_ID;
		this.unsubscribe = this.host.subscribe(() => this.requestRender());
		this.timer = setInterval(() => {
			this.frame++;
			if (this.flash && Date.now() - this.flash.at > 4000) this.flash = undefined;
			this.requestRender();
		}, TICK_MS);
		if (opts.initial === "resume") this.openResume();
		if (opts.initial === "new") this.openPrompt("new");
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.filter.focused = value && this.filtering;
		if (this.prompt) this.prompt.input.focused = value;
	}

	private requestRender(): void {
		if (!this.closed) this.tui.requestRender();
	}

	private close(result: ManagerResult = undefined): void {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.timer);
		this.unsubscribe();
		this.done(result);
	}

	dispose(): void {
		clearInterval(this.timer);
		this.unsubscribe();
	}

	invalidate(): void {
		this.filter.invalidate();
		this.prompt?.input.invalidate();
		this.sub?.invalidate();
	}

	private say(text: string, type: "info" | "warning" | "error" = "info"): void {
		this.flash = { text, type, at: Date.now() };
		this.requestRender();
	}

	// --- Data -------------------------------------------------------------

	private sessions(): LiveSession[] {
		const all = this.host.list();
		const query = this.filter.getValue().trim().toLowerCase();
		if (!query) return all;
		const terms = query.split(/\s+/);
		return all.filter((r) => {
			const hay = [titleOf(r), r.sessionName, r.cwd, r.firstPrompt, this.host.modelLabel(r), r.id]
				.filter(Boolean)
				.join(" ")
				.toLowerCase();
			return terms.every((t) => hay.includes(t));
		});
	}

	private selected(): LiveSession | undefined {
		const list = this.sessions();
		return list.find((r) => r.id === this.selectedId) ?? list[0];
	}

	private move(delta: number): void {
		const list = this.sessions();
		if (!list.length) return;
		const index = Math.max(0, list.findIndex((r) => r.id === this.selected()?.id));
		const next = list[(index + delta + list.length) % list.length];
		if (!next) return;
		this.selectedId = next.id;
		this.detailScroll = 0;
		this.requestRender();
	}

	// --- Actions ----------------------------------------------------------

	private async run(label: string, action: () => Promise<void> | void): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.requestRender();
		try {
			await action();
		} catch (error: any) {
			debug(error);
			this.say(`${label} failed: ${error?.message ?? String(error)}`, "error");
		} finally {
			this.busy = false;
			this.requestRender();
		}
	}

	private switchTo(r: LiveSession | undefined): void {
		if (!r) return;
		if (r.id === this.host.activeId) {
			this.close();
			return;
		}
		this.close({ type: "switch", id: r.id });
	}

	private openPrompt(kind: PromptKind, target?: LiveSession): void {
		const input = new Input();
		input.focused = true;
		if (kind === "rename" && target) setInputValueAtEnd(input, target.sessionName ?? "");
		this.prompt = { kind, targetId: target?.id, input };
		this.requestRender();
	}

	private submitPrompt(): void {
		const prompt = this.prompt;
		if (!prompt) return;
		const value = prompt.input.getValue().trim();
		this.prompt = undefined;
		const target = prompt.targetId ? this.host.get(prompt.targetId) : undefined;
		if (prompt.kind === "new") {
			void this.run("New agent", async () => {
				const cwd = this.ctx.cwd || process.cwd();
				if (!value) {
					const child = await this.host.createChild({ cwd, ctx: this.ctx });
					this.close({ type: "switch", id: child.id });
					return;
				}
				const child = await this.host.createChild({ cwd, ctx: this.ctx, task: value });
				this.selectedId = child.id;
				this.say(`Started agent "${titleOf(child)}" in the background`);
			});
			return;
		}
		if (!target) {
			this.say("That session is gone", "warning");
			return;
		}
		if (prompt.kind === "rename") {
			void this.run("Rename", () => {
				if (!value) return;
				this.host.rename(target, value);
				this.say(`Renamed to "${value}"`);
			});
		} else if (prompt.kind === "message") {
			void this.run("Send", async () => {
				if (!value) return;
				const queued = this.host.activity(target) !== "idle";
				const started = target.state === "saved";
				await this.host.send(target, value);
				let note = `Sent to "${titleOf(target)}"`;
				if (queued) note = `Queued for "${titleOf(target)}"`;
				else if (started) note = `Started "${titleOf(target)}" and sent the message`;
				this.say(note);
			});
		}
	}

	private interrupt(r: LiveSession | undefined): void {
		if (!r) return;
		if (this.host.activity(r) === "idle") {
			this.say("That session is not running", "warning");
			return;
		}
		void this.run("Interrupt", async () => {
			await this.host.interrupt(r);
			this.say(`Interrupted "${titleOf(r)}"`);
		});
	}

	private requestKill(r: LiveSession | undefined): void {
		if (!r) return;
		if (r.kind === "parent") {
			this.say("The main session cannot be stopped from here. Use /quit.", "warning");
			return;
		}
		this.confirmKillId = r.id;
		this.requestRender();
	}

	private confirmKill(): void {
		const r = this.confirmKillId ? this.host.get(this.confirmKillId) : undefined;
		this.confirmKillId = undefined;
		if (!r) return;
		if (r.id === this.host.activeId) {
			// Stopping the session that owns the terminal needs the overlay closed first.
			this.close({ type: "kill", id: r.id });
			return;
		}
		void this.run("Stop", async () => {
			const title = titleOf(r);
			const saved = r.state === "saved";
			await this.host.stopChild(r.id);
			if (this.screen === "detail") this.screen = "list";
			this.say(saved ? `Removed "${title}" from the list. Its file stays.` : `Stopped "${title}"`);
		});
	}

	private openFolder(): void {
		this.sub = new FileExplorer(
			this.ctx.cwd || process.cwd(),
			this.theme,
			(cwd: string | null) => {
				this.sub = undefined;
				if (!cwd) return this.requestRender();
				void this.run("New session", async () => {
					const child = await this.host.createChild({ cwd, ctx: this.ctx });
					this.close({ type: "switch", id: child.id });
				});
			},
			() => this.requestRender(),
		);
		this.requestRender();
	}

	private openResume(): void {
		const live = new Set(this.host.list().map((r) => r.sessionFile).filter(Boolean));
		this.sub = new ResumeSessionPicker(
			this.theme,
			async () => {
				const all = (await SessionManager.listAll()) as SavedSessionInfo[];
				return all
					.filter((s) => !live.has(s.path))
					.sort((a, b) => Number(b.modified) - Number(a.modified));
			},
			(sessionPath: string | null) => {
				this.sub = undefined;
				if (!sessionPath) return this.requestRender();
				void this.run("Resume", async () => {
					const child = await this.host.openSaved(sessionPath, this.ctx);
					this.close({ type: "switch", id: child.id });
				});
			},
			() => this.requestRender(),
		);
		this.requestRender();
	}

	// --- Input ------------------------------------------------------------

	handleInput(data: string): void {
		if (this.sub) {
			this.sub.handleInput(data);
			return;
		}
		if (this.prompt) {
			if (matchesKey(data, "escape")) {
				this.prompt = undefined;
			} else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
				this.submitPrompt();
			} else {
				this.prompt.input.handleInput(data);
			}
			this.requestRender();
			return;
		}
		if (this.confirmKillId) {
			if (data === "y" || data === "Y" || matchesKey(data, "enter") || matchesKey(data, "return")) {
				this.confirmKill();
			} else {
				this.confirmKillId = undefined;
			}
			this.requestRender();
			return;
		}
		if (this.filtering) {
			if (matchesKey(data, "escape")) {
				this.filter.setValue("");
				this.filtering = false;
				this.filter.focused = false;
			} else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
				this.filtering = false;
				this.filter.focused = false;
			} else if (matchesKey(data, "up")) {
				this.move(-1);
			} else if (matchesKey(data, "down")) {
				this.move(1);
			} else {
				this.filter.handleInput(data);
				const first = this.sessions()[0];
				if (first && !this.sessions().some((r) => r.id === this.selectedId)) this.selectedId = first.id;
			}
			this.requestRender();
			return;
		}
		if (this.screen === "detail") {
			this.handleDetailInput(data);
			return;
		}
		this.handleListInput(data);
	}

	private handleCommonKey(data: string): boolean {
		const r = this.selected();
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			this.switchTo(r);
			return true;
		}
		switch (data) {
			case "e":
				if (r) this.openPrompt("rename", r);
				return true;
			case "m":
				if (r) this.openPrompt("message", r);
				return true;
			case "x":
				this.interrupt(r);
				return true;
			case "k":
			case "d":
				this.requestKill(r);
				return true;
			default:
				break;
		}
		if (isCtrl(data, "k")) {
			this.requestKill(r);
			return true;
		}
		return false;
	}

	private handleListInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			if (this.filter.getValue()) {
				this.filter.setValue("");
				this.requestRender();
				return;
			}
			this.close();
			return;
		}
		if (matchesKey(data, "up") || isCtrl(data, "p")) return this.move(-1);
		if (matchesKey(data, "down") || isCtrl(data, "n")) return this.move(1);
		if (matchesKey(data, "right") || matchesKey(data, "tab") || data === " ") {
			if (this.selected()) {
				this.screen = "detail";
				this.detailScroll = 0;
				this.requestRender();
			}
			return;
		}
		if (this.handleCommonKey(data)) return;
		if (/^[1-9]$/.test(data)) {
			const r = this.sessions()[Number(data) - 1];
			if (r) this.switchTo(r);
			return;
		}
		switch (data) {
			case "/":
				this.filtering = true;
				this.filter.focused = true;
				this.requestRender();
				return;
			case "n":
				this.openPrompt("new");
				return;
			case "o":
				this.openFolder();
				return;
			case "r":
				this.openResume();
				return;
			default:
				break;
		}
		if (isCtrl(data, "o")) this.openFolder();
		else if (isCtrl(data, "r")) this.openResume();
	}

	private handleDetailInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "left") || data === "q") {
			this.screen = "list";
			this.requestRender();
			return;
		}
		const page = Math.max(1, this.viewportRows() - 10);
		if (matchesKey(data, "up")) this.detailScroll += 1;
		else if (matchesKey(data, "down")) this.detailScroll = Math.max(0, this.detailScroll - 1);
		else if (matchesKey(data, "pageUp")) this.detailScroll += page;
		else if (matchesKey(data, "pageDown")) this.detailScroll = Math.max(0, this.detailScroll - page);
		else if (data === "g" || matchesKey(data, "home")) this.detailScroll = Number.MAX_SAFE_INTEGER;
		else if (data === "G" || matchesKey(data, "end")) this.detailScroll = 0;
		else if (matchesKey(data, "tab")) this.move(1);
		else if (matchesKey(data, "shift+tab")) this.move(-1);
		else this.handleCommonKey(data);
		this.requestRender();
	}

	// --- Rendering --------------------------------------------------------

	private viewportRows(): number {
		const rows = Number(this.tui?.terminal?.rows) || 40;
		return Math.max(16, Math.floor(rows * 0.9));
	}

	render(width: number): string[] {
		if (this.sub) return this.sub.render(width);
		const lines = this.screen === "detail" ? this.renderDetail(width) : this.renderList(width);
		return lines.map((line) => fit(line, width));
	}

	private headerCounts(): string {
		const th = this.theme;
		const all = this.host.list();
		const saved = all.filter((r) => r.state === "saved").length;
		const working = all.filter((r) => this.host.activity(r) === "working").length;
		const waiting = all.filter((r) => this.host.activity(r) === "waiting").length;
		const parts = [th.fg("muted", `${all.length - saved} live`)];
		if (saved) parts.push(th.fg("dim", `${saved} saved`));
		if (working) parts.push(th.fg("accent", `${working} working`));
		if (waiting) parts.push(th.fg("warning", `${waiting} need input`));
		return parts.join(th.fg("dim", " · "));
	}

	private renderFooterArea(box: Box, out: string[]): void {
		const th = this.theme;
		if (this.prompt) {
			const target = this.prompt.targetId ? this.host.get(this.prompt.targetId) : undefined;
			const name = target ? titleOf(target) : "session";
			const labels = {
				new: "New agent task (empty opens a blank session)",
				rename: `Rename "${name}"`,
				message: `Message to "${name}"`,
			};
			const label = labels[this.prompt.kind];
			out.push(box.sep(label));
			const prefix = th.fg("accent", "❯ ");
			out.push(box.line(prefix + renderInputChild(this.prompt.input, box.inner - 2)));
			return;
		}
		if (this.confirmKillId) {
			const target = this.host.get(this.confirmKillId);
			out.push(box.sep());
			const running = target && this.host.activity(target) !== "idle" ? " It is still running." : "";
			const name = target ? titleOf(target) : "session";
			const question =
				target?.state === "saved" ? `Remove "${name}" from the list? Its file stays.` : `Stop "${name}"?${running}`;
			out.push(
				box.line(
					th.fg("warning", `${question} `) +
						th.fg("dim", "y/enter confirm · any other key cancels"),
				),
			);
			return;
		}
		if (this.busy) {
			out.push(box.sep());
			out.push(box.line(th.fg("muted", `${spinnerFrame(this.host, th, this.frame)} working…`)));
		} else if (this.flash) {
			out.push(box.sep());
			const color = this.flash.type === "info" ? "success" : this.flash.type;
			out.push(box.line(th.fg(color, this.flash.text)));
		}
	}

	private renderList(width: number): string[] {
		const th = this.theme;
		const box = new Box(th, width);
		const inner = box.inner;
		const out: string[] = [];
		out.push(box.top(th.bold(th.fg("accent", "Sessions")), this.headerCounts()));
		const query = this.filter.getValue();
		if (this.filtering || query) {
			const input = this.filtering ? renderInputChild(this.filter, inner - 3) : th.fg("text", query);
			out.push(box.line(th.fg("accent", "/ ") + input));
		}
		out.push(box.line());

		const list = this.sessions();
		const footerExtra = this.prompt || this.confirmKillId || this.busy || this.flash ? 2 : 0;
		const fixed = out.length + 1 + PREVIEW_ROWS + 1 + footerExtra + 1 + 1;
		const slots = Math.max(1, Math.floor((this.viewportRows() - fixed) / 2));
		const selectedIndex = Math.max(0, list.findIndex((r) => r.id === this.selected()?.id));
		const start = Math.max(0, Math.min(selectedIndex - Math.floor(slots / 2), list.length - slots));
		const visible = list.slice(start, start + slots);

		if (!list.length) {
			out.push(box.line(th.fg("dim", query ? "No sessions match." : "No sessions.")));
			out.push(box.line());
		}
		if (start > 0) out.push(box.line(th.fg("dim", `  ↑ ${start} more`)));
		visible.forEach((r, i) => out.push(...this.renderRow(r, start + i, inner).map((l) => box.line(l))));
		const below = list.length - start - visible.length;
		if (below > 0) out.push(box.line(th.fg("dim", `  ↓ ${below} more`)));

		out.push(box.sep("preview"));
		out.push(...this.renderPreview(this.selected(), inner).map((l) => box.line(l)));
		this.renderFooterArea(box, out);
		out.push(box.bottom(th.fg("dim", this.host.activeId === PARENT_ID ? "main" : "child")));
		out.push(
			hints(
				th,
				[
					["↑↓", "select"],
					["⏎", "switch"],
					["→", "details"],
					["n", "new agent"],
					["m", "message"],
					["e", "rename"],
					["x", "interrupt"],
					["k", "stop"],
					["o", "new in folder"],
					["r", "resume"],
					["/", "filter"],
					["esc", "close"],
				],
				width,
			),
		);
		return out;
	}

	/** Two unframed rows per session. */
	private renderRow(r: LiveSession, index: number, inner: number): string[] {
		const th = this.theme;
		const selected = r.id === this.selected()?.id;
		const current = r.id === this.host.activeId;
		const marker = selected ? th.fg("accent", "❯") : " ";
		const icon = statusIcon(this.host, r, th, this.frame);
		const num = index < 9 ? th.fg("dim", `${index + 1}`) : " ";
		let title = titleOf(r);
		if (selected) title = th.bold(th.fg("accent", title));
		else if (r.unread) title = th.bold(title);
		const tags: string[] = [];
		if (current) tags.push(th.fg("dim", "(current)"));
		if (r.kind === "parent") tags.push(th.fg("dim", "main"));
		if (r.unread) tags.push(th.fg("accent", "•"));
		const right = `${statusText(this.host, r, th)}  ${th.fg("dim", timeText(this.host, r).padStart(7))}`;
		const rightW = Math.min(visibleWidth(right), Math.floor(inner * 0.55));
		const left = `${marker} ${num} ${icon} ${title}${tags.length ? ` ${tags.join(" ")}` : ""}`;
		const line1 = spread(left, fit(right, rightW), inner);

		const s = this.host.stats(r);
		const meta = [shortPath(r.cwd)];
		const model = this.host.modelLabel(r);
		if (model) meta.push(model);
		const tokens = s.input + s.output + s.cacheRead + s.cacheWrite;
		if (tokens) meta.push(`${fmtTokens(tokens)} tok`);
		if (s.cost) meta.push(fmtCost(s.cost));
		if (s.contextPercent != null) meta.push(`ctx ${Math.round(s.contextPercent)}%`);
		const line2 = `       ${th.fg("dim", meta.join(" · "))}`;
		return [line1, fit(line2, inner)];
	}

	private renderPreview(r: LiveSession | undefined, inner: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		if (!r) return Array.from({ length: PREVIEW_ROWS }, () => "");
		const prompt = this.host.lastPrompt(r);
		lines.push(prompt ? th.fg("accent", "› ") + th.fg("muted", fit(prompt, inner - 2)) : th.fg("dim", "No messages yet."));
		const reply = this.host.lastReply(r);
		const replyRows = PREVIEW_ROWS - 2;
		if (reply) {
			const wrapped = wrap(reply.replace(/\n{2,}/g, "\n"), inner - 2).filter((l) => l.trim());
			const tail = wrapped.slice(-replyRows);
			tail.forEach((l, i) => lines.push((i === 0 ? th.fg("text", "⏺ ") : "  ") + th.fg("text", l)));
		}
		while (lines.length < PREVIEW_ROWS - 1) lines.push("");
		let status = "";
		const activity = this.host.activity(r);
		if (activity === "waiting") status = th.fg("warning", `⚠ waiting for you${r.promptTitle ? `: ${r.promptTitle}` : ""}. Press ⏎ to switch.`);
		else if (r.tool) status = th.fg("dim", `  ⎿ ${r.tool.name} ${r.tool.detail} (${fmtDuration(Date.now() - r.tool.startedAt)})`);
		else if (r.error) status = th.fg("error", `  ✗ ${r.error}`);
		else if (r.lastRunMs && activity === "idle") status = th.fg("dim", `  last run took ${fmtDuration(r.lastRunMs)}`);
		lines.push(fit(status, inner));
		return lines.slice(0, PREVIEW_ROWS);
	}

	private renderDetail(width: number): string[] {
		const th = this.theme;
		const box = new Box(th, width);
		const inner = box.inner;
		const r = this.selected();
		const out: string[] = [];
		if (!r) {
			this.screen = "list";
			return this.renderList(width);
		}
		const icon = statusIcon(this.host, r, th, this.frame);
		out.push(box.top(`${icon} ${th.bold(th.fg("accent", fit(titleOf(r), inner - 30)))}`, this.headerCounts()));
		const s = this.host.stats(r);
		const label = (text: string) => th.fg("muted", text.padEnd(10));
		const activity = this.host.activity(r);
		const status = [statusText(this.host, r, th)];
		if (activity !== "idle" && r.runStartedAt) status.push(th.fg("dim", `running ${fmtDuration(Date.now() - r.runStartedAt)}`));
		else if (r.lastRunMs) status.push(th.fg("dim", `last run ${fmtDuration(r.lastRunMs)}`));
		if (r.id === this.host.activeId) status.push(th.fg("dim", "current"));
		out.push(box.line(label("Status") + status.join(th.fg("dim", " · "))));
		out.push(box.line(label("Directory") + shortPath(r.cwd)));
		const model = this.host.modelLabel(r);
		out.push(box.line(label("Model") + (model || th.fg("dim", "unknown"))));
		out.push(
			box.line(
				label("Usage") +
					`↑ ${fmtTokens(s.input)} in · ↓ ${fmtTokens(s.output)} out · ${fmtTokens(s.cacheRead)} cache · ` +
					th.fg("success", fmtCost(s.cost)),
			),
		);
		out.push(box.line(label("Context") + this.contextBar(s.contextPercent, s.contextWindow, Math.min(24, inner - 30))));
		out.push(
			box.line(
				label("Messages") +
					`${s.userMessages} user · ${s.assistantMessages} assistant · ${s.toolCalls} tool calls`,
			),
		);
		const sessionInfo = [r.sessionId ? r.sessionId.slice(0, 8) : r.id, `started ${fmtAgo(r.createdAt)}`];
		if (r.sessionFile) sessionInfo.push(shortPath(r.sessionFile));
		out.push(box.line(label("Session") + th.fg("dim", sessionInfo.join(" · "))));
		const locks = this.host.locks.heldBy(r.id);
		if (locks.length) out.push(box.line(label("Locks") + th.fg("warning", locks.map(shortPath).join(", "))));

		out.push(box.sep("transcript"));
		const footerExtra = this.prompt || this.confirmKillId || this.busy || this.flash ? 2 : 0;
		const avail = Math.max(4, this.viewportRows() - out.length - footerExtra - 2);
		const body = this.renderTranscript(this.host.transcript(r, 120), inner);
		if (activity === "waiting") {
			body.push("", th.fg("warning", `⚠ waiting for you${r.promptTitle ? `: ${r.promptTitle}` : ""}. Press ⏎ to switch.`));
		}
		const maxScroll = Math.max(0, body.length - avail);
		this.detailScroll = Math.min(this.detailScroll, maxScroll);
		const end = body.length - this.detailScroll;
		const view = body.slice(Math.max(0, end - avail), end);
		// Short transcripts start at the top. Long ones stick to the newest line.
		while (view.length < avail) view.push("");
		out.push(...view.map((l) => box.line(l)));
		this.renderFooterArea(box, out);
		const scrollText = this.detailScroll ? `↑ ${this.detailScroll} lines up` : "following";
		const scrollInfo = maxScroll ? th.fg("dim", scrollText) : "";
		out.push(box.bottom(scrollInfo));
		out.push(
			hints(
				th,
				[
					["esc", "back"],
					["⏎", "switch"],
					["m", "message"],
					["e", "rename"],
					["x", "interrupt"],
					["k", "stop"],
					["↑↓ pgup/pgdn", "scroll"],
					["tab", "next"],
				],
				width,
			),
		);
		return out;
	}

	private contextBar(percent: number | null, window: number | null, cells: number): string {
		const th = this.theme;
		if (percent == null) return th.fg("dim", "unknown");
		const n = Math.max(4, cells);
		const filled = Math.round((Math.min(100, percent) / 100) * n);
		let color = "error";
		if (percent < 50) color = "success";
		else if (percent < 80) color = "warning";
		const bar = th.fg(color, "█".repeat(filled)) + th.fg("dim", "░".repeat(n - filled));
		const total = window ? ` of ${fmtTokens(window)}` : "";
		return `${bar} ${Math.round(percent)}%${total}`;
	}

	private renderTranscript(items: TranscriptItem[], inner: number): string[] {
		const th = this.theme;
		const out: string[] = [];
		let previous: TranscriptItem["kind"] | undefined;
		for (const item of items) {
			const gap = previous && (item.kind === "user" || (item.kind === "assistant" && previous !== "tool"));
			if (gap) out.push("");
			if (item.kind === "user") {
				const lines = wrap(item.text, inner - 2);
				lines.forEach((l, i) => out.push((i === 0 ? th.fg("accent", "› ") : "  ") + th.fg("userMessageText", l)));
			} else if (item.kind === "assistant") {
				const lines = wrap(item.text, inner - 2);
				lines.forEach((l, i) => out.push((i === 0 ? "⏺ " : "  ") + th.fg("text", l)));
			} else if (item.kind === "tool") {
				out.push(th.fg("dim", fit(`  ⎿ ${item.text}`, inner)));
			} else if (item.kind === "toolError") {
				out.push(th.fg("error", fit(`  ✗ ${item.text}`, inner)));
			} else {
				out.push(th.fg("dim", item.text));
			}
			previous = item.kind;
		}
		if (!out.length) out.push(th.fg("dim", "No messages yet."));
		return out;
	}
}

// ---------------------------------------------------------------------------
// Status bar under the editor: one glyph and a short name per live session.

export class StatusBar implements Component {
	private frame = 0;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly host: SessionHost,
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private readonly shortcut: string,
	) {}

	render(width: number): string[] {
		// Saved rows stay out of the status bar until they start.
		const sessions = this.host.list().filter((r) => r.state !== "saved");
		if (sessions.length < 2) {
			this.setTimer(false);
			return [];
		}
		const th = this.theme;
		this.setTimer(sessions.some((r) => this.host.activity(r) === "working"));
		const segments = sessions.map((r) => {
			const current = r.id === this.host.activeId;
			const name = fit(r.sessionName || (r.kind === "parent" ? "main" : titleOf(r)), 20);
			let styled = th.fg(r.unread ? "text" : "muted", name);
			if (current) styled = th.bold(th.fg("accent", name));
			const dot = r.unread ? th.fg("accent", "•") : "";
			return `${statusIcon(this.host, r, th, this.frame)} ${styled}${dot}`;
		});
		const hint = th.fg("dim", `${this.shortcut} sessions`);
		let line = "";
		for (const segment of segments) {
			const next = line ? `${line}${th.fg("dim", "  │  ")}${segment}` : segment;
			if (visibleWidth(next) + visibleWidth(hint) + 3 > width) break;
			line = next;
		}
		return [spread(` ${line}`, hint, width)];
	}

	invalidate(): void {}

	dispose(): void {
		this.setTimer(false);
	}

	private setTimer(on: boolean): void {
		if (on && !this.timer) {
			this.timer = setInterval(() => {
				this.frame++;
				this.requestRender();
			}, this.host.workingIndicator?.intervalMs || TICK_MS);
		} else if (!on && this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
}
