// SocketTerminal is the Terminal of a worker. It draws to the client that holds the
// session, and drops output while no client holds it. The keyboard protocol logic follows ProcessTerminal
// of pi-tui, which talks to process.stdin and process.stdout only.
import type { ProgramStatus, StdinBuffer, Terminal } from "@earendil-works/pi-tui";
import type { TerminalSize } from "./protocol.ts";

/** The pi-tui values that SocketTerminal needs. The worker passes the copies that pi loaded. */
export interface TuiDeps {
	StdinBuffer: typeof StdinBuffer;
	setKittyProtocolActive: (active: boolean) => void;
}

const KITTY_FLAGS = 7;
const KITTY_QUERY = `\x1b[>${KITTY_FLAGS}u\x1b[?u`;
const KITTY_POP = "\x1b[<u";
const DEVICE_ATTRIBUTES_QUERY = "\x1b[c";
const MODIFY_OTHER_KEYS_ON = "\x1b[>4;2m";
const MODIFY_OTHER_KEYS_OFF = "\x1b[>4;0m";
const BRACKETED_PASTE_ON = "\x1b[?2004h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";
const PROGRESS_ON = "\x1b]9;4;3\x07";
const PROGRESS_OFF = "\x1b]9;4;0\x07";
const PROGRESS_KEEPALIVE_MS = 1000;
const ESCAPE_TIMEOUT_MS = 30;

type Negotiation = { type: "kitty-flags"; flags: number } | { type: "device-attributes" };

export function parseNegotiation(sequence: string): Negotiation | undefined {
	const kitty = sequence.match(/^\x1b\[\?(\d+)u$/);
	if (kitty) return { type: "kitty-flags", flags: Number.parseInt(kitty[1] ?? "0", 10) };
	if (/^\x1b\[\?[\d;]*c$/.test(sequence)) return { type: "device-attributes" };
	return undefined;
}

export class SocketTerminal implements Terminal {
	private sink?: (data: string) => void;
	private size: TerminalSize = { columns: 80, rows: 24 };
	private onInput?: (data: string) => void;
	private onResize?: () => void;
	private buffer?: StdinBuffer;
	private kittyActive = false;
	private modifyOtherKeys = false;
	private kittyPushed = false;
	/** Device-attribute replies owed to our keyboard queries. Later ones belong to other queries. */
	private owedDeviceAttributes = 0;
	private title?: string;
	private progress = false;
	private progressTimer?: ReturnType<typeof setInterval>;

	private readonly deps: TuiDeps;

	constructor(deps: TuiDeps) {
		this.deps = deps;
	}

	// --- Connection -----------------------------------------------------

	get attached(): boolean {
		return this.sink !== undefined;
	}

	/** Route output to a client. Call before TUI.start(), so start() negotiates with it. */
	attach(sink: (data: string) => void, size: TerminalSize): void {
		this.sink = sink;
		this.size = { ...size };
		if (this.title) this.send(`\x1b]0;${this.title}\x07`);
	}

	/** Drop the client. Call after TUI.stop(), so stop() restores the client terminal first. */
	detach(): void {
		this.sink = undefined;
		this.resetKeyboardState();
	}

	/** Bytes that the client typed. */
	input(data: string): void {
		this.buffer?.process(data);
	}

	resize(size: TerminalSize): void {
		this.size = { ...size };
		this.onResize?.();
	}

	// --- Terminal -------------------------------------------------------

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.onInput = onInput;
		this.onResize = onResize;
		this.buffer?.destroy();
		this.buffer = new this.deps.StdinBuffer({ escapeTimeout: ESCAPE_TIMEOUT_MS });
		this.buffer.on("data", (sequence: string) => this.handleSequence(sequence));
		this.buffer.on("paste", (content: string) => this.onInput?.(`\x1b[200~${content}\x1b[201~`));
		if (!this.attached) return;
		this.send(BRACKETED_PASTE_ON);
		this.kittyPushed = true;
		this.owedDeviceAttributes++;
		this.send(KITTY_QUERY + DEVICE_ATTRIBUTES_QUERY);
		if (this.progress) this.startProgress();
	}

	stop(): void {
		if (this.stopProgress()) this.send(PROGRESS_OFF);
		this.send(BRACKETED_PASTE_OFF);
		if (this.kittyPushed || this.kittyActive) this.send(KITTY_POP);
		if (this.modifyOtherKeys) this.send(MODIFY_OTHER_KEYS_OFF);
		this.resetKeyboardState();
		this.buffer?.destroy();
		this.buffer = undefined;
		this.onInput = undefined;
		this.onResize = undefined;
	}

	async drainInput(): Promise<void> {
		// Key releases can not leak into a parent shell. The client owns the real terminal.
	}

	write(data: string): void {
		this.send(data);
	}

	get columns(): number {
		return this.size.columns;
	}

	get rows(): number {
		return this.size.rows;
	}

	get kittyProtocolActive(): boolean {
		return this.kittyActive;
	}

	get modifyOtherKeysActive(): boolean {
		return this.modifyOtherKeys;
	}

	moveBy(lines: number): void {
		if (lines > 0) this.send(`\x1b[${lines}B`);
		else if (lines < 0) this.send(`\x1b[${-lines}A`);
	}

	hideCursor(): void {
		this.send("\x1b[?25l");
	}

	showCursor(): void {
		this.send("\x1b[?25h");
	}

	clearLine(): void {
		this.send("\x1b[K");
	}

	clearFromCursor(): void {
		this.send("\x1b[J");
	}

	clearScreen(): void {
		this.send("\x1b[2J\x1b[H");
	}

	setTitle(title: string): void {
		this.title = title;
		this.send(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		this.progress = active;
		if (active) this.startProgress();
		else if (this.stopProgress()) this.send(PROGRESS_OFF);
	}

	setProgramStatus(_status: ProgramStatus): void {
		// OSC 7501 needs a support query per terminal. Detached sessions skip it for now.
	}

	// --- Internals ------------------------------------------------------

	private send(data: string): void {
		if (data) this.sink?.(data);
	}

	private handleSequence(sequence: string): void {
		const negotiation = parseNegotiation(sequence);
		if (negotiation && this.handleNegotiation(negotiation)) return;
		this.onInput?.(sequence);
	}

	/** Returns true when the sequence answered one of our queries. */
	private handleNegotiation(negotiation: Negotiation): boolean {
		if (negotiation.type === "kitty-flags") {
			if (negotiation.flags !== 0) {
				this.setModifyOtherKeys(false);
				this.kittyActive = true;
				this.deps.setKittyProtocolActive(true);
			} else {
				this.setModifyOtherKeys(true);
			}
			return true;
		}
		if (this.owedDeviceAttributes === 0) return false;
		this.owedDeviceAttributes--;
		// Device attributes before a Kitty reply: the terminal does not know the Kitty protocol.
		if (!this.kittyActive) this.setModifyOtherKeys(true);
		return true;
	}

	private setModifyOtherKeys(on: boolean): void {
		if (on === this.modifyOtherKeys || (on && this.kittyActive)) return;
		this.send(on ? MODIFY_OTHER_KEYS_ON : MODIFY_OTHER_KEYS_OFF);
		this.modifyOtherKeys = on;
	}

	private resetKeyboardState(): void {
		if (this.kittyActive) this.deps.setKittyProtocolActive(false);
		this.kittyActive = false;
		this.kittyPushed = false;
		this.modifyOtherKeys = false;
		this.owedDeviceAttributes = 0;
	}

	private startProgress(): void {
		if (!this.attached || this.progressTimer) return;
		this.send(PROGRESS_ON);
		this.progressTimer = setInterval(() => this.send(PROGRESS_ON), PROGRESS_KEEPALIVE_MS);
		this.progressTimer.unref?.();
	}

	/** Returns true when a progress indicator was on. */
	private stopProgress(): boolean {
		if (!this.progressTimer) return false;
		clearInterval(this.progressTimer);
		this.progressTimer = undefined;
		return true;
	}
}
