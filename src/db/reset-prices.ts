import { getDatabase, saveDatabase } from './schema';
import { logger } from '../utils/logger';

/**
 * Wipes all price history and scrape logs while keeping
 * stores, items, and mappings intact.
 * Run this before switching from sample data to real scraping.
 */
async function resetPrices(): Promise<void> {
  const db = await getDatabase();

  db.run('DELETE FROM price_history');
  db.run('DELETE FROM scrape_logs');

  saveDatabase(db);
  db.close();

  logger.info('Cleared all price history and scrape logs. Stores and items are untouched.');
}

resetPrices().catch((err) => {
  logger.error(err, 'Reset failed');
  process.exit(1);
});
