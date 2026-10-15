#!/usr/bin/env node
// Starts the TypeScript parts of this package: a worker, the supervisor, or the pi-sm CLI.
// This file is plain JavaScript, because Node refuses to strip types from .ts files under
// node_modules, where pi installs packages. It loads the TypeScript through the jiti that
// pi ships. A worker also gets pi itself, so it shares one pi instance with the extensions.
//
// Usage: node boot.mjs <worker|supervisor|cli> --pi-dir <dir> [arguments of the role]
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PI_PACKAGE = "@earendil-works/pi-coding-agent";

function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** The pi package: PI_SM_PI_DIR, or the package that owns the pi on PATH. */
export function findPiDir(env = process.env) {
	if (env.PI_SM_PI_DIR) return path.resolve(env.PI_SM_PI_DIR);
	for (const dir of (env.PATH ?? "").split(path.delimiter)) {
		const bin = path.join(dir, "pi");
		if (!dir || !existsSync(bin)) continue;
		let current = path.dirname(realpathSync(bin));
		while (current !== path.dirname(current)) {
			if (readJson(path.join(current, "package.json"))?.name === PI_PACKAGE) return current;
			current = path.dirname(current);
		}
	}
	throw new Error("pi-session-manager: no pi on PATH. Set PI_SM_PI_DIR to the pi-coding-agent package.");
}

export async function boot(role, piDir, argv) {
	const requireFromPi = createRequire(path.join(piDir, "package.json"));
	const importFromPi = (specifier) => import(pathToFileURL(requireFromPi.resolve(specifier)).href);
	const { createJiti } = await importFromPi("jiti");
	// Imports of pi and pi-tui in this package get the copies that pi uses itself, as in pi's extension loader.
	const sdkFile = path.join(piDir, "dist/index.js");
	const tuiFile = requireFromPi.resolve("@earendil-works/pi-tui");
	const jiti = createJiti(import.meta.url, {
		alias: { "@earendil-works/pi-coding-agent": sdkFile, "@earendil-works/pi-tui": tuiFile },
	});
	const context = { piDir, root: ROOT, version: readJson(path.join(ROOT, "package.json"))?.version ?? "0.0.0" };

	if (role === "worker") {
		const sdk = await import(pathToFileURL(sdkFile).href);
		const tui = await importFromPi("@earendil-works/pi-tui");
		const worker = await jiti.import(path.join(ROOT, "worker.ts"));
		const deps = { StdinBuffer: tui.StdinBuffer, setKittyProtocolActive: tui.setKittyProtocolActive };
		await worker.runWorker(sdk, deps, worker.parseWorkerArgs(argv, piDir));
	} else if (role === "supervisor") {
		const supervisor = await jiti.import(path.join(ROOT, "supervisor.ts"));
		await supervisor.runSupervisor(context, argv);
	} else if (role === "cli") {
		const cli = await jiti.import(path.join(ROOT, "cli.ts"));
		process.exitCode = await cli.main(context, argv);
	} else {
		throw new Error(`boot.mjs: unknown role "${role}".`);
	}
}

function runAsScript() {
	const [role, ...rest] = process.argv.slice(2);
	const index = rest.indexOf("--pi-dir");
	if (!role || index === -1 || !rest[index + 1]) {
		process.stderr.write("usage: node boot.mjs <worker|supervisor|cli> --pi-dir <dir> [arguments]\n");
		process.exit(2);
	}
	const piDir = path.resolve(rest[index + 1]);
	rest.splice(index, 2);
	boot(role, piDir, rest).catch((error) => {
		process.stderr.write(`${error?.stack ?? error}\n`);
		process.exit(1);
	});
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) runAsScript();
