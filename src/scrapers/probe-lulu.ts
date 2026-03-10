/**
 * Deep diagnostic for Lulu Hypermarket UAE.
 * Run locally:  npx ts-node src/scrapers/probe-lulu.ts
 *
 * Tests every known approach to access Lulu product data:
 *   - Subdomains (api., m., mobile., search.)
 *   - Akinon commerce platform API patterns
 *   - Mobile app user-agent
 *   - Cookie jar warmup
 *   - Alternative GCC domains
 *   - Sitemap/robots
 */
import axios, { AxiosInstance } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';

const UA_BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UA_MOBILE_ANDROID =
  'LuluShopping/4.2.0 (Android 14; SM-S928B; Build/UP1A.231005.007)';
const UA_MOBILE_IOS =
  'LuluShopping/4.2.0 (iPhone; iOS 17.4; Scale/3.00)';

function createClient(ua: string, useCookies = false): AxiosInstance {
  const opts: any = {
    timeout: 15000,
    maxRedirects: 10,
    headers: {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
    },
    validateStatus: () => true,  // don't throw on any status
  };
  if (useCookies) {
    opts.jar = new CookieJar();
    opts.withCredentials = true;
    return wrapper(axios.create(opts));
  }
  return axios.create(opts);
}

async function probe(
  label: string,
  url: string,
  client: AxiosInstance,
  extraHeaders: Record<string, string> = {}
) {
  try {
    const r = await client.get(url, { headers: extraHeaders });
    const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    const cf = r.headers['server']?.includes('cloudflare') ? ' [CF]' : '';
    const ct = r.headers['content-type'] || '';
    const isJson = ct.includes('json') || body.startsWith('{') || body.startsWith('[');

    let statusIcon = '❌';
    if (r.status === 200) statusIcon = '✅';
    else if (r.status === 301 || r.status === 302) statusIcon = '↪️';
    else if (r.status === 403) statusIcon = '🔒';

    console.log(`${statusIcon} ${label}: ${r.status}${cf} (${body.length} bytes, ${ct.split(';')[0]})`);

    if (r.status === 200 && isJson && body.length > 10 && body.length < 2000) {
      console.log(`   JSON preview: ${body.substring(0, 300)}`);
    }
    if (r.status === 200 && body.length > 1000) {
      // Check for interesting patterns
      const hasAed = (body.match(/AED\s*[\d,.]+/g) || []).length;
      const hasPrice = body.includes('"price"') || body.includes('"sale_price"');
      const hasProduct = body.includes('"product"') || body.includes('"name"');
      const hasNext = body.includes('__NEXT_DATA__') || body.includes('_next/');
      const hasAkinon = body.includes('akinon') || body.includes('Akinon');

      if (hasAed || hasPrice || hasProduct || hasNext || hasAkinon) {
        console.log(`   Signals: AED×${hasAed} | price:${hasPrice} | product:${hasProduct} | next:${hasNext} | akinon:${hasAkinon}`);
      }
    }
    if (r.status === 200 && isJson && body.length > 10) {
      console.log(`   🟢 JSON RESPONSE — THIS MIGHT WORK!`);
    }
    if (r.status === 301 || r.status === 302) {
      console.log(`   → Redirects to: ${r.headers['location']}`);
    }

    return { status: r.status, bodyLength: body.length, body };
  } catch (e: any) {
    console.log(`❌ ${label}: ${e.code || e.message}`);
    return { status: 0, bodyLength: 0, body: '' };
  }
}

async function main() {
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║   Lulu Hypermarket — Deep API Diagnostic      ║');
  console.log('╚═══════════════════════════════════════════════╝');
  console.log(`Running at ${new Date().toISOString()}\n`);

  const browser = createClient(UA_BROWSER);
  const browserCookie = createClient(UA_BROWSER, true);
  const android = createClient(UA_MOBILE_ANDROID);
  const ios = createClient(UA_MOBILE_IOS);

  // ── Section 1: Basic reachability ──────────────────────────
  console.log('═══ 1. BASIC REACHABILITY ═══');
  await probe('Homepage (browser)', 'https://gcc.luluhypermarket.com/en-ae', browser);
  await probe('Homepage (browser+cookies)', 'https://gcc.luluhypermarket.com/en-ae', browserCookie);
  await probe('Homepage (Android UA)', 'https://gcc.luluhypermarket.com/en-ae', android);
  await probe('Homepage (iOS UA)', 'https://gcc.luluhypermarket.com/en-ae', ios);
  await probe('www.luluhypermarket.com', 'https://www.luluhypermarket.com', browser);
  await probe('luluhypermarket.com (bare)', 'https://luluhypermarket.com', browser);

  // ── Section 2: Subdomains ──────────────────────────────────
  console.log('\n═══ 2. SUBDOMAINS ═══');
  await probe('api.luluhypermarket.com', 'https://api.luluhypermarket.com', browser);
  await probe('m.luluhypermarket.com', 'https://m.luluhypermarket.com', browser);
  await probe('mobile.luluhypermarket.com', 'https://mobile.luluhypermarket.com', browser);
  await probe('search.luluhypermarket.com', 'https://search.luluhypermarket.com', browser);
  await probe('app.luluhypermarket.com', 'https://app.luluhypermarket.com', browser);
  await probe('cdn.luluhypermarket.com', 'https://cdn.luluhypermarket.com', browser);
  await probe('gateway.luluhypermarket.com', 'https://gateway.luluhypermarket.com', browser);

  // ── Section 3: Akinon platform API patterns ────────────────
  console.log('\n═══ 3. AKINON API PATTERNS ═══');
  // Akinon commerce platform commonly exposes these endpoints
  const baseUrls = [
    'https://gcc.luluhypermarket.com',
    'https://www.luluhypermarket.com',
  ];
  for (const base of baseUrls) {
    const domain = base.replace('https://', '');
    await probe(`${domain}/api/`, `${base}/api/`, android, { 'Accept': 'application/json' });
    await probe(`${domain}/api/v1/`, `${base}/api/v1/`, android, { 'Accept': 'application/json' });
    await probe(`${domain}/api/v2/`, `${base}/api/v2/`, android, { 'Accept': 'application/json' });
    await probe(`${domain}/ccapi/`, `${base}/ccapi/`, android, { 'Accept': 'application/json' });
  }

  // ── Section 4: Search endpoints ────────────────────────────
  console.log('\n═══ 4. SEARCH ENDPOINTS ═══');
  const searchPaths = [
    '/en-ae/search/?q=milk',
    '/api/search?q=milk',
    '/api/v1/search?q=milk',
    '/api/v2/search?q=milk',
    '/search/api/?q=milk',
    '/ccapi/search/?q=milk',
    '/ccapi/catalog/products/?search=milk',
    '/api/catalog/products/?search=milk',
    '/api/products?search=milk&limit=5',
    '/en-ae/catalogsearch/result/?q=milk',
    '/graphql',
    '/_next/data/',
  ];
  for (const path of searchPaths) {
    await probe(`gcc${path}`, `https://gcc.luluhypermarket.com${path}`, browserCookie, { 'Accept': 'application/json' });
  }

  // ── Section 5: Mobile-specific JSON API ────────────────────
  console.log('\n═══ 5. MOBILE APP API ATTEMPTS ═══');
  // Akinon apps often hit a different API host or specific versioned endpoints
  const mobileHeaders = {
    'Accept': 'application/json',
    'X-Platform': 'android',
    'X-App-Version': '4.2.0',
    'X-Device-Type': 'mobile',
  };
  await probe('Android /api/search', 'https://gcc.luluhypermarket.com/api/search?q=milk', android, mobileHeaders);
  await probe('Android /api/v1/products', 'https://gcc.luluhypermarket.com/api/v1/products?search=milk', android, mobileHeaders);
  await probe('Android /api/catalog', 'https://gcc.luluhypermarket.com/api/catalog/search?q=milk', android, mobileHeaders);

  // POST-based search (some Akinon deployments use POST)
  console.log('\n═══ 6. POST-BASED SEARCH ═══');
  const postEndpoints = [
    'https://gcc.luluhypermarket.com/api/search',
    'https://gcc.luluhypermarket.com/api/v1/search',
    'https://gcc.luluhypermarket.com/graphql',
    'https://gcc.luluhypermarket.com/api/graphql',
  ];
  for (const url of postEndpoints) {
    try {
      const r = await android.post(url, { query: 'milk', q: 'milk', search: 'milk' }, {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      });
      const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      console.log(`POST ${url.replace('https://gcc.luluhypermarket.com', '')}: ${r.status} (${body.length} bytes)`);
      if (r.status === 200 && body.length > 10) {
        console.log(`   🟢 ${body.substring(0, 300)}`);
      }
    } catch (e: any) {
      console.log(`POST ${url.replace('https://gcc.luluhypermarket.com', '')}: ${e.code || e.message}`);
    }
  }

  // ── Section 7: Robots & Sitemap ────────────────────────────
  console.log('\n═══ 7. ROBOTS & SITEMAP ═══');
  const robotsResult = await probe('robots.txt', 'https://gcc.luluhypermarket.com/robots.txt', browser);
  if (robotsResult.status === 200 && robotsResult.bodyLength > 50) {
    // Look for sitemaps and disallowed paths (hints about API structure)
    const sitemaps = robotsResult.body.match(/Sitemap:\s*(.*)/gi) || [];
    const allows = robotsResult.body.match(/Allow:\s*(.*)/gi) || [];
    if (sitemaps.length > 0) console.log(`   Sitemaps: ${sitemaps.join(', ')}`);
    if (allows.length > 0) console.log(`   Allow rules: ${allows.slice(0, 10).join(', ')}`);
  }
  await probe('sitemap.xml', 'https://gcc.luluhypermarket.com/sitemap.xml', browser);

  // ── Section 8: Alternative GCC subdomains ──────────────────
  console.log('\n═══ 8. OTHER GCC REGIONS ═══');
  // Lulu operates across GCC — other regions may have different CF rules
  await probe('uae (gcc)', 'https://gcc.luluhypermarket.com/en-ae', browser);
  await probe('oman', 'https://gcc.luluhypermarket.com/en-om', browser);
  await probe('bahrain', 'https://gcc.luluhypermarket.com/en-bh', browser);
  await probe('kuwait', 'https://gcc.luluhypermarket.com/en-kw', browser);
  await probe('qatar', 'https://gcc.luluhypermarket.com/en-qa', browser);
  await probe('saudi', 'https://gcc.luluhypermarket.com/en-sa', browser);

  console.log('\n═══════════════════════════════════════════════');
  console.log('DONE. Look for 🟢 markers — those are accessible endpoints.');
  console.log('If ALL are 403/Cloudflare, the only options are:');
  console.log('  1. Playwright with stealth plugin (puppeteer-extra-plugin-stealth)');
  console.log('  2. Use a residential proxy service');
  console.log('  3. Skip Lulu and track other stores');
  console.log('═══════════════════════════════════════════════');
}

main().catch(console.error);
