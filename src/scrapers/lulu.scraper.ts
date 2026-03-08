import { BaseScraper, ScrapeResult, StoreConfig } from './base-scraper';
import { logger } from '../utils/logger';

/** Scraper adapter for Lulu Hypermarket UAE */
export class LuluScraper extends BaseScraper {
  private hasVisitedHomepage = false;

  constructor(storeId: number) {
    const config: StoreConfig = {
      storeId,
      storeName: 'Lulu Hypermarket',
      baseUrl: 'https://gcc.luluhypermarket.com/en-ae',
      searchUrl: '', // Not used — Lulu search is done via the search bar
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
      await this.page.goto(this.config.baseUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await this.page.waitForTimeout(3000);
      this.hasVisitedHomepage = true;
    }

    // Use the search bar — Lulu's /search?q= URL returns 404,
    // the real search works by typing into the search input and pressing Enter
    logger.debug(
      { store: this.config.storeName, searchQuery },
      'Typing into search bar'
    );

    const searchInputSelectors = [
      'input[placeholder*="Anything"]',
      'input[placeholder*="Search"]',
      'input[type="search"]',
      'input[name="q"]',
      'input[class*="search"]',
    ];

    let searchInput = null;
    for (const sel of searchInputSelectors) {
      searchInput = await this.page.$(sel);
      if (searchInput) break;
    }

    if (!searchInput) {
      // Fallback: navigate to homepage again and retry
      await this.page.goto(this.config.baseUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await this.page.waitForTimeout(3000);

      for (const sel of searchInputSelectors) {
        searchInput = await this.page.$(sel);
        if (searchInput) break;
      }
    }

    if (!searchInput) {
      return {
        itemId,
        storeId: this.config.storeId,
        searchQuery,
        productName: null,
        price: null,
        success: false,
        error: 'Could not find search input on Lulu site',
      };
    }

    // Clear previous search, type new query, hit Enter
    await searchInput.click({ clickCount: 3 }); // select all
    await this.page.waitForTimeout(200);
    await searchInput.fill(searchQuery);
    await this.page.waitForTimeout(500);
    await this.page.keyboard.press('Enter');

    // Wait for search results to load (Lulu redirects to a category page)
    await this.page.waitForTimeout(5000);

    // ── Extract price and name using known Lulu selectors ────────
    // Product names: <a> with Tailwind class "line-clamp-3"
    // Prices: <span> with "font-bold text-base text-black"

    let price: number | null = null;
    let productName: string | null = null;

    // Primary selectors (confirmed from live site inspection)
    const priceSelectors = [
      'span.font-bold.text-base.text-black',
      'span.font-bold.text-black',
      'span[class*="font-bold"][class*="text-black"]',
    ];

    const nameSelectors = [
      'a.line-clamp-3',
      'a[class*="line-clamp"]',
    ];

    for (const sel of nameSelectors) {
      try {
        const el = await this.page.$(sel);
        if (el) {
          productName = (await el.textContent())?.trim() || null;
          if (productName) break;
        }
      } catch {}
    }

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

    // Fallback: grab all numbers that look like prices from the page
    if (price === null) {
      try {
        const allPrices = await this.page.evaluate(() => {
          const spans = document.querySelectorAll('span');
          const prices: number[] = [];
          spans.forEach((el) => {
            const text = (el.textContent || '').trim();
            const val = parseFloat(text);
            if (
              !isNaN(val) &&
              val > 0.5 &&
              val < 2000 &&
              text === val.toFixed(2).replace(/\.?0+$/, '') || text === val.toString()
            ) {
              // Check if parent looks like a price container (has font-bold)
              if (el.className.includes('font-bold') || el.parentElement?.className.includes('font-bold')) {
                prices.push(val);
              }
            }
          });
          return prices;
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
