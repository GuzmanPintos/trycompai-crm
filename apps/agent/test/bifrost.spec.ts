import { beforeEach, describe, expect, it } from "bun:test";

interface BifrostModule {
	APPROVED_BIFROST_BASE_URL: string;
	APPROVED_BIFROST_CONTEXT_WINDOW_TOKENS: number;
	APPROVED_BIFROST_MODEL: string;
	bifrostFallbackModel(): {
		modelId: string;
		provider: string;
	};
	bifrostModel(id: string): {
		model: { modelId: string; provider: string };
		substituted: boolean;
	};
	resolveBifrostSelection(
		selection: { model: string; modelContextWindowTokens: number } | null,
	): {
		model: { modelId: string; provider: string };
		modelContextWindowTokens: number;
	};
}

let counter = 0;

async function loadBifrost(
	env: Record<string, string | undefined>,
): Promise<BifrostModule> {
	for (const key of [
		"BIFROST_BASE_URL",
		"BIFROST_API_KEY",
		"BIFROST_ROUTABLE_PREFIXES",
	]) {
		const value = env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}

	counter += 1;
	return (await import(
		`../agent/lib/bifrost?case=${counter}`
	)) as unknown as BifrostModule;
}

const configured = {
	BIFROST_BASE_URL: "https://llm.eddiewang.me/openai",
	BIFROST_API_KEY: "test-virtual-key",
};

describe("Bifrost model routing", () => {
	beforeEach(() => {
		process.env.CRM_TELEMETRY_DISABLED = "1";
	});

	it("constructs a direct Bifrost fallback without runtime credentials", async () => {
		const bifrost = await loadBifrost({
			BIFROST_BASE_URL: undefined,
			BIFROST_API_KEY: undefined,
		});

		const fallback = bifrost.bifrostFallbackModel();
		expect(fallback.provider).toBe("bifrost.chat");
		expect(fallback.modelId).toBe("openai/gpt-5.6-terra");
		expect(bifrost.APPROVED_BIFROST_BASE_URL).toBe(
			"https://llm.eddiewang.me/openai",
		);
		expect(bifrost.APPROVED_BIFROST_CONTEXT_WINDOW_TOKENS).toBe(400_000);
	});

	it("fails closed with a clear configuration error at runtime", async () => {
		const bifrost = await loadBifrost({
			BIFROST_BASE_URL: undefined,
			BIFROST_API_KEY: undefined,
		});

		expect(() => bifrost.bifrostModel("openai/gpt-5.6-terra")).toThrow(
			/Bifrost configuration error.*BIFROST_BASE_URL.*BIFROST_API_KEY/,
		);
	});

	it("passes a routable model through the direct provider", async () => {
		const bifrost = await loadBifrost({
			...configured,
			BIFROST_ROUTABLE_PREFIXES: "openai/",
		});

		const resolved = bifrost.bifrostModel("openai/gpt-5.5");
		expect(resolved.substituted).toBe(false);
		expect(resolved.model.provider).toBe("bifrost.chat");
		expect(resolved.model.modelId).toBe("openai/gpt-5.5");
	});

	it("substitutes the approved model and window for an unroutable selection", async () => {
		const bifrost = await loadBifrost({
			...configured,
			BIFROST_ROUTABLE_PREFIXES: "openai/",
		});

		const resolved = bifrost.resolveBifrostSelection({
			model: "zai/glm-5.2-fast",
			modelContextWindowTokens: 1_000_000,
		});
		expect(resolved.model.provider).toBe("bifrost.chat");
		expect(resolved.model.modelId).toBe(bifrost.APPROVED_BIFROST_MODEL);
		expect(resolved.modelContextWindowTokens).toBe(400_000);
	});

	it("uses the approved selection when no stored selection exists", async () => {
		const bifrost = await loadBifrost(configured);
		const resolved = bifrost.resolveBifrostSelection(null);

		expect(resolved.model.modelId).toBe("openai/gpt-5.6-terra");
		expect(resolved.modelContextWindowTokens).toBe(400_000);
	});
});
