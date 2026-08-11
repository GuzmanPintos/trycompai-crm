import { db } from "@crm/db";
import { defineAgent } from "eve";
import { z } from "zod";
import {
	APPROVED_BIFROST_CONTEXT_WINDOW_TOKENS,
	defineBifrostModel,
} from "../../lib/bifrost";
import { attribute, purposeOf } from "../../lib/session-purpose";

export default defineAgent({
	description:
		"Execute one immutable deployed CRM agent version and persist its result and every side effect.",
	model: defineBifrostModel(async (_event, ctx) => {
		if (purposeOf(ctx) !== "team-agent") return null;
		const runId = attribute(ctx, "runId");
		if (!runId) return null;

		const run = await db.agentRun.findUnique({
			where: { id: runId },
			select: {
				version: {
					select: { modelId: true, modelContextWindowTokens: true },
				},
			},
		});
		return run
			? {
					model: run.version.modelId,
					modelContextWindowTokens: run.version.modelContextWindowTokens,
				}
			: null;
	}),
	modelContextWindowTokens: APPROVED_BIFROST_CONTEXT_WINDOW_TOKENS,
	reasoning: "high",
	outputSchema: z.object({
		summary: z.string().min(1).max(1000),
		result: z.record(z.string(), z.unknown()).nullable(),
	}),
	limits: {
		maxInputTokensPerSession: 500_000,
		maxOutputTokensPerSession: 40_000,
		sessionTimeoutMs: 24 * 60 * 60 * 1000,
	},
});
