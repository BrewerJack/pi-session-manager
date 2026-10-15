// End to end: a real supervisor and real pi workers in a throwaway agent dir (spec §12).
// The tests skip when no pi is on PATH. No test sends a message, so no model runs.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error boot.mjs is plain JavaScript without types.
import { findPiDir } from "../boot.mjs";
import { attach, type AttachResult } from "../client.ts";
import type { SessionRecord } from "../control.ts";
import { statePaths, type StatePaths } from "../paths.ts";
import { isAlive } from "../supervisor.ts";
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

async function create(name: string): Promise<SessionRecord> {
	const request = { cwd: agentDir, name, env: {}, piDir };
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

async function until(check: () => boolean, what: string, ms = 15_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
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
