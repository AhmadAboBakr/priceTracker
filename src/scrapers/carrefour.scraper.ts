import { BaseScraper, ScrapeResult, StoreConfig } from './base-scraper';
import { logger } from '../utils/logger';

/** Scraper adapter for Carrefour UAE (Majid Al Futtaim) */
export class CarrefourScraper extends BaseScraper {
  constructor(storeId: number) {
    const config: StoreConfig = {
      storeId,
      storeName: 'Carrefour UAE',
      baseUrl: 'https://www.carrefouruae.com',
      // Use the main site search page, NOT the v4 API endpoint (which blocks bots)
      searchUrl: 'https://www.carrefouruae.com/mafuae/en/search?keyword=',
      requestDelay: 5000,
    };
    super(config);
  }

  protected async performSearch(
    itemId: number,
    searchQuery: string
  ): Promise<ScrapeResult> {
    if (!this.page) throw new Error('Browser not initialized');

    // First visit the homepage to establish cookies/session on first run
    try {
      const currentUrl = this.page.url();
      if (!currentUrl.includes('carrefouruae.com')) {
        logger.debug({ store: this.config.storeName }, 'Warming up with homepage visit');
        await this.page.goto(this.config.baseUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 20000,
        });
        await this.page.waitForTimeout(2000);
      }
    } catch {
      // Homepage visit is optional — continue even if it fails
    }

    const url = `${this.config.searchUrl}${encodeURIComponent(searchQuery)}`;
    logger.debug({ store: this.config.storeName, url }, 'Navigating to search');

    try {
      await this.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: parseInt(process.env.SCRAPER_TIMEOUT || '30000', 10),
      });
    } catch (navError) {
      // If navigation fails, try an alternative approach: use the search bar
      logger.warn(
        { store: this.config.storeName, error: (navError as Error).message },
        'Direct search URL failed, trying search bar approach'
      );
      return this.searchViaSearchBar(itemId, searchQuery);
    }

    // Carrefour is a heavy React app — give it time to render
    await this.page.waitForTimeout(4000);

    return this.extractFromPage(itemId, searchQuery);
  }

  /** Fallback: navigate to homepage and use the search bar */
  private async searchViaSearchBar(
    itemId: number,
    searchQuery: string
  ): Promise<ScrapeResult> {
    if (!this.page) throw new Error('Browser not initialized');

    try {
      await this.page.goto(this.config.baseUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await this.page.waitForTimeout(3000);

      // Try to find and use the search bar
      const searchInputSelectors = [
        'input[type="search"]',
        'input[placeholder*="Search"]',
        'input[placeholder*="search"]',
        'input[name="q"]',
        'input[name="keyword"]',
        '#search-input',
        '[data-testid="search-input"]',
        'input[class*="search"]',
      ];

      for (const sel of searchInputSelectors) {
        try {
          const input = await this.page.$(sel);
          if (input) {
            await input.click();
            await this.page.waitForTimeout(500);
            await input.fill(searchQuery);
            await this.page.keyboard.press('Enter');
            await this.page.waitForTimeout(5000);
            return this.extractFromPage(itemId, searchQuery);
          }
        } catch {}
      }

      throw new Error('Could not find search input on Carrefour homepage');
    } catch (error) {
      logger.error(
        { store: this.config.storeName, error: (error as Error).message },
        'Search bar approach also failed'
      );
      return {
        itemId,
        storeId: this.config.storeId,
        searchQuery,
        productName: null,
        price: null,
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /** Extracts product name and price from the current search results page */
  private async extractFromPage(
    itemId: number,
    searchQuery: string
  ): Promise<ScrapeResult> {
    if (!this.page) throw new Error('Browser not initialized');

    const priceSelectors = [
      '[data-testid="product_card_price"]',
      '[data-testid="product_price"]',
      '.product-price',
      '.price .amount',
      '.plp-price',
      'span[class*="price"] span',
      'span[class*="Price"]',
      'div[class*="price"]',
      'span[class*="amount"]',
    ];

    const nameSelectors = [
      '[data-testid="product_card_name"]',
      '[data-testid="product_name"]',
      '.product-name',
      'a[class*="product"] span',
      '.plp-name',
      'a[class*="name"]',
      'div[class*="product-name"]',
    ];

    let price: number | null = null;
    let productName: string | null = null;

    for (const priceSel of priceSelectors) {
      try {
        const priceEl = await this.page.$(priceSel);
        if (priceEl) {
          const text = await priceEl.textContent();
          if (text) {
            const parsed = parseFloat(text.replace(/[^\d.]/g, ''));
            if (!isNaN(parsed) && this.validatePrice(parsed, searchQuery)) {
              price = parsed;
              break;
            }
          }
        }
      } catch {}
    }

    for (const nameSel of nameSelectors) {
      try {
        const nameEl = await this.page.$(nameSel);
        if (nameEl) {
          productName = await nameEl.textContent();
          if (productName) {
            productName = productName.trim();
            break;
          }
        }
      } catch {}
    }

    // Fallback: regex-based AED price extraction from full page
    if (price === null) {
      try {
        const allPrices = await this.page.evaluate(() => {
          const elements = document.querySelectorAll('*');
          const prices: number[] = [];
          elements.forEach((el) => {
            // Only check leaf nodes to avoid duplicates
            if (el.children.length > 5) return;
            const text = el.textContent || '';
            const match = text.match(/(?:AED|aed|د\.إ)\s*([\d,.]+)/);
            if (match) {
              const val = parseFloat(match[1].replace(',', ''));
              if (!isNaN(val) && val > 0.5 && val < 2000) {
                prices.push(val);
              }
            }
          });
          return [...new Set(prices)];
        });

        if (allPrices.length > 0) {
          price = allPrices[0];
        }
      } catch {}
    }

    if (price !== null) {
      logger.info(
        { store: this.config.storeName, itemId, price, productName },
        'Price found'
      );
      return {
        itemId,
        storeId: this.config.storeId,
        searchQuery,
        productName,
        price,
        success: true,
      };
    }

    logger.warn(
      { store: this.config.storeName, itemId, searchQuery },
      'No price found'
    );
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
}
