/**
 * Diagnostic script for Choithrams UAE.
 * Tests the server-rendered search page HTML parsing with the
 * Choithrams-specific DOM structure and dirham price format.
 *
 * Usage:  npx ts-node src/scrapers/probe-choithrams.ts
 */
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SEARCH_URL = 'https://www.choithrams.com/en/search/?q=';
const SEARCH_TERMS = ['milk', 'rice', 'chicken', 'bread', 'water'];

function parseDirhamPrice(text: string): number | null {
  // "D3.50 Each" format (custom dirham font)
  const dirhamMatch = text.match(/D([\d,.]+)/);
  if (dirhamMatch) {
    const val = parseFloat(dirhamMatch[1].replace(',', ''));
    if (!isNaN(val) && val > 0) return val;
  }
  // "AED 3.50" format
  const aedMatch = text.match(/(?:AED|aed)\s*([\d,.]+)/);
  if (aedMatch) {
    const val = parseFloat(aedMatch[1].replace(',', ''));
    if (!isNaN(val) && val > 0) return val;
  }
  // Plain number fallback
  const numMatch = text.match(/([\d]+\.[\d]{2})/);
  if (numMatch) {
    const val = parseFloat(numMatch[1]);
    if (!isNaN(val) && val > 0) return val;
  }
  return null;
}

function extractProducts(html: string): { name: string; price: number }[] {
  const $ = cheerio.load(html);
  const products: { name: string; price: number }[] = [];

  $('.js-product-wrapper').each((_i, el) => {
    const $card = $(el);
    const name =
      $card.find('p.excerpt a').first().text().trim() ||
      $card.find('p.excerpt.line-crop a').first().text().trim() ||
      $card.find('.product-info a').first().text().trim() ||
      '';
    const priceText =
      $card.find('.product-price .price').first().text().trim() || '';

    if (name && priceText) {
      const price = parseDirhamPrice(priceText);
      if (price !== null && price > 0) {
        products.push({ name, price });
      }
    }
  });

  return products;
}

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  Choithrams UAE — Scraper Probe Diagnostic   ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`Running at ${new Date().toISOString()}\n`);

  const jar = new CookieJar();
  const http = wrapper(
    axios.create({
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.choithrams.com/en/',
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
    const r = await http.get('https://www.choithrams.com/en/');
    const body = String(r.data);
    const server = r.headers['server'] || 'unknown';
    console.log(`✅ Homepage: ${r.status} (${body.length} bytes) Server: ${server}`);
  } catch (e: any) {
    console.log(`❌ Homepage failed: ${e.response?.status || e.message}`);
  }

  // ── Test 2: Search pages ───────────────────────────────
  console.log('\n═══ 2. SEARCH PAGES ═══');
  for (const term of SEARCH_TERMS) {
    const url = `${SEARCH_URL}${encodeURIComponent(term)}`;
    try {
      const r = await http.get(url);
      const html = String(r.data);
      const products = extractProducts(html);

      const $ = cheerio.load(html);
      const wrapperCount = $('.js-product-wrapper').length;

      // Check for dirham prices (D + number)
      const dirhamMatches = (html.match(/D[\d]+\.[\d]{2}/g) || []).length;
      // Check for AED prices
      const aedMatches = (html.match(/(?:AED|aed)\s*[\d,.]+/g) || []).length;
      // Check for results count text
      const resultsMatch = html.match(/(\d+)\s*Results?/i);
      const totalResults = resultsMatch ? resultsMatch[1] : 'unknown';

      console.log(`\n  "${term}": ${r.status} (${html.length} bytes) — ${totalResults} total results`);
      console.log(`    .js-product-wrapper: ${wrapperCount} | Dirham prices: ${dirhamMatches} | AED prices: ${aedMatches} | Parsed: ${products.length}`);

      for (const p of products.slice(0, 3)) {
        console.log(`    → ${p.name.substring(0, 55)} | AED ${p.price.toFixed(2)}`);
      }

      if (products.length === 0 && wrapperCount > 0) {
        // Debug: show what's in the first wrapper
        const firstWrapper = $('.js-product-wrapper').first();
        const nameEl = firstWrapper.find('p.excerpt a').first().text().trim();
        const priceEl = firstWrapper.find('.product-price .price').first().text().trim();
        console.log(`    ⚠️ Parsing failed. First card name: "${nameEl}" price: "${priceEl}"`);
      }
    } catch (e: any) {
      console.log(`\n  "${term}": ❌ ${e.response?.status || e.message}`);
    }
  }

  // ── Test 3: Price format verification ──────────────────
  console.log('\n═══ 3. PRICE FORMAT VERIFICATION ═══');
  try {
    const r = await http.get(`${SEARCH_URL}milk`);
    const html = String(r.data);
    const $ = cheerio.load(html);

    console.log('  Testing parseDirhamPrice() with live data:');
    let tested = 0;
    $('.js-product-wrapper').each((_i, el) => {
      if (tested >= 5) return;
      const $card = $(el);
      const rawPrice = $card.find('.product-price .price').first().text().trim();
      const parsed = parseDirhamPrice(rawPrice);
      const name = $card.find('p.excerpt a').first().text().trim();
      console.log(`    "${rawPrice}" → ${parsed !== null ? `AED ${parsed.toFixed(2)}` : 'FAILED'} (${name.substring(0, 40)})`);
      tested++;
    });
  } catch (e: any) {
    console.log(`  ❌ Price format test failed: ${e.response?.status || e.message}`);
  }

  // ── Test 4: Product link structure ─────────────────────
  console.log('\n═══ 4. PRODUCT LINK STRUCTURE ═══');
  try {
    const r = await http.get(`${SEARCH_URL}milk`);
    const html = String(r.data);
    const $ = cheerio.load(html);

    const links: string[] = [];
    $('.js-product-wrapper .product-img a, .js-product-wrapper p.excerpt a').each((_i, el) => {
      const href = $(el).attr('href');
      if (href && !links.includes(href)) links.push(href);
    });

    console.log(`  Found ${links.length} unique product links:`);
    for (const link of links.slice(0, 5)) {
      console.log(`    ${link}`);
    }
  } catch (e: any) {
    console.log(`  ❌ Link test failed: ${e.response?.status || e.message}`);
  }

  // ── Summary ────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════');
  console.log('DONE. Key selectors to validate:');
  console.log('  Product cards: .js-product-wrapper');
  console.log('  Names:  p.excerpt a  or  p.excerpt.line-crop a');
  console.log('  Prices: .product-price .price (format: "D3.50 Each")');
  console.log('  Search URL: /en/search/?q=');
  console.log('  Price parse: D(\\d+\\.\\d{2}) → extract number after "D"');
  console.log('═══════════════════════════════════════════════');
}

main().catch(console.error);
