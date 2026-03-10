/**
 * Playwright stealth diagnostic for Lulu Hypermarket UAE.
 * Run locally:  npx ts-node src/scrapers/probe-lulu.ts
 *
 * Tests whether the Playwright + stealth approach bypasses Cloudflare
 * and can extract product data from Lulu search pages.
 */
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
chromium.use(stealth());

const SEARCH_TERMS = ['milk', 'rice', 'chicken', 'bread'];
const BASE_URL = 'https://gcc.luluhypermarket.com/en-ae';
const SEARCH_URL = 'https://gcc.luluhypermarket.com/en-ae/list/?search_text=';

async function main() {
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║  Lulu Hypermarket — Playwright Stealth Diagnostic  ║');
  console.log('╚═══════════════════════════════════════════════════╝');
  console.log(`Running at ${new Date().toISOString()}\n`);

  console.log('Launching stealth browser...');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-AE',
    timezoneId: 'Asia/Dubai',
  });

  // ── Test 1: Homepage warmup ──────────────────────────
  console.log('\n═══ 1. HOMEPAGE WARMUP ═══');
  try {
    const page = await context.newPage();
    const response = await page.goto(BASE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    const status = response?.status() || 0;
    const title = await page.title();
    const bodyText = await page.textContent('body').catch(() => '');
    const hasCloudflare = bodyText?.includes('Checking your browser') || bodyText?.includes('cf-browser-verification');

    if (hasCloudflare) {
      console.log(`⏳ Homepage: ${status} — Cloudflare challenge detected, waiting 8s...`);
      await page.waitForTimeout(8000);
      const newTitle = await page.title();
      const newBody = await page.textContent('body').catch(() => '');
      const stillBlocked = newBody?.includes('Checking your browser');
      console.log(`   After wait: title="${newTitle}", still blocked: ${stillBlocked}`);
    } else {
      console.log(`✅ Homepage: ${status} — title="${title}"`);
      const aedCount = (bodyText?.match(/AED\s*[\d,.]+/g) || []).length;
      console.log(`   AED prices found on homepage: ${aedCount}`);
    }
    await page.close();
  } catch (err: any) {
    console.log(`❌ Homepage failed: ${err.message}`);
  }

  // ── Test 2: Search pages ──────────────────────────────
  console.log('\n═══ 2. SEARCH PAGES ═══');
  for (const term of SEARCH_TERMS) {
    const url = `${SEARCH_URL}${encodeURIComponent(term)}`;
    console.log(`\nSearching: "${term}"  →  ${url}`);
    try {
      const page = await context.newPage();
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      const status = response?.status() || 0;

      // Wait for products to appear
      let productsFound = false;
      const selectors = [
        '[data-testid="product-card"]',
        '.product-card',
        '[class*="ProductCard"]',
        'a[class*="line-clamp"]',
        'span[class*="font-bold"][class*="text-black"]',
      ];

      for (const sel of selectors) {
        try {
          await page.waitForSelector(sel, { timeout: 10000 });
          const count = await page.locator(sel).count();
          console.log(`   ✅ Selector "${sel}" matched ${count} elements`);
          productsFound = true;
          break;
        } catch {
          // not found, try next
        }
      }

      if (!productsFound) {
        // Fallback: check for AED text
        try {
          await page.waitForFunction(
            () => document.body.innerText.includes('AED'),
            { timeout: 8000 }
          );
          productsFound = true;
          console.log('   ✅ AED text detected on page');
        } catch {
          console.log('   ⚠️ No product selectors or AED text found');
        }
      }

      // Extract products from the page
      const products = await page.evaluate(() => {
        const results: { name: string; price: string }[] = [];

        // Try name+price selectors
        const nameSelectors = [
          'a.line-clamp-3', 'a[class*="line-clamp"]',
          '[data-testid="product-name"]', '.product-name a', 'h3 a', 'h2 a',
        ];
        const priceSelectors = [
          'span.font-bold.text-base.text-black', 'span.font-bold.text-black',
          '[data-testid="product-price"]', '.product-price', 'span.price',
        ];

        let names: string[] = [];
        let prices: string[] = [];

        for (const sel of nameSelectors) {
          const els = document.querySelectorAll(sel);
          if (els.length > 0) {
            els.forEach(el => {
              const t = (el as HTMLElement).innerText?.trim();
              if (t && t.length > 2) names.push(t);
            });
            break;
          }
        }
        for (const sel of priceSelectors) {
          const els = document.querySelectorAll(sel);
          if (els.length > 0) {
            els.forEach(el => {
              const t = (el as HTMLElement).innerText?.trim();
              if (t) prices.push(t);
            });
            break;
          }
        }

        const count = Math.min(names.length, prices.length, 5);
        for (let i = 0; i < count; i++) {
          results.push({ name: names[i], price: prices[i] });
        }

        // Fallback: AED regex from page text
        if (results.length === 0) {
          const text = document.body.innerText || '';
          const matches = text.match(/(?:AED|aed|د\.إ)\s*[\d,.]+/g) || [];
          for (const m of matches.slice(0, 5)) {
            results.push({ name: '(regex)', price: m });
          }
        }

        return results;
      });

      console.log(`   Status: ${status} | Products extracted: ${products.length}`);
      for (const p of products.slice(0, 5)) {
        console.log(`     → ${p.name.substring(0, 60)} | ${p.price}`);
      }

      // Check __NEXT_DATA__
      const hasNextData = await page.evaluate(() => !!document.getElementById('__NEXT_DATA__'));
      if (hasNextData) {
        console.log('   📦 __NEXT_DATA__ found — JSON extraction possible');
      }

      // Check LD+JSON
      const ldJsonCount = await page.evaluate(
        () => document.querySelectorAll('script[type="application/ld+json"]').length
      );
      if (ldJsonCount > 0) {
        console.log(`   📦 ${ldJsonCount} LD+JSON script(s) found`);
      }

      await page.close();
    } catch (err: any) {
      console.log(`   ❌ Search failed: ${err.message}`);
    }
  }

  // ── Test 3: Direct product page ────────────────────────
  console.log('\n═══ 3. DIRECT PRODUCT PAGE TEST ═══');
  try {
    const page = await context.newPage();
    // Navigate to search first, then try to grab a product link
    await page.goto(`${SEARCH_URL}milk`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    const productLink = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/en-ae/"]'));
      for (const link of links) {
        const href = (link as HTMLAnchorElement).href;
        if (href.includes('/p/') || href.match(/\/en-ae\/[a-z].*\/[a-z0-9-]+\/?$/)) {
          return href;
        }
      }
      return null;
    });

    if (productLink) {
      console.log(`Found product link: ${productLink}`);
      await page.goto(productLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      const productData = await page.evaluate(() => {
        const title = document.querySelector('h1')?.innerText?.trim() || '(no title)';
        const priceText = document.body.innerText.match(/(?:AED|aed)\s*([\d,.]+)/);
        return { title, price: priceText ? priceText[0] : '(no price)' };
      });
      console.log(`   ✅ Product: ${productData.title} | ${productData.price}`);
    } else {
      console.log('   ⚠️ No product links found on search page');
    }
    await page.close();
  } catch (err: any) {
    console.log(`   ❌ Product page test failed: ${err.message}`);
  }

  // ── Test 4: Bot detection checks ───────────────────────
  console.log('\n═══ 4. BOT DETECTION STATUS ═══');
  try {
    const page = await context.newPage();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const botTests = await page.evaluate(() => {
      return {
        webdriver: (navigator as any).webdriver,
        plugins: navigator.plugins.length,
        languages: navigator.languages?.length || 0,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        hasChrome: !!(window as any).chrome,
        hasCDP: !!(window as any).cdc_adoQpoasnfa76pfcZLmcfl_Array,
      };
    });

    console.log(`   navigator.webdriver: ${botTests.webdriver} (should be false/undefined)`);
    console.log(`   plugins: ${botTests.plugins} (should be > 0)`);
    console.log(`   languages: ${botTests.languages} (should be > 0)`);
    console.log(`   platform: ${botTests.platform}`);
    console.log(`   hardwareConcurrency: ${botTests.hardwareConcurrency}`);
    console.log(`   window.chrome: ${botTests.hasChrome} (should be true)`);
    console.log(`   CDP markers: ${botTests.hasCDP} (should be false)`);

    await page.close();
  } catch (err: any) {
    console.log(`   ❌ Bot detection check failed: ${err.message}`);
  }

  await browser.close();

  console.log('\n═══════════════════════════════════════════════════');
  console.log('DONE. Key results:');
  console.log('  ✅ = Playwright stealth bypassed Cloudflare, products extracted');
  console.log('  ⚠️ = Page loaded but no product data found (may need different selectors)');
  console.log('  ❌ = Still blocked by Cloudflare or network error');
  console.log('═══════════════════════════════════════════════════');
}

main().catch(console.error);
