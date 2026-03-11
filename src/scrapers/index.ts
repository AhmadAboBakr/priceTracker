import { BaseScraper, ScrapeResult } from './base-scraper';
import { LuluScraper } from './lulu.scraper';
import { CarrefourScraper } from './carrefour.scraper';
import { UnionCoopScraper } from './union-coop.scraper';
import { GrandioseScraper } from './magento.scraper';
import { NoonScraper } from './noon.scraper';
import { SpinneysScraper } from './spinneys.scraper';
import { BarakatScraper } from './barakat.scraper';
import { ChoithramsScraper } from './choithrams.scraper';
import { logger } from '../utils/logger';

/**
 * Stores to skip during scraping.
 * Re-enable by removing from this set once a working approach is found.
 */
const DISABLED_STORES = new Set<string>([
  // Cloudflare WAF blocks all HTTP requests with 403
  // 'Lulu Hypermarket',  // RE-ENABLED — now uses Playwright stealth
  'Kibsons',

  // Corporate site only — no online store or e-commerce
  'West Zone',

  // Not real Magento — GraphQL returns HTML, no product data
  'VIVA Supermarket',

  // Magento markers but GraphQL 404, search 404 — locked down
  'Al Madina',

  // RE-ENABLED — autocomplete API + cheerio (.js-product-wrapper cards)
  // 'Spinneys',
]);

/** Maps store names to their scraper constructors */
const SCRAPER_MAP: Record<string, (storeId: number) => BaseScraper> = {
  // ─── Confirmed working ─────────────────────
  'Union Coop': (id) => new UnionCoopScraper(id),        // GraphQL ✅
  'Grandiose': (id) => new GrandioseScraper(id),          // GraphQL ✅
  'Noon Grocery': (id) => new NoonScraper(id),            // Catalog API + LD+JSON ✅
  'Barakat': (id) => new BarakatScraper(id),              // Next.js + AED prices ✅
  'Carrefour UAE': (id) => new CarrefourScraper(id),      // Cookie jar + escaped JSON ✅

  // ─── Server-rendered HTML scrapers ────────
  'Choithrams': (id) => new ChoithramsScraper(id),        // SSR search + cheerio ✅
  'Spinneys': (id) => new SpinneysScraper(id),            // Autocomplete API + cheerio ✅

  // ─── Playwright stealth (Cloudflare bypass) ──
  'Lulu Hypermarket': (id) => new LuluScraper(id),       // Playwright + stealth ✅
  'Kibsons': (id) => new SpinneysScraper(id),             // Placeholder — Cloudflare
  'West Zone': (id) => new GrandioseScraper(id),          // Placeholder — blocked
  'VIVA Supermarket': (id) => new GrandioseScraper(id),   // Placeholder — not Magento
  'Al Madina': (id) => new GrandioseScraper(id),          // Placeholder — locked down
};

/** Creates the appropriate scraper for a given store */
export function createScraper(
  storeName: string,
  storeId: number
): BaseScraper | null {
  const factory = SCRAPER_MAP[storeName];
  if (!factory) {
    logger.warn({ storeName }, 'No scraper registered for store — skipping');
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

/** Runs scrapers for all stores sequentially. When onResult is provided, each price is emitted immediately (not accumulated in memory). */
export async function scrapeAllStores(
  stores: { id: number; name: string }[],
  itemsByStore: Map<number, { itemId: number; searchQuery: string }[]>,
  onResult?: (result: ScrapeResult) => void
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
    let successCount = 0;
    let failedCount = 0;

    logger.info(
      { store: store.name, itemCount: items.length },
      'Starting store scrape'
    );

    try {
      if (onResult) {
        // Stream mode: emit each result immediately, don't accumulate
        await scraper.scrapeAll(items, (result) => {
          if (result.success) successCount++;
          else failedCount++;
          onResult(result);
        });

        summaries.push({
          storeId: store.id,
          storeName: store.name,
          totalItems: items.length,
          successCount,
          failedCount,
          results: [],  // not accumulated — already emitted
          durationMs: Date.now() - start,
        });
      } else {
        // Batch mode: collect all results in memory (legacy)
        const results = await scraper.scrapeAll(items);
        successCount = results.filter((r) => r.success).length;
        failedCount = results.filter((r) => !r.success).length;

        summaries.push({
          storeId: store.id,
          storeName: store.name,
          totalItems: items.length,
          successCount,
          failedCount,
          results,
          durationMs: Date.now() - start,
        });
      }

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
