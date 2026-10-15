import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { connect, type SessionRecord } from "../control.ts";
import { recordFile, statePaths, type StatePaths } from "../paths.ts";
import { isAlive, Supervisor, type StartWorker } from "../supervisor.ts";

const FAKE_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-worker.mjs");
const dirs: string[] = [];
const pids: number[] = [];

after(() => {
	for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "pism-test-"));
	dirs.push(dir);
	return dir;
}

/** A supervisor whose workers are fake-worker.mjs. FAKE_STATE comes from the env of the create request. */
async function startSupervisor(paths: StatePaths): Promise<Supervisor> {
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
			const child = spawn(process.execPath, args, { stdio: "ignore", env: { ...process.env, ...record.env } });
			if (child.pid) pids.push(child.pid);
			return child;
		},
	});
	assert.equal(await supervisor.start(), true);
	return supervisor;
}

function sessionFile(dir: string): string {
	const file = path.join(dir, "session.jsonl");
	writeFileSync(file, `${JSON.stringify({ type: "session", id: "x", cwd: dir })}\n`);
	return file;
}

const request = (cwd: string, extra: Record<string, unknown> = {}) => ({ cwd, env: {}, piDir: "/unused", ...extra });

async function until(check: () => boolean, ms = 5_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

const stateOf = (supervisor: Supervisor, id: string) => supervisor.list().find((r) => r.id === id)?.state;

test("create starts a worker, and list shows it idle with a record on disk", async () => {
	const dir = tempDir();
	const paths = statePaths(dir);
	const supervisor = await startSupervisor(paths);
	try {
		const record = await supervisor.create(request(dir, { name: "alpha" }));
		assert.equal(record.state, "idle");
		assert.ok(record.pid && isAlive(record.pid));
		assert.equal(supervisor.find("alpha")?.id, record.id);
		const file = recordFile(paths, record.id);
		assert.equal(JSON.parse(readFileSync(file, "utf8")).name, "alpha");
		assert.equal(statSync(file).mode & 0o777, 0o600);
	} finally {
		await supervisor.close(false);
	}
});

test("clients list and stop sessions over the socket", async () => {
	const dir = tempDir();
	const paths = statePaths(dir);
	const supervisor = await startSupervisor(paths);
	try {
		const record = await supervisor.create(request(dir));
		const client = await connect(paths.supervisorSocket);
		const { sessions } = await client.request<{ sessions: SessionRecord[] }>({ type: "list" });
		assert.deepEqual(
			sessions.map((s) => s.id),
			[record.id],
		);
		await client.request({ type: "stop", session: record.id });
		assert.equal(supervisor.list().length, 0);
		assert.equal(existsSync(recordFile(paths, record.id)), false);
		await until(() => !isAlive(record.pid!));
		await assert.rejects(client.request({ type: "stop", session: record.id }), /No session matches/);
		client.close();
	} finally {
		await supervisor.close(false);
	}
});

test("a killed idle worker leaves a saved session, or none without a session file", async () => {
	const dir = tempDir();
	const supervisor = await startSupervisor(statePaths(dir));
	try {
		const withFile = await supervisor.create(request(dir, { sessionFile: sessionFile(dir) }));
		const withoutFile = await supervisor.create(request(dir));
		process.kill(withFile.pid!, "SIGKILL");
		process.kill(withoutFile.pid!, "SIGKILL");
		await until(() => stateOf(supervisor, withFile.id) === "saved" && !stateOf(supervisor, withoutFile.id));
		assert.equal(supervisor.find(withFile.id)?.pid, undefined);
		assert.equal(supervisor.find(withFile.id)?.error, undefined);
	} finally {
		await supervisor.close(false);
	}
});

test("a killed working worker leaves a failed session with the reason", async () => {
	const dir = tempDir();
	const supervisor = await startSupervisor(statePaths(dir));
	try {
		const record = await supervisor.create(request(dir, { sessionFile: sessionFile(dir), env: { FAKE_STATE: "working" } }));
		assert.equal(record.state, "working");
		process.kill(record.pid!, "SIGKILL");
		await until(() => stateOf(supervisor, record.id) === "failed");
		assert.match(supervisor.find(record.id)?.error ?? "", /SIGKILL/);
	} finally {
		await supervisor.close(false);
	}
});

test("a second create on the same session file returns the existing session", async () => {
	const dir = tempDir();
	const supervisor = await startSupervisor(statePaths(dir));
	try {
		const file = sessionFile(dir);
		const first = await supervisor.create(request(dir, { sessionFile: file }));
		const second = await supervisor.create(request(dir, { sessionFile: file }));
		assert.equal(second.id, first.id);
		assert.equal(supervisor.list().length, 1);
		await assert.rejects(supervisor.create(request(dir, { sessionFile: file, task: "go" })), /Attach to it instead/);
	} finally {
		await supervisor.close(false);
	}
});

test("workers outlive a supervisor restart and reconnect to the next one", async () => {
	const dir = tempDir();
	const paths = statePaths(dir);
	const first = await startSupervisor(paths);
	const record = await first.create(request(dir, { sessionFile: sessionFile(dir) }));
	await first.close(true);
	assert.ok(isAlive(record.pid!));
	const second = await startSupervisor(paths);
	try {
		assert.equal(second.find(record.id)?.pid, record.pid);
		const client = await connect(paths.supervisorSocket);
		await until(() => second.list().length === 1);
		// The stop reaches the worker over its new connection.
		await until(() => {
			const live = (second as any).live.get(record.id);
			return Boolean(live?.connection);
		});
		await client.request({ type: "stop", session: record.id });
		await until(() => !isAlive(record.pid!));
		client.close();
	} finally {
		await second.close(false);
	}
});

test("a supervisor that finds a dead worker on start settles its session", async () => {
	const dir = tempDir();
	const paths = statePaths(dir);
	const first = await startSupervisor(paths);
	const record = await first.create(request(dir, { sessionFile: sessionFile(dir), env: { FAKE_STATE: "working" } }));
	await first.close(true);
	process.kill(record.pid!, "SIGKILL");
	await until(() => !isAlive(record.pid!));
	const second = await startSupervisor(paths);
	try {
		assert.equal(stateOf(second, record.id), "failed");
	} finally {
		await second.close(false);
	}
});

test("closing without keepWorkers ends the workers and keeps their sessions", async () => {
	const dir = tempDir();
	const paths = statePaths(dir);
	const supervisor = await startSupervisor(paths);
	const record = await supervisor.create(request(dir, { sessionFile: sessionFile(dir) }));
	await supervisor.close(false);
	assert.equal(isAlive(record.pid!), false);
	assert.equal(existsSync(paths.supervisorSocket), false);
	const saved = JSON.parse(readFileSync(recordFile(paths, record.id), "utf8")) as SessionRecord;
	assert.equal(saved.state, "saved");
	assert.equal(saved.pid, undefined);
});

test("a second supervisor on the same agent dir steps aside", async () => {
	const dir = tempDir();
	const paths = statePaths(dir);
	const first = await startSupervisor(paths);
	try {
		const second = new Supervisor({ paths, version: "test", bootFile: "unused", log: () => {} });
		assert.equal(await second.start(), false);
	} finally {
		await first.close(false);
	}
});

test("close does not wait for clients that stay connected", async () => {
	const dir = tempDir();
	const paths = statePaths(dir);
	const supervisor = await startSupervisor(paths);
	const client = await connect(paths.supervisorSocket);
	await client.request({ type: "list" });
	const started = Date.now();
	await supervisor.close(false);
	assert.ok(Date.now() - started < 2_000);
	await until(() => client.isClosed);
});
