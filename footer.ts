// Per-session token breakdown for the status line in the footer of pi.

export interface FooterEntry {
	name: string;
	/** Input, output, and cache tokens together. */
	tokens: number;
	/** Context use in percent, or null when pi does not know it yet. */
	contextPercent: number | null;
	cost: number;
	current: boolean;
	saved: boolean;
}

/** The theme subset that the breakdown uses. */
export interface FooterTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

const NAME_WIDTH = 14;

export function compactTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function compactCost(cost: number): string {
	if (cost <= 0) return "";
	return cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
}

/** One decimal below 10%, like the footer of pi, so a fresh session does not read 0%. */
export function compactPercent(percent: number): string {
	return percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}

function shortName(name: string): string {
	const clean = name.replace(/\s+/g, " ").trim();
	return clean.length > NAME_WIDTH ? `${clean.slice(0, NAME_WIDTH - 1)}…` : clean;
}

/**
 * One line, total first: the footer cuts the line at the screen width, so the total
 * must come before the per-session parts. Fewer than two sessions give an empty string.
 */
export function formatBreakdown(entries: readonly FooterEntry[], theme: FooterTheme): string {
	if (entries.length < 2) return "";
	const total = entries.reduce((sum, e) => sum + e.tokens, 0);
	const cost = entries.reduce((sum, e) => sum + e.cost, 0);
	const totalText = ["Σ", compactTokens(total), compactCost(cost)].filter(Boolean).join(" ");
	const parts = entries.map((e) => {
		const percent = e.contextPercent == null ? "" : ` ${compactPercent(e.contextPercent)}`;
		const text = `${shortName(e.name)} ${compactTokens(e.tokens)}${percent}`;
		if (e.current) return theme.bold(theme.fg("accent", text));
		return theme.fg(e.saved ? "dim" : "muted", e.saved ? `◇ ${text}` : text);
	});
	return `${theme.fg("muted", totalText)}${theme.fg("dim", " │ ")}${parts.join(theme.fg("dim", " · "))}`;
}
