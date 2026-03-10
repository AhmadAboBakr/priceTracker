/**
 * Diagnostic script: run locally to discover which UAE grocery stores
 * are accessible via HTTP and what API patterns they expose.
 *
 * Usage:  npx ts-node src/scrapers/probe-stores.ts
 */
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE_HEADERS = {
  'User-Agent': UA,
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

interface StoreProbe {
  name: string;
  baseUrl: string;
  searchUrl: string;
  /** Magento GraphQL endpoint (set if store is likely Magento 2) */
  graphqlUrl?: string;
  /** Any JSON API search endpoint to try */
  apiUrl?: string;
}

const STORES: StoreProbe[] = [
  {
    name: 'Choithrams',
    baseUrl: 'https://www.choithrams.com',
    searchUrl: 'https://www.choithrams.com/catalogsearch/result/?q=milk',
    graphqlUrl: 'https://www.choithrams.com/graphql',
  },
  {
    name: 'Spinneys',
    baseUrl: 'https://www.spinneys.com',
    searchUrl: 'https://www.spinneys.com/search?q=milk',
  },
  {
    name: 'Grandiose',
    baseUrl: 'https://www.grandiose.ae',
    searchUrl: 'https://www.grandiose.ae/catalogsearch/result/?q=milk',
    graphqlUrl: 'https://www.grandiose.ae/graphql',
  },
  {
    name: 'Kibsons',
    baseUrl: 'https://www.kibsons.com',
    searchUrl: 'https://www.kibsons.com/search?q=milk',
  },
  {
    name: 'VIVA Supermarket',
    baseUrl: 'https://www.vivasupermarket.com',
    searchUrl: 'https://www.vivasupermarket.com/catalogsearch/result/?q=milk',
    graphqlUrl: 'https://www.vivasupermarket.com/graphql',
  },
  {
    name: 'West Zone',
    baseUrl: 'https://www.westzone.com',
    searchUrl: 'https://www.westzone.com/catalogsearch/result/?q=milk',
    graphqlUrl: 'https://www.westzone.com/graphql',
  },
  {
    name: 'Noon Grocery',
    baseUrl: 'https://www.noon.com',
    searchUrl: 'https://www.noon.com/uae-en/search/?q=milk&category=grocery',
    apiUrl: 'https://www.noon.com/_svc/catalog/api/v3/u/search?q=milk&cat=grocery&limit=5&locale=en-AE',
  },
  {
    name: 'Al Madina',
    baseUrl: 'https://www.almadinauae.com',
    searchUrl: 'https://www.almadinauae.com/catalogsearch/result/?q=milk',
    graphqlUrl: 'https://www.almadinauae.com/graphql',
  },
  {
    name: 'Barakat',
    baseUrl: 'https://www.barakatfresh.ae',
    searchUrl: 'https://www.barakatfresh.ae/search?q=milk',
  },
];

async function probeHomepage(store: StoreProbe) {
  const jar = new CookieJar();
  const http = wrapper(
    axios.create({ headers: BASE_HEADERS, timeout: 15000, maxRedirects: 10, jar, withCredentials: true })
  );

  try {
    const r = await http.get(store.baseUrl);
    const body = String(r.data);
    const server = r.headers['server'] || 'unknown';
    const powered = r.headers['x-powered-by'] || '';
    const isMagento =
      body.includes('Magento') ||
      body.includes('mage-') ||
      body.includes('catalogsearch') ||
      body.includes('requirejs-config');
    const isNextJs = body.includes('__NEXT_DATA__') || body.includes('_next/');
    const isCloudflare = server.toLowerCase().includes('cloudflare');

    console.log(`\n✅ ${store.name}: ${r.status} (${body.length} bytes)`);
    console.log(`   Server: ${server} | X-Powered-By: ${powered || 'none'}`);
    console.log(`   Magento: ${isMagento} | Next.js: ${isNextJs} | Cloudflare: ${isCloudflare}`);

    return { http, accessible: true, isMagento, isNextJs, isCloudflare, bodyLength: body.length };
  } catch (e: any) {
    const status = e.response?.status || e.code || e.message;
    const server = e.response?.headers?.['server'] || '';
    console.log(`\n❌ ${store.name}: ${status} (server: ${server})`);
    return { http, accessible: false, isMagento: false, isNextJs: false, isCloudflare: server.toLowerCase().includes('cloudflare'), bodyLength: 0 };
  }
}

async function probeGraphQL(store: StoreProbe, http: any) {
  if (!store.graphqlUrl) return;
  try {
    const r = await http.post(
      store.graphqlUrl,
      {
        query: `{ products(search: "milk", pageSize: 3) { items { name sku price_range { minimum_price { final_price { value currency } } } } } }`,
      },
      {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Store': 'default' },
        timeout: 10000,
      }
    );
    const data = r.data;
    const items = data?.data?.products?.items;
    if (Array.isArray(items) && items.length > 0) {
      console.log(`   🟢 GraphQL WORKS! Found ${items.length} products:`);
      for (const item of items.slice(0, 3)) {
        const price = item.price_range?.minimum_price?.final_price?.value;
        const currency = item.price_range?.minimum_price?.final_price?.currency;
        console.log(`      - ${item.name}: ${currency} ${price}`);
      }
    } else {
      console.log(`   🟡 GraphQL responded but no products: ${JSON.stringify(data).substring(0, 200)}`);
    }
  } catch (e: any) {
    console.log(`   🔴 GraphQL failed: ${e.response?.status || e.message}`);
  }
}

async function probeSearch(store: StoreProbe, http: any) {
  try {
    const r = await http.get(store.searchUrl, { headers: { 'Referer': store.baseUrl } });
    const body = String(r.data);

    // Check for AED prices
    const aedMatches = body.match(/(?:AED|aed|د\.إ)\s*[\d,.]+/g) || [];

    // Check for JSON product data
    const hasLdJson = body.includes('application/ld+json');
    const hasProductItems = body.includes('product-item') || body.includes('product-card');
    const priceEscaped = (body.match(/\\"price\\":\s*[\d.]+/g) || []).length;

    console.log(`   Search page: ${r.status} (${body.length} bytes)`);
    console.log(`   AED prices found: ${aedMatches.length} | LD+JSON: ${hasLdJson} | Product items: ${hasProductItems} | Escaped prices: ${priceEscaped}`);
    if (aedMatches.length > 0) {
      console.log(`   Sample prices: ${aedMatches.slice(0, 5).join(', ')}`);
    }
  } catch (e: any) {
    console.log(`   Search failed: ${e.response?.status || e.message}`);
  }
}

async function probeApi(store: StoreProbe, http: any) {
  if (!store.apiUrl) return;
  try {
    const r = await http.get(store.apiUrl, {
      headers: { 'Accept': 'application/json', 'Referer': store.baseUrl },
    });
    const data = r.data;
    const json = typeof data === 'string' ? data : JSON.stringify(data);
    console.log(`   🟢 API responded: ${json.substring(0, 300)}`);
  } catch (e: any) {
    console.log(`   🔴 API failed: ${e.response?.status || e.message}`);
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   UAE Grocery Store Probe Diagnostics    ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`Running at ${new Date().toISOString()}\n`);

  for (const store of STORES) {
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`PROBING: ${store.name} (${store.baseUrl})`);
    console.log('═'.repeat(50));

    const { http, accessible, isMagento } = await probeHomepage(store);

    if (accessible) {
      if (store.graphqlUrl) {
        await probeGraphQL(store, http);
      }
      await probeSearch(store, http);
      if (store.apiUrl) {
        await probeApi(store, http);
      }
    }
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log('DONE. Use results above to determine which stores to enable.');
  console.log('Stores with 🟢 GraphQL can use the Union Coop pattern.');
  console.log('Stores with AED prices in search can use HTML parsing.');
  console.log('═'.repeat(50));
}

main().catch(console.error);
