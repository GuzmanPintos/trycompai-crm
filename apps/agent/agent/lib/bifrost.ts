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
// Model IDs: both sides use "provider/model", so IDs pass through unchanged.
//
// BUT upstream's DEFAULT_AGENT_MODEL is "zai/glm-5.2-fast" (see
// packages/db/src/settings.ts) and THIS Bifrost does not serve it. Verified
// against the live gateway on 2026-12-08: GET /openai/v1/models lists only
// openai/* ids (gpt-5.2 … gpt-5.6-terra), a chat completion for
// openai/gpt-5.4-mini returns 200, and the same call for zai/glm-5.2-fast
// returns 400. An unroutable id fails at request time, not at boot, so this
// would have surfaced as "the agent silently never finishes a session".
//
// Hence BIFROST_DEFAULT_MODEL: when the stored selection is a model this
// gateway cannot route, fall back to one it can. Configured in the deployment
// rather than hard-coded so adding a provider to Bifrost does not need a
// rebuild.

// `ai` is not a direct dependency of apps/agent (eve owns it), so take the
// model type from the provider package we do depend on.
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";

type BifrostLanguageModel = ReturnType<OpenAIProvider["chat"]>;

const BASE_URL = process.env.BIFROST_BASE_URL ?? "";
const API_KEY = process.env.BIFROST_API_KEY ?? "";

/**
 * Model used when the stored selection is not routable here. Empty means "pass
 * every id through untouched", which is the right behaviour for a Bifrost that
 * does serve the upstream default.
 */
const DEFAULT_MODEL = process.env.BIFROST_DEFAULT_MODEL ?? "";

/**
 * Prefixes this gateway can actually route, comma-separated (e.g. "openai/").
 * Empty disables the check. This is a cheap prefix test on purpose: querying
 * /v1/models at startup would make agent boot depend on the gateway being up,
 * and the failure mode we are guarding against is a *stale stored setting*,
 * not a typo.
 */
const ROUTABLE_PREFIXES = (process.env.BIFROST_ROUTABLE_PREFIXES ?? "")
	.split(",")
	.map((prefix) => prefix.trim())
	.filter((prefix) => prefix.length > 0);

function routable(id: string): boolean {
	if (ROUTABLE_PREFIXES.length === 0) return true;
	return ROUTABLE_PREFIXES.some((prefix) => id.startsWith(prefix));
}

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
 * Context window of BIFROST_DEFAULT_MODEL. Only consulted when a substitution
 * happens: the stored window belongs to the model the user picked, and
 * eve never inherits it, so carrying it over would let the agent pack a
 * context the substitute cannot hold.
 */
export function bifrostDefaultContextWindowTokens(): number | null {
	const raw = process.env.BIFROST_DEFAULT_MODEL_CONTEXT_WINDOW ?? "";
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

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
export function bifrostModel(
	id: string,
): { model: BifrostLanguageModel; substituted: boolean } | null {
	if (provider === null) return null;

	if (!routable(id) && DEFAULT_MODEL !== "") {
		console.warn(
			`[agent] model "${id}" is not routable on this Bifrost; using "${DEFAULT_MODEL}". ` +
				"Change it on the settings page to silence this.",
		);
		return { model: provider.chat(DEFAULT_MODEL), substituted: true };
	}

	return { model: provider.chat(id), substituted: false };
}
