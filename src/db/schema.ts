import initSqlJs, { Database } from 'sql.js';
type SqlJsDatabase = Database;
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { logger } from '../utils/logger';

dotenv.config();

const DB_PATH = path.resolve(process.env.DATABASE_PATH || './data/prices.db');

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    url TEXT NOT NULL,
    search_url TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    category TEXT NOT NULL,
    unit TEXT NOT NULL,
    standard_size TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS item_store_mapping (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    store_id INTEGER NOT NULL,
    search_query TEXT NOT NULL,
    FOREIGN KEY (item_id) REFERENCES items(id),
    FOREIGN KEY (store_id) REFERENCES stores(id),
    UNIQUE(item_id, store_id)
  );

  CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    store_id INTEGER NOT NULL,
    price REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'AED',
    scraped_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY (item_id) REFERENCES items(id),
    FOREIGN KEY (store_id) REFERENCES stores(id)
  );

  CREATE INDEX IF NOT EXISTS idx_price_history_lookup
    ON price_history(item_id, store_id, scraped_at DESC);

  CREATE INDEX IF NOT EXISTS idx_price_history_date
    ON price_history(scraped_at DESC);

  CREATE TABLE IF NOT EXISTS scrape_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER,
    status TEXT NOT NULL CHECK(status IN ('success', 'partial', 'failed')),
    items_scraped INTEGER DEFAULT 0,
    items_failed INTEGER DEFAULT 0,
    error_message TEXT,
    duration_ms INTEGER,
    started_at DATETIME NOT NULL,
    completed_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY (store_id) REFERENCES stores(id)
  );
`;

/** Opens or creates the SQLite database, returns the sql.js Database instance */
export async function getDatabase(): Promise<SqlJsDatabase> {
  const SQL = await initSqlJs();

  let db: SqlJsDatabase;
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
    logger.info({ path: DB_PATH }, 'Opened existing database');
  } else {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new SQL.Database();
    logger.info({ path: DB_PATH }, 'Created new database');
  }

  db.run('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  saveDatabase(db);
  return db;
}

/** Persists the in-memory database to disk */
export function saveDatabase(db: SqlJsDatabase): void {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}
