const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^tk_\S+$/;
const DIGEST_IMAGE_PATTERN = /^\S+@sha256:[0-9a-f]{64}$/i;

export const DEFAULT_TENKI_ENDPOINT = "https://api.tenki.cloud";

export interface ProductionConfig {
	readonly authToken: string;
	readonly endpoint: string;
	readonly workspaceId: string;
}

function requiredValue(
	env: NodeJS.ProcessEnv,
	name: "TENKI_AUTH_TOKEN" | "TENKI_WORKSPACE_ID",
): string {
	const value = env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

export function isUuid(value: string): boolean {
	return UUID_PATTERN.test(value);
}

export function isImmutableDigestImage(value: string): boolean {
	return DIGEST_IMAGE_PATTERN.test(value);
}

export function requireProductionConfig(
	env: NodeJS.ProcessEnv = process.env,
): ProductionConfig {
	const authToken = requiredValue(env, "TENKI_AUTH_TOKEN");
	if (!TOKEN_PATTERN.test(authToken)) {
		throw new Error("TENKI_AUTH_TOKEN must use the tk_ token shape");
	}

	const workspaceId = requiredValue(env, "TENKI_WORKSPACE_ID");
	if (!isUuid(workspaceId)) {
		throw new Error("TENKI_WORKSPACE_ID must be a UUID");
	}

	const endpointValue = env.TENKI_BASE_URL?.trim() || DEFAULT_TENKI_ENDPOINT;
	let endpoint: URL;
	try {
		endpoint = new URL(endpointValue);
	} catch {
		throw new Error("TENKI_BASE_URL must be a valid HTTP or HTTPS URL");
	}
	if (
		(endpoint.protocol !== "https:" && endpoint.protocol !== "http:") ||
		endpoint.username !== "" ||
		endpoint.password !== ""
	) {
		throw new Error(
			"TENKI_BASE_URL must be a credential-free HTTP or HTTPS URL",
		);
	}

	return {
		authToken,
		endpoint: endpoint.href.replace(/\/$/, ""),
		workspaceId,
	};
}

export function acceptKnownOutboundBug(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env.TENKI_ACCEPT_KNOWN_OUTBOUND_BUG === "true";
}

export function requireSandboxImage(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const image = env.TENKI_SANDBOX_IMAGE?.trim();
	if (!image) throw new Error("TENKI_SANDBOX_IMAGE is required");
	if (isImmutableDigestImage(image)) return image;
	throw new Error(
		"TENKI_SANDBOX_IMAGE must be an immutable sha256 digest reference",
	);
}

export function createOutputSanitizer(
	secrets: readonly (string | undefined)[],
): (value: string) => string {
	const variants = secrets
		.flatMap((secret) => {
			if (!secret) return [];
			const encoded = encodeURIComponent(secret);
			return encoded === secret ? [secret] : [secret, encoded];
		})
		.sort((left, right) => right.length - left.length);

	return (value: string) => {
		let sanitized = value;
		for (const secret of variants)
			sanitized = sanitized.replaceAll(secret, "[REDACTED]");
		return sanitized;
	};
}

export function errorText(error: unknown): string {
	if (error instanceof Error) return error.stack || error.message;
	return String(error);
}
