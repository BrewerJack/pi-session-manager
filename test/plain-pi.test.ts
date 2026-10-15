// Plain pi as a client, under a PTY from util-linux `script` (spec §12). Linux only.
// The agent dir has no login, so no model can run. The tests skip without pi or `script`.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error boot.mjs is plain JavaScript without types.
import { findPiDir } from "../boot.mjs";
import type { SessionRecord } from "../control.ts";
import { statePaths, type StatePaths } from "../paths.ts";
import { connectSupervisor } from "../supervisor-client.ts";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let piDir: string | undefined;
try {
	piDir = findPiDir();
} catch {
	piDir = undefined;
}
const hasScript = process.platform === "linux" && spawnSync("script", ["--version"]).status === 0;
const skip = !piDir ? "no pi on PATH" : !hasScript ? "needs util-linux script on Linux" : false;

let agentDir: string;
/** pi moves *.jsonl files out of the root of the agent dir, so the test files live here. */
let workDir: string;
let paths: StatePaths;
let piCli: string;

function writeSettings(extra: Record<string, unknown> = {}): void {
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [ROOT], ...extra }));
}

before(() => {
	if (skip) return;
	agentDir = mkdtempSync(path.join(tmpdir(), "pism-plain-"));
	workDir = mkdtempSync(path.join(tmpdir(), "pism-plain-work-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	paths = statePaths(agentDir);
	const bin = JSON.parse(readFileSync(path.join(piDir!, "package.json"), "utf8")).bin;
	piCli = path.join(piDir!, typeof bin === "string" ? bin : bin.pi);
	writeSettings();
});

after(async () => {
	if (skip) return;
	try {
		const handle = await connectSupervisor(paths, { piDir: piDir!, root: ROOT, version: "test" }, { start: false });
		await handle.connection.request({ type: "shutdown", keepWorkers: false }, 60_000);
		handle.connection.close();
	} catch {
		// No supervisor ran.
	}
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(workDir, { recursive: true, force: true });
});

/** pi in a PTY of 120 × 34. The screen is the plain text of all output since the last mark. */
function runPi(args: string[]) {
	const command = ["stty cols 120 rows 34;", "exec", process.execPath, piCli, ...args].map((a) => (a.endsWith(";") ? a : `'${a}'`)).join(" ");
	const child = spawn("script", ["-qfec", command, "/dev/null"], { cwd: workDir, env: process.env });
	let raw = "";
	let mark = 0;
	child.stdout.on("data", (chunk: Buffer) => {
		raw += chunk.toString("utf8");
	});
	const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	const plain = () => raw.slice(mark).replace(/\x1b\[[0-9;?<>=]*[a-zA-Z~]|\x1b\][^\x07]*\x07|\x1b_[^\x1b]*\x1b\\/g, "");
	return {
		exit,
		type: async (data: string) => {
			mark = raw.length;
			child.stdin.write(data);
			await new Promise((resolve) => setTimeout(resolve, 400));
		},
		wait: (text: string, ms = 20_000) =>
			until(() => plain().includes(text), `"${text}" on screen`, ms).catch((error) => {
				throw new Error(`${error.message}. The screen showed: ${plain().replace(/\s+/g, " ").slice(-600)}`);
			}),
		kill: () => child.kill("SIGKILL"),
	};
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 20_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function sessions(): Promise<SessionRecord[]> {
	try {
		const handle = await connectSupervisor(paths, { piDir: piDir!, root: ROOT, version: "test" }, { start: false });
		try {
			return (await handle.connection.request<{ sessions: SessionRecord[] }>({ type: "list" })).sessions;
		} finally {
			handle.connection.close();
		}
	} catch {
		return [];
	}
}

const conversation = () => path.join(workDir, "conversation.jsonl");

test("/sessions bg moves a plain session to a worker and attaches to it", { skip }, async () => {
	const fixture = readFileSync(path.join(ROOT, "test", "fixtures", "conversation.jsonl"), "utf8");
	writeFileSync(conversation(), fixture.replace('"cwd":"/tmp"', `"cwd":${JSON.stringify(workDir)}`));
	const pi = runPi(["--session", conversation()]);
	try {
		await pi.wait("7 files");
		await pi.type("/sessions bg");
		// The first enter takes the completion, the second runs the command.
		await pi.type("\r");
		await pi.type("\r");
		await until(async () => (await sessions()).some((r) => r.sessionFile === conversation() && r.attached), "the attach");
		await pi.type("\x04");
		await pi.wait("Detached");
		await pi.type("\x04");
		assert.equal(await pi.exit, 0);
		// The worker keeps the session.
		const row = (await sessions()).find((r) => r.sessionFile === conversation());
		assert.equal(row?.state, "idle");
	} finally {
		pi.kill();
	}
});

test("pi on the file of a listed session attaches to it, then ends after the manager", { skip }, async () => {
	await until(async () => (await sessions()).some((r) => r.sessionFile === conversation()), "the session from the test before");
	const pi = runPi(["--session", conversation()]);
	try {
		await until(async () => (await sessions()).some((r) => r.sessionFile === conversation() && r.attached), "the attach");
		await pi.type("\x04");
		await pi.wait("so pi attached to it");
		await pi.type("q");
		assert.equal(await pi.exit, 0);
	} finally {
		pi.kill();
	}
});

test("startDetached opens the manager at once and ends pi with it", { skip }, async () => {
	writeSettings({ sessionManager: { startDetached: true } });
	const pi = runPi([]);
	try {
		await pi.wait("fixture");
		await pi.wait("Sessions");
		await pi.type("q");
		assert.equal(await pi.exit, 0);
	} finally {
		pi.kill();
		writeSettings();
	}
});
