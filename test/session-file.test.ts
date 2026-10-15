import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { appendSessionName, branchOf, nameOf, readSessionFile } from "../session-file.ts";
import { firstUserText, lastExchange, transcriptOf, usageOf } from "../transcript.ts";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "conversation.jsonl");
const dir = mkdtempSync(path.join(tmpdir(), "pism-file-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("a session file gives its header, branch, name, and first prompt", () => {
	const { header, entries } = readSessionFile(FIXTURE);
	assert.equal(header?.cwd, "/tmp");
	assert.equal(entries.length, 6);
	assert.equal(branchOf(entries).length, 6);
	assert.equal(nameOf(entries), "fixture");
	assert.equal(firstUserText(entries), "Count the files in this folder.");
});

test("the branch follows the parents of the last entry", () => {
	const entries = [
		{ id: "1", parentId: null },
		{ id: "2", parentId: "1" },
		{ id: "3", parentId: "1" },
	];
	assert.deepEqual(
		branchOf(entries).map((e) => e.id),
		["1", "3"],
	);
	// Entries of old pi versions carry no ids. They form one branch.
	assert.equal(branchOf([{ type: "message" }, { type: "message" }]).length, 2);
});

test("transcript, last exchange, and usage come from the messages", () => {
	const branch = branchOf(readSessionFile(FIXTURE).entries);
	assert.deepEqual(transcriptOf(branch), [
		{ kind: "user", text: "Count the files\nin this folder." },
		{ kind: "assistant", text: "I will look." },
		{ kind: "tool", text: "bash ls | wc -l" },
		{ kind: "assistant", text: "The folder holds 7 files." },
	]);
	assert.deepEqual(lastExchange(branch), { prompt: "Count the files in this folder.", reply: "The folder holds 7 files." });
	const usage = usageOf(branch);
	assert.equal(usage.input, 220);
	assert.equal(usage.cacheRead, 2100);
	assert.equal(usage.cost, 0.75);
	assert.equal(usage.userMessages, 1);
	assert.equal(usage.assistantMessages, 2);
	assert.equal(usage.toolCalls, 1);
});

test("a new name lands at the end of the branch", () => {
	const file = path.join(dir, "named.jsonl");
	copyFileSync(FIXTURE, file);
	appendSessionName(file, "renamed\nsession");
	const { entries } = readSessionFile(file);
	assert.equal(nameOf(entries), "renamed session");
	assert.equal(entries.at(-1).parentId, "a0000006");
	assert.equal(branchOf(entries).length, 7);
});
