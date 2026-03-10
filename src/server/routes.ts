import { Router, Request, Response } from 'express';
import { PriceQueries } from '../db/queries';
import { Database } from 'sql.js';

/** Creates all API routes with the given database connection */
export function createRouter(db: Database): Router {
  const router = Router();
  const queries = new PriceQueries(db);

  // GET /api/stores — all stores
  router.get('/stores', (_req: Request, res: Response) => {
    try {
      const stores = queries.getAllStores();
      res.json(stores);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch stores' });
    }
  });

  // GET /api/items — all items with latest prices and % change
  router.get('/items', (_req: Request, res: Response) => {
    try {
      const items = queries.getAllItems();
      const stores = queries.getAllStores();
      const latestPrices = queries.getLatestPrices();
      const prevPrices = queries.getPreviousPrices();

      // Build lookup maps
      const latestMap = new Map<string, any>();
      for (const p of latestPrices) {
        latestMap.set(`${p.item_id}-${p.store_id}`, p);
      }
      const prevMap = new Map<string, any>();
      for (const p of prevPrices) {
        prevMap.set(`${p.item_id}-${p.store_id}`, p);
      }

      const result = items.map((item: any) => {
        const prices: Record<number, any> = {};
        const changes: Record<number, number | null> = {};

        for (const store of stores) {
          const key = `${item.id}-${store.id}`;
          const latest = latestMap.get(key);
          const prev = prevMap.get(key);

          if (latest) {
            prices[store.id] = {
              price: latest.price,
              date: latest.scraped_at,
            };

            // Don't calculate % change for out-of-stock entries
            if (prev && prev.price > 0 && latest.price > 0) {
              changes[store.id] = parseFloat(
                (((latest.price - prev.price) / prev.price) * 100).toFixed(2)
              );
            } else {
              changes[store.id] = null;
            }
          } else {
            prices[store.id] = null;
            changes[store.id] = null;
          }
        }

        return {
          id: item.id,
          name: item.name,
          category: item.category,
          unit: item.unit,
          standardSize: item.standard_size,
          prices,
          changes,
        };
      });

      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch items' });
    }
  });

  // GET /api/items/:id/history?days=30 — price history for one item
  router.get('/items/:id/history', (req: Request, res: Response) => {
    try {
      const itemId = parseInt(req.params.id, 10);
      const days = parseInt((req.query.days as string) || '30', 10);

      if (isNaN(itemId)) {
        res.status(400).json({ error: 'Invalid item ID' });
        return;
      }

      const history = queries.getItemHistory(itemId, days);

      // Group by date
      const dateMap = new Map<string, Record<number, number>>();
      for (const row of history) {
        if (!dateMap.has(row.date)) dateMap.set(row.date, {});
        dateMap.get(row.date)![row.store_id] = row.price;
      }

      const result = Array.from(dateMap.entries()).map(([date, prices]) => ({
        date,
        prices,
      }));

      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch item history' });
    }
  });

  // GET /api/basket?days=30 — total basket cost per store per day
  router.get('/basket', (req: Request, res: Response) => {
    try {
      const days = parseInt((req.query.days as string) || '30', 10);
      const history = queries.getBasketHistory(days);

      // Group by date
      const dateMap = new Map<
        string,
        { totals: Record<number, number>; counts: Record<number, number>; avgs: Record<number, number> }
      >();
      for (const row of history) {
        if (!dateMap.has(row.date)) {
          dateMap.set(row.date, { totals: {}, counts: {}, avgs: {} });
        }
        const entry = dateMap.get(row.date)!;
        entry.totals[row.store_id] = row.total;
        entry.counts[row.store_id] = row.item_count;
        entry.avgs[row.store_id] = row.avg_price;
      }

      const result = Array.from(dateMap.entries()).map(
        ([date, { totals, counts, avgs }]) => ({
          date,
          totals,
          avgs,
          itemCount: counts,
        })
      );

      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch basket history' });
    }
  });

  // GET /api/stats — aggregated stats per store
  router.get('/stats', (_req: Request, res: Response) => {
    try {
      const stats = queries.getStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // POST /api/stores — add a new store
  router.post('/stores', (req: Request, res: Response) => {
    try {
      const { name, url, searchUrl } = req.body;

      if (!name) {
        res.status(400).json({ error: 'Store name is required' });
        return;
      }

      db.run(
        `INSERT INTO stores (name, url, search_url) VALUES (?, ?, ?)`,
        [name.trim(), url?.trim() || '', searchUrl?.trim() || '']
      );

      const row = db.exec(`SELECT last_insert_rowid() as id`);
      const newId = row[0]?.values[0]?.[0] as number;

      // Create item_store_mapping entries for all existing items
      const allItems = queries.getAllItems();
      for (const item of allItems) {
        db.run(
          `INSERT OR IGNORE INTO item_store_mapping (item_id, store_id, search_query) VALUES (?, ?, ?)`,
          [item.id, newId, item.name]
        );
      }

      const { saveDatabase: save } = require('../db/schema');
      save(db);

      res.json({ success: true, id: newId, name: name.trim() });
    } catch (err: any) {
      if (err.message?.includes('UNIQUE constraint')) {
        res.status(409).json({ error: 'A store with that name already exists' });
      } else {
        console.error(err);
        res.status(500).json({ error: 'Failed to create store' });
      }
    }
  });

  // DELETE /api/stores/:id — remove a store and its data
  router.delete('/stores/:id', (req: Request, res: Response) => {
    try {
      const storeId = parseInt(req.params.id, 10);
      if (isNaN(storeId)) {
        res.status(400).json({ error: 'Invalid store ID' });
        return;
      }

      db.run(`DELETE FROM price_history WHERE store_id = ?`, [storeId]);
      db.run(`DELETE FROM item_store_mapping WHERE store_id = ?`, [storeId]);
      db.run(`DELETE FROM scrape_logs WHERE store_id = ?`, [storeId]);
      db.run(`DELETE FROM stores WHERE id = ?`, [storeId]);

      const { saveDatabase: save } = require('../db/schema');
      save(db);

      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to delete store' });
    }
  });

  // POST /api/items — create a new tracked item
  router.post('/items', (req: Request, res: Response) => {
    try {
      const { name, category, unit, standardSize } = req.body;

      if (!name || !category) {
        res.status(400).json({ error: 'Name and category are required' });
        return;
      }

      db.run(
        `INSERT INTO items (name, category, unit, standard_size) VALUES (?, ?, ?, ?)`,
        [name, category, unit || 'unit', standardSize || '']
      );

      const row = db.exec(`SELECT last_insert_rowid() as id`);
      const newId = row[0]?.values[0]?.[0] as number;

      // Create store mappings for all stores
      const stores = queries.getAllStores();
      for (const store of stores) {
        db.run(
          `INSERT OR IGNORE INTO item_store_mapping (item_id, store_id, search_query) VALUES (?, ?, ?)`,
          [newId, store.id, name]
        );
      }

      const { saveDatabase: save } = require('../db/schema');
      save(db);

      res.json({ success: true, id: newId, name, category });
    } catch (err: any) {
      if (err.message?.includes('UNIQUE constraint')) {
        res.status(409).json({ error: 'An item with that name already exists' });
      } else {
        console.error(err);
        res.status(500).json({ error: 'Failed to create item' });
      }
    }
  });

  // DELETE /api/items/:id — remove an item from tracking
  router.delete('/items/:id', (req: Request, res: Response) => {
    try {
      const itemId = parseInt(req.params.id, 10);
      if (isNaN(itemId)) {
        res.status(400).json({ error: 'Invalid item ID' });
        return;
      }

      db.run(`DELETE FROM price_history WHERE item_id = ?`, [itemId]);
      db.run(`DELETE FROM item_store_mapping WHERE item_id = ?`, [itemId]);
      db.run(`DELETE FROM items WHERE id = ?`, [itemId]);

      const { saveDatabase: save } = require('../db/schema');
      save(db);

      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to delete item' });
    }
  });

  // POST /api/prices — manually insert prices
  router.post('/prices', (req: Request, res: Response) => {
    try {
      const { prices } = req.body;

      if (!Array.isArray(prices) || prices.length === 0) {
        res.status(400).json({ error: 'Body must contain a non-empty "prices" array' });
        return;
      }

      const now = new Date().toISOString();
      const records = prices
        .filter((p: any) => p.itemId && p.storeId && typeof p.price === 'number' && (p.price > 0 || p.price < 0))
        .map((p: any) => ({
          itemId: p.itemId,
          storeId: p.storeId,
          price: p.price < 0 ? -1 : p.price, // Normalize any negative to -1 (out of stock)
          scrapedAt: p.date || now,
        }));

      if (records.length === 0) {
        res.status(400).json({ error: 'No valid price entries found' });
        return;
      }

      const inserted = queries.insertPrices(records);
      res.json({ success: true, inserted });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to insert prices' });
    }
  });

  // GET /api/anomalies?deviation=15 — detect price anomalies
  router.get('/anomalies', (req: Request, res: Response) => {
    try {
      const deviation = parseFloat((req.query.deviation as string) || '15');
      const anomalies = queries.detectAnomalies(deviation);
      res.json({
        deviation,
        count: anomalies.length,
        anomalies,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to detect anomalies' });
    }
  });

  // DELETE /api/anomalies — remove detected anomalies (all or specific IDs)
  router.delete('/anomalies', (req: Request, res: Response) => {
    try {
      // If specific IDs are provided in the body, delete only those
      const { ids } = req.body || {};
      if (Array.isArray(ids) && ids.length > 0) {
        const numericIds = ids.map(Number).filter((n: number) => !isNaN(n) && n > 0);
        if (numericIds.length === 0) {
          res.status(400).json({ error: 'No valid IDs provided' });
          return;
        }
        const removed = queries.deleteAnomalies(numericIds);
        res.json({ removed });
        return;
      }

      // Otherwise detect and remove all anomalies at the given deviation
      const deviation = parseFloat((req.query.deviation as string) || '15');
      const anomalies = queries.detectAnomalies(deviation);

      if (anomalies.length === 0) {
        res.json({ removed: 0, message: 'No anomalies found' });
        return;
      }

      const allIds = anomalies.map((a) => a.id);
      const removed = queries.deleteAnomalies(allIds);

      res.json({
        removed,
        details: anomalies.map((a) => ({
          item: a.itemName,
          store: a.storeName,
          price: a.price,
          trimmedMean: a.trimmedMean,
        })),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to remove anomalies' });
    }
  });

  // GET /api/scrape-logs?limit=20 — recent scraper run logs
  router.get('/scrape-logs', (req: Request, res: Response) => {
    try {
      const limit = parseInt((req.query.limit as string) || '20', 10);
      const logs = queries.getRecentScrapeLogs(limit);
      res.json(logs);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch scrape logs' });
    }
  });

  return router;
}
