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

export async function connectSupervisor(
	paths: StatePaths,
	context: BootContext,
	options: { start?: boolean } = {},
): Promise<SupervisorHandle> {
	let connection = await tryConnect(paths.supervisorSocket);
	if (!connection) {
		if (options.start === false) throw new Error("The supervisor does not run.");
		connection = await startSupervisor(paths, context);
	}
	const hello = await connection.request<{ version: string; pid: number }>({ type: "hello", version: context.version });
	return { connection, version: hello.version, pid: hello.pid };
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
			env: process.env,
		});
		child.unref();
	} finally {
		closeSync(fd);
	}
}
