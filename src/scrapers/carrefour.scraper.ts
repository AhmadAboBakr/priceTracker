import { BaseScraper, ScrapeResult, StoreConfig } from './base-scraper';
import { logger } from '../utils/logger';

/**
 * Scraper for Carrefour UAE (Majid Al Futtaim).
 * Uses direct HTTP requests with cookie jar — no browser needed.
 *
 * Carrefour UAE is a Next.js app with React Server Components.
 * The search page requires cookies (homepage visit first) and returns
 * product data as escaped JSON embedded in the SSR HTML body.
 * We extract product objects via regex on the raw HTML string.
 */
export class CarrefourScraper extends BaseScraper {
  constructor(storeId: number) {
    const config: StoreConfig = {
      storeId,
      storeName: 'Carrefour UAE',
      baseUrl: 'https://www.carrefouruae.com/mafuae/en/',
      searchUrl: 'https://www.carrefouruae.com/mafuae/en/search?keyword=',
      requestDelay: 2000,
      useCookieJar: true,
    };
    super(config);
  }

  protected async performSearch(
    itemId: number,
    searchQuery: string
  ): Promise<ScrapeResult> {
    const url = `${this.config.searchUrl}${encodeURIComponent(searchQuery)}`;
    logger.debug({ store: this.config.storeName, searchQuery, url }, 'Fetching search page');

    try {
      const response = await this.http.get(url, {
        headers: { 'Referer': this.config.baseUrl },
      });

      const html: string = typeof response.data === 'string'
        ? response.data
        : String(response.data);

      if (html.length < 500) {
        logger.warn(
          { store: this.config.storeName, htmlLength: html.length },
          'Response too small — cookies may have failed'
        );
        return this.noResult(itemId, searchQuery, 'Empty or blocked response');
      }

      // Strategy 1: Extract product objects from escaped JSON in SSR HTML
      const escapedResult = this.extractFromEscapedJson(html, itemId, searchQuery);
      if (escapedResult) return escapedResult;

      // Strategy 2: Try regex for AED price patterns as fallback
      const regexResult = this.extractFromAedRegex(html, itemId, searchQuery);
      if (regexResult) return regexResult;

      logger.warn({ store: this.config.storeName, itemId, searchQuery }, 'No price found');
      return this.noResult(itemId, searchQuery, 'No matching product price found');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        { store: this.config.storeName, itemId, searchQuery, error: errMsg },
        'Fetch failed'
      );
      throw error;
    }
  }

  /**
   * Parses escaped JSON product data embedded in the SSR HTML.
   * Carrefour embeds React props as escaped JSON with patterns like:
   *   \"name\":\"Product Name\"  and  \"price\":{\"currency\":\"AED\",\"price\":18.99,...}
   */
  private extractFromEscapedJson(
    html: string,
    itemId: number,
    searchQuery: string
  ): ScrapeResult | null {
    const products: { name: string; price: number }[] = [];

    // Find all escaped JSON product blocks.
    // Each product has a \"price\" object with \"price\":NUMBER and a nearby \"name\" field.
    // The data appears in blocks like: \"name\":\"...\",\"...\",\"price\":{\"currency\":\"AED\",\"price\":NN.NN,...}

    // Approach: find all price occurrences, then look backwards for the product name
    const pricePattern = /\\?"price\\?":\s*\{[^}]*\\?"currency\\?":\s*\\?"AED\\?"[^}]*\\?"price\\?":\s*([\d.]+)/g;
    let priceMatch;
    const priceLocations: { price: number; index: number }[] = [];

    while ((priceMatch = pricePattern.exec(html)) !== null) {
      const price = parseFloat(priceMatch[1]);
      if (!isNaN(price) && price > 0.5 && price < 2000) {
        priceLocations.push({ price, index: priceMatch.index });
      }
    }

    // Also try the simpler pattern where price comes first
    const simplePricePattern = /\\?"price\\?":\s*\{[^}]*?\\?"price\\?":\s*([\d.]+)[^}]*?\\?"currency\\?":\s*\\?"AED\\?"/g;
    let simpleMatch;
    while ((simpleMatch = simplePricePattern.exec(html)) !== null) {
      const price = parseFloat(simpleMatch[1]);
      if (!isNaN(price) && price > 0.5 && price < 2000) {
        const alreadyFound = priceLocations.some(
          pl => Math.abs(pl.index - simpleMatch!.index) < 50
        );
        if (!alreadyFound) {
          priceLocations.push({ price, index: simpleMatch.index });
        }
      }
    }

    if (priceLocations.length === 0) {
      logger.debug({ store: this.config.storeName }, 'No escaped JSON price blocks found');
      return null;
    }

    // For each price location, look for a product name in the surrounding context
    for (const { price, index } of priceLocations) {
      const contextStart = Math.max(0, index - 1500);
      const contextEnd = Math.min(html.length, index + 500);
      const context = html.substring(contextStart, contextEnd);

      // Look for escaped \"name\":\"...\" pattern
      const namePattern = /\\?"name\\?":\s*\\?"([^"\\]{3,120})\\?"/g;
      let nameMatch;
      let bestName: string | null = null;
      let bestDist = Infinity;

      while ((nameMatch = namePattern.exec(context)) !== null) {
        const name = nameMatch[1];
        // Skip generic names
        if (this.isGenericName(name)) continue;
        // Prefer the name closest to (but before) the price
        const relativeIndex = nameMatch.index;
        const priceRelative = index - contextStart;
        const dist = Math.abs(priceRelative - relativeIndex);
        if (dist < bestDist) {
          bestDist = dist;
          bestName = name;
        }
      }

      // Also try unescaped name pattern (some parts of the HTML aren't escaped)
      if (!bestName) {
        const plainNamePattern = /"name"\s*:\s*"([^"]{3,120})"/g;
        while ((nameMatch = plainNamePattern.exec(context)) !== null) {
          const name = nameMatch[1];
          if (this.isGenericName(name)) continue;
          bestName = name;
          break;
        }
      }

      if (bestName) {
        products.push({ name: bestName, price });
      }
    }

    // Deduplicate by name
    const seen = new Set<string>();
    const uniqueProducts = products.filter(p => {
      const key = `${p.name}|${p.price}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (uniqueProducts.length > 0) {
      const best = this.findBestMatch(uniqueProducts, searchQuery);
      if (best && this.validatePrice(best.price, searchQuery)) {
        logger.info(
          { store: this.config.storeName, itemId, price: best.price, productName: best.name, method: 'escaped-json', totalFound: uniqueProducts.length },
          'Price found via escaped JSON'
        );
        return {
          itemId, storeId: this.config.storeId, searchQuery,
          productName: best.name, price: best.price, success: true,
        };
      }
    }

    return null;
  }

  /** Fallback: extracts AED prices via regex from raw HTML */
  private extractFromAedRegex(
    html: string,
    itemId: number,
    searchQuery: string
  ): ScrapeResult | null {
    const aedPattern = /(?:AED|aed|د\.إ)\s*([\d,.]+)/g;
    let match;
    const prices: number[] = [];

    while ((match = aedPattern.exec(html)) !== null) {
      const val = parseFloat(match[1].replace(',', ''));
      if (!isNaN(val) && val > 0.5 && val < 2000) {
        prices.push(val);
      }
    }

    if (prices.length > 0) {
      // Take the most common price (likely the main product)
      const priceFreq = new Map<number, number>();
      for (const p of prices) {
        priceFreq.set(p, (priceFreq.get(p) || 0) + 1);
      }
      const sortedPrices = [...priceFreq.entries()].sort((a, b) => b[1] - a[1]);
      const bestPrice = sortedPrices[0][0];

      if (this.validatePrice(bestPrice, searchQuery)) {
        logger.info(
          { store: this.config.storeName, itemId, price: bestPrice, method: 'aed-regex', totalPrices: prices.length },
          'Price found via AED regex fallback'
        );
        return {
          itemId, storeId: this.config.storeId, searchQuery,
          productName: searchQuery, price: bestPrice, success: true,
        };
      }
    }

    return null;
  }

  private isGenericName(name: string): boolean {
    const lower = name.toLowerCase();
    return (
      lower.length < 3 ||
      lower === 'carrefour' ||
      lower === 'search' ||
      lower === 'home' ||
      lower === 'mafuae' ||
      lower.startsWith('http') ||
      lower.includes('navigation') ||
      lower.includes('breadcrumb') ||
      lower.includes('menu') ||
      /^\d+$/.test(lower)
    );
  }

  private noResult(itemId: number, searchQuery: string, error: string): ScrapeResult {
    return {
      itemId, storeId: this.config.storeId, searchQuery,
      productName: null, price: null, success: false, error,
    };
  }
}
