// Path locks in the supervisor (spec §9, §12). Raw connections play the workers of two
// saved sessions, so the locks belong to real records without worker processes.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { connect, type Connection } from "../control.ts";
import type { LockAnswer } from "../locks.ts";
import { statePaths } from "../paths.ts";
import { Supervisor } from "../supervisor.ts";

const CONVERSATION = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "conversation.jsonl");
const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function setup() {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "pism-locks-")));
	dirs.push(dir);
	const supervisor = new Supervisor({ paths: statePaths(dir), version: "test", bootFile: "unused", log: () => {} });
	assert.equal(await supervisor.start(), true);
	return { dir, supervisor };
}

/** A connection that says hello as the worker of a saved session. */
async function fakeWorker(supervisor: Supervisor, dir: string, name: string): Promise<{ id: string; connection: Connection }> {
	const file = path.join(dir, `${name}.jsonl`);
	copyFileSync(CONVERSATION, file);
	const record = supervisor.addSaved(file, "/unused");
	await supervisor.rename(record.id, name);
	const connection = await connect(supervisor.paths.supervisorSocket);
	await connection.request({ type: "worker.hello", workerId: record.id, pid: process.pid, socket: "/unused", update: {} });
	return { id: record.id, connection };
}

const acquire = (connection: Connection, paths: string[], cwd: string, toolCallId: string) =>
	connection.request<LockAnswer>({ type: "lock.acquire", paths, cwd, toolCallId });

async function until(check: () => boolean, ms = 3_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("two workers write one path: the second write is blocked until the first ends", async () => {
	const { dir, supervisor } = await setup();
	try {
		const a = await fakeWorker(supervisor, dir, "alpha");
		const b = await fakeWorker(supervisor, dir, "beta");
		assert.deepEqual(await acquire(a.connection, ["src/app.ts"], dir, "t1"), { granted: true });
		assert.deepEqual(supervisor.find(a.id)?.locks, [path.join(dir, "src", "app.ts")]);

		const blocked = await acquire(b.connection, ["src"], dir, "t2");
		assert.equal(blocked.granted, false);
		assert.deepEqual(blocked.owners, ["alpha"]);
		assert.deepEqual(blocked.held, [path.join(dir, "src", "app.ts")]);
		// Another folder is free. The same session can write its own path again.
		assert.deepEqual(await acquire(b.connection, ["docs/readme.md"], dir, "t3"), { granted: true });
		assert.deepEqual(await acquire(a.connection, ["src/app.ts"], dir, "t4"), { granted: true });

		a.connection.send({ type: "lock.release", toolCallId: "t1" });
		a.connection.send({ type: "lock.release", toolCallId: "t4" });
		await until(() => !supervisor.find(a.id)?.locks);
		assert.deepEqual(await acquire(b.connection, ["src"], dir, "t5"), { granted: true });
		a.connection.close();
		b.connection.close();
	} finally {
		await supervisor.close(true);
	}
});

test("a closed connection gives up its locks, and a client lock names its label", async () => {
	const { dir, supervisor } = await setup();
	try {
		const a = await fakeWorker(supervisor, dir, "alpha");
		assert.deepEqual(await acquire(a.connection, ["out.txt"], dir, "t1"), { granted: true });
		a.connection.socket.destroy();
		await until(() => supervisor.locks.heldBy(a.id).length === 0);

		const plain = await connect(supervisor.paths.supervisorSocket);
		const label = "plain pi in ~/app";
		const granted = await plain.request<LockAnswer>({ type: "lock.acquire", paths: ["out.txt"], cwd: dir, toolCallId: "p1", label });
		assert.equal(granted.granted, true);
		const b = await fakeWorker(supervisor, dir, "beta");
		const blocked = await acquire(b.connection, ["out.txt"], dir, "t2");
		assert.deepEqual(blocked.owners, [label]);
		plain.close();
		b.connection.close();
	} finally {
		await supervisor.close(true);
	}
});
