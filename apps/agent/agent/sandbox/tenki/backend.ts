// [tenki] eve SandboxBackend backed by the in-cluster Tenki sandbox-engine.
//
// WHY THIS EXISTS
// eve's defaultBackend() picks, in order: Vercel (when $VERCEL is set) → Docker
// daemon → microsandbox → just-bash. In a plain Kubernetes pod the first three
// are all absent, so it silently lands on just-bash: a pure-JS interpreter with a
// virtual filesystem and no real binaries. The agent's bash/grep/glob tools would
// appear to work and quietly do nothing useful. This backend is what makes the
// sandbox real off Vercel.
//
// EGRESS — READ THIS, IT IS NOT WHAT UPSTREAM ASSUMES
// Upstream sets networkPolicy "deny-all" on every backend deliberately. From the
// README: web_fetch runs in the app runtime and web_search at the model provider,
// so the sandbox needs no network, and deny-all removes "the only path by which a
// customer's email body could leave through a shell command". The other half of
// that rule is that the sandbox is never given DATABASE_URL.
//
// ⚠️ WE CANNOT CURRENTLY HONOUR THE FIRST HALF ON THIS ENGINE.
// We pass `allowOutbound: false`, but the homelab sandbox-engine ignores it.
// Measured directly against the live engine (2026-12-08):
//
//   requested allowOutbound=false -> session.outboundEnabled=true
//   requested allowOutbound=true  -> session.outboundEnabled=true
//   and inside such a session: curl https://example.com -> HTTP 200
//
// The engine is configured `session.default_outbound_enabled: true` and puts
// sandboxes on the netmaker mesh; this build does not appear to apply the
// per-session override. So a shell in the CRM sandbox HAS internet access.
//
// What still holds: the sandbox is never given DATABASE_URL (eve does not inject
// it, and nothing here adds it), so the exfiltration path is "whatever the model
// chooses to type into a shell", not "read the customer table and POST it".
// That is a genuinely weaker posture than upstream's, and it is a deliberate,
// documented trade rather than an oversight.
//
// To actually get deny-all, the engine side must change
// (kubernetes/modules/tenki-app/base/sandbox-engine: default_outbound_enabled,
// or a per-owner policy for owner_id=crm). Until then
// TENKI_SANDBOX_ALLOW_EGRESS is advisory: it controls what we *request*, and
// the request is currently not enforced.
//
// Because the policy is fixed at session creation, a *runtime* setNetworkPolicy()
// call that tries to widen access is refused rather than being silently accepted
// (see setNetworkPolicy below) — mirroring how the just-bash backend rejects the
// call rather than pretending.

import { randomUUID } from "node:crypto";
import { type Session, TenkiSandbox } from "@tenkicloud/sandbox";
import type {
	SandboxBackend,
	SandboxBackendCreateInput,
	SandboxBackendHandle,
	SandboxBackendPrewarmInput,
} from "eve/sandbox";

// eve exports the prewarm *input* type but not its result type, so mirror the
// one-field shape here rather than reaching into a private #-subpath.
interface PrewarmResult {
	readonly reused: boolean;
}

import { createTenkiSandboxSession, WORKSPACE_ROOT } from "./session";

export const TENKI_BACKEND_NAME = "tenki";

const DEFAULT_IDLE_TIMEOUT_MIN = 30;
const DEFAULT_MAX_DURATION_MS = 4 * 60 * 60_000;
const DEFAULT_CPU_CORES = 2;
const DEFAULT_MEMORY_MB = 4096;
const DEFAULT_DISK_GB = 20;
const CREATE_WAIT_MS = 180_000;

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * What we REQUEST for session egress. Off unless explicitly, literally enabled.
 *
 * Note this is a request, not a guarantee: the homelab engine currently ignores
 * it and enables outbound regardless (see the egress note at the top of this
 * file). Kept fail-closed anyway so the intent is unambiguous and so the day the
 * engine honours it, we are already asking for the right thing.
 */
function egressAllowed(): boolean {
	return process.env.TENKI_SANDBOX_ALLOW_EGRESS === "true";
}

export interface TenkiBackendOptions {
	readonly baseUrl?: string;
	readonly authToken?: string;
	/** Image the sandbox boots. Must contain bash, grep, and the usual coreutils. */
	readonly image?: string;
	/**
	 * Workspace to scope sessions to. REQUIRED for service-token callers: the
	 * engine infers the workspace only for workspace API keys, and a `tk_` service
	 * credential is a full-service identity with no implied scope. Omitting it
	 * makes ListSessions fail with
	 * `workspace_id: value is empty, which is not a valid UUID`.
	 */
	readonly workspaceId?: string;
}

export function tenkiBackend(
	options: TenkiBackendOptions = {},
): SandboxBackend {
	const baseUrl = options.baseUrl ?? process.env.TENKI_BASE_URL ?? "";
	const authToken = options.authToken ?? process.env.TENKI_AUTH_TOKEN ?? "";
	const image = options.image ?? process.env.TENKI_SANDBOX_IMAGE ?? undefined;
	const workspaceId =
		options.workspaceId ?? process.env.TENKI_WORKSPACE_ID ?? "";

	if (baseUrl === "" || authToken === "") {
		throw new Error(
			"The tenki sandbox backend needs TENKI_BASE_URL and TENKI_AUTH_TOKEN. " +
				"Without them eve would fall back to just-bash, which runs no real binaries.",
		);
	}

	if (workspaceId === "") {
		// Fail at construction rather than on the first tool call. A service token
		// carries no implied workspace, so every list/create would otherwise die
		// mid-session with an opaque UUID validation error from the engine.
		throw new Error(
			"The tenki sandbox backend needs TENKI_WORKSPACE_ID: a tk_ service " +
				"credential has no implied workspace scope, so the engine rejects " +
				"ListSessions/CreateSession with an empty workspace_id.",
		);
	}

	let client: TenkiSandbox | undefined;
	const clientOnce = (): TenkiSandbox => {
		client ??= new TenkiSandbox({ authToken, baseUrl });
		return client;
	};

	// Providers can be constructed concurrently for one logical session; the
	// engine does NOT enforce name uniqueness, so two racing resolves would burn
	// two concurrency slots for one agent session. Coalesce by name.
	const inflight = new Map<string, Promise<Session>>();

	function singleFlight(
		name: string,
		resolve: () => Promise<Session>,
	): Promise<Session> {
		const existing = inflight.get(name);
		if (existing !== undefined) return existing;

		const promise = resolve().finally(() => {
			if (inflight.get(name) === promise) inflight.delete(name);
		});
		inflight.set(name, promise);
		return promise;
	}

	async function findByName(name: string): Promise<Session | null> {
		// Scope explicitly — see the workspaceId note on TenkiBackendOptions.
		// Do NOT swallow list errors into "not found": that would force a spurious
		// create and orphan the real session, burning a concurrency slot.
		const sessions = await clientOnce().list({ workspaceId });
		const live = sessions.filter(
			(session) =>
				session.name === name &&
				session.state !== "TERMINATED" &&
				session.state !== "TERMINATING" &&
				session.state !== "USER_SHUTDOWN",
		);
		return live[0] ?? null;
	}

	async function createNamed(name: string): Promise<Session> {
		const session = await clientOnce().createAndWait({
			name,
			image,
			workspaceId,
			allowInbound: false,
			allowOutbound: egressAllowed(),
			cpuCores: envInt("TENKI_SANDBOX_CPU_CORES", DEFAULT_CPU_CORES),
			memoryMb: envInt("TENKI_SANDBOX_MEMORY_MB", DEFAULT_MEMORY_MB),
			diskSizeGb: envInt("TENKI_SANDBOX_DISK_GB", DEFAULT_DISK_GB),
			idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MIN,
			maxDurationMs: DEFAULT_MAX_DURATION_MS,
			metadata: { app: "crm", managedBy: "eve" },
			timeoutMs: CREATE_WAIT_MS,
			waitReady: true,
		});

		// Say so, loudly, when the engine did not give us the posture we asked
		// for. A silent gap between "we requested deny-all" and "the box has
		// internet" is exactly the kind of thing that gets written down as a
		// security property and then quietly is not one.
		if (!egressAllowed() && session.outboundEnabled) {
			console.warn(
				`[agent] sandbox ${session.id}: requested allowOutbound=false but the ` +
					"engine reports outboundEnabled=true. This sandbox HAS network " +
					"egress. Fix on the engine side (session.default_outbound_enabled) " +
					"if the CRM's deny-all posture is required.",
			);
		}

		return session;
	}

	/** Resolve a live RUNNING session for `name`, resuming or recreating as needed. */
	async function resolveSession(name: string): Promise<Session> {
		return await singleFlight(name, async () => {
			const existing = await findByName(name);
			if (existing === null) return await createNamed(name);

			if (existing.state === "RUNNING") return existing;

			// PAUSED (the engine's idle sweeper pauses rather than deletes) — a
			// plain exec against a non-RUNNING box drives the SDK's credential
			// retry loop instead of failing cleanly, so resume explicitly first.
			try {
				await existing.waitReady(CREATE_WAIT_MS);
				return existing;
			} catch {
				return await createNamed(name);
			}
		});
	}

	async function refuseNetworkPolicy(policy: string): Promise<void> {
		// "deny-all" is already what we created the session with, so honouring it
		// is a no-op. Anything wider would require recreating the session, and
		// silently ignoring it would misrepresent the sandbox's egress to a caller
		// that is asking to widen it on purpose.
		if (policy === "deny-all" || (!egressAllowed() && policy === "")) return;
		if (egressAllowed() && policy === "allow-all") return;

		throw new Error(
			`setNetworkPolicy(${policy}) is not supported on the tenki sandbox backend: ` +
				"the engine fixes egress at session creation. Set TENKI_SANDBOX_ALLOW_EGRESS=true " +
				"to create sessions with egress (this weakens the CRM's data-exfiltration boundary).",
		);
	}

	return {
		name: TENKI_BACKEND_NAME,

		// The CRM's sandbox authors no bootstrap() and no seed files, so eve passes
		// templateKey: null at create time and this is a formality. We deliberately
		// do NOT build a snapshot template: it would add a build-time dependency on
		// a reachable engine (breaking `eve build` in CI and in the image build,
		// which runs with no cluster access).
		async prewarm(input: SandboxBackendPrewarmInput): Promise<PrewarmResult> {
			if (input.seedFiles.length > 0 || input.bootstrap !== undefined) {
				input.log?.(
					"tenki backend: seed files and bootstrap are applied per session, not baked into a template",
				);
			}
			return { reused: true };
		},

		async create(
			input: SandboxBackendCreateInput,
		): Promise<SandboxBackendHandle> {
			const name = `crm-${input.sessionKey}`.slice(0, 63);

			// Resolve lazily: eve calls create() eagerly per session, and paying a
			// ~3min cold boot for a session that never runs a command is waste.
			let resolved: Promise<Session> | undefined;
			const session = () => (resolved ??= resolveSession(name));

			const eveSession = createTenkiSandboxSession({
				id: input.sessionKey,
				session,
				setNetworkPolicy: refuseNetworkPolicy,
			});

			return {
				session: eveSession,
				useSessionFn: async () => eveSession,

				async captureState() {
					return {
						backendName: TENKI_BACKEND_NAME,
						metadata: { sessionName: name, workspaceRoot: WORKSPACE_ROOT },
						sessionKey: input.sessionKey,
					};
				},

				// eve shuts down on server exit; the session must stay reattachable.
				// Do NOT terminate here — the engine's idle sweeper pauses it, and
				// resolveSession() reattaches by name on the next start. Terminating
				// would drop durable research state on every redeploy.
				async shutdown() {
					resolved = undefined;
				},
			};
		},
	};
}

/** Exported for tests. */
export const __testing = { randomUUID };
