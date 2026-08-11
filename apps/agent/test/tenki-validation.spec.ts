import { describe, expect, it } from "bun:test";
import {
	acceptKnownOutboundBug,
	createOutputSanitizer,
	DEFAULT_TENKI_ENDPOINT,
	isImmutableDigestImage,
	isUuid,
	requireProductionConfig,
	requireSandboxImage,
} from "../tenki/config";
import {
	activeSessionHeadroom,
	CRM_ACCEPTANCE_COMMANDS,
	isPermissionDenied,
	isWorkspaceUuidRejection,
	OUTBOUND_PROBE_COMMAND,
} from "../tenki/validate-production";

const WORKSPACE_ID = "01900000-0000-7000-8000-000000000001";
const DIGEST_IMAGE = `workspace/crm-agent@sha256:${"a".repeat(64)}`;

describe("Tenki production input validation", () => {
	it("accepts UUID-shaped workspace IDs and rejects malformed values", () => {
		expect(isUuid(WORKSPACE_ID)).toBe(true);
		expect(isUuid("01900000000070008000000000000001")).toBe(false);
		expect(isUuid("not-a-uuid")).toBe(false);
	});

	it("requires tk_ authentication and uses TENKI_BASE_URL only", () => {
		expect(
			requireProductionConfig({
				TENKI_API_ENDPOINT: "https://legacy.invalid",
				TENKI_AUTH_TOKEN: "tk_unit_test",
				TENKI_WORKSPACE_ID: WORKSPACE_ID,
			}).endpoint,
		).toBe(DEFAULT_TENKI_ENDPOINT);
		expect(
			requireProductionConfig({
				TENKI_AUTH_TOKEN: "tk_unit_test",
				TENKI_BASE_URL: "https://sandbox.internal/",
				TENKI_WORKSPACE_ID: WORKSPACE_ID,
			}).endpoint,
		).toBe("https://sandbox.internal");
		expect(() =>
			requireProductionConfig({
				TENKI_AUTH_TOKEN: "wrong",
				TENKI_WORKSPACE_ID: WORKSPACE_ID,
			}),
		).toThrow("tk_");
	});

	it("accepts the known outbound exception only when explicitly literal", () => {
		expect(acceptKnownOutboundBug({})).toBe(false);
		expect(
			acceptKnownOutboundBug({ TENKI_ACCEPT_KNOWN_OUTBOUND_BUG: "false" }),
		).toBe(false);
		expect(
			acceptKnownOutboundBug({ TENKI_ACCEPT_KNOWN_OUTBOUND_BUG: "TRUE" }),
		).toBe(false);
		expect(
			acceptKnownOutboundBug({ TENKI_ACCEPT_KNOWN_OUTBOUND_BUG: "true" }),
		).toBe(true);
	});

	it("requires an immutable image digest", () => {
		expect(isImmutableDigestImage(DIGEST_IMAGE)).toBe(true);
		expect(isImmutableDigestImage("workspace/crm-agent:latest")).toBe(false);
		expect(requireSandboxImage({ TENKI_SANDBOX_IMAGE: DIGEST_IMAGE })).toBe(
			DIGEST_IMAGE,
		);
		expect(() =>
			requireSandboxImage({ TENKI_SANDBOX_IMAGE: "sandbox" }),
		).toThrow("immutable sha256 digest reference");
	});

	it("keeps at least 24 sequential checks for production policy", () => {
		const commands = CRM_ACCEPTANCE_COMMANDS.map(({ command }) => command);
		expect(commands.length).toBeGreaterThanOrEqual(24);
		expect(commands[0]).toBe("pwd");
		expect(commands.some((command) => command.includes("DATABASE_URL"))).toBe(
			true,
		);
		expect(OUTBOUND_PROBE_COMMAND).toContain("curl");
		expect(OUTBOUND_PROBE_COMMAND).toContain("max-time");
	});

	it("recognizes fail-closed SDK error shapes", () => {
		expect(
			isWorkspaceUuidRejection(
				new Error("workspace_id: value is not a valid UUID"),
			),
		).toBe(true);
		expect(isWorkspaceUuidRejection(new Error("unauthorized"))).toBe(false);
		expect(
			isPermissionDenied(new Error("permission_denied: path outside workdir")),
		).toBe(true);
		expect(isPermissionDenied(new Error("not found"))).toBe(false);
	});

	it("fails closed when active-session usage is missing or exhausted", () => {
		expect(
			activeSessionHeadroom([
				{
					current: 1,
					helpText: "",
					key: "active_sessions",
					label: "Active sessions",
					max: 3,
					unit: "count",
				},
			]),
		).toEqual({ current: 1, max: 3 });
		expect(
			activeSessionHeadroom([
				{
					current: 17,
					helpText: "",
					key: "max_concurrent_jobs",
					label: "Active sessions",
					max: 200,
					unit: "count",
				},
			]),
		).toEqual({ current: 17, max: 200 });
		expect(() => activeSessionHeadroom([])).toThrow("active_sessions");
		expect(() =>
			activeSessionHeadroom([
				{
					current: 3,
					helpText: "",
					key: "active_sessions",
					label: "Active sessions",
					max: 3,
					unit: "count",
				},
			]),
		).toThrow("headroom");
	});
});

describe("Tenki output sanitization", () => {
	it("redacts every raw and encoded occurrence without changing safe metadata", () => {
		const token = "tk_secret/value";
		const sanitize = createOutputSanitizer([token]);
		const output = sanitize(
			`workspace=${WORKSPACE_ID} token=${token} again=${token} encoded=${encodeURIComponent(token)}`,
		);
		expect(output).toBe(
			`workspace=${WORKSPACE_ID} token=[REDACTED] again=[REDACTED] encoded=[REDACTED]`,
		);
		expect(output).not.toContain(token);
	});
});
