import { BaseScraper, ScrapeResult, StoreConfig } from './base-scraper';
import { logger } from '../utils/logger';

/** Scraper adapter for Union Coop UAE (Magento 2 site) */
export class UnionCoopScraper extends BaseScraper {
  private hasVisitedHomepage = false;

  constructor(storeId: number) {
    const config: StoreConfig = {
      storeId,
      storeName: 'Union Coop',
      baseUrl: 'https://www.unioncoop.ae',
      searchUrl: 'https://www.unioncoop.ae/catalogsearch/result/?q=',
      requestDelay: 3000,
    };
    super(config);
  }

  protected async performSearch(
    itemId: number,
    searchQuery: string
  ): Promise<ScrapeResult> {
    if (!this.page) throw new Error('Browser not initialized');

    // Visit homepage once to establish session / cookies
    if (!this.hasVisitedHomepage) {
      logger.debug({ store: this.config.storeName }, 'Initial homepage visit');
      try {
        await this.page.goto(this.config.baseUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 20000,
        });
        await this.page.waitForTimeout(3000);
        this.hasVisitedHomepage = true;
      } catch (err) {
        logger.warn(
          { store: this.config.storeName, error: (err as Error).message },
          'Homepage visit failed, trying direct search URL'
        );
      }
    }

    // Strategy 1: Try direct search URL first (Magento standard)
    let searchWorked = false;
    const directUrl = `${this.config.searchUrl}${encodeURIComponent(searchQuery)}`;

    try {
      logger.debug({ store: this.config.storeName, url: directUrl }, 'Trying direct search URL');
      await this.page.goto(directUrl, {
        waitUntil: 'domcontentloaded',
        timeout: parseInt(process.env.SCRAPER_TIMEOUT || '30000', 10),
      });
      await this.page.waitForTimeout(4000);

      // Check if we actually got search results (not a 404/error page)
      const hasResults = await this.page.evaluate(() => {
        const body = document.body.textContent || '';
        return !body.includes('404') && !body.includes('Page Not Found');
      });
      searchWorked = hasResults;
    } catch (err) {
      logger.warn(
        { store: this.config.storeName, error: (err as Error).message },
        'Direct search URL failed, trying search bar'
      );
    }

    // Strategy 2: If direct URL failed, use the search bar
    if (!searchWorked) {
      try {
        await this.searchViaSearchBar(searchQuery);
      } catch (err) {
        return {
          itemId,
          storeId: this.config.storeId,
          searchQuery,
          productName: null,
          price: null,
          success: false,
          error: `Both search methods failed: ${(err as Error).message}`,
        };
      }
    }

    // ── Extract price and name ──────────────────────────────────
    return this.extractFromPage(itemId, searchQuery);
  }

  /** Uses the on-page search bar to search for a product */
  private async searchViaSearchBar(searchQuery: string): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');

    // Navigate to homepage if not already there
    if (!this.hasVisitedHomepage) {
      await this.page.goto(this.config.baseUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await this.page.waitForTimeout(3000);
      this.hasVisitedHomepage = true;
    }

    // Magento 2 standard search input selectors
    const searchInputSelectors = [
      '#search',                          // Magento 2 default
      'input[name="q"]',                  // Standard search param
      'input#search_mini_form',
      'input[type="search"]',
      'input[placeholder*="Search"]',
      'input[placeholder*="search"]',
      'input[class*="search"]',
      '.search-input input',
      '#search_mini_form input',
    ];

    let searchInput = null;
    for (const sel of searchInputSelectors) {
      searchInput = await this.page.$(sel);
      if (searchInput) break;
    }

    if (!searchInput) {
      throw new Error('Could not find search input on Union Coop site');
    }

    await searchInput.click({ clickCount: 3 });
    await this.page.waitForTimeout(200);
    await searchInput.fill(searchQuery);
    await this.page.waitForTimeout(500);
    await this.page.keyboard.press('Enter');
    await this.page.waitForTimeout(5000);
  }

  /** Extracts product name and price from the current page */
  private async extractFromPage(
    itemId: number,
    searchQuery: string
  ): Promise<ScrapeResult> {
    if (!this.page) throw new Error('Browser not initialized');

    let price: number | null = null;
    let productName: string | null = null;

    // Magento 2 standard selectors (most common to least)
    const priceSelectors = [
      '.price-box .price',                       // Magento 2 standard
      '.product-item-info .price',
      '.price-wrapper .price',
      '[data-price-type="finalPrice"] .price',    // Magento 2 final price
      '.special-price .price',
      '.regular-price .price',
      '.product-price .price',
      '.old-price .price',
      'span.price',
      '[class*="price"] span',
    ];

    const nameSelectors = [
      'a.product-item-link',                     // Magento 2 standard
      '.product-item-name a',
      '.product-item-link',
      '.product-item-info .product-item-link',
      '.product-name a',
      '.product-item-name',
      'h2.product-name a',
      'a[class*="product"][class*="link"]',
    ];

    // Try name selectors
    for (const sel of nameSelectors) {
      try {
        const el = await this.page.$(sel);
        if (el) {
          productName = (await el.textContent())?.trim() || null;
          if (productName && productName.length > 3) break;
        }
      } catch {}
    }

    // Try price selectors
    for (const sel of priceSelectors) {
      try {
        const el = await this.page.$(sel);
        if (el) {
          const text = await el.textContent();
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

    // Fallback: scan page for AED prices or bare numeric prices
    if (price === null) {
      try {
        const allPrices = await this.page.evaluate(() => {
          const prices: number[] = [];

          // Method 1: Look for AED/currency formatted prices
          document.querySelectorAll('*').forEach((el) => {
            if (el.children.length > 5) return;
            const text = (el.textContent || '').trim();
            const match = text.match(/(?:AED|aed|د\.إ)\s*([\d,.]+)/);
            if (match) {
              const val = parseFloat(match[1].replace(',', ''));
              if (!isNaN(val) && val > 0.5 && val < 2000) {
                prices.push(val);
              }
            }
          });

          // Method 2: Look for elements with price-like classes containing numbers
          if (prices.length === 0) {
            document.querySelectorAll('[class*="price"], [class*="Price"]').forEach((el) => {
              const text = (el.textContent || '').trim();
              const val = parseFloat(text.replace(/[^\d.]/g, ''));
              if (!isNaN(val) && val > 0.5 && val < 2000) {
                prices.push(val);
              }
            });
          }

          return [...new Set(prices)];
        });

        if (allPrices.length > 0) {
          price = allPrices[0];
        }
      } catch {}
    }

    // Fallback for name too
    if (!productName) {
      try {
        productName = await this.page.evaluate(() => {
          // Look for the first product-like heading or link
          const candidates = document.querySelectorAll(
            'h2 a, h3 a, .product a, [class*="product"] a, [class*="item"] a'
          );
          for (const el of candidates) {
            const text = (el.textContent || '').trim();
            if (text.length > 5 && text.length < 200) {
              return text;
            }
          }
          return null;
        });
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
