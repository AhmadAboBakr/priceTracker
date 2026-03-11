import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger';
import { retryWithBackoff } from '../utils/retry';
import { ScraperErrorType } from '../types';
import dotenv from 'dotenv';

dotenv.config();

/** Cheerio parsed document type */
export type CheerioDoc = ReturnType<typeof cheerio.load>;

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
  /** If true, uses a cookie jar to persist cookies across requests */
  useCookieJar?: boolean;
}

/**
 * Abstract base scraper using axios + cheerio (no browser).
 * Each store scraper implements performSearch() to fetch and parse product data
 * via lightweight HTTP requests instead of a full headless browser.
 */
export abstract class BaseScraper {
  protected config: StoreConfig;
  protected http: AxiosInstance;
  protected cookieJar: CookieJar | null = null;
  private hasWarmedUp = false;

  constructor(config: StoreConfig) {
    this.config = config;

    const baseOptions: any = {
      timeout: parseInt(process.env.SCRAPER_TIMEOUT || '15000', 10),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept':
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
      maxRedirects: 10,
      validateStatus: (status: number) => status < 400,
    };

    if (config.useCookieJar) {
      this.cookieJar = new CookieJar();
      baseOptions.jar = this.cookieJar;
      baseOptions.withCredentials = true;
      this.http = wrapper(axios.create(baseOptions));
    } else {
      this.http = axios.create(baseOptions);
    }
  }

  /** Visits the homepage to establish session cookies */
  async initialize(): Promise<void> {
    if (this.config.useCookieJar && !this.hasWarmedUp) {
      try {
        logger.info({ store: this.config.storeName }, 'Warming up — fetching homepage for cookies');
        await this.http.get(this.config.baseUrl);
        this.hasWarmedUp = true;
        logger.info({ store: this.config.storeName }, 'Cookie warmup done');
      } catch (e) {
        logger.warn({ store: this.config.storeName, error: (e as Error).message }, 'Homepage warmup failed');
      }
    }
    logger.info({ store: this.config.storeName }, 'HTTP scraper ready');
  }

  /** No-op — no browser to close */
  async cleanup(): Promise<void> {}

  /** Fetches a URL and returns a cheerio-parsed document */
  protected async fetchHtml(
    url: string,
    extraHeaders?: Record<string, string>
  ): Promise<ReturnType<typeof cheerio.load>> {
    const config: AxiosRequestConfig = {};
    if (extraHeaders) {
      config.headers = extraHeaders;
    }
    const response = await this.http.get(url, config);
    return cheerio.load(response.data);
  }

  /** Fetches a URL and returns the raw response data (for JSON APIs) */
  protected async fetchJson<T = any>(
    url: string,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    const config: AxiosRequestConfig = {
      headers: {
        ...extraHeaders,
        'Accept': 'application/json',
      },
    };
    const response = await this.http.get<T>(url, config);
    return response.data;
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

  /** Scrapes all items for this store sequentially with pacing. If onResult is provided, each result is emitted immediately and not accumulated. */
  async scrapeAll(
    items: { itemId: number; searchQuery: string }[],
    onResult?: (result: ScrapeResult) => void
  ): Promise<ScrapeResult[]> {
    await this.initialize();
    const results: ScrapeResult[] = [];

    try {
      for (const item of items) {
        const result = await this.scrapeItem(item.itemId, item.searchQuery);
        if (onResult) {
          onResult(result);
        } else {
          results.push(result);
        }
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

  /** Picks the product whose name best matches the search query */
  protected findBestMatch(
    products: { name: string; price: number }[],
    query: string
  ): { name: string; price: number } | null {
    if (products.length === 0) return null;

    const queryWords = query.toLowerCase().split(/\s+/);
    let bestScore = -1;
    let bestProduct = products[0];

    for (const product of products) {
      const nameLower = product.name.toLowerCase();
      let score = 0;
      for (const word of queryWords) {
        if (nameLower.includes(word)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestProduct = product;
      }
    }

    return bestProduct;
  }

  /**
   * Recursively searches a JSON object for product-like structures.
   * Looks for objects with both a price field and a name/title field.
   */
  protected findProductsInJson(obj: any, depth: number = 0): { name: string; price: number }[] {
    if (depth > 10 || obj == null) return [];
    const results: { name: string; price: number }[] = [];

    if (Array.isArray(obj)) {
      for (const item of obj.slice(0, 60)) {
        results.push(...this.findProductsInJson(item, depth + 1));
      }
      return results;
    }

    if (typeof obj === 'object') {
      const price = this.extractPriceField(obj);
      const name = this.extractNameField(obj);
      if (price !== null && name !== null) {
        results.push({ name, price });
      }

      // Recurse into known collection keys
      for (const key of Object.keys(obj)) {
        const lower = key.toLowerCase();
        if (
          ['products', 'items', 'results', 'hits', 'data', 'records',
           'content', 'listing', 'product_list', 'edges', 'nodes'].includes(lower)
        ) {
          results.push(...this.findProductsInJson(obj[key], depth + 1));
        }
      }
    }

    return results;
  }

  /** Tries common price field names on an object */
  protected extractPriceField(obj: any): number | null {
    const priceKeys = [
      'price', 'finalPrice', 'final_price', 'salePrice', 'sale_price',
      'currentPrice', 'current_price', 'unitPrice', 'unit_price',
      'displayPrice', 'display_price', 'offerPrice', 'offer_price',
      'special_price', 'regular_price', 'minimal_price',
    ];

    for (const key of priceKeys) {
      if (obj[key] != null) {
        const raw = obj[key];
        const val = typeof raw === 'object'
          ? (raw.value ?? raw.amount ?? raw.price ?? raw.formattedValue)
          : raw;
        const num = parseFloat(String(val).replace(/[^\d.]/g, ''));
        if (!isNaN(num) && num > 0) return num;
      }
    }

    // Nested price object
    if (obj.price && typeof obj.price === 'object') {
      for (const subKey of ['value', 'amount', 'current', 'final', 'sale']) {
        const val = obj.price[subKey];
        if (val != null) {
          const num = parseFloat(String(typeof val === 'object' ? (val.amount ?? val.value) : val));
          if (!isNaN(num) && num > 0) return num;
        }
      }
    }

    // Magento price_range
    if (obj.price_range?.minimum_price?.final_price?.value) {
      const num = parseFloat(String(obj.price_range.minimum_price.final_price.value));
      if (!isNaN(num) && num > 0) return num;
    }

    return null;
  }

  /** Tries common name/title field names on an object */
  protected extractNameField(obj: any): string | null {
    const nameKeys = [
      'name', 'title', 'productName', 'product_name', 'displayName',
      'display_name', 'label', 'itemName', 'item_name',
    ];

    for (const key of nameKeys) {
      if (typeof obj[key] === 'string' && obj[key].length > 2) {
        return obj[key].trim();
      }
    }
    return null;
  }

  /** Classifies an error into a known scraper error type */
  protected classifyError(error: Error): ScraperErrorType {
    const msg = error.message.toLowerCase();
    if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('ETIMEDOUT'))
      return ScraperErrorType.Timeout;
    if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('network'))
      return ScraperErrorType.Network;
    if (msg.includes('429') || msg.includes('rate'))
      return ScraperErrorType.RateLimited;
    if (msg.includes('403') || msg.includes('forbidden'))
      return ScraperErrorType.RateLimited;
    return ScraperErrorType.Unknown;
  }

  /** Pauses execution for the given number of milliseconds */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Store-specific: fetch search results and extract price */
  protected abstract performSearch(
    itemId: number,
    searchQuery: string
  ): Promise<ScrapeResult>;
}
