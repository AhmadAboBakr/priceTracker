import { getDatabase, saveDatabase } from '../db/schema';
import { PriceQueries } from '../db/queries';
import { scrapeAllStores } from '../scrapers';
import { logger } from '../utils/logger';

/**
 * Main entry point for the scrape job.
 *
 * Usage:
 *   npx ts-node src/cron/run-scrape.ts                  # scrape all stores
 *   npx ts-node src/cron/run-scrape.ts --store Lulu      # scrape one store (partial match, case-insensitive)
 *   npx ts-node src/cron/run-scrape.ts --store "Union Coop"
 *   npx ts-node src/cron/run-scrape.ts --list            # list available store names
 *
 * Or schedule with crontab: 0 8 * * * cd /path/to/project && npx ts-node src/cron/run-scrape.ts
 */
async function runScrape(): Promise<void> {
  const jobStart = new Date().toISOString();

  const db = await getDatabase();
  const queries = new PriceQueries(db);

  let allStores = queries.getAllStores();
  if (allStores.length === 0) {
    logger.error('No stores found in database. Run seed first: npm run seed');
    process.exit(1);
  }

  // ── CLI flags ──────────────────────────────────────
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    console.log('\nAvailable stores:');
    for (const s of allStores) {
      console.log(`  • ${s.name}  (id: ${s.id})`);
    }
    process.exit(0);
  }

  const storeIdx = args.indexOf('--store');
  if (storeIdx !== -1) {
    const storeArg = args[storeIdx + 1];
    if (!storeArg) {
      console.error('Error: --store requires a store name argument');
      process.exit(1);
    }
    const needle = storeArg.toLowerCase();
    const matched = allStores.filter((s) => s.name.toLowerCase().includes(needle));
    if (matched.length === 0) {
      console.error(`No store matching "${storeArg}". Use --list to see available stores.`);
      process.exit(1);
    }
    allStores = matched;
    logger.info({ stores: allStores.map((s) => s.name) }, `Scraping filtered store(s)`);
  }

  const stores = allStores;
  logger.info({ startedAt: jobStart, storeCount: stores.length }, 'Scrape job starting');

  // Build item lists per store from mappings
  const itemsByStore = new Map<number, { itemId: number; searchQuery: string }[]>();
  for (const store of stores) {
    const mappings = queries.getMappingsForStore(store.id);
    itemsByStore.set(
      store.id,
      mappings.map((m) => ({
        itemId: m.item_id,
        searchQuery: m.search_query,
      }))
    );
  }

  // Run the scrape — insert each result immediately, skip same-day duplicates
  const now = new Date().toISOString();
  let totalInserted = 0;
  let totalSkipped = 0;

  const summaries = await scrapeAllStores(stores, itemsByStore, (result) => {
    if (!result.success || result.price === null) return;

    const inserted = queries.insertPriceIfNew(
      result.itemId,
      result.storeId,
      result.price,
      now
    );

    if (inserted) {
      totalInserted++;
      logger.debug(
        { itemId: result.itemId, storeId: result.storeId, price: result.price },
        'Price inserted'
      );
    } else {
      totalSkipped++;
      logger.debug(
        { itemId: result.itemId, storeId: result.storeId },
        'Skipped — already scraped today'
      );
    }
  });

  // Log scrape runs per store
  for (const summary of summaries) {
    const status =
      summary.failedCount === 0
        ? 'success'
        : summary.successCount > 0
          ? 'partial'
          : 'failed';

    queries.logScrapeRun(
      summary.storeId,
      status,
      summary.successCount,
      summary.failedCount,
      summary.failedCount > 0
        ? `${summary.failedCount} items failed to scrape`
        : null,
      summary.durationMs,
      jobStart
    );
  }

  saveDatabase(db);
  db.close();

  const totalSuccess = summaries.reduce((s, r) => s + r.successCount, 0);
  const totalFailed = summaries.reduce((s, r) => s + r.failedCount, 0);
  const totalDuration = summaries.reduce((s, r) => s + r.durationMs, 0);

  logger.info(
    {
      totalInserted,
      totalSkipped,
      totalSuccess,
      totalFailed,
      totalDurationMs: totalDuration,
      stores: summaries.map((s) => ({
        name: s.storeName,
        success: s.successCount,
        failed: s.failedCount,
      })),
    },
    'Scrape job completed'
  );

  process.exit(totalFailed > 0 && totalSuccess === 0 ? 1 : 0);
}

runScrape().catch((err) => {
  logger.error(err, 'Scrape job crashed');
  process.exit(1);
});
