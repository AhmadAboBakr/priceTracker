import { getDatabase, saveDatabase } from './schema';
import { PriceQueries } from '../db/queries';
import { logger } from '../utils/logger';

/**
 * Generates realistic sample price data for the last 30 days.
 * Useful for testing the dashboard before the scrapers are fully tuned.
 */
async function generateSampleData(): Promise<void> {
  const db = await getDatabase();
  const queries = new PriceQueries(db);

  const items = queries.getAllItems();
  const stores = queries.getAllStores();

  if (items.length === 0 || stores.length === 0) {
    logger.error('No items or stores found. Run seed first: npm run seed');
    process.exit(1);
  }

  // Base prices per category (realistic UAE AED prices)
  const basePrices: Record<string, [number, number]> = {
    'Dairy & Eggs': [3, 35],
    'Bread & Bakery': [3, 8],
    'Rice & Grains': [5, 45],
    'Cooking Oil': [12, 30],
    'Condiments': [5, 15],
    'Protein': [15, 35],
    'Seafood': [10, 35],
    'Canned Goods': [3, 12],
    'Pasta & Noodles': [5, 10],
    'Beverages': [2, 25],
    'Frozen': [7, 18],
    'Fresh Produce': [3, 8],
    'Household': [10, 25],
  };

  const records: { itemId: number; storeId: number; price: number; scrapedAt: string }[] = [];

  for (const item of items) {
    const [minPrice, maxPrice] = basePrices[item.category] || [5, 20];
    // Generate a stable base price for this item
    const itemHash = hashCode(item.name);
    const basePrice = minPrice + (Math.abs(itemHash) % 100) / 100 * (maxPrice - minPrice);

    for (const store of stores) {
      // Each store has a slight price offset (-5% to +10%)
      const storeOffset = 1 + ((store.id * 7 + itemHash) % 15 - 5) / 100;
      const storeBasePrice = basePrice * storeOffset;

      // Generate 30 days of prices with small daily fluctuation
      for (let daysAgo = 30; daysAgo >= 0; daysAgo--) {
        const date = new Date();
        date.setDate(date.getDate() - daysAgo);
        date.setHours(8, 0, 0, 0);

        // Small daily fluctuation: -2% to +2%
        const dailyJitter = 1 + (Math.sin(daysAgo * 0.7 + store.id + itemHash * 0.01) * 0.02);
        // Slight upward trend over 30 days (0-3% inflation)
        const trend = 1 + (30 - daysAgo) * 0.001;

        const finalPrice = Math.round(storeBasePrice * dailyJitter * trend * 100) / 100;

        records.push({
          itemId: item.id,
          storeId: store.id,
          price: Math.max(0.5, finalPrice),
          scrapedAt: date.toISOString(),
        });
      }
    }
  }

  logger.info({ totalRecords: records.length }, 'Inserting sample price data');
  queries.insertPrices(records);

  // Also log some sample scrape logs
  for (const store of stores) {
    for (let daysAgo = 30; daysAgo >= 0; daysAgo--) {
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      date.setHours(8, 0, 0, 0);

      queries.logScrapeRun(
        store.id,
        'success',
        items.length,
        0,
        null,
        Math.floor(120000 + Math.random() * 60000),
        date.toISOString()
      );
    }
  }

  saveDatabase(db);
  db.close();
  logger.info('Sample data generation complete');
}

function hashCode(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const char = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash;
}

generateSampleData().catch((err) => {
  logger.error(err, 'Sample data generation failed');
  process.exit(1);
});
