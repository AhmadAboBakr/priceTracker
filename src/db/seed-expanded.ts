import { getDatabase, saveDatabase } from './schema';
import { logger } from '../utils/logger';

/** Helper to query rows from sql.js */
function queryAll(db: any, sql: string): any[] {
  const stmt = db.prepare(sql);
  const rows: any[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

/**
 * Adds new stores (from the scraper probe results) and a broader set of
 * common UAE grocery items to the database.
 *
 * Safe to run multiple times — uses INSERT OR IGNORE.
 *
 * Usage:  npx ts-node src/db/seed-expanded.ts
 */
async function seedExpanded(): Promise<void> {
  const db = await getDatabase();

  // ── New Stores ────────────────────────────────────────────────
  // Store names must EXACTLY match the keys in src/scrapers/index.ts
  const newStores = [
    { name: 'Grandiose', url: 'https://www.grandiose.ae', searchUrl: 'https://www.grandiose.ae/catalogsearch/result/?q=' },
    { name: 'Noon Grocery', url: 'https://www.noon.com', searchUrl: 'https://www.noon.com/uae-en/search/?q=' },
    { name: 'Barakat', url: 'https://www.barakatfresh.ae', searchUrl: 'https://www.barakatfresh.ae/search?q=' },
    { name: 'Choithrams', url: 'https://www.choithrams.com', searchUrl: 'https://www.choithrams.com/search?q=' },
    { name: 'Spinneys', url: 'https://www.spinneys.com', searchUrl: 'https://www.spinneys.com/search?q=' },
    { name: 'West Zone', url: 'https://www.westzone.com', searchUrl: 'https://www.westzone.com/catalogsearch/result/?q=' },
  ];

  const existingStoreCount = queryAll(db, 'SELECT COUNT(*) as c FROM stores')[0].c;
  for (const s of newStores) {
    db.run(
      `INSERT OR IGNORE INTO stores (name, url, search_url) VALUES (?, ?, ?)`,
      [s.name, s.url, s.searchUrl]
    );
  }
  const storesAdded = queryAll(db, 'SELECT COUNT(*) as c FROM stores')[0].c - existingStoreCount;
  logger.info({ added: storesAdded, total: newStores.length }, 'Seeded new stores');

  // ── Expanded Items ────────────────────────────────────────────
  // [name, category, unit, standard_size]
  // These are common UAE grocery staples beyond the original 50 seed items.
  const items: [string, string, string, string][] = [

    // ─── Dairy & Eggs (expanded) ─────────────────────────────────
    ['Almarai Full Fat Milk', 'Dairy & Eggs', 'L', '1L'],
    ['Al Rawabi Full Fat Milk', 'Dairy & Eggs', 'L', '1L'],
    ['Al Ain Low Fat Milk', 'Dairy & Eggs', 'L', '1L'],
    ['Almarai Low Fat Milk', 'Dairy & Eggs', 'L', '1L'],
    ['Al Safi Danone Laban', 'Dairy & Eggs', 'L', '1L'],
    ['Lurpak Butter Salted', 'Dairy & Eggs', 'g', '200g'],
    ['President Butter Unsalted', 'Dairy & Eggs', 'g', '200g'],
    ['Almarai Halloumi Cheese', 'Dairy & Eggs', 'g', '225g'],
    ['Puck Sliced Cheese', 'Dairy & Eggs', 'g', '200g'],
    ['Kiri Spreadable Cream Cheese', 'Dairy & Eggs', 'g', '108g'],
    ['Al Ain Eggs White Large', 'Dairy & Eggs', 'pack', '15 pack'],
    ['Nadec Long Life Full Cream Milk', 'Dairy & Eggs', 'L', '1L'],
    ['Lacnor Essentials Full Cream Milk', 'Dairy & Eggs', 'L', '1L'],
    ['Rainbow Evaporated Milk', 'Dairy & Eggs', 'ml', '170ml'],
    ['Nestle Sweetened Condensed Milk', 'Dairy & Eggs', 'g', '397g'],
    ['Almarai Whipping Cream', 'Dairy & Eggs', 'ml', '500ml'],
    ['Al Ain Greek Style Yoghurt', 'Dairy & Eggs', 'g', '150g'],
    ['Almarai Feta Cheese', 'Dairy & Eggs', 'g', '400g'],
    ['Philadelphia Cream Cheese', 'Dairy & Eggs', 'g', '200g'],
    ['Laughing Cow Cheese Triangles', 'Dairy & Eggs', 'g', '120g'],

    // ─── Bread & Bakery (expanded) ──────────────────────────────
    ['Al Jadeed White Bread', 'Bread & Bakery', 'g', '600g'],
    ['Bimbo Tortilla Wraps', 'Bread & Bakery', 'pack', '8 pack'],
    ['Americana Croissant Plain', 'Bread & Bakery', 'g', '55g'],
    ['Jaffa Cake Bars', 'Bread & Bakery', 'pack', '12 pack'],
    ['Safia Arabic Bread Brown', 'Bread & Bakery', 'pack', '6 pack'],
    ['Mountain Bread Original', 'Bread & Bakery', 'pack', '5 pack'],
    ['Britannia Rusk Toast', 'Bread & Bakery', 'g', '610g'],

    // ─── Rice, Grains & Pulses ──────────────────────────────────
    ['India Gate Basmati Rice Premium', 'Rice & Grains', 'kg', '2kg'],
    ['Tilda Basmati Rice Pure', 'Rice & Grains', 'kg', '5kg'],
    ['Green Farms Sella Basmati', 'Rice & Grains', 'kg', '5kg'],
    ['Egyptian Rice', 'Rice & Grains', 'kg', '2kg'],
    ['Haldiram Moong Dal', 'Rice & Grains', 'g', '500g'],
    ['Green Valley Yellow Lentils', 'Rice & Grains', 'g', '500g'],
    ['Quaker White Oats', 'Rice & Grains', 'g', '500g'],
    ['Kel Kithna White Flour', 'Rice & Grains', 'kg', '2kg'],
    ['Samba Atta Chakki', 'Rice & Grains', 'kg', '5kg'],
    ['Green Valley Chickpeas Dried', 'Rice & Grains', 'g', '500g'],
    ['Bulgur Wheat', 'Rice & Grains', 'g', '500g'],

    // ─── Cooking Oil ────────────────────────────────────────────
    ['Al Arabi Vegetable Oil', 'Cooking Oil', 'L', '1.5L'],
    ['Mazola Corn Oil', 'Cooking Oil', 'L', '1.8L'],
    ['Noor Pure Sunflower Oil', 'Cooking Oil', 'L', '3L'],
    ['Rahma Extra Virgin Olive Oil', 'Cooking Oil', 'ml', '750ml'],
    ['Dalda Vegetable Ghee', 'Cooking Oil', 'kg', '1kg'],
    ['Saffola Gold Oil', 'Cooking Oil', 'L', '1L'],
    ['Coconut Oil Extra Virgin', 'Cooking Oil', 'ml', '500ml'],

    // ─── Condiments & Sauces ────────────────────────────────────
    ['Al Barakah Tahina', 'Condiments', 'g', '250g'],
    ['Dettol Antiseptic Disinfectant', 'Household', 'ml', '750ml'],
    ['Tabasco Original Hot Sauce', 'Condiments', 'ml', '60ml'],
    ['Heinz Yellow Mustard', 'Condiments', 'ml', '245ml'],
    ['Knorr Chicken Stock Cubes', 'Condiments', 'pack', '24 pack'],
    ['Nando Hot Peri Peri Sauce', 'Condiments', 'ml', '250ml'],
    ['Kraft Cheddar Cheese Spread', 'Condiments', 'g', '230g'],
    ['ABC Soy Sauce', 'Condiments', 'ml', '620ml'],
    ['Al Barakah Hummus', 'Condiments', 'g', '280g'],
    ['Heinz Baked Beans', 'Canned Goods', 'g', '415g'],
    ['Al Doha Tomato Paste', 'Canned Goods', 'g', '200g'],

    // ─── Sugar, Spices & Baking ─────────────────────────────────
    ['Al Khaleej White Sugar', 'Sugar & Spices', 'kg', '2kg'],
    ['Al Khaleej Brown Sugar', 'Sugar & Spices', 'g', '500g'],
    ['Eastern Turmeric Powder', 'Sugar & Spices', 'g', '200g'],
    ['Eastern Chilli Powder', 'Sugar & Spices', 'g', '200g'],
    ['Eastern Cumin Powder', 'Sugar & Spices', 'g', '200g'],
    ['Eastern Coriander Powder', 'Sugar & Spices', 'g', '200g'],
    ['Black Pepper Whole', 'Sugar & Spices', 'g', '100g'],
    ['Cinnamon Sticks', 'Sugar & Spices', 'g', '100g'],
    ['Green Cardamom', 'Sugar & Spices', 'g', '100g'],
    ['Royal Baking Powder', 'Sugar & Spices', 'g', '113g'],
    ['Doves Farm Self Raising Flour', 'Sugar & Spices', 'kg', '1kg'],
    ['Nestle Icing Sugar', 'Sugar & Spices', 'g', '500g'],

    // ─── Protein — Chicken ──────────────────────────────────────
    ['Al Ain Fresh Chicken Whole', 'Protein', 'kg', '1kg'],
    ['Al Watania Frozen Chicken Whole', 'Protein', 'kg', '1.2kg'],
    ['Sadia Frozen Whole Chicken', 'Protein', 'kg', '1kg'],
    ['Al Khazna Fresh Chicken Thighs', 'Protein', 'kg', '500g'],
    ['Tanmiah Fresh Chicken Drumsticks', 'Protein', 'kg', '500g'],

    // ─── Protein — Meat & Alternatives ──────────────────────────
    ['Australian Beef Tenderloin', 'Protein', 'kg', '1kg'],
    ['Pakistani Lamb Leg Bone In', 'Protein', 'kg', '1kg'],
    ['Al Kabeer Chicken Franks', 'Protein', 'g', '340g'],
    ['Freshly Minced Lamb', 'Protein', 'g', '500g'],
    ['Americana Chicken Popcorn', 'Protein', 'g', '400g'],

    // ─── Seafood ────────────────────────────────────────────────
    ['Fresh Hammour Fillet', 'Seafood', 'kg', '500g'],
    ['Fresh Salmon Fillet Norwegian', 'Seafood', 'kg', '500g'],
    ['Freshly Frozen Shrimp Peeled', 'Seafood', 'g', '500g'],
    ['Al Kabeer Breaded Fish Fingers', 'Seafood', 'g', '450g'],
    ['John West Tuna Chunks In Water', 'Seafood', 'g', '170g'],

    // ─── Canned & Packaged ──────────────────────────────────────
    ['Al Alali Canned Tuna In Oil', 'Canned Goods', 'g', '170g'],
    ['California Garden Hummus', 'Canned Goods', 'g', '400g'],
    ['Del Monte Canned Sweetcorn', 'Canned Goods', 'g', '340g'],
    ['Al Ain Canned Green Peas', 'Canned Goods', 'g', '400g'],
    ['Goody Macaroni', 'Pasta & Noodles', 'g', '450g'],
    ['Barilla Penne Rigate', 'Pasta & Noodles', 'g', '500g'],
    ['Maggi 2 Minute Noodles', 'Pasta & Noodles', 'pack', '5 pack'],
    ['Indomie Mi Goreng Fried Noodles', 'Pasta & Noodles', 'pack', '5 pack'],

    // ─── Beverages ──────────────────────────────────────────────
    ['Arwa Water', 'Beverages', 'L', '1.5L'],
    ['Vimto Cordial', 'Beverages', 'ml', '710ml'],
    ['Rani Orange Float Juice', 'Beverages', 'ml', '240ml'],
    ['Nescafe Gold Instant Coffee', 'Beverages', 'g', '100g'],
    ['Lipton Green Tea', 'Beverages', 'pack', '25 bags'],
    ['Ahmad English Tea', 'Beverages', 'pack', '100 bags'],
    ['Karak Chai', 'Beverages', 'pack', '25 bags'],
    ['Pepsi Can', 'Beverages', 'ml', '330ml'],
    ['Coca Cola Can', 'Beverages', 'ml', '330ml'],
    ['Red Bull Energy Drink', 'Beverages', 'ml', '250ml'],
    ['Barbican Malt Beverage', 'Beverages', 'ml', '330ml'],
    ['Lacnor Fresh Orange Juice', 'Beverages', 'L', '1L'],
    ['Al Ain Apple Juice', 'Beverages', 'ml', '500ml'],

    // ─── Fresh Produce ──────────────────────────────────────────
    ['Potato', 'Fresh Produce', 'kg', '1kg'],
    ['Cucumber', 'Fresh Produce', 'kg', '1kg'],
    ['Green Capsicum', 'Fresh Produce', 'kg', '1kg'],
    ['Lemon', 'Fresh Produce', 'kg', '1kg'],
    ['Banana', 'Fresh Produce', 'kg', '1kg'],
    ['Apple Red', 'Fresh Produce', 'kg', '1kg'],
    ['Orange', 'Fresh Produce', 'kg', '1kg'],
    ['Garlic', 'Fresh Produce', 'kg', '1kg'],
    ['Ginger', 'Fresh Produce', 'kg', '500g'],
    ['Carrot', 'Fresh Produce', 'kg', '1kg'],
    ['Fresh Coriander', 'Fresh Produce', 'bunch', '1 bunch'],
    ['Fresh Mint', 'Fresh Produce', 'bunch', '1 bunch'],
    ['Avocado', 'Fresh Produce', 'piece', '1 piece'],
    ['Mango', 'Fresh Produce', 'kg', '1kg'],
    ['Watermelon', 'Fresh Produce', 'kg', '1kg'],

    // ─── Frozen Foods ───────────────────────────────────────────
    ['McCain Smiles', 'Frozen', 'g', '450g'],
    ['Al Kabeer Chicken Samosa', 'Frozen', 'g', '240g'],
    ['Al Kabeer Vegetable Spring Rolls', 'Frozen', 'g', '300g'],
    ['Birds Eye Garden Peas', 'Frozen', 'g', '450g'],
    ['Baskin Robbins Ice Cream Vanilla', 'Frozen', 'L', '1L'],
    ['Kwality Walls Cornetto', 'Frozen', 'ml', '110ml'],
    ['Sadia Frozen Mixed Vegetables', 'Frozen', 'g', '450g'],

    // ─── Snacks & Sweets ────────────────────────────────────────
    ['Lay Chips Classic Salted', 'Snacks', 'g', '170g'],
    ['Doritos Nacho Cheese', 'Snacks', 'g', '180g'],
    ['Pringles Original', 'Snacks', 'g', '165g'],
    ['KitKat 4 Finger', 'Snacks', 'g', '41.5g'],
    ['Cadbury Dairy Milk', 'Snacks', 'g', '110g'],
    ['Galaxy Chocolate', 'Snacks', 'g', '90g'],
    ['Nutella Hazelnut Spread', 'Snacks', 'g', '350g'],
    ['Oreo Original Cookies', 'Snacks', 'g', '133g'],
    ['Britannia Digestive Biscuits', 'Snacks', 'g', '400g'],
    ['Ulker Tea Biscuit', 'Snacks', 'g', '165g'],
    ['Al Kazzi Mixed Nuts', 'Snacks', 'g', '300g'],
    ['Dates Medjool', 'Snacks', 'g', '500g'],
    ['Mars Bar', 'Snacks', 'g', '51g'],
    ['Twix Bar', 'Snacks', 'g', '50g'],

    // ─── Baby & Infant ──────────────────────────────────────────
    ['S-26 Gold Stage 1 Infant Formula', 'Baby', 'g', '400g'],
    ['Aptamil Stage 1', 'Baby', 'g', '400g'],
    ['Cerelac Wheat With Milk', 'Baby', 'g', '400g'],
    ['Pampers Baby Dry Size 4', 'Baby', 'pack', '44 pack'],
    ['Huggies Ultra Comfort Size 4', 'Baby', 'pack', '40 pack'],

    // ─── Household & Cleaning ───────────────────────────────────
    ['Persil Detergent Powder', 'Household', 'kg', '3kg'],
    ['Comfort Fabric Softener', 'Household', 'L', '2L'],
    ['Clorox Bleach Original', 'Household', 'L', '1.89L'],
    ['Harpic Toilet Cleaner', 'Household', 'ml', '750ml'],
    ['Finish Dishwasher Tablets', 'Household', 'pack', '30 pack'],
    ['Fine Toilet Paper', 'Household', 'pack', '12 rolls'],
    ['Fine Facial Tissues', 'Household', 'pack', '200 sheets'],
    ['Glad Cling Wrap', 'Household', 'm', '30m'],
    ['Bounty Paper Towels', 'Household', 'pack', '2 rolls'],
    ['Baygon Insect Killer Spray', 'Household', 'ml', '400ml'],
    ['Flash All Purpose Cleaner', 'Household', 'ml', '750ml'],

    // ─── Personal Care ──────────────────────────────────────────
    ['Colgate Triple Action Toothpaste', 'Personal Care', 'ml', '100ml'],
    ['Dettol Hand Wash Original', 'Personal Care', 'ml', '250ml'],
    ['Dove Soap Bar', 'Personal Care', 'g', '135g'],
    ['Head Shoulders Shampoo', 'Personal Care', 'ml', '400ml'],
    ['Nivea Body Lotion', 'Personal Care', 'ml', '400ml'],
  ];

  const existingItemCount = queryAll(db, 'SELECT COUNT(*) as c FROM items')[0].c;
  for (const [name, category, unit, size] of items) {
    db.run(
      `INSERT OR IGNORE INTO items (name, category, unit, standard_size) VALUES (?, ?, ?, ?)`,
      [name, category, unit, size]
    );
  }
  const itemsAdded = queryAll(db, 'SELECT COUNT(*) as c FROM items')[0].c - existingItemCount;
  logger.info({ added: itemsAdded, total: items.length }, 'Seeded expanded items');

  // ── Create Item-Store Mappings ─────────────────────────────────
  // Creates a mapping for every item × store combination that doesn't exist yet.
  // search_query defaults to item name (scrapers use this as the search term).
  const storeRows = queryAll(db, 'SELECT id, name FROM stores');
  const itemRows = queryAll(db, 'SELECT id, name FROM items');

  const existingMappingCount = queryAll(db, 'SELECT COUNT(*) as c FROM item_store_mapping')[0].c;
  for (const item of itemRows) {
    for (const store of storeRows) {
      db.run(
        `INSERT OR IGNORE INTO item_store_mapping (item_id, store_id, search_query) VALUES (?, ?, ?)`,
        [item.id, store.id, item.name]
      );
    }
  }
  const mappingsAdded = queryAll(db, 'SELECT COUNT(*) as c FROM item_store_mapping')[0].c - existingMappingCount;
  logger.info({ added: mappingsAdded }, 'Seeded item-store mappings');

  // ── Summary ───────────────────────────────────────────────────
  const totalStores = queryAll(db, 'SELECT COUNT(*) as c FROM stores')[0].c;
  const totalItems = queryAll(db, 'SELECT COUNT(*) as c FROM items')[0].c;
  const totalMappings = queryAll(db, 'SELECT COUNT(*) as c FROM item_store_mapping')[0].c;
  const categories = queryAll(db, 'SELECT DISTINCT category FROM items ORDER BY category');

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║        Seed Expanded — Summary           ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  Stores:     ${totalStores} (${storesAdded} new)`);
  console.log(`  Items:      ${totalItems} (${itemsAdded} new)`);
  console.log(`  Mappings:   ${totalMappings} (${mappingsAdded} new)`);
  console.log(`  Categories: ${categories.map((r: any) => r.category).join(', ')}`);
  console.log('');

  saveDatabase(db);
  db.close();
  logger.info('Expanded seed complete');
}

seedExpanded().catch((err) => {
  logger.error(err, 'Expanded seed failed');
  process.exit(1);
});
