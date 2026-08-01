import { describe, expect, it } from "bun:test";
import {
	type CreateOptions,
	type ExecOptions,
	FileNotFoundError,
	type ProcessRunHandle,
	type ProcessRunOptions,
	type SessionState,
	type Snapshot,
} from "@tenkicloud/sandbox";
import type { SandboxBackendPrewarmInput } from "eve/sandbox";
import {
	configuredSandboxBackend,
	readProvider,
} from "../agent/sandbox/provider";
import {
	type TenkiClient,
	type TenkiSession,
	tenkiBackend,
} from "../agent/sandbox/tenki";

describe("sandbox provider", () => {
	it("keeps the existing automatic backend by default", () => {
		expect(readProvider()).toBe("auto");
		expect(configuredSandboxBackend({}).name).not.toBe("tenki");
	});

	it("requires a key when Tenki is explicitly selected", () => {
		expect(() =>
			configuredSandboxBackend({ SANDBOX_PROVIDER: "tenki" }),
		).toThrow("TENKI_API_KEY");
		expect(
			configuredSandboxBackend({
				SANDBOX_PROVIDER: " TENKI ",
				TENKI_API_KEY: "tk_test",
			}).name,
		).toBe("tenki");
	});

	it("rejects misspelled providers instead of silently changing isolation", () => {
		expect(() => readProvider("tenkii")).toThrow('auto" or "tenki');
	});
});

describe("Tenki eve backend", () => {
	it("prewarms, restores, pauses, and reattaches one durable session", async () => {
		const client = new FakeTenkiClient();
		const backend = tenkiBackend({ client, networkPolicy: "deny-all" });
		const prewarm = prewarmInput();

		expect(await backend.prewarm(prewarm)).toEqual({ reused: false });
		expect(client.createCalls[0]).toMatchObject({
			allowInbound: false,
			allowOutbound: false,
		});
		expect(client.createCalls[0]).not.toHaveProperty("env");
		expect(client.snapshots).toHaveLength(1);

		const template = client.sessions[0];
		expect(text(template.files.get("/home/tenki/workspace/README.md"))).toBe(
			"seeded",
		);
		expect(text(template.files.get("/home/tenki/workspace/boot.txt"))).toBe(
			"ready",
		);
		expect(template.closed).toBe(true);

		expect(await backend.prewarm(prewarm)).toEqual({ reused: true });
		expect(client.createCalls).toHaveLength(1);

		const first = await backend.create({
			runtimeContext: { appRoot: "/repo" },
			sessionKey: "eve-session-1",
			tags: { agent: "root" },
			templateKey: "template-1",
		});
		expect(client.createCalls[1]).toMatchObject({
			allowOutbound: false,
			snapshotId: client.snapshots[0]?.id,
		});
		expect(first.session.resolvePath("notes/a.txt")).toBe(
			"/home/tenki/workspace/notes/a.txt",
		);

		await first.session.writeTextFile({
			path: "notes/a.txt",
			content: "hello",
		});
		expect(
			await first.session.readTextFile({ path: "/workspace/notes/a.txt" }),
		).toBe("hello");
		expect((await first.session.run({ command: "pwd" })).stdout).toBe(
			"ran:pwd",
		);
		await first.session.setNetworkPolicy("deny-all");
		await expect(first.session.setNetworkPolicy("allow-all")).rejects.toThrow(
			"cannot be changed",
		);

		const state = await first.captureState();
		await first.shutdown();
		const live = client.sessions[1];
		expect(live.state).toBe("PAUSED");

		const resumed = await backend.create({
			existingMetadata: state.metadata,
			runtimeContext: { appRoot: "/repo" },
			sessionKey: "eve-session-1",
			templateKey: "template-1",
		});
		expect(client.createCalls).toHaveLength(2);
		expect(client.getCalls).toEqual([live.id]);
		expect(live.state).toBe("RUNNING");
		expect((await resumed.captureState()).metadata).toEqual({
			sessionId: live.id,
		});
	});

	it("fails closed when eve requests a template that was not prewarmed", async () => {
		const backend = tenkiBackend({
			client: new FakeTenkiClient(),
			networkPolicy: "deny-all",
		});

		await expect(
			backend.create({
				runtimeContext: { appRoot: "/repo" },
				sessionKey: "eve-session-1",
				templateKey: "missing-template",
			}),
		).rejects.toThrow("not provisioned");
	});

	it("refuses a VM when Tenki says deny-all but egress is reachable", async () => {
		const client = new FakeTenkiClient({ egressReachable: true });
		const backend = tenkiBackend({ client, networkPolicy: "deny-all" });

		await expect(
			backend.create({
				runtimeContext: { appRoot: "/repo" },
				sessionKey: "eve-session-1",
				templateKey: null,
			}),
		).rejects.toThrow("opened a direct external socket");
		expect(client.sessions[0]?.closed).toBe(true);
	});
});

function prewarmInput(): SandboxBackendPrewarmInput {
	return {
		async bootstrap({ use }) {
			const sandbox = await use();
			await sandbox.writeTextFile({ path: "boot.txt", content: "ready" });
		},
		runtimeContext: { appRoot: "/repo" },
		seedFiles: [{ path: "README.md", content: "seeded" }],
		templateKey: "template-1",
	};
}

class FakeTenkiClient implements TenkiClient {
	readonly createCalls: CreateOptions[] = [];
	readonly getCalls: string[] = [];
	readonly sessions: FakeTenkiSession[] = [];
	readonly snapshots: Snapshot[] = [];
	readonly egressReachable: boolean;

	constructor(options: { egressReachable?: boolean } = {}) {
		this.egressReachable = options.egressReachable ?? false;
	}

	async create(options: CreateOptions = {}): Promise<FakeTenkiSession> {
		this.createCalls.push(options);
		const session = new FakeTenkiSession(
			`tenki-${this.sessions.length + 1}`,
			this.egressReachable,
		);
		if (options.snapshotId) {
			const source = this.snapshots.find(
				(snapshot) => snapshot.id === options.snapshotId,
			);
			const template = this.sessions.find(
				(candidate) => candidate.id === source?.sessionId,
			);
			for (const [path, value] of template?.files ?? []) {
				session.files.set(path, value.slice());
			}
		}
		this.sessions.push(session);
		return session;
	}

	async createSnapshotAndWait(
		sessionId: string,
		options: { name?: string } = {},
	): Promise<Snapshot> {
		const snapshot = fakeSnapshot(
			`snapshot-${this.snapshots.length + 1}`,
			sessionId,
			options.name ?? "snapshot",
		);
		this.snapshots.push(snapshot);
		return snapshot;
	}

	async get(sessionId: string): Promise<FakeTenkiSession> {
		this.getCalls.push(sessionId);
		const session = this.sessions.find(
			(candidate) => candidate.id === sessionId,
		);
		if (!session) throw new Error("not found");
		return session;
	}

	async listSnapshots(): Promise<Snapshot[]> {
		return this.snapshots;
	}

	async updateSnapshot(
		snapshotId: string,
		options: { tags?: string[] },
	): Promise<Snapshot> {
		const snapshot = this.snapshots.find(
			(candidate) => candidate.id === snapshotId,
		);
		if (!snapshot) throw new Error("not found");
		snapshot.tags = options.tags ?? snapshot.tags;
		return snapshot;
	}
}

class FakeTenkiSession implements TenkiSession {
	readonly files = new Map<string, Uint8Array>();
	closed = false;
	state: SessionState = "RUNNING";

	constructor(
		readonly id: string,
		private readonly egressReachable: boolean,
	) {}

	async closeIfOpen(): Promise<void> {
		this.closed = true;
		this.state = "TERMINATED";
	}

	async exec(_command: string, options: ExecOptions = {}) {
		const command = options.args?.at(-1) ?? "";
		const networkProbe = command.includes("/dev/tcp/1.1.1.1/443");
		return {
			args: options.args ?? [],
			command: _command,
			durationMs: 1,
			exitCode: networkProbe && !this.egressReachable ? 1 : 0,
			outputs: [],
			sessionId: this.id,
			status:
				networkProbe && !this.egressReachable
					? ("FAILED" as const)
					: ("SUCCEEDED" as const),
			stderr: new Uint8Array(),
			stdout: new TextEncoder().encode(`ran:${command}`),
		};
	}

	async mkdir(_path: string): Promise<void> {}

	async pause(): Promise<void> {
		this.state = "PAUSED";
	}

	async readFile(path: string): Promise<Uint8Array> {
		const value = this.files.get(path);
		if (!value) throw new FileNotFoundError("missing");
		return value;
	}

	async readFileStream(path: string): Promise<ReadableStream<Uint8Array>> {
		return bytesStream(await this.readFile(path));
	}

	async refresh(): Promise<void> {}

	async remove(path: string): Promise<void> {
		this.files.delete(path);
	}

	async resume(): Promise<void> {
		this.state = "RUNNING";
	}

	run(argv: string[], _options?: ProcessRunOptions): ProcessRunHandle {
		const result = Promise.resolve({
			durationMs: 1,
			exitCode: 0,
			stderr: new Uint8Array(),
			stdout: new Uint8Array(),
		}) as Promise<{
			durationMs: number;
			exitCode: number;
			stderr: Uint8Array;
			stdout: Uint8Array;
		}> &
			ProcessRunHandle;
		return Object.assign(result, {
			kill: async () => {},
			pid: Promise.resolve(42),
			signal: async () => {},
			stderr: bytesStream(new Uint8Array()),
			stdin: new WritableStream<Uint8Array>(),
			stdout: bytesStream(
				new TextEncoder().encode(argv[0] === "rm" ? "" : "spawned"),
			),
		});
	}

	async waitReady(): Promise<void> {
		this.state = "RUNNING";
	}

	async waitResumed(): Promise<void> {
		this.state = "RUNNING";
	}

	async writeFile(path: string, data: Uint8Array | string): Promise<void> {
		this.files.set(
			path,
			typeof data === "string" ? new TextEncoder().encode(data) : data,
		);
	}

	async writeFileStream(
		path: string,
		data: ReadableStream<Uint8Array>,
	): Promise<void> {
		this.files.set(path, await streamBytes(data));
	}
}

function fakeSnapshot(id: string, sessionId: string, name: string): Snapshot {
	return {
		baseImageId: "base",
		compressedBytes: 1,
		cpuCores: 2,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		diskSizeGb: 10,
		id,
		memoryBytes: 1,
		memoryMb: 4096,
		name,
		rawImageAvailable: true,
		sessionId,
		sizeBytes: 1,
		state: "READY",
		tags: [],
		type: "USER",
		workspaceId: "workspace",
	};
}

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

async function streamBytes(
	stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	return Buffer.concat(chunks);
}

function text(value?: Uint8Array): string | undefined {
	return value ? new TextDecoder().decode(value) : undefined;
}
