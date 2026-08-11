import { describe, expect, it } from "bun:test";
import {
	CRM_APT_PACKAGES,
	CRM_SANDBOX_SMOKE_COMMAND,
	CRM_TEMPLATE_CONTEXT_DIRECTORY,
	CRM_TEMPLATE_CONTEXT_REPOSITORY,
	CRM_TEMPLATE_CONTEXT_REVISION,
	CRM_TEMPLATE_RESOURCES,
	CRM_TEMPLATE_WORKDIR,
	crmTemplateSpec,
} from "../tenki/template";

interface AuthoredStep {
	apt?: { packages?: string[] };
	name?: string;
	remove?: { path?: string; recursive?: boolean };
	run?: { command?: string; timeoutSeconds?: number };
}

interface AuthoredTemplateSpec {
	base?: { image?: string };
	context?: {
		checkout?: { dest?: string; mode?: string };
		source?: { git?: { ref?: string; repo?: string } };
	};
	resources?: { cpuCores?: number; diskSizeGb?: number; memoryMb?: number };
	specVersion?: string;
	steps?: AuthoredStep[];
	workdir?: string;
}

const authored = crmTemplateSpec.toJSON() as unknown as AuthoredTemplateSpec;
const steps = authored.steps ?? [];

describe("CRM Tenki TemplateSpec", () => {
	it("is a valid typed recipe with fixed base, context, workdir, and resources", () => {
		expect(crmTemplateSpec.validate()).toEqual([]);
		expect(authored.specVersion).toBe("tenki.template.v1");
		expect(authored.base?.image).toBe("sandbox");
		expect(authored.context).toEqual({
			checkout: { dest: CRM_TEMPLATE_CONTEXT_DIRECTORY, mode: "contents" },
			source: {
				git: {
					ref: CRM_TEMPLATE_CONTEXT_REVISION,
					repo: CRM_TEMPLATE_CONTEXT_REPOSITORY,
				},
			},
		});
		expect(authored.workdir).toBe(CRM_TEMPLATE_WORKDIR);
		expect(authored.resources).toEqual(CRM_TEMPLATE_RESOURCES);
		expect(steps[0]?.remove).toEqual({
			path: CRM_TEMPLATE_CONTEXT_DIRECTORY,
			recursive: true,
		});
	});

	it("installs only the required reliable shell toolchain", () => {
		const apt = steps.find((step) => step.apt)?.apt?.packages ?? [];
		expect(apt).toEqual([...CRM_APT_PACKAGES]);
		expect(apt).toEqual(
			expect.arrayContaining([
				"bash",
				"ca-certificates",
				"coreutils",
				"curl",
				"file",
				"findutils",
				"git",
				"grep",
				"jq",
				"procps",
				"python3",
				"ripgrep",
				"sed",
			]),
		);
		expect(apt.join(" ")).not.toMatch(
			/browser|chrom|firefox|libreoffice|office|playwright/i,
		);
	});

	it("contains no credential or model environment values", () => {
		const serialized = JSON.stringify(authored);
		expect(serialized).not.toMatch(
			/DATABASE_URL|TENKI_AUTH_TOKEN|AI_GATEWAY_API_KEY|BIFROST_API_KEY|model credential/i,
		);
	});

	it("cleans apt caches and runs the deterministic smoke command", () => {
		const cleanup = steps.find((step) => step.name === "Clean apt caches")?.run
			?.command;
		const smoke = steps.find(
			(step) => step.name === "Verify CRM agent toolchain",
		)?.run;
		expect(cleanup).toContain("/var/lib/apt/lists/*");
		expect(cleanup).toContain("/var/cache/apt/archives/*.deb");
		expect(smoke?.command).toBe(CRM_SANDBOX_SMOKE_COMMAND);
		expect(smoke?.timeoutSeconds).toBe(60);
		for (const invariant of [
			"set -eu",
			'test "$(pwd)" = "/home/tenki"',
			"command -v",
			"bash",
			"curl",
			"find",
			"git",
			"grep",
			"jq",
			"python3",
			"rg",
			"sed",
			"sha256sum",
			"input.txt",
			"rm",
			"test ! -e",
		]) {
			expect(smoke?.command).toContain(invariant);
		}
	});
});
