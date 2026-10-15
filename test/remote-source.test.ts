import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { statePaths, type StatePaths } from "../paths.ts";
import { RemoteSource } from "../remote-source.ts";
import { nameOf, readSessionFile } from "../session-file.ts";
import { isAlive, Supervisor, type StartWorker } from "../supervisor.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_WORKER = path.join(HERE, "fixtures", "fake-worker.mjs");
const CONVERSATION = path.join(HERE, "fixtures", "conversation.jsonl");
const dirs: string[] = [];
const pids: number[] = [];

after(() => {
	for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function setup(): Promise<{ dir: string; paths: StatePaths; supervisor: Supervisor; source: RemoteSource }> {
	const dir = mkdtempSync(path.join(tmpdir(), "pism-source-"));
	dirs.push(dir);
	const paths = statePaths(dir);
	const supervisor = new Supervisor({
		paths,
		version: "test",
		bootFile: "unused",
		log: () => {},
		sweepMs: 100,
		createTimeoutMs: 5_000,
		spawnWorker: ({ record }: StartWorker) => {
			const args = [FAKE_WORKER, paths.supervisorSocket, record.id];
			if (record.sessionFile) args.push(record.sessionFile);
			const child = spawn(process.execPath, args, { stdio: "ignore" });
			if (child.pid) pids.push(child.pid);
			return child;
		},
	});
	assert.equal(await supervisor.start(), true);
	const source = new RemoteSource(paths, { piDir: "/unused", root: "/unused", version: "test" });
	await source.ensureConnected();
	return { dir, paths, supervisor, source };
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("the source follows sessions that other clients create and stop", async () => {
	const { dir, supervisor, source } = await setup();
	try {
		let changes = 0;
		source.subscribe(() => changes++);
		const record = await supervisor.create({ cwd: dir, env: { SECRET: "x" }, piDir: "/unused", name: "elsewhere" });
		await until(() => source.get("elsewhere")?.state === "idle");
		assert.ok(changes > 0);
		// The env of a record never reaches a client.
		assert.equal("env" in source.get(record.id)!, false);
		await supervisor.stop(record.id);
		await until(() => source.list().length === 0);
	} finally {
		source.dispose();
		await supervisor.close(false);
	}
});

test("send, rename, and transcript reach the worker of a live session", async () => {
	const { dir, source, supervisor } = await setup();
	try {
		const row = await source.create({ cwd: dir, name: "live" });
		await source.send(row.id, "hello worker");
		await until(() => source.get(row.id)?.lastPrompt === "hello worker");
		await source.rename(row.id, "renamed");
		await until(() => source.get(row.id)?.name === "renamed");
		assert.equal(source.transcript(row.id), undefined);
		await until(() => source.transcript(row.id)?.[0]?.text === "from the worker");
	} finally {
		source.dispose();
		await supervisor.close(false);
	}
});

test("a saved session answers from its file, and a rename lands in the file", async () => {
	const { dir, source, supervisor } = await setup();
	try {
		const file = path.join(dir, "saved.jsonl");
		copyFileSync(CONVERSATION, file);
		const record = supervisor.addSaved(file, "/unused");
		assert.equal(record.state, "saved");
		assert.equal(record.name, "fixture");
		assert.equal(record.lastReply, "The folder holds 7 files.");
		assert.equal(record.usage?.cost, 0.75);
		await until(() => source.get(record.id) !== undefined);
		await until(() => (source.transcript(record.id)?.length ?? 0) === 4);
		await source.rename(record.id, "from the list");
		assert.equal(nameOf(readSessionFile(file).entries), "from the list");
		await until(() => source.get(record.id)?.name === "from the list");
		await source.pin(record.id, true);
		await until(() => source.get(record.id)?.pinned === true);
		// A second import of the same file returns the listed session.
		assert.equal(supervisor.addSaved(file, "/unused").id, record.id);
	} finally {
		source.dispose();
		await supervisor.close(false);
	}
});

test("a send to a saved session starts its worker first", async () => {
	const { dir, source, supervisor } = await setup();
	try {
		const file = path.join(dir, "sleeping.jsonl");
		copyFileSync(CONVERSATION, file);
		const record = supervisor.addSaved(file, "/unused");
		await source.send(record.id, "wake up");
		await until(() => source.get(record.id)?.lastPrompt === "wake up");
		assert.ok(source.get(record.id)?.pid);
	} finally {
		source.dispose();
		await supervisor.close(false);
	}
});

test("files of an old child list become saved sessions once", async () => {
	const { dir, source, supervisor } = await setup();
	try {
		const file = path.join(dir, "child.jsonl");
		copyFileSync(CONVERSATION, file);
		const rows = await source.importSaved([file, path.join(dir, "missing.jsonl"), "relative.jsonl"]);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.state, "saved");
		assert.equal(rows[0]?.name, "fixture");
		const again = await source.importSaved([file]);
		assert.equal(again[0]?.id, rows[0]?.id);
		assert.equal(supervisor.list().length, 1);
	} finally {
		source.dispose();
		await supervisor.close(false);
	}
});
