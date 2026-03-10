import { BaseScraper, ScrapeResult, StoreConfig, CheerioDoc } from './base-scraper';
import { logger } from '../utils/logger';

/**
 * Scraper for Noon Daily / Noon Grocery (noon.com).
 * Noon is a Next.js app with an internal catalog API at /_svc/catalog/api/
 * that returns JSON product data. The search page also contains LD+JSON
 * and embedded escaped JSON with AED prices.
 */
export class NoonScraper extends BaseScraper {
  constructor(storeId: number) {
    const config: StoreConfig = {
      storeId,
      storeName: 'Noon Grocery',
      baseUrl: 'https://www.noon.com',
      searchUrl: 'https://www.noon.com/uae-en/search/?q=',
      requestDelay: 2500,
      useCookieJar: true,
    };
    super(config);
  }

  protected async performSearch(
    itemId: number,
    searchQuery: string
  ): Promise<ScrapeResult> {
    // Strategy 1: Internal catalog API
    const apiResult = await this.tryCatalogApi(searchQuery, itemId);
    if (apiResult) return apiResult;

    // Strategy 2: Parse search page HTML (LD+JSON, escaped JSON, AED regex)
    const htmlResult = await this.tryHtmlParse(searchQuery, itemId);
    if (htmlResult) return htmlResult;

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

  /// Tries Noon's internal catalog search API.
  private async tryCatalogApi(
    searchQuery: string,
    itemId: number
  ): Promise<ScrapeResult | null> {
    const apiUrls = [
      `https://www.noon.com/_svc/catalog/api/v3/u/search?q=${encodeURIComponent(searchQuery)}&cat=grocery&limit=10&locale=en-AE`,
      `https://www.noon.com/_svc/catalog/api/v3/u/search?q=${encodeURIComponent(searchQuery)}&limit=10&locale=en-AE`,
    ];

    for (const url of apiUrls) {
      try {
        const response = await this.http.get(url, {
          headers: {
            'Accept': 'application/json',
            'Referer': `${this.config.baseUrl}/uae-en/`,
            'X-Locale': 'en-AE',
            'X-Content': 'V6',
          },
          timeout: 12000,
        });

        const data = response.data;
        const products = this.extractFromNoonApi(data, searchQuery);

        if (products.length > 0) {
          const best = this.findBestMatch(products, searchQuery);
          if (best && this.validatePrice(best.price, searchQuery)) {
            logger.info(
              {
                store: this.config.storeName,
                itemId,
                price: best.price,
                productName: best.name,
                method: 'catalog-api',
                totalFound: products.length,
              },
              'Price found via catalog API'
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
      } catch (e) {
        logger.debug(
          { store: this.config.storeName, error: (e as Error).message },
          'Catalog API failed'
        );
      }
    }

    return null;
  }

  /** Walks the Noon API response to find product hits with prices */
  private extractFromNoonApi(
    data: any,
    searchQuery: string
  ): { name: string; price: number }[] {
    const products: { name: string; price: number }[] = [];
    if (!data || typeof data !== 'object') return products;

    // Noon API nests products in various locations
    const possibleArrays = [
      data.hits,
      data.results,
      data.products,
      data.data?.hits,
      data.data?.results,
      data.data?.products,
    ];

    // Also try to walk the response for any nested product-like objects
    const rawJson = JSON.stringify(data);

    // Look for product objects with name/title and price fields
    // Noon's format often has "name", "name_en", "sale_price", "price"
    const namePattern = /"(?:name|name_en|title|display_name)"\s*:\s*"([^"]{3,120})"/g;
    const pricePattern = /"(?:sale_price|price|offer_price|special_price)"\s*:\s*"?([\d.]+)"?/g;

    // Strategy A: parse arrays of product objects
    for (const arr of possibleArrays) {
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const name =
          item.name ||
          item.name_en ||
          item.title ||
          item.display_name ||
          item.product_title;
        const price =
          item.sale_price ??
          item.price ??
          item.offer_price ??
          item.special_price ??
          item.final_price;

        if (name && price !== undefined && price !== null) {
          const num = parseFloat(String(price));
          if (!isNaN(num) && num > 0.5 && num < 2000) {
            products.push({ name: String(name), price: num });
          }
        }
      }
      if (products.length > 0) return products;
    }

    // Strategy B: use the generic JSON product finder from base class
    const baseProducts = this.findProductsInJson(data);
    if (baseProducts.length > 0) return baseProducts;

    // Strategy C: regex approach on stringified JSON
    // Collect all name-price pairs by proximity
    const names: { value: string; index: number }[] = [];
    const prices: { value: number; index: number }[] = [];
    let m;

    while ((m = namePattern.exec(rawJson)) !== null) {
      if (m[1].length > 3 && !m[1].startsWith('http')) {
        names.push({ value: m[1], index: m.index });
      }
    }
    while ((m = pricePattern.exec(rawJson)) !== null) {
      const num = parseFloat(m[1]);
      if (!isNaN(num) && num > 0.5 && num < 2000) {
        prices.push({ value: num, index: m.index });
      }
    }

    // Match each price to its nearest preceding name
    for (const p of prices) {
      let bestName: string | null = null;
      let bestDist = Infinity;
      for (const n of names) {
        const dist = p.index - n.index;
        if (dist > 0 && dist < bestDist) {
          bestDist = dist;
          bestName = n.value;
        }
      }
      if (bestName && bestDist < 500) {
        products.push({ name: bestName, price: p.value });
      }
    }

    return products;
  }

  /// Parses the search page HTML for LD+JSON, escaped JSON, or AED prices.
  private async tryHtmlParse(
    searchQuery: string,
    itemId: number
  ): Promise<ScrapeResult | null> {
    const url = `${this.config.searchUrl}${encodeURIComponent(searchQuery)}&category=grocery`;

    try {
      const response = await this.http.get(url, {
        headers: { Referer: this.config.baseUrl },
      });

      const html: string =
        typeof response.data === 'string'
          ? response.data
          : String(response.data);

      if (html.length < 500) return null;

      // Try LD+JSON first
      const $ = require('cheerio').load(html) as ReturnType<typeof import('cheerio').load>;
      const ldScripts = $('script[type="application/ld+json"]');
      for (let i = 0; i < ldScripts.length; i++) {
        try {
          const raw = $(ldScripts[i]).html();
          if (!raw) continue;
          const ld = JSON.parse(raw);
          const products: { name: string; price: number }[] = [];

          if (ld['@type'] === 'ItemList' && Array.isArray(ld.itemListElement)) {
            for (const el of ld.itemListElement) {
              const prod = el.item || el;
              if (prod.name && prod.offers) {
                const p = parseFloat(String(prod.offers.price ?? prod.offers.lowPrice));
                if (!isNaN(p) && p > 0) products.push({ name: prod.name, price: p });
              }
            }
          } else if (ld['@type'] === 'Product' && ld.name && ld.offers) {
            const p = parseFloat(String(ld.offers.price ?? ld.offers.lowPrice));
            if (!isNaN(p) && p > 0) products.push({ name: ld.name, price: p });
          }

          if (products.length > 0) {
            const best = this.findBestMatch(products, searchQuery);
            if (best && this.validatePrice(best.price, searchQuery)) {
              logger.info(
                { store: this.config.storeName, itemId, price: best.price, productName: best.name, method: 'ld+json', totalFound: products.length },
                'Price found via LD+JSON'
              );
              return {
                itemId, storeId: this.config.storeId, searchQuery,
                productName: best.name, price: best.price, success: true,
              };
            }
          }
        } catch { /* malformed LD+JSON */ }
      }

      // Escaped JSON prices (Noon embeds ~72 escaped price values)
      const escapedPricePattern = /\\?"sale_price\\?":\s*\\?"?([\d.]+)\\?"?/g;
      const escapedNamePattern = /\\?"(?:name|name_en)\\?":\s*\\?"([^"\\]{3,120})\\?"/g;
      const eNames: { value: string; index: number }[] = [];
      const ePrices: { value: number; index: number }[] = [];
      let em;

      while ((em = escapedNamePattern.exec(html)) !== null) {
        if (!em[1].startsWith('http') && em[1].length > 3) {
          eNames.push({ value: em[1], index: em.index });
        }
      }
      while ((em = escapedPricePattern.exec(html)) !== null) {
        const num = parseFloat(em[1]);
        if (!isNaN(num) && num > 0.5 && num < 2000) {
          ePrices.push({ value: num, index: em.index });
        }
      }

      const escapedProducts: { name: string; price: number }[] = [];
      for (const p of ePrices) {
        let bestName: string | null = null;
        let bestDist = Infinity;
        for (const n of eNames) {
          const dist = p.index - n.index;
          if (dist > 0 && dist < 800) {
            if (dist < bestDist) {
              bestDist = dist;
              bestName = n.value;
            }
          }
        }
        if (bestName) {
          escapedProducts.push({ name: bestName, price: p.value });
        }
      }

      if (escapedProducts.length > 0) {
        const best = this.findBestMatch(escapedProducts, searchQuery);
        if (best && this.validatePrice(best.price, searchQuery)) {
          logger.info(
            { store: this.config.storeName, itemId, price: best.price, productName: best.name, method: 'escaped-json', totalFound: escapedProducts.length },
            'Price found via escaped JSON'
          );
          return {
            itemId, storeId: this.config.storeId, searchQuery,
            productName: best.name, price: best.price, success: true,
          };
        }
      }

      // AED regex as last resort
      const aedPattern = /AED\s*([\d,.]+)/g;
      let match;
      const aedPrices: number[] = [];
      while ((match = aedPattern.exec(html)) !== null) {
        const val = parseFloat(match[1].replace(',', ''));
        if (!isNaN(val) && val > 0.5 && val < 2000) aedPrices.push(val);
      }

      if (aedPrices.length > 0) {
        const freq = new Map<number, number>();
        for (const p of aedPrices) freq.set(p, (freq.get(p) || 0) + 1);
        const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
        const bestPrice = sorted[0][0];

        if (this.validatePrice(bestPrice, searchQuery)) {
          logger.info(
            { store: this.config.storeName, itemId, price: bestPrice, method: 'aed-regex', totalPrices: aedPrices.length },
            'Price found via AED regex'
          );
          return {
            itemId, storeId: this.config.storeId, searchQuery,
            productName: searchQuery, price: bestPrice, success: true,
          };
        }
      }
    } catch (e) {
      logger.debug(
        { store: this.config.storeName, error: (e as Error).message },
        'HTML parse failed'
      );
    }

    return null;
  }
}
