import { BaseScraper, ScrapeResult, StoreConfig } from './base-scraper';
import { logger } from '../utils/logger';

/**
 * Scraper for Spinneys UAE (spinneys.com).
 * Spinneys uses a custom frontend. We try their search API endpoint
 * and fall back to HTML parsing with AED price extraction.
 */
export class SpinneysScraper extends BaseScraper {
  constructor(storeId: number) {
    const config: StoreConfig = {
      storeId,
      storeName: 'Spinneys',
      baseUrl: 'https://www.spinneys.com',
      searchUrl: 'https://www.spinneys.com/search?q=',
      requestDelay: 2000,
      useCookieJar: true,
    };
    super(config);
  }

  protected async performSearch(
    itemId: number,
    searchQuery: string
  ): Promise<ScrapeResult> {
    // Strategy 1: Try search API endpoint
    const apiResult = await this.trySearchApi(searchQuery, itemId);
    if (apiResult) return apiResult;

    // Strategy 2: Parse search page HTML
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

  /// Tries various API patterns Spinneys might use.
  private async trySearchApi(
    searchQuery: string,
    itemId: number
  ): Promise<ScrapeResult | null> {
    const encoded = encodeURIComponent(searchQuery);
    const apiUrls = [
      `${this.config.baseUrl}/api/search?q=${encoded}&limit=5`,
      `${this.config.baseUrl}/api/products/search?q=${encoded}&limit=5`,
      `${this.config.baseUrl}/api/v1/search?q=${encoded}&limit=5`,
    ];

    for (const url of apiUrls) {
      try {
        const response = await this.http.get(url, {
          headers: {
            Accept: 'application/json',
            Referer: this.config.baseUrl,
          },
          timeout: 10000,
        });

        const data = response.data;
        if (typeof data !== 'object' || data === null) continue;

        const products = this.findProductsInJson(data);
        if (products.length > 0) {
          const best = this.findBestMatch(products, searchQuery);
          if (best && this.validatePrice(best.price, searchQuery)) {
            logger.info(
              {
                store: this.config.storeName,
                itemId,
                price: best.price,
                productName: best.name,
                method: 'search-api',
              },
              'Price found via search API'
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
          'Search API attempt failed'
        );
      }
    }

    return null;
  }

  /// Parses the search page HTML for product data.
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
                {
                  store: this.config.storeName,
                  itemId,
                  price: best.price,
                  productName: best.name,
                  method: 'next-data',
                },
                'Price found via __NEXT_DATA__'
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
        } catch {
          /* malformed JSON */
        }
      }

      // Try embedded JSON in script tags
      const scriptPattern =
        /<script[^>]*>([\s\S]*?)<\/script>/gi;
      let scriptMatch;
      while ((scriptMatch = scriptPattern.exec(html)) !== null) {
        const content = scriptMatch[1];
        if (content.includes('"price"') && content.includes('"name"')) {
          try {
            // Try to find JSON object boundaries
            const jsonPattern = /\{[^{}]*"name"\s*:\s*"[^"]+?"[^{}]*"price"\s*:\s*[\d.]+[^{}]*\}/g;
            let jsonMatch;
            const products: { name: string; price: number }[] = [];
            while ((jsonMatch = jsonPattern.exec(content)) !== null) {
              try {
                const obj = JSON.parse(jsonMatch[0]);
                const name = obj.name || obj.title;
                const price = obj.price || obj.sale_price || obj.final_price;
                if (name && price) {
                  const num = parseFloat(String(price));
                  if (!isNaN(num) && num > 0.5 && num < 2000) {
                    products.push({ name: String(name), price: num });
                  }
                }
              } catch {
                /* not valid JSON */
              }
            }

            if (products.length > 0) {
              const best = this.findBestMatch(products, searchQuery);
              if (best && this.validatePrice(best.price, searchQuery)) {
                logger.info(
                  {
                    store: this.config.storeName,
                    itemId,
                    price: best.price,
                    productName: best.name,
                    method: 'embedded-json',
                  },
                  'Price found via embedded JSON'
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
          } catch {
            /* skip */
          }
        }
      }

      // AED regex fallback
      const aedPattern = /(?:AED|aed|د\.إ)\s*([\d,.]+)/g;
      let match;
      const prices: number[] = [];
      while ((match = aedPattern.exec(html)) !== null) {
        const val = parseFloat(match[1].replace(',', ''));
        if (!isNaN(val) && val > 0.5 && val < 2000) prices.push(val);
      }

      if (prices.length > 0) {
        const freq = new Map<number, number>();
        for (const p of prices) freq.set(p, (freq.get(p) || 0) + 1);
        const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
        const bestPrice = sorted[0][0];

        if (this.validatePrice(bestPrice, searchQuery)) {
          logger.info(
            {
              store: this.config.storeName,
              itemId,
              price: bestPrice,
              method: 'aed-regex',
            },
            'Price found via AED regex'
          );
          return {
            itemId,
            storeId: this.config.storeId,
            searchQuery,
            productName: searchQuery,
            price: bestPrice,
            success: true,
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
