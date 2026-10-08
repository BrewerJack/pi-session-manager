// Folder explorer and saved-session picker.
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	fuzzyFilter,
	getKeybindings,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";
import { debug } from "./host.ts";

export type SavedSessionInfo = {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	modified?: Date;
	firstMessage?: string;
	messageCount?: number;
};

export function isCtrl(data: string, key: "o" | "r" | "k" | "p" | "n"): boolean {
	const codes: Record<string, string> = {
		o: "\x0f",
		r: "\x12",
		k: "\x0b",
		p: "\x10",
		n: "\x0e",
	};
	return data === codes[key] || matchesKey(data, Key.ctrl(key));
}

function padVisible(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "…");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

export function renderInputChild(input: Input, width: number): string {
	const line = input.render(Math.max(1, width))[0] ?? "";
	return line.startsWith("> ") ? line.slice(2) : line;
}

const FILE_EXPLORER_MAX_VISIBLE = 8;
const RESUME_MAX_VISIBLE = 12;

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return path.join(homedir(), input.slice(2));
	return input;
}

function normalizeExistingDir(input: string): string | null {
	try {
		const expanded = expandHome(input.trim());
		if (!expanded) return null;
		const absolute = path.resolve(expanded);
		if (!existsSync(absolute)) return null;
		if (!statSync(absolute).isDirectory()) return null;
		return absolute;
	} catch {
		return null;
	}
}

function relativeTime(date: Date): string {
	const ms = Date.now() - date.getTime();
	if (!Number.isFinite(ms) || ms < 0) return "now";
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return "now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hour = Math.floor(min / 60);
	if (hour < 24) return `${hour}h ago`;
	const day = Math.floor(hour / 24);
	if (day < 30) return `${day}d ago`;
	const month = Math.floor(day / 30);
	if (month < 12) return `${month}mo ago`;
	return `${Math.floor(month / 12)}y ago`;
}

function fits(width: number, text: string): string {
	return truncateToWidth(text, Math.max(0, width), "…");
}

function indent(width: number, text: string): string {
	return fits(width, `  ${text}`);
}

export function setInputValueAtEnd(input: Input, value: string): void {
	input.setValue(value);
	// SAFETY: pi-tui Input keeps the caret in the private numeric field `cursor`
	// (see components/input.d.ts). It has no public setter for the caret.
	(input as unknown as { cursor: number }).cursor = value.length;
}

function dirPrefix(value: string): string {
	const slash = value.lastIndexOf("/");
	return slash >= 0 ? value.slice(0, slash + 1) : "";
}

function formatSize(bytes: number): string {
	if (bytes < 1000) return `${bytes}b`;
	if (bytes < 1_000_000)
		return `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)}kb`;
	if (bytes < 1_000_000_000)
		return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)}Mb`;
	return `${(bytes / 1_000_000_000).toFixed(1)}Gb`;
}

type FileEntry = {
	name: string;
	path: string;
	isDirectory: boolean;
	size: string;
	modified: Date;
};

function readFileEntries(dir: string): FileEntry[] {
	const entries: FileEntry[] = [
		{
			name: "./",
			path: dir,
			isDirectory: true,
			size: "",
			modified: new Date(),
		},
	];

	for (const dirent of readdirSync(dir, { withFileTypes: true })) {
		try {
			const entryPath = path.join(dir, dirent.name);
			const stat = statSync(entryPath);
			const isDirectory = stat.isDirectory();
			entries.push({
				name: `${dirent.name}${isDirectory ? "/" : ""}`,
				path: entryPath,
				isDirectory,
				size: isDirectory ? "" : formatSize(stat.size),
				modified: stat.mtime,
			});
		} catch (error) {
			// Skip unreadable entries.
			debug(error);
		}
	}

	return entries.sort((a, b) => {
		if (a.name === "./") return -1;
		if (b.name === "./") return 1;
		if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

export class FileExplorer implements Component, Focusable {
	private entries: FileEntry[] = [];
	private selectedIndex = 0;
	private readonly searchInput = new Input();
	private error: string | undefined;
	private readonly theme: Theme;
	private readonly done: (path: string | null) => void;
	private readonly requestRender: () => void;

	constructor(
		initialCwd: string,
		theme: Theme,
		done: (path: string | null) => void,
		requestRender: () => void,
	) {
		setInputValueAtEnd(
			this.searchInput,
			`${normalizeExistingDir(initialCwd) ?? homedir()}/`,
		);
		this.theme = theme;
		this.done = done;
		this.requestRender = requestRender;
		this.refresh();
	}

	render(width: number): string[] {
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const lines: string[] = [];
		lines.push(this.border(width));
		lines.push(this.header(width));
		lines.push(this.border(width, "dim"));
		this.renderEntries(lines, width);
		lines.push(this.border(width));
		lines.push(
			fits(
				width,
				dim("↑↓/<C-p>/<C-n>") +
					muted(" move · ") +
					dim("<tab>") +
					muted(" enter folder · ") +
					dim("<enter>") +
					muted(" choose folder · ") +
					dim("<M-backspace>") +
					muted(" parent · ") +
					dim("<esc>") +
					muted(" cancel"),
			),
		);
		return lines;
	}

	get focused(): boolean {
		return this.searchInput.focused;
	}

	set focused(value: boolean) {
		this.searchInput.focused = value;
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.enterSelectedDirectory();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.chooseSelectedDirectory();
			return;
		}
		if (getKeybindings().matches(data, "tui.editor.deleteWordBackward")) {
			this.deletePathSegmentBackward();
			return;
		}

		const before = this.search;
		const beforeDir = dirPrefix(before);
		this.searchInput.handleInput(data);
		const after = this.search;
		if (after !== before) {
			if (dirPrefix(after) !== beforeDir) this.refresh();
			else this.clampSelection();
		}
		this.requestRender();
	}

	private get search(): string {
		return this.searchInput.getValue();
	}

	private set search(value: string) {
		setInputValueAtEnd(this.searchInput, value);
	}

	private deletePathSegmentBackward(): void {
		const before = this.search;
		const trimmed = before.replace(/\/+$/, "");
		const slash = trimmed.lastIndexOf("/");
		if (slash < 0) return;
		const next = trimmed.slice(0, slash + 1);
		if (next === before) return;
		this.search = next || "/";
		this.refresh();
		this.requestRender();
	}

	private refresh(): void {
		try {
			this.entries = readFileEntries(dirPrefix(this.search));
			this.selectedIndex = Math.max(
				0,
				Math.min(this.selectedIndex, Math.max(0, this.entries.length - 1)),
			);
			this.error = undefined;
			this.selectedIndex = Math.min(1, Math.max(0, this.entries.length - 1));
		} catch (error) {
			this.entries = [];
			this.selectedIndex = 0;
			this.error = error instanceof Error ? error.message : String(error);
		}
	}

	private header(width: number): string {
		const entries = this.filteredEntries();
		const total = Math.max(1, entries.length);
		const index = Math.min(this.selectedIndex + 1, total);
		const prefix = `${index}/${total}\tOpen session in folder: `;
		const input = renderInputChild(
			this.searchInput,
			Math.max(1, width - visibleWidth(prefix)),
		);
		return this.theme.fg("accent", fits(width, `${prefix}${input}`));
	}

	private border(width: number, color: "accent" | "dim" = "accent"): string {
		return this.theme.fg(color, "─".repeat(Math.max(0, width)));
	}

	private renderEntries(lines: string[], width: number): void {
		if (this.error) {
			lines.push(this.theme.fg("dim", indent(width, this.error)));
			this.padRows(lines, width, 1);
			return;
		}
		const entries = this.filteredEntries();
		if (entries.length === 0) {
			lines.push(
				this.theme.fg(
					"dim",
					indent(width, this.search ? "No matches." : "No entries."),
				),
			);
			this.padRows(lines, width, 1);
			return;
		}

		let rendered = 0;
		const start = this.visibleStart(entries.length);
		const end = Math.min(entries.length, start + FILE_EXPLORER_MAX_VISIBLE);
		for (let i = start; i < end; i++) {
			const entry = entries[i];
			if (!entry) continue;
			lines.push(
				this.entryLine(width, entry, {
					selected: i === this.selectedIndex,
				}),
			);
			rendered++;
		}
		this.padRows(lines, width, rendered);
	}

	private entryLine(
		width: number,
		entry: FileEntry,
		options: { selected: boolean },
	): string {
		if (entry.name === "./") return this.currentDirLine(width, options);
		const left = `${options.selected ? "›" : " "} ${entry.name}`;
		const timeW = 7;
		const meta = `${entry.size.padStart(5)}  ${relativeTime(entry.modified).padStart(timeW)}`;
		const metaWidth = Math.min(
			5 + 2 + timeW,
			Math.max(0, Math.floor(width * 0.38)),
		);
		const renderedMeta = fits(metaWidth, meta);
		const renderedLeft = fits(
			Math.max(0, width - visibleWidth(renderedMeta) - 1),
			left,
		);
		const gap = " ".repeat(
			Math.max(
				1,
				width - visibleWidth(renderedLeft) - visibleWidth(renderedMeta),
			),
		);
		let styledLeft = renderedLeft;
		if (!entry.isDirectory) styledLeft = this.theme.fg("dim", renderedLeft);
		else if (options.selected) styledLeft = this.theme.fg("accent", renderedLeft);
		return `${styledLeft}${gap}${this.theme.fg("dim", renderedMeta)}`;
	}

	private currentDirLine(
		width: number,
		options: { selected: boolean },
	): string {
		const marker = options.selected ? "›" : " ";
		const name = `${marker} ./`;
		const note = " (select current dir)";
		const availableNoteWidth = Math.max(0, width - visibleWidth(name));
		const renderedNote = fits(availableNoteWidth, note);
		const renderedName = fits(
			Math.max(0, width - visibleWidth(renderedNote)),
			name,
		);
		const padding = " ".repeat(
			Math.max(
				0,
				width - visibleWidth(renderedName) - visibleWidth(renderedNote),
			),
		);
		const styledName = options.selected
			? this.theme.fg("accent", renderedName)
			: renderedName;
		return `${styledName}${this.theme.fg("dim", renderedNote)}${padding}`;
	}

	private visibleStart(total: number): number {
		if (total <= FILE_EXPLORER_MAX_VISIBLE) return 0;
		const half = Math.floor(FILE_EXPLORER_MAX_VISIBLE / 2);
		return Math.min(
			Math.max(0, this.selectedIndex - half),
			total - FILE_EXPLORER_MAX_VISIBLE,
		);
	}

	private padRows(lines: string[], width: number, rendered: number): void {
		for (let i = rendered; i < FILE_EXPLORER_MAX_VISIBLE; i++) {
			lines.push(" ".repeat(Math.max(0, width)));
		}
	}

	private filteredEntries(): FileEntry[] {
		const query = this.search.trim().split("/").pop() ?? "";
		if (!query) return this.entries;
		return fuzzyFilter(this.entries, query, (entry) => entry.name);
	}

	private clampSelection(): void {
		const maxIndex = Math.max(0, this.filteredEntries().length - 1);
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, maxIndex));
	}

	private move(delta: number): void {
		const entries = this.filteredEntries();
		if (entries.length === 0) return;
		this.selectedIndex =
			(this.selectedIndex + delta + entries.length) % entries.length;
		this.requestRender();
	}

	private selected(): FileEntry | undefined {
		return this.filteredEntries()[this.selectedIndex];
	}

	private enterSelectedDirectory(): void {
		const entry = this.selected();
		if (!entry?.isDirectory) return;
		const next = normalizeExistingDir(entry.path) + "/";
		if (!next) return;
		this.search = next;
		this.refresh();
		this.requestRender();
	}

	private chooseSelectedDirectory(): void {
		const entry = this.selected();
		if (!entry?.isDirectory) return;
		const chosen = normalizeExistingDir(entry.path);
		if (chosen) this.done(chosen);
	}
}

export class ResumeSessionPicker implements Component, Focusable {
	private sessions: SavedSessionInfo[] = [];
	private selected = 0;
	private loading = true;
	private error: string | null = null;
	private readonly filterInput = new Input();

	constructor(
		private readonly theme: any,
		private readonly loadSessions: () => Promise<SavedSessionInfo[]>,
		private readonly onDone: (sessionPath: string | null) => void,
		private readonly requestRender: () => void,
	) {
		this.filterInput.focused = true;
		void this.refresh();
	}

	get focused(): boolean {
		return true;
	}

	set focused(_value: boolean) {}

	private async refresh(): Promise<void> {
		try {
			this.error = null;
			this.sessions = await this.loadSessions();
		} catch (error) {
			this.error = String(error);
		} finally {
			this.loading = false;
			this.clampSelection();
			this.requestRender();
		}
	}

	private filteredSessions(): SavedSessionInfo[] {
		const query = this.filterInput.getValue().trim();
		return fuzzyFilter(this.sessions, query, (session) =>
			[
				session.name,
				session.cwd,
				session.firstMessage,
				session.path,
				session.id,
			]
				.filter(Boolean)
				.join(" "),
		);
	}

	private visibleStart(total: number): number {
		if (total <= RESUME_MAX_VISIBLE) return 0;
		const half = Math.floor(RESUME_MAX_VISIBLE / 2);
		return Math.min(
			Math.max(0, this.selected - half),
			total - RESUME_MAX_VISIBLE,
		);
	}

	private padRows(
		lines: string[],
		width: number,
		rendered: number,
		totalItems: number,
	): void {
		const target = Math.min(Math.max(totalItems, rendered), RESUME_MAX_VISIBLE);
		for (let i = rendered; i < target; i++) {
			lines.push(" ".repeat(Math.max(0, width)));
		}
	}

	private clampSelection(): void {
		const max = Math.max(0, this.filteredSessions().length - 1);
		this.selected = Math.max(0, Math.min(this.selected, max));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.onDone(null);
			return;
		}
		if (matchesKey(data, "up") || isCtrl(data, "p")) {
			this.selected = Math.max(0, this.selected - 1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "down") || isCtrl(data, "n")) {
			this.selected = Math.min(
				Math.max(0, this.filteredSessions().length - 1),
				this.selected + 1,
			);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const session = this.filteredSessions()[this.selected];
			if (session?.path) this.onDone(session.path);
			return;
		}
		const before = this.filterInput.getValue();
		this.filterInput.handleInput(data);
		if (this.filterInput.getValue() !== before) this.selected = 0;
		this.clampSelection();
		this.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const border = (color: "accent" | "dim" = "accent") =>
			th.fg(color, "─".repeat(Math.max(0, width)));
		const accent = (s: string) => th.fg("accent", s);
		const dim = (s: string) => th.fg("dim", s);
		const muted = (s: string) => th.fg("muted", s);
		const error = (s: string) => th.fg("error", s);
		const lines: string[] = [];
		const visibleSessions = this.filteredSessions();
		const total = Math.max(1, visibleSessions.length);
		const index = Math.min(this.selected + 1, total);
		const prefix = `${index}/${total}\tResume: `;
		const renderedInput = renderInputChild(
			this.filterInput,
			width - visibleWidth(prefix),
		);

		lines.push(border());
		lines.push(accent(fits(width, `${prefix}${renderedInput}`)));
		lines.push(border("dim"));
		const startIdx = this.visibleStart(visibleSessions.length);
		const endIdx = Math.min(
			visibleSessions.length,
			startIdx + RESUME_MAX_VISIBLE,
		);
		let rendered = 0;
		if (this.error) {
			lines.push(padVisible(`  ${error("error")} ${this.error}`, width));
			rendered = 1;
		} else if (visibleSessions.length === 0) {
			lines.push(
				padVisible(
					`  ${dim(this.loading ? "Loading…" : "No saved sessions")}`,
					width,
				),
			);
			rendered = 1;
		} else {
			for (let i = startIdx; i < endIdx; i++) {
				const session = visibleSessions[i];
				if (!session) continue;
				const marker = i === this.selected ? "›" : " ";
				const title =
					session.name || session.firstMessage || session.id.slice(0, 8);
				const styledName =
					i === this.selected
						? accent(`${marker} ${title}`)
						: `${marker} ${title}`;

				const cwdText = session.cwd || "";
				const msgCountText = session.messageCount
					? String(session.messageCount)
					: "";
				const timeText = session.modified ? relativeTime(session.modified) : "";

				const rightParts = [];
				if (cwdText) rightParts.push(muted(cwdText));
				if (msgCountText && timeText)
					rightParts.push(dim(`${msgCountText} ${timeText}`));
				else if (msgCountText) rightParts.push(dim(msgCountText));
				else if (timeText) rightParts.push(dim(timeText));
				const rightText = rightParts.join("  ");
				const rightWidth = visibleWidth(rightText);

				const leftWidth = Math.max(10, width - rightWidth - 1);
				const left = truncateToWidth(styledName, leftWidth, "…");
				const gap = " ".repeat(
					Math.max(1, width - visibleWidth(left) - rightWidth),
				);
				let line = left + gap + rightText;
				if (i === this.selected) {
					line = th.bg("selectedBg", line);
				}
				lines.push(line);
				rendered++;
			}
		}
		this.padRows(lines, width, rendered, this.sessions.length);
		lines.push(border());
		lines.push(
			padVisible(
				dim("↑↓/<C-p>/<C-n>") +
					muted(" move · ") +
					dim("<enter>") +
					muted(" resume · ") +
					dim("<esc>") +
					muted(" back"),
				width,
			),
		);
		return lines;
	}

	invalidate(): void {
		this.filterInput.invalidate();
	}

	dispose(): void {}
}

