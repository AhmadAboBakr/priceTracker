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
 * Seeds the database with stores, items, and item-store mappings.
 * Safe to run multiple times — uses INSERT OR IGNORE.
 */
async function seed(): Promise<void> {
  const db = await getDatabase();

  // ── Stores ──────────────────────────────────────────────────
  const stores = [
    { name: 'Lulu Hypermarket', url: 'https://gcc.luluhypermarket.com/en-ae', searchUrl: 'https://gcc.luluhypermarket.com/en-ae' },
    { name: 'Carrefour UAE', url: 'https://www.carrefouruae.com', searchUrl: 'https://www.carrefouruae.com/mafuae/en/search?keyword=' },
    { name: 'Union Coop', url: 'https://www.unioncoop.ae', searchUrl: 'https://www.unioncoop.ae/catalogsearch/result/?q=' },
  ];

  for (const s of stores) {
    db.run(
      `INSERT OR IGNORE INTO stores (name, url, search_url) VALUES (?, ?, ?)`,
      [s.name, s.url, s.searchUrl]
    );
  }
  logger.info('Seeded stores');

  // ── Items (50 common UAE grocery staples) ───────────────────
  const items: [string, string, string, string][] = [
    // Dairy & Eggs (10)
    ['Al Ain Fresh Milk Full Cream', 'Dairy & Eggs', 'L', '1L'],
    ['Al Rawabi Fresh Laban', 'Dairy & Eggs', 'L', '1L'],
    ['Lurpak Butter Unsalted', 'Dairy & Eggs', 'g', '200g'],
    ['Almarai Mozzarella Cheese', 'Dairy & Eggs', 'g', '200g'],
    ['Golden Eggs White', 'Dairy & Eggs', 'pack', '30 pack'],
    ['Activia Stirred Yoghurt Plain', 'Dairy & Eggs', 'g', '120g'],
    ['Puck Cream Cheese Spread', 'Dairy & Eggs', 'g', '500g'],
    ['Al Ain Cream Fresh', 'Dairy & Eggs', 'ml', '200ml'],
    ['Nido Fortified Milk Powder', 'Dairy & Eggs', 'g', '900g'],
    ['KDD Thick Cream', 'Dairy & Eggs', 'ml', '250ml'],

    // Bread & Bakery (5)
    ['Wooden Bakery White Sliced Bread', 'Bread & Bakery', 'g', '600g'],
    ['Wooden Bakery Brown Sliced Bread', 'Bread & Bakery', 'g', '600g'],
    ['Modern Arabic Bread White', 'Bread & Bakery', 'pack', '6 pack'],
    ['Samoli Bread White', 'Bread & Bakery', 'g', '300g'],
    ['Lusine Sandwich Bread', 'Bread & Bakery', 'g', '600g'],

    // Rice & Grains (5)
    ['India Gate Basmati Rice Classic', 'Rice & Grains', 'kg', '5kg'],
    ['Abu Kass Basmati Rice', 'Rice & Grains', 'kg', '2kg'],
    ['Sunwhite Calrose Rice', 'Rice & Grains', 'kg', '2kg'],
    ['Green Valley Red Lentils', 'Rice & Grains', 'g', '500g'],
    ['Quaker Oats', 'Rice & Grains', 'g', '500g'],

    // Cooking Oil & Condiments (5)
    ['Noor Sunflower Oil', 'Cooking Oil', 'L', '1.5L'],
    ['Rahma Olive Oil Extra Virgin', 'Cooking Oil', 'ml', '500ml'],
    ['Heinz Tomato Ketchup', 'Condiments', 'ml', '500ml'],
    ['Best Foods Mayonnaise', 'Condiments', 'ml', '473ml'],
    ['Maggi Chicken Stock Cubes', 'Condiments', 'pack', '24 pack'],

    // Protein — Chicken & Meat (5)
    ['Tanmiah Fresh Chicken Whole', 'Protein', 'kg', '1kg'],
    ['Al Kabeer Frozen Beef Burger', 'Protein', 'g', '500g'],
    ['Al Khazna Fresh Chicken Breast', 'Protein', 'kg', '1kg'],
    ['Sadia Frozen Chicken Nuggets', 'Protein', 'g', '500g'],
    ['Al Kabeer Beef Mince', 'Protein', 'g', '400g'],

    // Seafood (3)
    ['Al Kabeer Fish Fingers', 'Seafood', 'g', '300g'],
    ['Americana Frozen Shrimp', 'Seafood', 'g', '500g'],
    ['Sealect Tuna In Oil', 'Seafood', 'g', '185g'],

    // Canned & Packaged (5)
    ['California Garden Fava Beans', 'Canned Goods', 'g', '400g'],
    ['KDD Tomato Paste', 'Canned Goods', 'g', '135g'],
    ['Indomie Instant Noodles Special', 'Canned Goods', 'pack', '5 pack'],
    ['Barilla Spaghetti No 5', 'Pasta & Noodles', 'g', '500g'],
    ['Al Ain Canned Chickpeas', 'Canned Goods', 'g', '400g'],

    // Beverages (5)
    ['Masafi Water', 'Beverages', 'L', '1.5L'],
    ['Al Ain Water', 'Beverages', 'L', '1.5L'],
    ['Tang Orange Instant Drink', 'Beverages', 'g', '375g'],
    ['Lipton Yellow Label Tea', 'Beverages', 'pack', '100 bags'],
    ['Nescafe Classic Instant Coffee', 'Beverages', 'g', '200g'],

    // Frozen Vegetables (3)
    ['Al Kabeer Mixed Vegetables Frozen', 'Frozen', 'g', '450g'],
    ['Al Kabeer Frozen Green Peas', 'Frozen', 'g', '450g'],
    ['McCain French Fries', 'Frozen', 'g', '750g'],

    // Fresh Produce (2)
    ['White Onion', 'Fresh Produce', 'kg', '1kg'],
    ['Tomato', 'Fresh Produce', 'kg', '1kg'],

    // Household (2)
    ['Fairy Dishwashing Liquid Original', 'Household', 'ml', '750ml'],
    ['Persil Power Gel Detergent', 'Household', 'L', '1L'],
  ];

  for (const [name, category, unit, size] of items) {
    db.run(
      `INSERT OR IGNORE INTO items (name, category, unit, standard_size) VALUES (?, ?, ?, ?)`,
      [name, category, unit, size]
    );
  }
  logger.info({ count: items.length }, 'Seeded items');

  // ── Item-Store Mappings ─────────────────────────────────────
  const storeRows = queryAll(db, 'SELECT id, name FROM stores');
  const itemRows = queryAll(db, 'SELECT id, name FROM items');

  let mappingCount = 0;
  for (const item of itemRows) {
    for (const store of storeRows) {
      db.run(
        `INSERT OR IGNORE INTO item_store_mapping (item_id, store_id, search_query) VALUES (?, ?, ?)`,
        [item.id, store.id, item.name]
      );
      mappingCount++;
    }
  }
  logger.info({ count: mappingCount }, 'Seeded item-store mappings');

  saveDatabase(db);
  db.close();
  logger.info('Seed complete');
}

seed().catch((err) => {
  logger.error(err, 'Seed failed');
  process.exit(1);
});
