import { describe, expect, it, mock } from "bun:test";
import { GoogleSyncStatus, type MailboxSyncModel } from "@crm/db";
import { CalendarSyncService } from "../src/google/calendar-sync.service";

type EventsQuery = {
	syncToken?: string;
	timeMin?: string;
	timeMax?: string;
	pageToken?: string;
};

describe("CalendarSyncService", () => {
	it("continues beyond the per-tick page budget without restarting the window", async () => {
		const queries: EventsQuery[] = [];
		const listEvents = mock(
			async (_accessToken: string, query: EventsQuery) => {
				queries.push(query);
				const page = queries.length;

				if (page <= 5) {
					return {
						outcome: "ok" as const,
						data: { items: [], nextPageToken: `page-${page + 1}` },
					};
				}

				return {
					outcome: "ok" as const,
					data: { items: [], nextSyncToken: "next-sync-token" },
				};
			},
		);
		const settled: Array<{
			cursor?: string | null;
			status: GoogleSyncStatus;
		}> = [];
		const state = {
			markRunning: mock(async () => undefined),
			settle: mock(
				async (
					_id: string,
					update: { cursor?: string | null; status: GoogleSyncStatus },
				) => {
					settled.push(update);
				},
			),
		};
		const service = new CalendarSyncService(
			{} as never,
			{ listEvents } as never,
			{
				accessTokenFor: mock(async () => ({
					outcome: "ok" as const,
					accessToken: "test-access-token",
				})),
			} as never,
			{
				internalIdentity: mock(async () => ({
					addresses: new Set<string>(),
					domains: new Set<string>(),
				})),
				suppressedDomains: mock(async () => new Set<string>()),
				suppressedEmails: mock(async () => new Set<string>()),
			} as never,
			state as never,
			{} as never,
			{} as never,
		);
		const row = {
			id: "sync-1",
			userId: "user-1",
			source: "calendar",
			status: GoogleSyncStatus.IDLE,
			cursor: null,
			lastSyncedAt: null,
			lastError: null,
			retryAfter: null,
			autoCreate: true,
			createdAt: new Date("2026-08-11T00:00:00Z"),
			updatedAt: new Date("2026-08-11T00:00:00Z"),
		} satisfies MailboxSyncModel;

		const first = await service.sync(row);

		expect(first.reason).toBe("Page budget reached; continuing next tick.");
		expect(queries).toHaveLength(5);
		expect(settled[0]?.status).toBe(GoogleSyncStatus.IDLE);
		expect(settled[0]?.cursor).toStartWith("calendar-page-v1:");

		await service.sync({ ...row, cursor: settled[0]?.cursor ?? null });

		expect(queries).toHaveLength(6);
		expect(queries[5]).toMatchObject({
			pageToken: "page-6",
			timeMin: queries[0]?.timeMin,
			timeMax: queries[0]?.timeMax,
		});
		expect(settled[1]).toEqual({
			cursor: "next-sync-token",
			status: GoogleSyncStatus.RUNNING,
		});
	});
});
