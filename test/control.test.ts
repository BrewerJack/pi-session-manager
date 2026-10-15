import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { connect, Connection, encodeLine, LineDecoder, type SessionRecord } from "../control.ts";
import { newSessionId, statePaths, workerSocket } from "../paths.ts";
import { Registry } from "../registry.ts";

const dir = mkdtempSync(path.join(tmpdir(), "pism-control-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("lines split only on \\n, keep U+2028, and survive any chunking", () => {
	const text = "a\u2028b\u2029c ✓";
	const stream = Buffer.from(encodeLine({ text }) + encodeLine({ n: 2 }).replace("\n", "\r\n") + "{bad}\n");
	const decoder = new LineDecoder();
	const out: unknown[] = [];
	const bad: string[] = [];
	for (const byte of stream) out.push(...decoder.push(Buffer.from([byte]), (line) => bad.push(line)));
	assert.deepEqual(out, [{ text }, { n: 2 }]);
	assert.deepEqual(bad, ["{bad}"]);
});

test("requests get their own responses, and errors reject", async () => {
	const socketPath = path.join(dir, "rpc.sock");
	const server = net.createServer((socket) => {
		new Connection(socket).onMessage(async (message) => {
			if (message.type === "fail") throw new Error("nope");
			await new Promise((resolve) => setTimeout(resolve, message.type === "slow" ? 50 : 0));
			return { echo: message.type };
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	try {
		const client = await connect(socketPath);
		const [slow, fast] = await Promise.all([client.request({ type: "slow" }), client.request({ type: "fast" })]);
		assert.deepEqual([slow, fast], [{ echo: "slow" }, { echo: "fast" }]);
		await assert.rejects(client.request({ type: "fail" }), /nope/);
		client.close();
	} finally {
		server.close();
	}
});

test("pending requests reject when the connection closes", async () => {
	const socketPath = path.join(dir, "drop.sock");
	const server = net.createServer((socket) => socket.destroy());
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	try {
		const client = await connect(socketPath);
		await assert.rejects(client.request({ type: "anything" }), /closed/);
	} finally {
		server.close();
	}
});

test("connect rejects when nobody listens", async () => {
	await assert.rejects(connect(path.join(dir, "nobody.sock")));
});

test("the registry writes private records, skips broken ones, and removes them", () => {
	const registry = new Registry(path.join(dir, "sessions"));
	const record: SessionRecord = {
		id: "app-1",
		cwd: "/tmp",
		state: "idle",
		pinned: false,
		createdAt: 2,
		lastActivityAt: 2,
		env: {},
		piDir: "/pi",
	};
	registry.write(record);
	registry.write({ ...record, id: "app-0", createdAt: 1 });
	writeFileSync(path.join(dir, "sessions", "broken.json"), "{");
	writeFileSync(path.join(dir, "sessions", "wrong-name.json"), JSON.stringify(record));
	assert.deepEqual(
		registry.load().map((r) => r.id),
		["app-0", "app-1"],
	);
	assert.equal(statSync(path.join(dir, "sessions", "app-1.json")).mode & 0o777, 0o600);
	assert.ok(!readdirSync(path.join(dir, "sessions")).some((n) => n.endsWith(".tmp")));
	registry.remove("app-1");
	assert.deepEqual(
		registry.load().map((r) => r.id),
		["app-0"],
	);
});

test("socket paths stay short enough for macOS, also under a deep agent dir", () => {
	const deep = path.join(dir, "a".repeat(60), "b".repeat(30));
	mkdirSync(deep, { recursive: true });
	const paths = statePaths(deep, { XDG_RUNTIME_DIR: "/run/user/1000" });
	const id = newSessionId("/some/very-long-project-folder-name-that-goes-on");
	assert.ok(id.length <= 48, id);
	assert.ok(workerSocket(paths, id).length <= 103);
	assert.ok(paths.supervisorSocket.length <= 103);
	assert.ok(paths.sockets.startsWith("/run/user/1000/pi-sm-"));
	assert.notEqual(statePaths(`${deep}2`, { XDG_RUNTIME_DIR: "/run/user/1000" }).sockets, paths.sockets);
	assert.equal(statePaths("/home/u/.pi/agent").sockets, "/home/u/.pi/agent/pi-session-manager/workers");
});

test("only a numeric older version counts as older", async () => {
	const { isOlder } = await import("../supervisor-client.ts");
	assert.equal(isOlder("0.3.0", "0.4.0"), true);
	assert.equal(isOlder("0.4.0", "0.4.0"), false);
	assert.equal(isOlder("0.10.0", "0.9.9"), false);
	assert.equal(isOlder("1.0.0", "0.9.0"), false);
	assert.equal(isOlder("test", "0.4.0"), false);
	assert.equal(isOlder("0.4.0", "e2e"), false);
});
