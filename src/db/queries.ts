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

  /**
   * Detects anomalous prices for each item.
   * Uses the **median** price across stores as the reference point (robust to outliers).
   * Only flags prices where fewer than half the stores agree with that price range,
   * preventing the majority of correct prices from being flagged when one store is wrong.
   * Zero and negative prices are excluded.
   */
  detectAnomalies(deviationPct: number = 20): { id: number; itemId: number; storeId: number; price: number; storeName: string; itemName: string; trimmedMean: number }[] {
    // Get latest prices per item+store, excluding zero/negative prices
    const latestPrices = queryAll(this.db, `
      SELECT ph.id, ph.item_id, ph.store_id, ph.price, ph.scraped_at,
             i.name as item_name, s.name as store_name
      FROM price_history ph
      INNER JOIN (
        SELECT item_id, store_id, MAX(scraped_at) as max_date
        FROM price_history
        WHERE price > 0
        GROUP BY item_id, store_id
      ) latest ON ph.item_id = latest.item_id
               AND ph.store_id = latest.store_id
               AND ph.scraped_at = latest.max_date
      JOIN items i ON i.id = ph.item_id
      JOIN stores s ON s.id = ph.store_id
      WHERE ph.price > 0
    `);

    // Group by item_id
    const byItem = new Map<number, typeof latestPrices>();
    for (const row of latestPrices) {
      if (!byItem.has(row.item_id)) byItem.set(row.item_id, []);
      byItem.get(row.item_id)!.push(row);
    }

    const anomalies: { id: number; itemId: number; storeId: number; price: number; storeName: string; itemName: string; trimmedMean: number }[] = [];

    for (const [_itemId, rows] of byItem) {
      const validRows = rows.filter((r) => r.price > 0);
      if (validRows.length < 3) continue;

      // Use MEDIAN as reference — immune to outliers
      const sorted = [...validRows].sort((a, b) => a.price - b.price);
      const mid = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 === 0
          ? (sorted[mid - 1].price + sorted[mid].price) / 2
          : sorted[mid].price;

      if (median <= 0) continue;

      const threshold = deviationPct / 100;

      // Count how many stores are within the acceptable range of the median
      const inRange = validRows.filter(
        (r) => Math.abs(r.price - median) / median <= threshold
      );

      // Safety: only flag outliers when the MAJORITY of stores agree on the price range.
      // If more than half would be flagged, something is wrong — skip this item entirely.
      if (inRange.length < validRows.length / 2) continue;

      for (const row of validRows) {
        const deviation = Math.abs(row.price - median) / median;
        if (deviation > threshold) {
          anomalies.push({
            id: row.id,
            itemId: row.item_id,
            storeId: row.store_id,
            price: row.price,
            storeName: row.store_name,
            itemName: row.item_name,
            trimmedMean: parseFloat(median.toFixed(2)), // field kept as "trimmedMean" for API compat
          });
        }
      }
    }

    return anomalies;
  }

  /** Deletes specific price_history rows by ID */
  deleteAnomalies(ids: number[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    this.db.run(`DELETE FROM price_history WHERE id IN (${placeholders})`, ids);
    saveDatabase(this.db);
    return ids.length;
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
