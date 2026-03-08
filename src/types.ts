/** Represents a supermarket store */
export interface Store {
  id: number;
  name: string;
  url: string;
  searchUrl: string;
  createdAt: string;
}

/** Represents a tracked grocery item */
export interface Item {
  id: number;
  name: string;
  category: string;
  unit: string;
  standardSize: string;
  createdAt: string;
}

/** Maps an item to a store with search configuration */
export interface ItemStoreMapping {
  id: number;
  itemId: number;
  storeId: number;
  searchQuery: string;
}

/** A single price record */
export interface PriceRecord {
  id: number;
  itemId: number;
  storeId: number;
  price: number;
  currency: string;
  scrapedAt: string;
  createdAt: string;
}

/** Result from a single product scrape attempt */
export interface ScrapedProduct {
  itemId: number;
  storeId: number;
  name: string;
  price: number;
  currency: string;
  url?: string;
  confidence: number;
}

/** Scraper run log entry */
export interface ScrapeLog {
  id: number;
  storeId: number;
  status: 'success' | 'partial' | 'failed';
  itemsScraped: number;
  itemsFailed: number;
  errorMessage?: string;
  durationMs: number;
  startedAt: string;
  completedAt: string;
}

/** Error types the scraper can encounter */
export enum ScraperErrorType {
  Network = 'network',
  Timeout = 'timeout',
  SelectorMismatch = 'selector',
  RateLimited = 'rate_limit',
  StoreOffline = 'offline',
  ParseError = 'parse',
  Unknown = 'unknown',
}

/** Dashboard API response: item with latest prices */
export interface ItemWithPrices {
  id: number;
  name: string;
  category: string;
  unit: string;
  standardSize: string;
  prices: Record<number, { price: number; date: string } | null>;
  changes: Record<number, number | null>;
}

/** Dashboard API response: price history point */
export interface PriceHistoryPoint {
  date: string;
  prices: Record<number, number | null>;
}

/** Dashboard API response: basket total point */
export interface BasketPoint {
  date: string;
  totals: Record<number, number | null>;
  itemCount: Record<number, number>;
}
