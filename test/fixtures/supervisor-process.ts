// A supervisor in a process of its own, with fake workers, for the recovery test.
// Usage: node supervisor-process.ts <agent dir>. It prints "ready" once it listens.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { statePaths } from "../../paths.ts";
import { Supervisor, type StartWorker } from "../../supervisor.ts";

const FAKE_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-worker.mjs");
const paths = statePaths(process.argv[2]!);
const supervisor = new Supervisor({
	paths,
	version: "test",
	bootFile: "unused",
	log: () => {},
	sweepMs: 100,
	idleMs: 0,
	spawnWorker: ({ record }: StartWorker) => {
		const args = [FAKE_WORKER, paths.supervisorSocket, record.id];
		if (record.sessionFile) args.push(record.sessionFile);
		// The workers must outlive this process, as real workers do.
		const child = spawn(process.execPath, args, { stdio: "ignore", detached: true, env: { ...process.env, ...record.env } });
		child.unref();
		return child;
	},
});
if (await supervisor.start()) process.stdout.write("ready\n");
