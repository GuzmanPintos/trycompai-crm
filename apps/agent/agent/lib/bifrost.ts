import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { type DynamicResolveContext, defineDynamic } from "eve";

export const APPROVED_BIFROST_BASE_URL = "https://llm.eddiewang.me/openai";
export const APPROVED_BIFROST_MODEL = "openai/gpt-5.6-sol";
export const APPROVED_BIFROST_CONTEXT_WINDOW_TOKENS = 400_000;

const BUILD_PLACEHOLDER_API_KEY = "bifrost-build-placeholder-not-a-secret";
const DEFAULT_ROUTABLE_PREFIXES = "openai/";

type BifrostLanguageModel = ReturnType<OpenAIProvider["chat"]>;

export interface BifrostStoredSelection {
	model: string;
	modelContextWindowTokens: number;
}

export interface BifrostResolvedModel {
	model: BifrostLanguageModel;
	substituted: boolean;
}

type SelectionResolver = (
	event: unknown,
	ctx: DynamicResolveContext,
) => BifrostStoredSelection | null | Promise<BifrostStoredSelection | null>;

let runtimeProvider:
	| {
			apiKey: string;
			baseURL: string;
			provider: OpenAIProvider;
	  }
	| undefined;

function provider(apiKey: string, baseURL: string): OpenAIProvider {
	if (
		runtimeProvider?.apiKey === apiKey &&
		runtimeProvider.baseURL === baseURL
	) {
		return runtimeProvider.provider;
	}

	const next = createOpenAI({ apiKey, baseURL, name: "bifrost" });
	runtimeProvider = { apiKey, baseURL, provider: next };
	return next;
}

function runtimeConfiguration(): { apiKey: string; baseURL: string } {
	const baseURL = process.env.BIFROST_BASE_URL?.trim() ?? "";
	const apiKey = process.env.BIFROST_API_KEY?.trim() ?? "";
	if (!baseURL || !apiKey) {
		throw new Error(
			"Bifrost configuration error: BIFROST_BASE_URL and BIFROST_API_KEY are required at runtime.",
		);
	}
	return { apiKey, baseURL };
}

function routablePrefixes(): string[] {
	return (
		process.env.BIFROST_ROUTABLE_PREFIXES?.trim() || DEFAULT_ROUTABLE_PREFIXES
	)
		.split(",")
		.map((prefix) => prefix.trim())
		.filter(Boolean);
}

function routable(id: string): boolean {
	return routablePrefixes().some((prefix) => id.startsWith(prefix));
}

export function bifrostFallbackModel(): BifrostLanguageModel {
	const baseURL =
		process.env.BIFROST_BASE_URL?.trim() || APPROVED_BIFROST_BASE_URL;
	const apiKey =
		process.env.BIFROST_API_KEY?.trim() || BUILD_PLACEHOLDER_API_KEY;
	return provider(apiKey, baseURL).chat(APPROVED_BIFROST_MODEL);
}

export function bifrostModel(id: string): BifrostResolvedModel {
	const { apiKey, baseURL } = runtimeConfiguration();
	const selected = routable(id) ? id : APPROVED_BIFROST_MODEL;
	if (selected !== id) {
		console.warn(
			`[agent] model "${id}" is not routable on Bifrost; using "${APPROVED_BIFROST_MODEL}".`,
		);
	}
	return {
		model: provider(apiKey, baseURL).chat(selected),
		substituted: selected !== id,
	};
}

export function resolveBifrostSelection(
	selection: BifrostStoredSelection | null,
) {
	const requested = selection ?? {
		model: APPROVED_BIFROST_MODEL,
		modelContextWindowTokens: APPROVED_BIFROST_CONTEXT_WINDOW_TOKENS,
	};
	const resolved = bifrostModel(requested.model);
	return {
		model: resolved.model,
		modelContextWindowTokens: resolved.substituted
			? APPROVED_BIFROST_CONTEXT_WINDOW_TOKENS
			: requested.modelContextWindowTokens,
	};
}

export function defineBifrostModel(resolveSelection: SelectionResolver) {
	return defineDynamic({
		fallback: bifrostFallbackModel(),
		events: {
			"step.started": async (event, ctx) =>
				resolveBifrostSelection(await resolveSelection(event, ctx)),
		},
	});
}
