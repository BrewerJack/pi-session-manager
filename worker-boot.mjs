#!/usr/bin/env node
// Starts a worker. This file is plain JavaScript, because Node refuses to strip types
// from .ts files under node_modules, where pi installs packages.
//
// It imports pi natively from --pi-dir, then loads worker.ts through the jiti that pi
// ships. worker.ts gets pi passed in, so pi and its extensions share one module instance.
//
// Usage: node worker-boot.mjs --pi-dir <dir> --id <id> --socket <path> --info <path>
//        --log <path> --cwd <dir> [--session <file>] [--task <text>]
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		"pi-dir": { type: "string" },
		id: { type: "string" },
		socket: { type: "string" },
		info: { type: "string" },
		log: { type: "string" },
		cwd: { type: "string" },
		session: { type: "string" },
		task: { type: "string" },
	},
});

for (const name of ["pi-dir", "id", "socket", "info", "log", "cwd"]) {
	if (!values[name]) {
		process.stderr.write(`worker-boot: --${name} is required\n`);
		process.exit(2);
	}
}

const piDir = path.resolve(values["pi-dir"]);
const requireFromPi = createRequire(path.join(piDir, "package.json"));
const importFromPi = (specifier) => import(pathToFileURL(requireFromPi.resolve(specifier)).href);

const sdk = await import(pathToFileURL(path.join(piDir, "dist/index.js")).href);
const tui = await importFromPi("@earendil-works/pi-tui");
const { createJiti } = await importFromPi("jiti");

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { runWorker } = await jiti.import(path.join(here, "worker.ts"));

await runWorker(
	sdk,
	{ StdinBuffer: tui.StdinBuffer, setKittyProtocolActive: tui.setKittyProtocolActive },
	{
		id: values.id,
		socket: values.socket,
		infoFile: values.info,
		logFile: values.log,
		cwd: values.cwd,
		sessionFile: values.session,
		task: values.task,
		piDir,
	},
);
