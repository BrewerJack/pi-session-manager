import assert from "node:assert/strict";
import { test } from "node:test";
import { endOrphan } from "../worker.ts";

const noLog = () => {};

test("an orphan with a session starts the shutdown and does not exit at once", () => {
	const stops: unknown[][] = [];
	const exits: number[] = [];
	const timer = endOrphan({ stop: (...args) => void stops.push(args) }, noLog, (code) => void exits.push(code), 60_000);
	assert.deepEqual(stops, [["stopped", "The supervisor is gone."]]);
	assert.deepEqual(exits, []);
	clearTimeout(timer);
});

test("an orphan without a session exits at once", () => {
	const exits: number[] = [];
	const timer = endOrphan(undefined, noLog, (code) => void exits.push(code));
	assert.deepEqual(exits, [0]);
	assert.equal(timer, undefined);
});

test("an orphan exits by force when the shutdown hangs", async () => {
	const exits: number[] = [];
	const lines: unknown[][] = [];
	endOrphan({ stop: () => {} }, (...args: unknown[]) => void lines.push(args), (code) => void exits.push(code), 10);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(exits, [0]);
	assert.equal(lines.length, 1);
});
