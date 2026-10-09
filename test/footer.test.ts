import assert from "node:assert/strict";
import { test } from "node:test";
import { compactPercent, compactTokens, formatBreakdown, type FooterEntry, type FooterTheme } from "../footer.ts";

/** Marks styles in plain text, so the tests can see them. */
const theme: FooterTheme = {
	fg: (color, text) => (color === "accent" ? `<${text}>` : color === "dim" && text.startsWith("◇") ? `[${text}]` : text),
	bold: (text) => `*${text}*`,
};

function entry(name: string, tokens: number, extra: Partial<FooterEntry> = {}): FooterEntry {
	return { name, tokens, contextPercent: null, cost: 0, current: false, saved: false, ...extra };
}

test("one session shows nothing, because the footer of pi already covers it", () => {
	assert.equal(formatBreakdown([entry("main", 4400)], theme), "");
});

test("the total comes first, then each session with tokens and context use", () => {
	const line = formatBreakdown(
		[
			entry("main", 4400, { contextPercent: 0.4, current: true }),
			entry("fruit-bot", 7500, { contextPercent: 2.2, cost: 0.12 }),
			entry("tests", 81_000, { contextPercent: 12, cost: 1.3 }),
		],
		theme,
	);
	assert.equal(line, "Σ 93k $1.42 │ *<main 4.4k 0.4%>* · fruit-bot 7.5k 2.2% · tests 81k 12%");
});

test("saved sessions get a mark, and unknown context use stays out", () => {
	const line = formatBreakdown([entry("main", 10, { current: true }), entry("old", 2500, { saved: true })], theme);
	assert.equal(line, "Σ 2.5k │ *<main 10>* · [◇ old 2.5k]");
});

test("long names get cut to keep the line short", () => {
	const line = formatBreakdown([entry("main", 1), entry("Reply with exactly the word OK", 1)], theme);
	assert.ok(line.includes("Reply with ex… 1"), line);
});

test("token counts use k and M", () => {
	assert.equal(compactTokens(0), "0");
	assert.equal(compactTokens(999), "999");
	assert.equal(compactTokens(4400), "4.4k");
	assert.equal(compactTokens(81_000), "81k");
	assert.equal(compactTokens(2_500_000), "2.5M");
});

test("context use keeps one decimal below 10%", () => {
	assert.equal(compactPercent(0.4), "0.4%");
	assert.equal(compactPercent(9.94), "9.9%");
	assert.equal(compactPercent(12.4), "12%");
});
