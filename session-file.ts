// Read and annotate pi session files without pi. The supervisor uses this for saved
// sessions, which have no worker to ask. A session file is JSONL: a header, then entries
// that point to their parent. pi continues from the last entry when it opens a file.
import { appendFileSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

export interface SessionFile {
	header?: { cwd?: string; id?: string };
	entries: any[];
}

export function readSessionFile(file: string): SessionFile {
	const out: SessionFile = { entries: [] };
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let value: any;
		try {
			value = JSON.parse(line);
		} catch {
			// pi skips broken lines too.
			continue;
		}
		if (value?.type === "session") out.header = value;
		else if (value && typeof value === "object") out.entries.push(value);
	}
	return out;
}

/** The entries from the root to the last entry. Files of old pi versions without ids are one branch. */
export function branchOf(entries: readonly any[]): any[] {
	const last = entries.at(-1);
	if (!last || typeof last.id !== "string") return [...entries];
	const byId = new Map<string, any>();
	for (const entry of entries) if (typeof entry?.id === "string") byId.set(entry.id, entry);
	const branch: any[] = [];
	const seen = new Set<string>();
	let current: any = last;
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		branch.push(current);
		current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
	}
	return branch.reverse();
}

/** The latest name of a session. An empty name clears it. */
export function nameOf(entries: readonly any[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type === "session_info") return typeof entry.name === "string" && entry.name.trim() ? entry.name : undefined;
	}
	return undefined;
}

/** Name a saved session the way pi's SessionManager.appendSessionInfo does. */
export function appendSessionName(file: string, name: string): void {
	const { entries } = readSessionFile(file);
	const ids = new Set(entries.map((e) => e?.id));
	let id = randomBytes(4).toString("hex");
	while (ids.has(id)) id = randomBytes(4).toString("hex");
	const entry = {
		type: "session_info",
		id,
		parentId: entries.at(-1)?.id ?? null,
		timestamp: new Date().toISOString(),
		name: name.replace(/[\r\n]+/g, " ").trim(),
	};
	appendFileSync(file, `${JSON.stringify(entry)}\n`);
}
