// Client side of the supervisor: connect, and start the supervisor when none runs (spec §7.1).
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { connect, type Connection } from "./control.ts";
import type { BootContext, StatePaths } from "./paths.ts";

/** A client that holds the lock longer than this died during the start. */
const STALE_LOCK_MS = 30_000;
/** The supervisor loads jiti and its modules first. */
const START_TIMEOUT_MS = 20_000;

export interface SupervisorHandle {
	connection: Connection;
	version: string;
	pid: number;
}

/**
 * Connect to the supervisor of an agent dir. `start` starts one when none runs. A supervisor
 * with an older version than this client restarts as this version, and keeps its workers (spec §7.1).
 */
export async function connectSupervisor(
	paths: StatePaths,
	context: BootContext,
	options: { start?: boolean } = {},
): Promise<SupervisorHandle> {
	const start = options.start !== false;
	let connection = await tryConnect(paths.supervisorSocket);
	if (!connection) {
		if (!start) throw new Error("The supervisor does not run.");
		connection = await startSupervisor(paths, context);
	}
	let hello = await connection.request<{ version: string; pid: number }>({ type: "hello", version: context.version });
	if (start && isOlder(hello.version, context.version)) {
		await connection.request({ type: "shutdown", keepWorkers: true }, 30_000).catch(() => {});
		connection.close();
		await waitUntilGone(paths.supervisorSocket);
		connection = await startSupervisor(paths, context);
		hello = await connection.request<{ version: string; pid: number }>({ type: "hello", version: context.version });
	}
	return { connection, version: hello.version, pid: hello.pid };
}

/** Numeric parts of a version such as 0.4.0, or undefined for other strings. */
function versionParts(version: string): number[] | undefined {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	return match ? match.slice(1).map(Number) : undefined;
}

/** True when `a` is an older version than `b`. Versions that are no numbers never count as older. */
export function isOlder(a: string, b: string): boolean {
	const left = versionParts(a);
	const right = versionParts(b);
	if (!left || !right) return false;
	for (let i = 0; i < 3; i++) {
		const x = left[i] ?? 0;
		const y = right[i] ?? 0;
		if (x !== y) return x < y;
	}
	return false;
}

/** The old supervisor removes its socket when it closes. */
async function waitUntilGone(socketPath: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const connection = await tryConnect(socketPath);
		if (!connection) return;
		connection.socket.destroy();
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("The old supervisor did not stop.");
}

async function tryConnect(socketPath: string): Promise<Connection | undefined> {
	try {
		return await connect(socketPath);
	} catch {
		return undefined;
	}
}

async function startSupervisor(paths: StatePaths, context: BootContext): Promise<Connection> {
	mkdirSync(paths.root, { recursive: true, mode: 0o700 });
	const deadline = Date.now() + START_TIMEOUT_MS;
	let spawned = false;
	try {
		while (Date.now() < deadline) {
			const connection = await tryConnect(paths.supervisorSocket);
			if (connection) return connection;
			// One client starts the supervisor. The others wait for its socket.
			if (!spawned && takeLock(paths.supervisorLock)) {
				spawned = true;
				spawnSupervisor(paths, context);
			}
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
	} finally {
		if (spawned) rmSync(paths.supervisorLock, { force: true });
	}
	throw new Error(`The supervisor did not start. See ${paths.supervisorLog}`);
}

function takeLock(file: string): boolean {
	try {
		const fd = openSync(file, "wx", 0o600);
		writeSync(fd, String(process.pid));
		closeSync(fd);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	if (lockIsStale(file)) {
		rmSync(file, { force: true });
		return takeLock(file);
	}
	return false;
}

function lockIsStale(file: string): boolean {
	try {
		if (Date.now() - statSync(file).mtimeMs > STALE_LOCK_MS) return true;
		const pid = Number.parseInt(readFileSync(file, "utf8"), 10);
		if (!Number.isFinite(pid)) return true;
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "EPERM";
	}
}

function spawnSupervisor(paths: StatePaths, context: BootContext): void {
	const fd = openSync(paths.supervisorLog, "a", 0o600);
	try {
		const child = spawn(process.execPath, [path.join(context.root, "boot.mjs"), "supervisor", "--pi-dir", context.piDir], {
			cwd: homedir(),
			detached: true,
			stdio: ["ignore", fd, fd],
			// The supervisor serves the agent dir of these paths, whatever the env of this client says.
			env: { ...process.env, PI_CODING_AGENT_DIR: paths.agentDir },
		});
		child.unref();
	} finally {
		closeSync(fd);
	}
}
