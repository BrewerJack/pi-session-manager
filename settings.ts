// The "sessionManager" key of pi's global settings.json, as far as this package reads it
// outside keys.ts and env.ts. A missing or broken file gives the defaults.
import { readFileSync } from "node:fs";

export interface ManagerSettings {
	/** Plain pi opens the manager at once and keeps its own session out of sight (spec §5.2). */
	startDetached: boolean;
	/** An idle session without a client loses its worker after this many minutes (spec §7.6). 0 turns it off. */
	idleMinutes: number;
}

export const DEFAULT_IDLE_MINUTES = 60;

export function readManagerSettings(settingsPath: string, env: Record<string, string | undefined> = process.env): ManagerSettings {
	let section: any = {};
	try {
		section = JSON.parse(readFileSync(settingsPath, "utf8"))?.sessionManager ?? {};
	} catch {
		section = {};
	}
	const fromEnv = env.PI_SESSION_MANAGER_START_DETACHED;
	const startDetached = fromEnv !== undefined ? fromEnv === "1" || fromEnv === "true" : section.startDetached === true;
	const minutes = Number(section.idleMinutes);
	const idleMinutes = Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_IDLE_MINUTES;
	return { startDetached, idleMinutes };
}
