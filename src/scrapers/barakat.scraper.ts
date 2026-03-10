import { BaseScraper, ScrapeResult, StoreConfig } from './base-scraper';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger';

/**
 * Scraper for Barakat Fresh UAE (barakatfresh.ae).
 * Barakat is a Next.js + Magento hybrid. The search page returns
 * server-rendered HTML with AED prices. We also try the Magento
 * GraphQL endpoint as it may expose structured product data.
 */
export class BarakatScraper extends BaseScraper {
  constructor(storeId: number) {
    const config: StoreConfig = {
      storeId,
      storeName: 'Barakat',
      baseUrl: 'https://www.barakatfresh.ae',
      searchUrl: 'https://www.barakatfresh.ae/search?q=',
      requestDelay: 2000,
    };
    super(config);
  }

  protected async performSearch(
    itemId: number,
    searchQuery: string
  ): Promise<ScrapeResult> {
    // Strategy 1: Magento GraphQL (site shows Magento markers)
    const gqlResult = await this.tryGraphQl(searchQuery, itemId);
    if (gqlResult) return gqlResult;

    // Strategy 2: Parse search page HTML
    const htmlResult = await this.tryHtmlParse(searchQuery, itemId);
    if (htmlResult) return htmlResult;

    // Strategy 3: Try Magento catalog search URL
    const magentoResult = await this.tryMagentoCatalogSearch(searchQuery, itemId);
    if (magentoResult) return magentoResult;

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

  /// Tries Magento 2 GraphQL product search.
  private async tryGraphQl(
    searchQuery: string,
    itemId: number
  ): Promise<ScrapeResult | null> {
    const gqlUrl = `${this.config.baseUrl}/graphql`;
    const query = `{
      products(search: "${searchQuery.replace(/"/g, '\\"')}", pageSize: 5) {
        items {
          name
          sku
          price_range {
            minimum_price {
              final_price {
                value
                currency
              }
            }
          }
        }
      }
    }`;

    try {
      const response = await this.http.post(
        gqlUrl,
        { query },
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Store': 'default',
          },
          timeout: 10000,
        }
      );

      const items = response.data?.data?.products?.items;
      if (!Array.isArray(items) || items.length === 0) return null;

      const products = items
        .filter(
          (item: any) =>
            item.name && item.price_range?.minimum_price?.final_price?.value
        )
        .map((item: any) => ({
          name: item.name as string,
          price: item.price_range.minimum_price.final_price.value as number,
        }));

      if (products.length > 0) {
        const best = this.findBestMatch(products, searchQuery);
        if (best && this.validatePrice(best.price, searchQuery)) {
          logger.info(
            { store: this.config.storeName, itemId, price: best.price, productName: best.name, method: 'graphql' },
            'Price found via GraphQL'
          );
          return {
            itemId, storeId: this.config.storeId, searchQuery,
            productName: best.name, price: best.price, success: true,
          };
        }
      }
    } catch (e) {
      logger.debug(
        { store: this.config.storeName, error: (e as Error).message },
        'GraphQL failed'
      );
    }

    return null;
  }

  /// Parses the search page HTML for product data and AED prices.
  private async tryHtmlParse(
    searchQuery: string,
    itemId: number
  ): Promise<ScrapeResult | null> {
    const url = `${this.config.searchUrl}${encodeURIComponent(searchQuery)}`;

    try {
      const response = await this.http.get(url, {
        headers: { Referer: this.config.baseUrl },
      });

      const html: string =
        typeof response.data === 'string'
          ? response.data
          : String(response.data);

      if (html.length < 500) return null;

      const $ = cheerio.load(html);

      // Check for __NEXT_DATA__
      const nextDataMatch = html.match(
        /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
      );
      if (nextDataMatch) {
        try {
          const nextData = JSON.parse(nextDataMatch[1]);
          const products = this.findProductsInJson(nextData);
          if (products.length > 0) {
            const best = this.findBestMatch(products, searchQuery);
            if (best && this.validatePrice(best.price, searchQuery)) {
              logger.info(
                { store: this.config.storeName, itemId, price: best.price, productName: best.name, method: 'next-data' },
                'Price found via __NEXT_DATA__'
              );
              return {
                itemId, storeId: this.config.storeId, searchQuery,
                productName: best.name, price: best.price, success: true,
              };
            }
          }
        } catch { /* malformed JSON */ }
      }

      // Try product card elements
      const products: { name: string; price: number }[] = [];

      // Common product card selectors
      $('[class*="product-card"], [class*="ProductCard"], [class*="product-item"], [data-product]').each((_i, el) => {
        const $card = $(el);
        const name =
          $card.find('[class*="product-name"], [class*="ProductName"], [class*="title"], h3, h4').first().text().trim() ||
          $card.find('a').first().text().trim();
        const priceText =
          $card.find('[class*="price"], [class*="Price"]').first().text().trim();

        if (name && priceText) {
          const num = parseFloat(priceText.replace(/[^\d.]/g, ''));
          if (!isNaN(num) && num > 0.5 && num < 2000) {
            products.push({ name, price: num });
          }
        }
      });

      if (products.length > 0) {
        const best = this.findBestMatch(products, searchQuery);
        if (best && this.validatePrice(best.price, searchQuery)) {
          logger.info(
            { store: this.config.storeName, itemId, price: best.price, productName: best.name, method: 'html-cards' },
            'Price found via product cards'
          );
          return {
            itemId, storeId: this.config.storeId, searchQuery,
            productName: best.name, price: best.price, success: true,
          };
        }
      }

      // AED regex fallback — the probe found 22 AED prices
      const aedPattern = /AED\s*([\d,.]+)/g;
      let match;
      const aedPrices: number[] = [];
      while ((match = aedPattern.exec(html)) !== null) {
        const val = parseFloat(match[1].replace(',', ''));
        if (!isNaN(val) && val > 0.5 && val < 2000) aedPrices.push(val);
      }

      if (aedPrices.length > 0) {
        // Try to pair names with prices via proximity
        const namePattern = /"name"\s*:\s*"([^"]{3,120})"/g;
        const namedProducts: { name: string; price: number }[] = [];
        const names: string[] = [];
        let nm;
        while ((nm = namePattern.exec(html)) !== null) {
          if (!nm[1].startsWith('http') && nm[1].length > 3) {
            names.push(nm[1]);
          }
        }

        if (names.length > 0 && names.length <= aedPrices.length) {
          for (let i = 0; i < names.length; i++) {
            namedProducts.push({ name: names[i], price: aedPrices[i] });
          }
          const best = this.findBestMatch(namedProducts, searchQuery);
          if (best && this.validatePrice(best.price, searchQuery)) {
            logger.info(
              { store: this.config.storeName, itemId, price: best.price, productName: best.name, method: 'name-price-pair' },
              'Price found via name-price pairing'
            );
            return {
              itemId, storeId: this.config.storeId, searchQuery,
              productName: best.name, price: best.price, success: true,
            };
          }
        }

        // Pure price fallback
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

  /// Tries Magento-style catalog search URL as fallback.
  private async tryMagentoCatalogSearch(
    searchQuery: string,
    itemId: number
  ): Promise<ScrapeResult | null> {
    const url = `${this.config.baseUrl}/catalogsearch/result/?q=${encodeURIComponent(searchQuery)}`;

    try {
      const $ = await this.fetchHtml(url, { Referer: this.config.baseUrl });
      const products: { name: string; price: number }[] = [];

      $('.product-item').each((_i, el) => {
        const $item = $(el);
        const name =
          $item.find('a.product-item-link').text().trim() ||
          $item.find('.product-item-name a').text().trim();
        const priceText =
          $item.find('[data-price-type="finalPrice"] .price').text().trim() ||
          $item.find('.price').first().text().trim();

        if (name && priceText) {
          const num = parseFloat(priceText.replace(/[^\d.]/g, ''));
          if (!isNaN(num) && num > 0.5 && num < 2000) {
            products.push({ name, price: num });
          }
        }
      });

      if (products.length > 0) {
        const best = this.findBestMatch(products, searchQuery);
        if (best && this.validatePrice(best.price, searchQuery)) {
          logger.info(
            { store: this.config.storeName, itemId, price: best.price, productName: best.name, method: 'magento-html' },
            'Price found via Magento catalog search'
          );
          return {
            itemId, storeId: this.config.storeId, searchQuery,
            productName: best.name, price: best.price, success: true,
          };
        }
      }
    } catch (e) {
      logger.debug(
        { store: this.config.storeName, error: (e as Error).message },
        'Magento catalog search failed'
      );
    }

    return null;
  }
}
