// The session runtime of a worker. It is the createRuntime of pi's main, without CLI flags
// and without a trust prompt. A new session also takes over the model, thinking level, and
// tools of the session that started it (spec §7.2). pi comes in as `sdk`, so this module
// imports types only.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Inheritance } from "./control.ts";
import type { Log } from "./filelog.ts";

type Sdk = typeof import("@earendil-works/pi-coding-agent");

/** The options that a new session takes over. */
interface SessionOptions {
	model?: any;
	thinkingLevel?: any;
	scopedModels?: any[];
	tools?: string[];
}

function sameModel(a: any, b: { provider?: string; id?: string } | undefined): boolean {
	return Boolean(a && b && a.provider === b.provider && a.id === b.id);
}

/** A model by provider and id, if the runtime has it and holds a login for its provider. */
function usableModel(modelRuntime: any, provider: string, modelId: string): any {
	const model = modelRuntime?.getModel?.(provider, modelId);
	return model && modelRuntime.hasConfiguredAuth?.(model.provider) ? model : undefined;
}

function hasMessages(sessionManager: any): boolean {
	try {
		return (sessionManager.buildSessionContext?.().messages?.length ?? 0) > 0;
	} catch {
		return false;
	}
}

/**
 * A session with history keeps its own model, and pi restores it from the file. A new
 * session takes the model, thinking level, and tools of the session that started it.
 * enabledModels in the settings limit the choice, as in pi's main.
 */
async function resolveOptions(piDir: string, services: any, sessionManager: any, inherit: Inheritance): Promise<SessionOptions> {
	const existing = hasMessages(sessionManager);
	const options: SessionOptions = {};
	if (inherit.tools) options.tools = [...inherit.tools];
	const wanted = inherit.model;
	if (!existing) {
		if (wanted) options.model = usableModel(services.modelRuntime, wanted.provider, wanted.id);
		if (inherit.thinkingLevel) options.thinkingLevel = inherit.thinkingLevel;
	}
	const patterns = services.settingsManager?.getEnabledModels?.();
	if (!patterns?.length) return options;
	const resolver = await import(pathToFileURL(path.join(piDir, "dist/core/model-resolver.js")).href);
	const scopedModels = await resolver.resolveModelScope(patterns, services.modelRuntime);
	if (!scopedModels?.length) return options;
	options.scopedModels = scopedModels;
	if (existing) return options;
	const provider = services.settingsManager?.getDefaultProvider?.();
	const modelId = services.settingsManager?.getDefaultModel?.();
	const fallback = provider && modelId ? { provider, id: modelId } : undefined;
	const selected =
		scopedModels.find((scoped: any) => sameModel(scoped.model, wanted)) ??
		scopedModels.find((scoped: any) => sameModel(scoped.model, fallback)) ??
		scopedModels[0];
	options.model = selected.model;
	if (selected.thinkingLevel) options.thinkingLevel = selected.thinkingLevel;
	return options;
}

/**
 * The factory that pi calls for the first session, and again on /new and /resume.
 * `extension` reports to the supervisor. pi passes it to every runtime, so it survives both.
 */
export function createRuntimeFactory(
	sdk: Sdk,
	piDir: string,
	extension: (pi: ExtensionAPI) => void,
	inherit: Inheritance,
	log: Log,
) {
	const trustStore = new sdk.ProjectTrustStore(sdk.getAgentDir());
	return async ({ cwd, agentDir, sessionManager, sessionStartEvent }: any) => {
		const projectTrusted = !sdk.hasTrustRequiringProjectResources(cwd) || trustStore.get(cwd) === true;
		const settingsManager = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted });
		const services = await sdk.createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager,
			resourceLoaderOptions: { extensionFactories: [extension] },
		});
		if (!projectTrusted) {
			services.diagnostics.push({ type: "warning", message: `Project resources are not trusted: ${cwd}` });
		}
		let options: SessionOptions = {};
		try {
			options = await resolveOptions(piDir, services, sessionManager, inherit);
		} catch (error) {
			log("inherited options skipped", error);
			services.diagnostics.push({ type: "warning", message: `The inherited model and tools did not apply: ${String(error)}` });
		}
		const created = await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, ...options });
		return { ...created, services, diagnostics: services.diagnostics };
	};
}

/** pi's main applies these after it creates the runtime. The public API of pi lacks them. */
export async function applyNetworkSettings(piDir: string, settingsManager: any, log: Log): Promise<void> {
	try {
		const http = await import(pathToFileURL(path.join(piDir, "dist/core/http-dispatcher.js")).href);
		http.applyHttpProxySettings?.(settingsManager.getGlobalSettings().httpProxy);
		http.configureHttpDispatcher?.(settingsManager.getHttpIdleTimeoutMs());
	} catch (error) {
		log("network settings skipped", error);
	}
}
