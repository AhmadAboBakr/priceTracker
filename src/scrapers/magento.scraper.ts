import { BaseScraper, ScrapeResult, StoreConfig, CheerioDoc } from './base-scraper';
import { logger } from '../utils/logger';

/**
 * Reusable scraper for Magento 2 based UAE stores.
 * Many UAE grocery sites (Union Coop, Choithrams, Grandiose, West Zone,
 * VIVA, Al Madina) run on Magento 2 which exposes a standard GraphQL API.
 *
 * Strategy order:
 *   1. Magento GraphQL (fastest, structured)
 *   2. Magento REST API
 *   3. HTML scrape with cheerio
 */
export class MagentoScraper extends BaseScraper {
  constructor(config: StoreConfig) {
    super(config);
  }

  protected async performSearch(
    itemId: number,
    searchQuery: string
  ): Promise<ScrapeResult> {
    const gqlResult = await this.tryGraphQl(searchQuery, itemId);
    if (gqlResult) return gqlResult;

    const restResult = await this.tryRestApi(searchQuery, itemId);
    if (restResult) return restResult;

    const htmlResult = await this.tryHtmlScrape(searchQuery, itemId);
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
            {
              store: this.config.storeName,
              itemId,
              price: best.price,
              productName: best.name,
              method: 'graphql',
            },
            'Price found via GraphQL'
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
        'GraphQL failed'
      );
    }

    return null;
  }

  /// Tries Magento 2 REST API product search.
  private async tryRestApi(
    searchQuery: string,
    itemId: number
  ): Promise<ScrapeResult | null> {
    const encoded = encodeURIComponent(searchQuery);
    const restUrls = [
      `${this.config.baseUrl}/rest/V1/products?searchCriteria[filter_groups][0][filters][0][field]=name&searchCriteria[filter_groups][0][filters][0][value]=%25${encoded}%25&searchCriteria[filter_groups][0][filters][0][condition_type]=like&searchCriteria[pageSize]=5`,
      `${this.config.baseUrl}/rest/default/V1/products?searchCriteria[filter_groups][0][filters][0][field]=name&searchCriteria[filter_groups][0][filters][0][value]=%25${encoded}%25&searchCriteria[filter_groups][0][filters][0][condition_type]=like&searchCriteria[pageSize]=5`,
    ];

    for (const restUrl of restUrls) {
      try {
        const data = await this.fetchJson(restUrl, {
          Referer: this.config.baseUrl,
        });

        const items = data?.items;
        if (!Array.isArray(items) || items.length === 0) continue;

        const products: { name: string; price: number }[] = [];
        for (const item of items) {
          const name = item.name;
          let price = item.price;

          if (item.custom_attributes && Array.isArray(item.custom_attributes)) {
            const specialPrice = item.custom_attributes.find(
              (a: any) => a.attribute_code === 'special_price'
            );
            if (specialPrice?.value) {
              const sp = parseFloat(String(specialPrice.value));
              if (!isNaN(sp) && sp > 0) price = sp;
            }
          }

          if (name && price) {
            const num = parseFloat(String(price));
            if (!isNaN(num) && num > 0) products.push({ name, price: num });
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
                method: 'rest-api',
              },
              'Price found via REST API'
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
          'REST API failed'
        );
      }
    }

    return null;
  }

  /// Falls back to fetching and parsing the search results HTML.
  private async tryHtmlScrape(
    searchQuery: string,
    itemId: number
  ): Promise<ScrapeResult | null> {
    const url = `${this.config.searchUrl}${encodeURIComponent(searchQuery)}`;
    logger.debug({ store: this.config.storeName, url }, 'Fetching search HTML');

    try {
      const $ = await this.fetchHtml(url, { Referer: this.config.baseUrl });

      // LD+JSON structured data
      const ldResult = this.extractFromLdJson($, itemId, searchQuery);
      if (ldResult) return ldResult;

      // Magento 2 product listing
      const products: { name: string; price: number }[] = [];

      $('.product-item').each((_i, el) => {
        const $item = $(el);
        const name =
          $item.find('a.product-item-link').text().trim() ||
          $item.find('.product-item-name a').text().trim() ||
          $item.find('.product-name a').text().trim();

        const priceText =
          $item.find('[data-price-type="finalPrice"] .price').text().trim() ||
          $item.find('.special-price .price').text().trim() ||
          $item.find('.price-box .price').text().trim() ||
          $item.find('.price').first().text().trim();

        if (name && priceText) {
          const num = parseFloat(priceText.replace(/[^\d.]/g, ''));
          if (!isNaN(num) && num > 0.5 && num < 2000) {
            products.push({ name, price: num });
          }
        }
      });

      // AED regex fallback
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
            {
              store: this.config.storeName,
              itemId,
              price: best.price,
              productName: best.name,
              method: 'html',
            },
            'Price found via HTML'
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
        'HTML scrape failed'
      );
    }

    return null;
  }

  /// Extracts products from Schema.org LD+JSON blocks.
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

        if (data['@type'] === 'Product' && data.name && data.offers) {
          const p = parseFloat(
            String(data.offers.price ?? data.offers.lowPrice)
          );
          if (!isNaN(p) && p > 0) products.push({ name: data.name, price: p });
        }

        if (
          data['@type'] === 'ItemList' &&
          Array.isArray(data.itemListElement)
        ) {
          for (const item of data.itemListElement) {
            const prod = item.item || item;
            if (prod.name && prod.offers) {
              const p = parseFloat(
                String(prod.offers.price ?? prod.offers.lowPrice)
              );
              if (!isNaN(p) && p > 0)
                products.push({ name: prod.name, price: p });
            }
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
                method: 'ld+json',
              },
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
      } catch {
        /* skip malformed LD+JSON */
      }
    }
    return null;
  }
}

// ─── Concrete store classes using the shared Magento scraper ────────

/// Scraper for Choithrams UAE (Magento 2).
export class ChoithramsScraper extends MagentoScraper {
  constructor(storeId: number) {
    super({
      storeId,
      storeName: 'Choithrams',
      baseUrl: 'https://www.choithrams.com',
      searchUrl: 'https://www.choithrams.com/catalogsearch/result/?q=',
      requestDelay: 2000,
    });
  }
}

/// Scraper for Grandiose UAE (Magento 2).
export class GrandioseScraper extends MagentoScraper {
  constructor(storeId: number) {
    super({
      storeId,
      storeName: 'Grandiose',
      baseUrl: 'https://www.grandiose.ae',
      searchUrl: 'https://www.grandiose.ae/catalogsearch/result/?q=',
      requestDelay: 2000,
    });
  }
}

/// Scraper for West Zone UAE (Magento 2).
export class WestZoneScraper extends MagentoScraper {
  constructor(storeId: number) {
    super({
      storeId,
      storeName: 'West Zone',
      baseUrl: 'https://www.westzone.com',
      searchUrl: 'https://www.westzone.com/catalogsearch/result/?q=',
      requestDelay: 2000,
    });
  }
}

/// Scraper for VIVA Supermarket UAE (Magento 2).
export class VivaScraper extends MagentoScraper {
  constructor(storeId: number) {
    super({
      storeId,
      storeName: 'VIVA Supermarket',
      baseUrl: 'https://www.vivasupermarket.com',
      searchUrl: 'https://www.vivasupermarket.com/catalogsearch/result/?q=',
      requestDelay: 2000,
    });
  }
}

/// Scraper for Al Madina UAE (Magento 2).
export class AlMadinaScraper extends MagentoScraper {
  constructor(storeId: number) {
    super({
      storeId,
      storeName: 'Al Madina',
      baseUrl: 'https://www.almadinauae.com',
      searchUrl: 'https://www.almadinauae.com/catalogsearch/result/?q=',
      requestDelay: 2000,
    });
  }
}
