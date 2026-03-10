/**
 * Diagnostic v3: Dumps Carrefour HTML structure around AED prices
 * so we can see how to extract product name + price pairs.
 *
 * Run: npx ts-node src/scrapers/diagnose.ts
 */
import axios from 'axios';
import * as cheerio from 'cheerio';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const QUERY = 'milk';

function createClient() {
  const jar = new CookieJar();
  const client = wrapper(axios.create({
    jar,
    timeout: 20000,
    maxRedirects: 10,
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
    withCredentials: true,
    validateStatus: () => true,
  }));
  return { client, jar };
}

async function main() {
  console.log('Carrefour HTML Structure Analysis');
  console.log(`Query: "${QUERY}"\n`);

  const { client } = createClient();

  // Step 1: Homepage for cookies
  console.log('1. Getting cookies from homepage...');
  await client.get('https://www.carrefouruae.com/mafuae/en/');

  // Step 2: Fetch search page
  console.log('2. Fetching search results...\n');
  const res = await client.get(`https://www.carrefouruae.com/mafuae/en/search?keyword=${QUERY}`);
  const html = res.data as string;
  const $ = cheerio.load(html);

  // Step 3: Find all text nodes containing AED + number
  console.log('=== AED Price Locations ===\n');

  // Get the raw HTML and find AED patterns with surrounding context
  const aedPattern = /AED\s*([\d,.]+)/g;
  let match;
  let count = 0;

  while ((match = aedPattern.exec(html)) !== null && count < 8) {
    const price = match[1];
    if (parseFloat(price) < 1) continue; // skip "AED 0"

    const start = Math.max(0, match.index - 300);
    const end = Math.min(html.length, match.index + match[0].length + 100);
    const context = html.substring(start, end);

    // Find what tags surround this price
    console.log(`--- Price: AED ${price} ---`);
    console.log(`HTML context (trimmed):`);
    // Clean up for readability
    const cleaned = context
      .replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')
      .replace(/<svg[^>]*>[\s\S]*?<\/svg>/g, '[SVG]')
      .replace(/\s+/g, ' ')
      .trim();
    console.log(cleaned.substring(0, 500));
    console.log('');
    count++;
  }

  // Step 4: Look for product card patterns
  console.log('\n=== Element Analysis ===\n');

  // Find elements containing AED text
  const aedElements: string[] = [];
  $('*').each((_i, el) => {
    if (aedElements.length >= 5) return;
    const $el = $(el);
    const text = $el.clone().children().remove().end().text().trim(); // direct text only
    if (/AED\s*\d+/.test(text) && parseFloat(text.replace(/[^\d.]/g, '')) > 1) {
      const tag = el.type === 'tag' ? (el as any).tagName : '?';
      const cls = $el.attr('class') || '(no class)';
      const parent = $el.parent();
      const parentTag = parent.length ? ((parent[0] as any).tagName || '?') : '?';
      const parentCls = parent.attr('class') || '(no class)';

      // Look for nearby text that could be a product name
      const grandparent = parent.parent();
      const allText = grandparent.text().substring(0, 200).replace(/\s+/g, ' ').trim();

      aedElements.push(`<${tag} class="${cls.substring(0, 80)}">`);
      console.log(`Price element: <${tag}> class="${cls.substring(0, 100)}"`);
      console.log(`  Text: "${text.substring(0, 60)}"`);
      console.log(`  Parent: <${parentTag}> class="${parentCls.substring(0, 100)}"`);
      console.log(`  Grandparent text: "${allText.substring(0, 200)}"`);
      console.log('');
    }
  });

  // Step 5: Look for anchor tags or spans that might be product names near prices
  console.log('=== Looking for product name patterns ===\n');
  const allLinks = $('a[href*="/p/"], a[href*="/product"], a[href*="/en/"]');
  console.log(`Links with /p/ or /product in href: ${allLinks.length}`);
  allLinks.each((i, el) => {
    if (i >= 5) return;
    const $a = $(el);
    const text = $a.text().trim().substring(0, 80);
    const href = $a.attr('href') || '';
    if (text.length > 5 && !text.includes('Carrefour') && !text.includes('Home')) {
      console.log(`  "${text}" → ${href.substring(0, 80)}`);
    }
  });

  // Step 6: Try to find the repeating product card structure
  console.log('\n=== Product card structure detection ===\n');
  // Look for repeated sibling elements that contain both text and AED
  const containers = $('div, li, article, section').filter((_i, el) => {
    const text = $(el).text();
    return text.includes('AED') && text.length < 500 && text.length > 20;
  });
  console.log(`Elements containing "AED" with 20-500 chars text: ${containers.length}`);
  containers.each((i, el) => {
    if (i >= 5) return;
    const $c = $(el);
    const tag = (el as any).tagName;
    const cls = $c.attr('class') || '(no class)';
    const text = $c.text().replace(/\s+/g, ' ').trim().substring(0, 150);
    console.log(`  <${tag} class="${cls.substring(0, 80)}">`);
    console.log(`    "${text}"`);
    console.log('');
  });
}

main().catch(console.error);
