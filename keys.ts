// Shortcut configuration and macOS keyboard support.
//
// Most macOS terminals turn Option+letter into a character (Option+S types "ß")
// instead of sending alt+letter. The manager then catches that character, but only
// while the macOS native helper of pi reports that the user holds Option.
import { readFileSync } from "node:fs";

export const DEFAULT_SHORTCUT = "alt+s";

/** What Option+letter types on the US and ABC layouts. The map skips the dead keys e, i, n, and u. */
export const US_OPTION_CHARS: Readonly<Record<string, string>> = {
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
	const char = match ? US_OPTION_CHARS[match[1]!] : undefined;
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
