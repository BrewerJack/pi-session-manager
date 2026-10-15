// End to end: a real supervisor and real pi workers in a throwaway agent dir (spec §12).
// The tests skip when no pi is on PATH. No test sends a message, so no model runs.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error boot.mjs is plain JavaScript without types.
import { findPiDir } from "../boot.mjs";
import { attach, type AttachResult } from "../client.ts";
import type { SessionRecord } from "../control.ts";
import { statePaths, type StatePaths } from "../paths.ts";
import { nameOf, readSessionFile } from "../session-file.ts";
import { isAlive, Supervisor, type StartWorker } from "../supervisor.ts";
import { connectSupervisor, type SupervisorHandle } from "../supervisor-client.ts";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let piDir: string | undefined;
try {
	piDir = findPiDir();
} catch {
	piDir = undefined;
}
const skip = piDir ? false : "no pi on PATH";

let agentDir: string;
let paths: StatePaths;
let handle: SupervisorHandle;

before(async () => {
	if (!piDir) return;
	agentDir = mkdtempSync(path.join(tmpdir(), "pism-e2e-"));
	// Workers load this package as an extension. The agent dir has no login, so no model can run.
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [ROOT] }));
	// The supervisor and its workers inherit this, so they never touch the real agent dir.
	process.env.PI_CODING_AGENT_DIR = agentDir;
	paths = statePaths(agentDir);
	handle = await connectSupervisor(paths, { piDir, root: ROOT, version: "e2e" });
});

after(async () => {
	if (!piDir) return;
	await handle.connection.request({ type: "shutdown", keepWorkers: false }, 60_000).catch(() => {});
	handle.connection.close();
	rmSync(agentDir, { recursive: true, force: true });
});

async function create(name: string, extra: Record<string, unknown> = {}): Promise<SessionRecord> {
	const request = { cwd: agentDir, name, env: {}, piDir, ...extra };
	const { record } = await handle.connection.request<{ record: SessionRecord }>({ type: "create", request }, 60_000);
	return record;
}

async function socketOf(id: string): Promise<string> {
	const { socket } = await handle.connection.request<{ socket: string }>({ type: "attach", session: id }, 60_000);
	return socket;
}

/** A client with a fake terminal. Its screen is the plain text of everything the worker drew. */
function client(socket: string) {
	const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode: () => input });
	const output = Object.assign(new PassThrough(), { columns: 100, rows: 30 });
	let raw = "";
	output.on("data", (chunk: Buffer) => {
		raw += chunk.toString("utf8");
	});
	const controller = new AbortController();
	const done: Promise<AttachResult> = attach(socket, {
		input: input as unknown as NodeJS.ReadStream,
		output: output as unknown as NodeJS.WriteStream,
		signal: controller.signal,
	});
	return {
		done,
		type: (data: string) => input.write(data),
		screen: () => raw.replace(/\x1b\[[0-9;?<>=]*[a-zA-Z~]|\x1b\][^\x07]*\x07|\x1b_[^\x1b]*\x1b\\/g, ""),
		raw: () => raw,
		close: () => controller.abort(),
	};
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 15_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

test("a session survives its client and redraws for the next one", { skip }, async () => {
	const record = await create("survivor");
	const first = client(await socketOf(record.id));
	await until(() => first.screen().includes("survivor"), "the first screen");
	first.type("hello from the first client");
	await until(() => first.screen().includes("hello from the first client"), "the typed text");
	// A closed terminal: the connection drops without a detach.
	first.close();
	assert.equal((await first.done).kind, "closed");
	assert.ok(isAlive(record.pid!));

	const second = client(await socketOf(record.id));
	await until(() => second.screen().includes("hello from the first client"), "the redraw with the editor text");
	// ctrl+c clears the editor, a second ctrl+c within 500 ms is the quit key. It only detaches.
	second.type("\x03");
	second.type("\x03");
	const result = await second.done;
	assert.deepEqual(result, { kind: "detached", detached: { reason: "quit" } });
	// The client gets its terminal back: bracketed paste off and the Kitty pop.
	assert.ok(second.raw().includes("\x1b[?2004l"));
	assert.ok(isAlive(record.pid!));
});

test("a second client takes the session over", { skip }, async () => {
	const record = await create("contested");
	const socket = await socketOf(record.id);
	const first = client(socket);
	await until(() => first.screen().includes("contested"), "the first screen");
	const second = client(socket);
	assert.deepEqual(await first.done, { kind: "detached", detached: { reason: "taken" } });
	await until(() => second.screen().includes("contested"), "the second screen");
	second.type("\x04");
	assert.deepEqual(await second.done, { kind: "detached", detached: { reason: "quit" } });
});

test("a stop detaches the client with the reason", { skip }, async () => {
	const record = await create("stopped");
	const viewer = client(await socketOf(record.id));
	await until(() => viewer.screen().includes("stopped"), "the screen");
	await handle.connection.request({ type: "stop", session: record.id }, 30_000);
	const result = await viewer.done;
	assert.equal(result.kind, "detached");
	assert.equal(result.kind === "detached" && result.detached.reason, "stopped");
	await until(() => !isAlive(record.pid!), "the worker exit");
});

test("a worker ignores SIGHUP", { skip }, async () => {
	const record = await create("hangup");
	process.kill(record.pid!, "SIGHUP");
	await new Promise((resolve) => setTimeout(resolve, 1000));
	assert.ok(isAlive(record.pid!));
	const viewer = client(await socketOf(record.id));
	await until(() => viewer.screen().includes("hangup"), "the screen after SIGHUP");
	viewer.type("\x04");
	assert.equal((await viewer.done).kind, "detached");
});

test("/sessions detach leaves the session running", { skip }, async () => {
	const record = await create("commands");
	const viewer = client(await socketOf(record.id));
	await until(() => viewer.screen().includes("commands"), "the screen");
	viewer.type("/sessions detach");
	await new Promise((resolve) => setTimeout(resolve, 300));
	// The first enter takes the completion, the second runs the command.
	viewer.type("\r");
	await new Promise((resolve) => setTimeout(resolve, 300));
	viewer.type("\r");
	const result = await Promise.race([
		viewer.done,
		new Promise<AttachResult>((resolve) => setTimeout(() => resolve({ kind: "error", message: viewer.screen().slice(-800) }), 8000)),
	]);
	assert.deepEqual(result, { kind: "detached", detached: { reason: "quit" } });
	assert.ok(isAlive(record.pid!));
});

test("a worker reports its conversation and answers transcript, stats, and rename", { skip }, async () => {
	// pi moves *.jsonl files out of the root of the agent dir. Keep the file in a folder.
	const file = path.join(agentDir, "work", "conversation.jsonl");
	mkdirSync(path.dirname(file), { recursive: true });
	copyFileSync(path.join(ROOT, "test", "fixtures", "conversation.jsonl"), file);
	const record = await create("ignored", { sessionFile: file });
	// The file names the session. The worker keeps that name.
	assert.equal(record.name, "fixture");
	assert.equal(record.lastPrompt, "Count the files in this folder.");
	assert.equal(record.lastReply, "The folder holds 7 files.");
	assert.equal(record.usage?.cost, 0.75);
	const { items } = await handle.connection.request<{ items: { kind: string }[] }>({ type: "transcript", session: record.id });
	assert.deepEqual(
		items.map((i) => i.kind),
		["user", "assistant", "tool", "assistant"],
	);
	const { usage } = await handle.connection.request<{ usage: { toolCalls: number } }>({ type: "stats", session: record.id });
	assert.equal(usage.toolCalls, 1);
	await handle.connection.request({ type: "rename", session: record.id, name: "renamed live" });
	assert.equal(nameOf(readSessionFile(file).entries), "renamed live");
	await handle.connection.request({ type: "stop", session: record.id }, 30_000);
});

test("the manager in a worker sends its client to another session", { skip }, async () => {
	const here = await create("switch-from");
	const there = await create("switch-to");
	const viewer = client(await socketOf(here.id));
	await until(() => viewer.screen().includes("switch-from"), "the screen");
	// alt+s opens the overlay. It starts on the first session that is not this one.
	viewer.type("\x1bs");
	await until(() => viewer.screen().includes("(this session)"), "the overlay");
	const others = (await handle.connection.request<{ sessions: SessionRecord[] }>({ type: "list" })).sessions;
	const first = others.find((r) => r.id !== here.id)!;
	viewer.type("\r");
	assert.deepEqual(await viewer.done, { kind: "switch", id: first.id });
	assert.ok(isAlive(there.pid!));
});

test("a newer client restarts an older supervisor and keeps its workers", { skip }, async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pism-upgrade-"));
	const otherPaths = statePaths(dir);
	const fakeWorker = path.join(ROOT, "test", "fixtures", "fake-worker.mjs");
	const old = new Supervisor({
		paths: otherPaths,
		version: "0.0.1",
		bootFile: "unused",
		log: () => {},
		idleMs: 0,
		spawnWorker: ({ record }: StartWorker) => {
			const args = [fakeWorker, otherPaths.supervisorSocket, record.id, record.sessionFile ?? ""].filter(Boolean);
			const child = spawn(process.execPath, args, { stdio: "ignore", detached: true });
			child.unref();
			return child;
		},
	});
	assert.equal(await old.start(), true);
	const file = path.join(dir, "work.jsonl");
	writeFileSync(file, `${JSON.stringify({ type: "session", id: "x", cwd: dir })}\n`);
	const record = await old.create({ cwd: dir, env: {}, piDir: piDir!, sessionFile: file });
	const version = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
	const next = await connectSupervisor(otherPaths, { piDir: piDir!, root: ROOT, version });
	try {
		assert.equal(next.version, version);
		assert.notEqual(next.pid, process.pid);
		assert.ok(isAlive(record.pid!));
		await until(async () => {
			const { sessions } = await next.connection.request<{ sessions: SessionRecord[] }>({ type: "list" });
			return sessions.some((r) => r.id === record.id && r.pid === record.pid && r.state === "idle");
		}, "the worker on the new supervisor");
	} finally {
		await next.connection.request({ type: "shutdown", keepWorkers: false }, 30_000).catch(() => {});
		next.connection.close();
		await until(() => !isAlive(record.pid!), "the end of the worker");
		rmSync(dir, { recursive: true, force: true });
	}
});

// This test must stay the last one: it lets the supervisor stop every idle session without a client.
test("an idle session without a client loses its worker, and an attached one keeps it", { skip }, async () => {
	const settings = path.join(agentDir, "settings.json");
	const before = readFileSync(settings, "utf8");
	const watched = await create("watched");
	const viewer = client(await socketOf(watched.id));
	await until(() => viewer.screen().includes("watched"), "the screen");
	const sleepy = await create("sleepy");
	// About a second. The supervisor reads the setting on each sweep, every 5 seconds.
	writeFileSync(settings, JSON.stringify({ ...JSON.parse(before), sessionManager: { idleMinutes: 0.02 } }));
	try {
		await until(async () => {
			const { sessions } = await handle.connection.request<{ sessions: SessionRecord[] }>({ type: "list" });
			return !sessions.some((r) => r.id === sleepy.id);
		}, "the idle stop", 20_000);
		assert.equal(isAlive(sleepy.pid!), false);
		assert.ok(isAlive(watched.pid!));
		viewer.type("\x04");
		assert.equal((await viewer.done).kind, "detached");
	} finally {
		writeFileSync(settings, before);
	}
});
