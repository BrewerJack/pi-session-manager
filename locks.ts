// Path locks: two live sessions must not write the same path tree at once.
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { debug } from "./log.ts";
function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

export function inferToolPaths(toolName: string, input: any): string[] {
	const paths = new Set<string>();
	if (toolName === "write" || toolName === "edit") {
		const p = asString(input?.path) || asString(input?.file_path) || asString(input?.filePath);
		if (p) paths.add(p);
	}
	if (toolName === "bash") {
		const command = asString(input?.command) || "";
		for (const m of command.matchAll(/(?:>|>>|2>|&>)\s*([^\s;&|]+)/g)) {
			const p = m[1];
			if (p && !p.startsWith("/dev/")) paths.add(p.replace(/^["']|["']$/g, ""));
		}
		const mutating =
			/\b(rm|mv|cp|touch|mkdir|rmdir|chmod|chown|install|tee|sed\s+-i|perl\s+-i|python\b.*\b(open|write)|node\b.*writeFile)\b/.test(
				command,
			);
		if (mutating) {
			for (const token of command.match(/(?:\.\.?|~|\/)?[\w@%+=:,./-]+/g) || []) {
				if (token.includes("/") || token.startsWith(".")) paths.add(token.replace(/^["']|["']$/g, ""));
			}
			if (paths.size === 0) paths.add(".");
		}
	}
	return [...paths];
}

/**
 * Resolve symlinks in the part of the path that exists. On macOS, /tmp and /var
 * point into /private, so two spellings can name one file.
 */
export function canonicalPath(absolute: string): string {
	let existing = absolute;
	const rest: string[] = [];
	while (!existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) return absolute;
		rest.unshift(path.basename(existing));
		existing = parent;
	}
	try {
		return path.join(realpathSync.native(existing), ...rest);
	} catch (error) {
		debug(error);
		return absolute;
	}
}

export function normalizeLockPath(p: string, cwd: string): string | null {
	if (!p || typeof p !== "string") return null;
	const absolute = p.startsWith("~")
		? path.join(os.homedir(), p.slice(1))
		: path.resolve(cwd || process.cwd(), p);
	return canonicalPath(absolute);
}

// macOS and Windows file systems ignore case by default, so Foo.ts and foo.ts are one file.
// On a case-sensitive volume, this only makes the locks a little stricter.
export const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

export function pathsConflict(rawA: string, rawB: string, caseInsensitive = CASE_INSENSITIVE_FS): boolean {
	const a = caseInsensitive ? rawA.toLowerCase() : rawA;
	const b = caseInsensitive ? rawB.toLowerCase() : rawB;
	const ar = a.endsWith(path.sep) ? a : a + path.sep;
	const br = b.endsWith(path.sep) ? b : b + path.sep;
	return a === b || a.startsWith(br) || b.startsWith(ar);
}

export class LockManager {
	readonly caseInsensitive: boolean;
	locks = new Map<string, { sessionId: string; acquiredAt: number }>();
	heldByToolCall = new Map<string, { sessionId: string; paths: string[] }>();

	constructor(options: { caseInsensitive?: boolean } = {}) {
		this.caseInsensitive = options.caseInsensitive ?? CASE_INSENSITIVE_FS;
	}

	acquire(sessionId: string, rawPaths: string[], cwd: string) {
		const paths = [
			...new Set(rawPaths.map((p) => normalizeLockPath(p, cwd)).filter((p): p is string => !!p)),
		].sort();
		const conflicts: { path: string; heldPath: string; by: string }[] = [];
		for (const p of paths) {
			for (const [held, info] of this.locks.entries()) {
				if (info.sessionId !== sessionId && pathsConflict(p, held, this.caseInsensitive)) {
					conflicts.push({ path: p, heldPath: held, by: info.sessionId });
				}
			}
		}
		if (conflicts.length) return { ok: false as const, conflicts };
		const acquiredAt = Date.now();
		for (const p of paths) this.locks.set(p, { sessionId, acquiredAt });
		return { ok: true as const, paths };
	}

	release(sessionId: string, rawPaths?: string[]): void {
		const wanted = rawPaths?.length ? new Set(rawPaths) : null;
		for (const [p, info] of this.locks.entries()) {
			if (info.sessionId === sessionId && (!wanted || wanted.has(p))) this.locks.delete(p);
		}
	}

	releaseByToolCall(toolCallId: string): void {
		const held = this.heldByToolCall.get(toolCallId);
		if (!held) return;
		this.heldByToolCall.delete(toolCallId);
		this.release(held.sessionId, held.paths);
	}

	heldBy(sessionId: string): string[] {
		return [...this.locks.entries()].filter(([, info]) => info.sessionId === sessionId).map(([p]) => p);
	}
}

