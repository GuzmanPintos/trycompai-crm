import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { Inject, Injectable } from "@nestjs/common";
import type { Cache } from "cache-manager";

const CATALOG_TTL_MS = 30 * 60_000;
const CATALOG_KEY = "settings:model-catalog";

export interface CatalogModel {
	id: string;
	name: string;
	provider: string;
	contextWindowTokens: number;
	pricing: { input: number; output: number } | null;
}

const PRODUCTION_MODELS: CatalogModel[] = [
	{
		id: "openai/gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		provider: "openai",
		contextWindowTokens: 400_000,
		pricing: null,
	},
];

@Injectable()
export class ModelCatalogService {
	constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

	async models(): Promise<CatalogModel[] | null> {
		const cached = await this.cache.get<CatalogModel[]>(CATALOG_KEY);
		if (cached) return cached;

		const models = PRODUCTION_MODELS.map((model) => ({ ...model }));
		await this.cache.set(CATALOG_KEY, models, CATALOG_TTL_MS);
		return models;
	}

	async find(id: string): Promise<CatalogModel | null> {
		const models = await this.models();
		return models?.find((model) => model.id === id) ?? null;
	}
}
