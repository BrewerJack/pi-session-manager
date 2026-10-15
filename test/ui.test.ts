import assert from "node:assert/strict";
import { test } from "node:test";
import type { Row, SessionSource } from "../remote-source.ts";
import { ManagerView, StatusBar, type ManagerResult } from "../ui.ts";

const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };
const tui = { requestRender: () => {}, terminal: { rows: 40 } };

function row(id: string, fields: Partial<Row> = {}): Row {
	return { id, cwd: "/tmp", state: "idle", pinned: false, createdAt: Number(id.replace(/\D/g, "")) || 1, lastActivityAt: Date.now(), piDir: "/x", ...fields };
}

function source(rows: Row[], currentId?: string): SessionSource {
	return {
		currentId,
		list: () => rows,
		get: (id) => rows.find((r) => r.id === id),
		subscribe: () => () => {},
		transcript: () => [],
		ensureConnected: async () => {},
		create: async () => rows[0]!,
		send: async () => {},
		interrupt: async () => {},
		rename: async () => {},
		stop: async () => {},
		pin: async () => {},
		attach: async (id) => ({ id, socket: "" }),
	};
}

function view(rows: Row[], currentId?: string) {
	let result: ManagerResult | "open" = "open";
	const manager = new ManagerView({ tui, theme, source: source(rows, currentId), cwd: "/tmp", done: (r) => (result = r) });
	return { manager, result: () => result };
}

test("the manager lists sessions with status and starts on one that needs input", () => {
	const rows = [
		row("s1", { name: "first", lastOutcome: "done" }),
		row("s2", { name: "asks", state: "waiting", promptTitle: "Allow?" }),
		row("s3", { name: "asleep", state: "saved" }),
	];
	const { manager, result } = view(rows, "s1");
	const text = manager.render(100).join("\n");
	assert.match(text, /first \(this session\)/);
	assert.match(text, /needs input · Allow\?/);
	assert.match(text, /saved · ⏎ starts it/);
	manager.handleInput("\r");
	assert.deepEqual(result(), { type: "open", id: "s2" });
	manager.dispose();
});

test("enter on the current session only closes the manager", () => {
	const { manager, result } = view([row("s1", { name: "only" })], "s1");
	manager.handleInput("\r");
	assert.equal(result(), undefined);
	manager.dispose();
});

test("an empty list says how to start a session", () => {
	const { manager } = view([]);
	assert.match(manager.render(80).join("\n"), /No sessions\. Press n to start one\./);
	manager.dispose();
});

test("the status bar shows other live sessions and hides saved ones", () => {
	const rows = [row("s1", { name: "me" }), row("s2", { name: "other" }), row("s3", { name: "asleep", state: "saved" })];
	const bar = new StatusBar(source(rows, "s1"), theme, () => {}, "alt+s");
	const line = bar.render(100).join("");
	assert.match(line, /me/);
	assert.match(line, /other/);
	assert.doesNotMatch(line, /asleep/);
	assert.deepEqual(new StatusBar(source([rows[0]!], "s1"), theme, () => {}, "alt+s").render(100), []);
	bar.dispose();
});
