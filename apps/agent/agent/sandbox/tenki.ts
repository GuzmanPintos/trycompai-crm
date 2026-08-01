import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
	type ClientOptions,
	type CreateOptions,
	FileNotFoundError,
	InvalidStateError,
	type ProcessRunHandle,
	type Session,
	SessionExpiredError,
	SessionNotFoundError,
	SessionTerminatedError,
	type Snapshot,
	TenkiSandbox,
} from "@tenkicloud/sandbox";
import {
	type SandboxBackend,
	type SandboxBackendCreateInput,
	type SandboxBackendHandle,
	type SandboxBackendPrewarmInput,
	type SandboxNetworkPolicy,
	type SandboxProcess,
	type SandboxSession,
	SandboxTemplateNotProvisionedError,
} from "eve/sandbox";

const BACKEND_NAME = "tenki";
const EVE_WORKSPACE = "/workspace";
const TENKI_WORKSPACE = "/home/tenki/workspace";
const TEXT_DECODER = new TextDecoder();
const DENY_ALL_PROBE =
	"timeout 5 bash -c '</dev/tcp/1.1.1.1/443' >/dev/null 2>&1";

export type TenkiSandboxUseOptions = {
	readonly networkPolicy?: SandboxNetworkPolicy;
};

export type TenkiBackendOptions = {
	/** Injected by tests; production constructs the official SDK client. */
	readonly client?: TenkiClient;
	readonly clientOptions?: ClientOptions;
	readonly create?: Omit<
		CreateOptions,
		| "allowInbound"
		| "allowOutbound"
		| "cloneRepoUrl"
		| "enableOpenCode"
		| "env"
		| "githubToken"
		| "metadata"
		| "name"
		| "openCodeProvider"
		| "setupEnv"
		| "setupSecrets"
		| "snapshotId"
		| "tags"
	>;
	readonly networkPolicy?: SandboxNetworkPolicy;
};

type TenkiProcess = Pick<
	ProcessRunHandle,
	"kill" | "pid" | "stderr" | "stdout" | "then"
>;

export type TenkiSession = Pick<
	Session,
	| "closeIfOpen"
	| "exec"
	| "id"
	| "mkdir"
	| "pause"
	| "readFile"
	| "readFileStream"
	| "refresh"
	| "remove"
	| "resume"
	| "run"
	| "state"
	| "waitReady"
	| "waitResumed"
	| "writeFile"
	| "writeFileStream"
>;

export type TenkiClient = {
	create(options?: CreateOptions): Promise<TenkiSession>;
	createSnapshotAndWait(
		sessionId: string,
		options?: { name?: string },
	): Promise<Snapshot>;
	get(sessionId: string): Promise<TenkiSession>;
	listSnapshots(): Promise<Snapshot[]>;
	updateSnapshot(
		snapshotId: string,
		options: { tags?: string[] },
	): Promise<Snapshot>;
};

/**
 * Runs eve sandboxes in Tenki microVMs.
 *
 * The API key stays in this client, in the trusted agent runtime. Create
 * options deliberately do not accept `env`: the CRM's database and provider
 * credentials must never become guest environment variables.
 */
export function tenkiBackend(
	options: TenkiBackendOptions = {},
): SandboxBackend<TenkiSandboxUseOptions, TenkiSandboxUseOptions> {
	const client =
		options.client ??
		(new TenkiSandbox(options.clientOptions) satisfies TenkiClient);
	const networkPolicy = options.networkPolicy ?? "allow-all";
	const activeHandles = new Map<
		string,
		Promise<SandboxBackendHandle<TenkiSandboxUseOptions>>
	>();
	const prewarmedSnapshots = new Map<string, string>();

	assertSupportedNetworkPolicy(networkPolicy);

	return {
		name: BACKEND_NAME,

		async prewarm(input) {
			const templateName = templateSnapshotName(input.templateKey, {
				create: options.create,
				networkPolicy,
			});
			const cached = await findTemplateSnapshot(client, templateName);
			if (cached) {
				prewarmedSnapshots.set(input.templateKey, cached.id);
				input.log?.(`reusing cached Tenki snapshot "${templateName}"`);
				return { reused: true };
			}

			input.log?.(`creating Tenki template session`);
			const session = await client.create({
				...options.create,
				allowInbound: false,
				allowOutbound: allowsOutbound(networkPolicy),
				metadata: {
					"eve.role": "template",
					"eve.template": input.templateKey,
				},
				name: templateName,
				tags: ["eve", "eve-template"],
				waitReady: true,
			});

			try {
				await verifyNetworkPolicy(session, networkPolicy);
				await prepareBaseRuntime(session);
				const sandbox = tenkiSession(session, networkPolicy);
				await writeSeedFiles(sandbox, input.seedFiles);

				if (input.bootstrap) {
					input.log?.(`running sandbox bootstrap`);
					await input.bootstrap({
						use: async (useOptions) => {
							assertUnchangedPolicy(networkPolicy, useOptions?.networkPolicy);
							return sandbox;
						},
					});
				}

				input.log?.(`snapshotting Tenki template session`);
				const snapshot = await client.createSnapshotAndWait(session.id, {
					name: templateName,
				});
				await client.updateSnapshot(snapshot.id, {
					tags: ["eve", "eve-template"],
				});
				prewarmedSnapshots.set(input.templateKey, snapshot.id);
				return { reused: false };
			} finally {
				await session.closeIfOpen().catch(() => {});
			}
		},

		async create(input) {
			const existing = activeHandles.get(input.sessionKey);
			if (existing) return existing;

			const handle = createHandle({
				client,
				createOptions: options.create,
				input,
				networkPolicy,
				prewarmedSnapshots,
			})
				.then((resolved) => ({
					...resolved,
					async shutdown() {
						activeHandles.delete(input.sessionKey);
						await resolved.shutdown();
					},
				}))
				.catch((error) => {
					activeHandles.delete(input.sessionKey);
					throw error;
				});
			activeHandles.set(input.sessionKey, handle);
			return handle;
		},
	};
}

async function createHandle(input: {
	readonly client: TenkiClient;
	readonly createOptions: TenkiBackendOptions["create"];
	readonly input: SandboxBackendCreateInput;
	readonly networkPolicy: SandboxNetworkPolicy;
	readonly prewarmedSnapshots: Map<string, string>;
}): Promise<SandboxBackendHandle<TenkiSandboxUseOptions>> {
	const persistedId = readSessionId(input.input.existingMetadata);
	let session = persistedId
		? await reconnectSession(input.client, persistedId)
		: null;
	const reattached = session !== null;

	if (!session) {
		const snapshotId = await resolveTemplateSnapshot({
			client: input.client,
			createOptions: input.createOptions,
			networkPolicy: input.networkPolicy,
			prewarmedSnapshots: input.prewarmedSnapshots,
			templateKey: input.input.templateKey,
		});
		session = await input.client.create({
			...input.createOptions,
			allowInbound: false,
			allowOutbound: allowsOutbound(input.networkPolicy),
			metadata: {
				...input.input.tags,
				"eve.backend": BACKEND_NAME,
				"eve.session": input.input.sessionKey,
			},
			name: sessionName(input.input.sessionKey),
			...(snapshotId ? { snapshotId } : {}),
			tags: ["eve", "eve-session"],
			waitReady: true,
		});

		if (!snapshotId) await prepareBaseRuntime(session);
	}

	try {
		await verifyNetworkPolicy(session, input.networkPolicy);
	} catch (error) {
		// A newly created VM contains no durable user state and can be removed. A
		// reattached one may hold the only copy of its workspace, so park it again.
		if (reattached) await pauseIfRunning(session).catch(() => {});
		else await session.closeIfOpen().catch(() => {});
		throw error;
	}

	const sandbox = tenkiSession(session, input.networkPolicy);
	return {
		session: sandbox,
		useSessionFn: async (useOptions) => {
			assertUnchangedPolicy(input.networkPolicy, useOptions?.networkPolicy);
			return sandbox;
		},
		async captureState() {
			return {
				backendName: BACKEND_NAME,
				metadata: { sessionId: session.id },
				sessionKey: input.input.sessionKey,
			};
		},
		async shutdown() {
			await pauseIfRunning(session);
		},
	};
}

async function reconnectSession(
	client: TenkiClient,
	sessionId: string,
): Promise<TenkiSession | null> {
	let session: TenkiSession;
	try {
		session = await client.get(sessionId);
	} catch (error) {
		if (isGone(error)) return null;
		throw error;
	}

	switch (session.state) {
		case "RUNNING":
			return session;
		case "CREATING":
			await session.waitReady();
			return session;
		case "PAUSED":
		case "USER_SHUTDOWN":
			await session.resume();
			await session.waitResumed();
			return session;
		case "RESUMING":
			await session.waitResumed();
			return session;
		case "PAUSING":
			// A shutdown raced the next invocation. Refresh until Tenki exposes the
			// resumable state rather than creating a second VM for one eve session.
			for (let attempt = 0; attempt < 20; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 250));
				await session.refresh();
				if (session.state !== "PAUSING") {
					return reconnectSession(client, sessionId);
				}
			}
			throw new Error(`Tenki session "${sessionId}" did not finish pausing.`);
		case "TERMINATING":
		case "TERMINATED":
			return null;
		default:
			return null;
	}
}

function tenkiSession(
	session: TenkiSession,
	networkPolicy: SandboxNetworkPolicy,
): SandboxSession {
	const spawn = async (
		options: Parameters<SandboxSession["spawn"]>[0],
	): Promise<SandboxProcess> => {
		throwIfAborted(options.abortSignal);
		const process = session.run(
			["bash", "-lc", options.command],
			processOptions(options),
		) as TenkiProcess;
		const onAbort = () => void process.kill();
		options.abortSignal?.addEventListener("abort", onAbort, { once: true });

		let pid: number | undefined;
		try {
			pid = await process.pid;
		} catch {}

		return {
			...(pid === undefined ? {} : { pid }),
			stderr: process.stderr,
			stdout: process.stdout,
			async kill() {
				options.abortSignal?.removeEventListener("abort", onAbort);
				await process.kill();
			},
			async wait() {
				try {
					const result = await process;
					throwIfAborted(options.abortSignal);
					return { exitCode: result.exitCode };
				} finally {
					options.abortSignal?.removeEventListener("abort", onAbort);
				}
			},
		};
	};

	return {
		id: session.id,
		resolvePath,
		async run(options) {
			throwIfAborted(options.abortSignal);
			const result = await session.exec("bash", {
				args: ["-lc", options.command],
				cwd: resolveWorkingDirectory(options.workingDirectory),
				env: options.env,
				signal: options.abortSignal,
			});
			return {
				exitCode: result.exitCode,
				stderr: TEXT_DECODER.decode(result.stderr),
				stdout: TEXT_DECODER.decode(result.stdout),
			};
		},
		spawn,
		async readFile(options) {
			throwIfAborted(options.abortSignal);
			try {
				return await session.readFileStream(resolvePath(options.path));
			} catch (error) {
				if (error instanceof FileNotFoundError) return null;
				throw error;
			}
		},
		async readBinaryFile(options) {
			throwIfAborted(options.abortSignal);
			try {
				return await session.readFile(resolvePath(options.path));
			} catch (error) {
				if (error instanceof FileNotFoundError) return null;
				throw error;
			}
		},
		async readTextFile(options) {
			throwIfAborted(options.abortSignal);
			let content: Uint8Array;
			try {
				content = await session.readFile(resolvePath(options.path));
			} catch (error) {
				if (error instanceof FileNotFoundError) return null;
				throw error;
			}

			const text = Buffer.from(content).toString(
				(options.encoding ?? "utf-8") as BufferEncoding,
			);
			if (options.startLine === undefined && options.endLine === undefined) {
				return text;
			}
			const start = Math.max(1, options.startLine ?? 1) - 1;
			const end = options.endLine === undefined ? undefined : options.endLine;
			return text.split("\n").slice(start, end).join("\n");
		},
		async writeFile(options) {
			throwIfAborted(options.abortSignal);
			const path = resolvePath(options.path);
			await ensureParent(session, path);
			await session.writeFileStream(path, options.content);
		},
		async writeBinaryFile(options) {
			throwIfAborted(options.abortSignal);
			const path = resolvePath(options.path);
			await ensureParent(session, path);
			await session.writeFile(path, options.content);
		},
		async writeTextFile(options) {
			throwIfAborted(options.abortSignal);
			const path = resolvePath(options.path);
			await ensureParent(session, path);
			const content = Buffer.from(
				options.content,
				(options.encoding ?? "utf-8") as BufferEncoding,
			);
			await session.writeFile(path, content);
		},
		async removePath(options) {
			throwIfAborted(options.abortSignal);
			const args = [
				"rm",
				...(options.force ? ["-f"] : []),
				...(options.recursive ? ["-r"] : []),
				"--",
				resolvePath(options.path),
			];
			const result = await session.run(args);
			if (result.exitCode !== 0) {
				throw new Error(
					`Could not remove "${options.path}" from Tenki sandbox (exit ${result.exitCode}).`,
				);
			}
		},
		async setNetworkPolicy(policy) {
			assertUnchangedPolicy(networkPolicy, policy);
		},
	};
}

function processOptions(options: Parameters<SandboxSession["spawn"]>[0]): {
	cwd: string;
	env?: Record<string, string>;
} {
	return {
		cwd: resolveWorkingDirectory(options.workingDirectory),
		...(options.env ? { env: options.env } : {}),
	};
}

async function prepareBaseRuntime(session: TenkiSession): Promise<void> {
	const result = await session.exec("bash", {
		args: [
			"-lc",
			`mkdir -p ${TENKI_WORKSPACE} && if [ ! -e ${EVE_WORKSPACE} ]; then sudo ln -s ${TENKI_WORKSPACE} ${EVE_WORKSPACE}; fi`,
		],
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`Could not prepare ${EVE_WORKSPACE} in Tenki sandbox (exit ${result.exitCode}).`,
		);
	}
}

/**
 * Provider configuration is a security boundary, so trust but verify it before
 * any seed or customer-derived data enters a new VM. This catches a service or
 * SDK regression that reports outbound disabled while the guest can still open
 * a direct socket; failing closed is safer than silently weakening the CRM's
 * documented data boundary.
 */
async function verifyNetworkPolicy(
	session: TenkiSession,
	policy: SandboxNetworkPolicy,
): Promise<void> {
	if (policy !== "deny-all") return;
	const result = await session.exec("bash", {
		args: ["-lc", DENY_ALL_PROBE],
	});
	if (result.exitCode === 0) {
		throw new Error(
			"Tenki reported outbound networking disabled, but the sandbox opened a direct external socket. Refusing to expose agent data to this session.",
		);
	}
}

async function writeSeedFiles(
	sandbox: SandboxSession,
	files: SandboxBackendPrewarmInput["seedFiles"],
): Promise<void> {
	for (const file of files) {
		await sandbox.writeBinaryFile({
			content:
				typeof file.content === "string"
					? Buffer.from(file.content)
					: file.content,
			path: file.path,
		});
	}
}

async function ensureParent(
	session: TenkiSession,
	path: string,
): Promise<void> {
	const parent = posix.dirname(path);
	if (parent !== ".") await session.mkdir(parent);
}

async function resolveTemplateSnapshot(input: {
	readonly client: TenkiClient;
	readonly createOptions: TenkiBackendOptions["create"];
	readonly networkPolicy: SandboxNetworkPolicy;
	readonly prewarmedSnapshots: Map<string, string>;
	readonly templateKey: string | null;
}): Promise<string | null> {
	if (!input.templateKey) return null;
	const inMemory = input.prewarmedSnapshots.get(input.templateKey);
	if (inMemory) return inMemory;

	const name = templateSnapshotName(input.templateKey, {
		create: input.createOptions,
		networkPolicy: input.networkPolicy,
	});
	const snapshot = await findTemplateSnapshot(input.client, name);
	if (!snapshot) {
		throw new SandboxTemplateNotProvisionedError({
			backendName: BACKEND_NAME,
			templateKey: input.templateKey,
		});
	}
	input.prewarmedSnapshots.set(input.templateKey, snapshot.id);
	return snapshot.id;
}

async function findTemplateSnapshot(
	client: TenkiClient,
	name: string,
): Promise<Snapshot | undefined> {
	const snapshots = await client.listSnapshots();
	return snapshots.find(
		(snapshot) => snapshot.name === name && snapshot.state === "READY",
	);
}

function templateSnapshotName(
	templateKey: string,
	options: Pick<TenkiBackendOptions, "create" | "networkPolicy">,
): string {
	const identity = createHash("sha256")
		.update(templateKey)
		.update("\0")
		.update(JSON.stringify(options.create ?? {}))
		.update("\0")
		.update(JSON.stringify(options.networkPolicy ?? "allow-all"))
		.digest("hex")
		.slice(0, 32);
	return `eve-template-${identity}`;
}

function sessionName(sessionKey: string): string {
	const identity = createHash("sha256")
		.update(sessionKey)
		.digest("hex")
		.slice(0, 24);
	return `eve-session-${identity}`;
}

function resolvePath(path: string): string {
	if (path === EVE_WORKSPACE) return TENKI_WORKSPACE;
	if (path.startsWith(`${EVE_WORKSPACE}/`)) {
		return `${TENKI_WORKSPACE}${path.slice(EVE_WORKSPACE.length)}`;
	}
	if (path.startsWith("/")) return path;
	return posix.resolve(TENKI_WORKSPACE, path);
}

function resolveWorkingDirectory(path?: string): string {
	return path ? resolvePath(path) : TENKI_WORKSPACE;
}

function readSessionId(metadata?: Record<string, unknown>): string | null {
	return typeof metadata?.sessionId === "string" &&
		metadata.sessionId.length > 0
		? metadata.sessionId
		: null;
}

async function pauseIfRunning(session: TenkiSession): Promise<void> {
	try {
		await session.refresh();
		if (session.state === "RUNNING") await session.pause();
	} catch (error) {
		if (isGone(error) || error instanceof InvalidStateError) return;
		throw error;
	}
}

function isGone(error: unknown): boolean {
	return (
		error instanceof SessionNotFoundError ||
		error instanceof SessionExpiredError ||
		error instanceof SessionTerminatedError
	);
}

function allowsOutbound(policy: SandboxNetworkPolicy): boolean {
	assertSupportedNetworkPolicy(policy);
	return policy === "allow-all";
}

function assertSupportedNetworkPolicy(policy: SandboxNetworkPolicy): void {
	if (policy !== "allow-all" && policy !== "deny-all") {
		throw new Error(
			"The Tenki sandbox backend currently supports only allow-all or deny-all network policy.",
		);
	}
}

function assertUnchangedPolicy(
	configured: SandboxNetworkPolicy,
	requested?: SandboxNetworkPolicy,
): void {
	if (requested === undefined || requested === configured) return;
	throw new Error(
		"Tenki sandbox network policy is fixed when the VM is created and cannot be changed during a session.",
	);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw (
			signal.reason ??
			new DOMException("The operation was aborted.", "AbortError")
		);
	}
}
