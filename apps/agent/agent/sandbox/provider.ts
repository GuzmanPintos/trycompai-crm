import "@crm/env/load";

import { defaultBackend, type SandboxBackend } from "eve/sandbox";
import { tenkiBackend } from "./tenki";

export type SandboxProvider = "auto" | "tenki";

/**
 * One install, one sandbox provider.
 *
 * Provider credentials are deployment secrets and eve persists backend-specific
 * reconnect metadata, so this is deliberately process configuration rather than
 * a preference in the CRM UI. Leaving it unset preserves eve's normal Vercel →
 * Docker → microsandbox → just-bash selection.
 */
export function configuredSandboxBackend(
	env: NodeJS.ProcessEnv = process.env,
): SandboxBackend {
	const provider = readProvider(env.SANDBOX_PROVIDER);

	if (provider === "tenki") {
		const authToken = env.TENKI_AUTH_TOKEN?.trim() || env.TENKI_API_KEY?.trim();
		if (!authToken) {
			throw new Error(
				"SANDBOX_PROVIDER is tenki, but TENKI_API_KEY is not configured.",
			);
		}

		return tenkiBackend({
			clientOptions: {
				authToken,
				...(env.TENKI_API_ENDPOINT?.trim()
					? { baseUrl: env.TENKI_API_ENDPOINT.trim() }
					: {}),
			},
			networkPolicy: "deny-all",
		});
	}

	return defaultBackend({
		vercel: { networkPolicy: "deny-all" },
		docker: { networkPolicy: "deny-all" },
		microsandbox: { networkPolicy: "deny-all" },
	});
}

export function readProvider(value?: string): SandboxProvider {
	const provider = value?.trim().toLowerCase() || "auto";
	if (provider === "auto" || provider === "tenki") return provider;
	throw new Error(
		`Unknown SANDBOX_PROVIDER "${value}". Expected "auto" or "tenki".`,
	);
}
