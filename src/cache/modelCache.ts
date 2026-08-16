import * as vscode from 'vscode';
import { ProcessedModel, CacheMetadata } from '../types/models';
import { Logger } from '../utils/logger';

const CACHE_KEY = 'openrouter-model-cache';
const CACHE_META_KEY = 'openrouter-cache-meta';
const CACHE_VERSION = '1';

/**
 * Manages model cache with in-memory and persistent storage.
 * Uses VS Code globalState for persistence across sessions.
 */
export class ModelCache {
  private inMemoryModels: ProcessedModel[] = [];
  private isLoaded = false;

  constructor(private readonly globalState: vscode.Memento) {}

  /**
   * Get all cached models. Returns empty array if cache is empty.
   */
  getModels(): ProcessedModel[] {
    return this.inMemoryModels;
  }

  /**
   * Check if the cache has any models loaded.
   */
  hasModels(): boolean {
    return this.inMemoryModels.length > 0;
  }

  /**
   * Load models from persistent storage into memory.
   */
  async loadFromDisk(): Promise<ProcessedModel[]> {
    try {
      const cached = this.globalState.get<ProcessedModel[]>(CACHE_KEY);
      if (cached && Array.isArray(cached) && cached.length > 0) {
        this.inMemoryModels = cached;
        this.isLoaded = true;
        Logger.info(`Loaded ${cached.length} models from cache`);
        return cached;
      }
    } catch (error) {
      Logger.warn('Failed to load models from cache', error);
    }
    return [];
  }

  /**
   * Store models in both memory and persistent storage.
   */
  async saveModels(models: ProcessedModel[]): Promise<void> {
    this.inMemoryModels = models;
    this.isLoaded = true;

    const meta: CacheMetadata = {
      lastUpdated: Date.now(),
      modelCount: models.length,
      version: CACHE_VERSION,
    };

    await this.globalState.update(CACHE_KEY, models);
    await this.globalState.update(CACHE_META_KEY, meta);

    Logger.info(`Cached ${models.length} models`);
  }

  /**
   * Get cache metadata (last updated time, count, etc.)
   */
  getMetadata(): CacheMetadata | undefined {
    return this.globalState.get<CacheMetadata>(CACHE_META_KEY);
  }

  /**
   * Check if the cache is stale based on TTL setting.
   */
  isStale(): boolean {
    const meta = this.getMetadata();
    if (!meta) { return true; }

    const ttlMinutes = vscode.workspace
      .getConfiguration('openrouterMaestro')
      .get<number>('cache.ttlMinutes', 60);

    const ageMs = Date.now() - meta.lastUpdated;
    return ageMs > ttlMinutes * 60 * 1000;
  }

  /**
   * Clear all cached data.
   */
  async clear(): Promise<void> {
    this.inMemoryModels = [];
    this.isLoaded = false;
    await this.globalState.update(CACHE_KEY, undefined);
    await this.globalState.update(CACHE_META_KEY, undefined);
    Logger.info('Cache cleared');
  }

  /**
   * Get a specific model by ID.
   */
  getModel(id: string): ProcessedModel | undefined {
    return this.inMemoryModels.find((m) => m.id === id);
  }

  /**
   * Get all unique provider names.
   */
  getProviders(): string[] {
    const providers = new Set(this.inMemoryModels.map((m) => m.provider));
    return [...providers].sort();
  }
}
