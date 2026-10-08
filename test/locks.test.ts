import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { canonicalPath, inferToolPaths, LockManager, pathsConflict } from "../locks.ts";

function workspace(): string {
	return realpathSync(mkdtempSync(path.join(tmpdir(), "psm-locks-")));
}

test("paths conflict when one contains the other", () => {
	assert.ok(pathsConflict("/a/b", "/a/b", false));
	assert.ok(pathsConflict("/a/b/c.ts", "/a/b", false));
	assert.ok(!pathsConflict("/a/bc", "/a/b", false));
});

test("case-insensitive file systems, such as the macOS default, treat Foo and foo as one path", () => {
	assert.ok(pathsConflict("/Users/me/App/Main.ts", "/users/me/app/main.ts", true));
	assert.ok(!pathsConflict("/Users/me/App/Main.ts", "/users/me/app/main.ts", false));
});

test("a symlinked folder, like /tmp on macOS, resolves to its real path", () => {
	const root = workspace();
	mkdirSync(path.join(root, "private-tmp"));
	symlinkSync(path.join(root, "private-tmp"), path.join(root, "tmp"));
	assert.equal(canonicalPath(path.join(root, "tmp", "new", "file.ts")), path.join(root, "private-tmp", "new", "file.ts"));
});

test("two sessions cannot lock one file through a symlink", () => {
	const root = workspace();
	mkdirSync(path.join(root, "real"));
	writeFileSync(path.join(root, "real", "x.ts"), "");
	symlinkSync(path.join(root, "real"), path.join(root, "link"));
	const locks = new LockManager({ caseInsensitive: false });
	assert.ok(locks.acquire("one", ["real/x.ts"], root).ok);
	const second = locks.acquire("two", ["link/x.ts"], root);
	assert.ok(!second.ok);
});

test("two sessions cannot lock one file through different case on macOS", () => {
	const root = workspace();
	const locks = new LockManager({ caseInsensitive: true });
	assert.ok(locks.acquire("one", ["Src/App.ts"], root).ok);
	assert.ok(!locks.acquire("two", ["src/app.ts"], root).ok);
	locks.release("one");
	assert.ok(locks.acquire("two", ["src/app.ts"], root).ok);
});

test("write, edit, and mutating bash commands report their paths", () => {
	assert.deepEqual(inferToolPaths("write", { path: "a.ts" }), ["a.ts"]);
	assert.deepEqual(inferToolPaths("bash", { command: "echo hi > out.txt" }), ["out.txt"]);
	assert.deepEqual(inferToolPaths("bash", { command: "ls -la" }), []);
});
