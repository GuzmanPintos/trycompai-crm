import { afterEach, describe, expect, it } from "bun:test";
import type { Cache } from "cache-manager";
import { ModelCatalogService } from "../src/settings/model-catalog.service";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

function memoryCache(): Cache {
	const values = new Map<string, unknown>();
	return {
		get: async <T>(key: string) => values.get(key) as T | undefined,
		set: async (key: string, value: unknown) => {
			values.set(key, value);
		},
	} as Cache;
}

describe("production model catalog", () => {
	it("serves the deployment-owned approved model without an external fetch", async () => {
		globalThis.fetch = (async () => {
			throw new Error("external model catalog fetch attempted");
		}) as unknown as typeof fetch;
		const catalog = new ModelCatalogService(memoryCache());

		expect(await catalog.models()).toEqual([
			{
				id: "openai/gpt-5.6-terra",
				name: "GPT-5.6 Terra",
				provider: "openai",
				contextWindowTokens: 400_000,
				pricing: null,
			},
		]);
		expect(await catalog.find("zai/glm-5.2-fast")).toBeNull();
	});
});
