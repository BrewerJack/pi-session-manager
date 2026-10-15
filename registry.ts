// Session records on disk: one JSON file per session in <root>/sessions/ (spec §6.1).
// Only the supervisor writes them. Each write goes to a temp file first, then a rename.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SessionRecord } from "./control.ts";

export class Registry {
	private readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	private file(id: string): string {
		return path.join(this.dir, `${id}.json`);
	}

	/** All readable records. A broken file stays on disk and does not show. */
	load(): SessionRecord[] {
		let names: string[];
		try {
			names = readdirSync(this.dir).filter((n) => n.endsWith(".json"));
		} catch {
			return [];
		}
		const records: SessionRecord[] = [];
		for (const name of names) {
			try {
				const record = JSON.parse(readFileSync(path.join(this.dir, name), "utf8")) as SessionRecord;
				if (record && typeof record.id === "string" && `${record.id}.json` === name) records.push(record);
			} catch {
				// A half-written file can not exist, because writes rename. Skip anything else.
			}
		}
		return records.sort((a, b) => a.createdAt - b.createdAt);
	}

	write(record: SessionRecord): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const target = this.file(record.id);
		const temp = `${target}.${process.pid}.tmp`;
		writeFileSync(temp, JSON.stringify(record, null, "\t"), { mode: 0o600 });
		renameSync(temp, target);
	}

	remove(id: string): void {
		rmSync(this.file(id), { force: true });
	}
}
