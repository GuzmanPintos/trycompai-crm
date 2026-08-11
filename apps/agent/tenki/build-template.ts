#!/usr/bin/env bun
import { pathToFileURL } from "node:url";
import {
	type Session,
	type Template,
	type TemplateBuildEvent,
	TemplateRuntimeFailedError,
	TenkiSandbox,
	WaitReadyFailedError,
} from "@tenkicloud/sandbox";
import {
	createOutputSanitizer,
	errorText,
	isImmutableDigestImage,
	requireProductionConfig,
} from "./config";
import {
	CRM_SANDBOX_SMOKE_COMMAND,
	CRM_TEMPLATE_NAME,
	crmTemplateSpec,
} from "./template";

const SMOKE_MAX_DURATION_MS = 5 * 60 * 1000;
const SMOKE_WAIT_MS = 3 * 60 * 1000;

function isDirectExecution(): boolean {
	const entry = process.argv[1];
	return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

export function streamBuildEvent(
	event: TemplateBuildEvent,
	sanitize: (value: string) => string,
): void {
	if (event.type === "log") {
		process.stderr.write(sanitize(`[template:${event.stream}] ${event.data}`));
		return;
	}

	const step = event.step
		? ` step=${event.step.index}:${event.step.label}`
		: "";
	const message = event.message ? ` ${event.message}` : "";
	process.stderr.write(
		sanitize(`[template:${event.phase}] ${event.state}${step}${message}\n`),
	);
}

async function ensureTemplate(
	client: TenkiSandbox,
	workspaceId: string,
): Promise<Template> {
	const templates = await client.listTemplates({ workspaceId });
	const matching = templates.filter(
		(template) => template.name === CRM_TEMPLATE_NAME,
	);
	if (matching.length > 1) {
		throw new Error(
			`Found ${matching.length} templates named exactly ${CRM_TEMPLATE_NAME}`,
		);
	}

	const existing = matching[0];
	if (!existing) {
		process.stderr.write(`[template] creating ${CRM_TEMPLATE_NAME}\n`);
		return await client.createTemplate({
			name: CRM_TEMPLATE_NAME,
			spec: crmTemplateSpec,
			workspaceId,
		});
	}

	const authoredSpec = JSON.stringify(crmTemplateSpec.toJSON());
	const existingSpec = existing.spec
		? JSON.stringify(existing.spec.toJSON())
		: undefined;
	if (existingSpec === authoredSpec) {
		process.stderr.write(`[template] ${CRM_TEMPLATE_NAME} already matches\n`);
		return existing;
	}

	process.stderr.write(`[template] updating ${CRM_TEMPLATE_NAME}\n`);
	return await client.updateTemplate(existing, { spec: crmTemplateSpec });
}

async function smokeBuiltImage(
	client: TenkiSandbox,
	template: Template,
	imageDigestRef: string,
	buildId: string,
): Promise<void> {
	let smoke: Session | undefined;
	let createAttempted = false;
	const name = `crm-template-smoke-${buildId}`.slice(0, 63);
	const metadata = { app: "crm", buildId, managedBy: "template-smoke" };
	try {
		process.stderr.write("[template] launching smoke sandbox\n");
		createAttempted = true;
		smoke = await client.createAndWait({
			allowInbound: false,
			allowOutbound: false,
			idleTimeoutMinutes: 2,
			image: imageDigestRef,
			maxDurationMs: SMOKE_MAX_DURATION_MS,
			metadata,
			name,
			sticky: false,
			timeoutMs: SMOKE_WAIT_MS,
			waitReady: true,
			workspaceId: template.workspaceId,
		});
		const result = await smoke.run(["bash", "-lc", CRM_SANDBOX_SMOKE_COMMAND]);
		if (result.exitCode !== 0) {
			throw new Error(`Smoke sandbox failed with exit ${result.exitCode}`);
		}
		process.stderr.write("[template] smoke passed\n");
	} catch (error) {
		if (
			error instanceof WaitReadyFailedError ||
			error instanceof TemplateRuntimeFailedError
		) {
			smoke = error.session;
		}
		throw error;
	} finally {
		let sessionsToClose = smoke ? [smoke] : [];
		if (createAttempted && sessionsToClose.length === 0) {
			sessionsToClose = (
				await client.list({ workspaceId: template.workspaceId })
			).filter(
				(candidate) =>
					candidate.name === name &&
					candidate.metadata.app === metadata.app &&
					candidate.metadata.buildId === metadata.buildId &&
					candidate.metadata.managedBy === metadata.managedBy,
			);
		}
		for (const candidate of sessionsToClose) await candidate.closeIfOpen();
	}
}

export async function buildCrmTemplate(
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const config = requireProductionConfig(env);
	const sanitize = createOutputSanitizer([config.authToken]);
	const violations = crmTemplateSpec.validate();
	if (violations.length > 0) {
		throw new Error(`Invalid CRM TemplateSpec: ${JSON.stringify(violations)}`);
	}

	const client = new TenkiSandbox({
		authToken: config.authToken,
		baseUrl: config.endpoint,
	});
	try {
		const template = await ensureTemplate(client, config.workspaceId);
		if (template.workspaceId !== config.workspaceId) {
			throw new Error("Template workspace does not match TENKI_WORKSPACE_ID");
		}
		if (template.visibility !== "PRIVATE") {
			throw new Error("CRM template visibility must be private");
		}

		const build = await client.buildTemplate(template, {
			onEvent: (event) => streamBuildEvent(event, sanitize),
			waitForCompletion: true,
		});
		if (build.state !== "READY") {
			throw new Error(`Template build ${build.id} ended in ${build.state}`);
		}
		if (!build.image) {
			throw new Error(`READY template build ${build.id} returned no image`);
		}
		if (
			!isImmutableDigestImage(build.image.digestRef) ||
			build.image.digestRef !== build.imageDigestRef
		) {
			throw new Error(
				`READY template build ${build.id} returned no immutable digestRef`,
			);
		}
		if (build.image.visibility !== "private") {
			throw new Error(
				`Template build ${build.id} image visibility must be private`,
			);
		}

		await smokeBuiltImage(client, template, build.image.digestRef, build.id);
		process.stdout.write(
			`${JSON.stringify({
				buildId: build.id,
				imageDigest: build.image.digest,
				imageDigestRef: build.image.digestRef,
				imageId: build.image.id,
				snapshotId: build.snapshotId,
				templateId: template.id,
				templateName: template.name,
				workspaceId: template.workspaceId,
			})}\n`,
		);
	} catch (error) {
		throw new Error(sanitize(errorText(error)));
	} finally {
		client.close();
	}
}

if (isDirectExecution()) {
	void buildCrmTemplate().catch((error: unknown) => {
		const authToken = process.env.TENKI_AUTH_TOKEN;
		const sanitize = createOutputSanitizer([authToken]);
		process.stderr.write(`${sanitize(errorText(error))}\n`);
		process.exitCode = 1;
	});
}
