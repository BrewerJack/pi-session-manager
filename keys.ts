// Shortcut configuration and macOS keyboard support.
//
// Most macOS terminals turn Option+letter into a character (Option+S types "ß")
// instead of sending alt+letter. The manager then catches that character, but only
// while the macOS native helper of pi reports that the user holds Option.
import { readFileSync } from "node:fs";

export const DEFAULT_SHORTCUT = "alt+s";

/** What Option+letter types on the US and ABC layouts. The map skips the dead keys e, i, n, and u. */
const US_OPTION_CHARS: Readonly<Record<string, string>> = {
	a: "å",
	b: "∫",
	c: "ç",
	d: "∂",
	f: "ƒ",
	g: "©",
	h: "˙",
	j: "∆",
	k: "˚",
	l: "¬",
	m: "µ",
	o: "ø",
	p: "π",
	q: "œ",
	r: "®",
	s: "ß",
	t: "†",
	v: "√",
	w: "∑",
	x: "≈",
	y: "¥",
	z: "Ω",
};

export interface KeyConfig {
	shortcut: string;
	/** Characters that open the manager on macOS while Option is held. */
	macOptionChars: string[];
	warnings: string[];
}

const KEY_PATTERN =
	/^((ctrl|shift|alt|super)\+){0,3}([a-z0-9]|f([1-9]|1[0-2])|escape|enter|tab|space|backspace|delete|home|end|pageUp|pageDown|up|down|left|right|[`\-=[\]\\;',./])$/;

export function isValidShortcut(key: string): boolean {
	return KEY_PATTERN.test(key);
}

export function optionCharsFor(shortcut: string): string[] {
	const match = /^alt\+([a-z])$/.exec(shortcut);
	const letter = match?.[1];
	const char = letter ? US_OPTION_CHARS[letter] : undefined;
	return char ? [char] : [];
}

/**
 * Read the "sessionManager" key of the global pi settings, then the environment.
 * PI_SESSION_MANAGER_SHORTCUT wins over settings.json.
 */
export function loadKeyConfig(settingsPath: string, env: Record<string, string | undefined>): KeyConfig {
	const warnings: string[] = [];
	let fromFile: any = {};
	try {
		fromFile = JSON.parse(readFileSync(settingsPath, "utf8"))?.sessionManager ?? {};
	} catch {
		// A missing or broken settings file leaves the defaults in place.
		fromFile = {};
	}
	let shortcut = DEFAULT_SHORTCUT;
	const requested = env.PI_SESSION_MANAGER_SHORTCUT?.trim() || fromFile.shortcut;
	if (typeof requested === "string" && requested) {
		if (isValidShortcut(requested)) shortcut = requested;
		else warnings.push(`pi-session-manager: "${requested}" is not a valid shortcut. Using ${DEFAULT_SHORTCUT}.`);
	}
	let macOptionChars = optionCharsFor(shortcut);
	if (Array.isArray(fromFile.macOptionChars)) {
		macOptionChars = fromFile.macOptionChars.filter((c: unknown): c is string => typeof c === "string" && c.length > 0);
	} else if (fromFile.macOptionChars === false) {
		macOptionChars = [];
	}
	return { shortcut, macOptionChars, warnings };
}

export type ModifierProbe = (name: "option" | "command" | "control" | "shift") => boolean;

/** True when the input is one of the Option characters and the user holds Option but not Command or Control. */
export function isMacOptionShortcut(data: string, chars: readonly string[], pressed: ModifierProbe): boolean {
	if (!chars.includes(data)) return false;
	return pressed("option") && !pressed("command") && !pressed("control");
}

/** Show keys the way the platform writes them, for example "⌥S" on macOS. */
export function displayKey(key: string, platform: string): string {
	if (platform !== "darwin") return key;
	const symbols: Record<string, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", super: "⌘" };
	const parts = key.split("+");
	const base = parts.pop() ?? "";
	const order = ["ctrl", "alt", "shift", "super"];
	const mods = parts.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((m) => symbols[m] ?? m);
	return mods.join("") + (base.length === 1 ? base.toUpperCase() : base);
}

/** The part of pi's macOS native helper that the modifier probe needs. */
interface NativeHelper {
	isModifierPressed?: (name: string) => unknown;
}

/**
 * pi's macOS native helper as a modifier probe. Undefined off macOS, or when pi runs without
 * the helper, for example over SSH. `getHelper` is getNativeClipboard of pi-tui.
 */
export function macModifierProbe(getHelper: () => unknown, platform = process.platform): ModifierProbe | undefined {
	if (platform !== "darwin") return undefined;
	let helper: NativeHelper | undefined;
	try {
		helper = getHelper() as NativeHelper | undefined;
	} catch {
		return undefined;
	}
	const probe = helper?.isModifierPressed;
	if (typeof probe !== "function") return undefined;
	return (name) => {
		try {
			return probe.call(helper, name) === true;
		} catch {
			return false;
		}
	};
}

/**
 * A worker has no keyboard, so the client handles the macOS key (spec §11). The client turns
 * the Option character into the alt+letter shortcut. Undefined when nothing needs a translation.
 *
 * The client sends the Kitty form, CSI <codepoint>;3u. A worker that uses the Kitty keyboard
 * protocol, as pi does in Ghostty, kitty, WezTerm, and iTerm2, ignores the legacy form ESC <letter>.
 * pi-tui reads the Kitty form in both modes.
 */
export function macOptionTranslator(config: KeyConfig, pressed: ModifierProbe | undefined): ((data: string) => string) | undefined {
	const letter = /^alt\+([a-z])$/.exec(config.shortcut)?.[1];
	if (!pressed || !letter || !config.macOptionChars.length) return undefined;
	const sequence = `\x1b[${letter.charCodeAt(0)};3u`;
	return (data) => (isMacOptionShortcut(data, config.macOptionChars, pressed) ? sequence : data);
}

