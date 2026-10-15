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
async function startSupervisor(paths: StatePaths, extra: { idleMs?: number } = {}): Promise<Supervisor> {
	const supervisor = new Supervisor({
		paths,
		version: "test",
		bootFile: "unused",
		log: () => {},
		sweepMs: 100,
		createTimeoutMs: 5_000,
		idleMs: extra.idleMs ?? 0,
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

function sessionFile(dir: string, name = "session"): string {
	const file = path.join(dir, `${name}.jsonl`);
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

test("a worker that crashes during a run starts again once, then fails", async () => {
	const dir = tempDir();
	const supervisor = await startSupervisor(statePaths(dir));
	try {
		const record = await supervisor.create(request(dir, { sessionFile: sessionFile(dir), env: { FAKE_STATE: "working" } }));
		assert.equal(record.state, "working");
		const firstPid = record.pid!;
		process.kill(firstPid, "SIGKILL");
		await until(() => {
			const now = supervisor.find(record.id);
			return Boolean(now?.pid && now.pid !== firstPid && now.state === "working");
		});
		const restarted = supervisor.find(record.id)!;
		assert.match(restarted.error ?? "", /SIGKILL.*started again/);
		assert.equal(restarted.lastOutcome, "error");
		process.kill(restarted.pid!, "SIGKILL");
		await until(() => stateOf(supervisor, record.id) === "failed");
		assert.match(supervisor.find(record.id)?.error ?? "", /crashed twice/);
	} finally {
		await supervisor.close(false);
	}
});

test("an idle session without a client loses its worker, unless a client holds it or it is pinned", async () => {
	const dir = tempDir();
	const paths = statePaths(dir);
	const supervisor = await startSupervisor(paths, { idleMs: 300 });
	try {
		const idle = await supervisor.create(request(dir, { sessionFile: sessionFile(dir) }));
		const held = await supervisor.create(request(dir, { sessionFile: sessionFile(dir, "held"), env: { FAKE_ATTACHED: "1" } }));
		const pinned = await supervisor.create(request(dir, { sessionFile: sessionFile(dir, "pinned") }));
		const blank = await supervisor.create(request(dir));
		const client = await connect(paths.supervisorSocket);
		await client.request({ type: "pin", session: pinned.id, pinned: true });
		await until(() => stateOf(supervisor, idle.id) === "saved" && !stateOf(supervisor, blank.id), 3_000);
		assert.equal(isAlive(idle.pid!), false);
		assert.equal(stateOf(supervisor, held.id), "idle");
		assert.equal(stateOf(supervisor, pinned.id), "idle");
		client.close();
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

test("workers reconnect to a new supervisor after the old one dies from SIGKILL", async () => {
	const dir = tempDir();
	const paths = statePaths(dir);
	const fixture = path.join(path.dirname(FAKE_WORKER), "supervisor-process.ts");
	const old = spawn(process.execPath, [fixture, dir], { stdio: ["ignore", "pipe", "inherit"] });
	await new Promise<void>((resolve, reject) => {
		old.stdout.on("data", (chunk: Buffer) => chunk.toString().includes("ready") && resolve());
		old.once("exit", (code) => reject(new Error(`the supervisor process exited with ${code}`)));
	});
	const client = await connect(paths.supervisorSocket);
	const { record } = await client.request<{ record: SessionRecord }>({ type: "create", request: request(dir, { sessionFile: sessionFile(dir) }) });
	pids.push(record.pid!);
	client.close();
	old.kill("SIGKILL");
	await until(() => old.exitCode !== null || old.signalCode !== null);
	assert.ok(isAlive(record.pid!));
	// The socket file of the dead supervisor stays behind. The new one replaces it.
	const next = await startSupervisor(paths);
	try {
		await until(() => Boolean((next as any).live.get(record.id)?.connection));
		assert.equal(next.find(record.id)?.pid, record.pid);
		assert.equal(stateOf(next, record.id), "idle");
	} finally {
		await next.close(false);
	}
	assert.equal(isAlive(record.pid!), false);
});

test("after a reboot, a dead idle worker leaves a saved session", async () => {
	const dir = tempDir();
	const paths = statePaths(dir);
	const first = await startSupervisor(paths);
	const record = await first.create(request(dir, { sessionFile: sessionFile(dir) }));
	await first.close(true);
	process.kill(record.pid!, "SIGKILL");
	await until(() => !isAlive(record.pid!));
	const second = await startSupervisor(paths);
	try {
		assert.equal(stateOf(second, record.id), "saved");
		assert.equal(second.find(record.id)?.error, undefined);
	} finally {
		await second.close(false);
	}
});
