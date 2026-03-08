import { chromium, Browser, Page } from 'playwright';
import { logger } from '../utils/logger';
import { retryWithBackoff } from '../utils/retry';
import { ScraperErrorType } from '../types';
import dotenv from 'dotenv';

dotenv.config();

/** Result from scraping a single product */
export interface ScrapeResult {
  itemId: number;
  storeId: number;
  searchQuery: string;
  productName: string | null;
  price: number | null;
  success: boolean;
  error?: string;
}

/** Configuration for a store scraper */
export interface StoreConfig {
  storeId: number;
  storeName: string;
  baseUrl: string;
  searchUrl: string;
  requestDelay: number;
}

/** Abstract base scraper with shared Playwright lifecycle and retry logic */
export abstract class BaseScraper {
  protected browser: Browser | null = null;
  protected page: Page | null = null;
  protected config: StoreConfig;

  constructor(config: StoreConfig) {
    this.config = config;
  }

  /** Launches headless browser with stealth settings to avoid bot detection */
  async initialize(): Promise<void> {
    const headless = process.env.HEADLESS !== 'false';
    this.browser = await chromium.launch({
      headless,
      args: [
        '--disable-http2',              // Fixes ERR_HTTP2_PROTOCOL_ERROR
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });
    const context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'en-AE',
      timezoneId: 'Asia/Dubai',
      // Spoof webdriver detection
      javaScriptEnabled: true,
    });

    // Remove navigator.webdriver flag that exposes automation
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      // Spoof plugins array (headless Chrome has empty plugins)
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });
      // Spoof languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en', 'ar'],
      });
    });

    this.page = await context.newPage();
    logger.info({ store: this.config.storeName }, 'Browser initialized');
  }

  /** Closes browser and releases resources */
  async cleanup(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }

  /** Scrapes price for a single item with retry */
  async scrapeItem(
    itemId: number,
    searchQuery: string
  ): Promise<ScrapeResult> {
    const maxRetries = parseInt(process.env.MAX_RETRIES || '3', 10);
    const baseDelay = parseInt(process.env.RETRY_BASE_DELAY || '2000', 10);

    try {
      const result = await retryWithBackoff(
        () => this.performSearch(itemId, searchQuery),
        { maxRetries, baseDelay }
      );
      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        { store: this.config.storeName, itemId, searchQuery, error: errMsg },
        'Scrape failed after retries'
      );
      return {
        itemId,
        storeId: this.config.storeId,
        searchQuery,
        productName: null,
        price: null,
        success: false,
        error: errMsg,
      };
    }
  }

  /** Scrapes all items for this store sequentially with pacing */
  async scrapeAll(
    items: { itemId: number; searchQuery: string }[]
  ): Promise<ScrapeResult[]> {
    await this.initialize();
    const results: ScrapeResult[] = [];

    try {
      for (const item of items) {
        const result = await this.scrapeItem(item.itemId, item.searchQuery);
        results.push(result);

        // Rate-limit between requests
        await this.delay(this.config.requestDelay);
      }
    } finally {
      await this.cleanup();
    }

    return results;
  }

  /** Validates a scraped price is within reasonable bounds */
  protected validatePrice(price: number, itemName: string): boolean {
    if (price < 0.5) {
      logger.warn({ price, itemName }, 'Price too low, likely a parse error');
      return false;
    }
    if (price > 2000) {
      logger.warn(
        { price, itemName },
        'Price unrealistically high, likely a parse error'
      );
      return false;
    }
    return true;
  }

  /** Classifies an error into a known scraper error type */
  protected classifyError(error: Error): ScraperErrorType {
    const msg = error.message.toLowerCase();
    if (msg.includes('timeout') || msg.includes('timed out'))
      return ScraperErrorType.Timeout;
    if (msg.includes('net::') || msg.includes('network'))
      return ScraperErrorType.Network;
    if (msg.includes('selector') || msg.includes('not found'))
      return ScraperErrorType.SelectorMismatch;
    if (msg.includes('429') || msg.includes('rate'))
      return ScraperErrorType.RateLimited;
    return ScraperErrorType.Unknown;
  }

  /** Pauses execution for the given number of milliseconds */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Store-specific: navigate to search page, find product, extract price */
  protected abstract performSearch(
    itemId: number,
    searchQuery: string
  ): Promise<ScrapeResult>;
}
