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
	assert.ok(timer);
	// The grace timer must not keep the worker alive by itself.
	assert.equal(timer.hasRef(), false);
	clearTimeout(timer);
});

test("an orphan without attachments exits at once", () => {
	const exits: number[] = [];
	const timer = endOrphan(undefined, noLog, (code) => void exits.push(code));
	assert.deepEqual(exits, [0]);
	assert.equal(timer, undefined);
});

test("an orphan exits at once when the shutdown fails to start", () => {
	const exits: number[] = [];
	const lines: unknown[][] = [];
	const stop = () => {
		throw new TypeError("this.mode.shutdown is not a function");
	};
	endOrphan({ stop }, (...args: unknown[]) => void lines.push(args), (code) => void exits.push(code), 60_000);
	assert.deepEqual(exits, [0]);
	assert.equal(lines.length, 1);
});

test("an orphan exits by force when the shutdown hangs", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const exits: number[] = [];
	const lines: unknown[][] = [];
	endOrphan({ stop: () => {} }, (...args: unknown[]) => void lines.push(args), (code) => void exits.push(code), 15_000);
	t.mock.timers.tick(14_999);
	assert.deepEqual(exits, []);
	t.mock.timers.tick(1);
	assert.deepEqual(exits, [0]);
	assert.equal(lines.length, 1);
});
