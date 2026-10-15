#!/usr/bin/env node
// pi-sm: list, start, attach to, and stop pi sessions that run in the background.
import { boot, findPiDir } from "../boot.mjs";

try {
	await boot("cli", findPiDir(), process.argv.slice(2));
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
