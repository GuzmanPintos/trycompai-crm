import "@crm/env/load";

import { onTelemetryProblem, syncVersion } from "@crm/telemetry";
import { defineAgent } from "eve";
import {
	APPROVED_BIFROST_CONTEXT_WINDOW_TOKENS,
	defineBifrostModel,
} from "./lib/bifrost";
import { logCapabilities } from "./lib/capabilities";
import { selectedModel } from "./lib/model";

void logCapabilities();

onTelemetryProblem((message) => console.debug(`[telemetry] ${message}`));

void syncVersion();

export default defineAgent({
	model: defineBifrostModel(() => selectedModel()),
	modelContextWindowTokens: APPROVED_BIFROST_CONTEXT_WINDOW_TOKENS,
	reasoning: "high",
	limits: {
		maxInputTokensPerSession: 500_000,
		maxOutputTokensPerSession: 50_000,
		sessionTimeoutMs: 30 * 24 * 60 * 60 * 1000,
	},
});
