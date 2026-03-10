// ── Store config ────────────────────────────────────
const STORE_COLORS = {};
const STORE_NAMES = {};
const STORE_CSS = {};

const COLOR_PALETTE = [
  '#FF6B35', '#004B87', '#00B050', '#8B5CF6', '#EC4899',
  '#F59E0B', '#06B6D4', '#EF4444', '#6366F1', '#84CC16',
];
const CSS_CLASSES = [
  'lulu', 'carrefour', 'coop', 'store4', 'store5',
  'store6', 'store7', 'store8', 'store9', 'store10',
];

let stores = [];
let items = [];
let basketChart = null;
let itemChart = null;
let currentDays = 30;
let currentCategory = 'all';

// ── Init ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadStores();
  await Promise.all([loadItems(), loadBasketChart()]);
  setupEventListeners();
});

// ── Fetch stores and build color maps ───────────────
async function loadStores() {
  try {
    const res = await fetch('/api/stores');
    stores = await res.json();

    stores.forEach((s, i) => {
      STORE_COLORS[s.id] = COLOR_PALETTE[i % COLOR_PALETTE.length];
      STORE_NAMES[s.id] = s.name;
      STORE_CSS[s.id] = CSS_CLASSES[i % CSS_CLASSES.length];
    });
  } catch (err) {
    console.error('Failed to load stores:', err);
  }
}

// ── Compute and render inflation stats ──────────────
function renderStats() {
  const row = document.getElementById('statsRow');
  if (!items || items.length === 0) {
    row.innerHTML = '';
    return;
  }

  // Gather per-store stats
  let totalUp = 0, totalDown = 0, totalFlat = 0, totalOOS = 0;
  const allChanges = [];
  const perStore = {}; // { storeId: { changes: [], up, down, flat, oos, priced } }

  for (const store of stores) {
    perStore[store.id] = { changes: [], up: 0, down: 0, flat: 0, oos: 0, priced: 0 };
  }

  for (const item of items) {
    for (const store of stores) {
      const priceData = item.prices[store.id];
      const change = item.changes[store.id];
      const ps = perStore[store.id];

      if (priceData && priceData.price === -1) {
        totalOOS++;
        ps.oos++;
        continue;
      }
      if (!priceData) continue;

      ps.priced++;

      if (change !== null && change !== undefined) {
        allChanges.push(change);
        ps.changes.push(change);
        if (change > 0) { totalUp++; ps.up++; }
        else if (change < 0) { totalDown++; ps.down++; }
        else { totalFlat++; ps.flat++; }
      }
    }
  }

  const avgChange = allChanges.length > 0
    ? (allChanges.reduce((a, b) => a + b, 0) / allChanges.length)
    : 0;

  const inflationDir = avgChange > 0.1 ? 'up' : avgChange < -0.1 ? 'down' : 'flat';
  const inflationColor = inflationDir === 'up' ? 'var(--negative)' : inflationDir === 'down' ? 'var(--positive)' : 'var(--text-secondary)';
  const inflationArrow = inflationDir === 'up' ? '&#9650;' : inflationDir === 'down' ? '&#9660;' : '&#8722;';

  let html = '';

  // Card 1: Overall average price change
  html += `
    <div class="stat-card">
      <div class="stat-label">Overall Inflation</div>
      <div class="stat-value" style="color:${inflationColor}">${inflationArrow} ${Math.abs(avgChange).toFixed(1)}%</div>
      <div class="stat-sub">avg across all stores</div>
    </div>`;

  // Per-store inflation cards
  for (const store of stores) {
    const ps = perStore[store.id];
    const storeAvg = ps.changes.length > 0
      ? (ps.changes.reduce((a, b) => a + b, 0) / ps.changes.length)
      : null;

    const color = STORE_COLORS[store.id];
    const css = STORE_CSS[store.id];

    if (storeAvg !== null) {
      const dir = storeAvg > 0.1 ? 'up' : storeAvg < -0.1 ? 'down' : 'flat';
      const sColor = dir === 'up' ? 'var(--negative)' : dir === 'down' ? 'var(--positive)' : 'var(--text-secondary)';
      const sArrow = dir === 'up' ? '&#9650;' : dir === 'down' ? '&#9660;' : '&#8722;';

      let subParts = [];
      if (ps.up > 0) subParts.push(`${ps.up} up`);
      if (ps.down > 0) subParts.push(`${ps.down} down`);
      if (ps.flat > 0) subParts.push(`${ps.flat} flat`);
      if (ps.oos > 0) subParts.push(`${ps.oos} OOS`);

      html += `
        <div class="stat-card" style="border-top: 3px solid ${color}">
          <div class="stat-label"><span class="store-dot ${css}"></span> ${store.name}</div>
          <div class="stat-value" style="color:${sColor}">${sArrow} ${Math.abs(storeAvg).toFixed(1)}%</div>
          <div class="stat-sub">${subParts.join(' · ')}</div>
        </div>`;
    } else {
      // No change data yet — show priced count or OOS
      let sub = '';
      if (ps.priced > 0) sub = `${ps.priced} items priced`;
      else if (ps.oos > 0) sub = `${ps.oos} out of stock`;
      else sub = 'no data yet';

      html += `
        <div class="stat-card" style="border-top: 3px solid ${color}">
          <div class="stat-label"><span class="store-dot ${css}"></span> ${store.name}</div>
          <div class="stat-value" style="color:var(--text-secondary)">&#8722;</div>
          <div class="stat-sub">${sub}</div>
        </div>`;
    }
  }

  // Items tracked card
  html += `
    <div class="stat-card">
      <div class="stat-label">Items Tracked</div>
      <div class="stat-value">${items.length}</div>
      <div class="stat-sub">across ${stores.length} store${stores.length !== 1 ? 's' : ''}</div>
    </div>`;

  // Price movement breakdown
  html += `
    <div class="stat-card">
      <div class="stat-label">Price Movements</div>
      <div class="stat-value" style="font-size:1.1rem">
        <span style="color:var(--negative)">&#9650; ${totalUp}</span> &nbsp;
        <span style="color:var(--positive)">&#9660; ${totalDown}</span> &nbsp;
        <span style="color:var(--text-secondary)">&#8722; ${totalFlat}</span>
      </div>
      <div class="stat-sub">up / down / unchanged</div>
    </div>`;

  // Out of stock count (only if > 0)
  if (totalOOS > 0) {
    html += `
      <div class="stat-card">
        <div class="stat-label">Out of Stock</div>
        <div class="stat-value" style="color:var(--negative)">${totalOOS}</div>
        <div class="stat-sub">item–store combinations</div>
      </div>`;
  }

  row.innerHTML = html;
}

// ── Load items grid ─────────────────────────────────
async function loadItems() {
  try {
    const res = await fetch('/api/items');
    items = await res.json();
    renderItems();
    renderStats();
    populateCategoryFilter();
  } catch (err) {
    console.error('Failed to load items:', err);
    document.getElementById('itemsGrid').innerHTML =
      '<p class="loading">Failed to load items.</p>';
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
    grid.innerHTML = '<p class="loading">No items found. <a href="/manage-items.html">Add items</a> and <a href="/add-prices.html">enter prices</a> to get started.</p>';
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

          // Handle -1 = out of stock
          if (priceData.price === -1) {
            return `<div class="price-row">
              <span><span class="store-dot ${css}"></span>${STORE_NAMES[store.id]}</span>
              <span class="no-data" style="color:#dc2626">Out of Stock</span>
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
  select.innerHTML =
    '<option value="all">All Categories</option>' +
    categories.map((c) => `<option value="${c}">${c}</option>`).join('');
}

// ── Average price trend chart ───────────────────────
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
            text: 'Add prices to see trends',
          },
        },
      },
    });
    return;
  }

  const labels = data.map((d) => d.date);

  // Build raw avg arrays per store, treating 0 as null
  const rawAvgs = {};
  const basePrice = {}; // first valid avg per store (for normalization)
  for (const store of stores) {
    rawAvgs[store.id] = data.map((d) => {
      const v = d.avgs[store.id];
      return (v && v > 0) ? v : null; // ignore zero and missing
    });
    // Find first non-null value as the baseline
    basePrice[store.id] = rawAvgs[store.id].find((v) => v !== null) || null;
  }

  // Normalize: first entry = 100, subsequent = (avg / base) * 100
  const datasets = stores.map((store) => ({
    label: store.name,
    data: rawAvgs[store.id].map((v) => {
      if (v === null || basePrice[store.id] === null) return null;
      return parseFloat(((v / basePrice[store.id]) * 100).toFixed(2));
    }),
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
            label: (tooltipCtx) => {
              const storeId = stores[tooltipCtx.datasetIndex]?.id;
              const date = labels[tooltipCtx.dataIndex];
              const entry = data.find((d) => d.date === date);
              const count = entry?.itemCount?.[storeId] || '?';
              const actualAvg = rawAvgs[storeId]?.[tooltipCtx.dataIndex];
              const idx = tooltipCtx.parsed.y;
              if (actualAvg != null && idx != null) {
                return `${tooltipCtx.dataset.label}: ${idx.toFixed(1)} (AED ${actualAvg.toFixed(2)} avg, ${count} items)`;
              }
              return `${tooltipCtx.dataset.label}: --`;
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: false,
          title: { display: true, text: 'Price Index (first entry = 100)' },
          ticks: {
            callback: (val) => val.toFixed(0),
          },
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
    data: data.map((d) => {
      const p = d.prices[store.id];
      return (p != null && p !== -1) ? p : null;
    }),
    borderColor: STORE_COLORS[store.id],
    backgroundColor: STORE_COLORS[store.id] + '20',
    borderWidth: 2,
    tension: 0.3,
    fill: false,
    spanGaps: true,
    pointRadius: 4,
    pointHoverRadius: 7,
  }));

  // Track which dates have OOS for tooltip
  const oosMap = {};
  data.forEach((d) => {
    stores.forEach((store) => {
      if (d.prices[store.id] === -1) {
        if (!oosMap[d.date]) oosMap[d.date] = {};
        oosMap[d.date][store.id] = true;
      }
    });
  });

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
            label: (tooltipCtx) => {
              const storeId = stores[tooltipCtx.datasetIndex]?.id;
              const date = labels[tooltipCtx.dataIndex];
              if (oosMap[date] && oosMap[date][storeId]) {
                return `${tooltipCtx.dataset.label}: Out of Stock`;
              }
              return `${tooltipCtx.dataset.label}: AED ${tooltipCtx.parsed.y?.toFixed(2) || '--'}`;
            },
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

  // Show min/max info (exclude -1 from stats)
  let infoText = '';
  for (const store of stores) {
    const prices = data
      .map((d) => d.prices[store.id])
      .filter((p) => p !== null && p !== undefined && p !== -1);
    if (prices.length > 0) {
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const latest = prices[prices.length - 1];
      infoText += `${store.name}: AED ${latest.toFixed(2)} (range: ${min.toFixed(2)} – ${max.toFixed(2)}) | `;
    } else {
      const allEntries = data.map((d) => d.prices[store.id]).filter((p) => p != null);
      if (allEntries.length > 0 && allEntries.every((p) => p === -1)) {
        infoText += `${store.name}: Out of Stock | `;
      }
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

  // Anomaly buttons
  document.getElementById('anomalyBtn').addEventListener('click', handleAnomalyRemoval);
  document.getElementById('viewAnomalyBtn').addEventListener('click', handleViewAnomalies);
  document.getElementById('anomalyModalClose').addEventListener('click', closeAnomalyModal);
  document.getElementById('anomalyOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeAnomalyModal();
  });
}

// ── Anomaly Detection ─────────────────────────────────
const ANOMALY_DEVIATION = 20;

async function handleAnomalyRemoval() {
  const btn = document.getElementById('anomalyBtn');
  btn.disabled = true;
  btn.textContent = 'Scanning...';

  try {
    const previewRes = await fetch(`/api/anomalies?deviation=${ANOMALY_DEVIATION}`);
    const preview = await previewRes.json();

    if (preview.count === 0) {
      alert(`No anomalies detected. All prices are within ${ANOMALY_DEVIATION}% of the median.`);
      btn.textContent = 'Remove Anomalies';
      btn.disabled = false;
      return;
    }

    const lines = preview.anomalies.map(
      (a) => `${a.itemName} @ ${a.storeName}: AED ${a.price.toFixed(2)} (avg: AED ${a.trimmedMean.toFixed(2)})`
    );
    const msg = `Found ${preview.count} anomalous price(s) (>${ANOMALY_DEVIATION}% from median):\n\n` +
      lines.slice(0, 20).join('\n') +
      (lines.length > 20 ? `\n... and ${lines.length - 20} more` : '') +
      '\n\nRemove these prices?';

    if (!confirm(msg)) {
      btn.textContent = 'Remove Anomalies';
      btn.disabled = false;
      return;
    }

    btn.textContent = 'Removing...';
    const delRes = await fetch(`/api/anomalies?deviation=${ANOMALY_DEVIATION}`, { method: 'DELETE' });
    const delResult = await delRes.json();

    alert(`Removed ${delResult.removed} anomalous price(s).`);
    await Promise.all([loadItems(), loadBasketChart()]);
  } catch (err) {
    console.error('Anomaly removal failed:', err);
    alert('Failed to process anomalies. Check console for details.');
  } finally {
    btn.textContent = 'Remove Anomalies';
    btn.disabled = false;
  }
}

// ── View Anomalies List ───────────────────────────────
async function handleViewAnomalies() {
  const btn = document.getElementById('viewAnomalyBtn');
  btn.disabled = true;
  btn.textContent = 'Loading...';

  try {
    const res = await fetch(`/api/anomalies?deviation=${ANOMALY_DEVIATION}`);
    const data = await res.json();

    const listEl = document.getElementById('anomalyList');

    if (data.count === 0) {
      listEl.innerHTML = `<p style="text-align:center;color:var(--text-secondary);padding:32px">No anomalies found. All prices are within ${ANOMALY_DEVIATION}% of the median.</p>`;
      document.getElementById('anomalyOverlay').style.display = 'flex';
      return;
    }

    // Group anomalies by item
    const byItem = {};
    for (const a of data.anomalies) {
      if (!byItem[a.itemName]) byItem[a.itemName] = [];
      byItem[a.itemName].push(a);
    }

    let html = `<p style="margin-bottom:16px;color:var(--text-secondary);font-size:0.85rem">${data.count} anomalous price(s) found across ${Object.keys(byItem).length} item(s). Prices highlighted in red deviate more than ${ANOMALY_DEVIATION}% from the median (shown in gray).</p>`;
    html += '<div style="display:flex;flex-direction:column;gap:12px">';

    for (const [itemName, anomalies] of Object.entries(byItem)) {
      const itemAnomalies = anomalies;
      const trimmedMean = itemAnomalies[0].trimmedMean;

      // Get all store prices for this item from the loaded items data
      const itemData = items.find((i) => i.name === itemName);
      let allPricesHtml = '';

      if (itemData) {
        allPricesHtml = stores.map((store) => {
          const priceData = itemData.prices[store.id];
          if (!priceData || priceData.price <= 0) return '';

          const css = STORE_CSS[store.id];
          const isAnomaly = itemAnomalies.some((a) => a.storeId === store.id);
          const deviationPct = ((Math.abs(priceData.price - trimmedMean) / trimmedMean) * 100).toFixed(1);

          const style = isAnomaly
            ? 'background:rgba(220,38,38,0.1);border:1px solid rgba(220,38,38,0.3);border-radius:6px;padding:4px 8px'
            : 'padding:4px 8px';

          return `<div style="display:flex;justify-content:space-between;align-items:center;font-size:0.85rem;${style}">
            <span><span class="store-dot ${css}"></span>${STORE_NAMES[store.id]}</span>
            <span>
              <span style="font-weight:600;${isAnomaly ? 'color:var(--negative)' : ''}">AED ${priceData.price.toFixed(2)}</span>
              ${isAnomaly ? `<span style="font-size:0.75rem;color:var(--negative);margin-left:6px">(${deviationPct}% off)</span>` : ''}
            </span>
          </div>`;
        }).filter(Boolean).join('');
      }

      html += `<div style="background:var(--card-bg);border-radius:var(--radius);padding:14px;box-shadow:var(--shadow);border-left:4px solid var(--negative)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span style="font-weight:600;font-size:0.95rem">${itemName}</span>
          <span style="font-size:0.75rem;color:var(--text-secondary);background:var(--bg);padding:2px 8px;border-radius:4px">Median: AED ${trimmedMean.toFixed(2)}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">${allPricesHtml}</div>
      </div>`;
    }

    html += '</div>';
    listEl.innerHTML = html;
    document.getElementById('anomalyOverlay').style.display = 'flex';
  } catch (err) {
    console.error('Failed to load anomalies:', err);
    alert('Failed to load anomalies. Check console for details.');
  } finally {
    btn.textContent = 'View Anomalies';
    btn.disabled = false;
  }
}

function closeAnomalyModal() {
  document.getElementById('anomalyOverlay').style.display = 'none';
}
