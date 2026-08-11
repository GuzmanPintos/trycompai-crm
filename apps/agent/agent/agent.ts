import "@crm/env/load";

import { DEFAULT_AGENT_MODEL } from "@crm/db/settings";
import { onTelemetryProblem, syncVersion } from "@crm/telemetry";
import { defineAgent, defineDynamic } from "eve";
// [tenki]
import {
	bifrostConfigured,
	bifrostDefaultContextWindowTokens,
	bifrostModel,
} from "./lib/bifrost";
import { logCapabilities } from "./lib/capabilities";
import { selectedModel } from "./lib/model";

void logCapabilities();

onTelemetryProblem((message) => console.debug(`[telemetry] ${message}`));

void syncVersion();

// [tenki] Self-hosted: models come from the in-cluster Bifrost gateway, not the
// Vercel AI Gateway. eve only accepts live LanguageModel objects from a
// `step.started` resolver (session/turn selections must be serializable ID
// strings), so the Bifrost path resolves there. `fallback` stays a string
// because it anchors build-time metadata. When Bifrost is unconfigured this
// collapses to exactly upstream's behaviour.
export default defineAgent({
	model: defineDynamic({
		fallback: DEFAULT_AGENT_MODEL.id,
		events: bifrostConfigured()
			? {
					"step.started": async () => {
						const selection = await selectedModel();
						const id = selection?.model ?? DEFAULT_AGENT_MODEL.id;
						const resolved = bifrostModel(id);
						if (resolved === null) return null;

						// On substitution the stored window describes the model the
						// user picked, not the one we are about to call, and eve
						// never inherits the window — so use the substitute's.
						const substituteWindow = resolved.substituted
							? bifrostDefaultContextWindowTokens()
							: null;

						return {
							model: resolved.model,
							modelContextWindowTokens:
								substituteWindow ??
								selection?.modelContextWindowTokens ??
								DEFAULT_AGENT_MODEL.contextWindowTokens,
						};
					},
				}
			: { "session.started": () => selectedModel() },
	}),
	// [tenki] Keep production model calls on the explicitly approved reasoning
	// policy. Eve maps this provider-agnostic level to Bifrost/OpenAI requests.
	reasoning: "high",
	limits: {
		maxInputTokensPerSession: 500_000,
		maxOutputTokensPerSession: 50_000,
		sessionTimeoutMs: 30 * 24 * 60 * 60 * 1000,
	},
});
