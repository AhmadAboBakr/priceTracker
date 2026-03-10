import { BaseScraper, ScrapeResult, StoreConfig } from './base-scraper';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger';

/**
 * Scraper for Choithrams UAE (choithrams.com).
 * Not Magento — appears to be a custom or Shopify-like platform.
 * Homepage returns 771KB but catalogsearch/graphql return 404.
 * We probe common API patterns and parse search HTML.
 */
export class ChoithramsScraper extends BaseScraper {
  constructor(storeId: number) {
    const config: StoreConfig = {
      storeId,
      storeName: 'Choithrams',
      baseUrl: 'https://www.choithrams.com',
      searchUrl: 'https://www.choithrams.com/search?q=',
      requestDelay: 2000,
      useCookieJar: true,
    };
    super(config);
  }

  protected async performSearch(
    itemId: number,
    searchQuery: string
  ): Promise<ScrapeResult> {
    // Strategy 1: Try various API search endpoints
    const apiResult = await this.trySearchApis(searchQuery, itemId);
    if (apiResult) return apiResult;

    // Strategy 2: Parse search page HTML
    const htmlResult = await this.tryHtmlSearch(searchQuery, itemId);
    if (htmlResult) return htmlResult;

    // Strategy 3: Try alternative search URL patterns
    const altResult = await this.tryAlternativeUrls(searchQuery, itemId);
    if (altResult) return altResult;

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

  /// Tries various common API endpoint patterns.
  private async trySearchApis(
    searchQuery: string,
    itemId: number
  ): Promise<ScrapeResult | null> {
    const encoded = encodeURIComponent(searchQuery);
    const apiUrls = [
      `${this.config.baseUrl}/api/search?q=${encoded}`,
      `${this.config.baseUrl}/api/products/search?q=${encoded}&limit=5`,
      `${this.config.baseUrl}/api/v1/products?search=${encoded}&limit=5`,
      `${this.config.baseUrl}/search/suggest?q=${encoded}`,
      `${this.config.baseUrl}/wc/v3/products?search=${encoded}&per_page=5`,
    ];

    for (const url of apiUrls) {
      try {
        const response = await this.http.get(url, {
          headers: {
            'Accept': 'application/json',
            'Referer': this.config.baseUrl,
          },
          timeout: 8000,
        });

        const data = response.data;
        if (typeof data !== 'object' || data === null) continue;

        const products = this.findProductsInJson(data);
        if (products.length > 0) {
          const best = this.findBestMatch(products, searchQuery);
          if (best && this.validatePrice(best.price, searchQuery)) {
            logger.info(
              { store: this.config.storeName, itemId, price: best.price, productName: best.name, method: 'api', url },
              'Price found via API'
            );
            return {
              itemId, storeId: this.config.storeId, searchQuery,
              productName: best.name, price: best.price, success: true,
            };
          }
        }
      } catch {
        // Silently try next URL
      }
    }

    return null;
  }

  /// Fetches and parses search page HTML.
  private async tryHtmlSearch(
    searchQuery: string,
    itemId: number
  ): Promise<ScrapeResult | null> {
    // Try several search URL patterns
    const searchUrls = [
      `${this.config.searchUrl}${encodeURIComponent(searchQuery)}`,
      `${this.config.baseUrl}/search?q=${encodeURIComponent(searchQuery)}`,
      `${this.config.baseUrl}/search?keyword=${encodeURIComponent(searchQuery)}`,
      `${this.config.baseUrl}/search/${encodeURIComponent(searchQuery)}`,
    ];

    for (const url of searchUrls) {
      try {
        const response = await this.http.get(url, {
          headers: { Referer: this.config.baseUrl },
        });

        const html: string =
          typeof response.data === 'string'
            ? response.data
            : String(response.data);

        if (html.length < 500) continue;

        const result = this.parseProductHtml(html, itemId, searchQuery);
        if (result) return result;
      } catch {
        // Try next URL
      }
    }

    return null;
  }

  /// Tries alternative URL patterns.
  private async tryAlternativeUrls(
    searchQuery: string,
    itemId: number
  ): Promise<ScrapeResult | null> {
    const encoded = encodeURIComponent(searchQuery);
    const urls = [
      `${this.config.baseUrl}/collections/all?q=${encoded}`,
      `${this.config.baseUrl}/products?q=${encoded}`,
    ];

    for (const url of urls) {
      try {
        const response = await this.http.get(url, {
          headers: { Referer: this.config.baseUrl },
        });

        const html: string =
          typeof response.data === 'string'
            ? response.data
            : String(response.data);

        if (html.length < 500) continue;

        const result = this.parseProductHtml(html, itemId, searchQuery);
        if (result) return result;
      } catch {
        // Try next URL
      }
    }

    return null;
  }

  /** Shared HTML parsing logic for any page with product data. */
  private parseProductHtml(
    html: string,
    itemId: number,
    searchQuery: string
  ): ScrapeResult | null {
    const $ = cheerio.load(html);
    const products: { name: string; price: number }[] = [];

    // __NEXT_DATA__ check
    const nextDataMatch = html.match(
      /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
    );
    if (nextDataMatch) {
      try {
        const nextData = JSON.parse(nextDataMatch[1]);
        const found = this.findProductsInJson(nextData);
        products.push(...found);
      } catch { /* skip */ }
    }

    // Generic product cards
    $('[class*="product"], [class*="Product"], [data-product]').each((_i, el) => {
      const $card = $(el);
      const name =
        $card.find('[class*="name"], [class*="title"], h3, h4').first().text().trim() ||
        $card.find('a').first().text().trim();
      const priceText =
        $card.find('[class*="price"], [class*="Price"]').first().text().trim();

      if (name && name.length > 3 && priceText) {
        const num = parseFloat(priceText.replace(/[^\d.]/g, ''));
        if (!isNaN(num) && num > 0.5 && num < 2000) {
          products.push({ name, price: num });
        }
      }
    });

    // AED regex
    if (products.length === 0) {
      const aedPattern = /AED\s*([\d,.]+)/g;
      let match;
      while ((match = aedPattern.exec(html)) !== null) {
        const val = parseFloat(match[1].replace(',', ''));
        if (!isNaN(val) && val > 0.5 && val < 2000) {
          products.push({ name: searchQuery, price: val });
        }
      }
    }

    if (products.length > 0) {
      const best = this.findBestMatch(products, searchQuery);
      if (best && this.validatePrice(best.price, searchQuery)) {
        logger.info(
          { store: this.config.storeName, itemId, price: best.price, productName: best.name, method: 'html' },
          'Price found via HTML'
        );
        return {
          itemId, storeId: this.config.storeId, searchQuery,
          productName: best.name, price: best.price, success: true,
        };
      }
    }

    return null;
  }
}
