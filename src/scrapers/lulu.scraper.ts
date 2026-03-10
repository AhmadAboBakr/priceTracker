import { BaseScraper, ScrapeResult, StoreConfig, CheerioDoc } from './base-scraper';
import { logger } from '../utils/logger';

/**
 * Scraper for Lulu Hypermarket UAE.
 * Uses direct HTTP requests with cheerio parsing — no browser needed.
 *
 * Lulu's search uses a URL pattern like /en-ae/search/?q=...
 * The site may use SSR or embed product data in script tags.
 * We try multiple extraction strategies:
 *  1. __NEXT_DATA__ or similar embedded JSON
 *  2. Schema.org LD+JSON structured data
 *  3. Direct HTML parsing of product cards (Tailwind classes)
 */
export class LuluScraper extends BaseScraper {
  /** Known Lulu search URL patterns to try */
  private static readonly SEARCH_URLS = [
    'https://gcc.luluhypermarket.com/en-ae/search/?q=',
    'https://gcc.luluhypermarket.com/en-ae/search?q=',
    'https://gcc.luluhypermarket.com/en-ae/catalogsearch/result/?q=',
  ];

  constructor(storeId: number) {
    const config: StoreConfig = {
      storeId,
      storeName: 'Lulu Hypermarket',
      baseUrl: 'https://gcc.luluhypermarket.com/en-ae',
      searchUrl: 'https://gcc.luluhypermarket.com/en-ae/search/?q=',
      requestDelay: 2000,
    };
    super(config);
  }

  protected async performSearch(
    itemId: number,
    searchQuery: string
  ): Promise<ScrapeResult> {
    // Try each search URL pattern until one works
    for (const baseSearchUrl of LuluScraper.SEARCH_URLS) {
      const url = `${baseSearchUrl}${encodeURIComponent(searchQuery)}`;
      logger.debug({ store: this.config.storeName, searchQuery, url }, 'Fetching search page');

      try {
        const $ = await this.fetchHtml(url, {
          'Referer': this.config.baseUrl,
        });

        // Strategy 1: Embedded JSON data (__NEXT_DATA__ or similar)
        const jsonResult = this.extractFromEmbeddedJson($, itemId, searchQuery);
        if (jsonResult) return jsonResult;

        // Strategy 2: Schema.org LD+JSON structured data
        const ldResult = this.extractFromLdJson($, itemId, searchQuery);
        if (ldResult) return ldResult;

        // Strategy 3: HTML product cards (Tailwind classes)
        const htmlResult = this.extractFromHtml($, itemId, searchQuery);
        if (htmlResult) return htmlResult;

      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.debug(
          { store: this.config.storeName, url, error: errMsg },
          'Search URL failed, trying next'
        );
        continue;
      }
    }

    // Strategy 4: Try Lulu API directly if it exists
    const apiResult = await this.tryApiEndpoints(searchQuery, itemId);
    if (apiResult) return apiResult;

    logger.warn({ store: this.config.storeName, itemId, searchQuery }, 'No price found');
    return {
      itemId,
      storeId: this.config.storeId,
      searchQuery,
      productName: null,
      price: null,
      success: false,
      error: 'No matching product price found',
    };
  }

  /** Extracts product data from embedded JSON in script tags */
  private extractFromEmbeddedJson(
    $: CheerioDoc,
    itemId: number,
    searchQuery: string
  ): ScrapeResult | null {
    // Check for __NEXT_DATA__
    const nextData = $('#__NEXT_DATA__').html();
    if (nextData) {
      try {
        const data = JSON.parse(nextData);
        const products = this.findProductsInJson(data);
        if (products.length > 0) {
          const best = this.findBestMatch(products, searchQuery);
          if (best && this.validatePrice(best.price, searchQuery)) {
            logger.info(
              { store: this.config.storeName, itemId, price: best.price, method: '__NEXT_DATA__' },
              'Price found'
            );
            return {
              itemId, storeId: this.config.storeId, searchQuery,
              productName: best.name, price: best.price, success: true,
            };
          }
        }
      } catch {}
    }

    // Check all application/json script tags
    $('script[type="application/json"]').each((_i, el) => {
      // cheerio .each doesn't support early return for ScrapeResult, handled below
    });

    const jsonScripts = $('script[type="application/json"]');
    for (let i = 0; i < jsonScripts.length; i++) {
      try {
        const raw = $(jsonScripts[i]).html();
        if (!raw || raw.length < 30) continue;
        const data = JSON.parse(raw);
        const products = this.findProductsInJson(data);
        if (products.length > 0) {
          const best = this.findBestMatch(products, searchQuery);
          if (best && this.validatePrice(best.price, searchQuery)) {
            logger.info(
              { store: this.config.storeName, itemId, price: best.price, method: 'inline-json' },
              'Price found'
            );
            return {
              itemId, storeId: this.config.storeId, searchQuery,
              productName: best.name, price: best.price, success: true,
            };
          }
        }
      } catch {}
    }

    return null;
  }

  /** Extracts from Schema.org LD+JSON */
  private extractFromLdJson(
    $: CheerioDoc,
    itemId: number,
    searchQuery: string
  ): ScrapeResult | null {
    const ldScripts = $('script[type="application/ld+json"]');
    for (let i = 0; i < ldScripts.length; i++) {
      try {
        const raw = $(ldScripts[i]).html();
        if (!raw) continue;
        const data = JSON.parse(raw);

        const products: { name: string; price: number }[] = [];

        // Single product
        if (data['@type'] === 'Product' && data.name && data.offers) {
          const p = parseFloat(String(data.offers.price ?? data.offers.lowPrice));
          if (!isNaN(p) && p > 0) products.push({ name: data.name, price: p });
        }

        // Item list
        if (data['@type'] === 'ItemList' && Array.isArray(data.itemListElement)) {
          for (const item of data.itemListElement) {
            const prod = item.item || item;
            if (prod.name && prod.offers) {
              const p = parseFloat(String(prod.offers.price ?? prod.offers.lowPrice));
              if (!isNaN(p) && p > 0) products.push({ name: prod.name, price: p });
            }
          }
        }

        if (products.length > 0) {
          const best = this.findBestMatch(products, searchQuery);
          if (best && this.validatePrice(best.price, searchQuery)) {
            logger.info(
              { store: this.config.storeName, itemId, price: best.price, method: 'ld+json' },
              'Price found'
            );
            return {
              itemId, storeId: this.config.storeId, searchQuery,
              productName: best.name, price: best.price, success: true,
            };
          }
        }
      } catch {}
    }
    return null;
  }

  /** Extracts product data from rendered HTML */
  private extractFromHtml(
    $: CheerioDoc,
    itemId: number,
    searchQuery: string
  ): ScrapeResult | null {
    const products: { name: string; price: number }[] = [];

    // Lulu uses Tailwind: font-bold text-base text-black for prices
    // and a.line-clamp-3 for product names
    const priceSelectors = [
      'span.font-bold.text-base.text-black',
      'span.font-bold.text-black',
      '[class*="font-bold"][class*="text-black"]',
      '.product-price',
      'span.price',
    ];

    const nameSelectors = [
      'a.line-clamp-3',
      'a[class*="line-clamp"]',
      '.product-name',
      '.product-title',
      'h2 a',
      'h3 a',
    ];

    const names: string[] = [];
    const prices: number[] = [];

    for (const sel of nameSelectors) {
      $(sel).each((_i, el) => {
        const text = $(el).text().trim();
        if (text.length > 2) names.push(text);
      });
      if (names.length > 0) break;
    }

    for (const sel of priceSelectors) {
      $(sel).each((_i, el) => {
        const text = $(el).text().trim();
        const num = parseFloat(text.replace(/[^\d.]/g, ''));
        if (!isNaN(num) && num > 0.5 && num < 2000) prices.push(num);
      });
      if (prices.length > 0) break;
    }

    const count = Math.min(names.length, prices.length);
    for (let i = 0; i < count; i++) {
      products.push({ name: names[i], price: prices[i] });
    }

    // Fallback: regex for AED prices
    if (products.length === 0) {
      const bodyText = $('body').html() || '';
      const aedPattern = /(?:AED|aed|د\.إ)\s*([\d,.]+)/g;
      let match;
      while ((match = aedPattern.exec(bodyText)) !== null) {
        const val = parseFloat(match[1].replace(',', ''));
        if (!isNaN(val) && val > 0.5 && val < 2000) {
          products.push({ name: searchQuery, price: val });
          break;
        }
      }
    }

    if (products.length > 0) {
      const best = this.findBestMatch(products, searchQuery);
      if (best && this.validatePrice(best.price, searchQuery)) {
        logger.info(
          { store: this.config.storeName, itemId, price: best.price, method: 'html' },
          'Price found'
        );
        return {
          itemId, storeId: this.config.storeId, searchQuery,
          productName: best.name, price: best.price, success: true,
        };
      }
    }

    return null;
  }

  /** Tries direct API endpoints that Lulu might expose */
  private async tryApiEndpoints(
    searchQuery: string,
    itemId: number
  ): Promise<ScrapeResult | null> {
    const apiPatterns = [
      `https://gcc.luluhypermarket.com/api/search?q=${encodeURIComponent(searchQuery)}&lang=en-ae`,
      `https://gcc.luluhypermarket.com/en-ae/api/search?q=${encodeURIComponent(searchQuery)}`,
      `https://gcc.luluhypermarket.com/rest/v2/lulu-gcc/products/search?query=${encodeURIComponent(searchQuery)}&lang=en&curr=AED&country=AE`,
    ];

    for (const apiUrl of apiPatterns) {
      try {
        const data = await this.fetchJson(apiUrl, {
          'Referer': this.config.baseUrl,
        });
        const products = this.findProductsInJson(data);
        if (products.length > 0) {
          const best = this.findBestMatch(products, searchQuery);
          if (best && this.validatePrice(best.price, searchQuery)) {
            logger.info(
              { store: this.config.storeName, itemId, price: best.price, apiUrl, method: 'api' },
              'Price found via API'
            );
            return {
              itemId, storeId: this.config.storeId, searchQuery,
              productName: best.name, price: best.price, success: true,
            };
          }
        }
      } catch {
        // This endpoint doesn't work — try next
      }
    }

    return null;
  }
}
