// [tenki] Model access through the in-cluster Bifrost gateway.
//
// Upstream passes model-ID strings to eve, which resolves them through the
// Vercel AI Gateway. That gateway speaks Vercel's own protocol (it POSTs to
// `${baseURL}/language-model`, see @ai-sdk/gateway), so it is NOT something an
// OpenAI-compatible endpoint can stand in for by swapping a base URL. We have to
// construct a real provider client instead.
//
// Bifrost exposes an OpenAI-compatible surface at
//   http://bifrost.bifrost.svc.cluster.local:8080/openai/v1
// and requires auth (`enforceAuthOnInference: true`), so BIFROST_API_KEY is a
// Bifrost virtual key.
//
// Model IDs: the settings UI stores gateway-style IDs like "zai/glm-5.2-fast"
// (see DEFAULT_AGENT_MODEL in packages/db/src/settings.ts). Bifrost also uses
// "provider/model" routing, so IDs pass through unchanged. If a stored ID is not
// routable on this Bifrost the request fails at call time, which is eve's
// documented behaviour for a selected model without credentials.

// `ai` is not a direct dependency of apps/agent (eve owns it), so take the
// model type from the provider package we do depend on.
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";

type BifrostLanguageModel = ReturnType<OpenAIProvider["chat"]>;

const BASE_URL = process.env.BIFROST_BASE_URL ?? "";
const API_KEY = process.env.BIFROST_API_KEY ?? "";

/** True when this install is wired to Bifrost rather than the Vercel gateway. */
export function bifrostConfigured(): boolean {
	return BASE_URL.length > 0 && API_KEY.length > 0;
}

const provider = bifrostConfigured()
	? createOpenAI({
			apiKey: API_KEY,
			baseURL: BASE_URL,
			name: "bifrost",
		})
	: null;

/**
 * Resolves a stored model ID to a live `LanguageModel` routed through Bifrost.
 *
 * Returns `null` when Bifrost is not configured, so callers fall back to eve's
 * default gateway-string behaviour instead of failing closed — an unconfigured
 * install should degrade the same way upstream does.
 *
 * Only safe to return from a `step.started` resolver: eve requires session- and
 * turn-scoped selections to be serializable ID strings, and only accepts live
 * model objects at step scope.
 */
export function bifrostModel(id: string): BifrostLanguageModel | null {
	if (provider === null) return null;
	return provider.chat(id);
}
