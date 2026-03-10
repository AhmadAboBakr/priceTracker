import { BaseScraper, ScrapeResult, StoreConfig } from './base-scraper';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger';

/**
 * Scraper for Choithrams UAE (choithrams.com).
 * Server-rendered search page at /en/search/?q=.
 * Product cards use `.js-product-wrapper` with `p.excerpt a` for names
 * and `.product-price .price` for prices. Prices use a custom dirham
 * font character "D" followed by the numeric value (e.g. "D3.50 Each").
 */
export class ChoithramsScraper extends BaseScraper {
  private static readonly SEARCH_URL = 'https://www.choithrams.com/en/search/?q=';

  constructor(storeId: number) {
    const config: StoreConfig = {
      storeId,
      storeName: 'Choithrams',
      baseUrl: 'https://www.choithrams.com',
      searchUrl: ChoithramsScraper.SEARCH_URL,
      requestDelay: 2000,
      useCookieJar: true,
    };
    super(config);
  }

  protected async performSearch(
    itemId: number,
    searchQuery: string
  ): Promise<ScrapeResult> {
    // Strategy 1: Parse search page HTML with Choithrams-specific selectors
    const htmlResult = await this.trySearchPage(searchQuery, itemId);
    if (htmlResult) return htmlResult;

    // Strategy 2: Dirham regex fallback on full page text
    const regexResult = await this.tryDirhamRegex(searchQuery, itemId);
    if (regexResult) return regexResult;

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

  /** Fetches search results page and extracts products from Choithrams DOM */
  private async trySearchPage(
    searchQuery: string,
    itemId: number
  ): Promise<ScrapeResult | null> {
    const url = `${ChoithramsScraper.SEARCH_URL}${encodeURIComponent(searchQuery)}`;

    try {
      const response = await this.http.get(url, {
        headers: {
          'Referer': 'https://www.choithrams.com/en/',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 15000,
      });

      const html: string =
        typeof response.data === 'string' ? response.data : String(response.data);

      if (html.length < 500) return null;

      const products = this.extractProductsFromHtml(html);
      if (products.length > 0) {
        const best = this.findBestMatch(products, searchQuery);
        if (best && this.validatePrice(best.price, searchQuery)) {
          logger.info(
            { store: this.config.storeName, itemId, price: best.price, productName: best.name, method: 'search-page' },
            'Price found via search page'
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
        'Search page request failed'
      );
    }

    return null;
  }

  /**
   * Extracts products from Choithrams HTML.
   * Product cards: `.js-product-wrapper`
   *   - Name:  `p.excerpt a` or `p.excerpt.line-crop a`
   *   - Price: `.product-price:not(.mobile) .price` — text like "D3.50 Each"
   *   - Link:  `.product-container .product-img a` (href like /en/catalogue/item_ID/)
   */
  private extractProductsFromHtml(html: string): { name: string; price: number }[] {
    const $ = cheerio.load(html);
    const products: { name: string; price: number }[] = [];

    // Primary: Choithrams-specific selectors
    $('.js-product-wrapper').each((_i, el) => {
      const $card = $(el);

      // Product name
      const name =
        $card.find('p.excerpt a').first().text().trim() ||
        $card.find('p.excerpt.line-crop a').first().text().trim() ||
        $card.find('.product-info a').first().text().trim() ||
        '';

      // Price — from the desktop price div (not .mobile)
      // Text format: "D3.50 Each" where D is a dirham symbol in custom font
      const priceEl = $card.find('.product-price .price').first();
      const priceText = priceEl.text().trim();

      if (name && name.length > 2 && priceText) {
        const price = this.parseDirhamPrice(priceText);
        if (price !== null && price > 0.5 && price < 2000) {
          products.push({ name, price });
        }
      }
    });

    // Fallback: Generic product selectors
    if (products.length === 0) {
      $('.product-bx, .product-container, [class*="product-card"]').each((_i, el) => {
        const $card = $(el);
        const name =
          $card.find('a').first().text().trim();
        const priceText =
          $card.find('[class*="price"]').first().text().trim();

        if (name && name.length > 2 && priceText) {
          const price = this.parseDirhamPrice(priceText);
          if (price !== null && price > 0.5 && price < 2000) {
            products.push({ name, price });
          }
        }
      });
    }

    return products;
  }

  /**
   * Parses Choithrams price format. The site uses a custom font where "D" represents
   * the dirham symbol. Price text looks like "D3.50 Each" or "D16.29 Each".
   * Also handles standard "AED 3.50" format and plain numbers.
   */
  private parseDirhamPrice(text: string): number | null {
    // Try "D" prefix format: "D3.50", "D16.29"
    const dirhamMatch = text.match(/D([\d,.]+)/);
    if (dirhamMatch) {
      const val = parseFloat(dirhamMatch[1].replace(',', ''));
      if (!isNaN(val) && val > 0) return val;
    }

    // Try AED format: "AED 3.50"
    const aedMatch = text.match(/(?:AED|aed)\s*([\d,.]+)/);
    if (aedMatch) {
      const val = parseFloat(aedMatch[1].replace(',', ''));
      if (!isNaN(val) && val > 0) return val;
    }

    // Try plain number
    const numMatch = text.match(/([\d]+\.[\d]{2})/);
    if (numMatch) {
      const val = parseFloat(numMatch[1]);
      if (!isNaN(val) && val > 0) return val;
    }

    return null;
  }

  /** Regex fallback: scans entire HTML for dirham prices */
  private async tryDirhamRegex(
    searchQuery: string,
    itemId: number
  ): Promise<ScrapeResult | null> {
    const url = `${ChoithramsScraper.SEARCH_URL}${encodeURIComponent(searchQuery)}`;

    try {
      const response = await this.http.get(url, {
        headers: { 'Referer': 'https://www.choithrams.com/en/' },
        timeout: 15000,
      });

      const html: string =
        typeof response.data === 'string' ? response.data : String(response.data);

      // Look for D + number pattern (Choithrams dirham font) and AED pattern
      const patterns = [
        /D([\d]+\.[\d]{2})/g,
        /(?:AED|aed)\s*([\d,.]+)/g,
      ];

      const prices: number[] = [];
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(html)) !== null) {
          const val = parseFloat(match[1].replace(',', ''));
          if (!isNaN(val) && val > 0.5 && val < 2000) prices.push(val);
        }
        if (prices.length > 0) break;
      }

      if (prices.length > 0) {
        const price = prices[0];
        if (this.validatePrice(price, searchQuery)) {
          logger.info(
            { store: this.config.storeName, itemId, price, method: 'dirham-regex' },
            'Price found via dirham regex'
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
    } catch (e) {
      logger.debug(
        { store: this.config.storeName, error: (e as Error).message },
        'Dirham regex fallback failed'
      );
    }

    return null;
  }
}
