import { Database } from 'sql.js';
import { saveDatabase } from './schema';
type SqlJsDatabase = Database;

/** Runs a SELECT and returns an array of plain objects */
function queryAll(db: SqlJsDatabase, sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/** Provides all database operations for the price tracker */
export class PriceQueries {
  constructor(private db: SqlJsDatabase) {}

  /** Gets all stores */
  getAllStores() {
    return queryAll(this.db, 'SELECT * FROM stores ORDER BY name');
  }

  /** Gets all tracked items */
  getAllItems() {
    return queryAll(this.db, 'SELECT * FROM items ORDER BY category, name');
  }

  /** Gets store-specific search mappings for a given store */
  getMappingsForStore(storeId: number) {
    return queryAll(
      this.db,
      `SELECT ism.*, i.name as item_name, i.category, i.unit, i.standard_size
       FROM item_store_mapping ism
       JOIN items i ON i.id = ism.item_id
       WHERE ism.store_id = ?`,
      [storeId]
    );
  }

  /** Inserts a batch of price records and persists to disk */
  insertPrices(records: { itemId: number; storeId: number; price: number; scrapedAt: string }[]): number {
    let count = 0;
    for (const r of records) {
      this.db.run(
        `INSERT INTO price_history (item_id, store_id, price, currency, scraped_at)
         VALUES (?, ?, ?, 'AED', ?)`,
        [r.itemId, r.storeId, r.price, r.scrapedAt]
      );
      count++;
    }
    saveDatabase(this.db);
    return count;
  }

  /** Gets the most recent price for every item/store pair */
  getLatestPrices() {
    return queryAll(this.db, `
      SELECT ph.item_id, ph.store_id, ph.price, ph.scraped_at
      FROM price_history ph
      INNER JOIN (
        SELECT item_id, store_id, MAX(scraped_at) as max_date
        FROM price_history
        GROUP BY item_id, store_id
      ) latest ON ph.item_id = latest.item_id
               AND ph.store_id = latest.store_id
               AND ph.scraped_at = latest.max_date
    `);
  }

  /** Gets the second-most-recent price for every item/store pair (for % change) */
  getPreviousPrices() {
    return queryAll(this.db, `
      WITH ranked AS (
        SELECT item_id, store_id, price, scraped_at,
               ROW_NUMBER() OVER (PARTITION BY item_id, store_id ORDER BY scraped_at DESC) as rn
        FROM price_history
      )
      SELECT item_id, store_id, price, scraped_at
      FROM ranked WHERE rn = 2
    `);
  }

  /** Gets price history for a single item within N days */
  getItemHistory(itemId: number, days: number) {
    return queryAll(this.db, `
      SELECT item_id, store_id, price, DATE(scraped_at) as date
      FROM price_history
      WHERE item_id = ?
        AND scraped_at >= datetime('now', '-' || ? || ' days')
      ORDER BY scraped_at ASC
    `, [itemId, days]);
  }

  /** Gets average price per item per store per day (excludes out-of-stock = -1) */
  getBasketHistory(days: number) {
    return queryAll(this.db, `
      SELECT DATE(scraped_at) as date, store_id,
             ROUND(AVG(price), 2) as avg_price,
             ROUND(SUM(price), 2) as total,
             COUNT(DISTINCT item_id) as item_count
      FROM price_history
      WHERE scraped_at >= datetime('now', '-' || ? || ' days')
        AND price > 0
      GROUP BY DATE(scraped_at), store_id
      ORDER BY date ASC
    `, [days]);
  }

  /** Logs a scraper run and persists */
  logScrapeRun(storeId: number | null, status: string, itemsScraped: number, itemsFailed: number, errorMessage: string | null, durationMs: number, startedAt: string): void {
    this.db.run(
      `INSERT INTO scrape_logs (store_id, status, items_scraped, items_failed,
                                error_message, duration_ms, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [storeId, status, itemsScraped, itemsFailed, errorMessage, durationMs, startedAt]
    );
    saveDatabase(this.db);
  }

  /** Gets recent scrape log entries */
  getRecentScrapeLogs(limit: number = 20) {
    return queryAll(this.db, `
      SELECT sl.*, s.name as store_name
      FROM scrape_logs sl
      LEFT JOIN stores s ON s.id = sl.store_id
      ORDER BY sl.completed_at DESC
      LIMIT ?
    `, [limit]);
  }

  /** Gets aggregate stats per store (latest basket total, excludes out-of-stock) */
  getStats() {
    return queryAll(this.db, `
      SELECT
        s.id as store_id, s.name as store_name,
        ROUND(SUM(ph.price), 2) as basket_total,
        COUNT(DISTINCT ph.item_id) as items_tracked
      FROM price_history ph
      JOIN stores s ON s.id = ph.store_id
      INNER JOIN (
        SELECT item_id, store_id, MAX(scraped_at) as max_date
        FROM price_history
        GROUP BY item_id, store_id
      ) latest ON ph.item_id = latest.item_id
               AND ph.store_id = latest.store_id
               AND ph.scraped_at = latest.max_date
      WHERE ph.price > 0
      GROUP BY s.id
    `);
  }
}
