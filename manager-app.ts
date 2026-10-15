// pi-sm without a command: the manager in a terminal of its own, with no pi session (spec §5.2).
// ⏎ attaches this terminal to a session. A detach brings the manager back.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ProcessTerminal, TuiMainScreen, type TUI } from "@earendil-works/pi-tui";
import { macTranslator } from "./cli.ts";
import { attachLoop, describeEnd } from "./client.ts";
import type { BootContext, StatePaths } from "./paths.ts";
import { RemoteSource } from "./remote-source.ts";
import { ManagerView, type ManagerOptions, type ManagerResult } from "./ui.ts";

/** Colors without a theme, for a pi whose theme module moved. */
const PLAIN_THEME = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

/** The theme of the user's pi settings. pi does not export its theme module, so it loads by path. */
async function loadTheme(piDir: string, agentDir: string): Promise<any> {
	let name = "dark";
	try {
		const settings = JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8"));
		if (typeof settings?.theme === "string" && settings.theme) name = settings.theme;
	} catch {
		// Without settings, pi uses the dark theme too.
	}
	try {
		const url = pathToFileURL(path.join(piDir, "dist/modes/interactive/theme/theme.js")).href;
		const themes = await import(url);
		themes.initTheme(name, false);
		return themes.theme;
	} catch {
		return PLAIN_THEME;
	}
}

export async function runManagerApp(context: BootContext, paths: StatePaths): Promise<number> {
	const theme = await loadTheme(context.piDir, paths.agentDir);
	const source = new RemoteSource(paths, context);
	await source.ensureConnected();
	const tui = new TuiMainScreen(new ProcessTerminal());
	const translate = await macTranslator(paths.agentDir);
	let notice: ManagerOptions["notice"];
	try {
		for (;;) {
			const result = await showManager(tui, { theme, source, cwd: process.cwd(), notice });
			if (!result) return 0;
			const streams = { input: process.stdin, output: process.stdout, translate };
			const { result: end, id } = await attachLoop((next) => source.attach(next), result.id, streams);
			notice = { text: describeEnd(end, id), type: end.kind === "error" ? "error" : "info" };
		}
	} finally {
		source.dispose();
	}
}

function showManager(tui: TUI, options: Omit<ManagerOptions, "tui" | "done">): Promise<ManagerResult> {
	return new Promise((resolve) => {
		const view = new ManagerView({
			...options,
			tui,
			done: (result) => {
				tui.removeChild(view);
				tui.stop();
				resolve(result);
			},
		});
		tui.addChild(view);
		tui.setFocus(view);
		tui.start();
		tui.requestRender(true);
	});
}
