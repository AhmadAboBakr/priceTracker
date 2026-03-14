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
let currentItemId = null;

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

  currentItemId = itemId;
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
  currentItemId = null;
  if (itemChart) {
    itemChart.destroy();
    itemChart = null;
  }
}

async function deleteCurrentItem() {
  if (!currentItemId) return;

  const item = items.find((i) => i.id === currentItemId);
  const name = item ? item.name : `Item #${currentItemId}`;

  if (!confirm(`Delete "${name}" and all its price history? This cannot be undone.`)) return;

  const btn = document.getElementById('modalDeleteBtn');
  btn.disabled = true;
  btn.textContent = 'Deleting...';

  try {
    const res = await fetch(`/api/items/${currentItemId}`, { method: 'DELETE' });
    const result = await res.json();

    if (res.ok) {
      closeModal();
      await Promise.all([loadItems(), loadBasketChart()]);
    } else {
      alert(result.error || 'Failed to delete item.');
      btn.disabled = false;
      btn.textContent = 'Delete Item';
    }
  } catch (err) {
    console.error('Failed to delete item:', err);
    alert('Failed to delete item. Check console for details.');
    btn.disabled = false;
    btn.textContent = 'Delete Item';
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
    if (e.key === 'Escape') {
      closeModal();
      closeCleanupModal();
    }
  });

  // Data Cleanup modal
  document.getElementById('dataCleanupBtn').addEventListener('click', openCleanupModal);
  document.getElementById('cleanupModalClose').addEventListener('click', closeCleanupModal);
  document.getElementById('cleanupOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeCleanupModal();
  });

  // Sliders — debounced live preview
  let anomalyTimer = null;
  document.getElementById('anomalySlider').addEventListener('input', (e) => {
    document.getElementById('anomalySliderVal').textContent = e.target.value + '%';
    clearTimeout(anomalyTimer);
    anomalyTimer = setTimeout(() => loadAnomalyPreview(parseInt(e.target.value)), 300);
  });

  let spikeTimer = null;
  document.getElementById('spikeAedSlider').addEventListener('input', (e) => {
    document.getElementById('spikeAedVal').textContent = 'AED ' + e.target.value;
    clearTimeout(spikeTimer);
    spikeTimer = setTimeout(() => loadSpikePreview(), 300);
  });
  document.getElementById('spikePctSlider').addEventListener('input', (e) => {
    document.getElementById('spikePctVal').textContent = e.target.value + '%';
    clearTimeout(spikeTimer);
    spikeTimer = setTimeout(() => loadSpikePreview(), 300);
  });
}

// ── Data Cleanup ─────────────────────────────────────
let cachedAnomalyIds = [];
let cachedSpikeIds = [];

function openCleanupModal() {
  document.getElementById('cleanupOverlay').style.display = 'flex';
  switchCleanupTab('anomalies');
}

function closeCleanupModal() {
  document.getElementById('cleanupOverlay').style.display = 'none';
}

function switchCleanupTab(tab) {
  document.querySelectorAll('.cleanup-tab').forEach((t) => {
    const isActive = t.dataset.tab === tab;
    t.style.borderBottomColor = isActive ? 'var(--primary, #004B87)' : 'transparent';
    t.style.color = isActive ? 'var(--text-primary, #111)' : 'var(--text-secondary)';
  });
  document.getElementById('anomalyTab').style.display = tab === 'anomalies' ? '' : 'none';
  document.getElementById('spikesTab').style.display = tab === 'spikes' ? '' : 'none';

  if (tab === 'anomalies') {
    loadAnomalyPreview(parseInt(document.getElementById('anomalySlider').value));
  } else {
    loadSpikePreview();
  }
}

// ── Anomaly Preview ──────────────────────────────────
async function loadAnomalyPreview(deviation) {
  const listEl = document.getElementById('anomalyList');
  listEl.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:24px">Loading...</p>';

  try {
    const res = await fetch(`/api/anomalies?deviation=${deviation}`);
    const data = await res.json();

    if (!res.ok || !data.anomalies) {
      listEl.innerHTML = `<p style="color:var(--negative);padding:16px">Server error: ${data.error || 'unknown'}. Try restarting the server.</p>`;
      return;
    }

    cachedAnomalyIds = data.anomalies.map((a) => a.id);
    const removeBtn = document.getElementById('removeAllAnomaliesBtn');
    removeBtn.textContent = `Remove All (${data.count})`;
    removeBtn.disabled = data.count === 0;

    if (data.count === 0) {
      listEl.innerHTML = `<p style="text-align:center;color:var(--text-secondary);padding:32px">No anomalies at ${deviation}% threshold.</p>`;
      return;
    }

    const byItem = {};
    for (const a of data.anomalies) {
      if (!byItem[a.itemName]) byItem[a.itemName] = [];
      byItem[a.itemName].push(a);
    }

    let html = `<p style="margin-bottom:16px;color:var(--text-secondary);font-size:0.85rem">${data.count} anomalous price(s) across ${Object.keys(byItem).length} item(s). Red = deviates >${deviation}% from median.</p>`;
    html += '<div style="display:flex;flex-direction:column;gap:12px">';

    for (const [itemName, anomalies] of Object.entries(byItem)) {
      const itemAnomalies = anomalies;
      const median = itemAnomalies[0].trimmedMean;
      const itemData = items.find((i) => i.name === itemName);
      let pricesHtml = '';

      if (itemData) {
        pricesHtml = stores.map((store) => {
          const priceData = itemData.prices[store.id];
          if (!priceData || priceData.price <= 0) return '';

          const css = STORE_CSS[store.id];
          const isAnomaly = itemAnomalies.some((a) => a.storeId === store.id);
          const devPct = ((Math.abs(priceData.price - median) / median) * 100).toFixed(1);

          const style = isAnomaly
            ? 'background:rgba(220,38,38,0.1);border:1px solid rgba(220,38,38,0.3);border-radius:6px;padding:4px 8px'
            : 'padding:4px 8px';

          const entry = isAnomaly ? itemAnomalies.find((a) => a.storeId === store.id) : null;
          const delBtn = entry
            ? `<button onclick="deletePriceEntry(${entry.id}, this, 'anomaly')" title="Remove" style="background:none;border:none;cursor:pointer;color:var(--negative);font-size:1rem;padding:0 0 0 6px;line-height:1;opacity:0.7" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.7">&times;</button>`
            : '';

          return `<div style="display:flex;justify-content:space-between;align-items:center;font-size:0.85rem;${style}" ${entry ? `data-entry-id="${entry.id}"` : ''}>
            <span><span class="store-dot ${css}"></span>${STORE_NAMES[store.id]}</span>
            <span style="display:flex;align-items:center">
              <span style="font-weight:600;${isAnomaly ? 'color:var(--negative)' : ''}">AED ${priceData.price.toFixed(2)}</span>
              ${isAnomaly ? `<span style="font-size:0.75rem;color:var(--negative);margin-left:6px">(${devPct}% off)</span>` : ''}
              ${delBtn}
            </span>
          </div>`;
        }).filter(Boolean).join('');
      }

      html += `<div style="background:var(--card-bg);border-radius:var(--radius);padding:14px;box-shadow:var(--shadow);border-left:4px solid var(--negative)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span style="font-weight:600;font-size:0.95rem">${itemName}</span>
          <span style="font-size:0.75rem;color:var(--text-secondary);background:var(--bg);padding:2px 8px;border-radius:4px">Median: AED ${median.toFixed(2)}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">${pricesHtml}</div>
      </div>`;
    }

    html += '</div>';
    listEl.innerHTML = html;
  } catch (err) {
    console.error('Failed to load anomalies:', err);
    listEl.innerHTML = '<p style="color:var(--negative);padding:16px">Failed to load anomalies.</p>';
  }
}

// ── Spike Preview ────────────────────────────────────
async function loadSpikePreview() {
  const aed = document.getElementById('spikeAedSlider').value;
  const pct = document.getElementById('spikePctSlider').value;
  const listEl = document.getElementById('spikesList');
  listEl.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:24px">Loading...</p>';

  try {
    const res = await fetch(`/api/spikes?aed=${aed}&pct=${pct}`);
    const data = await res.json();

    if (!res.ok || !data.spikes) {
      listEl.innerHTML = `<p style="color:var(--negative);padding:16px">Server error: ${data.error || 'unknown'}. Try restarting the server.</p>`;
      return;
    }

    cachedSpikeIds = data.spikes.map((s) => s.id);
    const removeBtn = document.getElementById('removeAllSpikesBtn');
    removeBtn.textContent = `Remove All (${data.count})`;
    removeBtn.disabled = data.count === 0;

    if (data.count === 0) {
      listEl.innerHTML = `<p style="text-align:center;color:var(--text-secondary);padding:32px">No price spikes exceeding AED ${aed} or ${pct}%.</p>`;
      return;
    }

    let html = `<p style="margin-bottom:16px;color:var(--text-secondary);font-size:0.85rem">${data.count} suspicious price change(s) found (exceeding AED ${aed} or ${pct}%).</p>`;
    html += '<div style="display:flex;flex-direction:column;gap:8px">';

    for (const spike of data.spikes) {
      const css = STORE_CSS[spike.storeId] || '';
      const isUp = spike.changeAed > 0;
      const arrow = isUp ? '&#9650;' : '&#9660;';
      const color = isUp ? 'var(--negative, #dc2626)' : '#2563eb';
      const bgColor = isUp ? 'rgba(220,38,38,0.06)' : 'rgba(37,99,235,0.06)';
      const borderColor = isUp ? 'rgba(220,38,38,0.3)' : 'rgba(37,99,235,0.3)';

      html += `<div style="background:${bgColor};border:1px solid ${borderColor};border-radius:8px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center" data-entry-id="${spike.id}">
        <div style="flex:1">
          <div style="font-weight:600;font-size:0.9rem;margin-bottom:2px">${spike.itemName}</div>
          <div style="font-size:0.8rem;color:var(--text-secondary)"><span class="store-dot ${css}"></span>${spike.storeName}</div>
        </div>
        <div style="text-align:right;display:flex;align-items:center;gap:12px">
          <div>
            <div style="font-size:0.8rem;color:var(--text-secondary)">AED ${spike.previousPrice.toFixed(2)} &rarr; <span style="font-weight:600;color:${color}">AED ${spike.price.toFixed(2)}</span></div>
            <div style="font-size:0.8rem;color:${color};font-weight:600">${arrow} ${isUp ? '+' : ''}${spike.changeAed.toFixed(2)} (${isUp ? '+' : ''}${spike.changePct}%)</div>
          </div>
          <button onclick="deletePriceEntry(${spike.id}, this, 'spike')" title="Remove" style="background:none;border:none;cursor:pointer;color:${color};font-size:1.1rem;padding:0;line-height:1;opacity:0.7" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.7">&times;</button>
        </div>
      </div>`;
    }

    html += '</div>';
    listEl.innerHTML = html;
  } catch (err) {
    console.error('Failed to load spikes:', err);
    listEl.innerHTML = '<p style="color:var(--negative);padding:16px">Failed to load price spikes.</p>';
  }
}

// ── Shared delete for both anomalies and spikes ──────
async function deletePriceEntry(id, btnEl, type) {
  btnEl.disabled = true;
  btnEl.style.opacity = 0.3;

  const endpoint = type === 'spike' ? '/api/spikes' : '/api/anomalies';
  try {
    const res = await fetch(endpoint, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    });
    const result = await res.json();

    if (result.removed > 0) {
      const row = btnEl.closest('[data-entry-id]');
      if (row) {
        row.style.transition = 'opacity 0.3s';
        row.style.opacity = '0';
        setTimeout(() => row.remove(), 300);
      }
      // Update cached IDs
      if (type === 'spike') {
        cachedSpikeIds = cachedSpikeIds.filter((i) => i !== id);
        const btn = document.getElementById('removeAllSpikesBtn');
        btn.textContent = `Remove All (${cachedSpikeIds.length})`;
        btn.disabled = cachedSpikeIds.length === 0;
      } else {
        cachedAnomalyIds = cachedAnomalyIds.filter((i) => i !== id);
        const btn = document.getElementById('removeAllAnomaliesBtn');
        btn.textContent = `Remove All (${cachedAnomalyIds.length})`;
        btn.disabled = cachedAnomalyIds.length === 0;
      }
      await Promise.all([loadItems(), loadBasketChart()]);
    }
  } catch (err) {
    console.error('Failed to delete entry:', err);
    btnEl.disabled = false;
    btnEl.style.opacity = 0.7;
  }
}

// ── Bulk remove ──────────────────────────────────────
async function removeAllVisibleAnomalies() {
  if (cachedAnomalyIds.length === 0) return;
  if (!confirm(`Remove all ${cachedAnomalyIds.length} anomalous price(s)?`)) return;

  const btn = document.getElementById('removeAllAnomaliesBtn');
  btn.disabled = true;
  btn.textContent = 'Removing...';

  try {
    const res = await fetch('/api/anomalies', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: cachedAnomalyIds }),
    });
    const result = await res.json();
    cachedAnomalyIds = [];
    btn.textContent = 'Remove All (0)';
    document.getElementById('anomalyList').innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:32px">All anomalies removed.</p>';
    await Promise.all([loadItems(), loadBasketChart()]);
  } catch (err) {
    console.error('Bulk anomaly removal failed:', err);
    btn.disabled = false;
    btn.textContent = `Remove All (${cachedAnomalyIds.length})`;
  }
}

async function removeAllVisibleSpikes() {
  if (cachedSpikeIds.length === 0) return;
  if (!confirm(`Remove all ${cachedSpikeIds.length} suspicious price change(s)?`)) return;

  const btn = document.getElementById('removeAllSpikesBtn');
  btn.disabled = true;
  btn.textContent = 'Removing...';

  try {
    const res = await fetch('/api/spikes', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: cachedSpikeIds }),
    });
    const result = await res.json();
    cachedSpikeIds = [];
    btn.textContent = 'Remove All (0)';
    document.getElementById('spikesList').innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:32px">All spikes removed.</p>';
    await Promise.all([loadItems(), loadBasketChart()]);
  } catch (err) {
    console.error('Bulk spike removal failed:', err);
    btn.disabled = false;
    btn.textContent = `Remove All (${cachedSpikeIds.length})`;
  }
}
