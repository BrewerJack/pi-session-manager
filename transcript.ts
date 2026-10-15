// Text, transcript, and usage helpers over pi session entries. The worker reads entries
// from its SessionManager, the supervisor reads them from the session file of a saved session.
// This module does not import pi.

export interface TranscriptItem {
	kind: "user" | "assistant" | "thinking" | "tool" | "toolError" | "info";
	text: string;
}

/** Token use and message counts of one session. */
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	contextTokens: number | null;
	contextWindow: number | null;
	contextPercent: number | null;
}

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		contextTokens: null,
		contextWindow: null,
		contextPercent: null,
	};
}

export function totalTokens(usage: Usage | undefined): number {
	return usage ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite : 0;
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part: any) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join(" ");
}

export function oneLine(text: string, max = 200): string {
	return text.replace(/\s+/g, " ").trim().slice(0, max);
}

export function summarizeToolArgs(toolName: string, args: any): string {
	if (!args || typeof args !== "object") return "";
	const pick = (...keys: string[]) => {
		for (const key of keys) {
			if (typeof args[key] === "string" && args[key].trim()) return args[key];
		}
		return undefined;
	};
	const value =
		(toolName === "bash" ? pick("command") : undefined) ??
		pick("path", "file_path", "filePath", "pattern", "query", "url", "command", "task", "prompt") ??
		Object.values(args).find((v) => typeof v === "string" && v.trim());
	return typeof value === "string" ? oneLine(value.split("\n")[0] ?? "", 120) : "";
}

/** The first user message of a session, on one line. */
export function firstUserText(entries: readonly any[]): string | undefined {
	for (const entry of entries) {
		if (entry?.type !== "message" || entry.message?.role !== "user") continue;
		const text = oneLine(textOf(entry.message.content));
		if (text) return text;
	}
	return undefined;
}

/** The conversation of a branch, as the detail screen shows it. */
export function transcriptOf(branch: readonly any[], maxItems = 80): TranscriptItem[] {
	const items: TranscriptItem[] = [];
	for (const entry of branch) {
		if (entry?.type === "compaction") {
			items.push({ kind: "info", text: "— conversation compacted —" });
			continue;
		}
		if (entry?.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role === "user") {
			const text = textOf(msg.content).trim();
			if (text) items.push({ kind: "user", text });
		} else if (msg?.role === "assistant" && Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (part?.type === "text" && part.text?.trim()) {
					items.push({ kind: "assistant", text: part.text.trim() });
				} else if (part?.type === "toolCall") {
					const detail = summarizeToolArgs(part.name, part.arguments);
					items.push({ kind: "tool", text: detail ? `${part.name} ${detail}` : part.name });
				}
			}
			if (msg.stopReason === "error" && msg.errorMessage) {
				items.push({ kind: "toolError", text: oneLine(msg.errorMessage, 300) });
			}
		} else if (msg?.role === "toolResult" && msg.isError) {
			items.push({ kind: "toolError", text: oneLine(textOf(msg.content), 300) || `${msg.toolName} failed` });
		} else if (msg?.role === "bashExecution") {
			items.push({ kind: "tool", text: `! ${oneLine(String(msg.command ?? ""), 200)}` });
		}
	}
	return items.slice(-maxItems);
}

/** The last user prompt and the last assistant text of a branch, for the preview. */
export function lastExchange(branch: readonly any[]): { prompt?: string; reply?: string } {
	const items = transcriptOf(branch, 200);
	let prompt: string | undefined;
	let reply: string | undefined;
	for (let i = items.length - 1; i >= 0 && (!prompt || !reply); i--) {
		const item = items[i]!;
		if (!reply && item.kind === "assistant") reply = item.text.slice(-2000);
		if (!prompt && item.kind === "user") prompt = oneLine(item.text);
	}
	return { prompt, reply };
}

/** Usage summed over the messages of a session. pi computes the context use, so it stays unknown here. */
export function usageOf(entries: readonly any[]): Usage {
	const out = emptyUsage();
	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role === "user") out.userMessages++;
		if (msg?.role !== "assistant") continue;
		out.assistantMessages++;
		if (Array.isArray(msg.content)) out.toolCalls += msg.content.filter((p: any) => p?.type === "toolCall").length;
		const u = msg.usage;
		if (!u) continue;
		out.input += u.input ?? 0;
		out.output += u.output ?? 0;
		out.cacheRead += u.cacheRead ?? 0;
		out.cacheWrite += u.cacheWrite ?? 0;
		out.cost += u.cost?.total ?? 0;
	}
	return out;
}
