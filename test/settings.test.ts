import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { DEFAULT_IDLE_MINUTES, readManagerSettings } from "../settings.ts";

const dir = mkdtempSync(path.join(tmpdir(), "pism-settings-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function settings(value: unknown): string {
	const file = path.join(dir, `${Math.random()}.json`);
	writeFileSync(file, JSON.stringify(value));
	return file;
}

test("defaults without a file or a section", () => {
	assert.deepEqual(readManagerSettings(path.join(dir, "missing.json"), {}), { startDetached: false, idleMinutes: DEFAULT_IDLE_MINUTES });
	assert.deepEqual(readManagerSettings(settings({ theme: "dark" }), {}), { startDetached: false, idleMinutes: 60 });
});

test("the section sets startDetached and idleMinutes, and the env wins for startDetached", () => {
	const file = settings({ sessionManager: { startDetached: true, idleMinutes: 15 } });
	assert.deepEqual(readManagerSettings(file, {}), { startDetached: true, idleMinutes: 15 });
	assert.equal(readManagerSettings(file, { PI_SESSION_MANAGER_START_DETACHED: "0" }).startDetached, false);
	assert.equal(readManagerSettings(settings({}), { PI_SESSION_MANAGER_START_DETACHED: "1" }).startDetached, true);
});

test("bad idle values fall back to the default, and 0 turns reaping off", () => {
	assert.equal(readManagerSettings(settings({ sessionManager: { idleMinutes: -5 } }), {}).idleMinutes, 60);
	assert.equal(readManagerSettings(settings({ sessionManager: { idleMinutes: "soon" } }), {}).idleMinutes, 60);
	assert.equal(readManagerSettings(settings({ sessionManager: { idleMinutes: 0 } }), {}).idleMinutes, 0);
});
