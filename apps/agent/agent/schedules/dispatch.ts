import { defineSchedule } from "eve/schedules";
import crm from "../channels/crm";
import {
	pendingAgentRunIds,
	pendingBuilderSubmissionIds,
	queueDueAgentRuns,
} from "../lib/custom-agent-dispatch";
import { brief, drainAll, taskAuth } from "../lib/dispatch";
import {
	dispatchModelSessions,
	modelDispatchConcurrency,
} from "../lib/model-dispatch";

export default defineSchedule({
	cron: "* * * * *",
	async run({ receive, waitUntil, appAuth }) {
		waitUntil(
			(async () => {
				await drainAll((task) =>
					receive(crm, {
						message: brief(task),
						target: { taskId: task.id },
						auth: taskAuth(task, appAuth),
					}),
				);
				await queueDueAgentRuns();
				const [builderIds, runIds] = await Promise.all([
					pendingBuilderSubmissionIds(),
					pendingAgentRunIds(),
				]);
				const launches = [
					...builderIds.map((id) => ({ id, kind: "builder" as const })),
					...runIds.map((id) => ({ id, kind: "runner" as const })),
				].slice(0, modelDispatchConcurrency());

				await dispatchModelSessions(launches, (launch) =>
					launch.kind === "builder"
						? receive(crm, {
								message: "Continue a queued private agent-builder chat.",
								target: { builderSubmissionId: launch.id },
								auth: appAuth,
							})
						: receive(crm, {
								message: "Execute a queued deployed agent run.",
								target: { runId: launch.id },
								auth: appAuth,
							}),
				);
			})(),
		);
	},
});
