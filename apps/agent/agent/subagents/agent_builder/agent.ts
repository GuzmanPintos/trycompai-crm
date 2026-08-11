import { defineAgent } from "eve";
import { z } from "zod";
import {
	APPROVED_BIFROST_CONTEXT_WINDOW_TOKENS,
	defineBifrostModel,
} from "../../lib/bifrost";
import { selectedModel } from "../../lib/model";

export default defineAgent({
	description:
		"Turn one private CRM builder-chat request into a validated, reviewable team-agent version without deploying it.",
	model: defineBifrostModel(() => selectedModel()),
	modelContextWindowTokens: APPROVED_BIFROST_CONTEXT_WINDOW_TOKENS,
	reasoning: "high",
	outputSchema: z.object({
		status: z.literal("draft_ready"),
		summary: z.string().min(1).max(1000),
		agentId: z.string().min(1),
		versionId: z.string().min(1),
	}),
	limits: {
		maxInputTokensPerSession: 100_000,
		maxOutputTokensPerSession: 10_000,
		sessionTimeoutMs: 24 * 60 * 60 * 1000,
	},
});
