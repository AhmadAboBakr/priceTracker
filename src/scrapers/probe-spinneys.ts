/**
 * Diagnostic script for Spinneys UAE.
 * Tests the autocomplete API and the full search page HTML parsing.
 *
 * Usage:  npx ts-node src/scrapers/probe-spinneys.ts
 */
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const AUTOCOMPLETE_URL = 'https://www.spinneys.com/en-ae/search/product-autocomplete/?q=';
const SEARCH_URL = 'https://www.spinneys.com/en-ae/search/?q=';
const SEARCH_TERMS = ['milk', 'rice', 'chicken', 'bread', 'water'];

function extractProducts(html: string): { name: string; price: number }[] {
  const $ = cheerio.load(html);
  const products: { name: string; price: number }[] = [];

  $('.js-product-wrapper').each((_i, el) => {
    const $card = $(el);
    const name =
      $card.find('p.product-name a').first().text().trim() ||
      $card.find('.product-name a').first().text().trim() ||
      '';
    const priceText =
      $card.find('p.product-price span.price').first().text().trim() ||
      $card.find('.product-price .price').first().text().trim() ||
      '';

    if (name && priceText) {
      const num = parseFloat(priceText.replace(/[^\d.]/g, ''));
      if (!isNaN(num) && num > 0) {
        products.push({ name, price: num });
      }
    }
  });

  return products;
}

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Spinneys UAE — Scraper Probe Diagnostic    ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`Running at ${new Date().toISOString()}\n`);

  const jar = new CookieJar();
  const http = wrapper(
    axios.create({
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.spinneys.com/en-ae/',
      },
      timeout: 15000,
      maxRedirects: 10,
      jar,
      withCredentials: true,
    })
  );

  // ── Test 1: Homepage ───────────────────────────────────
  console.log('═══ 1. HOMEPAGE ═══');
  try {
    const r = await http.get('https://www.spinneys.com/en-ae/');
    const body = String(r.data);
    const server = r.headers['server'] || 'unknown';
    console.log(`✅ Homepage: ${r.status} (${body.length} bytes) Server: ${server}`);
  } catch (e: any) {
    console.log(`❌ Homepage failed: ${e.response?.status || e.message}`);
  }

  // ── Test 2: Autocomplete API ───────────────────────────
  // Response is JSON with product_swiper_html containing .js-product-wrapper cards
  console.log('\n═══ 2. AUTOCOMPLETE API ═══');
  for (const term of SEARCH_TERMS) {
    const url = `${AUTOCOMPLETE_URL}${encodeURIComponent(term)}`;
    try {
      const r = await http.get(url, {
        headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/html, */*' },
      });

      let html = '';
      const data = r.data;

      // Response is JSON — products are in product_swiper_html, not product_items_html
      if (typeof data === 'object' && data !== null) {
        const swiperHtml = data.product_swiper_html || '';
        const itemsHtml = data.product_items_html || '';
        html = swiperHtml || itemsHtml;
        console.log(`\n  "${term}": ${r.status} (JSON) product_items_count=${data.product_items_count || 0}, swiper_html=${swiperHtml.length} bytes`);
      } else {
        html = String(data);
        console.log(`\n  "${term}": ${r.status} (raw HTML, ${html.length} bytes)`);
      }

      const products = extractProducts(html);
      console.log(`    Parsed ${products.length} products from HTML fragment`);
      for (const p of products.slice(0, 3)) {
        console.log(`    → ${p.name.substring(0, 55)} | AED ${p.price.toFixed(2)}`);
      }

      if (products.length === 0 && html.length > 0) {
        console.log(`    ⚠️ No products parsed. HTML preview: ${html.substring(0, 200)}`);
      }
    } catch (e: any) {
      console.log(`\n  "${term}": ❌ ${e.response?.status || e.message}`);
    }
  }

  // ── Test 3: Full search page ───────────────────────────
  console.log('\n═══ 3. FULL SEARCH PAGE ═══');
  for (const term of SEARCH_TERMS) {
    const url = `${SEARCH_URL}${encodeURIComponent(term)}`;
    try {
      const r = await http.get(url);
      const html = String(r.data);
      const products = extractProducts(html);

      // Also check for .js-product-wrapper count and AED matches
      const $ = cheerio.load(html);
      const wrapperCount = $('.js-product-wrapper').length;
      const aedMatches = (html.match(/(?:AED|aed)\s*[\d,.]+/g) || []).length;

      console.log(`\n  "${term}": ${r.status} (${html.length} bytes)`);
      console.log(`    .js-product-wrapper: ${wrapperCount} | AED regex: ${aedMatches} | Parsed: ${products.length}`);
      for (const p of products.slice(0, 3)) {
        console.log(`    → ${p.name.substring(0, 55)} | AED ${p.price.toFixed(2)}`);
      }
    } catch (e: any) {
      console.log(`\n  "${term}": ❌ ${e.response?.status || e.message}`);
    }
  }

  // ── Summary ────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════');
  console.log('DONE. Key selectors to validate:');
  console.log('  Product cards: .js-product-wrapper');
  console.log('  Names:  p.product-name > a');
  console.log('  Prices: p.product-price > span.price');
  console.log('  Autocomplete: /en-ae/search/product-autocomplete/?q=');
  console.log('  Search page:  /en-ae/search/?q=');
  console.log('═══════════════════════════════════════════════');
}

main().catch(console.error);
