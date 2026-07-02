/**
 * app.js - Main Application Logic for WMS (Supabase & LocalStorage Hybrid Version)
 * Optimized for performance (6,000+ SKUs) with client-side caching, autocomplete datalists,
 * Excel imports, and transaction location tracking.
 */

// --- GLOBAL APP STATE ---
let currentTheme = 'dark';
let chartInstanceCategory = null;
let chartInstanceStock = null;
let selectedSkuForEdit = null;

// Memory Cache for products list
let productsCache = null;

// Sorting State for Inventory Table
let sortColumn = 'sku';
let sortDirection = 'asc';

// Virtual Scroll State for Inventory Table
// Stores the current filtered+sorted dataset so the scroll handler can render slices
let vsFilteredData = [];
let vsRowHeight = 53;       // px height of each <tr> — keep in sync with CSS
let vsOverscan = 5;         // extra rows rendered above/below the visible window
let vsScrollRAF = null;     // requestAnimationFrame token for scroll throttling

// --- GLOBAL HELPER FUNCTIONS ---

// Escape HTML special characters to prevent XSS when inserting user-sourced
// data into innerHTML. Use this for any value that comes from the database
// (product names, SKUs, operator names, locations, categories, etc.).
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
window.escapeHtml = escapeHtml; // Expose globally

// Render a product's multi-location JSON map as a readable string
// {"Rack A1":50,"Rack B2":30} → "Rack A1 (50), Rack B2 (30)"
function formatLocationDisplay(locationStr, stockOnHand) {
  const locMap = window.parseLocations ? window.parseLocations(locationStr, stockOnHand) : {};
  const entries = Object.entries(locMap).filter(([loc]) => loc && loc !== '0');
  if (entries.length === 0) return locationStr || 'N/A';
  return entries.map(([loc, qty]) => `${loc} (${qty})`).join(', ');
}

// Memory cache lookup helper
async function getCachedProducts(forceRefresh = false) {
  if (productsCache === null || forceRefresh) {
    productsCache = await WMSDatabase.getProducts();
  }
  return productsCache;
}

// Memory cache single lookup helper (extremely fast)
async function getProductBySku(sku) {
  if (!sku) return null;
  const products = await getCachedProducts();
  return products.find(p => p.sku === sku.toUpperCase().trim()) || null;
}

// Sound generator for barcode scanner simulator
function playScanSound() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(1200, audioCtx.currentTime); // High pitch beep
    gainNode.gain.setValueAtTime(0.08, audioCtx.currentTime);
    
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.08); // Short duration
  } catch (e) {
    console.log('AudioContext not allowed or supported yet', e);
  }
}

// Format relative timestamps
function formatTimeDiff(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Display modern toast notifications
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  let iconClass = 'fa-circle-check';
  if (type === 'error') iconClass = 'fa-circle-xmark';
  else if (type === 'warning') iconClass = 'fa-triangle-exclamation';

  toast.innerHTML = `
    <i class="fa-solid ${iconClass}"></i>
    <span>${message}</span>
  `;

  container.appendChild(toast);

  // Animate and remove toast after 3.5 seconds
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-20px) scale(0.9)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}
window.showToast = showToast; // Expose globally

// Display inline system message feedback (as fallback for forms)
function showMessage(containerId, message, type = 'success') {
  const container = document.getElementById(containerId);
  if (!container) return;
  
  container.innerHTML = `
    <div class="sys-message ${type}">
      <i class="fa-solid ${type === 'success' ? 'fa-circle-check' : 'fa-circle-exclamation'}"></i>
      ${message}
    </div>
  `;
  setTimeout(() => {
    container.innerHTML = '';
  }, 4000);
}

// Apply Theme colors
function applyTheme(theme) {
  const themeToggle = document.getElementById('theme-toggle');
  const icon = themeToggle ? themeToggle.querySelector('i') : null;
  if (theme === 'light') {
    document.body.classList.add('light-theme');
    if (icon) {
      icon.className = 'fa-solid fa-moon';
    }
  } else {
    document.body.classList.remove('light-theme');
    if (icon) {
      icon.className = 'fa-solid fa-sun';
    }
  }
}

// Sync global header user avatar
function updateGlobalHeaderProfile() {
  const user = WMSDatabase.getCurrentUser();
  const profileBadge = document.getElementById('global-profile-initials');
  const headerGreeting = document.getElementById('global-header-username');
  
  if (user && profileBadge && headerGreeting) {
    const initials = user.name.split(' ').filter(Boolean).map(n => n[0]).join('').toUpperCase().substring(0, 2);
    profileBadge.textContent = initials || '??';
    headerGreeting.textContent = user.name;
    const headerRole = document.getElementById('global-header-role');
    if (headerRole) headerRole.textContent = user.role || 'Operator';
  }
}

// Enforce role-based page and sidebar menu permissions
function enforceUserPermissions() {
  // Prefer WMSAuth profile (Supabase) over localStorage — more trustworthy
  const authProfile = window.WMSAuth && WMSAuth.profile ? WMSAuth.profile : null;
  const user = authProfile
    ? { role: authProfile.role, name: authProfile.full_name }
    : WMSDatabase.getCurrentUser();

  const isOperator = user && user.role === 'Operator';

  // Show or hide admin-only sidebar items
  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = isOperator ? 'none' : '';
  });

  // If operator is on a restricted view, force redirect to dashboard
  const restrictedViews = ['view-barcode', 'view-reports', 'view-settings', 'view-approvals', 'view-activity-log'];
  const activeLink = document.querySelector('.sidebar .menu a.active');
  if (activeLink) {
    const activeView = activeLink.getAttribute('data-view');
    if (isOperator && restrictedViews.includes(activeView)) {
      showToast('Access Denied: Operators cannot access this section.', 'warning');
      _redirectToDashboard();
    }
  }

  // Also guard direct navigation — if the active page-view is restricted, redirect
  restrictedViews.forEach(viewId => {
    const el = document.getElementById(viewId);
    if (el && el.classList.contains('active') && isOperator) {
      showToast('Access Denied: Operators cannot access this section.', 'warning');
      _redirectToDashboard();
    }
  });
}

function _redirectToDashboard() {
  document.querySelectorAll('.sidebar .menu a').forEach(l => l.classList.remove('active'));
  document.querySelectorAll('.main .page-view').forEach(p => p.classList.remove('active'));
  const dashLink = document.querySelector('[data-view="view-dashboard"]');
  if (dashLink) dashLink.classList.add('active');
  const dashView = document.getElementById('view-dashboard');
  if (dashView) dashView.classList.add('active');
  onViewActivated('view-dashboard');
}


// --- VIEW RENDERING ENGINE ---

// Shared, visually distinct color palette used consistently across charts and tables.
// 12 colors to cover even large category sets without repeating.
const CHART_COLORS = [
  '#06b6d4', // teal
  '#3b82f6', // blue
  '#10b981', // green
  '#f59e0b', // amber
  '#8b5cf6', // violet
  '#f43f5e', // rose
  '#14b8a6', // cyan
  '#f97316', // orange
  '#a855f7', // purple
  '#84cc16', // lime
  '#ec4899', // pink
  '#64748b', // slate
];
const CHART_COLORS_ALPHA = CHART_COLORS.map(c => c + 'cc'); // ~80% opacity versions

// Dashboard View
async function renderDashboard() {
  const products = await getCachedProducts();
  const transactions = await WMSDatabase.getTransactions();
  
  // Calculate KPIs
  const totalItems = products.length;
  const totalStock = products.reduce((acc, p) => acc + p.stock_on_hand, 0);
  const lowStockCount = products.filter(p => p.status === 'Low Stock').length;
  const outOfStockCount = products.filter(p => p.status === 'Out of Stock').length;

  // Render KPIs
  document.getElementById('kpi-total-sku').textContent = totalItems.toLocaleString();
  document.getElementById('kpi-total-stock').textContent = totalStock.toLocaleString();
  document.getElementById('kpi-low-stock').textContent = lowStockCount.toLocaleString();
  document.getElementById('kpi-out-of-stock').textContent = outOfStockCount.toLocaleString();

  // Render Transaction Feed (Recent Activities)
  const feedContainer = document.getElementById('dashboard-transaction-feed');
  if (feedContainer) {
    if (transactions.length === 0) {
      feedContainer.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 20px;">No recent activities.</div>';
    } else {
      const latestTx = transactions.slice(0, 5);
      feedContainer.innerHTML = latestTx.map(tx => {
        const isStockIn = tx.type === 'Stock In';
        const iconClass = isStockIn ? 'fa-arrow-down-long' : 'fa-arrow-up-long';
        const iconType = isStockIn ? 'in' : 'out';
        const timeFormatted = formatTimeDiff(new Date(tx.timestamp));
        const locInfo = tx.location && tx.location !== 'N/A' ? ` &bull; <i class="fa-solid fa-location-dot" style="font-size:10px;"></i> ${escapeHtml(tx.location)}` : '';
        
        return `
          <div class="feed-item">
            <div class="feed-icon ${iconType}">
              <i class="fa-solid ${iconClass}"></i>
            </div>
            <div class="feed-details">
              <div class="feed-title">${escapeHtml(tx.type)}: ${escapeHtml(tx.productName)}</div>
              <div class="feed-meta">
                <span>${escapeHtml(tx.quantity)} units (${escapeHtml(tx.sku)})${locInfo} &bull; ${escapeHtml(tx.docRef)}</span>
                <span>${timeFormatted}</span>
              </div>
            </div>
            <div style="align-self: center;">
              <span class="badge-operator">${escapeHtml(tx.operator)}</span>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // Render Low Stock & Out of Stock Watchlist
  const lowStockContainer = document.getElementById('dashboard-low-stock-list');
  if (lowStockContainer) {
    const watchlist = products.filter(p => p.status === 'Low Stock' || p.status === 'Out of Stock');
    if (watchlist.length === 0) {
      lowStockContainer.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 15px;">All items sufficiently stocked.</td></tr>';
    } else {
      lowStockContainer.innerHTML = watchlist.map(p => {
        const statusClass = p.status === 'Out of Stock' ? 'out-of-stock' : 'low-stock';
        return `
          <tr>
            <td style="font-weight:700;">${escapeHtml(p.sku)}</td>
            <td>${escapeHtml(p.name)}</td>
            <td style="font-size:12px;">${escapeHtml(formatLocationDisplay(p.location, p.stock_on_hand))}</td>
            <td style="color: var(--danger-color); font-weight:700;">${escapeHtml(p.available_stock)}</td>
            <td><span class="status ${statusClass}">${escapeHtml(p.status)}</span></td>
          </tr>
        `;
      }).join('');
    }
  }
}

// Build one table row HTML string — pure string concatenation, no DOM touching
function buildInventoryRow(p) {
  let statusClass = 'in-stock';
  let rowClass = '';
  if (p.status === 'Out of Stock') { statusClass = 'out-of-stock'; rowClass = 'row-out-of-stock'; }
  else if (p.status === 'Low Stock')  { statusClass = 'low-stock';     rowClass = 'row-low-stock'; }

  const formattedDate = new Date(p.updated_at).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  // Operators can view inventory but cannot edit or delete products
  const authProfile = window.WMSAuth && WMSAuth.profile ? WMSAuth.profile : null;
  const isOperator = authProfile ? authProfile.role === 'Operator' : false;
  const actionsHtml = isOperator
    ? `<span style="font-size:11px;color:var(--text-muted);font-style:italic;">View only</span>`
    : `<button class="action-btn edit-product-btn" data-sku="${escapeHtml(p.sku)}" title="Edit Product Details"><i class="fa-solid fa-pen"></i></button>
       <button class="action-btn delete delete-product-btn" data-sku="${escapeHtml(p.sku)}" title="Delete Product"><i class="fa-solid fa-trash"></i></button>`;

  return `<tr class="${rowClass}" data-sku="${escapeHtml(p.sku)}">
    <td style="font-weight:700;font-family:monospace;">${escapeHtml(p.sku)}</td>
    <td style="font-weight:500;">${escapeHtml(p.name)}</td>
    <td>${escapeHtml(p.category)}</td>
    <td style="font-size:12px;"><i class="fa-solid fa-location-dot" style="margin-right:5px;font-size:11px;color:var(--text-muted);"></i>${escapeHtml(formatLocationDisplay(p.location, p.stock_on_hand))}</td>
    <td style="font-weight:600;">${escapeHtml(p.stock_on_hand)}</td>
    <td style="color:var(--text-secondary);font-weight:500;">${escapeHtml(p.reserved_stock)}</td>
    <td style="font-weight:700;color:${p.available_stock<=0?'var(--danger-color)':'var(--text-primary)'};">${escapeHtml(p.available_stock)}</td>
    <td style="color:var(--text-muted);font-family:monospace;">${escapeHtml(p.reorder_level)}</td>
    <td style="color:var(--text-muted);font-family:monospace;">₱${Number(p.price||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
    <td><span class="status ${statusClass}">${escapeHtml(p.status)}</span></td>
    <td style="font-size:12px;color:var(--text-muted);">${formattedDate}</td>
    <td><div class="actions">${actionsHtml}</div></td>
  </tr>`;
}

// Inventory Table View — virtual scroll handles 5000+ SKUs without freezing the browser
async function renderInventoryTable() {
  const products = await getCachedProducts();
  const tbody = document.getElementById('inventory-table-body');
  if (!tbody) return;

  // Hide Add/Import controls for operators
  const authProfile = window.WMSAuth && WMSAuth.profile ? WMSAuth.profile : null;
  const isOperator = authProfile ? authProfile.role === 'Operator' : false;
  const addBtn = document.querySelector('#view-inventory .btn:not(.btn-secondary)');
  const importLabel = document.querySelector('label[for="xlsx-import-file"]');
  const exportBtn = document.querySelector('.inv-export-btn');
  if (addBtn) addBtn.style.display = isOperator ? 'none' : '';
  if (importLabel) importLabel.style.display = isOperator ? 'none' : '';
  // Operators can still export

  const searchQuery = document.getElementById('inv-search').value.toLowerCase();
  const filterCategory = document.getElementById('filter-category').value;
  const filterLocation = document.getElementById('filter-location').value;
  const filterStatus = document.getElementById('filter-status').value;
  const hideZeroStock = document.getElementById('hide-zero-stock').checked;

  // 1. Filter in-memory
  let filtered = products.filter(p => {
    if (searchQuery && !p.sku.toLowerCase().includes(searchQuery) && !p.name.toLowerCase().includes(searchQuery)) return false;
    if (filterCategory !== 'all' && p.category !== filterCategory) return false;
    if (filterLocation !== 'all') {
      // Location is stored as a JSON map — check if the selected location key exists with stock > 0
      const locMap = window.parseLocations ? window.parseLocations(p.location, p.stock_on_hand) : {};
      if (!locMap[filterLocation]) return false;
    }
    if (filterStatus === 'in-stock'     && p.status !== 'In Stock')     return false;
    if (filterStatus === 'low-stock'    && p.status !== 'Low Stock')     return false;
    if (filterStatus === 'out-of-stock' && p.status !== 'Out of Stock')  return false;
    if (hideZeroStock && p.stock_on_hand <= 0) return false;
    return true;
  });

  // 2. Sort
  filtered.sort((a, b) => {
    let valA = a[sortColumn] ?? '';
    let valB = b[sortColumn] ?? '';
    if (typeof valA === 'string') { valA = valA.toLowerCase(); valB = (valB + '').toLowerCase(); }
    if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
    if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
    return 0;
  });

  // Update sort header icons
  document.querySelectorAll('th.sortable-header').forEach(th => {
    const col = th.getAttribute('data-sort');
    th.classList.remove('sorted-asc', 'sorted-desc');
    const icon = th.querySelector('i');
    if (icon) icon.className = 'fa-solid fa-sort';
    if (col === sortColumn) {
      th.classList.add(sortDirection === 'asc' ? 'sorted-asc' : 'sorted-desc');
      if (icon) icon.className = sortDirection === 'asc' ? 'fa-solid fa-arrow-up-long' : 'fa-solid fa-arrow-down-long';
    }
  });

  // 3. Store filtered data globally for the virtual scroll handler
  vsFilteredData = filtered;

  // Update the count label
  const countEl = document.getElementById('inventory-count-label');
  if (countEl) countEl.textContent = `${filtered.length.toLocaleString()} products`;

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:35px;color:var(--text-muted);font-size:14px;">No products found matching the criteria.</td></tr>';
    const pre = document.getElementById('vs-spacer-top');
    const post = document.getElementById('vs-spacer-bottom');
    if (pre) pre.style.height = '0px';
    if (post) post.style.height = '0px';
    return;
  }

  // 4. Reset scroll to top and trigger initial virtual render
  const scrollContainer = document.getElementById('inventory-scroll-container');
  if (scrollContainer) scrollContainer.scrollTop = 0;
  renderVirtualRows();
}

// Renders only the rows visible in the scroll viewport plus overscan buffer
function renderVirtualRows() {
  const tbody = document.getElementById('inventory-table-body');
  const scrollContainer = document.getElementById('inventory-scroll-container');
  if (!tbody || !scrollContainer) return;

  const total = vsFilteredData.length;
  if (total === 0) return;

  const containerHeight = scrollContainer.clientHeight || 500;
  const scrollTop = scrollContainer.scrollTop;

  const firstVisible = Math.floor(scrollTop / vsRowHeight);
  const visibleCount = Math.ceil(containerHeight / vsRowHeight);

  const startIdx = Math.max(0, firstVisible - vsOverscan);
  const endIdx   = Math.min(total - 1, firstVisible + visibleCount + vsOverscan);

  // Spacer rows push the visible slice into the correct scroll position
  const topSpacerHeight    = startIdx * vsRowHeight;
  const bottomSpacerHeight = (total - 1 - endIdx) * vsRowHeight;

  const pre  = document.getElementById('vs-spacer-top');
  const post = document.getElementById('vs-spacer-bottom');
  if (pre)  pre.style.height  = topSpacerHeight + 'px';
  if (post) post.style.height = bottomSpacerHeight + 'px';

  // Build only the visible slice as a string — no DOM per-row
  let html = '';
  for (let i = startIdx; i <= endIdx; i++) {
    html += buildInventoryRow(vsFilteredData[i]);
  }
  tbody.innerHTML = html;

  // Attach row action button listeners on the rendered slice
  tbody.querySelectorAll('.edit-product-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await openEditProductModal(btn.getAttribute('data-sku'));
    });
  });

  tbody.querySelectorAll('.delete-product-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sku = btn.getAttribute('data-sku');
      if (confirm(`Are you sure you want to delete SKU ${sku}? This action cannot be undone.`)) {
        try {
          await WMSDatabase.deleteProduct(sku);
          productsCache = null;
          showToast(`Successfully deleted SKU: ${sku}`, 'success');
          await renderInventoryTable();
          await renderDashboard();
        } catch (e) {
          showToast(`Error deleting product: ${e.message}`, 'error');
        }
      }
    });
  });
}

// Wire up scroll listener for virtual scroll — called once in setupEventListeners
function setupInventoryVirtualScroll() {
  const scrollContainer = document.getElementById('inventory-scroll-container');
  if (!scrollContainer) return;
  scrollContainer.addEventListener('scroll', () => {
    if (vsScrollRAF) cancelAnimationFrame(vsScrollRAF);
    vsScrollRAF = requestAnimationFrame(renderVirtualRows);
  }, { passive: true });
}

// Populate Category & Location filters — location is a JSON map, extract all unique keys
async function populateFilterDropdowns() {
  const [settingsData, products] = await Promise.all([
    WMSDatabase.getSettings(),
    getCachedProducts()
  ]);
  const catSelect = document.getElementById('filter-category');
  const locSelect = document.getElementById('filter-location');

  if (catSelect) {
    const savedVal = catSelect.value;
    const productCats = [...new Set(products.map(p => p.category).filter(Boolean))];
    const allCats = [...new Set([...settingsData.categories, ...productCats])].sort();
    catSelect.innerHTML = '<option value="all">All Categories</option>' +
      allCats.map(c => `<option value="${c}">${c}</option>`).join('');
    catSelect.value = savedVal || 'all';
  }

  if (locSelect) {
    const savedVal = locSelect.value;
    // Collect all unique location keys across all products (location is JSON map)
    const productLocs = new Set(settingsData.locations);
    products.forEach(p => {
      const locMap = window.parseLocations ? window.parseLocations(p.location, p.stock_on_hand) : {};
      Object.keys(locMap).forEach(k => { if (k) productLocs.add(k); });
    });
    const allLocs = [...productLocs].sort();
    locSelect.innerHTML = '<option value="all">All Locations</option>' +
      allLocs.map(l => `<option value="${l}">${l}</option>`).join('');
    locSelect.value = savedVal || 'all';
  }
}

// Autocomplete populator helper for SKU autocomplete datalists
async function updateSkuDatalists() {
  const products = await getCachedProducts();
  const dlIn = document.getElementById('stock-in-sku-list');
  const dlOut = document.getElementById('stock-out-sku-list');
  
  const optionsHtml = products.map(p => `<option value="${escapeHtml(p.sku)}">${escapeHtml(p.name)} (Qty: ${escapeHtml(p.stock_on_hand)})</option>`).join('');
  if (dlIn) dlIn.innerHTML = optionsHtml;
  if (dlOut) dlOut.innerHTML = optionsHtml;
}

// Stock In Intake forms
async function initStockInForm() {
  await updateSkuDatalists();

  const settingsData = await WMSDatabase.getSettings();
  const locSelect = document.getElementById('stock-in-location');
  if (locSelect) {
    locSelect.innerHTML = settingsData.locations.map(l => `<option value="${l}">${l}</option>`).join('');
  }

  const inputSku = document.getElementById('stock-in-sku');
  if (inputSku && !inputSku.dataset.wired) {
    inputSku.dataset.wired = '1';
    inputSku.addEventListener('input', async () => {
      const sku = inputSku.value.trim().toUpperCase();
      const product = await getProductBySku(sku);
      const details = document.getElementById('stock-in-details');

      if (product && details) {
        // Build per-location breakdown
        const locMap = window.parseLocations ? window.parseLocations(product.location, product.stock_on_hand) : {};
        const locEntries = Object.entries(locMap);
        const locBreakdown = locEntries.length > 0
          ? locEntries.map(([loc, qty]) => `<span style="display:inline-block;margin-right:10px;"><i class="fa-solid fa-location-dot" style="margin-right:3px;font-size:10px;color:var(--text-muted);"></i><strong>${escapeHtml(loc)}:</strong> ${escapeHtml(qty)} units</span>`).join('')
          : `<span style="color:var(--text-muted);">No location data yet</span>`;

        const locCount = locEntries.length;
        const canAddNewLoc = locCount < 5;

        details.innerHTML = `
          <div style="background:rgba(255,255,255,0.03);padding:12px;border-radius:8px;border:1px solid var(--border-color);font-size:13px;display:flex;flex-direction:column;gap:6px;">
            <div style="display:flex;gap:16px;flex-wrap:wrap;">
              <span><strong>Product:</strong> ${escapeHtml(product.name)}</span>
              <span><strong>Category:</strong> ${escapeHtml(product.category)}</span>
              <span><strong>Unit Price:</strong> <span style="color:var(--accent);font-weight:700;">₱${Number(product.price||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span></span>
            </div>
            <div><strong>Total Stock:</strong> ${escapeHtml(product.stock_on_hand)} &nbsp;|&nbsp; <strong>Available:</strong> <span style="color:var(--accent);font-weight:700;">${escapeHtml(product.available_stock)}</span></div>
            <div><strong>Locations (${locCount}/5):</strong></div>
            <div style="padding-left:8px;line-height:2;">${locBreakdown}</div>
            ${!canAddNewLoc ? `<div style="color:var(--warning-color);font-size:12px;"><i class="fa-solid fa-triangle-exclamation"></i> Max 5 locations. Stock in at an existing location.</div>` : ''}
          </div>
        `;

        if (locSelect) {
          const firstLoc = locEntries[0]?.[0];
          if (firstLoc && locSelect.querySelector(`option[value="${firstLoc}"]`)) {
            locSelect.value = firstLoc;
          }
        }

        // Auto-fill the price field if empty
        const priceEl = document.getElementById('stock-in-price');
        if (priceEl && !priceEl.value && product.price) {
          priceEl.value = product.price;
        }
      } else if (details) {
        details.innerHTML = `<div style="font-size:12px;color:var(--text-muted);"><i class="fa-solid fa-info-circle"></i> Type a valid SKU to view details...</div>`;
      }
    });
  }

  await renderStockInHistoryTable();
}

async function renderStockInHistoryTable() {
  const transactions = await WMSDatabase.getTransactions();
  const tbody = document.getElementById('stock-in-history-tbody');
  if (!tbody) return;

  const searchEl = document.getElementById('stock-in-history-search');
  const query = searchEl ? searchEl.value.trim().toUpperCase() : '';

  let inTx = transactions.filter(t => t.type === 'Stock In');
  if (query) inTx = inTx.filter(t => t.sku.toUpperCase().includes(query));

  if (inTx.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:15px;">${query ? `No Stock In records for SKU &quot;<strong>${escapeHtml(query)}</strong>&quot;.` : 'No recent Stock In logs.'}</td></tr>`;
    return;
  }

  tbody.innerHTML = inTx.slice(0, 100).map(tx => {
    const locInfo = tx.location && tx.location !== 'N/A'
      ? ` <span style="font-size:11px;color:var(--text-muted);font-weight:500;">&nbsp;@ ${escapeHtml(tx.location)}</span>` : '';
    const priceInfo = tx.price > 0
      ? `<span style="color:var(--text-muted);font-size:11px;"> &nbsp;·&nbsp; ₱${Number(tx.price).toLocaleString(undefined,{minimumFractionDigits:2})}/unit</span>` : '';
    return `
      <tr>
        <td style="font-size:12px;color:var(--text-muted);">${new Date(tx.timestamp).toLocaleString()}</td>
        <td style="font-weight:700;font-family:monospace;">${escapeHtml(tx.sku)}</td>
        <td>${escapeHtml(tx.productName)}${tx.category ? ` <span style="font-size:11px;color:var(--text-muted);">(${escapeHtml(tx.category)})</span>` : ''}</td>
        <td style="color:var(--success-color);font-weight:700;">+${escapeHtml(tx.quantity)}${locInfo}${priceInfo}</td>
        <td style="font-size:12px;color:var(--text-muted);">${escapeHtml(tx.operator || '')}</td>
      </tr>
    `;
  }).join('');
}

// Stock Out Dispatch forms
async function initStockOutForm() {
  await updateSkuDatalists();

  const settingsData = await WMSDatabase.getSettings();
  const locSelect = document.getElementById('stock-out-location');
  if (locSelect) {
    // Start with all locations — will be overridden when SKU is selected
    locSelect.innerHTML = `<option value="">Select a SKU first...</option>`;
    locSelect.disabled = true;
  }

  const inputSku = document.getElementById('stock-out-sku');
  if (inputSku && !inputSku.dataset.wired) {
    inputSku.dataset.wired = '1';
    inputSku.addEventListener('input', async () => {
      const sku = inputSku.value.trim().toUpperCase();
      const product = await getProductBySku(sku);
      const details = document.getElementById('stock-out-details');

      if (product && details) {
        const locMap = window.parseLocations ? window.parseLocations(product.location, product.stock_on_hand) : {};
        const availableLocs = Object.entries(locMap).filter(([, qty]) => qty > 0);

        // Populate location dropdown with ONLY the locations that have stock
        if (locSelect) {
          if (availableLocs.length === 0) {
            locSelect.innerHTML = `<option value="">No stock in any location</option>`;
            locSelect.disabled = true;
          } else {
            locSelect.innerHTML = availableLocs
              .map(([loc, qty]) => `<option value="${loc}">${loc} — ${qty} units available</option>`)
              .join('');
            locSelect.disabled = false;
          }
        }

        const locBreakdown = availableLocs.length > 0
          ? availableLocs.map(([loc, qty]) => `<span style="display:inline-block;margin-right:10px;"><i class="fa-solid fa-location-dot" style="margin-right:3px;font-size:10px;color:var(--text-muted);"></i><strong>${escapeHtml(loc)}:</strong> ${escapeHtml(qty)} units</span>`).join('')
          : `<span style="color:var(--danger-color);">No stock available in any location</span>`;

        details.innerHTML = `
          <div style="background:rgba(255,255,255,0.03);padding:12px;border-radius:8px;border:1px solid var(--border-color);font-size:13px;display:flex;flex-direction:column;gap:6px;">
            <div style="display:flex;gap:16px;flex-wrap:wrap;">
              <span><strong>Product:</strong> ${escapeHtml(product.name)}</span>
              <span><strong>Category:</strong> ${escapeHtml(product.category)}</span>
              <span><strong>Unit Price:</strong> <span style="color:var(--accent);font-weight:700;">₱${Number(product.price||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span></span>
            </div>
            <div><strong>Total Stock:</strong> ${escapeHtml(product.stock_on_hand)} &nbsp;|&nbsp; <strong>Reserved:</strong> ${escapeHtml(product.reserved_stock)} &nbsp;|&nbsp; <strong>Available:</strong> <span style="color:var(--accent);font-weight:700;" id="stock-out-max-qty">${escapeHtml(product.available_stock)}</span></div>
            <div><strong>Stock by Location:</strong></div>
            <div style="padding-left:8px;line-height:2;">${locBreakdown}</div>
          </div>
        `;

        // Auto-fill unit price if field is empty
        const priceEl = document.getElementById('stock-out-price');
        if (priceEl && !priceEl.value && product.price) {
          priceEl.value = product.price;
        }
      } else {
        if (locSelect) {
          locSelect.innerHTML = `<option value="">Select a SKU first...</option>`;
          locSelect.disabled = true;
        }
        if (details) {
          details.innerHTML = `<div style="font-size:12px;color:var(--text-muted);"><i class="fa-solid fa-info-circle"></i> Type a valid SKU to view details...</div>`;
        }
      }
    });
  }

  await renderStockOutHistoryTable();
}

async function renderStockOutHistoryTable() {
  const transactions = await WMSDatabase.getTransactions();
  const tbody = document.getElementById('stock-out-history-tbody');
  if (!tbody) return;

  const outTx = transactions.filter(t => t.type === 'Stock Out');

  if (outTx.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:15px;">No recent Stock Out logs.</td></tr>';
    return;
  }

  tbody.innerHTML = outTx.slice(0, 100).map(tx => {
    const locInfo = tx.location && tx.location !== 'N/A'
      ? ` <span style="font-size:11px;color:var(--text-muted);font-weight:500;">&nbsp;@ ${escapeHtml(tx.location)}</span>` : '';
    const priceInfo = tx.price > 0
      ? `<span style="color:var(--text-muted);font-size:11px;"> &nbsp;·&nbsp; ₱${Number(tx.price).toLocaleString(undefined,{minimumFractionDigits:2})}/unit</span>` : '';
    return `
      <tr>
        <td style="font-size:12px;color:var(--text-muted);">${new Date(tx.timestamp).toLocaleString()}</td>
        <td style="font-weight:700;font-family:monospace;">${escapeHtml(tx.sku)}</td>
        <td>${escapeHtml(tx.productName)}${tx.category ? ` <span style="font-size:11px;color:var(--text-muted);">(${escapeHtml(tx.category)})</span>` : ''}</td>
        <td style="color:var(--danger-color);font-weight:700;">-${escapeHtml(tx.quantity)}${locInfo}${priceInfo}</td>
        <td style="font-size:12px;color:var(--text-muted);">${escapeHtml(tx.operator || '')}</td>
      </tr>
    `;
  }).join('');
}

// Barcodes Generator section — cards only appear when a search query is typed
async function renderBarcodeSection() {
  const products = await getCachedProducts();
  const barcodeGrid = document.getElementById('barcode-cards-grid');
  const barcodeSearch = document.getElementById('barcode-search');
  if (!barcodeGrid) return;

  // Wire up search input (once)
  if (barcodeSearch && !barcodeSearch.dataset.wired) {
    barcodeSearch.dataset.wired = '1';
    barcodeSearch.addEventListener('input', () => renderBarcodeCards(products));
  }

  // Start with empty grid — show placeholder
  barcodeGrid.innerHTML = `
    <div id="barcode-empty-hint" style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:30px 0; font-size:14px;">
      <i class="fa-solid fa-magnifying-glass" style="font-size:28px; margin-bottom:10px; display:block; opacity:0.4;"></i>
      Type a SKU or product name above to show barcodes.
    </div>
  `;
}

function renderBarcodeCards(products) {
  const barcodeGrid = document.getElementById('barcode-cards-grid');
  const barcodeSearch = document.getElementById('barcode-search');
  if (!barcodeGrid) return;

  const query = (barcodeSearch ? barcodeSearch.value : '').trim().toLowerCase();

  if (!query) {
    barcodeGrid.innerHTML = `
      <div id="barcode-empty-hint" style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:30px 0; font-size:14px;">
        <i class="fa-solid fa-magnifying-glass" style="font-size:28px; margin-bottom:10px; display:block; opacity:0.4;"></i>
        Type a SKU or product name above to show barcodes.
      </div>
    `;
    return;
  }

  const matched = products.filter(p =>
    p.sku.toLowerCase().includes(query) || p.name.toLowerCase().includes(query)
  );

  if (matched.length === 0) {
    barcodeGrid.innerHTML = `
      <div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:30px 0; font-size:14px;">
        No products match "<strong>${query}</strong>".
      </div>
    `;
    return;
  }

  barcodeGrid.innerHTML = matched.map(p => `
    <div class="barcode-card" data-sku="${escapeHtml(p.sku)}">
      <div class="barcode-card-sku">${escapeHtml(p.sku)}</div>
      <div class="barcode-card-name">${escapeHtml(p.name)}</div>
      <canvas id="bc-canvas-${escapeHtml(p.sku)}"></canvas>
      <div style="font-size:11px; color:var(--text-muted);"><i class="fa-solid fa-location-dot" style="margin-right:4px;"></i>${escapeHtml(formatLocationDisplay(p.location, p.stock_on_hand))}</div>
    </div>
  `).join('');

  // Render barcodes onto each canvas
  matched.forEach(p => {
    const canvas = document.getElementById(`bc-canvas-${p.sku}`);
    if (!canvas) return;
    if (window.JsBarcode) {
      try {
        window.JsBarcode(canvas, p.sku, {
          format: 'CODE128', width: 1.5, height: 40,
          displayValue: false, background: '#ffffff',
          lineColor: '#000000', margin: 5
        });
      } catch (err) { drawFallbackBarcode(canvas, p.sku); }
    } else {
      drawFallbackBarcode(canvas, p.sku);
    }
  });

  // Click card → auto-fill scanner
  barcodeGrid.querySelectorAll('.barcode-card').forEach(card => {
    card.addEventListener('click', async () => {
      const sku = card.getAttribute('data-sku');
      const scannerInput = document.getElementById('mock-scan-input');
      if (scannerInput) {
        scannerInput.value = sku;
        await triggerMockScan();
      }
    });
  });
}

function drawFallbackBarcode(canvas, text) {
  const ctx = canvas.getContext('2d');
  canvas.width = 150;
  canvas.height = 50;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  ctx.fillStyle = '#000000';
  let x = 10;
  while (x < 140) {
    const w = Math.floor(Math.random() * 3) + 1;
    ctx.fillRect(x, 5, w, 40);
    x += w + Math.floor(Math.random() * 3) + 1;
  }
}

// Scanner trigger lookup
async function triggerMockScan() {
  const input = document.getElementById('mock-scan-input');
  const resultBox = document.getElementById('mock-scan-result');
  if (!input || !resultBox) return;

  const sku = input.value.trim().toUpperCase();
  if (!sku) return;

  playScanSound();
  const product = await getProductBySku(sku);

  if (product) {
    let statusClass = 'in-stock';
    if (product.status === 'Out of Stock') statusClass = 'out-of-stock';
    else if (product.status === 'Low Stock') statusClass = 'low-stock';

    resultBox.innerHTML = `
      <div class="scanned-product-result">
        <h4 style="color:var(--accent); font-size:16px; margin-bottom: 5px;"><i class="fa-solid fa-barcode" style="margin-right:6px;"></i>Scan Match: ${escapeHtml(product.sku)}</h4>
        <div style="font-size:14px; margin-bottom: 3px;"><strong>Name:</strong> ${escapeHtml(product.name)}</div>
        <div style="font-size:14px; margin-bottom: 3px;"><strong>Category:</strong> ${escapeHtml(product.category)}</div>
        <div style="font-size:14px; margin-bottom: 3px;"><strong>Stock On Hand:</strong> ${escapeHtml(product.stock_on_hand)} units</div>
        <div style="font-size:14px; margin-bottom: 3px;"><strong>Reserved Stock:</strong> ${escapeHtml(product.reserved_stock)} units</div>
        <div style="font-size:14px; margin-bottom: 3px;"><strong>Available Stock:</strong> ${escapeHtml(product.available_stock)} units</div>
        <div style="font-size:14px; margin-bottom: 3px;"><strong>Location:</strong> ${escapeHtml(formatLocationDisplay(product.location, product.stock_on_hand))}</div>
        <div style="margin-top:5px;"><span class="status ${statusClass}">${escapeHtml(product.status)}</span></div>
        <div style="display:flex; gap:10px; margin-top: 15px;">
          <button class="btn btn-secondary" onclick="quickTransact('in', '${escapeHtml(product.sku)}')">Stock In (+)</button>
          <button class="btn btn-secondary" onclick="quickTransact('out', '${escapeHtml(product.sku)}')">Stock Out (-)</button>
        </div>
      </div>
    `;
    showToast(`Scanner: Scanned ${product.sku} successfully`, 'success');
  } else {
    resultBox.innerHTML = `
      <div style="color:var(--danger-color); padding: 15px; text-align:center; border: 1px dashed var(--danger-color); border-radius: var(--border-radius-md); margin-top: 20px;">
        <i class="fa-solid fa-triangle-exclamation"></i> SKU Not Found in Database.
      </div>
    `;
    showToast(`Scanner Error: SKU ${sku} not found`, 'error');
  }
  input.value = ''; // Reset scanner input
}

// Reports & Chart rendering
async function renderReportsSection() {
  const products = await getCachedProducts();
  const categories = [...new Set(products.map(p => p.category))].sort();

  // 1. Calculate KPI Metrics
  const totalSKUs = products.length;
  const totalStock = products.reduce((a, p) => a + p.stock_on_hand, 0);
  const totalValuation = products.reduce((a, p) => a + (p.stock_on_hand * (parseFloat(p.price) || 0)), 0);
  const lowStockCount = products.filter(p => p.status === 'Low Stock').length;
  const outOfStockCount = products.filter(p => p.status === 'Out of Stock').length;

  // Parse locations
  const uniqueLocs = new Set();
  products.forEach(p => {
    const locs = parseLocations(p.location, p.stock_on_hand);
    Object.keys(locs).forEach(k => uniqueLocs.add(k));
  });
  const totalLocations = uniqueLocs.size;

  // Render KPIs in reports tab
  const kpiSkus = document.getElementById('kpi-reports-skus');
  const kpiUnits = document.getElementById('kpi-reports-units');
  const kpiValue = document.getElementById('kpi-reports-value');
  const kpiLocs = document.getElementById('kpi-reports-locations');

  if (kpiSkus) kpiSkus.textContent = totalSKUs.toLocaleString();
  if (kpiUnits) kpiUnits.textContent = totalStock.toLocaleString();
  if (kpiValue) kpiValue.textContent = '₱' + totalValuation.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (kpiLocs) kpiLocs.textContent = totalLocations;

  // 2. Calculate Location Breakdown Stats
  const locationStats = {};
  uniqueLocs.forEach(loc => {
    locationStats[loc] = { skus: new Set(), units: 0, value: 0 };
  });

  products.forEach(p => {
    const locs = parseLocations(p.location, p.stock_on_hand);
    const price = parseFloat(p.price) || 0;
    Object.entries(locs).forEach(([loc, qty]) => {
      if (locationStats[loc]) {
        locationStats[loc].skus.add(p.sku);
        locationStats[loc].units += qty;
        locationStats[loc].value += qty * price;
      }
    });
  });

  const locationStatsArray = Object.entries(locationStats).map(([name, stats]) => ({
    name,
    skuCount: stats.skus.size,
    totalUnits: stats.units,
    valuation: stats.value,
    percent: totalValuation > 0 ? (stats.value / totalValuation) * 100 : 0
  })).sort((a, b) => b.valuation - a.valuation);

  // Populate Location Table
  const tbody = document.getElementById('reports-locations-tbody');
  if (tbody) {
    if (locationStatsArray.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:15px;color:var(--text-muted);">No locations recorded</td></tr>';
    } else {
      tbody.innerHTML = locationStatsArray.map(item => `
        <tr>
          <td style="font-weight:700;"><i class="fa-solid fa-location-dot" style="margin-right:6px;color:var(--accent);"></i>${escapeHtml(item.name)}</td>
          <td>${escapeHtml(item.skuCount)} SKU types</td>
          <td style="font-family:'JetBrains Mono',monospace;">${escapeHtml(item.totalUnits)} units</td>
          <td style="font-family:'JetBrains Mono',monospace;font-weight:600;color:var(--success-color);">₱${item.valuation.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>
            <div style="display:flex; align-items:center; gap:8px;">
              <div style="flex-grow:1; background:var(--border-color); height:6px; border-radius:3px; overflow:hidden; min-width:80px;">
                <div style="background:var(--accent-gradient); width:${item.percent}%; height:100%;"></div>
              </div>
              <span style="font-size:11px; font-weight:600; color:var(--text-secondary); width:40px; text-align:right;">${item.percent.toFixed(1)}%</span>
            </div>
          </td>
        </tr>
      `).join('');
    }
  }

  // 3. Category Data Breakdown for charts
  const dataByCat = categories.map(cat => {
    const catProducts = products.filter(p => p.category === cat);
    const catStock = catProducts.reduce((a, p) => a + p.stock_on_hand, 0);
    const catValue = catProducts.reduce((a, p) => a + (p.stock_on_hand * (parseFloat(p.price) || 0)), 0);
    const catLow   = catProducts.filter(p => p.status === 'Low Stock').length;
    const catOut   = catProducts.filter(p => p.status === 'Out of Stock').length;
    return {
      category: cat,
      count: catProducts.length,
      stock: catStock,
      value: catValue,
      lowStock: catLow,
      outOfStock: catOut,
      valuePercent: totalValuation > 0 ? (catValue / totalValuation) * 100 : 0
    };
  }).sort((a, b) => b.stock - a.stock);

  // 4. Render Category Breakdown Table (new)
  const catTbody = document.getElementById('reports-categories-tbody');
  if (catTbody) {
    if (dataByCat.length === 0) {
      catTbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:15px;color:var(--text-muted);">No categories recorded</td></tr>';
    } else {
      catTbody.innerHTML = dataByCat.map((item, idx) => {
        const color = CHART_COLORS[idx % CHART_COLORS.length];
        return `
          <tr>
            <td style="font-weight:700;">
              <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:8px;vertical-align:middle;"></span>
              ${escapeHtml(item.category)}
            </td>
            <td>${escapeHtml(item.count)} SKUs</td>
            <td style="font-family:'JetBrains Mono',monospace;">${escapeHtml(item.stock)} units</td>
            <td style="font-family:'JetBrains Mono',monospace;font-weight:600;color:var(--success-color);">₱${item.value.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
            <td>
              ${item.lowStock > 0 ? `<span style="color:var(--warning-color);font-size:12px;font-weight:600;"><i class="fa-solid fa-triangle-exclamation" style="margin-right:3px;"></i>${escapeHtml(item.lowStock)} low</span>` : ''}
              ${item.outOfStock > 0 ? `<span style="color:var(--danger-color);font-size:12px;font-weight:600;margin-left:8px;"><i class="fa-solid fa-circle-xmark" style="margin-right:3px;"></i>${escapeHtml(item.outOfStock)} out</span>` : ''}
              ${item.lowStock === 0 && item.outOfStock === 0 ? `<span style="color:var(--success-color);font-size:12px;">✓ OK</span>` : ''}
            </td>
            <td>
              <div style="display:flex;align-items:center;gap:8px;">
                <div style="flex-grow:1;background:var(--border-color);height:6px;border-radius:3px;overflow:hidden;min-width:60px;">
                  <div style="background:${color};width:${item.valuePercent}%;height:100%;"></div>
                </div>
                <span style="font-size:11px;font-weight:600;color:var(--text-secondary);width:38px;text-align:right;">${item.valuePercent.toFixed(1)}%</span>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    }
  }

  // 5. Render Charts
  if (window.Chart) {
    renderCanvasCharts(products, dataByCat, locationStatsArray);
  } else {
    renderFallbackSVGCharts(products, dataByCat, locationStatsArray);
  }
}

function renderCanvasCharts(products, dataByCat, locationStatsArray) {
  const ctxStock = document.getElementById('chart-stock-levels');
  const ctxCat = document.getElementById('chart-category-dist');

  if (!ctxStock || !ctxCat) return;

  if (chartInstanceStock) chartInstanceStock.destroy();
  if (chartInstanceCategory) chartInstanceCategory.destroy();

  const isDark = !document.body.classList.contains('light-theme');
  const textColor = isDark ? '#94a3b8' : '#475569';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

  // Chart 1: Location Stock Volumes & Valuations (Dual Axis Bar+Line)
  const sortedLocs = [...locationStatsArray].slice(0, 7);
  chartInstanceStock = new window.Chart(ctxStock, {
    type: 'bar',
    data: {
      labels: sortedLocs.map(l => l.name),
      datasets: [
        {
          label: 'Total Units',
          type: 'bar',
          data: sortedLocs.map(l => l.totalUnits),
          backgroundColor: sortedLocs.map((_, i) => CHART_COLORS_ALPHA[i % CHART_COLORS_ALPHA.length]),
          borderColor:      sortedLocs.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
          borderWidth: 1,
          borderRadius: 5,
          yAxisID: 'y'
        },
        {
          label: 'Valuation (₱)',
          type: 'line',
          data: sortedLocs.map(l => l.valuation),
          borderColor: '#10b981',
          backgroundColor: 'rgba(16,185,129,0.08)',
          borderWidth: 2,
          tension: 0.35,
          pointBackgroundColor: '#10b981',
          pointRadius: 4,
          pointHoverRadius: 6,
          fill: true,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, labels: { color: textColor, usePointStyle: true, pointStyleWidth: 10 } },
        tooltip: {
          callbacks: {
            label: ctx => ctx.dataset.label === 'Valuation (₱)'
              ? ` ₱${Number(ctx.raw).toLocaleString(undefined,{minimumFractionDigits:2})}`
              : ` ${Number(ctx.raw).toLocaleString()} units`
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: textColor } },
        y: {
          type: 'linear', display: true, position: 'left',
          grid: { color: gridColor },
          ticks: { color: textColor },
          title: { display: true, text: 'Quantity (Units)', color: textColor }
        },
        y1: {
          type: 'linear', display: true, position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: textColor, callback: val => '₱' + val.toLocaleString() },
          title: { display: true, text: 'Valuation (₱)', color: textColor }
        }
      }
    }
  });

  // Chart 2: Category Allocation — rich multi-color doughnut
  const totalStock = dataByCat.reduce((a, d) => a + d.stock, 0);
  chartInstanceCategory = new window.Chart(ctxCat, {
    type: 'doughnut',
    data: {
      labels: dataByCat.map(d => d.category),
      datasets: [{
        data: dataByCat.map(d => d.stock),
        backgroundColor: dataByCat.map((_, i) => CHART_COLORS_ALPHA[i % CHART_COLORS_ALPHA.length]),
        borderColor:      dataByCat.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
        borderWidth: 2,
        hoverOffset: 10
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: {
          position: 'right',
          labels: {
            color: textColor,
            usePointStyle: true,
            pointStyle: 'circle',
            pointStyleWidth: 10,
            padding: 14,
            font: { size: 12 },
            generateLabels: chart => {
              const ds = chart.data.datasets[0];
              return chart.data.labels.map((label, i) => ({
                text: `${label}  (${totalStock > 0 ? ((ds.data[i] / totalStock) * 100).toFixed(1) : 0}%)`,
                fillStyle: ds.backgroundColor[i],
                strokeStyle: ds.borderColor[i],
                lineWidth: 2,
                hidden: false,
                index: i,
                pointStyle: 'circle'
              }));
            }
          }
        },
        tooltip: {
          callbacks: {
            label: ctx => {
              const pct = totalStock > 0 ? ((ctx.raw / totalStock) * 100).toFixed(1) : 0;
              return ` ${ctx.label}: ${Number(ctx.raw).toLocaleString()} units (${pct}%)`;
            }
          }
        }
      }
    }
  });
}

function renderFallbackSVGCharts(products, dataByCat, locationStatsArray) {
  const stockCanvas = document.getElementById('chart-stock-levels');
  const catCanvas = document.getElementById('chart-category-dist');
  const parentStock = stockCanvas ? stockCanvas.parentNode : null;
  const parentCat = catCanvas ? catCanvas.parentNode : null;

  if (!parentStock || !parentCat) return;

  const sortedLocs = [...locationStatsArray].slice(0, 5);
  const maxVal = Math.max(...sortedLocs.map(l => l.totalUnits), 1);
  
  let barsHtml = sortedLocs.map((l, idx) => {
    const barHeight = (l.totalUnits / maxVal) * 150;
    const x = 30 + idx * 45;
    const y = 170 - barHeight;
    const color = CHART_COLORS[idx % CHART_COLORS.length];
    return `
      <rect x="${x}" y="${y}" width="25" height="${barHeight}" fill="${color}" rx="3"/>
      <text x="${x + 12}" y="190" font-size="9" fill="var(--text-secondary)" text-anchor="middle">${l.name}</text>
      <text x="${x + 12}" y="${y - 3}" font-size="8" fill="var(--text-primary)" text-anchor="middle">${l.totalUnits}</text>
    `;
  }).join('');

  parentStock.innerHTML = `
    <svg width="100%" height="100%" viewBox="0 0 260 200" style="background:transparent;">
      <line x1="20" y1="170" x2="250" y2="170" stroke="var(--border-color)" stroke-width="1"/>
      ${barsHtml}
    </svg>
  `;

  const totalStock = dataByCat.reduce((a, d) => a + d.stock, 0);
  let legendHtml = '';
  
  if (totalStock === 0) {
    parentCat.innerHTML = `<div style="color:var(--text-muted); text-align:center;">No data available</div>`;
  } else {
    dataByCat.forEach((d, idx) => {
      const percentage = d.stock / totalStock;
      const color = CHART_COLORS[idx % CHART_COLORS.length];
      legendHtml += `
        <div style="display:flex; align-items:center; gap:8px; font-size:12px; margin-bottom:5px;">
          <div style="width:12px; height:12px; border-radius:50%; background:${color}; flex-shrink:0;"></div>
          <span style="color:var(--text-secondary);">${escapeHtml(d.category)}: ${d.stock.toLocaleString()} (${Math.round(percentage*100)}%)</span>
        </div>
      `;
    });

    parentCat.innerHTML = `
      <div style="display:flex; align-items:center; height:100%; justify-content:space-around; width:100%; padding:8px;">
        <svg width="110" height="110" viewBox="0 0 36 36" style="transform: rotate(-90deg); flex-shrink:0;">
          <circle cx="18" cy="18" r="15.915" fill="transparent" stroke="var(--border-color)" stroke-width="4"></circle>
          ${dataByCat.map((d, idx) => {
            const pct = (d.stock / totalStock) * 100;
            const color = CHART_COLORS[idx % CHART_COLORS.length];
            const offset = dataByCat.slice(0, idx).reduce((acc, prev) => acc + (prev.stock / totalStock) * 100, 0);
            return `<circle cx="18" cy="18" r="15.915" fill="transparent" stroke="${color}" stroke-width="4" stroke-dasharray="${pct} ${100-pct}" stroke-dashoffset="${-offset}" style="transition:stroke-dasharray 0.4s;"></circle>`;
          }).join('')}
        </svg>
        <div style="display:flex; flex-direction:column; overflow:hidden;">
          ${legendHtml}
        </div>
      </div>
    `;
  }
}

// Settings section configurations lists
async function renderSettingsSection() {
  const settingsData = await WMSDatabase.getSettings();
  const users = await WMSDatabase.getUsers();
  const currentUser = WMSDatabase.getCurrentUser();

  // Settings inputs details
  document.getElementById('set-warehouse-name').value = settingsData.warehouseName || '';
  document.getElementById('set-low-threshold').value = settingsData.lowStockThreshold || 15;

  // Active Operator selector
  const userSelect = document.getElementById('set-active-operator');
  if (userSelect && currentUser) {
    userSelect.innerHTML = users.map(u => `<option value="${escapeHtml(u.username)}">${escapeHtml(u.name)} (${escapeHtml(u.role)})</option>`).join('');
    userSelect.value = currentUser.username;
  }

  // Category tags
  const catContainer = document.getElementById('settings-categories-list');
  if (catContainer) {
    catContainer.innerHTML = settingsData.categories.map(c => `
      <span class="tag-pill">
        ${escapeHtml(c)}
        <button onclick="removeCategorySetting('${escapeHtml(c)}')"><i class="fa-solid fa-xmark"></i></button>
      </span>
    `).join('');
  }

  // Location tags
  const locContainer = document.getElementById('settings-locations-list');
  if (locContainer) {
    locContainer.innerHTML = settingsData.locations.map(l => `
      <span class="tag-pill">
        ${escapeHtml(l)}
        <button onclick="removeLocationSetting('${escapeHtml(l)}')"><i class="fa-solid fa-xmark"></i></button>
      </span>
    `).join('');
  }
}

// Global View routing toggler
async function onViewActivated(viewId) {
  updateGlobalHeaderProfile();
  enforceUserPermissions();
  
  switch (viewId) {
    case 'view-dashboard':
      await renderDashboard();
      break;
    case 'view-inventory':
      await populateFilterDropdowns();
      await renderInventoryTable();
      break;
    case 'view-stock-in':
      await initStockInForm();
      break;
    case 'view-stock-out':
      await initStockOutForm();
      break;
    case 'view-barcode':
      await renderBarcodeSection();
      break;
    case 'view-reports':
      await populateExportFilterDropdowns();
      await renderReportsSection();
      break;
    case 'view-approvals':
      await renderApprovalsSection();
      break;
    case 'view-activity-log':
      await WMSActivityLog.init();
      break;
    case 'view-settings':
      await renderSettingsSection();
      break;
  }

  // Update topbar title to match the active view
  const viewTitles = {
    'view-dashboard':  'Dashboard',
    'view-inventory':  'Inventory',
    'view-stock-in':   'Stock In',
    'view-stock-out':  'Stock Out',
    'view-barcode':    'Barcode & Scan',
    'view-reports':    'Reports & Exports',
    'view-approvals':  'User Approvals',
    'view-activity-log': 'Activity Log',
    'view-settings':   'Settings'
  };
  const titleEl = document.getElementById('header-warehouse-title');
  if (titleEl && viewTitles[viewId]) titleEl.textContent = viewTitles[viewId];
}


// --- WINDOW ATTACHED GLOBAL CALLBACKS ---
// Hooked up globally to prevent inline onclick ReferenceErrors.

window.openAddForm = async function() {
  const addModalOverlay = document.getElementById('addProductModal');
  if (!addModalOverlay) return;
  const settingsData = await WMSDatabase.getSettings();
  document.getElementById('add-category').innerHTML = settingsData.categories.map(c => `<option value="${c}">${c}</option>`).join('');
  document.getElementById('add-location').innerHTML = settingsData.locations.map(l => `<option value="${l}">${l}</option>`).join('');
  addModalOverlay.classList.add('active');
};

window.closeAddForm = function() {
  const addModalOverlay = document.getElementById('addProductModal');
  if (addModalOverlay) {
    addModalOverlay.classList.remove('active');
    document.getElementById('add-product-form').reset();
  }
};

async function renderEditLocationRow(container, initialLoc = '', initialQty = 0) {
  const settingsData = await WMSDatabase.getSettings();
  const row = document.createElement('div');
  row.className = 'edit-location-row';
  row.style.display = 'flex';
  row.style.gap = '10px';
  row.style.alignItems = 'center';
  row.style.marginTop = '6px';

  const select = document.createElement('select');
  select.className = 'edit-row-location';
  select.required = true;
  select.style.flexGrow = '1';
  select.innerHTML = settingsData.locations.map(l => `<option value="${l}">${l}</option>`).join('');
  if (initialLoc) select.value = initialLoc;

  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'edit-row-qty';
  input.min = '1';
  input.required = true;
  input.style.width = '100px';
  input.value = initialQty || '';
  input.placeholder = 'Qty';

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'action-btn delete';
  delBtn.style.flexShrink = '0';
  delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
  delBtn.addEventListener('click', () => {
    row.remove();
    updateEditModalTotalStock();
  });

  select.addEventListener('change', updateEditModalTotalStock);
  input.addEventListener('input', updateEditModalTotalStock);

  row.appendChild(select);
  row.appendChild(input);
  row.appendChild(delBtn);
  container.appendChild(row);
  
  updateEditModalTotalStock();
}

function updateEditModalTotalStock() {
  const container = document.getElementById('edit-locations-container');
  if (!container) return;
  let total = 0;
  container.querySelectorAll('.edit-row-qty').forEach(input => {
    total += parseInt(input.value) || 0;
  });
  const totalInput = document.getElementById('edit-qty');
  if (totalInput) totalInput.value = total;
}

window.openEditProductModal = async function(sku) {
  const editModalOverlay = document.getElementById('editProductModal');
  const product = await getProductBySku(sku);
  if (!product || !editModalOverlay) return;

  selectedSkuForEdit = sku;

  const settingsData = await WMSDatabase.getSettings();
  document.getElementById('edit-category').innerHTML = settingsData.categories.map(c => `<option value="${c}">${c}</option>`).join('');

  document.getElementById('edit-sku-display').value = product.sku;
  document.getElementById('edit-name').value = product.name;
  document.getElementById('edit-category').value = product.category;
  document.getElementById('edit-reserved').value = product.reserved_stock;
  document.getElementById('edit-min-qty').value = product.reorder_level;
  document.getElementById('edit-price').value = product.price || 0;

  // Populate locations
  const container = document.getElementById('edit-locations-container');
  if (container) {
    container.innerHTML = '';
    const locObj = window.parseLocations ? window.parseLocations(product.location, product.stock_on_hand) : {};
    for (const [loc, qty] of Object.entries(locObj)) {
      await renderEditLocationRow(container, loc, qty);
    }
    updateEditModalTotalStock();
  }

  editModalOverlay.classList.add('active');
};

window.closeEditForm = function() {
  const editModalOverlay = document.getElementById('editProductModal');
  if (editModalOverlay) {
    editModalOverlay.classList.remove('active');
    document.getElementById('edit-product-form').reset();
    const container = document.getElementById('edit-locations-container');
    if (container) container.innerHTML = '';
    selectedSkuForEdit = null;
  }
};

window.openUserModal = function() {
  const userModal = document.getElementById('addUserModal');
  if (userModal) userModal.classList.add('active');
};

window.closeUserModal = function() {
  const userModal = document.getElementById('addUserModal');
  if (userModal) {
    userModal.classList.remove('active');
    const form = document.getElementById('add-user-form');
    if (form) form.reset();
  }
};

async function renderUsersSection() {
  const approvalsBody = document.getElementById('approvals-table-body');
  if (!approvalsBody) return;
  await renderApprovalsSection();
}

window.quickTransact = function(type, sku) {
  if (type === 'in') {
    const stockInNav = document.querySelector('[data-view="view-stock-in"]');
    if (stockInNav) stockInNav.click();
    setTimeout(() => {
      const sel = document.getElementById('stock-in-sku');
      if (sel) {
        sel.value = sku;
        sel.dispatchEvent(new Event('input'));
      }
    }, 150);
  } else {
    const stockOutNav = document.querySelector('[data-view="view-stock-out"]');
    if (stockOutNav) stockOutNav.click();
    setTimeout(() => {
      const sel = document.getElementById('stock-out-sku');
      if (sel) {
        sel.value = sku;
        sel.dispatchEvent(new Event('input'));
      }
    }, 150);
  }
};

// exportCSV kept for backward compatibility — redirects to exportFilteredCSV
window.exportCSV = function() { window.exportFilteredCSV(); };

window.exportJSON = async function() {
  try {
    const rawData = await WMSDatabase.exportData();
    const blob = new Blob([rawData], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `wms_database_backup_${new Date().toISOString().split('T')[0]}.json`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast("Database Backup downloaded successfully", "success");
  } catch (err) {
    showToast("Failed to generate backup: " + err.message, "error");
  }
};

window.addCategorySetting = async function() {
  const input = document.getElementById('new-category-input');
  const val = input.value.trim();
  if (!val) return;

  const settingsData = await WMSDatabase.getSettings();
  if (settingsData.categories.map(c => c.toLowerCase()).includes(val.toLowerCase())) {
    showToast('Category already exists.', 'warning');
    return;
  }

  settingsData.categories.push(val);
  await WMSDatabase.saveSettings({ categories: settingsData.categories });
  input.value = '';
  showToast(`Added category: ${val}`, 'success');
  await renderSettingsSection();
};

window.removeCategorySetting = async function(cat) {
  const settingsData = await WMSDatabase.getSettings();
  settingsData.categories = settingsData.categories.filter(c => c !== cat);
  await WMSDatabase.saveSettings({ categories: settingsData.categories });
  showToast(`Removed category: ${cat}`, 'success');
  await renderSettingsSection();
};

window.addLocationSetting = async function() {
  const input = document.getElementById('new-location-input');
  const val = input.value.trim();
  if (!val) return;

  const settingsData = await WMSDatabase.getSettings();
  if (settingsData.locations.map(l => l.toLowerCase()).includes(val.toLowerCase())) {
    showToast('Location already exists.', 'warning');
    return;
  }

  settingsData.locations.push(val);
  await WMSDatabase.saveSettings({ locations: settingsData.locations });
  input.value = '';
  showToast(`Added location bin: ${val}`, 'success');
  await renderSettingsSection();
};

window.removeLocationSetting = async function(loc) {
  const settingsData = await WMSDatabase.getSettings();
  settingsData.locations = settingsData.locations.filter(l => l !== loc);
  await WMSDatabase.saveSettings({ locations: settingsData.locations });
  showToast(`Removed location bin: ${loc}`, 'success');
  await renderSettingsSection();
};

window.resetDatabaseTrigger = async function() {
  if (confirm('CRITICAL WARNING: This will reset all products, logs, operators, and settings to original defaults on the database. Are you absolutely sure?')) {
    const success = await WMSDatabase.resetDatabase();
    if (success) {
      productsCache = null; // Clear cache
      const settingsData = await WMSDatabase.getSettings();
      currentTheme = settingsData.theme || 'dark';
      applyTheme(currentTheme);
      
      await onViewActivated('view-dashboard');
      const dashLink = document.querySelector('[data-view="view-dashboard"]');
      if (dashLink) dashLink.click();
      
      showToast('Database successfully restored to default seeds!', 'success');
    } else {
      showToast('Failed to reset database.', 'error');
    }
  }
};


// --- ELEMENT EVENT LISTENERS REGISTRATION ---
function setupEventListeners() {
  // Sidebar View Switcher Navigation
  document.querySelectorAll('.sidebar .menu a').forEach(link => {
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      
      // Deactivate all links and pages
      document.querySelectorAll('.sidebar .menu a').forEach(l => l.classList.remove('active'));
      document.querySelectorAll('.main .page-view').forEach(p => p.classList.remove('active'));
      
      // Activate selected
      link.classList.add('active');
      const viewId = link.getAttribute('data-view');
      const pageView = document.getElementById(viewId);
      if (pageView) {
        pageView.classList.add('active');
        await onViewActivated(viewId);
      }
    });
  });

  // Theme Toggle Button
  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', async () => {
      currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
      applyTheme(currentTheme);
      await WMSDatabase.saveSettings({ theme: currentTheme });
      showToast(`Switched theme to ${currentTheme} mode`, 'success');
      if (document.getElementById('view-reports').classList.contains('active')) {
        await renderReportsSection();
      }
    });
  }

  // Column headers sorting clicks
  document.querySelectorAll('th.sortable-header').forEach(th => {
    th.addEventListener('click', () => {
      const colName = th.getAttribute('data-sort');
      if (sortColumn === colName) {
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      } else {
        sortColumn = colName;
        sortDirection = 'asc';
      }
      renderInventoryTable();
    });
  });

  // Inventory forms submissions (Add Item)
  const addForm = document.getElementById('add-product-form');
  if (addForm) {
    addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const sku = document.getElementById('add-sku').value.trim().toUpperCase();
      const name = document.getElementById('add-name').value.trim();
      const category = document.getElementById('add-category').value;
      const location = document.getElementById('add-location').value;
      const stockOnHand = parseInt(document.getElementById('add-qty').value);
      const reservedStock = parseInt(document.getElementById('add-reserved').value);
      const reorderLevel = parseInt(document.getElementById('add-min-qty').value);
      const price = parseFloat(document.getElementById('add-price').value) || 0;

      if (!sku || !name || !category || !location || isNaN(stockOnHand) || isNaN(reservedStock) || isNaN(reorderLevel)) {
        showToast('All fields are required.', 'warning');
        return;
      }
      if (stockOnHand < 0 || reservedStock < 0 || reorderLevel < 0 || price < 0) {
        showToast('Quantities and price cannot be negative.', 'error');
        return;
      }
      if (reservedStock > stockOnHand) {
        showToast('Reserved stock cannot exceed stock on hand.', 'warning');
        return;
      }

      const existing = await getProductBySku(sku);
      if (existing) {
        showToast(`SKU ${sku} already exists!`, 'error');
        return;
      }

      try {
        await WMSDatabase.saveProduct({
          sku, name, category, location,
          stock_on_hand: 0,
          reserved_stock: reservedStock,
          reorder_level: reorderLevel,
          price
        });

        if (stockOnHand > 0) {
          await WMSDatabase.logTransaction({
            type: 'Stock In', sku, productName: name,
            category, quantity: stockOnHand,
            price, docRef: 'INIT-COUNT', location,
            notes: 'Initial stock intake on registration'
          });
        }

        productsCache = null;
        closeAddForm();
        showToast(`Registered product: ${sku}`, 'success');
        await renderInventoryTable();
        await renderDashboard();
      } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
      }
    });
  }

  // Inventory forms submissions (Edit Item)
  const editForm = document.getElementById('edit-product-form');
  if (editForm) {
    editForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const product = await getProductBySku(selectedSkuForEdit);
      if (!product) return;

      const newName     = document.getElementById('edit-name').value.trim();
      const newCategory = document.getElementById('edit-category').value;
      const newReserved = parseInt(document.getElementById('edit-reserved').value);
      const newMinQty   = parseInt(document.getElementById('edit-min-qty').value);
      const newPrice    = parseFloat(document.getElementById('edit-price').value) || 0;

      // Collect locations and validate
      const container = document.getElementById('edit-locations-container');
      const locObj = {};
      let locsCount = 0;
      let duplicateFound = false;

      container.querySelectorAll('.edit-location-row').forEach(row => {
        const select = row.querySelector('.edit-row-location');
        const input = row.querySelector('.edit-row-qty');
        if (!select || !input) return;

        const loc = select.value;
        const qty = parseInt(input.value) || 0;

        if (qty <= 0) return; // skip 0 quantities

        if (locObj[loc]) {
          duplicateFound = true;
        }
        locObj[loc] = qty;
        locsCount++;
      });

      if (duplicateFound) {
        showToast('Duplicate locations selected. Please consolidate location quantities.', 'error');
        return;
      }

      if (locsCount > 5) {
        showToast('Maximum of 5 locations allowed.', 'error');
        return;
      }

      // Calculate total new stock
      const newQty = Object.values(locObj).reduce((a, b) => a + b, 0);

      // Input Validation
      if (!newName || !newCategory || isNaN(newQty) || isNaN(newReserved) || isNaN(newMinQty)) {
        showToast('All fields are required.', 'warning');
        return;
      }

      if (newQty < 0 || newReserved < 0 || newMinQty < 0) {
        showToast('Quantities cannot be negative values.', 'error');
        return;
      }

      if (newReserved > newQty) {
        showToast('Warning: Reserved stock cannot exceed total stock on hand.', 'warning');
        return;
      }

      const oldQty = product.stock_on_hand;

      try {
        // Save details keeping old quantity so transaction adjustments audit trail updates it properly
        await WMSDatabase.saveProduct({
          sku: selectedSkuForEdit,
          name: newName,
          category: newCategory,
          location: JSON.stringify(locObj),
          stock_on_hand: newQty,
          reserved_stock: newReserved,
          reorder_level: newMinQty,
          price: newPrice
        });

        if (oldQty !== newQty) {
          const diff = newQty - oldQty;
          const firstLoc = Object.keys(locObj)[0] || 'N/A';
          await WMSDatabase.logTransaction({
            type: diff > 0 ? 'Stock In' : 'Stock Out',
            sku: selectedSkuForEdit,
            productName: newName,
            category: newCategory,
            quantity: Math.abs(diff),
            price: newPrice,
            docRef: 'ADJUSTMENT',
            location: firstLoc,
            notes: `Manual adjustment (${oldQty} → ${newQty})`
          });
        }

        productsCache = null; // Clear cache
        closeEditForm();
        showToast(`Successfully updated product: ${selectedSkuForEdit}`, 'success');
        await renderInventoryTable();
        await renderDashboard();
      } catch (err) {
        showToast(`Error updating product: ${err.message}`, 'error');
      }
    });
  }

  // Stock In Form Submit
  const stockInForm = document.getElementById('stock-in-form');
  if (stockInForm) {
    stockInForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = stockInForm.querySelector('button[type="submit"]');
      
      const sku      = document.getElementById('stock-in-sku').value.trim().toUpperCase();
      const qty      = parseInt(document.getElementById('stock-in-qty').value) || 0;
      const location = document.getElementById('stock-in-location').value;
      const price    = parseFloat(document.getElementById('stock-in-price').value) || 0;
      const notes    = document.getElementById('stock-in-notes').value.trim() || '';

      if (!sku)      { showToast('Please type or select a SKU first.', 'warning'); return; }
      if (qty <= 0)  { showToast('Quantity must be greater than 0.', 'error');     return; }
      if (!location) { showToast('Please specify a rack location.', 'warning');    return; }

      const product = await getProductBySku(sku);
      if (!product) {
        showToast(`SKU ${sku} does not exist in the catalog. Register it first!`, 'error');
        return;
      }

      setButtonLoading(submitBtn, true);
      try {
        await WMSDatabase.logTransaction({
          type: 'Stock In', sku, productName: product.name,
          category: product.category, quantity: qty,
          price, docRef: 'N/A', location, notes
        });
        productsCache = null;
        stockInForm.reset();
        document.getElementById('stock-in-details').innerHTML = '';
        showToast(`Stocked in ${qty} units of ${sku} at ${location}`, 'success');
        await initStockInForm();
        await renderDashboard();
      } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
      } finally {
        setButtonLoading(submitBtn, false);
      }
    });
  }

  // Stock Out Form Submit
  const stockOutForm = document.getElementById('stock-out-form');
  if (stockOutForm) {
    stockOutForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = stockOutForm.querySelector('button[type="submit"]');

      const sku      = document.getElementById('stock-out-sku').value.trim().toUpperCase();
      const qty      = parseInt(document.getElementById('stock-out-qty').value) || 0;
      const location = document.getElementById('stock-out-location').value;
      const price    = parseFloat(document.getElementById('stock-out-price').value) || 0;
      const notes    = document.getElementById('stock-out-notes').value.trim() || '';
      const docRef   = (document.getElementById('stock-out-doc-ref')?.value || '').trim() || 'N/A';

      if (!sku)      { showToast('Please type or select a SKU first.', 'warning');  return; }
      if (qty <= 0)  { showToast('Quantity must be greater than 0.', 'error');      return; }
      if (!location) { showToast('Please type a SKU first — location will be auto-populated.', 'warning'); return; }

      const product = await getProductBySku(sku);
      if (!product) {
        showToast(`SKU ${sku} does not exist in catalog.`, 'error');
        return;
      }

      if (product.available_stock < qty) {
        showToast(`Cannot dispatch. Only ${product.available_stock} units available (On Hand: ${product.stock_on_hand}, Reserved: ${product.reserved_stock}).`, 'error');
        return;
      }

      const locObj = window.parseLocations ? window.parseLocations(product.location, product.stock_on_hand) : {};
      const locQty = locObj[location] || 0;
      if (locQty < qty) {
        showToast(`Cannot dispatch. Only ${locQty} units at ${location}.`, 'error');
        return;
      }

      setButtonLoading(submitBtn, true);
      try {
        await WMSDatabase.logTransaction({
          type: 'Stock Out', sku, productName: product.name,
          category: product.category, quantity: qty,
          price, docRef, location, notes
        });
        productsCache = null;
        stockOutForm.reset();
        // Re-disable location select after reset
        const locSel = document.getElementById('stock-out-location');
        if (locSel) { locSel.innerHTML = '<option value="">Select a SKU first...</option>'; locSel.disabled = true; }
        document.getElementById('stock-out-details').innerHTML = '';
        showToast(`Dispatched ${qty} units of ${sku} from ${location}`, 'success');
        await initStockOutForm();
        await renderDashboard();
      } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
      } finally {
        setButtonLoading(submitBtn, false);
      }
    });
  }

  // File Upload listener (Excel & CSV batch imports)
  const fileImportInput = document.getElementById('xlsx-import-file');
  if (fileImportInput) {
    fileImportInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      if (!window.XLSX) {
        showToast("Excel parsing library (SheetJS) is not loaded. Cannot import file.", "error");
        fileImportInput.value = '';
        return;
      }

      showToast(`Uploading and parsing ${file.name}...`, 'warning');
      const reader = new FileReader();
      reader.onload = async (evt) => {
        try {
          const data = new Uint8Array(evt.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          const sheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(sheet);
          
          if (rows.length === 0) {
            showToast("The sheet is empty.", "warning");
            return;
          }

          // Map row columns dynamically
          const mappedProducts = [];
          const skippedRows = [];
          
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            let sku = null, name = null, category = 'Uncategorized', location = 'Pending';
            let stockOnHand = 0, reservedStock = 0, reorderLevel = 15;
            
            for (const key of Object.keys(row)) {
              const cleanKey = key.trim().toLowerCase();
              const val = row[key];
              if (['sku', 'item code', 'item_code', 'code'].includes(cleanKey)) sku = String(val).trim().toUpperCase();
              else if (['name', 'item name', 'item_name', 'product name', 'product_name'].includes(cleanKey)) name = String(val).trim();
              else if (['category', 'type', 'group'].includes(cleanKey)) category = String(val).trim();
              else if (['location', 'rack', 'bin', 'warehouse location'].includes(cleanKey)) location = String(val).trim();
              else if (['stock on hand', 'stock_on_hand', 'quantity', 'qty', 'stock'].includes(cleanKey)) stockOnHand = parseInt(val) || 0;
              else if (['reserved stock', 'reserved_stock', 'reserved', 'reserved qty'].includes(cleanKey)) reservedStock = parseInt(val) || 0;
              else if (['reorder level', 'reorder_level', 'min qty', 'min_qty', 'threshold', 'reorder'].includes(cleanKey)) reorderLevel = parseInt(val) || 15;
            }

            if (!sku) {
              skippedRows.push(`Row ${i + 2}: Missing SKU`);
              continue;
            }
            if (!name) {
              skippedRows.push(`Row ${i + 2} (${sku}): Missing Name`);
              continue;
            }

            if (stockOnHand < 0 || reservedStock < 0 || reorderLevel < 0) {
              skippedRows.push(`Row ${i + 2} (${sku}): Negative stock values are not allowed`);
              continue;
            }
            
            mappedProducts.push({
              sku,
              name,
              category,
              location,
              stock_on_hand: stockOnHand,
              reserved_stock: reservedStock,
              reorder_level: reorderLevel
            });
          }

          if (mappedProducts.length === 0) {
            showToast("No valid products were found to import.", "error");
            fileImportInput.value = '';
            return;
          }

          // Execute batch save
          await WMSDatabase.saveProductsBatch(mappedProducts);
          productsCache = null; // Force clear memory cache

          let msg = `Successfully imported ${mappedProducts.length} items.`;
          if (skippedRows.length > 0) {
            msg += ` Skipped ${skippedRows.length} invalid rows.`;
            console.warn("WMS Excel Import Skipped Logs:", skippedRows);
          }
          
          showToast(msg, skippedRows.length > 0 ? "warning" : "success");
          await renderInventoryTable();
          await renderDashboard();
        } catch (err) {
          console.error(err);
          showToast(`Error parsing file: ${err.message}`, 'error');
        }
        fileImportInput.value = ''; // Reset input
      };
      reader.readAsArrayBuffer(file);
    });
  }

  // Barcode Scanner Form triggers
  const scanBtn = document.getElementById('mock-scan-btn');
  const scanInput = document.getElementById('mock-scan-input');
  
  if (scanBtn) scanBtn.addEventListener('click', async () => await triggerMockScan());
  if (scanInput) {
    scanInput.addEventListener('keypress', async (e) => {
      if (e.key === 'Enter') {
        await triggerMockScan();
      }
    });
  }

  // User Operators Form Submit
  const userForm = document.getElementById('add-user-form');
  if (userForm) {
    userForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const username = document.getElementById('user-username').value.trim().toLowerCase();
      const name = document.getElementById('user-name').value.trim();
      const email = document.getElementById('user-email').value.trim();
      const role = document.getElementById('user-role').value;

      if (!username || !name || !email || !role) {
        showToast('All operator fields are required.', 'warning');
        return;
      }

      try {
        await WMSDatabase.saveUser({ username, name, email, role });
        closeUserModal();
        showToast(`Successfully registered operator: ${username}`, 'success');
        await loadAdminUsers();
      } catch (err) {
        showToast(`Error saving operator: ${err.message}`, 'error');
      }
    });
  }

  // General Settings Form Submit
  const settingsForm = document.getElementById('settings-general-form');
  if (settingsForm) {
    settingsForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const wName = document.getElementById('set-warehouse-name').value.trim();
      const lowThresh = parseInt(document.getElementById('set-low-threshold').value) || 15;
      const activeOpUsername = document.getElementById('set-active-operator').value;

      try {
        await WMSDatabase.saveSettings({
          warehouseName: wName,
          lowStockThreshold: lowThresh
        });

        const users = await WMSDatabase.getUsers();
        const targetUser = users.find(u => u.username === activeOpUsername);
        if (targetUser) {
          WMSDatabase.setCurrentUser(targetUser);
          updateGlobalHeaderProfile();
        }

        productsCache = null; // Settings threshold affects status colors
        document.getElementById('header-warehouse-title').textContent = wName;
        showToast('General settings saved successfully.', 'success');
      } catch (err) {
        showToast(`Error saving settings: ${err.message}`, 'error');
      }
    });
  }

  // Database Backup Upload restore trigger
  const fileUploader = document.getElementById('db-restore-file');
  if (fileUploader) {
    fileUploader.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async function(evt) {
        const success = await WMSDatabase.importData(evt.target.result);
        if (success) {
          productsCache = null; // Clear cache
          showToast('Database restored successfully from backup!', 'success');
          setTimeout(() => window.location.reload(), 1000);
        } else {
          showToast('Error: Invalid database backup file format.', 'error');
        }
      };
      reader.readAsText(file);
    });
  }

  // Filters inputs listeners — search uses debounce to avoid firing on every keystroke
  const invSearch = document.getElementById('inv-search');
  if (invSearch) invSearch.addEventListener('input', debounce(() => renderInventoryTable(), 220));
  
  const filterCat = document.getElementById('filter-category');
  if (filterCat) filterCat.addEventListener('change', () => renderInventoryTable());

  const filterLoc = document.getElementById('filter-location');
  if (filterLoc) filterLoc.addEventListener('change', () => renderInventoryTable());

  const filterStat = document.getElementById('filter-status');
  if (filterStat) filterStat.addEventListener('change', () => renderInventoryTable());

  const filterZero = document.getElementById('hide-zero-stock');
  if (filterZero) filterZero.addEventListener('change', () => renderInventoryTable());

  // Sidebar collapse toggle
  const sidebarToggle = document.getElementById('sidebar-toggle');
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
      document.body.classList.toggle('sidebar-collapsed');
      try {
        localStorage.setItem('wms_sidebar_collapsed',
          document.body.classList.contains('sidebar-collapsed') ? '1' : '0');
      } catch (e) { /* ignore */ }
    });
  }

  // Stock In history — SKU search
  const histSearch = document.getElementById('stock-in-history-search');
  if (histSearch) histSearch.addEventListener('input', debounce(() => renderStockInHistoryTable(), 200));

  // Smooth data entry — auto-uppercase SKU fields as user types, Enter advances to next field
  setupDataEntryUX();

  // Wire up Add Location button once
  const addLocBtn = document.getElementById('edit-add-location-btn');
  if (addLocBtn && !addLocBtn.dataset.wired) {
    addLocBtn.dataset.wired = '1';
    addLocBtn.addEventListener('click', () => {
      const container = document.getElementById('edit-locations-container');
      if (container) {
        if (container.querySelectorAll('.edit-location-row').length >= 5) {
          showToast('Maximum of 5 locations allowed for a product.', 'warning');
          return;
        }
        renderEditLocationRow(container);
      }
    });
  }

  setupInventoryVirtualScroll();
}

// ── Utility: debounce ──────────────────────────────────────────────
function debounce(fn, delay) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// ── Data Entry UX improvements ────────────────────────────────────
// • Auto-uppercase SKU inputs in real time
// • Enter key advances focus to next form field (instead of submitting)
// • Disable submit button during async processing to prevent double-submit
function setupDataEntryUX() {
  // Auto-uppercase SKU fields
  ['stock-in-sku', 'stock-out-sku', 'add-sku'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', function() {
      const pos = this.selectionStart;
      this.value = this.value.toUpperCase();
      this.setSelectionRange(pos, pos);
    });
  });

  // Enter key advances to next focusable element in forms (not submit)
  document.querySelectorAll('.wms-form input, .wms-form select').forEach(el => {
    el.addEventListener('keydown', function(e) {
      if (e.key !== 'Enter') return;
      // Let textarea and submit button handle Enter normally
      if (this.tagName === 'TEXTAREA') return;
      e.preventDefault();
      const focusable = Array.from(
        this.closest('form').querySelectorAll('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button[type="submit"]')
      );
      const idx = focusable.indexOf(this);
      if (idx >= 0 && idx < focusable.length - 1) {
        focusable[idx + 1].focus();
      }
    });
  });
}

// ── Button loading state helpers ──────────────────────────────────
function setButtonLoading(btn, loading) {
  if (!btn) return;
  if (loading) {
    btn.dataset.origText = btn.innerHTML;
    btn.classList.add('loading');
    btn.disabled = true;
    btn.innerHTML = '<span style="font-size:13px;">Processing...</span>';
  } else {
    btn.classList.remove('loading');
    btn.disabled = false;
    if (btn.dataset.origText) btn.innerHTML = btn.dataset.origText;
  }
}

// ── Export helpers ────────────────────────────────────────────────

// Inventory view — export exactly what's shown after current filters
window.exportFilteredCSV = function() {
  if (!vsFilteredData || vsFilteredData.length === 0) {
    showToast('No data to export with current filters.', 'warning');
    return;
  }
  const label = buildExportFilenameLabel();
  generateCSVDownload(vsFilteredData, `wms_inventory${label}_${today()}.csv`);
  showToast(`Exported ${vsFilteredData.length.toLocaleString()} rows as CSV`, 'success');
};

// Reports view — export with the independent export-filter selectors
window.exportReportCSV = async function() {
  const products = await getCachedProducts();
  const cat    = document.getElementById('export-filter-category')?.value || 'all';
  const loc    = document.getElementById('export-filter-location')?.value  || 'all';
  const status = document.getElementById('export-filter-status')?.value    || 'all';

  let filtered = products;
  if (cat !== 'all') filtered = filtered.filter(p => p.category === cat);
  if (loc !== 'all') {
    // location is a JSON map — check if this location key exists with stock > 0
    filtered = filtered.filter(p => {
      const locMap = window.parseLocations ? window.parseLocations(p.location, p.stock_on_hand) : {};
      return !!locMap[loc];
    });
  }
  if (status !== 'all') {
    const map = { 'in-stock': 'In Stock', 'low-stock': 'Low Stock', 'out-of-stock': 'Out of Stock' };
    filtered = filtered.filter(p => p.status === map[status]);
  }

  if (filtered.length === 0) {
    showToast('No data matches the selected export filters.', 'warning');
    return;
  }

  const parts = [cat !== 'all' ? cat : '', loc !== 'all' ? loc : '', status !== 'all' ? status : '']
    .filter(Boolean).join('_').replace(/\s+/g, '-') || 'all';
  generateCSVDownload(filtered, `wms_export_${parts}_${today()}.csv`);
  showToast(`Exported ${filtered.length.toLocaleString()} rows as CSV`, 'success');
};

function generateCSVDownload(rows, filename) {
  const header = 'SKU / Item Code,Item Name,Category,Warehouse Location,Stock On Hand,Reserved Stock,Available Stock,Reorder Level,Unit Price,Status,Last Updated\r\n';
  const body = rows.map(p => {
    const locDisplay = formatLocationDisplay(p.location, p.stock_on_hand);
    return `"${p.sku}","${String(p.name).replace(/"/g,'""')}","${p.category}","${locDisplay}",${p.stock_on_hand},${p.reserved_stock},${p.available_stock},${p.reorder_level},${Number(p.price||0).toFixed(2)},"${p.status}","${p.updated_at}"`;
  }).join('\r\n');

  const blob = new Blob([header + body], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href     = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function buildExportFilenameLabel() {
  const cat    = document.getElementById('filter-category')?.value    || 'all';
  const loc    = document.getElementById('filter-location')?.value    || 'all';
  const status = document.getElementById('filter-status')?.value      || 'all';
  const search = document.getElementById('inv-search')?.value?.trim() || '';
  const parts  = [
    cat    !== 'all' ? cat    : '',
    loc    !== 'all' ? loc    : '',
    status !== 'all' ? status : '',
    search ? `q-${search}`  : ''
  ].filter(Boolean);
  return parts.length ? '_' + parts.join('_').replace(/\s+/g, '-') : '';
}

function today() {
  return new Date().toISOString().split('T')[0];
}

// Populate the export filter dropdowns in Reports view
async function populateExportFilterDropdowns() {
  const [settingsData, products] = await Promise.all([
    WMSDatabase.getSettings(),
    getCachedProducts()
  ]);

  const catSel = document.getElementById('export-filter-category');
  const locSel = document.getElementById('export-filter-location');

  if (catSel) {
    const allCats = [...new Set([
      ...settingsData.categories,
      ...products.map(p => p.category).filter(Boolean)
    ])].sort();
    catSel.innerHTML = '<option value="all">All Categories</option>' +
      allCats.map(c => `<option value="${c}">${c}</option>`).join('');
  }

  if (locSel) {
    const productLocs = [];
    products.forEach(p => {
      const locObj = window.parseLocations ? window.parseLocations(p.location, p.stock_on_hand) : {};
      Object.keys(locObj).forEach(k => {
        if (k && !productLocs.includes(k)) {
          productLocs.push(k);
        }
      });
    });
    const allLocs = [...new Set([...settingsData.locations, ...productLocs])].sort();
    locSel.innerHTML = '<option value="all">All Locations</option>' +
      allLocs.map(l => `<option value="${l}">${l}</option>`).join('');
  }
}

// ============================================================
//   PROFILE MODAL LOGIC
// ============================================================

function openProfileModal() {
  const modal = document.getElementById('profileModal');
  if (!modal) return;
  modal.classList.add('active');
  const user = WMSDatabase.getCurrentUser();
  if (user) {
    const emailInput = document.getElementById('prof-email');
    if (emailInput) emailInput.value = user.email || '';
    const roleInput = document.getElementById('prof-role');
    if (roleInput) roleInput.value = user.role || 'Operator';
    const nameInput = document.getElementById('prof-name');
    if (nameInput) nameInput.value = user.name || '';
    const phoneInput = document.getElementById('prof-phone');
    if (phoneInput) phoneInput.value = user.phone || '';
    const deptInput = document.getElementById('prof-dept');
    if (deptInput) deptInput.value = user.department || '';
  }
  switchProfileTab('info');
}

function closeProfileModal() {
  const modal = document.getElementById('profileModal');
  if (modal) modal.classList.remove('active');
}

function switchProfileTab(tabId) {
  const tabs = ['info', 'password', 'admin'];
  tabs.forEach(t => {
    const btn = document.getElementById('ptab-' + t);
    const panel = document.getElementById('ppanel-' + t);
    if (btn && panel) {
      if (t === tabId) {
        btn.classList.add('active');
        btn.style.background = 'var(--accent)';
        btn.style.color = '#fff';
        panel.style.display = 'block';
      } else {
        btn.classList.remove('active');
        btn.style.background = 'transparent';
        btn.style.color = '';
        panel.style.display = 'none';
      }
    }
  });

  if (tabId === 'admin') {
    loadAdminUsers();
  }
}

async function saveProfileInfo(e) {
  e.preventDefault();
  const name = document.getElementById('prof-name').value.trim();
  const phone = document.getElementById('prof-phone').value.trim();
  const dept = document.getElementById('prof-dept').value.trim();

  if (window.WMSAuth && typeof WMSAuth.updateProfile === 'function') {
    try {
      await WMSAuth.updateProfile({ full_name: name, phone, department: dept });
      showToast('Profile updated successfully', 'success');
      updateGlobalHeaderProfile();
    } catch (err) {
      showToast('Failed to update profile: ' + err.message, 'error');
    }
  } else {
    const user = WMSDatabase.getCurrentUser();
    if (user) {
      user.name = name;
      user.phone = phone;
      user.department = dept;
      WMSDatabase.setCurrentUser(user);
      showToast('Profile updated locally', 'success');
      updateGlobalHeaderProfile();
    }
  }
}

async function saveProfilePassword(e) {
  e.preventDefault();
  const newPw = document.getElementById('prof-pw-new').value;
  const confirmPw = document.getElementById('prof-pw-confirm').value;

  if (newPw !== confirmPw) {
    showToast('Passwords do not match', 'error');
    return;
  }

  if (window.WMSAuth && typeof WMSAuth.updatePassword === 'function') {
    try {
      await WMSAuth.updatePassword(newPw);
      showToast('Password updated successfully', 'success');
      document.getElementById('profile-pw-form').reset();
    } catch (err) {
      showToast('Failed to update password: ' + err.message, 'error');
    }
  } else {
    showToast('Password update only works with live Supabase auth', 'warning');
  }
}

async function loadAdminUsers() {
  const listEl = document.getElementById('admin-users-list');
  if (!listEl) return;
  listEl.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px;">Loading...</div>';

  if (window.WMSAuth && typeof WMSAuth.getAllUsers === 'function') {
    try {
      const users = await WMSAuth.getAllUsers();
      if (!users || users.length === 0) {
        listEl.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px;">No users found</div>';
        return;
      }

      listEl.innerHTML = users.map(u => {
        const name   = escapeHtml(u.full_name || u.name || '(No name)');
        const email  = escapeHtml(u.email || '(No email)');
        const status = escapeHtml(u.status || 'unknown');
        const role   = escapeHtml(u.role || 'Operator');
        const id     = escapeHtml(u.id || '');
        return `
        <div style="background:var(--bg-primary); border:1px solid var(--border-color); padding:12px; border-radius:8px; display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-weight:600; font-size:14px; margin-bottom:4px;">${name}</div>
            <div style="font-size:12px; color:var(--text-muted);">${email} &bull; <span style="color:${u.status === 'pending' ? 'var(--warning-color)' : 'var(--text-secondary)'}">${status.toUpperCase()}</span></div>
          </div>
          <div style="display:flex; gap:8px;">
            ${u.status === 'pending' ? `<button class="btn btn-secondary" onclick="WMSAuth.approveUser('${id}').then(()=>loadAdminUsers())" style="padding:6px 10px; font-size:12px; color:var(--success-color); border-color:var(--success-color);"><i class="fa-solid fa-check"></i> Approve</button>` : ''}
            <select onchange="WMSAuth.changeUserRole('${id}', this.value).then(()=>loadAdminUsers())" style="padding:6px; font-size:12px; border-radius:6px; background:var(--bg-secondary); border:1px solid var(--border-color); color:var(--text-primary);">
              <option value="Operator" ${u.role === 'Operator' ? 'selected' : ''}>Operator</option>
              <option value="Administrator" ${u.role === 'Administrator' ? 'selected' : ''}>Administrator</option>
            </select>
          </div>
        </div>
      `}).join('');
    } catch (err) {
      listEl.innerHTML = `<div style="color:var(--danger-color);text-align:center;padding:20px;">Error loading users: ${escapeHtml(err.message)}</div>`;
    }
  } else {
    listEl.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px;">Admin functions require live Supabase auth</div>';
  }
}

// Render User Approvals Section (Admin only)
async function renderApprovalsSection() {
  const tbody = document.getElementById('approvals-table-body');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-muted);">Loading users...</td></tr>';
  
  if (window.WMSAuth && typeof WMSAuth.getAllUsers === 'function') {
    try {
      const users = await WMSAuth.getAllUsers();
      if (!users || users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-muted);">No users found.</td></tr>';
        return;
      }

      tbody.innerHTML = users.map(u => {
        const isBypass = u.id === '00000000-0000-0000-0000-000000000000';
        const name   = escapeHtml(u.full_name || u.name || '(No name)');
        const email  = escapeHtml(u.email || '(No email)');
        const status = escapeHtml(u.status || 'unknown');
        const role   = escapeHtml(u.role || 'Operator');
        const id     = escapeHtml(u.id || '');
        
        let statusBadgeClass = 'pending';
        if (u.status === 'approved') statusBadgeClass = 'approved';
        if (u.status === 'rejected') statusBadgeClass = 'rejected';

        let actionButtons = '';
        if (u.status === 'pending') {
          actionButtons = `
            <button class="btn btn-secondary approve-btn" data-id="${id}" style="padding:6px 10px; font-size:12px; color:var(--success-color); border-color:var(--success-color);"><i class="fa-solid fa-check"></i> Approve</button>
            <button class="btn btn-secondary reject-btn" data-id="${id}" style="padding:6px 10px; font-size:12px; color:var(--danger-color); border-color:var(--danger-color); margin-left:6px;"><i class="fa-solid fa-xmark"></i> Reject</button>
          `;
        } else {
          actionButtons = `
            <span style="font-size:12px; color:var(--text-muted);"><i class="fa-solid fa-circle-check"></i> Processed</span>
          `;
        }

        const roleDropdown = isBypass
          ? `<span style="font-weight:600; font-size:12px;">${role}</span>`
          : `
            <select class="role-select" data-id="${id}" style="padding:6px; font-size:12px; border-radius:6px; background:var(--bg-secondary); border:1px solid var(--border-color); color:var(--text-primary);">
              <option value="Operator" ${u.role === 'Operator' ? 'selected' : ''}>Operator</option>
              <option value="Administrator" ${u.role === 'Administrator' ? 'selected' : ''}>Administrator</option>
            </select>
          `;

        return `
          <tr>
            <td style="font-weight:700;">${name}</td>
            <td>${email}</td>
            <td><span class="status-badge ${statusBadgeClass}">${status.toUpperCase()}</span></td>
            <td>${roleDropdown}</td>
            <td>${isBypass ? '<span style="font-size:12px; color:var(--text-muted);">Default Admin</span>' : actionButtons}</td>
          </tr>
        `;
      }).join('');

      // Add event listeners
      tbody.querySelectorAll('.approve-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-id');
          try {
            await WMSAuth.approveUser(id);
            showToast('User approved successfully.', 'success');
            await renderApprovalsSection();
          } catch (e) {
            showToast('Failed to approve user: ' + e.message, 'error');
          }
        });
      });

      tbody.querySelectorAll('.reject-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-id');
          if (confirm('Are you sure you want to reject this request?')) {
            try {
              await WMSAuth.rejectUser(id);
              showToast('User rejected.', 'warning');
              await renderApprovalsSection();
            } catch (e) {
              showToast('Failed to reject user: ' + e.message, 'error');
            }
          }
        });
      });

      tbody.querySelectorAll('.role-select').forEach(sel => {
        sel.addEventListener('change', async () => {
          const id = sel.getAttribute('data-id');
          const newRole = sel.value;
          try {
            await WMSAuth.changeUserRole(id, newRole);
            showToast(`Role updated to ${newRole}.`, 'success');
            await renderApprovalsSection();
          } catch (e) {
            showToast('Failed to change role: ' + e.message, 'error');
          }
        });
      });

    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--danger-color);">Error loading users: ${escapeHtml(err.message)}</td></tr>`;
    }
  } else {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-muted);">User approval functions require live Supabase auth.</td></tr>';
  }
}

// Real-time Audit Log & Activity tracking
const WMSActivityLog = {
  activeLogs: [],
  subscription: null,

  async init() {
    const timeline = document.getElementById('realtime-activity-timeline');
    if (!timeline) return;

    timeline.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:25px;"><i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Loading activities...</div>';

    // Fetch initial logs
    const [txs, logins] = await Promise.all([
      WMSDatabase.getTransactions(),
      WMSDatabase.getLoginLogs()
    ]);

    // Format and combine
    const formattedTxs = txs.map(t => ({
      id: t.id,
      timestamp: t.timestamp,
      type: 'transaction',
      event: t.type,
      title: `${escapeHtml(t.type)}: ${escapeHtml(t.productName)} (${escapeHtml(t.sku)})`,
      desc: `Qty: ${escapeHtml(t.quantity)} &bull; Loc: ${escapeHtml(t.location)} &bull; Ref: ${escapeHtml(t.docRef)}${t.notes ? ` &bull; Notes: ${escapeHtml(t.notes)}` : ''}`,
      operator: escapeHtml(t.operator || 'System'),
      dateObj: new Date(t.timestamp)
    }));

    const formattedLogins = logins.map(l => ({
      id: l.id || l.timestamp,
      timestamp: l.timestamp,
      type: 'auth',
      event: l.event,
      title: `User ${l.event === 'login' ? 'Signed In' : 'Signed Out'}: ${escapeHtml(l.full_name)}`,
      desc: `Email: ${escapeHtml(l.email)} &bull; Timestamp: ${new Date(l.timestamp).toLocaleString()}`,
      operator: escapeHtml(l.full_name),
      dateObj: new Date(l.timestamp)
    }));

    // Combine and sort by date descending
    this.activeLogs = [...formattedTxs, ...formattedLogins]
      .sort((a, b) => b.dateObj - a.dateObj)
      .slice(0, 150); // limit to 150 items

    this.renderLogs();

    // Subscribe to realtime updates
    if (this.subscription) {
      this.subscription.unsubscribe();
    }

    this.subscription = WMSDatabase.subscribeToRealtimeLogs(
      // On new Transaction
      (newTx) => {
        const t = {
          id: newTx.id,
          timestamp: newTx.timestamp,
          type: 'transaction',
          event: newTx.type,
          title: `${escapeHtml(newTx.type)}: ${escapeHtml(newTx.product_name || newTx.productName)} (${escapeHtml(newTx.sku)})`,
          desc: `Qty: ${escapeHtml(newTx.quantity)} &bull; Loc: ${escapeHtml(newTx.location || 'N/A')} &bull; Ref: ${escapeHtml(newTx.doc_ref || newTx.docRef || 'N/A')}${newTx.notes ? ` &bull; Notes: ${escapeHtml(newTx.notes)}` : ''}`,
          operator: escapeHtml(newTx.operator || 'System'),
          dateObj: new Date(newTx.timestamp)
        };
        this.addRealtimeLog(t);
      },
      // On new Login/Logout
      (newLogin) => {
        const l = {
          id: newLogin.id || newLogin.timestamp,
          timestamp: newLogin.timestamp,
          type: 'auth',
          event: newLogin.event,
          title: `User ${newLogin.event === 'login' ? 'Signed In' : 'Signed Out'}: ${escapeHtml(newLogin.full_name)}`,
          desc: `Email: ${escapeHtml(newLogin.email)} &bull; Timestamp: ${new Date(newLogin.timestamp).toLocaleString()}`,
          operator: escapeHtml(newLogin.full_name),
          dateObj: new Date(newLogin.timestamp)
        };
        this.addRealtimeLog(l);
      }
    );
  },

  addRealtimeLog(item) {
    if (this.activeLogs.find(l => l.id === item.id)) return;
    
    this.activeLogs.unshift(item);
    this.activeLogs.sort((a, b) => b.dateObj - a.dateObj);
    this.activeLogs = this.activeLogs.slice(0, 150);

    this.renderLogs();
    
    // Notify admin
    showToast(`🔔 Real-time log: ${item.title}`, 'info');
  },

  renderLogs() {
    const timeline = document.getElementById('realtime-activity-timeline');
    if (!timeline) return;

    if (this.activeLogs.length === 0) {
      timeline.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:25px;">No activity logs recorded.</div>';
      return;
    }

    timeline.innerHTML = this.activeLogs.map(item => {
      let icon = 'fa-info';
      let themeClass = 'info';
      
      if (item.type === 'transaction') {
        if (item.event === 'Stock In') {
          icon = 'fa-arrow-down-long';
          themeClass = 'success';
        } else if (item.event === 'Stock Out') {
          icon = 'fa-arrow-up-long';
          themeClass = 'danger';
        } else {
          icon = 'fa-arrows-rotate';
          themeClass = 'warning';
        }
      } else if (item.type === 'auth') {
        if (item.event === 'login') {
          icon = 'fa-right-to-bracket';
          themeClass = 'accent';
        } else {
          icon = 'fa-right-from-bracket';
          themeClass = 'muted';
        }
      }

      const formattedTime = new Date(item.timestamp).toLocaleString();

      return `
        <div class="timeline-item ${themeClass}" style="display: flex; gap: 15px; margin-bottom: 20px; position: relative;">
          <div class="timeline-badge ${themeClass}" style="width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; color: #fff; box-shadow: 0 4px 10px rgba(0,0,0,0.15);">
            <i class="fa-solid ${icon}"></i>
          </div>
          <div class="timeline-card" style="flex-grow: 1; background: var(--bg-secondary); border: 1px solid var(--border-color); padding: 14px 18px; border-radius: var(--border-radius-md); box-shadow: var(--card-shadow);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; flex-wrap: wrap; gap: 8px;">
              <h4 style="font-size: 14px; font-weight: 700; color: var(--text-primary);">${item.title}</h4>
              <span style="font-size: 11px; color: var(--text-muted); font-weight: 500;">${formattedTime}</span>
            </div>
            <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 8px;">${item.desc}</p>
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span class="badge-operator" style="background: var(--border-color); color: var(--text-primary); padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;"><i class="fa-solid fa-user" style="margin-right:4px; font-size:9px;"></i>${item.operator}</span>
              <span style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-weight: 700; letter-spacing: 0.5px;">${item.type}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }
};
window.WMSActivityLog = WMSActivityLog;


// --- DOMCONTENTLOADED ENTRY POINT ---
document.addEventListener('DOMContentLoaded', async () => {
  // ── Clean up corrupt localStorage data from old offline mode ──
  // These keys are no longer used in online-only mode and can contain
  // malformed user rows that crash the admin UI
  ['wms_local_users', 'wms_local_products', 'wms_local_transactions',
   'wms_local_settings', 'wms_bypass_session', 'wms_bypass_profile',
   'wms_bypass_profile_saved'].forEach(key => localStorage.removeItem(key));

  // ── Auth guard: must be first ──────────────────────────────────
  if (window.WMSAuth) {
    const profile = await WMSAuth.init();
    if (!profile) return; // WMSAuth.init() already redirected to login
  }

  // Restore sidebar collapsed preference
  try {
    if (localStorage.getItem('wms_sidebar_collapsed') === '1') {
      document.body.classList.add('sidebar-collapsed');
    }
  } catch (e) { /* ignore */ }

  // ── Online-only guard ──────────────────────────────────────────
  if (!window._sb) {
    document.body.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;
                  background:#0b0f19;color:#f1f5f9;font-family:'Inter',sans-serif;gap:16px;text-align:center;padding:24px;">
        <i class="fa-solid fa-wifi" style="font-size:48px;color:#f87171;"></i>
        <h2 style="font-size:22px;font-weight:700;">No Database Connection</h2>
        <p style="color:#94a3b8;max-width:360px;">This system requires an internet connection to function.
           Please check your network and reload the page.</p>
        <button onclick="location.reload()" style="margin-top:8px;padding:12px 24px;background:#06b6d4;
               color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;">
          Retry Connection
        </button>
      </div>`;
    return;
  }

  await WMSDatabase.init();
  const settingsData = await WMSDatabase.getSettings();
  currentTheme = settingsData.theme || localStorage.getItem('wms_theme') || 'dark';
  applyTheme(currentTheme);

  // ── Realtime cross-tab cache invalidation ─────────────────────
  // db.js fires this event when any product row changes on Supabase
  window.addEventListener('wms:products-changed', () => {
    productsCache = null;
    // If inventory view is currently open, silently refresh it
    const invView = document.getElementById('view-inventory');
    if (invView && invView.classList.contains('active')) {
      getCachedProducts(true).then(() => renderInventoryTable()).catch(() => {});
    }
  });

  // Show skeleton KPIs immediately
  ['kpi-total-sku','kpi-total-stock','kpi-low-stock','kpi-out-of-stock'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<span class="skeleton kpi-skeleton"></span>';
  });

  updateGlobalHeaderProfile();
  enforceUserPermissions();
  setupEventListeners();

  // Show/hide admin-only UI elements
  if (window.WMSAuth && WMSAuth.isAdmin()) {
    const adminTab = document.getElementById('ptab-admin');
    if (adminTab) adminTab.style.display = '';
  }

  await renderDashboard();

  if (!productsCache) getCachedProducts().catch(() => {});
});
