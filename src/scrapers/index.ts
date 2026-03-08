import { BaseScraper, ScrapeResult } from './base-scraper';
import { LuluScraper } from './lulu.scraper';
import { CarrefourScraper } from './carrefour.scraper';
import { UnionCoopScraper } from './union-coop.scraper';
import { logger } from '../utils/logger';

/** Stores to skip during scraping (re-enable by removing from this set) */
const DISABLED_STORES = new Set([
  'Carrefour UAE',  // TODO: re-enable once anti-bot issues are resolved
]);

/** Maps store names to their scraper constructors */
const SCRAPER_MAP: Record<string, (storeId: number) => BaseScraper> = {
  'Lulu Hypermarket': (id) => new LuluScraper(id),
  'Carrefour UAE': (id) => new CarrefourScraper(id),
  'Union Coop': (id) => new UnionCoopScraper(id),
};

/** Creates the appropriate scraper for a given store */
export function createScraper(
  storeName: string,
  storeId: number
): BaseScraper | null {
  const factory = SCRAPER_MAP[storeName];
  if (!factory) {
    logger.error({ storeName }, 'No scraper registered for store');
    return null;
  }
  return factory(storeId);
}

/** Result summary for a single store scrape run */
export interface StoreScrapeSummary {
  storeId: number;
  storeName: string;
  totalItems: number;
  successCount: number;
  failedCount: number;
  results: ScrapeResult[];
  durationMs: number;
}

/** Runs scrapers for all stores sequentially */
export async function scrapeAllStores(
  stores: { id: number; name: string }[],
  itemsByStore: Map<number, { itemId: number; searchQuery: string }[]>
): Promise<StoreScrapeSummary[]> {
  const summaries: StoreScrapeSummary[] = [];

  for (const store of stores) {
    if (DISABLED_STORES.has(store.name)) {
      logger.warn({ store: store.name }, 'Store is disabled, skipping');
      continue;
    }

    const scraper = createScraper(store.name, store.id);
    if (!scraper) {
      summaries.push({
        storeId: store.id,
        storeName: store.name,
        totalItems: 0,
        successCount: 0,
        failedCount: 0,
        results: [],
        durationMs: 0,
      });
      continue;
    }

    const items = itemsByStore.get(store.id) || [];
    const start = Date.now();

    logger.info(
      { store: store.name, itemCount: items.length },
      'Starting store scrape'
    );

    try {
      const results = await scraper.scrapeAll(items);
      const successCount = results.filter((r) => r.success).length;
      const failedCount = results.filter((r) => !r.success).length;

      summaries.push({
        storeId: store.id,
        storeName: store.name,
        totalItems: items.length,
        successCount,
        failedCount,
        results,
        durationMs: Date.now() - start,
      });

      logger.info(
        { store: store.name, successCount, failedCount, durationMs: Date.now() - start },
        'Store scrape completed'
      );
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ store: store.name, error: errMsg }, 'Store scrape crashed');
      summaries.push({
        storeId: store.id,
        storeName: store.name,
        totalItems: items.length,
        successCount: 0,
        failedCount: items.length,
        results: [],
        durationMs: Date.now() - start,
      });
    }
  }

  return summaries;
}

export { BaseScraper, ScrapeResult };
