// ── Store config ────────────────────────────────────
const STORE_COLORS = {};
const STORE_NAMES = {};
const STORE_CSS = {};

// These get populated once we fetch stores
let stores = [];
let items = [];
let basketChart = null;
let itemChart = null;
let currentDays = 30;
let currentCategory = 'all';

// ── Init ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadStores();
  await Promise.all([loadItems(), loadBasketChart(), loadStats()]);
  setupEventListeners();
});

// ── Fetch stores and build color maps ───────────────
async function loadStores() {
  try {
    const res = await fetch('/api/stores');
    stores = await res.json();

    const colors = ['#FF6B35', '#004B87', '#00B050'];
    const cssClasses = ['lulu', 'carrefour', 'coop'];

    stores.forEach((s, i) => {
      STORE_COLORS[s.id] = colors[i] || '#888';
      STORE_NAMES[s.id] = s.name;
      STORE_CSS[s.id] = cssClasses[i] || 'lulu';
    });
  } catch (err) {
    console.error('Failed to load stores:', err);
  }
}

// ── Load stats summary cards ────────────────────────
async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const stats = await res.json();

    if (stats.length === 0) {
      document.getElementById('statLuluVal').textContent = 'No data';
      document.getElementById('statCarrefourVal').textContent = 'No data';
      document.getElementById('statCoopVal').textContent = 'No data';
      document.getElementById('statCheapestVal').textContent = '--';
      return;
    }

    let cheapest = null;
    for (const stat of stats) {
      const name = (stat.store_name || '').toLowerCase();
      if (name.includes('lulu')) {
        document.getElementById('statLuluVal').textContent =
          stat.basket_total?.toFixed(2) || '--';
      } else if (name.includes('carrefour')) {
        document.getElementById('statCarrefourVal').textContent =
          stat.basket_total?.toFixed(2) || '--';
      } else if (name.includes('coop') || name.includes('union')) {
        document.getElementById('statCoopVal').textContent =
          stat.basket_total?.toFixed(2) || '--';
      }

      if (
        stat.basket_total &&
        (!cheapest || stat.basket_total < cheapest.basket_total)
      ) {
        cheapest = stat;
      }
    }

    if (cheapest) {
      document.getElementById('statCheapestVal').textContent =
        cheapest.basket_total.toFixed(2);
      document.getElementById('statCheapestSub').textContent =
        `${cheapest.store_name} (${cheapest.items_tracked} items)`;
    }
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// ── Load items grid ─────────────────────────────────
async function loadItems() {
  try {
    const res = await fetch('/api/items');
    items = await res.json();
    renderItems();
    populateCategoryFilter();
  } catch (err) {
    console.error('Failed to load items:', err);
    document.getElementById('itemsGrid').innerHTML =
      '<p class="loading">Failed to load items. Is the database seeded?</p>';
  }
}

function renderItems() {
  const grid = document.getElementById('itemsGrid');
  const filtered =
    currentCategory === 'all'
      ? items
      : items.filter((i) => i.category === currentCategory);

  document.getElementById('itemCount').textContent = `${filtered.length} items`;

  if (filtered.length === 0) {
    grid.innerHTML = '<p class="loading">No items found. Run the scraper first: <code>npm run scrape</code></p>';
    return;
  }

  grid.innerHTML = filtered
    .map((item) => {
      const priceRows = stores
        .map((store) => {
          const priceData = item.prices[store.id];
          const change = item.changes[store.id];
          const css = STORE_CSS[store.id];

          if (!priceData) {
            return `<div class="price-row">
              <span><span class="store-dot ${css}"></span>${STORE_NAMES[store.id]}</span>
              <span class="no-data">No data</span>
            </div>`;
          }

          let changeHtml = '';
          if (change !== null && change !== undefined) {
            const cls = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
            const arrow = change > 0 ? '&#9650;' : change < 0 ? '&#9660;' : '&#8722;';
            changeHtml = `<span class="price-change ${cls}">${arrow} ${Math.abs(change)}%</span>`;
          }

          return `<div class="price-row">
            <span><span class="store-dot ${css}"></span>${STORE_NAMES[store.id]}</span>
            <span>
              <span class="price-value">AED ${priceData.price.toFixed(2)}</span>
              ${changeHtml}
            </span>
          </div>`;
        })
        .join('');

      return `<div class="item-card" data-category="${item.category}" data-item-id="${item.id}" onclick="showItemDetail(${item.id})">
        <div class="item-name">${item.name}</div>
        <div class="item-meta">${item.category} &middot; ${item.standardSize}</div>
        <div class="price-rows">${priceRows}</div>
      </div>`;
    })
    .join('');
}

function populateCategoryFilter() {
  const categories = [...new Set(items.map((i) => i.category))].sort();
  const select = document.getElementById('categoryFilter');
  // Keep "all" option, add categories
  select.innerHTML =
    '<option value="all">All Categories</option>' +
    categories.map((c) => `<option value="${c}">${c}</option>`).join('');
}

// ── Basket trend chart ──────────────────────────────
async function loadBasketChart() {
  try {
    const res = await fetch(`/api/basket?days=${currentDays}`);
    const data = await res.json();
    renderBasketChart(data);
  } catch (err) {
    console.error('Failed to load basket chart:', err);
  }
}

function renderBasketChart(data) {
  const ctx = document.getElementById('basketChart').getContext('2d');
  if (basketChart) basketChart.destroy();

  if (data.length === 0) {
    basketChart = new Chart(ctx, {
      type: 'line',
      data: { labels: ['No data yet'], datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: 'Run the scraper to see data: npm run scrape',
          },
        },
      },
    });
    return;
  }

  const labels = data.map((d) => d.date);
  const datasets = stores.map((store) => ({
    label: store.name,
    data: data.map((d) => d.totals[store.id] || null),
    borderColor: STORE_COLORS[store.id],
    backgroundColor: STORE_COLORS[store.id] + '20',
    borderWidth: 2,
    tension: 0.3,
    fill: false,
    spanGaps: true,
    pointRadius: 3,
    pointHoverRadius: 6,
  }));

  basketChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true } },
        tooltip: {
          callbacks: {
            label: (ctx) =>
              `${ctx.dataset.label}: AED ${ctx.parsed.y?.toFixed(2) || '--'}`,
          },
        },
      },
      scales: {
        y: {
          beginAtZero: false,
          title: { display: true, text: 'Total Basket (AED)' },
        },
        x: {
          title: { display: true, text: 'Date' },
        },
      },
    },
  });
}

// ── Item detail modal ───────────────────────────────
async function showItemDetail(itemId) {
  const item = items.find((i) => i.id === itemId);
  if (!item) return;

  document.getElementById('modalTitle').textContent =
    `${item.name} (${item.standardSize})`;
  document.getElementById('modalOverlay').style.display = 'flex';

  try {
    const res = await fetch(`/api/items/${itemId}/history?days=${currentDays}`);
    const data = await res.json();
    renderItemChart(data, item);
  } catch (err) {
    console.error('Failed to load item history:', err);
  }
}

function renderItemChart(data, item) {
  const ctx = document.getElementById('itemChart').getContext('2d');
  if (itemChart) itemChart.destroy();

  if (data.length === 0) {
    document.getElementById('modalInfo').textContent =
      'No price history available for this item yet.';
    itemChart = new Chart(ctx, {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: { responsive: true, maintainAspectRatio: false },
    });
    return;
  }

  const labels = data.map((d) => d.date);
  const datasets = stores.map((store) => ({
    label: store.name,
    data: data.map((d) => d.prices[store.id] || null),
    borderColor: STORE_COLORS[store.id],
    backgroundColor: STORE_COLORS[store.id] + '20',
    borderWidth: 2,
    tension: 0.3,
    fill: false,
    spanGaps: true,
    pointRadius: 4,
    pointHoverRadius: 7,
  }));

  itemChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true } },
        tooltip: {
          callbacks: {
            label: (ctx) =>
              `${ctx.dataset.label}: AED ${ctx.parsed.y?.toFixed(2) || '--'}`,
          },
        },
      },
      scales: {
        y: {
          beginAtZero: false,
          title: { display: true, text: 'Price (AED)' },
        },
        x: { title: { display: true, text: 'Date' } },
      },
    },
  });

  // Show min/max info
  let infoText = '';
  for (const store of stores) {
    const prices = data
      .map((d) => d.prices[store.id])
      .filter((p) => p !== null && p !== undefined);
    if (prices.length > 0) {
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const latest = prices[prices.length - 1];
      infoText += `${store.name}: AED ${latest.toFixed(2)} (range: ${min.toFixed(2)} – ${max.toFixed(2)}) | `;
    }
  }
  document.getElementById('modalInfo').textContent = infoText.slice(0, -3);
}

function closeModal() {
  document.getElementById('modalOverlay').style.display = 'none';
  if (itemChart) {
    itemChart.destroy();
    itemChart = null;
  }
}

// ── Event Listeners ─────────────────────────────────
function setupEventListeners() {
  document.getElementById('daysFilter').addEventListener('change', (e) => {
    currentDays = parseInt(e.target.value, 10);
    loadBasketChart();
  });

  document.getElementById('categoryFilter').addEventListener('change', (e) => {
    currentCategory = e.target.value;
    renderItems();
  });

  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}
