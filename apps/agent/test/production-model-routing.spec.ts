import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface CompiledConfig {
	compaction?: { model?: unknown };
	dynamicModel?: { eventNames?: string[] };
	model?: {
		contextWindowTokens?: number;
		routing?: { kind?: string; provider?: string };
	};
	reasoning?: string;
}

interface CompiledNode {
	config: CompiledConfig;
}

interface CompiledSubagent {
	name: string;
	agent: CompiledNode;
}

interface CompiledManifest extends CompiledNode {
	subagents: CompiledSubagent[];
}

describe("compiled production model routing", () => {
	it("keeps root, builder, and runner on direct Bifrost when build credentials are absent", async () => {
		const appRoot = join(import.meta.dir, "..");
		const build = Bun.spawn(["bun", "run", "build"], {
			cwd: appRoot,
			env: {
				...process.env,
				BIFROST_BASE_URL: "",
				BIFROST_API_KEY: "",
				CRM_TELEMETRY_DISABLED: "1",
				DATABASE_URL:
					"postgresql://build:build@127.0.0.1:5432/build?schema=public",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await build.exited;
		if (exitCode !== 0) {
			throw new Error(
				`eve build failed:\n${await new Response(build.stderr).text()}`,
			);
		}

		const manifest = JSON.parse(
			await readFile(
				join(appRoot, ".output/.eve/compile/compiled-agent-manifest.json"),
				"utf8",
			),
		) as CompiledManifest;
		const builder = manifest.subagents.find(
			(subagent) => subagent.name === "agent_builder",
		);
		const runner = manifest.subagents.find(
			(subagent) => subagent.name === "agent_runner",
		);
		expect(builder).toBeDefined();
		expect(runner).toBeDefined();

		for (const node of [manifest, builder?.agent, runner?.agent]) {
			expect(node?.config.dynamicModel?.eventNames).toEqual(["step.started"]);
			expect(node?.config.model?.routing).toEqual({
				kind: "external",
				provider: "bifrost",
			});
			expect(node?.config.model?.contextWindowTokens).toBe(400_000);
			expect(node?.config.reasoning).toBe("high");
			expect(node?.config.compaction?.model).toBeUndefined();
		}
	}, 60_000);
});
