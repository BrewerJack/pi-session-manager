// The environment variables that a client passes to a new session (spec §6.3).
// Only allowed variables leave the client, and only they land in the session record.
import { readFileSync } from "node:fs";

/** The default allow list. It holds no credentials. An entry that ends in "*" is a prefix. */
export const DEFAULT_ENV_ALLOW: readonly string[] = [
	"PATH",
	"LANG",
	"LC_*",
	"TZ",
	"EDITOR",
	"VISUAL",
	"TERM",
	"COLORTERM",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"PI_CACHE_RETENTION",
	"PI_HARDWARE_CURSOR",
	"PI_HYPERLINKS",
	"PI_IMAGE_PROTOCOL",
	"PI_OFFLINE",
	"PI_SKIP_VERSION_CHECK",
	"PI_TELEMETRY",
	"PI_TRUE_COLOR",
	"PI_TUI_ESC_TIMEOUT",
];

/** These never pass. The first selects the supervisor. The others name one session only. */
export const ENV_DENY: readonly string[] = [
	"PI_CODING_AGENT_DIR",
	"PI_SESSION_FILE",
	"PI_SESSION_ID",
	"PI_SESSION_MANAGER_WORKER",
];

const NAME = /^[A-Za-z_][A-Za-z0-9_]*\*?$/;

function cleanEntries(values: unknown): string[] {
	if (!Array.isArray(values)) return [];
	return values.filter((v): v is string => typeof v === "string" && NAME.test(v.trim())).map((v) => v.trim());
}

/**
 * The allow list: the defaults, plus "sessionManager.env" of settings.json,
 * plus the comma-separated names in PI_SESSION_MANAGER_ENV.
 */
export function loadEnvAllow(settingsPath: string, env: Record<string, string | undefined> = process.env): string[] {
	let fromFile: unknown;
	try {
		fromFile = JSON.parse(readFileSync(settingsPath, "utf8"))?.sessionManager?.env;
	} catch {
		// A missing or broken settings file leaves the defaults in place.
		fromFile = undefined;
	}
	const fromEnv = (env.PI_SESSION_MANAGER_ENV ?? "").split(",");
	return [...new Set([...DEFAULT_ENV_ALLOW, ...cleanEntries(fromFile), ...cleanEntries(fromEnv)])];
}

export function isAllowed(name: string, allow: readonly string[]): boolean {
	if (ENV_DENY.includes(name)) return false;
	return allow.some((entry) => (entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : name === entry));
}

/** The allowed variables of an environment. */
export function pickEnv(env: Record<string, string | undefined>, allow: readonly string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (value !== undefined && isAllowed(name, allow)) out[name] = value;
	}
	return out;
}

/** The environment of a worker: the supervisor's, then the client's allowed variables on top. */
export function workerEnv(
	base: Record<string, string | undefined>,
	fromClient: Record<string, string>,
	workerId: string,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(base)) {
		if (value !== undefined && name !== "PI_SESSION_FILE" && name !== "PI_SESSION_ID") out[name] = value;
	}
	for (const [name, value] of Object.entries(fromClient)) {
		if (!ENV_DENY.includes(name)) out[name] = value;
	}
	out.PI_SESSION_MANAGER_WORKER = workerId;
	return out;
}
