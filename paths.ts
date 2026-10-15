// Where the supervisor, the workers, and the clients keep their state.
// This module does not import pi, so the supervisor and pi-sm start fast.
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

/** macOS allows 104 bytes for a Unix socket path, including the final NUL. */
const MAX_SOCKET_PATH = 103;
/** The longest worker socket name: an id of up to 48 characters plus ".sock". */
const LONGEST_SOCKET_NAME = 48 + ".sock".length;

/** What boot.mjs passes to the supervisor and the CLI. */
export interface BootContext {
	/** The pi package that runs workers. */
	piDir: string;
	/** The root of this package. */
	root: string;
	version: string;
}

export interface StatePaths {
	agentDir: string;
	/** <agentDir>/pi-session-manager */
	root: string;
	supervisorSocket: string;
	supervisorPid: string;
	/** A client holds this file while it starts the supervisor. */
	supervisorLock: string;
	supervisorLog: string;
	sessions: string;
	/** Worker logs. */
	workers: string;
	/** Worker sockets. Equals `workers`, unless that path is too long for a socket. */
	sockets: string;
}

/** The agent dir of pi: PI_CODING_AGENT_DIR, or ~/.pi/agent. Mirrors getAgentDir() of pi. */
export function agentDirFrom(env: Record<string, string | undefined> = process.env): string {
	const dir = env.PI_CODING_AGENT_DIR;
	if (!dir) return path.join(homedir(), ".pi", "agent");
	if (dir === "~") return homedir();
	if (dir.startsWith("~/")) return path.join(homedir(), dir.slice(2));
	return path.resolve(dir);
}

export function statePaths(agentDir: string, env: Record<string, string | undefined> = process.env): StatePaths {
	const root = path.join(agentDir, "pi-session-manager");
	const workers = path.join(root, "workers");
	let sockets = workers;
	if (path.join(workers, "x").length - 1 + LONGEST_SOCKET_NAME > MAX_SOCKET_PATH) {
		// Keep one socket directory for each agent dir, so two agent dirs never share a supervisor.
		const hash = createHash("sha256").update(agentDir).digest("hex").slice(0, 8);
		const base = env.XDG_RUNTIME_DIR || tmpdir();
		sockets = path.join(base, `pi-sm-${process.getuid?.() ?? "user"}-${hash}`);
	}
	return {
		agentDir,
		root,
		supervisorSocket: path.join(sockets === workers ? root : sockets, "supervisor.sock"),
		supervisorPid: path.join(root, "supervisor.pid"),
		supervisorLock: path.join(root, "supervisor.lock"),
		supervisorLog: path.join(root, "supervisor.log"),
		sessions: path.join(root, "sessions"),
		workers,
		sockets,
	};
}

export function recordFile(paths: StatePaths, id: string): string {
	return path.join(paths.sessions, `${id}.json`);
}

export function workerSocket(paths: StatePaths, id: string): string {
	return path.join(paths.sockets, `${id}.sock`);
}

export function workerLog(paths: StatePaths, id: string): string {
	return path.join(paths.workers, `${id}.log`);
}

/** A session id: the folder name, a time stamp, and a random suffix. At most 48 characters. */
export function newSessionId(cwd: string, now = Date.now()): string {
	const slug = path.basename(cwd).replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^[-.]+/, "").slice(0, 24) || "session";
	return `${slug}-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
