// [tenki] eve SandboxSession implemented over a Tenki sandbox-engine session.
//
// eve builds its public session surface from three primitives via an internal
// `buildSandboxSession` helper — but that helper is NOT exported from the `eve`
// package (only `#execution/...`, a private subpath), so a custom backend has to
// materialize the full public surface itself. That is what this file is: the same
// derivations eve applies internally (run = spawn + collect, binary/text variants
// over the byte primitives, 1-based inclusive line ranges), on top of
// `@tenkicloud/sandbox`.
//
// Keep this file mechanical. Anything clever belongs in backend.ts.

import type { Session } from "@tenkicloud/sandbox";
import type {
	SandboxSession as EveSandboxSession,
	SandboxProcess,
	SandboxRunOptions,
	SandboxSpawnOptions,
} from "eve/sandbox";

/** eve anchors every relative path to /workspace. */
export const WORKSPACE_ROOT = "/workspace";

export function resolveWorkspacePath(path: string): string {
	return path.startsWith("/") ? path : `${WORKSPACE_ROOT}/${path}`;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function streamToBuffer(
	stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;

	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value !== undefined) {
				chunks.push(value);
				total += value.length;
			}
		}
	} finally {
		reader.releaseLock();
	}

	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

function bufferToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

/** Mirrors eve's decoder: utf-8 is strict, everything else goes through Buffer. */
function decodeBytes(bytes: Uint8Array, encoding: string): string {
	if (encoding === "utf-8" || encoding === "utf8") {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	}
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
		encoding as BufferEncoding,
	);
}

function encodeString(value: string, encoding: string): Uint8Array {
	if (encoding === "utf-8" || encoding === "utf8") {
		return new TextEncoder().encode(value);
	}
	return new Uint8Array(Buffer.from(value, encoding as BufferEncoding));
}

/** Splits keeping line endings, so a range re-join is byte-faithful. */
function splitLinesPreservingEndings(text: string): string[] {
	const lines: string[] = [];
	let start = 0;

	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") {
			lines.push(text.slice(start, i + 1));
			start = i + 1;
		} else if (text[i] === "\r") {
			if (i + 1 < text.length && text[i + 1] === "\n") {
				lines.push(text.slice(start, i + 2));
				start = i + 2;
				i++;
			} else {
				lines.push(text.slice(start, i + 1));
				start = i + 1;
			}
		}
	}

	if (start < text.length) lines.push(text.slice(start));
	return lines;
}

function applyLineRange(
	text: string,
	options: { startLine?: number; endLine?: number },
): string {
	const { startLine, endLine } = options;
	if (startLine === undefined && endLine === undefined) return text;

	if (
		startLine !== undefined &&
		(!Number.isInteger(startLine) || startLine < 1)
	)
		throw new Error("startLine must be a positive integer (1-based).");
	if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1))
		throw new Error("endLine must be a positive integer (1-based).");
	if (startLine !== undefined && endLine !== undefined && startLine > endLine)
		throw new Error("startLine must not be greater than endLine.");

	const lines = splitLinesPreservingEndings(text);
	const from = startLine ?? 1;
	const to = Math.min(endLine ?? lines.length, lines.length);

	if (from > lines.length) return "";
	return lines.slice(from - 1, to).join("");
}

/** Tenki exposes readFile/writeFile that throw on missing; eve wants null. */
function isNotFound(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		/not[_ ]?found/i.test(message) ||
		/no such file/i.test(message) ||
		/ENOENT/.test(message)
	);
}

export interface TenkiSessionDeps {
	/** Stable eve-side identifier (session key or template key). */
	readonly id: string;
	/** Resolves the live Tenki session, reattaching/resuming as needed. */
	readonly session: () => Promise<Session>;
	/** Applies an eve network policy. Throws when the policy is unsupported. */
	readonly setNetworkPolicy: (policy: string) => Promise<void>;
}

export function createTenkiSandboxSession(
	deps: TenkiSessionDeps,
): EveSandboxSession {
	async function spawn(options: SandboxSpawnOptions): Promise<SandboxProcess> {
		const session = await deps.session();

		// Tenki's run() takes an argv, not a shell string. The agent's tools send
		// shell syntax (pipes, redirects, &&), so it must go through bash -lc.
		const command =
			options.workingDirectory === undefined
				? options.command
				: `cd ${shellQuote(options.workingDirectory)} && ${options.command}`;

		const handle = session.run(["bash", "-lc", command], {
			cwd: WORKSPACE_ROOT,
			env: options.env,
		});

		if (options.abortSignal !== undefined) {
			if (options.abortSignal.aborted) {
				await handle.kill().catch(() => {});
			} else {
				options.abortSignal.addEventListener(
					"abort",
					() => {
						void handle.kill().catch(() => {});
					},
					{ once: true },
				);
			}
		}

		return {
			get pid(): number | undefined {
				return undefined;
			},
			stdout: handle.stdout,
			stderr: handle.stderr,
			async wait() {
				const result = await handle;
				return { exitCode: result.exitCode };
			},
			async kill() {
				await handle.kill();
			},
		};
	}

	async function readFileStream(
		path: string,
	): Promise<ReadableStream<Uint8Array> | null> {
		const session = await deps.session();
		try {
			return await session.readFileStream(resolveWorkspacePath(path));
		} catch (error) {
			if (isNotFound(error)) return null;
			throw error;
		}
	}

	return {
		id: deps.id,

		resolvePath: resolveWorkspacePath,

		spawn,

		// eve's own `run`: spawn, drain both streams, await exit.
		async run(options: SandboxRunOptions) {
			const process = await spawn(options);
			const [stdout, stderr, { exitCode }] = await Promise.all([
				streamToBuffer(process.stdout).then((b) => new TextDecoder().decode(b)),
				streamToBuffer(process.stderr).then((b) => new TextDecoder().decode(b)),
				process.wait(),
			]);
			return { exitCode, stdout, stderr };
		},

		readFile: async (options) => await readFileStream(options.path),

		async readBinaryFile(options) {
			const stream = await readFileStream(options.path);
			return stream === null ? null : await streamToBuffer(stream);
		},

		async readTextFile(options) {
			const stream = await readFileStream(options.path);
			if (stream === null) return null;
			const text = decodeBytes(
				await streamToBuffer(stream),
				options.encoding ?? "utf-8",
			);
			return applyLineRange(text, options);
		},

		async writeFile(options) {
			const session = await deps.session();
			await session.writeFileStream(
				resolveWorkspacePath(options.path),
				options.content,
			);
		},

		async writeBinaryFile(options) {
			const session = await deps.session();
			await session.writeFileStream(
				resolveWorkspacePath(options.path),
				bufferToStream(options.content),
			);
		},

		async writeTextFile(options) {
			const session = await deps.session();
			await session.writeFileStream(
				resolveWorkspacePath(options.path),
				bufferToStream(
					encodeString(options.content, options.encoding ?? "utf-8"),
				),
			);
		},

		async removePath(options) {
			const session = await deps.session();
			const path = resolveWorkspacePath(options.path);
			try {
				await session.remove(path);
			} catch (error) {
				if (options.force === true && isNotFound(error)) return;
				throw error;
			}
		},

		setNetworkPolicy: async (policy) => {
			await deps.setNetworkPolicy(
				typeof policy === "string" ? policy : JSON.stringify(policy),
			);
		},
	};
}
