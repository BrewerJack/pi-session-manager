import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
	DEFAULT_SHORTCUT,
	displayKey,
	isMacOptionShortcut,
	isValidShortcut,
	loadKeyConfig,
	optionCharsFor,
	type ModifierProbe,
} from "../keys.ts";

const created: string[] = [];
after(() => {
	for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function settingsFile(content: unknown): string {
	const dir = mkdtempSync(path.join(tmpdir(), "psm-keys-"));
	created.push(dir);
	const file = path.join(dir, "settings.json");
	writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
	return file;
}

const held =
	(...names: string[]): ModifierProbe =>
	(name) =>
		names.includes(name);

test("the default shortcut is alt+s, and Option+S types ß on US layouts", () => {
	const config = loadKeyConfig("/nonexistent/settings.json", {});
	assert.equal(config.shortcut, DEFAULT_SHORTCUT);
	assert.deepEqual(config.macOptionChars, ["ß"]);
	assert.deepEqual(config.warnings, []);
});

test("settings.json can change the shortcut and the Option characters follow it", () => {
	const config = loadKeyConfig(settingsFile({ sessionManager: { shortcut: "alt+m" } }), {});
	assert.equal(config.shortcut, "alt+m");
	assert.deepEqual(config.macOptionChars, ["µ"]);
});

test("the environment variable wins over settings.json", () => {
	const file = settingsFile({ sessionManager: { shortcut: "alt+m" } });
	const config = loadKeyConfig(file, { PI_SESSION_MANAGER_SHORTCUT: "ctrl+alt+s" });
	assert.equal(config.shortcut, "ctrl+alt+s");
	assert.deepEqual(config.macOptionChars, []);
});

test("custom Option characters cover other keyboard layouts, and false turns the fallback off", () => {
	const german = loadKeyConfig(settingsFile({ sessionManager: { macOptionChars: ["‚"] } }), {});
	assert.deepEqual(german.macOptionChars, ["‚"]);
	const off = loadKeyConfig(settingsFile({ sessionManager: { macOptionChars: false } }), {});
	assert.deepEqual(off.macOptionChars, []);
});

test("an invalid shortcut falls back to the default with a warning", () => {
	const config = loadKeyConfig(settingsFile({ sessionManager: { shortcut: "hyper+?" } }), {});
	assert.equal(config.shortcut, DEFAULT_SHORTCUT);
	assert.equal(config.warnings.length, 1);
});

test("a broken settings file leaves the defaults in place", () => {
	const config = loadKeyConfig(settingsFile("{ not json"), {});
	assert.equal(config.shortcut, DEFAULT_SHORTCUT);
});

test("shortcut validation accepts pi key ids and rejects others", () => {
	for (const key of ["alt+s", "ctrl+alt+s", "f2", "shift+tab", "alt+pageUp", "alt+/"]) assert.ok(isValidShortcut(key), key);
	for (const key of ["", "alt+", "meta+s", "alt+ss", "s+alt"]) assert.ok(!isValidShortcut(key), key);
});

test("Option characters only exist for alt+letter shortcuts without dead keys", () => {
	assert.deepEqual(optionCharsFor("alt+s"), ["ß"]);
	assert.deepEqual(optionCharsFor("alt+e"), []);
	assert.deepEqual(optionCharsFor("ctrl+s"), []);
});

test("ß opens the manager only while Option is held without Command or Control", () => {
	const chars = ["ß"];
	assert.ok(isMacOptionShortcut("ß", chars, held("option")));
	assert.ok(isMacOptionShortcut("ß", chars, held("option", "shift")));
	assert.ok(!isMacOptionShortcut("ß", chars, held()), "a German ß key without Option types normally");
	assert.ok(!isMacOptionShortcut("ß", chars, held("option", "command")));
	assert.ok(!isMacOptionShortcut("ß", chars, held("option", "control")));
	assert.ok(!isMacOptionShortcut("s", chars, held("option")));
	assert.ok(!isMacOptionShortcut("ßß", chars, held("option")), "pasted text never matches");
});

test("macOS shows modifier symbols, other platforms keep the key id", () => {
	assert.equal(displayKey("alt+s", "darwin"), "⌥S");
	assert.equal(displayKey("shift+ctrl+f2", "darwin"), "⌃⇧f2");
	assert.equal(displayKey("alt+s", "linux"), "alt+s");
	assert.equal(displayKey("alt+s", "win32"), "alt+s");
});

test("pi-tui reads the translated key as alt+s with and without the Kitty protocol", async () => {
	const { loadKeyConfig: load, macOptionTranslator } = await import("../keys.ts");
	const { matchesKey, setKittyProtocolActive } = await import("@earendil-works/pi-tui");
	const sent = macOptionTranslator(load("/nonexistent/settings.json", {}), (name) => name === "option")!("ß");
	assert.equal(sent, "\x1b[115;3u");
	try {
		for (const kitty of [false, true]) {
			setKittyProtocolActive(kitty);
			assert.equal(matchesKey(sent, "alt+s"), true, `kitty ${kitty}`);
		}
		// The legacy form fails in a worker with the Kitty protocol. This was the bug of 0.4.1.
		assert.equal(matchesKey("\x1bs", "alt+s"), false);
	} finally {
		setKittyProtocolActive(false);
	}
});

test("a client turns the macOS Option character into the alt shortcut while Option is held", async () => {
	const { loadKeyConfig: load, macOptionTranslator, macModifierProbe } = await import("../keys.ts");
	const config = load("/nonexistent/settings.json", {});
	let option = true;
	const translate = macOptionTranslator(config, (name) => name === "option" && option);
	assert.ok(translate);
	assert.equal(translate!("ß"), "\x1b[115;3u");
	assert.equal(translate!("ßß"), "ßß");
	assert.equal(translate!("a"), "a");
	option = false;
	assert.equal(translate!("ß"), "ß");
	// Without a probe, or with a shortcut other than alt+letter, nothing changes.
	assert.equal(macOptionTranslator(config, undefined), undefined);
	assert.equal(macOptionTranslator(load("/nonexistent", { PI_SESSION_MANAGER_SHORTCUT: "ctrl+alt+s" }), () => true), undefined);
	// The probe exists on macOS only, and only with the native helper of pi.
	assert.equal(macModifierProbe(() => ({ isModifierPressed: () => true }), "linux"), undefined);
	assert.equal(macModifierProbe(() => ({}), "darwin"), undefined);
	const probe = macModifierProbe(() => ({ isModifierPressed: (name: string) => name === "option" }), "darwin");
	assert.equal(probe?.("option"), true);
	assert.equal(probe?.("command"), false);
});
