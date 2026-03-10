import { BaseScraper, ScrapeResult, StoreConfig } from './base-scraper';
import { logger } from '../utils/logger';

// playwright-extra + stealth for Cloudflare bypass
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
chromium.use(stealth());

/**
 * Scraper for Lulu Hypermarket UAE using Playwright with stealth plugin.
 * Lulu is protected by Cloudflare WAF which blocks plain HTTP requests.
 * This scraper uses a headless browser with stealth evasions to bypass it.
 */
export class LuluScraper extends BaseScraper {
  private browser: any = null;
  private context: any = null;

  private static readonly SEARCH_URL = 'https://gcc.luluhypermarket.com/en-ae/search/?q=';
  private static readonly BASE_URL = 'https://gcc.luluhypermarket.com/en-ae';

  /** Navigation timeout per page load (ms) */
  private static readonly NAV_TIMEOUT = 30000;
  /** Max time to wait for product results to appear (ms) */
  private static readonly RESULTS_TIMEOUT = 15000;

  constructor(storeId: number) {
    const config: StoreConfig = {
      storeId,
      storeName: 'Lulu Hypermarket',
      baseUrl: LuluScraper.BASE_URL,
      searchUrl: LuluScraper.SEARCH_URL,
      requestDelay: 3000,
    };
    super(config);
  }

  /** Launches the stealth browser and warms up with Lulu homepage */
  async initialize(): Promise<void> {
    logger.info({ store: this.config.storeName }, 'Launching Playwright stealth browser');

    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
      ],
    });

    this.context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'en-AE',
      timezoneId: 'Asia/Dubai',
    });

    // Warm up: visit homepage to pass Cloudflare challenge
    try {
      const page = await this.context.newPage();
      logger.info({ store: this.config.storeName }, 'Warming up — visiting homepage');
      await page.goto(LuluScraper.BASE_URL, {
        waitUntil: 'domcontentloaded',
        timeout: LuluScraper.NAV_TIMEOUT,
      });
      // Wait for Cloudflare challenge to resolve (if any)
      await page.waitForTimeout(3000);
      await page.close();
      logger.info({ store: this.config.storeName }, 'Stealth browser ready');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ store: this.config.storeName, error: msg }, 'Homepage warmup failed — continuing anyway');
    }
  }

  /** Closes the browser */
  async cleanup(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {}
      this.browser = null;
      this.context = null;
      logger.info({ store: this.config.storeName }, 'Browser closed');
    }
  }

  protected async performSearch(
    itemId: number,
    searchQuery: string
  ): Promise<ScrapeResult> {
    if (!this.context) {
      return this.failResult(itemId, searchQuery, 'Browser not initialized');
    }

    const page = await this.context.newPage();
    const url = `${LuluScraper.SEARCH_URL}${encodeURIComponent(searchQuery)}`;

    try {
      logger.debug({ store: this.config.storeName, searchQuery, url }, 'Navigating to search');

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: LuluScraper.NAV_TIMEOUT,
      });

      // Wait for products to render — try multiple selectors
      const productRendered = await this.waitForProducts(page);
      if (!productRendered) {
        // Check if Cloudflare is blocking us
        const bodyText = await page.textContent('body').catch(() => '');
        if (bodyText && (bodyText.includes('Checking your browser') || bodyText.includes('cf-browser-verification'))) {
          logger.warn({ store: this.config.storeName, searchQuery }, 'Cloudflare challenge detected');
          // Wait longer for challenge to resolve
          await page.waitForTimeout(8000);
        }
      }

      // Strategy 1: Extract from rendered DOM product cards
      const domResult = await this.extractFromDom(page, itemId, searchQuery);
      if (domResult) {
        await page.close();
        return domResult;
      }

      // Strategy 2: Extract from __NEXT_DATA__ or embedded JSON
      const jsonResult = await this.extractFromPageJson(page, itemId, searchQuery);
      if (jsonResult) {
        await page.close();
        return jsonResult;
      }

      // Strategy 3: AED regex fallback on full page text
      const regexResult = await this.extractFromAedRegex(page, itemId, searchQuery);
      if (regexResult) {
        await page.close();
        return regexResult;
      }

      await page.close();
      return this.failResult(itemId, searchQuery, 'No matching product price found');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ store: this.config.storeName, itemId, searchQuery, error: errMsg }, 'Search page error');
      await page.close().catch(() => {});
      return this.failResult(itemId, searchQuery, errMsg);
    }
  }

  /** Waits for product cards to appear using multiple possible selectors */
  private async waitForProducts(page: any): Promise<boolean> {
    const selectors = [
      '[data-testid="product-card"]',
      '.product-card',
      '[class*="ProductCard"]',
      'a[class*="line-clamp"]',
      'span[class*="font-bold"][class*="text-black"]',
      '.search-results',
      '[class*="product-grid"]',
      '[class*="search-result"]',
    ];

    for (const sel of selectors) {
      try {
        await page.waitForSelector(sel, { timeout: LuluScraper.RESULTS_TIMEOUT });
        logger.debug({ store: this.config.storeName, selector: sel }, 'Products detected');
        return true;
      } catch {
        // Selector not found, try next
      }
    }

    // Final fallback: wait for any AED text to appear
    try {
      await page.waitForFunction(
        () => document.body.innerText.includes('AED'),
        { timeout: 8000 }
      );
      return true;
    } catch {
      logger.debug({ store: this.config.storeName }, 'No product selectors or AED text found');
      return false;
    }
  }

  /** Extracts product data from rendered DOM elements */
  private async extractFromDom(
    page: any,
    itemId: number,
    searchQuery: string
  ): Promise<ScrapeResult | null> {
    const products = await page.evaluate(() => {
      const results: { name: string; price: number }[] = [];

      // Strategy A: Tailwind-styled product cards (common in Lulu's React frontend)
      const priceSelectors = [
        'span.font-bold.text-base.text-black',
        'span.font-bold.text-black',
        '[class*="font-bold"][class*="text-black"]',
        '[data-testid="product-price"]',
        '.product-price',
        'span.price',
      ];

      const nameSelectors = [
        'a.line-clamp-3',
        'a[class*="line-clamp"]',
        '[data-testid="product-name"]',
        '.product-name a',
        '.product-title a',
        'h3 a',
        'h2 a',
      ];

      let names: string[] = [];
      let prices: number[] = [];

      for (const sel of nameSelectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          els.forEach((el) => {
            const text = (el as HTMLElement).innerText?.trim();
            if (text && text.length > 2) names.push(text);
          });
          break;
        }
      }

      for (const sel of priceSelectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          els.forEach((el) => {
            const text = (el as HTMLElement).innerText?.trim();
            const num = parseFloat((text || '').replace(/[^\d.]/g, ''));
            if (!isNaN(num) && num > 0.5 && num < 2000) prices.push(num);
          });
          break;
        }
      }

      // Pair names with prices
      const count = Math.min(names.length, prices.length);
      for (let i = 0; i < count; i++) {
        results.push({ name: names[i], price: prices[i] });
      }

      // Strategy B: product card containers with both name and price inside
      if (results.length === 0) {
        const cardSelectors = [
          '[data-testid="product-card"]',
          '.product-card',
          '[class*="ProductCard"]',
        ];

        for (const cardSel of cardSelectors) {
          const cards = document.querySelectorAll(cardSel);
          if (cards.length > 0) {
            cards.forEach((card) => {
              const nameEl = card.querySelector('a, h3, h2, [class*="title"], [class*="name"]');
              const name = nameEl ? (nameEl as HTMLElement).innerText?.trim() : null;
              const priceText = card.textContent || '';
              const priceMatch = priceText.match(/(?:AED|aed|د\.إ)\s*([\d,.]+)/);
              if (name && priceMatch) {
                const p = parseFloat(priceMatch[1].replace(',', ''));
                if (!isNaN(p) && p > 0.5 && p < 2000) {
                  results.push({ name, price: p });
                }
              }
            });
            break;
          }
        }
      }

      return results;
    });

    if (products.length > 0) {
      const best = this.findBestMatch(products, searchQuery);
      if (best && this.validatePrice(best.price, searchQuery)) {
        logger.info(
          { store: this.config.storeName, itemId, price: best.price, name: best.name, method: 'dom' },
          'Price found'
        );
        return {
          itemId,
          storeId: this.config.storeId,
          searchQuery,
          productName: best.name,
          price: best.price,
          success: true,
        };
      }
    }

    return null;
  }

  /** Extracts from __NEXT_DATA__ or other embedded JSON in the rendered page */
  private async extractFromPageJson(
    page: any,
    itemId: number,
    searchQuery: string
  ): Promise<ScrapeResult | null> {
    const products = await page.evaluate(() => {
      const results: { name: string; price: number }[] = [];

      // Try __NEXT_DATA__
      const nextEl = document.getElementById('__NEXT_DATA__');
      if (nextEl) {
        try {
          const data = JSON.parse(nextEl.textContent || '');
          const walk = (obj: any, depth: number): void => {
            if (depth > 8 || !obj) return;
            if (Array.isArray(obj)) {
              obj.slice(0, 50).forEach((item) => walk(item, depth + 1));
              return;
            }
            if (typeof obj === 'object') {
              const priceKeys = ['price', 'finalPrice', 'final_price', 'salePrice', 'sale_price', 'offer_price'];
              const nameKeys = ['name', 'title', 'productName', 'product_name'];
              let p: number | null = null;
              let n: string | null = null;
              for (const k of priceKeys) {
                if (obj[k] != null) {
                  const val = typeof obj[k] === 'object' ? (obj[k].value ?? obj[k].amount) : obj[k];
                  const num = parseFloat(String(val));
                  if (!isNaN(num) && num > 0) { p = num; break; }
                }
              }
              if (obj.price_range?.minimum_price?.final_price?.value) {
                p = parseFloat(String(obj.price_range.minimum_price.final_price.value));
              }
              for (const k of nameKeys) {
                if (typeof obj[k] === 'string' && obj[k].length > 2) { n = obj[k]; break; }
              }
              if (p && n && p > 0.5 && p < 2000) {
                results.push({ name: n, price: p });
              }
              for (const key of Object.keys(obj)) {
                const lower = key.toLowerCase();
                if (['products', 'items', 'results', 'hits', 'data', 'content', 'nodes'].includes(lower)) {
                  walk(obj[key], depth + 1);
                }
              }
            }
          };
          walk(data, 0);
        } catch {}
      }

      // Try LD+JSON
      document.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
        try {
          const data = JSON.parse(el.textContent || '');
          if (data['@type'] === 'Product' && data.name && data.offers) {
            const p = parseFloat(String(data.offers.price ?? data.offers.lowPrice));
            if (!isNaN(p) && p > 0) results.push({ name: data.name, price: p });
          }
          if (data['@type'] === 'ItemList' && Array.isArray(data.itemListElement)) {
            for (const item of data.itemListElement) {
              const prod = item.item || item;
              if (prod.name && prod.offers) {
                const p = parseFloat(String(prod.offers.price ?? prod.offers.lowPrice));
                if (!isNaN(p) && p > 0) results.push({ name: prod.name, price: p });
              }
            }
          }
        } catch {}
      });

      return results;
    });

    if (products.length > 0) {
      const best = this.findBestMatch(products, searchQuery);
      if (best && this.validatePrice(best.price, searchQuery)) {
        logger.info(
          { store: this.config.storeName, itemId, price: best.price, method: 'page-json' },
          'Price found'
        );
        return {
          itemId,
          storeId: this.config.storeId,
          searchQuery,
          productName: best.name,
          price: best.price,
          success: true,
        };
      }
    }

    return null;
  }

  /** Last resort: regex AED prices from full page text */
  private async extractFromAedRegex(
    page: any,
    itemId: number,
    searchQuery: string
  ): Promise<ScrapeResult | null> {
    const text: string = await page.evaluate(() => document.body.innerText || '');
    const aedPattern = /(?:AED|aed|د\.إ)\s*([\d,.]+)/g;
    let match;
    const prices: number[] = [];
    while ((match = aedPattern.exec(text)) !== null) {
      const val = parseFloat(match[1].replace(',', ''));
      if (!isNaN(val) && val > 0.5 && val < 2000) {
        prices.push(val);
      }
    }

    if (prices.length > 0) {
      // Use the first reasonable price
      const price = prices[0];
      if (this.validatePrice(price, searchQuery)) {
        logger.info(
          { store: this.config.storeName, itemId, price, method: 'aed-regex' },
          'Price found (regex fallback)'
        );
        return {
          itemId,
          storeId: this.config.storeId,
          searchQuery,
          productName: searchQuery,
          price,
          success: true,
        };
      }
    }

    return null;
  }

  /** Creates a standardized failure result */
  private failResult(itemId: number, searchQuery: string, error: string): ScrapeResult {
    return {
      itemId,
      storeId: this.config.storeId,
      searchQuery,
      productName: null,
      price: null,
      success: false,
      error,
    };
  }
}
