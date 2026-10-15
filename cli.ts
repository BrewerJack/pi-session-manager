// pi-sm: manage background pi sessions from the shell. bin/pi-sm.mjs runs main().
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { attachLoop, describeEnd } from "./client.ts";
import type { CreateRequest, SessionRecord } from "./control.ts";
import { loadEnvAllow, pickEnv } from "./env.ts";
import { loadKeyConfig, macModifierProbe, macOptionTranslator } from "./keys.ts";
import { agentDirFrom, statePaths, type BootContext, type StatePaths } from "./paths.ts";
import { connectSupervisor, isOlder, type SupervisorHandle } from "./supervisor-client.ts";

const USAGE = `usage: pi-sm [command]

  (no command)                      Open the manager. Without a terminal, list the sessions.
  list [--json]                     List every session.
  new [options] [task…]             Start a session. Without --bg, attach to it.
      --cwd <dir>                   Folder of the session. Default: the current folder.
      --name <name>                 Name of the session.
      --session <file>              Open a saved pi session file.
      --bg                          Do not attach.
  attach <session>                  Attach this terminal. Detach with ctrl+d or /quit.
  stop <session>                    Stop a session. Its session file stays.
  daemon status                     Show the supervisor.
  daemon stop [--keep-workers]      Stop the supervisor, and its sessions unless --keep-workers.

<session> is an id, a name, an id prefix, or the start of a name or first prompt.`;

type Command = (context: BootContext, paths: StatePaths, args: string[]) => Promise<number>;

const COMMANDS: Record<string, Command> = {
	manager: managerCommand,
	list: listCommand,
	ls: listCommand,
	new: newCommand,
	attach: attachCommand,
	stop: stopCommand,
	daemon: daemonCommand,
};

export async function main(context: BootContext, argv: string[]): Promise<number> {
	const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	const [name = interactive ? "manager" : "list", ...args] = argv;
	if (name === "help" || name === "--help" || name === "-h") {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	const command = COMMANDS[name];
	if (!command) {
		process.stderr.write(`pi-sm: unknown command "${name}".\n${USAGE}\n`);
		return 2;
	}
	try {
		return await command(context, statePaths(agentDirFrom()), args);
	} catch (error) {
		process.stderr.write(`pi-sm: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

async function open(context: BootContext, paths: StatePaths, start = true): Promise<SupervisorHandle> {
	const handle = await connectSupervisor(paths, context, { start });
	// An older supervisor restarts on connect. A newer one stays, and this client may lack its features.
	if (isOlder(context.version, handle.version)) {
		process.stderr.write(`pi-sm: the supervisor runs ${handle.version}, this client is ${context.version}.\n`);
	}
	return handle;
}

async function managerCommand(context: BootContext, paths: StatePaths): Promise<number> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("the manager needs a terminal.");
	// The manager loads pi-tui and the theme of pi. The other commands start faster without them.
	const { runManagerApp } = await import("./manager-app.ts");
	return runManagerApp(context, paths);
}

async function listCommand(context: BootContext, paths: StatePaths, args: string[]): Promise<number> {
	const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
	const handle = await open(context, paths);
	try {
		const { sessions } = await handle.connection.request<{ sessions: SessionRecord[] }>({ type: "list" });
		if (values.json) {
			// The env of a record stays out of the output.
			const out = sessions.map(({ env: _env, ...rest }) => rest);
			process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
		} else {
			process.stdout.write(`${formatTable(sessions)}\n`);
		}
		return 0;
	} finally {
		handle.connection.close();
	}
}

async function newCommand(context: BootContext, paths: StatePaths, args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			cwd: { type: "string" },
			name: { type: "string" },
			session: { type: "string" },
			bg: { type: "boolean" },
		},
	});
	const sessionFile = values.session ? path.resolve(values.session) : undefined;
	if (sessionFile && !existsSync(sessionFile)) throw new Error(`The session file ${sessionFile} does not exist.`);
	// A saved session runs in its own folder, not in the folder of this shell.
	const cwd = path.resolve(values.cwd ?? (sessionFile && sessionCwd(sessionFile)) ?? process.cwd());
	if (!existsSync(cwd)) throw new Error(`The folder ${cwd} does not exist.`);
	const allow = loadEnvAllow(path.join(paths.agentDir, "settings.json"));
	const request: CreateRequest = {
		cwd,
		task: positionals.join(" ").trim() || undefined,
		name: values.name,
		sessionFile,
		env: pickEnv(process.env, allow),
		piDir: context.piDir,
	};
	const handle = await open(context, paths);
	let record: SessionRecord;
	try {
		({ record } = await handle.connection.request<{ record: SessionRecord }>({ type: "create", request }, 120_000));
	} finally {
		handle.connection.close();
	}
	process.stderr.write(`started ${record.id}\n`);
	if (values.bg) return 0;
	return attachTo(context, paths, record.id);
}

/** The cwd in the header line of a pi session file. */
function sessionCwd(file: string): string | undefined {
	try {
		const header = JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0] ?? "");
		return header?.type === "session" && typeof header.cwd === "string" ? header.cwd : undefined;
	} catch {
		return undefined;
	}
}

async function attachCommand(context: BootContext, paths: StatePaths, args: string[]): Promise<number> {
	const target = args.join(" ").trim();
	if (!target) throw new Error("attach needs a session.");
	return attachTo(context, paths, target);
}

async function attachTo(context: BootContext, paths: StatePaths, target: string): Promise<number> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("attach needs a terminal.");
	const streams = { input: process.stdin, output: process.stdout, translate: await macTranslator(paths.agentDir) };
	const { result, id } = await attachLoop((next) => resolveSocket(context, paths, next), target, streams);
	const text = describeEnd(result, id);
	process.stderr.write(result.kind === "error" ? `pi-sm: ${text}\n` : `${text}\n`);
	return result.kind === "error" ? 1 : 0;
}

/**
 * On macOS, the Option key of the shortcut types a character such as "ß". The client turns it
 * into the shortcut, because the worker cannot ask macOS about the keyboard (spec §11).
 */
export async function macTranslator(agentDir: string): Promise<((data: string) => string) | undefined> {
	if (process.platform !== "darwin") return undefined;
	try {
		const { getNativeClipboard } = await import("@earendil-works/pi-tui");
		const keys = loadKeyConfig(path.join(agentDir, "settings.json"), process.env);
		return macOptionTranslator(keys, macModifierProbe(getNativeClipboard));
	} catch {
		return undefined;
	}
}

/** The worker socket of a session, from a short connection to the supervisor. */
async function resolveSocket(context: BootContext, paths: StatePaths, target: string): Promise<{ id: string; socket: string }> {
	const handle = await open(context, paths);
	try {
		return await handle.connection.request({ type: "attach", session: target }, 120_000);
	} finally {
		handle.connection.close();
	}
}

async function stopCommand(context: BootContext, paths: StatePaths, args: string[]): Promise<number> {
	const target = args.join(" ").trim();
	if (!target) throw new Error("stop needs a session.");
	const handle = await open(context, paths);
	try {
		await handle.connection.request({ type: "stop", session: target }, 60_000);
	} finally {
		handle.connection.close();
	}
	process.stderr.write(`stopped ${target}\n`);
	return 0;
}

async function daemonCommand(context: BootContext, paths: StatePaths, args: string[]): Promise<number> {
	const [sub, ...rest] = args;
	if (sub === "status") {
		let handle: SupervisorHandle;
		try {
			handle = await connectSupervisor(paths, context, { start: false });
		} catch {
			process.stdout.write("The supervisor does not run.\n");
			return 3;
		}
		try {
			const { sessions } = await handle.connection.request<{ sessions: SessionRecord[] }>({ type: "list" });
			const live = sessions.filter((s) => s.pid).length;
			process.stdout.write(
				`The supervisor runs.\n  version   ${handle.version}\n  pid       ${handle.pid}\n` +
					`  socket    ${paths.supervisorSocket}\n  log       ${paths.supervisorLog}\n` +
					`  sessions  ${sessions.length} (${live} with a running worker)\n`,
			);
			return 0;
		} finally {
			handle.connection.close();
		}
	}
	if (sub === "stop") {
		const { values } = parseArgs({ args: rest, options: { "keep-workers": { type: "boolean" } } });
		let handle: SupervisorHandle;
		try {
			handle = await connectSupervisor(paths, context, { start: false });
		} catch {
			process.stdout.write("The supervisor does not run.\n");
			return 0;
		}
		await handle.connection.request({ type: "shutdown", keepWorkers: values["keep-workers"] === true }, 60_000);
		handle.connection.close();
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline && pidAlive(handle.pid)) await new Promise((resolve) => setTimeout(resolve, 100));
		process.stdout.write(values["keep-workers"] ? "The supervisor stopped. The sessions keep running.\n" : "The supervisor and its sessions stopped.\n");
		return 0;
	}
	throw new Error('daemon needs "status" or "stop".');
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Table

const STATE_LABEL: Record<SessionRecord["state"], string> = {
	starting: "starting",
	working: "working",
	waiting: "needs input",
	idle: "idle",
	saved: "saved",
	failed: "failed",
};

export function formatTable(sessions: SessionRecord[], now = Date.now()): string {
	if (!sessions.length) return "No sessions.";
	const rows = sessions.map((s) => {
		const outcome = s.state === "idle" && s.lastOutcome ? ` (${s.lastOutcome})` : "";
		return [
			s.id,
			STATE_LABEL[s.state] + outcome,
			truncate(s.name || s.firstPrompt || "new session", 40),
			shortPath(s.cwd),
			fmtAgo(s.lastActivityAt, now),
		];
	});
	const header = ["ID", "STATE", "NAME", "FOLDER", "ACTIVE"];
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
	return [header, ...rows].map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ")).join("\n");
}

function truncate(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function shortPath(dir: string): string {
	const home = homedir();
	return dir === home || dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
}

export function fmtAgo(at: number, now = Date.now()): string {
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}
