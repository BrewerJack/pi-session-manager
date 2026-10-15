// M0 dev tool: start workers, attach to them, list them, and stop them. No supervisor yet.
//
//   node dev/m0.ts start [--cwd <dir>] [--session <file>] [--bg] [task…]
//   node dev/m0.ts attach <id>
//   node dev/m0.ts list
//   node dev/m0.ts stop <id>
//
// Set PI_SM_PI_DIR to choose the pi package. The default is the pi on PATH.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { attach } from "../client.ts";
import type { WorkerInfo } from "../worker.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const START_TIMEOUT_MS = 60_000;

function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return env.startsWith("~") ? path.join(homedir(), env.slice(1)) : env;
	return path.join(homedir(), ".pi", "agent");
}

const WORKERS = path.join(agentDir(), "pi-session-manager", "workers");
const files = (id: string) => ({
	socket: path.join(WORKERS, `${id}.sock`),
	info: path.join(WORKERS, `${id}.json`),
	log: path.join(WORKERS, `${id}.log`),
});

/** The pi package root: PI_SM_PI_DIR, or the package that owns the pi on PATH. */
function piDir(): string {
	if (process.env.PI_SM_PI_DIR) return path.resolve(process.env.PI_SM_PI_DIR);
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		const bin = path.join(dir, "pi");
		if (!existsSync(bin)) continue;
		let current = path.dirname(realpathSync(bin));
		while (current !== path.dirname(current)) {
			if (packageName(current) === "@earendil-works/pi-coding-agent") return current;
			current = path.dirname(current);
		}
	}
	throw new Error("No pi on PATH. Set PI_SM_PI_DIR to the pi-coding-agent package.");
}

function packageName(dir: string): string | undefined {
	try {
		return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name;
	} catch {
		return undefined;
	}
}

function readInfo(id: string): WorkerInfo | undefined {
	try {
		return JSON.parse(readFileSync(files(id).info, "utf8")) as WorkerInfo;
	} catch {
		return undefined;
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function newId(cwd: string): string {
	const slug = path.basename(cwd).replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 24) || "session";
	return `${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function start(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: { cwd: { type: "string" }, session: { type: "string" }, bg: { type: "boolean" } },
	});
	const cwd = path.resolve(values.cwd ?? process.cwd());
	const id = newId(cwd);
	const f = files(id);
	mkdirSync(WORKERS, { recursive: true, mode: 0o700 });
	const logFd = openSync(f.log, "a", 0o600);
	const bootArgs = [path.join(ROOT, "worker-boot.mjs"), "--pi-dir", piDir(), "--id", id];
	bootArgs.push("--socket", f.socket, "--info", f.info, "--log", f.log, "--cwd", cwd);
	if (values.session) bootArgs.push("--session", path.resolve(values.session));
	const task = positionals.join(" ").trim();
	if (task) bootArgs.push("--task", task);
	const child = spawn(process.execPath, bootArgs, { cwd, detached: true, stdio: ["ignore", logFd, logFd] });
	let exitCode: number | null = null;
	child.on("exit", (code) => {
		exitCode = code ?? -1;
	});
	child.unref();

	const deadline = Date.now() + START_TIMEOUT_MS;
	while (!readInfo(id)) {
		if (exitCode !== null) throw new Error(`The worker exited with code ${exitCode}. See ${f.log}`);
		if (Date.now() > deadline) throw new Error(`The worker did not start in time. See ${f.log}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	process.stderr.write(`started ${id} (pid ${child.pid})\n`);
	if (!values.bg) await attachTo(id);
}

async function attachTo(id: string): Promise<void> {
	const info = readInfo(id);
	if (!info || !alive(info.pid)) throw new Error(`No live worker for ${id}.`);
	const result = await attach(info.socket);
	const what = result.kind === "detached" ? `detached (${result.detached.reason})` : result.kind;
	const extra = result.kind === "error" ? `: ${result.message}` : "";
	process.stderr.write(`${what}${extra}. Run "node dev/m0.ts attach ${id}" to attach again.\n`);
}

function list(): void {
	if (!existsSync(WORKERS)) return;
	for (const name of readdirSync(WORKERS).filter((n) => n.endsWith(".json")).sort((a, b) => a.localeCompare(b))) {
		const info = readInfo(name.slice(0, -".json".length));
		if (!info) continue;
		const state = alive(info.pid) ? "live" : "dead";
		process.stdout.write(`${info.id}\t${state}\tpid ${info.pid}\t${info.cwd}\t${info.sessionFile ?? "(no file yet)"}\n`);
	}
}

function stop(id: string): void {
	const info = readInfo(id);
	if (!info || !alive(info.pid)) throw new Error(`No live worker for ${id}.`);
	process.kill(info.pid, "SIGTERM");
	process.stderr.write(`sent SIGTERM to ${id} (pid ${info.pid})\n`);
}

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);
	if (command === "start") return start(rest);
	if (command === "attach" && rest[0]) return attachTo(rest[0]);
	if (command === "list") return list();
	if (command === "stop" && rest[0]) return stop(rest[0]);
	process.stderr.write("usage: node dev/m0.ts start|attach <id>|list|stop <id>\n");
	process.exitCode = 2;
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
