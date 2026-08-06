import {
	type AuthFn,
	extractBearerToken,
	localDev,
	vercelOidc,
	verifyJwtHmac,
	withAuthChallenges,
} from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export const BRIDGE_ISSUER = "crm-app";
export const BRIDGE_AUDIENCE = "crm-agent";

export function repFromCrm(secret: string): AuthFn<Request> {
	return withAuthChallenges(
		async (request: Request) => {
			const result = await verifyJwtHmac(
				extractBearerToken(request.headers.get("authorization")),
				{
					algorithm: "HS256",
					audiences: [BRIDGE_AUDIENCE],
					issuer: BRIDGE_ISSUER,
					secret,
				},
			);

			if (!result.ok) return null;

			const claims = result.sessionAuth;
			const userId = claims.subject;
			if (!userId) return null;

			return {
				attributes: claims.attributes ?? {},
				authenticator: "crm-app",
				principalId: userId,
				principalType: "user" as const,
			};
		},
		[{ scheme: "Bearer" }],
	);
}

const secret = process.env.AGENT_BRIDGE_SECRET;

// [tenki] Drop localDev() outside development.
//
// localDev() authorizes any request whose Host looks like loopback. On Vercel
// that is unreachable (the platform normalizes Host), but in a Kubernetes
// cluster the agent Service is addressable by every other pod, and Host is
// entirely caller-controlled. eve's own docs warn about exactly this: "a
// deployment that trusts an attacker-controlled Host header ... lets an attacker
// spoof Host: localhost and reach localDev(). Layer a real authenticator on such
// deployments."
//
// Verified against this image on a private docker network, from another
// container with no credentials at all:
//   POST /eve/v1/session                      -> 401
//   POST /eve/v1/session  (Host: localhost)   -> 400 "Missing ... 'message'"
// i.e. the spoofed request got PAST auth into the handler. That is
// unauthenticated access to the research agent: model spend, and the CRM data
// the agent can read.
//
// The bridge token (repFromCrm) is the real authenticator and is what the web
// app mints per signed-in rep, so nothing legitimate depends on localDev here.
const isDevelopment = process.env.NODE_ENV !== "production";

export default eveChannel({
	auth: [
		...(secret ? [repFromCrm(secret)] : []),
		vercelOidc(),
		...(isDevelopment ? [localDev()] : []),
	],
});
