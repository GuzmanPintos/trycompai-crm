import { readFileSync } from "node:fs";

const manifestPath =
	process.argv[2] ?? ".output/.eve/compile/compiled-agent-manifest.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const builder = manifest.subagents.find(
	(subagent) => subagent.name === "agent_builder",
);
const runner = manifest.subagents.find(
	(subagent) => subagent.name === "agent_runner",
);

if (!builder || !runner) {
	throw new Error(
		"Compiled manifest is missing agent_builder or agent_runner.",
	);
}

const disabledFrameworkTools = [...manifest.disabledFrameworkTools].sort();
if (
	JSON.stringify(disabledFrameworkTools) !==
	JSON.stringify(["agent", "web_search"])
) {
	throw new Error(
		"Root must disable the agent and provider-defined web_search defaults.",
	);
}

for (const [name, node] of [
	["root", manifest],
	["agent_builder", builder.agent],
	["agent_runner", runner.agent],
]) {
	const config = node.config;
	const events = config.dynamicModel?.eventNames;
	if (JSON.stringify(events) !== JSON.stringify(["step.started"])) {
		throw new Error(`${name} must declare only a step.started model resolver.`);
	}
	if (
		config.model?.routing?.kind !== "external" ||
		config.model.routing.provider !== "bifrost"
	) {
		throw new Error(`${name} fallback must use the direct Bifrost provider.`);
	}
	if (config.model.id !== "bifrost/openai/gpt-5.6-terra") {
		throw new Error(`${name} fallback must use the approved Terra model.`);
	}
	if (config.model.contextWindowTokens !== 400_000) {
		throw new Error(`${name} fallback must use a 400000-token context window.`);
	}
	if (config.reasoning !== "high") {
		throw new Error(`${name} reasoning must be high.`);
	}
	if (config.compaction?.model !== undefined) {
		throw new Error(`${name} compaction must reuse the active model.`);
	}
}

console.log("Verified direct Bifrost routing for root, builder, and runner.");
