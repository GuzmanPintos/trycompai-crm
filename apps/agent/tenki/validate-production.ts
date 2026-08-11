#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
	PermissionDeniedError,
	type ProcessRunResult,
	type Session,
	type SessionState,
	TemplateRuntimeFailedError,
	TenkiSandbox,
	WaitReadyFailedError,
	type WorkspaceUsageLimit,
} from "@tenkicloud/sandbox";
import {
	acceptKnownOutboundBug,
	createOutputSanitizer,
	errorText,
	requireProductionConfig,
	requireSandboxImage,
} from "./config";

const ACCEPTANCE_PREFIX = "crm-acceptance-";
const ACCEPTANCE_METADATA = {
	app: "crm",
	managedBy: "phase2-acceptance",
} as const;
const WORKDIR = "/home/tenki";
const SESSION_WAIT_MS = 3 * 60 * 1000;
const SESSION_MAX_DURATION_MS = 5 * 60 * 1000;
const DECODER = new TextDecoder();

export const OUTBOUND_PROBE_COMMAND =
	"curl --silent --show-error --connect-timeout 3 --max-time 5 --output /dev/null https://example.com/";

interface AcceptanceCommand {
	readonly command: string;
	readonly expectedStdout?: string;
}

export const CRM_ACCEPTANCE_COMMANDS: readonly AcceptanceCommand[] = [
	{ command: "pwd", expectedStdout: `${WORKDIR}\n` },
	{ command: "command -v bash >/dev/null" },
	{ command: "command -v cat >/dev/null" },
	{ command: "command -v curl >/dev/null" },
	{ command: "command -v file >/dev/null" },
	{ command: "command -v find >/dev/null" },
	{ command: "command -v git >/dev/null" },
	{ command: "command -v grep >/dev/null" },
	{ command: "command -v jq >/dev/null" },
	{ command: "command -v ps >/dev/null" },
	{ command: "command -v python3 >/dev/null" },
	{ command: "command -v rg >/dev/null" },
	{ command: "command -v sed >/dev/null" },
	{ command: "command -v sha256sum >/dev/null" },
	{ command: "! env | grep -q '^DATABASE_URL='" },
	{ command: "mkdir .crm-acceptance-shell" },
	{
		command:
			"printf '%s\\n' 'crm-acceptance' > .crm-acceptance-shell/input.txt",
	},
	{
		command:
			"test \"$(cat .crm-acceptance-shell/input.txt)\" = 'crm-acceptance'",
	},
	{
		command:
			"cp .crm-acceptance-shell/input.txt .crm-acceptance-shell/copy.txt",
	},
	{
		command:
			"mv .crm-acceptance-shell/copy.txt .crm-acceptance-shell/moved.txt",
	},
	{
		command:
			"find .crm-acceptance-shell -type f -name input.txt | grep -q 'input.txt$'",
	},
	{ command: "grep -q '^crm-acceptance$' .crm-acceptance-shell/input.txt" },
	{ command: "rg -q '^crm-acceptance$' .crm-acceptance-shell/input.txt" },
	{
		command:
			"test \"$(sed 's/acceptance/validated/' .crm-acceptance-shell/input.txt)\" = 'crm-validated'",
	},
	{ command: "test \"$(jq -nr '{status:\"ok\"} | .status')\" = 'ok'" },
	{
		command:
			'python3 -c \'from pathlib import Path; assert Path(".crm-acceptance-shell/input.txt").read_text() == "crm-acceptance\\n"\'',
	},
	{ command: "sha256sum .crm-acceptance-shell/input.txt >/dev/null" },
	{ command: "rm .crm-acceptance-shell/moved.txt" },
	{ command: "rm -rf .crm-acceptance-shell" },
] as const;

function isDirectExecution(): boolean {
	const entry = process.argv[1];
	return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

export function isWorkspaceUuidRejection(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		/uuid/i.test(message) &&
		/(workspace|invalid|validation|argument)/i.test(message)
	);
}

export function isPermissionDenied(error: unknown): boolean {
	if (error instanceof PermissionDeniedError) return true;
	const message = error instanceof Error ? error.message : String(error);
	return /permission[_ ]denied|path outside workdir/i.test(message);
}

export function activeSessionHeadroom(limits: readonly WorkspaceUsageLimit[]): {
	readonly current: number;
	readonly max: number | null;
} {
	// The SDK documents `active_sessions`; the production API currently returns
	// the equivalent quota as `max_concurrent_jobs`. Accept only those two known
	// names so a schema change still fails closed.
	const active = limits.find(
		(limit) =>
			limit.key === "active_sessions" || limit.key === "max_concurrent_jobs",
	);
	if (!active) {
		throw new Error(
			"Workspace usage omitted active_sessions/max_concurrent_jobs",
		);
	}
	if (active.max !== undefined && active.current >= active.max) {
		throw new Error("Workspace has no active-session headroom");
	}
	return { current: active.current, max: active.max ?? null };
}

function acceptanceOwned(session: Session): boolean {
	return (
		session.name.startsWith(ACCEPTANCE_PREFIX) &&
		session.metadata.app === ACCEPTANCE_METADATA.app &&
		session.metadata.managedBy === ACCEPTANCE_METADATA.managedBy
	);
}

function activeAcceptanceOwned(session: Session): boolean {
	const closedStates: readonly SessionState[] = [
		"TERMINATED",
		"TERMINATING",
		"USER_SHUTDOWN",
	];
	return acceptanceOwned(session) && !closedStates.includes(session.state);
}

function sessionFromError(error: unknown): Session | undefined {
	if (
		error instanceof WaitReadyFailedError ||
		error instanceof TemplateRuntimeFailedError
	) {
		return error.session;
	}
	return undefined;
}

async function runCommands(session: Session): Promise<number> {
	for (const [index, acceptance] of CRM_ACCEPTANCE_COMMANDS.entries()) {
		let result: ProcessRunResult;
		try {
			result = await session.run(["bash", "-lc", acceptance.command], {
				cwd: WORKDIR,
			});
		} catch (error) {
			throw new Error(`Acceptance command ${index + 1} failed`, {
				cause: error,
			});
		}
		const stdout = DECODER.decode(result.stdout);
		const stderr = DECODER.decode(result.stderr);
		if (/premature close/i.test(stdout) || /premature close/i.test(stderr)) {
			throw new Error(`Acceptance command ${index + 1} hit Premature close`);
		}
		if (result.exitCode !== 0) {
			throw new Error(
				`Acceptance command ${index + 1} exited ${result.exitCode}`,
			);
		}
		if (
			acceptance.expectedStdout !== undefined &&
			stdout !== acceptance.expectedStdout
		) {
			throw new Error(
				`Acceptance command ${index + 1} returned unexpected output`,
			);
		}
	}
	return CRM_ACCEPTANCE_COMMANDS.length;
}

async function measureOutboundDenial(session: Session): Promise<boolean> {
	let result: ProcessRunResult;
	try {
		result = await session.run(["bash", "-lc", OUTBOUND_PROBE_COMMAND], {
			cwd: WORKDIR,
		});
	} catch (error) {
		throw new Error("Outbound probe failed before returning an exit status", {
			cause: error,
		});
	}
	const stdout = DECODER.decode(result.stdout);
	const stderr = DECODER.decode(result.stderr);
	if (/premature close/i.test(stdout) || /premature close/i.test(stderr)) {
		throw new Error("Outbound probe hit Premature close");
	}
	return result.exitCode !== 0;
}

async function validateFileRpc(session: Session): Promise<number> {
	const workdirPath = `${WORKDIR}/.crm-acceptance-rpc-${randomUUID()}`;
	await session.writeFile(workdirPath, "rpc-ready\n");
	const contents = DECODER.decode(await session.readFile(workdirPath));
	if (contents !== "rpc-ready\n") {
		throw new Error("In-workdir file RPC read returned unexpected content");
	}
	await session.remove(workdirPath);

	let outsideRejected = false;
	try {
		await session.writeFile(
			`/tmp/crm-acceptance-rpc-${randomUUID()}`,
			"must-not-write\n",
		);
	} catch (error) {
		if (!isPermissionDenied(error)) {
			throw new Error(
				"Outside-workdir file RPC failed without permission denied",
				{
					cause: error,
				},
			);
		}
		outsideRejected = true;
	}
	if (!outsideRejected) {
		throw new Error("Outside-workdir file RPC was not rejected");
	}
	return 4;
}

export async function validateProduction(
	env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
	const config = requireProductionConfig(env);
	const image = requireSandboxImage(env);
	const mayAcceptKnownOutboundBug = acceptKnownOutboundBug(env);
	const client = new TenkiSandbox({
		authToken: config.authToken,
		baseUrl: config.endpoint,
	});
	let session: Session | undefined;
	let createAttempted = false;
	let failure: unknown;
	let cleanupFailure: unknown;
	let commands = 0;
	let fileRpcChecks = 0;
	let outboundDenied: boolean | undefined;
	let reportedOutboundEnabled: boolean | undefined;
	let remainingAcceptanceSessions: number | undefined;
	let usage:
		| { readonly current: number; readonly max: number | null }
		| undefined;
	let stage = "malformed workspace validation";
	const sessionName = `${ACCEPTANCE_PREFIX}${randomUUID()}`;

	try {
		let malformedWorkspaceError: unknown;
		try {
			await client.list({ workspaceId: "not-a-workspace-uuid" });
		} catch (error) {
			malformedWorkspaceError = error;
		}
		if (
			malformedWorkspaceError === undefined ||
			!isWorkspaceUuidRejection(malformedWorkspaceError)
		) {
			throw new Error("Malformed workspace UUID was not rejected as invalid");
		}

		stage = "workspace identity validation";
		const identity = await client.whoAmI();
		if (
			!identity.workspaces.some(
				(workspace) => workspace.id === config.workspaceId,
			)
		) {
			throw new Error("TENKI_WORKSPACE_ID is not available to this identity");
		}
		stage = "workspace quota validation";
		usage = activeSessionHeadroom(await client.getUsage());

		stage = "existing acceptance-session validation";
		const existing = await client.list({ workspaceId: config.workspaceId });
		if (existing.some(activeAcceptanceOwned)) {
			throw new Error("An active phase2 acceptance session already exists");
		}

		stage = "acceptance session creation";
		try {
			createAttempted = true;
			session = await client.createAndWait({
				allowInbound: false,
				allowOutbound: false,
				cpuCores: 2,
				diskSizeGb: 20,
				idleTimeoutMinutes: 2,
				image,
				maxDurationMs: SESSION_MAX_DURATION_MS,
				memoryMb: 4096,
				metadata: { ...ACCEPTANCE_METADATA },
				name: sessionName,
				sticky: false,
				timeoutMs: SESSION_WAIT_MS,
				waitReady: true,
				workspaceId: config.workspaceId,
			});
		} catch (error) {
			session = sessionFromError(error);
			throw error;
		}

		stage = "acceptance session property validation";
		if (session.workspaceId !== config.workspaceId) {
			throw new Error("Acceptance session returned the wrong workspace");
		}
		if (session.inboundEnabled) {
			throw new Error("Acceptance session reports inbound enabled");
		}
		reportedOutboundEnabled = session.outboundEnabled;
		if (reportedOutboundEnabled && !mayAcceptKnownOutboundBug) {
			throw new Error("Acceptance session reports outbound enabled");
		}
		if (
			session.cpuCores !== 2 ||
			session.memoryMb !== 4096 ||
			session.diskSizeGb !== 20
		) {
			throw new Error("Acceptance session returned unexpected resources");
		}

		stage = "sequential command validation";
		commands = await runCommands(session);
		stage = "outbound enforcement observation";
		outboundDenied = await measureOutboundDenial(session);
		if (!outboundDenied && !mayAcceptKnownOutboundBug) {
			throw new Error("Acceptance session reached the public Internet");
		}
		stage = "file RPC confinement validation";
		fileRpcChecks = await validateFileRpc(session);
	} catch (error) {
		failure = new Error(`Acceptance failed during ${stage}`, { cause: error });
	} finally {
		if (createAttempted) {
			let sessionsToClose = session ? [session] : [];
			if (sessionsToClose.length === 0) {
				try {
					sessionsToClose = (
						await client.list({ workspaceId: config.workspaceId })
					).filter(
						(candidate) =>
							candidate.name === sessionName && acceptanceOwned(candidate),
					);
				} catch (error) {
					cleanupFailure = error;
				}
			}
			for (const candidate of sessionsToClose) {
				try {
					await candidate.closeIfOpen();
				} catch (error) {
					cleanupFailure ??= error;
				}
			}
			try {
				const afterClose = await client.list({
					workspaceId: config.workspaceId,
				});
				remainingAcceptanceSessions = afterClose.filter(
					activeAcceptanceOwned,
				).length;
				if (remainingAcceptanceSessions !== 0) {
					cleanupFailure = new Error(
						"Active phase2 acceptance sessions remain after close",
					);
				}
			} catch (error) {
				cleanupFailure ??= error;
			}
		}
		try {
			client.close();
		} catch (error) {
			cleanupFailure ??= error;
		}
	}

	if (failure) throw failure;
	if (cleanupFailure) {
		throw new Error("Acceptance cleanup failed", { cause: cleanupFailure });
	}
	if (
		!usage ||
		remainingAcceptanceSessions === undefined ||
		outboundDenied === undefined ||
		reportedOutboundEnabled === undefined
	) {
		throw new Error("Acceptance validation did not reach cleanup verification");
	}

	const knownOutboundBugObserved = reportedOutboundEnabled || !outboundDenied;
	return {
		activeAcceptanceSessionsAfterClose: remainingAcceptanceSessions,
		commands,
		fileRpcChecks,
		knownOutboundBugAccepted:
			knownOutboundBugObserved && mayAcceptKnownOutboundBug,
		malformedWorkspaceRejected: true,
		outboundDenied,
		reportedOutboundEnabled,
		requestedOutbound: false,
		status: "ok",
		usage,
	};
}

if (isDirectExecution()) {
	void validateProduction()
		.then((result) => {
			process.stdout.write(`${JSON.stringify(result)}\n`);
		})
		.catch((error: unknown) => {
			const sanitize = createOutputSanitizer([process.env.TENKI_AUTH_TOKEN]);
			const lines = sanitize(errorText(error)).split("\n");
			const location = lines.find((line) => line.trimStart().startsWith("at "));
			const summary =
				error instanceof Error
					? `${error.name}: ${error.message}`
					: String(error);
			process.stderr.write(
				`${JSON.stringify({
					error: sanitize(summary),
					location: location?.trim() ?? null,
					status: "failed",
				})}\n`,
			);
			process.exitCode = 1;
		});
}
