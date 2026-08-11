import { describe, expect, it } from "bun:test";
import { DEFAULT_AGENT_MODEL } from "../src/settings";

describe("agent model defaults", () => {
	it("uses the approved production Bifrost model and context window", () => {
		expect(DEFAULT_AGENT_MODEL).toEqual({
			id: "openai/gpt-5.6-terra",
			contextWindowTokens: 400_000,
		});
	});
});
