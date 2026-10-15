import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { DEFAULT_ENV_ALLOW, isAllowed, loadEnvAllow, pickEnv, workerEnv } from "../env.ts";

const dir = mkdtempSync(path.join(tmpdir(), "pism-env-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function settings(value: unknown): string {
	const file = path.join(dir, `settings-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
	return file;
}

const client = {
	PATH: "/usr/bin",
	LANG: "en_US.UTF-8",
	LC_TIME: "de_DE.UTF-8",
	ANTHROPIC_API_KEY: "secret",
	AWS_SECRET_ACCESS_KEY: "secret",
	GITHUB_TOKEN: "secret",
	PI_OFFLINE: "1",
	PI_CODING_AGENT_DIR: "/elsewhere",
	PI_SESSION_FILE: "/one/session.jsonl",
};

test("the default list keeps shell and pi settings and drops credentials", () => {
	const picked = pickEnv(client, DEFAULT_ENV_ALLOW);
	assert.deepEqual(Object.keys(picked).sort(), ["LANG", "LC_TIME", "PATH", "PI_OFFLINE"]);
});

test("settings and PI_SESSION_MANAGER_ENV add names and prefixes", () => {
	const allow = loadEnvAllow(settings({ sessionManager: { env: ["AWS_*", "not valid", 3] } }), {
		PI_SESSION_MANAGER_ENV: " GITHUB_TOKEN , ",
	});
	const picked = pickEnv(client, allow);
	assert.equal(picked.AWS_SECRET_ACCESS_KEY, "secret");
	assert.equal(picked.GITHUB_TOKEN, "secret");
	assert.equal(picked.ANTHROPIC_API_KEY, undefined);
	assert.ok(!allow.includes("not valid"));
});

test("a missing or broken settings file leaves the defaults", () => {
	assert.deepEqual(loadEnvAllow(path.join(dir, "missing.json"), {}), [...DEFAULT_ENV_ALLOW]);
	assert.deepEqual(loadEnvAllow(settings("{broken"), {}), [...DEFAULT_ENV_ALLOW]);
});

test("denied names never pass, even when the user lists them", () => {
	const allow = [...DEFAULT_ENV_ALLOW, "PI_*"];
	assert.equal(isAllowed("PI_CODING_AGENT_DIR", allow), false);
	assert.equal(isAllowed("PI_SESSION_FILE", allow), false);
	assert.equal(isAllowed("PI_SESSION_MANAGER_WORKER", allow), false);
	assert.equal(isAllowed("PI_MODEL", allow), true);
});

test("a worker gets the supervisor env, the client values on top, and its own id", () => {
	const env = workerEnv(
		{ PATH: "/supervisor/bin", HOME: "/home/u", PI_CODING_AGENT_DIR: "/agent", PI_SESSION_FILE: "/x" },
		{ PATH: "/client/bin", PI_CODING_AGENT_DIR: "/elsewhere" },
		"w1",
	);
	assert.equal(env.PATH, "/client/bin");
	assert.equal(env.HOME, "/home/u");
	assert.equal(env.PI_CODING_AGENT_DIR, "/agent");
	assert.equal(env.PI_SESSION_FILE, undefined);
	assert.equal(env.PI_SESSION_MANAGER_WORKER, "w1");
});
