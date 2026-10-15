// Append-only log files for the supervisor and the workers. Logging never throws.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { format } from "node:util";

export type Log = (...values: unknown[]) => void;

export function openLog(file: string): Log {
	try {
		mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	} catch {
		// appendFileSync reports nothing either. The log is best effort.
	}
	return (...values: unknown[]) => {
		try {
			appendFileSync(file, `${new Date().toISOString()} ${format(...values)}\n`, { mode: 0o600 });
		} catch {
			// The log is best effort.
		}
	};
}

/** A process without a terminal sends console output to its log. */
export function routeConsoleToLog(log: Log): void {
	console.log = (...values: unknown[]) => log(...values);
	console.info = (...values: unknown[]) => log(...values);
	console.warn = (...values: unknown[]) => log("warn:", ...values);
	console.error = (...values: unknown[]) => log("error:", ...values);
}
