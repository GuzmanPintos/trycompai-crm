// [tenki] Guards the Bifrost model routing.
//
// The bug this exists for: upstream's DEFAULT_AGENT_MODEL is
// "zai/glm-5.2-fast", and the homelab Bifrost serves only openai/* ids —
// verified live, a chat completion for zai/glm-5.2-fast returns 400 while
// openai/gpt-5.4-mini returns 200. An unroutable id fails at REQUEST time, not
// at boot, so without a substitution the agent boots healthy and then silently
// never completes a session.
//
// bifrost.ts reads its env at module scope, so each case re-imports the module
// with a distinct query string to defeat the module cache.

import { beforeEach, describe, expect, it } from "bun:test";

type BifrostModule = typeof import("../agent/lib/bifrost");

let counter = 0;

async function loadBifrost(
	env: Record<string, string | undefined>,
): Promise<BifrostModule> {
	const keys = [
		"BIFROST_BASE_URL",
		"BIFROST_API_KEY",
		"BIFROST_DEFAULT_MODEL",
		"BIFROST_ROUTABLE_PREFIXES",
		"BIFROST_DEFAULT_MODEL_CONTEXT_WINDOW",
	];

	for (const key of keys) {
		const value = env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}

	counter += 1;
	return (await import(
		`../agent/lib/bifrost?case=${counter}`
	)) as BifrostModule;
}

const configured = {
	BIFROST_BASE_URL: "http://bifrost.invalid:8080/openai/v1",
	BIFROST_API_KEY: "test-virtual-key",
};

describe("bifrost model routing", () => {
	beforeEach(() => {
		process.env.CRM_TELEMETRY_DISABLED = "1";
	});

	it("is inactive when unconfigured, so an install degrades to upstream behaviour", async () => {
		const bifrost = await loadBifrost({
			BIFROST_BASE_URL: undefined,
			BIFROST_API_KEY: undefined,
		});

		expect(bifrost.bifrostConfigured()).toBe(false);
		expect(bifrost.bifrostModel("openai/gpt-5.4-mini")).toBeNull();
	});

	it("passes a routable id through untouched", async () => {
		const bifrost = await loadBifrost({
			...configured,
			BIFROST_ROUTABLE_PREFIXES: "openai/",
			BIFROST_DEFAULT_MODEL: "openai/gpt-5.4-mini",
		});

		const resolved = bifrost.bifrostModel("openai/gpt-5.5");
		expect(resolved).not.toBeNull();
		expect(resolved?.substituted).toBe(false);
		expect(resolved?.model.modelId).toBe("openai/gpt-5.5");
	});

	// The regression test. Without the routable/substitute logic this returns
	// the zai id and the agent 400s on every step.
	it("substitutes the default for an id this gateway cannot route", async () => {
		const bifrost = await loadBifrost({
			...configured,
			BIFROST_ROUTABLE_PREFIXES: "openai/",
			BIFROST_DEFAULT_MODEL: "openai/gpt-5.4-mini",
		});

		const resolved = bifrost.bifrostModel("zai/glm-5.2-fast");
		expect(resolved).not.toBeNull();
		expect(resolved?.substituted).toBe(true);
		expect(resolved?.model.modelId).toBe("openai/gpt-5.4-mini");
	});

	it("leaves ids alone when no prefix allow-list is configured", async () => {
		const bifrost = await loadBifrost({
			...configured,
			BIFROST_ROUTABLE_PREFIXES: undefined,
			BIFROST_DEFAULT_MODEL: "openai/gpt-5.4-mini",
		});

		const resolved = bifrost.bifrostModel("zai/glm-5.2-fast");
		expect(resolved?.substituted).toBe(false);
		expect(resolved?.model.modelId).toBe("zai/glm-5.2-fast");
	});

	it("reports the substitute's context window only when set", async () => {
		const withWindow = await loadBifrost({
			...configured,
			BIFROST_DEFAULT_MODEL_CONTEXT_WINDOW: "400000",
		});
		expect(withWindow.bifrostDefaultContextWindowTokens()).toBe(400_000);

		const withoutWindow = await loadBifrost({
			...configured,
			BIFROST_DEFAULT_MODEL_CONTEXT_WINDOW: undefined,
		});
		expect(withoutWindow.bifrostDefaultContextWindowTokens()).toBeNull();

		const garbage = await loadBifrost({
			...configured,
			BIFROST_DEFAULT_MODEL_CONTEXT_WINDOW: "not-a-number",
		});
		expect(garbage.bifrostDefaultContextWindowTokens()).toBeNull();
	});
});
