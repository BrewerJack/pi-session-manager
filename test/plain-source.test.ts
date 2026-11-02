import assert from "node:assert/strict";
import { test } from "node:test";
import { PLAIN_ID, PlainSource, type PlainSession } from "../plain-source.ts";
import type { Row, SessionSource } from "../remote-source.ts";

function inner(rows: Row[]): SessionSource & { calls: string[]; fire: () => void } {
	const calls: string[] = [];
	const listeners = new Set<() => void>();
	return {
		calls,
		fire: () => listeners.forEach((l) => l()),
		problem: undefined,
		list: () => rows,
		get: (id) => rows.find((r) => r.id === id || r.name === id),
		subscribe: (l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		transcript: () => [{ kind: "user", text: "remote" }],
		ensureConnected: async () => void calls.push("connect"),
		create: async () => rows[0]!,
		send: async (id) => void calls.push(`send ${id}`),
		interrupt: async (id) => void calls.push(`interrupt ${id}`),
		rename: async (id) => void calls.push(`rename ${id}`),
		stop: async (id) => void calls.push(`stop ${id}`),
		pin: async (id) => void calls.push(`pin ${id}`),
		attach: async (id) => ({ id, socket: "s" }),
	};
}

const entries = [
	{ type: "message", timestamp: "2026-11-01T10:00:00.000Z", message: { role: "user", content: "fix the tests" } },
	{
		type: "message",
		timestamp: "2026-11-01T10:01:00.000Z",
		message: { role: "assistant", content: [{ type: "text", text: "Done." }], usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } } },
	},
];

function session(over: Partial<PlainSession> = {}): PlainSession & { log: string[] } {
	const log: string[] = [];
	let busy = false;
	return {
		log,
		cwd: () => "/work/app",
		entries: () => entries,
		branch: () => entries,
		sessionFile: () => "/sessions/a.jsonl",
		sessionId: () => "a",
		name: () => undefined,
		modelLabel: () => "claude · high",
		contextPercent: () => 12,
		busy: () => busy,
		send: (text, isBusy) => void log.push(`send ${text} ${isBusy}`),
		rename: (name) => void log.push(`rename ${name}`),
		interrupt: () => {
			busy = false;
			log.push("interrupt");
		},
		...over,
	};
}

test("the plain row comes first and is the current session", () => {
	const remote = inner([{ id: "s1", cwd: "/x", state: "idle", pinned: false, createdAt: 1, lastActivityAt: 1, piDir: "/p" }]);
	const plain = new PlainSource(remote, "/pi");
	assert.deepEqual(plain.list().map((r) => r.id), ["s1"]);
	plain.bind(session());
	const rows = plain.list();
	assert.deepEqual(rows.map((r) => r.id), [PLAIN_ID, "s1"]);
	assert.equal(plain.currentId, PLAIN_ID);
	const own = rows[0]!;
	assert.equal(own.plain, true);
	assert.equal(own.firstPrompt, "fix the tests");
	assert.equal(own.lastReply, "Done.");
	assert.equal(own.modelLabel, "claude · high");
	assert.equal(own.usage?.input, 100);
	assert.equal(own.usage?.cost, 0.5);
	assert.equal(own.usage?.contextPercent, 12);
	assert.equal(own.lastActivityAt, Date.parse("2026-11-01T10:01:00.000Z"));
	plain.bind(undefined);
	assert.deepEqual(plain.list().map((r) => r.id), ["s1"]);
});

test("actions on the plain row go to pi, and the rest go to the supervisor", async () => {
	const remote = inner([{ id: "s1", name: "other", cwd: "/x", state: "idle", pinned: false, createdAt: 1, lastActivityAt: 1, piDir: "/p" }]);
	const plain = new PlainSource(remote, "/pi");
	const s = session({ name: () => "mine" });
	plain.bind(s);
	await plain.send(PLAIN_ID, "hello");
	await plain.rename(PLAIN_ID, "new");
	await plain.interrupt(PLAIN_ID);
	await plain.send("s1", "hi");
	await plain.stop("s1");
	assert.deepEqual(s.log, ["send hello false", "rename new", "interrupt"]);
	assert.deepEqual(remote.calls, ["send s1", "stop s1"]);
	await assert.rejects(plain.stop(PLAIN_ID), /Use \/quit to end it/);
	await assert.rejects(plain.pin(PLAIN_ID, true), /Only background sessions take a pin/);
	await assert.rejects(plain.attach(PLAIN_ID), /already shows/);
	assert.equal(plain.get("mine")?.id, PLAIN_ID);
	assert.equal(plain.get("other")?.id, "s1");
	assert.equal(plain.transcript(PLAIN_ID)?.[0]?.text, "fix the tests");
	assert.equal(plain.transcript("s1")?.[0]?.text, "remote");
});

test("subscribers hear changes of pi and of the supervisor, and the row is rebuilt", () => {
	const remote = inner([]);
	const plain = new PlainSource(remote, "/pi");
	let busy = false;
	plain.bind(session({ busy: () => busy }));
	let heard = 0;
	const stop = plain.subscribe(() => heard++);
	assert.equal(plain.row()?.state, "idle");
	busy = true;
	assert.equal(plain.row()?.state, "idle", "the row stays cached until pi reports a change");
	plain.changed();
	assert.equal(plain.row()?.state, "working");
	remote.fire();
	assert.equal(heard, 2);
	stop();
	plain.changed();
	remote.fire();
	assert.equal(heard, 2);
});

test("a broken pi context does not break the list", () => {
	const plain = new PlainSource(inner([]), "/pi");
	const fail = () => {
		throw new Error("stale");
	};
	plain.bind(session({ entries: fail, branch: fail, modelLabel: fail, contextPercent: fail, busy: fail }));
	const own = plain.list()[0]!;
	assert.equal(own.id, PLAIN_ID);
	assert.equal(own.state, "idle");
	assert.equal(own.firstPrompt, undefined);
});
