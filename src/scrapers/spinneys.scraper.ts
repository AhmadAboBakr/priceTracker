import { BaseScraper, ScrapeResult, StoreConfig } from './base-scraper';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger';

/**
 * Scraper for Spinneys UAE (spinneys.com).
 * Uses either the product-autocomplete endpoint (returns HTML) or
 * the full search page. Product cards use `.js-product-wrapper` with
 * `p.product-name > a` for names and `p.product-price > span.price`
 * for numeric prices.
 */
export class SpinneysScraper extends BaseScraper {
  private static readonly AUTOCOMPLETE_URL =
    'https://www.spinneys.com/en-ae/search/product-autocomplete/?q=';
  private static readonly SEARCH_URL =
    'https://www.spinneys.com/en-ae/search/?q=';

  constructor(storeId: number) {
    const config: StoreConfig = {
      storeId,
      storeName: 'Spinneys',
      baseUrl: 'https://www.spinneys.com',
      searchUrl: SpinneysScraper.SEARCH_URL,
      requestDelay: 2000,
      useCookieJar: true,
    };
    super(config);
  }

  protected async performSearch(
    itemId: number,
    searchQuery: string
  ): Promise<ScrapeResult> {
    // Strategy 1: Autocomplete API (fast, lightweight HTML)
    const autoResult = await this.tryAutocomplete(searchQuery, itemId);
    if (autoResult) return autoResult;

    // Strategy 2: Full search page HTML
    const htmlResult = await this.trySearchPage(searchQuery, itemId);
    if (htmlResult) return htmlResult;

    // Strategy 3: AED regex fallback on search page
    const regexResult = await this.tryAedRegex(searchQuery, itemId);
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

  /**
   * Tries the autocomplete endpoint which returns JSON with HTML fragments.
   * The response shape is:
   *   { product_items_count, product_items_html, product_swiper_html, ... }
   * Product data lives in `product_swiper_html` (contains .js-product-wrapper cards).
   */
  private async tryAutocomplete(
    searchQuery: string,
    itemId: number
  ): Promise<ScrapeResult | null> {
    const url = `${SpinneysScraper.AUTOCOMPLETE_URL}${encodeURIComponent(searchQuery)}`;

    try {
      const response = await this.http.get(url, {
        headers: {
          'Accept': 'application/json, text/html, */*',
          'Referer': 'https://www.spinneys.com/en-ae/',
          'X-Requested-With': 'XMLHttpRequest',
        },
        timeout: 10000,
      });

      let html = '';

      // Response may be JSON (with product_swiper_html field) or raw HTML
      if (typeof response.data === 'object' && response.data !== null) {
        // JSON response — extract the HTML fragment that contains product cards
        html = response.data.product_swiper_html || response.data.product_items_html || '';
      } else {
        html = typeof response.data === 'string' ? response.data : String(response.data);
      }

      if (html.length < 50) return null;

      const products = this.extractProductsFromHtml(html);
      if (products.length > 0) {
        const best = this.findBestMatch(products, searchQuery);
        if (best && this.validatePrice(best.price, searchQuery)) {
          logger.info(
            { store: this.config.storeName, itemId, price: best.price, productName: best.name, method: 'autocomplete' },
            'Price found via autocomplete'
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
        'Autocomplete request failed'
      );
    }

    return null;
  }

  /** Fetches the full search results page and extracts products */
  private async trySearchPage(
    searchQuery: string,
    itemId: number
  ): Promise<ScrapeResult | null> {
    const url = `${SpinneysScraper.SEARCH_URL}${encodeURIComponent(searchQuery)}`;

    try {
      const response = await this.http.get(url, {
        headers: { Referer: 'https://www.spinneys.com/en-ae/' },
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
   * Extracts product name/price pairs from Spinneys HTML.
   * Looks for `.js-product-wrapper` cards with `p.product-name a` and
   * `p.product-price span.price`.
   */
  private extractProductsFromHtml(html: string): { name: string; price: number }[] {
    const $ = cheerio.load(html);
    const products: { name: string; price: number }[] = [];

    // Primary: Spinneys-specific selectors discovered from live site
    $('.js-product-wrapper').each((_i, el) => {
      const $card = $(el);

      // Product name from p.product-name > a
      const name =
        $card.find('p.product-name a').first().text().trim() ||
        $card.find('.product-name a').first().text().trim() ||
        $card.find('a[title]').first().attr('title')?.trim() ||
        '';

      // Price from p.product-price > span.price (numeric only, no currency)
      const priceText =
        $card.find('p.product-price span.price').first().text().trim() ||
        $card.find('.product-price .price').first().text().trim() ||
        '';

      if (name && name.length > 2 && priceText) {
        const num = parseFloat(priceText.replace(/[^\d.]/g, ''));
        if (!isNaN(num) && num > 0.5 && num < 2000) {
          products.push({ name, price: num });
        }
      }
    });

    // Fallback: Generic product card selectors
    if (products.length === 0) {
      $('[class*="product-card"], [class*="ProductCard"], .product-item').each((_i, el) => {
        const $card = $(el);
        const name =
          $card.find('[class*="name"] a, [class*="title"] a, h3 a, h4 a').first().text().trim();
        const priceText =
          $card.find('[class*="price"]').first().text().trim();

        if (name && name.length > 2 && priceText) {
          const num = parseFloat(priceText.replace(/[^\d.]/g, ''));
          if (!isNaN(num) && num > 0.5 && num < 2000) {
            products.push({ name, price: num });
          }
        }
      });
    }

    return products;
  }

  /** AED regex fallback on search page text */
  private async tryAedRegex(
    searchQuery: string,
    itemId: number
  ): Promise<ScrapeResult | null> {
    const url = `${SpinneysScraper.SEARCH_URL}${encodeURIComponent(searchQuery)}`;

    try {
      const response = await this.http.get(url, {
        headers: { Referer: 'https://www.spinneys.com/en-ae/' },
        timeout: 15000,
      });

      const html: string =
        typeof response.data === 'string' ? response.data : String(response.data);

      const aedPattern = /(?:AED|aed)\s*([\d,.]+)/g;
      let match;
      const prices: number[] = [];
      while ((match = aedPattern.exec(html)) !== null) {
        const val = parseFloat(match[1].replace(',', ''));
        if (!isNaN(val) && val > 0.5 && val < 2000) prices.push(val);
      }

      if (prices.length > 0) {
        const price = prices[0];
        if (this.validatePrice(price, searchQuery)) {
          logger.info(
            { store: this.config.storeName, itemId, price, method: 'aed-regex' },
            'Price found via AED regex'
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
        'AED regex fallback failed'
      );
    }

    return null;
  }
}
