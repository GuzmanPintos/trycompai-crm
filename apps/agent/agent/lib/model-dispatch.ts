export const DEFAULT_MODEL_DISPATCH_CONCURRENCY = 2;
export const MAX_MODEL_DISPATCH_CONCURRENCY = 20;

export function modelDispatchConcurrency(
	value = process.env.EVE_MODEL_DISPATCH_CONCURRENCY,
): number {
	if (value === undefined || value.trim() === "") {
		return DEFAULT_MODEL_DISPATCH_CONCURRENCY;
	}

	const parsed = Number(value);
	if (
		!Number.isInteger(parsed) ||
		parsed < 1 ||
		parsed > MAX_MODEL_DISPATCH_CONCURRENCY
	) {
		throw new Error(
			`EVE_MODEL_DISPATCH_CONCURRENCY must be an integer from 1 to ${MAX_MODEL_DISPATCH_CONCURRENCY}.`,
		);
	}
	return parsed;
}

export async function dispatchModelSessions<T>(
	items: readonly T[],
	dispatch: (item: T) => Promise<unknown>,
	concurrency = modelDispatchConcurrency(),
): Promise<void> {
	for (let index = 0; index < items.length; index += concurrency) {
		await Promise.all(items.slice(index, index + concurrency).map(dispatch));
	}
}
