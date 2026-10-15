import assert from "node:assert/strict";
import { test } from "node:test";
import { describeEnd } from "../cli.ts";
import { recap, RunState } from "../worker.ts";

const MIN = 60_000;

function run(fields: Partial<RunState>): RunState {
	return Object.assign(new RunState(), fields);
}

test("recap names the outcome and the time since the last look", () => {
	const now = 100 * MIN;
	const done = run({ lastOutcome: "done", settledAt: now - 4 * MIN, lastRunMs: 2 * MIN });
	assert.deepEqual(recap(done, now - 60 * MIN, now), {
		text: "✓ Done 4m ago after 2m. You last looked 1h 0m ago.",
		type: "info",
	});
	const failed = run({ lastOutcome: "error", error: "rate limit", settledAt: now - MIN });
	assert.equal(recap(failed, undefined, now)?.text, "✗ Failed 1m ago: rate limit.");
	assert.equal(recap(failed, undefined, now)?.type, "error");
	const aborted = run({ lastOutcome: "aborted", settledAt: now - 30_000 });
	assert.equal(recap(aborted, now - 5 * MIN, now)?.text, "■ Interrupted 30s ago. You last looked 5m ago.");
});

test("recap says nothing when nothing happened since the last look", () => {
	const now = 100 * MIN;
	assert.equal(recap(run({}), undefined, now), undefined);
	assert.equal(recap(run({}), now - MIN, now), undefined);
	const seen = run({ lastOutcome: "done", settledAt: now - 10 * MIN });
	assert.equal(recap(seen, now - 5 * MIN, now), undefined);
	// A first attach to a running session needs no recap: the spinner shows it.
	assert.equal(recap(run({ running: true, runStartedAt: now - MIN }), undefined, now), undefined);
});

test("recap reports a run in progress and an open dialog", () => {
	const now = 100 * MIN;
	const working = run({ running: true, runStartedAt: now - 3 * MIN });
	assert.equal(recap(working, now - 2 * MIN, now)?.text, "Still working for 3m. You last looked 2m ago.");
	const waiting = run({ running: true, dialogs: 1 });
	assert.deepEqual(recap(waiting, undefined, now), { text: "? This session waits for your input.", type: "warning" });
});

test("pi-sm explains why an attach ended", () => {
	assert.match(describeEnd({ kind: "detached", detached: { reason: "quit" } }, "a1"), /^Detached\. .*pi-sm attach a1/);
	assert.match(describeEnd({ kind: "closed" }, "a1"), /^Detached\./);
	assert.match(describeEnd({ kind: "detached", detached: { reason: "taken" } }, "a1"), /^Another terminal took over/);
	assert.equal(describeEnd({ kind: "detached", detached: { reason: "stopped", message: "Bye." } }, "a1"), "The session a1 stopped. Bye.");
	assert.equal(describeEnd({ kind: "error", message: "boom" }, "a1"), "pi-sm: boom");
});
