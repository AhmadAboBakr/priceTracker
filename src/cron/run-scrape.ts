import { getDatabase, saveDatabase } from '../db/schema';
import { PriceQueries } from '../db/queries';
import { scrapeAllStores } from '../scrapers';
import { logger } from '../utils/logger';

/**
 * Main entry point for the daily scrape cron job.
 * Run via: npx ts-node src/cron/run-scrape.ts
 * Or schedule with crontab: 0 8 * * * cd /path/to/project && npx ts-node src/cron/run-scrape.ts
 */
async function runScrape(): Promise<void> {
  const jobStart = new Date().toISOString();
  logger.info({ startedAt: jobStart }, 'Daily scrape job starting');

  const db = await getDatabase();
  const queries = new PriceQueries(db);

  const stores = queries.getAllStores();
  if (stores.length === 0) {
    logger.error('No stores found in database. Run seed first: npm run seed');
    process.exit(1);
  }

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

  // Run the scrape
  const summaries = await scrapeAllStores(stores, itemsByStore);

  // Insert successful results into price_history
  const now = new Date().toISOString();
  let totalInserted = 0;

  for (const summary of summaries) {
    const successfulPrices = summary.results
      .filter((r) => r.success && r.price !== null)
      .map((r) => ({
        itemId: r.itemId,
        storeId: r.storeId,
        price: r.price!,
        scrapedAt: now,
      }));

    if (successfulPrices.length > 0) {
      const inserted = queries.insertPrices(successfulPrices);
      totalInserted += inserted;
    }

    // Log scrape run for this store
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
      totalSuccess,
      totalFailed,
      totalDurationMs: totalDuration,
      stores: summaries.map((s) => ({
        name: s.storeName,
        success: s.successCount,
        failed: s.failedCount,
      })),
    },
    'Daily scrape job completed'
  );

  process.exit(totalFailed > 0 && totalSuccess === 0 ? 1 : 0);
}

runScrape().catch((err) => {
  logger.error(err, 'Scrape job crashed');
  process.exit(1);
});
