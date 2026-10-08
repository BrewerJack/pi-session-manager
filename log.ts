// Debug log for best-effort calls that must not interrupt the user.
import { appendFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Best-effort calls land here. Set PI_SESSION_MANAGER_DEBUG=1 to log them. */
export function debug(error: unknown): void {
	if (!process.env.PI_SESSION_MANAGER_DEBUG) return;
	try {
		const line = `${new Date().toISOString()} ${error instanceof Error ? error.stack : String(error)}\n`;
		appendFileSync(path.join(getAgentDir(), "pi-session-manager-debug.log"), line);
	} catch {
		// The debug log is optional. Nothing else can report this failure.
	}
}

