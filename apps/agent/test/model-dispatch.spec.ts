import { describe, expect, it } from "bun:test";
import {
	dispatchModelSessions,
	modelDispatchConcurrency,
} from "../agent/lib/model-dispatch";

describe("initial Eve model-session dispatch", () => {
	it("defaults to two and accepts an explicit bounded limit", () => {
		expect(modelDispatchConcurrency(undefined)).toBe(2);
		expect(modelDispatchConcurrency("")).toBe(2);
		expect(modelDispatchConcurrency("1")).toBe(1);
		expect(modelDispatchConcurrency("2")).toBe(2);
		expect(modelDispatchConcurrency("20")).toBe(20);
	});

	it("rejects malformed and unsafe limits", () => {
		for (const value of ["0", "21", "1.5", "many"]) {
			expect(() => modelDispatchConcurrency(value)).toThrow(
				"EVE_MODEL_DISPATCH_CONCURRENCY",
			);
		}
	});

	it("starts work in bounded batches", async () => {
		let active = 0;
		let maximum = 0;
		const releases: Array<() => void> = [];
		const started: number[] = [];
		const releaseAll = () => {
			for (const release of releases.splice(0)) release();
		};

		const running = dispatchModelSessions(
			[1, 2, 3, 4, 5],
			async (value) => {
				started.push(value);
				active += 1;
				maximum = Math.max(maximum, active);
				await new Promise<void>((resolve) => releases.push(resolve));
				active -= 1;
			},
			2,
		);

		await Bun.sleep(0);
		expect(started).toEqual([1, 2]);
		releaseAll();
		await Bun.sleep(0);
		expect(started).toEqual([1, 2, 3, 4]);
		releaseAll();
		await Bun.sleep(0);
		expect(started).toEqual([1, 2, 3, 4, 5]);
		releaseAll();
		await running;

		expect(maximum).toBe(2);
	});
});
