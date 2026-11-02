// Session manager UI: a Claude-Code-style overlay that lists sessions with status, usage,
// and a preview. It also has a detail screen and a status bar. Both read a SessionSource,
// so they work the same in a worker, in plain pi, and in pi-sm.
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
import type { Inheritance } from "./control.ts";
import { compactTokens } from "./footer.ts";
import { debug } from "./log.ts";
import {
	FileExplorer,
	isCtrl,
	renderInputChild,
	ResumeSessionPicker,
	setInputValueAtEnd,
	type SavedSessionInfo,
} from "./pickers.ts";
import { PLAIN_PIN_TEXT, PLAIN_STOP_TEXT } from "./plain-source.ts";
import { activityOf, titleOf, type Row, type SessionSource } from "./remote-source.ts";
import { emptyUsage, type TranscriptItem } from "./transcript.ts";

type Theme = any;

/** "open" asks the caller to show that session in this terminal. */
export type ManagerResult = { type: "open"; id: string } | undefined;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 100;
const PREVIEW_ROWS = 5;
/** What the manager says when no background session exists. */
export const EMPTY_HINT = "No background sessions. Press n for a new one, or r to open a saved pi session.";

// ---------------------------------------------------------------------------
// Formatting helpers

export const fmtTokens = compactTokens;

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

function spinnerFrame(theme: Theme, frame: number): string {
	return theme.fg("accent", SPINNER[frame % SPINNER.length] ?? "");
}

function statusIcon(r: Row, theme: Theme, frame: number): string {
	if (r.state === "failed") return theme.fg("error", "✗");
	if (r.state === "starting") return theme.fg("dim", "◌");
	if (r.state === "saved") return theme.fg("dim", "◇");
	const activity = activityOf(r);
	if (activity === "waiting") return theme.bold(theme.fg("warning", "?"));
	if (activity === "working") return spinnerFrame(theme, frame);
	if (r.lastOutcome === "error") return theme.fg("error", "✗");
	if (r.lastOutcome === "aborted") return theme.fg("warning", "■");
	if (r.lastOutcome === "done") return theme.fg("success", "✓");
	return theme.fg("dim", "○");
}

function statusText(r: Row, theme: Theme): string {
	if (r.state === "failed") return theme.fg("error", `failed: ${r.error ?? "the worker died"}`);
	if (r.state === "starting") return theme.fg("dim", "starting…");
	if (r.state === "saved") return theme.fg("dim", "saved · ⏎ starts it");
	const activity = activityOf(r);
	if (activity === "waiting") {
		return theme.fg("warning", r.promptTitle ? `needs input · ${r.promptTitle}` : "needs input");
	}
	if (activity === "working") {
		if (r.tool) return theme.fg("muted", `${r.tool.name}${r.tool.detail ? ` ${r.tool.detail}` : ""}`);
		return theme.fg("muted", r.reply ? "responding…" : "thinking…");
	}
	if (r.lastOutcome === "error") return theme.fg("error", "failed");
	if (r.lastOutcome === "aborted") return theme.fg("warning", "interrupted");
	if (r.unread) return theme.fg("success", "done · unread");
	if (r.lastOutcome === "done") return theme.fg("success", "done");
	return theme.fg("dim", "ready");
}

function timeText(r: Row): string {
	if (activityOf(r) !== "idle" && r.runStartedAt) return fmtDuration(Date.now() - r.runStartedAt);
	return fmtAgo(r.lastActivityAt);
}

function usageOf(r: Row) {
	return r.usage ?? emptyUsage();
}

function tokensOf(r: Row): number {
	const u = usageOf(r);
	return u.input + u.output + u.cacheRead + u.cacheWrite;
}

/** The newest reply: the streaming tail during a run, the last reply after it. */
function replyOf(r: Row): string | undefined {
	if (activityOf(r) === "working" && r.reply?.trim()) return r.reply.trim();
	return r.lastReply;
}

// ---------------------------------------------------------------------------
// Box drawing

class Box {
	private readonly theme: Theme;
	readonly width: number;

	constructor(theme: Theme, width: number) {
		this.theme = theme;
		this.width = width;
	}

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
	source: SessionSource;
	/** The folder for new sessions. */
	cwd: string;
	done: (result: ManagerResult) => void;
	initial?: "resume" | "new";
	/** What new sessions take over from the session that opens the manager. */
	inherit?: () => Inheritance;
	/** A notice to show at the start, such as how the last attach ended. */
	notice?: { text: string; type: "info" | "warning" | "error" };
}

export class ManagerView implements Component, Focusable {
	private readonly tui: any;
	private readonly theme: Theme;
	private readonly source: SessionSource;
	private readonly cwd: string;
	private readonly inherit: () => Inheritance;
	private readonly done: (result: ManagerResult) => void;
	private readonly filter = new Input();
	private filtering = false;
	private screen: "list" | "detail" = "list";
	private prompt?: PromptState;
	private confirmKillId?: string;
	private selectedId?: string;
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
		this.source = opts.source;
		this.cwd = opts.cwd;
		this.inherit = opts.inherit ?? (() => ({}));
		this.done = opts.done;
		const sessions = this.sessions();
		const current = this.source.currentId;
		// Start on the most interesting session that is not the current one.
		const pick =
			sessions.find((r) => r.id !== current && activityOf(r) === "waiting") ??
			sessions.find((r) => r.id !== current && r.unread) ??
			sessions.find((r) => r.id !== current) ??
			sessions[0];
		this.selectedId = pick?.id;
		this.unsubscribe = this.source.subscribe(() => this.requestRender());
		this.timer = setInterval(() => {
			this.frame++;
			if (this.flash && Date.now() - this.flash.at > 4000) this.flash = undefined;
			this.requestRender();
		}, TICK_MS);
		if (opts.notice) this.say(opts.notice.text, opts.notice.type);
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

	private sessions(): Row[] {
		const all = this.source.list();
		const query = this.filter.getValue().trim().toLowerCase();
		if (!query) return all;
		const terms = query.split(/\s+/);
		return all.filter((r) => {
			const hay = [titleOf(r), r.name, r.cwd, r.firstPrompt, r.modelLabel, r.id]
				.filter(Boolean)
				.join(" ")
				.toLowerCase();
			return terms.every((t) => hay.includes(t));
		});
	}

	private selected(): Row | undefined {
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

	private switchTo(r: Row | undefined): void {
		if (!r) return;
		if (r.id === this.source.currentId) {
			this.close();
			return;
		}
		this.close({ type: "open", id: r.id });
	}

	private openPrompt(kind: PromptKind, target?: Row): void {
		const input = new Input();
		input.focused = true;
		if (kind === "rename" && target) setInputValueAtEnd(input, target.name ?? "");
		this.prompt = { kind, targetId: target?.id, input };
		this.requestRender();
	}

	private submitPrompt(): void {
		const prompt = this.prompt;
		if (!prompt) return;
		const value = prompt.input.getValue().trim();
		this.prompt = undefined;
		const target = prompt.targetId ? this.source.get(prompt.targetId) : undefined;
		if (prompt.kind === "new") {
			void this.run("New agent", async () => {
				if (!value) {
					const row = await this.source.create({ cwd: this.cwd, ...this.inherit() });
					this.close({ type: "open", id: row.id });
					return;
				}
				const row = await this.source.create({ cwd: this.cwd, task: value, ...this.inherit() });
				this.selectedId = row.id;
				this.say(`Started agent "${titleOf(row)}" in the background`);
			});
			return;
		}
		if (!target) {
			this.say("That session is gone", "warning");
			return;
		}
		if (prompt.kind === "rename") {
			void this.run("Rename", async () => {
				if (!value) return;
				await this.source.rename(target.id, value);
				this.say(`Renamed to "${value}"`);
			});
		} else if (prompt.kind === "message") {
			void this.run("Send", async () => {
				if (!value) return;
				const queued = activityOf(target) !== "idle";
				const started = target.state === "saved" || target.state === "failed";
				await this.source.send(target.id, value);
				let note = `Sent to "${titleOf(target)}"`;
				if (queued) note = `Queued for "${titleOf(target)}"`;
				else if (started) note = `Started "${titleOf(target)}" and sent the message`;
				this.say(note);
			});
		}
	}

	private interrupt(r: Row | undefined): void {
		if (!r) return;
		if (activityOf(r) === "idle") {
			this.say("That session is not running", "warning");
			return;
		}
		void this.run("Interrupt", async () => {
			await this.source.interrupt(r.id);
			this.say(`Interrupted "${titleOf(r)}"`);
		});
	}

	/** A pinned session keeps its worker when it idles (spec §7.6). */
	private togglePin(r: Row | undefined): void {
		if (!r) return;
		if (r.plain) {
			this.say(PLAIN_PIN_TEXT, "warning");
			return;
		}
		void this.run("Pin", async () => {
			await this.source.pin(r.id, !r.pinned);
			this.say(r.pinned ? `"${titleOf(r)}" can stop when idle` : `"${titleOf(r)}" keeps running when idle`);
		});
	}

	private requestKill(r: Row | undefined): void {
		if (!r) return;
		if (r.plain) {
			this.say(PLAIN_STOP_TEXT, "warning");
			return;
		}
		this.confirmKillId = r.id;
		this.requestRender();
	}

	private confirmKill(): void {
		const r = this.confirmKillId ? this.source.get(this.confirmKillId) : undefined;
		this.confirmKillId = undefined;
		if (!r) return;
		void this.run("Stop", async () => {
			const title = titleOf(r);
			const saved = r.state === "saved" || r.state === "failed";
			// A stop of the session that runs this overlay ends it, and its client returns to its manager.
			await this.source.stop(r.id);
			if (this.screen === "detail") this.screen = "list";
			this.say(saved ? `Removed "${title}" from the list. Its file stays.` : `Stopped "${title}"`);
		});
	}

	private openFolder(): void {
		this.sub = new FileExplorer(
			this.cwd,
			this.theme,
			(cwd: string | null) => {
				this.sub = undefined;
				if (!cwd) return this.requestRender();
				void this.run("New session", async () => {
					const row = await this.source.create({ cwd, ...this.inherit() });
					this.close({ type: "open", id: row.id });
				});
			},
			() => this.requestRender(),
		);
		this.requestRender();
	}

	private openResume(): void {
		const listed = new Set(this.source.list().map((r) => r.sessionFile).filter(Boolean));
		let all: SavedSessionInfo[] = [];
		this.sub = new ResumeSessionPicker(
			this.theme,
			async () => {
				all = ((await SessionManager.listAll()) as SavedSessionInfo[])
					.filter((s) => !listed.has(s.path))
					.sort((a, b) => Number(b.modified) - Number(a.modified));
				return all;
			},
			(sessionPath: string | null) => {
				this.sub = undefined;
				if (!sessionPath) return this.requestRender();
				void this.run("Resume", async () => {
					const info = all.find((s) => s.path === sessionPath);
					const row = await this.source.create({ cwd: info?.cwd || this.cwd, sessionFile: sessionPath });
					this.close({ type: "open", id: row.id });
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
			case "p":
				this.togglePin(r);
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
		if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "ctrl+c")) {
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
		const all = this.source.list();
		const saved = all.filter((r) => r.state === "saved" || r.state === "failed").length;
		const working = all.filter((r) => activityOf(r) === "working").length;
		const waiting = all.filter((r) => activityOf(r) === "waiting").length;
		const parts = [th.fg("muted", `${all.length - saved} live`)];
		if (saved) parts.push(th.fg("dim", `${saved} saved`));
		if (working) parts.push(th.fg("accent", `${working} working`));
		if (waiting) parts.push(th.fg("warning", `${waiting} need input`));
		return parts.join(th.fg("dim", " · "));
	}

	private renderFooterArea(box: Box, out: string[]): void {
		const th = this.theme;
		if (this.prompt) {
			const target = this.prompt.targetId ? this.source.get(this.prompt.targetId) : undefined;
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
			const target = this.source.get(this.confirmKillId);
			out.push(box.sep());
			const running = target && activityOf(target) !== "idle" ? " It is still running." : "";
			const name = target ? titleOf(target) : "session";
			const asleep = target?.state === "saved" || target?.state === "failed";
			const question = asleep ? `Remove "${name}" from the list? Its file stays.` : `Stop "${name}"?${running}`;
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
			out.push(box.line(th.fg("muted", `${spinnerFrame(th, this.frame)} working…`)));
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
			let empty = query ? "No sessions match." : EMPTY_HINT;
			if (!query && this.source.problem) empty = this.source.problem;
			out.push(box.line(th.fg("dim", empty)));
			out.push(box.line());
		}
		if (start > 0) out.push(box.line(th.fg("dim", `  ↑ ${start} more`)));
		visible.forEach((r, i) => out.push(...this.renderRow(r, start + i, inner).map((l) => box.line(l))));
		// Plain pi always lists its own row. Without background sessions, say how to get one.
		if (!query && list.length && list.every((r) => r.plain)) {
			out.push(box.line());
			out.push(box.line(th.fg("dim", this.source.problem ?? EMPTY_HINT)));
		}
		const below = list.length - start - visible.length;
		if (below > 0) out.push(box.line(th.fg("dim", `  ↓ ${below} more`)));

		out.push(box.sep("preview"));
		out.push(...this.renderPreview(this.selected(), inner).map((l) => box.line(l)));
		this.renderFooterArea(box, out);
		out.push(box.bottom(this.source.problem && list.length ? th.fg("warning", this.source.problem) : ""));
		out.push(
			hints(
				th,
				[
					["↑↓", "select"],
					["⏎", "open"],
					["→", "details"],
					["n", "new agent"],
					["m", "message"],
					["e", "rename"],
					["x", "interrupt"],
					["k", "stop"],
					["p", "pin"],
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
	private renderRow(r: Row, index: number, inner: number): string[] {
		const th = this.theme;
		const selected = r.id === this.selected()?.id;
		const current = r.id === this.source.currentId;
		const marker = selected ? th.fg("accent", "❯") : " ";
		const icon = statusIcon(r, th, this.frame);
		const num = index < 9 ? th.fg("dim", `${index + 1}`) : " ";
		let title = titleOf(r);
		if (selected) title = th.bold(th.fg("accent", title));
		else if (r.unread) title = th.bold(title);
		const tags: string[] = [];
		if (current) tags.push(th.fg("dim", "(this session)"));
		else if (r.attached) tags.push(th.fg("dim", "(open elsewhere)"));
		if (r.pinned) tags.push(th.fg("dim", "pinned"));
		if (r.unread) tags.push(th.fg("accent", "•"));
		const right = `${statusText(r, th)}  ${th.fg("dim", timeText(r).padStart(7))}`;
		const rightW = Math.min(visibleWidth(right), Math.floor(inner * 0.55));
		const left = `${marker} ${num} ${icon} ${title}${tags.length ? ` ${tags.join(" ")}` : ""}`;
		const line1 = spread(left, fit(right, rightW), inner);

		const s = usageOf(r);
		const meta = [shortPath(r.cwd)];
		if (r.modelLabel) meta.push(r.modelLabel);
		const tokens = tokensOf(r);
		if (tokens) meta.push(`${fmtTokens(tokens)} tok`);
		if (s.cost) meta.push(fmtCost(s.cost));
		if (s.contextPercent != null) meta.push(`ctx ${Math.round(s.contextPercent)}%`);
		const line2 = `       ${th.fg("dim", meta.join(" · "))}`;
		return [line1, fit(line2, inner)];
	}

	private renderPreview(r: Row | undefined, inner: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		if (!r) return Array.from({ length: PREVIEW_ROWS }, () => "");
		const prompt = r.lastPrompt ?? r.firstPrompt;
		lines.push(prompt ? th.fg("accent", "› ") + th.fg("muted", fit(prompt, inner - 2)) : th.fg("dim", "No messages yet."));
		const reply = replyOf(r);
		const replyRows = PREVIEW_ROWS - 2;
		if (reply) {
			const wrapped = wrap(reply.replace(/\n{2,}/g, "\n"), inner - 2).filter((l) => l.trim());
			const tail = wrapped.slice(-replyRows);
			tail.forEach((l, i) => lines.push((i === 0 ? th.fg("text", "⏺ ") : "  ") + th.fg("text", l)));
		}
		while (lines.length < PREVIEW_ROWS - 1) lines.push("");
		let status = "";
		const activity = activityOf(r);
		if (activity === "waiting") status = th.fg("warning", `⚠ waiting for you${r.promptTitle ? `: ${r.promptTitle}` : ""}. Press ⏎ to open it.`);
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
		const icon = statusIcon(r, th, this.frame);
		out.push(box.top(`${icon} ${th.bold(th.fg("accent", fit(titleOf(r), inner - 30)))}`, this.headerCounts()));
		const s = usageOf(r);
		const label = (text: string) => th.fg("muted", text.padEnd(10));
		const activity = activityOf(r);
		const status = [statusText(r, th)];
		if (activity !== "idle" && r.runStartedAt) status.push(th.fg("dim", `running ${fmtDuration(Date.now() - r.runStartedAt)}`));
		else if (r.lastRunMs) status.push(th.fg("dim", `last run ${fmtDuration(r.lastRunMs)}`));
		if (r.id === this.source.currentId) status.push(th.fg("dim", "this session"));
		else if (r.attached) status.push(th.fg("dim", "open elsewhere"));
		out.push(box.line(label("Status") + status.join(th.fg("dim", " · "))));
		out.push(box.line(label("Directory") + shortPath(r.cwd)));
		out.push(box.line(label("Model") + (r.modelLabel || th.fg("dim", "unknown"))));
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
		const locks = r.locks ?? [];
		if (locks.length) out.push(box.line(label("Locks") + th.fg("warning", locks.map(shortPath).join(", "))));

		out.push(box.sep("transcript"));
		const footerExtra = this.prompt || this.confirmKillId || this.busy || this.flash ? 2 : 0;
		const avail = Math.max(4, this.viewportRows() - out.length - footerExtra - 2);
		const items = [...(this.source.transcript(r.id) ?? [])];
		const streaming = activity === "working" ? r.reply?.trim() : undefined;
		if (streaming && items.at(-1)?.text !== streaming) items.push({ kind: "assistant", text: streaming });
		const body = this.renderTranscript(items, inner);
		if (activity === "waiting") {
			body.push("", th.fg("warning", `⚠ waiting for you${r.promptTitle ? `: ${r.promptTitle}` : ""}. Press ⏎ to open it.`));
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
					["⏎", "open"],
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

	private readonly source: SessionSource;
	private readonly theme: Theme;
	private readonly requestRender: () => void;
	private readonly shortcut: string;

	constructor(source: SessionSource, theme: Theme, requestRender: () => void, shortcut: string) {
		this.source = source;
		this.theme = theme;
		this.requestRender = requestRender;
		this.shortcut = shortcut;
	}

	render(width: number): string[] {
		// Saved rows stay out of the status bar until they start.
		const sessions = this.source.list().filter((r) => r.state !== "saved");
		if (!sessions.some((r) => r.id !== this.source.currentId)) {
			this.setTimer(false);
			return [];
		}
		const th = this.theme;
		this.setTimer(sessions.some((r) => activityOf(r) === "working"));
		const segments = sessions.map((r) => {
			const current = r.id === this.source.currentId;
			const name = fit(titleOf(r), 20);
			let styled = th.fg(r.unread ? "text" : "muted", name);
			if (current) styled = th.bold(th.fg("accent", name));
			const dot = r.unread ? th.fg("accent", "•") : "";
			return `${statusIcon(r, th, this.frame)} ${styled}${dot}`;
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
			}, TICK_MS);
		} else if (!on && this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
}
