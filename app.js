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

// --- WAVE 1-3: EXPIRY DATE VALIDATION ---
function validateExpiryDate(dateStr) {
  if (!dateStr) return { valid: true, message: '' }; // Optional field
  const expiryDate = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  expiryDate.setHours(0, 0, 0, 0);
  if (isNaN(expiryDate.getTime())) return { valid: false, message: 'Please enter a valid date' };
  if (expiryDate < today) return { valid: false, message: 'Expiry date cannot be in the past' };
  return { valid: true, message: '' };
}

// Calculate days until expiry
function calculateDaysUntilExpiry(expiryDateStr) {
  if (!expiryDateStr) return null;
  const expiryDate = new Date(expiryDateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  expiryDate.setHours(0, 0, 0, 0);
  return Math.floor((expiryDate - today) / (1000 * 60 * 60 * 24));
}

// Render expiry status badge for table
function renderExpiryStatusCell(product) {
  if (!product.expiry_date) {
    return '<span class="badge badge-neutral">No Expiry</span>';
  }
  const daysRemaining = calculateDaysUntilExpiry(product.expiry_date);
  if (daysRemaining < 0) {
    return `<span class="badge badge-danger"><i class="fa-solid fa-exclamation-triangle"></i> Expired</span>`;
  } else if (daysRemaining <= 7) {
    return `<span class="badge badge-critical"><i class="fa-solid fa-fire"></i> ${daysRemaining}d (Critical)</span>`;
  } else if (daysRemaining <= 30) {
    return `<span class="badge badge-warning"><i class="fa-solid fa-clock"></i> ${daysRemaining}d</span>`;
  } else {
    return `<span class="badge badge-success"><i class="fa-solid fa-check"></i> ${daysRemaining}d</span>`;
  }
}

// --- WAVE 2: PRICE VALIDATION & FORMATTING ---
function validatePrice(priceString) {
  // Empty field is invalid
  if (!priceString || priceString.trim() === '') {
    return { valid: false, formatted: '', message: 'Price is required' };
  }

  const trimmed = priceString.trim();
  const num = parseFloat(trimmed);

  // Check if it's a valid number
  if (isNaN(num)) {
    return { valid: false, formatted: '', message: 'Price must be a valid number' };
  }

  // Check if negative
  if (num < 0) {
    return { valid: false, formatted: '', message: 'Price must be positive' };
  }

  // Check if zero
  if (num === 0) {
    return { valid: false, formatted: '', message: 'Price must be greater than 0' };
  }

  // Check decimal places (max 2)
  const decimalRegex = /^\d+(\.\d{0,2})?$/;
  if (!decimalRegex.test(trimmed)) {
    return { valid: false, formatted: '', message: 'Price must have maximum 2 decimal places' };
  }

  // Check range (0.01 to 9999.99)
  if (num < 0.01 || num > 9999.99) {
    return { valid: false, formatted: '', message: 'Price must be between $0.01 and $9999.99' };
  }

  // Valid: return formatted price with $ symbol
  const formatted = formatCurrencyDisplay(num);
  return { valid: true, formatted: formatted, message: '' };
}

function formatCurrencyDisplay(price) {
  const num = parseFloat(price);
  if (isNaN(num)) return '$0.00';
  
  return '$' + num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

// Detect price changes
async function detectPriceChange(sku, newPrice) {
  const product = await getProductBySku(sku);
  if (!product) return null;
  const oldPrice = parseFloat(product.price) || 0;
  const newPriceNum = parseFloat(newPrice) || 0;
  if (oldPrice === newPriceNum) return null;
  return { sku, oldPrice, newPrice: newPriceNum, isIncrease: newPriceNum > oldPrice };
}

// --- SESSION & ACTIVITY TRACKING ---
let currentSessionId = null;
const ACTIVITY_UPDATE_INTERVAL = 30000; // 30 seconds
let activityUpdateTimer = null;
let nearExpiryCurrentPage = 1;
let nearExpiryData = [];
const NEAR_EXPIRY_PAGE_SIZE = 5;

// Session expiration constants
const SESSION_INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutes in milliseconds
const SESSION_MAX_LIFETIME = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

async function initializeSession() {
  const user = WMSDatabase.getCurrentUser();
  if (!user) return;
  try {
    // Session methods will be in db.js when online
    if (WMSDatabase.createSession) {
      const sessionId = await WMSDatabase.createSession(user.username, user.name);
      currentSessionId = sessionId;
      localStorage.setItem('wms_session_id', sessionId);
      startActivityTracking();
    }
  } catch (error) {
    console.error('[WMS] Session init error:', error);
  }
}

async function checkSessionExpiration() {
  const sessionId = localStorage.getItem('wms_session_id');
  const sessionStart = localStorage.getItem('wms_session_start');
  
  if (!sessionId || !sessionStart) {
    // No session data stored — this shouldn't happen after login, but handle gracefully
    return true; // Treat as not expired
  }

  try {
    // Fetch current session from database
    if (!WMSDatabase.getSession) {
      console.warn('[WMS] getSession method not available, skipping expiration check');
      return true; // Cannot check, allow session to continue
    }

    const session = await WMSDatabase.getSession(sessionId);
    
    if (!session) {
      // Session not found in database — it was invalidated or never created
      console.log('[WMS] Session not found in database');
      return false;
    }

    const now = new Date();
    const lastActivityTime = new Date(session.last_activity);
    const createdTime = new Date(session.login_time || session.created_at);
    
    // Check inactivity timeout: 30 minutes of no activity
    const inactivityDuration = now - lastActivityTime;
    if (inactivityDuration > SESSION_INACTIVITY_TIMEOUT) {
      console.log('[WMS] Session expired due to inactivity:', inactivityDuration, 'ms');
      return false;
    }

    // Check maximum lifetime: 24 hours since creation
    const sessionDuration = now - createdTime;
    if (sessionDuration > SESSION_MAX_LIFETIME) {
      console.log('[WMS] Session expired due to max lifetime exceeded:', sessionDuration, 'ms');
      return false;
    }

    // Session is still valid
    return true;
  } catch (error) {
    console.error('[WMS] Session expiration check error:', error);
    // On error, allow session to continue rather than forcing logout
    return true;
  }
}

async function forceLogout() {
  try {
    // End session in database
    const sessionId = localStorage.getItem('wms_session_id');
    if (sessionId && WMSDatabase.endSession) {
      try {
        await WMSDatabase.endSession(sessionId);
      } catch (e) {
        console.error('[WMS] Error ending session:', e);
      }
    }
  } catch (error) {
    console.error('[WMS] Force logout error:', error);
  }

  // Clear session data
  localStorage.removeItem('wms_session_id');
  localStorage.removeItem('wms_session_start');
  localStorage.removeItem('wms_user_id');
  
  // Clear activity tracking
  if (activityUpdateTimer) {
    clearInterval(activityUpdateTimer);
    activityUpdateTimer = null;
  }

  // Show toast and redirect
  showToast('Your session has expired. Please log in again.', 'warning');
  
  // Delay redirect slightly to ensure toast displays
  setTimeout(() => {
    if (WMSAuth && WMSAuth.signOut) {
      WMSAuth.signOut();
    } else {
      window.location.replace('login.html');
    }
  }, 500);
}

function startActivityTracking() {
  document.addEventListener('mousemove', debounce(() => updateUserActivity('page_interaction'), 5000));
  document.addEventListener('keydown', debounce(() => updateUserActivity('page_interaction'), 5000));
  document.addEventListener('click', debounce(() => updateUserActivity('page_interaction'), 5000));
  activityUpdateTimer = setInterval(updateUserActivity, ACTIVITY_UPDATE_INTERVAL);
}

async function updateUserActivity(actionType = 'page_interaction') {
  if (!currentSessionId) return;
  try {
    if (WMSDatabase.updateSessionActivity) {
      await WMSDatabase.updateSessionActivity(currentSessionId, actionType);
    }
  } catch (error) {
    console.error('[WMS] Activity update error:', error);
  }
}

function debounce(func, delay) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), delay);
  };
}

// Near-expiry widget functions
async function loadNearExpiryProducts() {
  try {
    if (WMSDatabase.getNearExpiryProducts) {
      nearExpiryData = await WMSDatabase.getNearExpiryProducts(30);
      nearExpiryData.sort((a, b) => new Date(a.expiry_date) - new Date(b.expiry_date));
    } else {
      // Fallback if method not available
      const products = await getCachedProducts();
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      nearExpiryData = products.filter(p => {
        if (!p.expiry_date) return false;
        const expDate = new Date(p.expiry_date);
        expDate.setHours(0, 0, 0, 0);
        const daysLeft = Math.floor((expDate - now) / (1000 * 60 * 60 * 24));
        return daysLeft <= 30 && daysLeft >= -1;
      }).sort((a, b) => new Date(a.expiry_date) - new Date(b.expiry_date));
    }
    nearExpiryCurrentPage = 1;
    renderNearExpiryPage();
  } catch (error) {
    console.error('[WMS] Near-expiry load error:', error);
  }
}

function renderNearExpiryPage() {
  const start = (nearExpiryCurrentPage - 1) * NEAR_EXPIRY_PAGE_SIZE;
  const items = nearExpiryData.slice(start, start + NEAR_EXPIRY_PAGE_SIZE);
  const container = document.getElementById('near-expiry-list');
  
  if (!container) return;
  
  if (items.length === 0) {
    container.innerHTML = '<p class="text-muted" style="padding:12px;text-align:center;color:var(--text-muted);">No products expiring within 30 days.</p>';
    const pageInfo = document.getElementById('near-expiry-page-info');
    if (pageInfo) pageInfo.textContent = 'Page 1 of 1';
    return;
  }
  
  container.innerHTML = items.map(p => {
    const daysLeft = calculateDaysUntilExpiry(p.expiry_date);
    const urgency = daysLeft <= 7 ? 'critical' : 'warning';
    const expDate = new Date(p.expiry_date).toLocaleDateString();
    return `
      <div class="near-expiry-item urgency-${urgency}" style="padding:12px;border-left:4px solid ${urgency === 'critical' ? '#ef4444' : '#f59e0b'};margin-bottom:8px;background:rgba(0,0,0,0.2);border-radius:6px;display:flex;justify-content:space-between;align-items:center;">
        <div style="flex:1;">
          <div style="font-weight:600;font-size:14px;">${escapeHtml(p.name)}</div>
          <small style="color:var(--text-muted);font-size:12px;">${escapeHtml(p.sku)} • Stock: ${escapeHtml(p.stock_on_hand)}</small>
        </div>
        <div style="text-align:right;">
          <span class="badge" style="background:${urgency === 'critical' ? '#ef4444' : '#f59e0b'};color:white;padding:4px 8px;border-radius:4px;font-size:12px;font-weight:600;">${daysLeft}d</span>
          <small style="color:var(--text-muted);display:block;font-size:11px;margin-top:2px;">${expDate}</small>
        </div>
      </div>
    `;
  }).join('');
  
  const totalPages = Math.ceil(nearExpiryData.length / NEAR_EXPIRY_PAGE_SIZE);
  const pageInfo = document.getElementById('near-expiry-page-info');
  if (pageInfo) pageInfo.textContent = `Page ${nearExpiryCurrentPage} of ${totalPages}`;
  
  const prevBtn = document.getElementById('near-expiry-prev');
  const nextBtn = document.getElementById('near-expiry-next');
  if (prevBtn) prevBtn.disabled = nearExpiryCurrentPage === 1;
  if (nextBtn) nextBtn.disabled = nearExpiryCurrentPage >= totalPages;
}

function nearExpiryNextPage() {
  const totalPages = Math.ceil(nearExpiryData.length / NEAR_EXPIRY_PAGE_SIZE);
  if (nearExpiryCurrentPage < totalPages) {
    nearExpiryCurrentPage++;
    renderNearExpiryPage();
  }
}

function nearExpiryPrevPage() {
  if (nearExpiryCurrentPage > 1) {
    nearExpiryCurrentPage--;
    renderNearExpiryPage();
  }
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
// CRITICAL FIX: Prefer WMSAuth.profile over WMSDatabase.getCurrentUser() to ensure
// we always display the CURRENT logged-in user, not stale cached data that shows "Earl Administrator"
function updateGlobalHeaderProfile() {
  // Prefer WMSAuth profile (live from authentication) over WMSDatabase cache
  const authProfile = window.WMSAuth && WMSAuth.profile ? WMSAuth.profile : null;
  const user = authProfile
    ? {
        name: authProfile.full_name || authProfile.name || 'User',
        role: authProfile.role || 'Operator'
      }
    : WMSDatabase.getCurrentUser();

  const profileBadge = document.getElementById('global-profile-initials');
  const headerGreeting = document.getElementById('global-header-username');
  const headerRole = document.getElementById('global-header-role');
  
  if (user && profileBadge && headerGreeting) {
    const initials = user.name.split(' ').filter(Boolean).map(n => n[0]).join('').toUpperCase().substring(0, 2);
    profileBadge.textContent = initials || '??';
    headerGreeting.textContent = user.name;
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

  // Near-expiry KPI: products expiring within 30 days (or already expired)
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const nearExpiryCount = products.filter(p => {
    if (!p.expiry_date) return false;
    const expDate = new Date(p.expiry_date);
    expDate.setHours(0, 0, 0, 0);
    const daysLeft = Math.floor((expDate - now) / (1000 * 60 * 60 * 24));
    return daysLeft <= 30;
  }).length;

  // Render KPIs
  document.getElementById('kpi-total-sku').textContent = totalItems.toLocaleString();
  document.getElementById('kpi-total-stock').textContent = totalStock.toLocaleString();
  document.getElementById('kpi-low-stock').textContent = lowStockCount.toLocaleString();
  document.getElementById('kpi-out-of-stock').textContent = outOfStockCount.toLocaleString();
  const nearExpiryEl = document.getElementById('kpi-near-expiry');
  if (nearExpiryEl) nearExpiryEl.textContent = nearExpiryCount.toLocaleString();

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
    <td>${renderExpiryStatusCell(p)}</td>
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
  const filterExpiryStatus = document.getElementById('filter-expiry-status').value;
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
    // Expiry status filtering
    if (filterExpiryStatus !== 'all') {
      if (!p.expiry_date) {
        if (filterExpiryStatus !== 'no-expiry') return false;
      } else {
        const daysLeft = calculateDaysUntilExpiry(p.expiry_date);
        if (filterExpiryStatus === 'expired' && daysLeft >= 0) return false;
        if (filterExpiryStatus === 'near-expiry' && (daysLeft > 30 || daysLeft < 0)) return false;
        if (filterExpiryStatus === 'ok' && daysLeft <= 30) return false;
      }
    }
    if (hideZeroStock && p.stock_on_hand <= 0) return false;
    return true;
  });

  // 2. Sort - handle expiry_status special sorting
  filtered.sort((a, b) => {
    let valA = a[sortColumn] ?? '';
    let valB = b[sortColumn] ?? '';
    
    if (sortColumn === 'expiry_status') {
      const daysA = calculateDaysUntilExpiry(a.expiry_date);
      const daysB = calculateDaysUntilExpiry(b.expiry_date);
      const aVal = daysA === null ? 999999 : daysA;
      const bVal = daysB === null ? 999999 : daysB;
      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    }
    
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
    tbody.innerHTML = '<tr><td colspan="13" style="text-align:center;padding:35px;color:var(--text-muted);font-size:14px;">No products found matching the criteria.</td></tr>';
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
      openDeleteProductConfirm(sku);
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
              <span><strong>Unit Price:</strong> <span style="color:var(--accent);font-weight:700;">${formatCurrencyDisplay(product.price||0)}</span></span>
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

        // Auto-fill the price field if empty and show current price
        const priceEl = document.getElementById('stock-in-unit-cost');
        const currentPriceDisplay = document.getElementById('current-price-display');
        if (currentPriceDisplay) {
          currentPriceDisplay.textContent = formatCurrencyDisplay(product.price||0);
        }
        if (priceEl && !priceEl.value && product.price) {
          priceEl.value = product.price;
        }
      } else if (details) {
        details.innerHTML = `<div style="font-size:12px;color:var(--text-muted);"><i class="fa-solid fa-info-circle"></i> Type a valid SKU to view details...</div>`;
      }
    });
  }

  // Wire up real-time price validation
  const priceEl = document.getElementById('stock-in-unit-cost');
  if (priceEl && !priceEl.dataset.wired) {
    priceEl.dataset.wired = '1';
    
    // Validate on blur (when user leaves the field)
    priceEl.addEventListener('blur', () => {
      const priceValue = priceEl.value.trim();
      const errorEl = document.getElementById('price-error');
      
      // Clear error on blur if empty (optional field when blank)
      if (!priceValue) {
        errorEl.style.display = 'none';
        errorEl.textContent = '';
        return;
      }
      
      const validation = validatePrice(priceValue);
      if (!validation.valid) {
        errorEl.textContent = validation.message;
        errorEl.style.display = 'block';
      } else {
        errorEl.style.display = 'none';
        errorEl.textContent = '';
      }
    });
    
    // Validate on change (real-time feedback as user types)
    priceEl.addEventListener('change', () => {
      const priceValue = priceEl.value.trim();
      const errorEl = document.getElementById('price-error');
      
      if (!priceValue) {
        errorEl.style.display = 'none';
        return;
      }
      
      const validation = validatePrice(priceValue);
      if (!validation.valid) {
        errorEl.textContent = validation.message;
        errorEl.style.display = 'block';
      } else {
        // Auto-format valid prices
        priceEl.value = validation.formatted.replace('$', '');
        errorEl.style.display = 'none';
      }
    });
  }

  // Wire up real-time expiry date validation
  const expiryDateEl = document.getElementById('stock-in-expiry-date');
  if (expiryDateEl && !expiryDateEl.dataset.wired) {
    expiryDateEl.dataset.wired = '1';
    
    // Validate on blur (when user leaves the field)
    expiryDateEl.addEventListener('blur', () => {
      const expiryValue = expiryDateEl.value.trim();
      const errorEl = document.getElementById('expiry-date-error');
      
      // Clear error on blur if empty (optional field when blank)
      if (!expiryValue) {
        errorEl.style.display = 'none';
        errorEl.textContent = '';
        return;
      }
      
      const validation = validateExpiryDate(expiryValue);
      if (!validation.valid) {
        errorEl.textContent = validation.message;
        errorEl.style.display = 'block';
      } else {
        errorEl.style.display = 'none';
        errorEl.textContent = '';
      }
    });
    
    // Validate on change (real-time feedback)
    expiryDateEl.addEventListener('change', () => {
      const expiryValue = expiryDateEl.value.trim();
      const errorEl = document.getElementById('expiry-date-error');
      
      if (!expiryValue) {
        errorEl.style.display = 'none';
        errorEl.textContent = '';
        return;
      }
      
      const validation = validateExpiryDate(expiryValue);
      if (!validation.valid) {
        errorEl.textContent = validation.message;
        errorEl.style.display = 'block';
      } else {
        errorEl.style.display = 'none';
        errorEl.textContent = '';
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
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:15px;">${query ? `No Stock In records for SKU &quot;<strong>${escapeHtml(query)}</strong>&quot;.` : 'No recent Stock In logs.'}</td></tr>`;
    return;
  }

  tbody.innerHTML = inTx.slice(0, 100).map(tx => {
    const locInfo = tx.location && tx.location !== 'N/A'
      ? ` <span style="font-size:11px;color:var(--text-muted);font-weight:500;">&nbsp;@ ${escapeHtml(tx.location)}</span>` : '';
    const priceInfo = tx.price > 0
      ? `<span style="color:var(--text-muted);font-size:11px;"> &nbsp;·&nbsp; ₱${Number(tx.price).toLocaleString(undefined,{minimumFractionDigits:2})}/unit</span>` : '';
    return `
      <tr class="clickable-transaction-row" style="cursor:pointer;" data-tx-timestamp="${escapeHtml(tx.timestamp)}" data-tx-type="${escapeHtml(tx.type)}" data-tx-sku="${escapeHtml(tx.sku)}" data-tx-product="${escapeHtml(tx.productName)}" data-tx-qty="${escapeHtml(tx.quantity)}" data-tx-location="${escapeHtml(tx.location)}" data-tx-doc-ref="${escapeHtml(tx.docRef || 'N/A')}" data-tx-operator="${escapeHtml(tx.operator || '')}" data-tx-price="${escapeHtml(tx.price || 0)}" data-tx-notes="${escapeHtml(tx.notes || '')}">
        <td style="font-size:12px;color:var(--text-muted);">${new Date(tx.timestamp).toLocaleString()}</td>
        <td style="font-weight:700;font-family:monospace;">${escapeHtml(tx.sku)}</td>
        <td>${escapeHtml(tx.productName)}${tx.category ? ` <span style="font-size:11px;color:var(--text-muted);">(${escapeHtml(tx.category)})</span>` : ''}</td>
        <td style="color:var(--success-color);font-weight:700;">+${escapeHtml(tx.quantity)}${locInfo}${priceInfo}</td>
        <td style="font-size:12px;color:var(--text-muted);font-family:monospace;">${escapeHtml(tx.docRef || 'N/A')}</td>
        <td style="font-size:12px;color:var(--text-muted);">${escapeHtml(tx.operator || '')}</td>
      </tr>
    `;
  }).join('');

  // Attach click listeners to all transaction rows
  document.querySelectorAll('#stock-in-history-tbody .clickable-transaction-row').forEach(row => {
    row.addEventListener('click', function() {
      const tx = {
        timestamp: this.dataset.txTimestamp,
        type: this.dataset.txType,
        sku: this.dataset.txSku,
        productName: this.dataset.txProduct,
        quantity: this.dataset.txQty,
        location: this.dataset.txLocation,
        docRef: this.dataset.txDocRef,
        operator: this.dataset.txOperator,
        price: this.dataset.txPrice,
        notes: this.dataset.txNotes
      };
      openTransactionDetailModal(tx);
    });
  });
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
      <tr class="clickable-transaction-row" style="cursor:pointer;" data-tx-timestamp="${escapeHtml(tx.timestamp)}" data-tx-type="${escapeHtml(tx.type)}" data-tx-sku="${escapeHtml(tx.sku)}" data-tx-product="${escapeHtml(tx.productName)}" data-tx-qty="${escapeHtml(tx.quantity)}" data-tx-location="${escapeHtml(tx.location)}" data-tx-doc-ref="${escapeHtml(tx.docRef || 'N/A')}" data-tx-operator="${escapeHtml(tx.operator || '')}" data-tx-price="${escapeHtml(tx.price || 0)}" data-tx-notes="${escapeHtml(tx.notes || '')}">
        <td style="font-size:12px;color:var(--text-muted);">${new Date(tx.timestamp).toLocaleString()}</td>
        <td style="font-weight:700;font-family:monospace;">${escapeHtml(tx.sku)}</td>
        <td>${escapeHtml(tx.productName)}${tx.category ? ` <span style="font-size:11px;color:var(--text-muted);">(${escapeHtml(tx.category)})</span>` : ''}</td>
        <td style="color:var(--warning-color);font-weight:700;">-${escapeHtml(tx.quantity)}${locInfo}${priceInfo}</td>
        <td style="font-size:12px;color:var(--text-muted);">${escapeHtml(tx.operator || '')}</td>
      </tr>
    `;
  }).join('');

  // Attach click listeners to all transaction rows
  document.querySelectorAll('#stock-out-history-tbody .clickable-transaction-row').forEach(row => {
    row.addEventListener('click', function() {
      const tx = {
        timestamp: this.dataset.txTimestamp,
        type: this.dataset.txType,
        sku: this.dataset.txSku,
        productName: this.dataset.txProduct,
        quantity: this.dataset.txQty,
        location: this.dataset.txLocation,
        docRef: this.dataset.txDocRef,
        operator: this.dataset.txOperator,
        price: this.dataset.txPrice,
        notes: this.dataset.txNotes
      };
      openTransactionDetailModal(tx);
    });
  });
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

// Redirect from topbar search to barcode scanner with proper async handling
async function handleTopbarScanRedirect(sku) {
  const authProfile = window.WMSAuth && WMSAuth.profile ? WMSAuth.profile : null;
  const isOperator = authProfile ? authProfile.role === 'Operator' : false;
  
  if (isOperator) {
    showToast('Use the Inventory search to look up SKUs.', 'warning');
    return;
  }
  
  // Switch to barcode view and wait for it to complete
  const barcodeLink = document.querySelector('[data-view="view-barcode"]');
  if (barcodeLink) {
    barcodeLink.click();
    // Wait a brief moment for the view to switch
    await new Promise(r => setTimeout(r, 100));
  }
  
  // Now safely set the scanner input and trigger scan
  const scanInput = document.getElementById('mock-scan-input');
  if (scanInput) {
    scanInput.value = sku;
    await triggerMockScan();
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

// ── Near Expiration Section ─────────────────────────────────────────────────
window.renderExpirySection = async function renderExpirySection() {
  const products = await getCachedProducts();
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  // Populate expiry category filter (once, only when empty)
  const catFilter = document.getElementById('expiry-category-filter');
  if (catFilter && catFilter.options.length <= 1) {
    const cats = [...new Set(products.map(p => p.category).filter(Boolean))].sort();
    cats.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      catFilter.appendChild(opt);
    });
  }

  const daysFilter   = parseInt(document.getElementById('expiry-days-filter')?.value   ?? '30');
  const searchQuery  = (document.getElementById('expiry-search')?.value ?? '').toLowerCase().trim();
  const statusFilter = document.getElementById('expiry-status-filter')?.value ?? 'all';
  const catFilterVal = catFilter?.value ?? 'all';

  // Update threshold label
  const thresholdLabel = document.getElementById('expiry-threshold-label');
  if (thresholdLabel) thresholdLabel.textContent = daysFilter === 0 ? '∞' : daysFilter;

  // Only products that carry an expiry date
  const withExpiry = products.filter(p => p.expiry_date);

  // Enrich each with computed daysLeft + expiryStatus
  const enriched = withExpiry.map(p => {
    const expDate = new Date(p.expiry_date);
    expDate.setHours(0, 0, 0, 0);
    const daysLeft = Math.floor((expDate - now) / (1000 * 60 * 60 * 24));
    let expiryStatus = 'safe';
    if (daysLeft < 0)        expiryStatus = 'expired';
    else if (daysLeft <= 7)  expiryStatus = 'critical';
    else if (daysLeft <= 30) expiryStatus = 'near';
    return { ...p, daysLeft, expiryStatus, expDate };
  });

  // ── KPI strip (always global – not affected by table filters) ──
  const expiredCount  = enriched.filter(p => p.expiryStatus === 'expired').length;
  const criticalCount = enriched.filter(p => p.expiryStatus === 'critical').length;
  const nearCount     = enriched.filter(p => p.expiryStatus === 'near').length;
  const safeCount     = enriched.filter(p => p.expiryStatus === 'safe').length;

  const setKpi = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setKpi('expiry-count-expired',  expiredCount);
  setKpi('expiry-count-critical', criticalCount);
  setKpi('expiry-count-near',     nearCount);
  setKpi('expiry-count-ok',       safeCount);

  // ── Table filters ──
  let filtered = enriched;

  // 0 = show only already-expired; otherwise show ≤ daysFilter days remaining
  if (daysFilter === 0) {
    filtered = filtered.filter(p => p.expiryStatus === 'expired');
  } else {
    filtered = filtered.filter(p => p.daysLeft <= daysFilter);
  }

  if (searchQuery) {
    filtered = filtered.filter(p =>
      p.sku.toLowerCase().includes(searchQuery) ||
      p.name.toLowerCase().includes(searchQuery)
    );
  }

  if (statusFilter !== 'all') {
    filtered = filtered.filter(p => p.expiryStatus === statusFilter);
  }

  if (catFilterVal !== 'all') {
    filtered = filtered.filter(p => p.category === catFilterVal);
  }

  // Sort: most urgent first (most negative / fewest days left at top)
  filtered.sort((a, b) => a.daysLeft - b.daysLeft);

  // ── Render table ──
  const tbody = document.getElementById('expiry-table-body');
  if (!tbody) return;

  const authProfile = window.WMSAuth && WMSAuth.profile ? WMSAuth.profile : null;
  const isOperator  = authProfile ? authProfile.role === 'Operator' : false;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--text-muted);">
      <i class="fa-solid fa-calendar-check" style="font-size:28px;opacity:0.35;display:block;margin-bottom:10px;"></i>
      No products match the selected filters.
    </td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(p => {
    let statusLabel = '', badgeClass = '', daysDisplay = '';

    if (p.expiryStatus === 'expired') {
      statusLabel = 'Expired';
      badgeClass  = 'expiry-badge-expired';
      daysDisplay = `<span style="color:var(--danger-color);font-weight:700;font-family:monospace;">${Math.abs(p.daysLeft)}d overdue</span>`;
    } else if (p.expiryStatus === 'critical') {
      statusLabel = 'Critical';
      badgeClass  = 'expiry-badge-critical';
      daysDisplay = `<span style="color:#f97316;font-weight:700;font-family:monospace;">${p.daysLeft}d left</span>`;
    } else if (p.expiryStatus === 'near') {
      statusLabel = 'Near Expiry';
      badgeClass  = 'expiry-badge-near';
      daysDisplay = `<span style="color:var(--warning-color);font-weight:700;font-family:monospace;">${p.daysLeft}d left</span>`;
    } else {
      statusLabel = 'Safe';
      badgeClass  = 'expiry-badge-safe';
      daysDisplay = `<span style="color:var(--success-color);font-weight:700;font-family:monospace;">${p.daysLeft}d left</span>`;
    }

    const expiryFormatted = new Date(p.expiry_date).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric'
    });

    const actionsHtml = isOperator
      ? `<span style="font-size:11px;color:var(--text-muted);font-style:italic;">View only</span>`
      : `<button class="action-btn edit-expiry-btn" data-sku="${escapeHtml(p.sku)}" title="Edit Product"><i class="fa-solid fa-pen"></i></button>`;

    return `<tr>
      <td style="font-weight:700;font-family:monospace;">${escapeHtml(p.sku)}</td>
      <td style="font-weight:500;">${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.category)}</td>
      <td style="font-size:12px;"><i class="fa-solid fa-location-dot" style="margin-right:4px;font-size:11px;color:var(--text-muted);"></i>${escapeHtml(formatLocationDisplay(p.location, p.stock_on_hand))}</td>
      <td style="font-weight:600;">${escapeHtml(p.stock_on_hand)}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:12px;">${expiryFormatted}</td>
      <td>${daysDisplay}</td>
      <td><span class="expiry-status-badge ${badgeClass}">${statusLabel}</span></td>
      <td class="admin-only"><div class="actions">${actionsHtml}</div></td>
    </tr>`;
  }).join('');

  // Wire up edit buttons in the rendered slice
  tbody.querySelectorAll('.edit-expiry-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await openEditProductModal(btn.getAttribute('data-sku'));
    });
  });
};

// Export near-expiry report as CSV
window.exportExpiryCSV = async function() {
  const products = await getCachedProducts();
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const withExpiry = products
    .filter(p => p.expiry_date)
    .map(p => {
      const expDate = new Date(p.expiry_date);
      expDate.setHours(0, 0, 0, 0);
      const daysLeft = Math.floor((expDate - now) / (1000 * 60 * 60 * 24));
      let expiryStatus = 'Safe';
      if (daysLeft < 0)        expiryStatus = 'Expired';
      else if (daysLeft <= 7)  expiryStatus = 'Critical';
      else if (daysLeft <= 30) expiryStatus = 'Near Expiry';
      return { ...p, daysLeft, expiryStatus };
    })
    .sort((a, b) => a.daysLeft - b.daysLeft);

  if (withExpiry.length === 0) {
    showToast('No products with expiry dates to export.', 'warning');
    return;
  }

  const header = 'SKU,Product Name,Category,Warehouse Location,Stock On Hand,Expiry Date,Days Left,Expiry Status\r\n';
  const body = withExpiry.map(p =>
    `"${p.sku}","${String(p.name).replace(/"/g,'""')}","${p.category}","${formatLocationDisplay(p.location, p.stock_on_hand)}",${p.stock_on_hand},"${p.expiry_date}",${p.daysLeft},"${p.expiryStatus}"`
  ).join('\r\n');

  const blob = new Blob([header + body], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href     = url;
  link.download = `wms_expiry_report_${today()}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  showToast(`Exported ${withExpiry.length} expiry records as CSV`, 'success');
};

// Settings section configurations lists
async function renderSettingsSection() {
  const settingsData = await WMSDatabase.getSettings();
  const users = await WMSDatabase.getUsers();
  const currentUser = WMSDatabase.getCurrentUser();

  // Settings inputs details
  document.getElementById('set-warehouse-name').value = settingsData.warehouseName || '';
  document.getElementById('set-low-threshold').value = settingsData.lowStockThreshold || 15;

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
      await loadNearExpiryProducts();
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
    case 'view-expiry':
      await renderExpirySection();
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
    'view-dashboard':    'Dashboard',
    'view-inventory':    'Inventory',
    'view-stock-in':     'Stock In',
    'view-stock-out':    'Stock Out',
    'view-barcode':      'Barcode & Scan',
    'view-reports':      'Reports & Exports',
    'view-expiry':       'Near Expiration',
    'view-approvals':    'User Approvals',
    'view-activity-log': 'Activity Log',
    'view-settings':     'Settings'
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

  // Populate expiry date
  const editExpiryInput = document.getElementById('edit-expiry');
  if (editExpiryInput) editExpiryInput.value = product.expiry_date || '';

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

// ── BULK STOCK IN / STOCK OUT ─────────────────────────────────────
let bulkRowCounter = 0;
async function addBulkRow(type) {
  const tbody = document.getElementById(`bulk-${type}-rows`);
  if (!tbody) return;
  const rowId = `bulk-row-${type}-${++bulkRowCounter}`;
  const settingsData = await WMSDatabase.getSettings();
  const locOptions = settingsData.locations.map(l => `<option value="${l}">${l}</option>`).join('');
  const tr = document.createElement('tr');
  tr.id = rowId;
  if (type === 'in') {
    tr.innerHTML = `<td><input type="text" class="bulk-sku" list="stock-in-sku-list" placeholder="SKU" autocomplete="off" style="width:100%;"></td><td><select class="bulk-location" style="width:100%;">${locOptions}</select></td><td><input type="number" class="bulk-qty" min="1" placeholder="Qty" style="width:90px;"></td><td><button type="button" class="action-btn delete" onclick="document.getElementById('${rowId}').remove()"><i class="fa-solid fa-trash"></i></button></td>`;
  } else {
    tr.innerHTML = `<td><input type="text" class="bulk-sku" list="stock-out-sku-list" placeholder="SKU" autocomplete="off" style="width:100%;"></td><td><select class="bulk-location" style="width:100%;"><option value="">Type SKU first</option></select></td><td><input type="number" class="bulk-qty" min="1" placeholder="Qty" style="width:90px;"></td><td><button type="button" class="action-btn delete" onclick="document.getElementById('${rowId}').remove()"><i class="fa-solid fa-trash"></i></button></td>`;
  }
  tbody.appendChild(tr);
  // Stock Out: populate the per-row location dropdown from that row's SKU
  if (type === 'out') {
    const skuInput = tr.querySelector('.bulk-sku');
    const locSelect = tr.querySelector('.bulk-location');
    skuInput.addEventListener('input', async () => {
      const sku = skuInput.value.trim().toUpperCase();
      const product = await getProductBySku(sku);
      if (!product) {
        locSelect.innerHTML = '<option value="">SKU not found</option>';
        return;
      }
      const locMap = window.parseLocations ? window.parseLocations(product.location, product.stock_on_hand) : {};
      const available = Object.entries(locMap).filter(([, qty]) => qty > 0);
      locSelect.innerHTML = available.length
        ? available.map(([loc, qty]) => `<option value="${loc}">${loc} (${qty})</option>`).join('')
        : '<option value="">No stock available</option>';
    });
  }
}
async function submitBulkStockIn()  { await submitBulkBatch('in'); }
async function submitBulkStockOut() { await submitBulkBatch('out'); }
// Processes rows SEQUENTIALLY (not in parallel) — prevents two rows for the
// same SKU/location from racing each other and reading stale stock counts.
async function submitBulkBatch(type) {
  const tbody = document.getElementById(`bulk-${type}-rows`);
  const resultsEl = document.getElementById(`bulk-${type}-results`);
  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll('tr'));
  if (rows.length === 0) {
    showToast('Add at least one row before submitting.', 'warning');
    return;
  }
  const outcomes = []; // { row, sku, status, message }
  for (const row of rows) {
    const sku      = row.querySelector('.bulk-sku')?.value.trim().toUpperCase();
    const location = row.querySelector('.bulk-location')?.value;
    const qty      = parseInt(row.querySelector('.bulk-qty')?.value) || 0;
    if (!sku && !qty) continue; // skip fully blank rows silently
    try {
      if (!sku) throw new Error('SKU is required.');
      if (qty <= 0) throw new Error('Quantity must be greater than 0.');
      if (!location) throw new Error('Location is required.');
      const product = await getProductBySku(sku);
      if (!product) throw new Error(`SKU ${sku} not found in catalog.`);
      if (type === 'out') {
        const locMap = window.parseLocations ? window.parseLocations(product.location, product.stock_on_hand) : {};
        const locQty = locMap[location] || 0;
        if (locQty < qty) throw new Error(`Only ${locQty} units available at ${location}.`);
      }
      await WMSDatabase.logTransaction({
        type: type === 'in' ? 'Stock In' : 'Stock Out',
        sku, productName: product.name, category: product.category,
        quantity: qty, location
      });
      outcomes.push({ row, sku, status: 'success', message: `${qty} units @ ${location}` });
    } catch (err) {
      outcomes.push({ row, sku: sku || '(blank)', status: 'error', message: err.message });
    }
  }
  // Refresh dependent views once, after the whole batch finishes
  productsCache = null;
  await renderDashboard();
  if (type === 'in') await renderStockInHistoryTable(); else await renderStockOutHistoryTable();
  await updateSkuDatalists();
  const successCount = outcomes.filter(o => o.status === 'success').length;
  const failCount = outcomes.filter(o => o.status === 'error').length;
  if (resultsEl) {
    resultsEl.innerHTML = outcomes.length === 0 ? '' : `<div style="font-weight:700;margin-bottom:8px;">Batch complete: <span style="color:var(--success-color);">${successCount} succeeded</span>${failCount > 0 ? `, <span style="color:var(--danger-color);">${failCount} failed</span>` : ''}</div>${outcomes.map(o => `<div style="padding:6px 10px;border-radius:6px;margin-bottom:4px;font-size:12px;background:${o.status === 'success' ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)'};color:${o.status === 'success' ? 'var(--success-color)' : 'var(--danger-color)'};"><strong>${escapeHtml(o.sku)}</strong> — ${escapeHtml(o.message)}</div>`).join('')}`;
  }
  if (outcomes.length > 0) {
    showToast(`Batch: ${successCount} succeeded, ${failCount} failed`, failCount > 0 ? 'warning' : 'success');
  } else {
    showToast('No rows to process.', 'warning');
  }
  // Remove only successful rows — failed/blank rows stay for correction
  outcomes.forEach(o => { if (o.status === 'success') o.row.remove(); });
}
window.addBulkRow = addBulkRow;
window.submitBulkStockIn = submitBulkStockIn;
window.submitBulkStockOut = submitBulkStockOut;

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
  // Use typed confirmation modal instead of browser confirm() for safety
  openResetConfirmModal();
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
      const expiryDate = document.getElementById('add-expiry')?.value || null;

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
          price,
          expiry_date: expiryDate || null
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
      const newExpiry   = document.getElementById('edit-expiry')?.value || null;

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
          price: newPrice,
          expiry_date: newExpiry || null
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
      
      const sku       = document.getElementById('stock-in-sku').value.trim().toUpperCase();
      const qty       = parseInt(document.getElementById('stock-in-qty').value) || 0;
      const location  = document.getElementById('stock-in-location').value;
      const priceInput = document.getElementById('stock-in-unit-cost').value.trim();
      const expiryDate = document.getElementById('stock-in-expiry-date').value.trim();
      const notes     = document.getElementById('stock-in-notes').value.trim() || '';
      const docRef    = (document.getElementById('stock-in-doc-ref')?.value || '').trim() || 'N/A';

      if (!sku)      { showToast('Please type or select a SKU first.', 'warning'); return; }
      if (qty <= 0)  { showToast('Quantity must be greater than 0.', 'error');     return; }
      if (!location) { showToast('Please specify a rack location.', 'warning');    return; }
      
      // Check price validation error
      const priceError = document.getElementById('price-error');
      if (priceError && priceError.style.display !== 'none' && priceError.textContent) {
        showToast(`Price error: ${priceError.textContent}`, 'error');
        return;
      }
      
      // Validate expiry date
      const expiryDateError = document.getElementById('expiry-date-error');
      if (expiryDateError && expiryDateError.style.display !== 'none' && expiryDateError.textContent) {
        showToast(`Expiry date error: ${expiryDateError.textContent}`, 'error');
        return;
      }
      
      if (expiryDate) {
        const expiryValidation = validateExpiryDate(expiryDate);
        if (!expiryValidation.valid) {
          showToast(`Expiry date error: ${expiryValidation.message}`, 'error');
          return;
        }
      }
      
      // Validate and parse price
      let parsedPrice = 0;
      if (priceInput) {
        const priceValidation = validatePrice(priceInput);
        if (!priceValidation.valid) {
          priceError.textContent = priceValidation.message;
          priceError.style.display = 'block';
          showToast(`Price error: ${priceValidation.message}`, 'error');
          return;
        }
        parsedPrice = parseFloat(priceInput);
      }

      const product = await getProductBySku(sku);
      if (!product) {
        showToast(`SKU ${sku} does not exist in the catalog. Register it first!`, 'error');
        return;
      }

      // Detect price changes and log if different
      if (parsedPrice > 0 && parsedPrice !== (product.price || 0)) {
        const priceChange = await detectPriceChange(sku, parsedPrice);
        if (priceChange) {
          const changeMsg = priceChange.isIncrease 
            ? `Price increased from ${formatCurrencyDisplay(priceChange.oldPrice)} to ${formatCurrencyDisplay(priceChange.newPrice)}`
            : `Price decreased from ${formatCurrencyDisplay(priceChange.oldPrice)} to ${formatCurrencyDisplay(priceChange.newPrice)}`;
          if (WMSDatabase.logPriceChange) {
            WMSDatabase.logPriceChange(sku, priceChange.oldPrice, priceChange.newPrice, 'Stock In Update', 'System');
          }
          console.log('[WMS] Price change detected:', changeMsg);
        }
      }

      // Log expiry alert if applicable
      if (expiryDate && WMSDatabase.logExpiryAlert) {
        const daysLeft = calculateDaysUntilExpiry(expiryDate);
        let alertType = 'ok';
        if (daysLeft < 0) alertType = 'expired';
        else if (daysLeft <= 7) alertType = 'critical';
        else if (daysLeft <= 30) alertType = 'near-expiry';
        WMSDatabase.logExpiryAlert(sku, expiryDate, alertType);
      }

      setButtonLoading(submitBtn, true);
      try {
        await WMSDatabase.logTransaction({
          type: 'Stock In', sku, productName: product.name,
          category: product.category, quantity: qty,
          price: parsedPrice, docRef, location, notes
        });
        
        // If price or expiry changed, update the product
        if ((parsedPrice > 0 && parsedPrice !== (product.price || 0)) || expiryDate) {
          await WMSDatabase.saveProduct({
            ...product,
            price: parsedPrice > 0 ? parsedPrice : product.price,
            expiry_date: expiryDate || product.expiry_date
          });
        }
        
        productsCache = null;
        stockInForm.reset();
        document.getElementById('stock-in-details').innerHTML = '';
        const priceError = document.getElementById('price-error');
        if (priceError) priceError.style.display = 'none';
        const expiryError = document.getElementById('expiry-date-error');
        if (expiryError) expiryError.style.display = 'none';
        showToast(`Stocked in ${qty} units of ${sku} at ${location}`, 'success');
        await initStockInForm();
        await renderDashboard();
        await loadNearExpiryProducts();
      } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
      } finally {
        setButtonLoading(submitBtn, false);
      }
    });

    // Real-time expiry date validation on blur and change
    const expiryDateInput = document.getElementById('stock-in-expiry-date');
    const expiryDateError = document.getElementById('expiry-date-error');
    if (expiryDateInput) {
      expiryDateInput.addEventListener('blur', () => {
        const dateValue = expiryDateInput.value.trim();
        if (dateValue) {
          const validation = validateExpiryDate(dateValue);
          if (validation.valid) {
            expiryDateError.style.display = 'none';
            expiryDateError.textContent = '';
          } else {
            expiryDateError.style.display = 'block';
            expiryDateError.textContent = validation.message;
          }
        } else {
          // Clear error if field is empty (optional field)
          expiryDateError.style.display = 'none';
          expiryDateError.textContent = '';
        }
      });

      expiryDateInput.addEventListener('change', () => {
        const dateValue = expiryDateInput.value.trim();
        if (dateValue) {
          const validation = validateExpiryDate(dateValue);
          if (validation.valid) {
            expiryDateError.style.display = 'none';
            expiryDateError.textContent = '';
          } else {
            expiryDateError.style.display = 'block';
            expiryDateError.textContent = validation.message;
          }
        } else {
          // Clear error if field is empty (optional field)
          expiryDateError.style.display = 'none';
          expiryDateError.textContent = '';
        }
      });
    }
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

      try {
        await WMSDatabase.saveSettings({
          warehouseName: wName,
          lowStockThreshold: lowThresh
        });

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

  const filterExpiry = document.getElementById('filter-expiry-status');
  if (filterExpiry) filterExpiry.addEventListener('change', () => renderInventoryTable());

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

  // Prefer the live Supabase auth profile — fall back to localStorage cache
  const authProfile = window.WMSAuth && WMSAuth.profile ? WMSAuth.profile : null;
  const user = authProfile
    ? {
        email:      authProfile.email      || '',
        role:       authProfile.role        || 'Operator',
        name:       authProfile.full_name   || '',
        phone:      authProfile.phone       || '',
        department: authProfile.department  || ''
      }
    : WMSDatabase.getCurrentUser();

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

  if (!name) { showToast('Full name is required.', 'warning'); return; }

  if (window.WMSAuth && typeof WMSAuth.updateProfile === 'function') {
    try {
      await WMSAuth.updateProfile({ full_name: name, phone, department: dept });
      showToast('Profile updated successfully', 'success');
      // Sync sidebar footer with the new name/role immediately
      updateGlobalHeaderProfile();
      if (window.WMSAuth) WMSAuth._renderHeaderUser();
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

  const currentUserId = window.WMSAuth?.session?.user?.id || window.WMSAuth?.profile?.id || '';

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
        const joined = u.created_at ? new Date(u.created_at).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' }) : '—';
        const isSelf = u.id === currentUserId;
        const statusColor = u.status === 'approved' ? 'var(--success-color)' : u.status === 'pending' ? 'var(--warning-color)' : 'var(--danger-color)';
        return `
        <div style="background:var(--bg-primary); border:1px solid var(--border-color); padding:12px 14px; border-radius:8px; display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600; font-size:14px; margin-bottom:3px;">${name} ${isSelf ? '<span style="font-size:10px;color:var(--accent);font-weight:700;">(You)</span>' : ''}</div>
            <div style="font-size:12px; color:var(--text-muted);">${email} &bull; Joined ${joined}</div>
            <div style="margin-top:3px;font-size:11px;font-weight:600;color:${statusColor};">${status.toUpperCase()}</div>
          </div>
          <div style="display:flex; gap:8px; align-items:center; flex-shrink:0;">
            ${u.status === 'pending' ? `<button class="btn btn-secondary admin-approve-btn" data-id="${id}" style="padding:6px 10px; font-size:12px; color:var(--success-color); border-color:var(--success-color);"><i class="fa-solid fa-check"></i> Approve</button>` : ''}
            <select class="admin-role-select" data-id="${id}" style="padding:6px; font-size:12px; border-radius:6px; background:var(--bg-secondary); border:1px solid var(--border-color); color:var(--text-primary);">
              <option value="Operator" ${u.role === 'Operator' ? 'selected' : ''}>Operator</option>
              <option value="Administrator" ${u.role === 'Administrator' ? 'selected' : ''}>Administrator</option>
            </select>
            ${!isSelf ? `<button class="btn btn-secondary admin-delete-btn" data-id="${id}" data-name="${name}" style="padding:6px 10px; font-size:12px; color:var(--danger-color); border-color:var(--danger-color);"><i class="fa-solid fa-trash"></i></button>` : ''}
          </div>
        </div>
      `}).join('');

      listEl.querySelectorAll('.admin-approve-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-id');
          try { await WMSAuth.approveUser(id); showToast('User approved.', 'success'); await loadAdminUsers(); }
          catch (e) { showToast('Failed: ' + e.message, 'error'); }
        });
      });

      listEl.querySelectorAll('.admin-role-select').forEach(sel => {
        sel.addEventListener('change', async () => {
          const id = sel.getAttribute('data-id');
          try { await WMSAuth.changeUserRole(id, sel.value); showToast('Role updated.', 'success'); await loadAdminUsers(); }
          catch (e) { showToast('Failed: ' + e.message, 'error'); sel.value = sel.value === 'Operator' ? 'Administrator' : 'Operator'; }
        });
      });

      listEl.querySelectorAll('.admin-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-id');
          const name = btn.getAttribute('data-name');
          openDeleteUserConfirm(id, name, 'loadAdminUsers');
        });
      });

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

  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted);">Loading users...</td></tr>';

  const currentUserId = window.WMSAuth?.session?.user?.id || window.WMSAuth?.profile?.id || '';

  if (window.WMSAuth && typeof WMSAuth.getAllUsers === 'function') {
    try {
      const users = await WMSAuth.getAllUsers();
      if (!users || users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted);">No users found.</td></tr>';
        return;
      }

      tbody.innerHTML = users.map(u => {
        const isSelf = u.id === currentUserId;
        const name   = escapeHtml(u.full_name || u.name || '(No name)');
        const email  = escapeHtml(u.email || '(No email)');
        const status = u.status || 'unknown';
        const id     = escapeHtml(u.id || '');
        const joined = u.created_at ? new Date(u.created_at).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' }) : '—';

        let statusBadgeClass = 'status-badge-unknown';
        if (status === 'approved') statusBadgeClass = 'status-badge-approved';
        else if (status === 'pending') statusBadgeClass = 'status-badge-pending';
        else if (status === 'rejected') statusBadgeClass = 'status-badge-rejected';

        let actionButtons = '';
        if (status === 'pending') {
          actionButtons = `
            <button class="btn btn-secondary approve-btn" data-id="${id}" style="padding:6px 10px;font-size:12px;color:var(--success-color);border-color:var(--success-color);"><i class="fa-solid fa-check"></i> Approve</button>
            <button class="btn btn-secondary reject-btn" data-id="${id}" style="padding:6px 10px;font-size:12px;color:var(--danger-color);border-color:var(--danger-color);margin-left:4px;"><i class="fa-solid fa-xmark"></i> Reject</button>
          `;
        } else if (!isSelf) {
          actionButtons = `<button class="btn btn-secondary delete-user-btn" data-id="${id}" data-name="${name}" style="padding:6px 10px;font-size:12px;color:var(--danger-color);border-color:var(--danger-color);"><i class="fa-solid fa-trash"></i> Remove</button>`;
        } else {
          actionButtons = `<span style="font-size:11px;color:var(--text-muted);font-style:italic;">Your account</span>`;
        }

        const roleDropdown = `
          <select class="role-select" data-id="${id}" style="padding:6px;font-size:12px;border-radius:6px;background:var(--bg-secondary);border:1px solid var(--border-color);color:var(--text-primary);" ${isSelf ? 'disabled title="Cannot change your own role"' : ''}>
            <option value="Operator" ${u.role === 'Operator' ? 'selected' : ''}>Operator</option>
            <option value="Administrator" ${u.role === 'Administrator' ? 'selected' : ''}>Administrator</option>
          </select>
        `;

        return `
          <tr>
            <td style="font-weight:700;">${name}${isSelf ? ' <span style="font-size:10px;color:var(--accent);">(You)</span>' : ''}</td>
            <td style="font-size:12px;color:var(--text-muted);">${email}</td>
            <td style="font-size:12px;color:var(--text-muted);">${joined}</td>
            <td><span class="user-status-badge ${statusBadgeClass}">${escapeHtml(status.toUpperCase())}</span></td>
            <td>${roleDropdown}</td>
            <td><div style="display:flex;gap:6px;flex-wrap:wrap;">${actionButtons}</div></td>
          </tr>
        `;
      }).join('');

      // Approve buttons
      tbody.querySelectorAll('.approve-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-id');
          try { await WMSAuth.approveUser(id); showToast('User approved.', 'success'); await renderApprovalsSection(); }
          catch (e) { showToast('Failed to approve: ' + e.message, 'error'); }
        });
      });

      // Reject buttons
      tbody.querySelectorAll('.reject-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-id');
          try { await WMSAuth.rejectUser(id); showToast('User rejected.', 'warning'); await renderApprovalsSection(); }
          catch (e) { showToast('Failed to reject: ' + e.message, 'error'); }
        });
      });

      // Delete buttons — use modal confirmation
      tbody.querySelectorAll('.delete-user-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-id');
          const name = btn.getAttribute('data-name');
          openDeleteUserConfirm(id, name, 'renderApprovalsSection');
        });
      });

      // Role dropdowns
      tbody.querySelectorAll('.role-select').forEach(sel => {
        sel.addEventListener('change', async () => {
          const id = sel.getAttribute('data-id');
          const newRole = sel.value;
          try { await WMSAuth.changeUserRole(id, newRole); showToast(`Role updated to ${newRole}.`, 'success'); await renderApprovalsSection(); }
          catch (e) { showToast('Failed to change role: ' + e.message, 'error'); await renderApprovalsSection(); }
        });
      });

    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--danger-color);">Error: ${escapeHtml(err.message)}</td></tr>`;
    }
  } else {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted);">User approval functions require live Supabase auth.</td></tr>';
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
    showToast(`🔔 Real-time: ${item.title}`, 'warning');
  },

  renderLogs() {
    const timeline = document.getElementById('realtime-activity-timeline');
    if (!timeline) return;

    if (this.activeLogs.length === 0) {
      timeline.innerHTML = `
        <div class="tl-empty">
          <i class="fa-solid fa-clock-rotate-left"></i>
          <span>No activity logs recorded yet.</span>
        </div>`;
      return;
    }

    timeline.innerHTML = this.activeLogs.map((item, idx) => {
      // Icon + theme class per event type
      let icon       = 'fa-circle-info';
      let themeClass = 'tl-info';

      if (item.type === 'transaction') {
        if (item.event === 'Stock In') {
          icon       = 'fa-arrow-down-long';
          themeClass = 'tl-success';
        } else if (item.event === 'Stock Out') {
          icon       = 'fa-arrow-up-long';
          themeClass = 'tl-danger';
        } else {
          icon       = 'fa-arrows-rotate';
          themeClass = 'tl-warning';
        }
      } else if (item.type === 'auth') {
        if (item.event === 'login') {
          icon       = 'fa-right-to-bracket';
          themeClass = 'tl-accent';
        } else {
          icon       = 'fa-right-from-bracket';
          themeClass = 'tl-muted';
        }
      }

      // Human-readable relative time + full date tooltip
      const dateObj  = new Date(item.timestamp);
      const fullDate = dateObj.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      const relTime  = formatTimeDiff(dateObj);

      // Type label for the footer tag
      const typeLabel = item.type === 'transaction'
        ? (item.event === 'Stock In'  ? 'Stock In'
         : item.event === 'Stock Out' ? 'Stock Out'
         : 'Adjustment')
        : (item.event === 'login' ? 'Sign In' : 'Sign Out');

      const isLast = idx === this.activeLogs.length - 1;

      return `
        <div class="tl-item ${themeClass}${isLast ? ' tl-last' : ''}">
          <!-- Connector line + badge -->
          <div class="tl-left">
            <div class="tl-badge ${themeClass}">
              <i class="fa-solid ${icon}"></i>
            </div>
            ${!isLast ? '<div class="tl-line"></div>' : ''}
          </div>

          <!-- Card -->
          <div class="tl-card">
            <div class="tl-card-header">
              <div class="tl-title-row">
                <span class="tl-type-chip ${themeClass}">${typeLabel}</span>
                <h4 class="tl-title">${item.title}</h4>
              </div>
              <time class="tl-time" title="${fullDate}">${relTime}</time>
            </div>

            <p class="tl-desc">${item.desc}</p>

            <div class="tl-card-footer">
              <span class="tl-operator">
                <i class="fa-solid fa-user-circle"></i>
                ${item.operator}
              </span>
              <time class="tl-full-date">${fullDate}</time>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }
};
window.WMSActivityLog = WMSActivityLog;


// ============================================================
//   TRANSACTION DETAIL MODAL
// ============================================================
function openTransactionDetailModal(tx) {
  const modal = document.getElementById('transaction-detail-modal');
  if (!modal) return;

  // Format timestamp nicely
  const formattedDate = new Date(tx.timestamp).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  // Populate modal fields with escaped content
  const timestampEl = document.getElementById('txn-detail-timestamp');
  if (timestampEl) timestampEl.textContent = formattedDate;

  const typeEl = document.getElementById('txn-detail-txn-type');
  if (typeEl) typeEl.textContent = escapeHtml(tx.type);

  const iconEl = document.getElementById('txn-detail-icon');
  if (iconEl) {
    iconEl.className = 'fa-solid';
    if (tx.type === 'Stock In') {
      iconEl.classList.add('fa-arrow-down-long');
      iconEl.style.color = 'var(--success-color)';
    } else if (tx.type === 'Stock Out') {
      iconEl.classList.add('fa-arrow-up-long');
      iconEl.style.color = 'var(--warning-color)';
    }
  }

  const skuEl = document.getElementById('txn-detail-sku');
  if (skuEl) skuEl.textContent = escapeHtml(tx.sku).toUpperCase();

  const productEl = document.getElementById('txn-detail-product-name');
  if (productEl) productEl.textContent = escapeHtml(tx.productName);

  const qtyEl = document.getElementById('txn-detail-quantity');
  if (qtyEl) {
    const qtyPrefix = tx.type === 'Stock In' ? '+' : '-';
    qtyEl.textContent = qtyPrefix + escapeHtml(tx.quantity);
    qtyEl.style.color = tx.type === 'Stock In' ? 'var(--success-color)' : 'var(--warning-color)';
  }

  const locationEl = document.getElementById('txn-detail-location');
  if (locationEl) locationEl.textContent = escapeHtml(tx.location) || 'N/A';

  const docRefEl = document.getElementById('txn-detail-doc-ref');
  if (docRefEl) docRefEl.textContent = escapeHtml(tx.docRef) || 'N/A';

  const priceEl = document.getElementById('txn-detail-unit-price');
  if (priceEl) {
    const price = parseFloat(tx.price) || 0;
    priceEl.textContent = price > 0 ? '₱' + price.toLocaleString(undefined, { minimumFractionDigits: 2 }) : 'N/A';
  }

  const operatorEl = document.getElementById('txn-detail-operator');
  if (operatorEl) operatorEl.textContent = escapeHtml(tx.operator) || 'N/A';

  const notesEl = document.getElementById('txn-detail-notes');
  if (notesEl) notesEl.textContent = escapeHtml(tx.notes) || 'N/A';

  // Show modal
  modal.classList.add('active');
}

// ============================================================
//   DELETE PRODUCT CONFIRM MODAL
// ============================================================
function openDeleteProductConfirm(sku) {
  const modal = document.getElementById('deleteProductConfirmModal');
  if (!modal) return;
  const msgEl = document.getElementById('delete-product-confirm-msg');
  if (msgEl) msgEl.textContent = `Delete SKU "${sku}"? This cannot be undone.`;
  modal._targetSku = sku;
  modal.classList.add('active');
}

window._confirmDeleteProduct = async function() {
  const modal = document.getElementById('deleteProductConfirmModal');
  if (!modal) return;
  const sku = modal._targetSku;
  modal.classList.remove('active');
  if (!sku) return;
  try {
    await WMSDatabase.deleteProduct(sku);
    productsCache = null;
    showToast(`Deleted SKU: ${sku}`, 'success');
    await renderInventoryTable();
    await renderDashboard();
  } catch (e) {
    showToast(`Error deleting product: ${e.message}`, 'error');
  }
};

// ============================================================
//   DELETE USER CONFIRM MODAL
// ============================================================
function openDeleteUserConfirm(userId, userName, callbackName) {
  const modal = document.getElementById('deleteUserConfirmModal');
  if (!modal) return;
  const msgEl = document.getElementById('delete-user-confirm-msg');
  if (msgEl) msgEl.textContent = `Remove user "${userName}"? Their profile will be deactivated and they will lose access.`;
  modal._targetUserId = userId;
  modal._callbackName = callbackName;
  modal.classList.add('active');
}

window._confirmDeleteUser = async function() {
  const modal = document.getElementById('deleteUserConfirmModal');
  if (!modal) return;
  const userId = modal._targetUserId;
  const callbackName = modal._callbackName;
  modal.classList.remove('active');
  if (!userId) return;
  try {
    await WMSAuth.deleteAuthUser(userId);
    showToast('User removed successfully.', 'success');
    if (callbackName === 'loadAdminUsers') await loadAdminUsers();
    else await renderApprovalsSection();
  } catch (e) {
    showToast('Failed to remove user: ' + e.message, 'error');
  }
};

// ============================================================
//   RESET DATABASE TYPED CONFIRM MODAL
// ============================================================
function openResetConfirmModal() {
  const modal = document.getElementById('resetConfirmModal');
  if (!modal) return;
  const input = document.getElementById('reset-confirm-input');
  if (input) input.value = '';
  const btn = document.getElementById('reset-confirm-btn');
  if (btn) btn.disabled = true;
  modal.classList.add('active');
}

window._confirmReset = async function() {
  const modal = document.getElementById('resetConfirmModal');
  if (!modal) return;
  modal.classList.remove('active');
  const success = await WMSDatabase.resetDatabase();
  if (success) {
    productsCache = null;
    const settingsData = await WMSDatabase.getSettings();
    currentTheme = settingsData.theme || 'dark';
    applyTheme(currentTheme);
    await onViewActivated('view-dashboard');
    const dashLink = document.querySelector('[data-view="view-dashboard"]');
    if (dashLink) dashLink.click();
    showToast('Database reset to factory defaults.', 'success');
  } else {
    showToast('Failed to reset database.', 'error');
  }
};

// --- DOMCONTENTLOADED ENTRY POINT ---
document.addEventListener('DOMContentLoaded', async () => {
  // Clean up legacy offline-mode keys that are no longer used in online-only mode.
  // NOTE: wms_bypass_session / wms_bypass_profile are intentionally kept —
  // auth.js uses them for the local/offline user login path.
  ['wms_local_users', 'wms_local_products', 'wms_local_transactions',
   'wms_local_settings'].forEach(key => localStorage.removeItem(key));

  // ── Auth guard: must be first ──────────────────────────────────
  if (window.WMSAuth) {
    const profile = await WMSAuth.init();
    if (!profile) return; // WMSAuth.init() already redirected to login
    // CRITICAL FIX: After auth init, ensure sidebar footer displays correct user name/role
    // This prevents stale "Earl Administrator" text from persisting after page refresh
    // by forcing a full re-render of the header user information
    if (typeof WMSAuth._renderHeaderUser === 'function') {
      WMSAuth._renderHeaderUser();
    }
  }

  // ── Check for session expiration on page load ─────────────────
  const sessionValid = await checkSessionExpiration();
  if (!sessionValid) {
    // Session has expired, force logout and show message
    await forceLogout();
    return; // Stop initialization
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

  // Wave 1-3: Realtime expiry changes
  window.addEventListener('wms:expiry-changed', () => {
    console.log('[WMS] Expiry data changed - refreshing near-expiry list');
    loadNearExpiryProducts();
    if (document.getElementById('inventory-table-body')) {
      renderInventoryTable();
    }
  });

  // Wave 2: Realtime price changes
  window.addEventListener('wms:price-changed', () => {
    console.log('[WMS] Price data changed');
    productsCache = null;
  });

  // Wave 3: Realtime session changes
  window.addEventListener('wms:sessions-changed', () => {
    console.log('[WMS] Sessions changed');
  });

  // Show skeleton KPIs immediately
  ['kpi-total-sku','kpi-total-stock','kpi-low-stock','kpi-out-of-stock'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<span class="skeleton kpi-skeleton"></span>';
  });

  // CRITICAL: Re-render header user info to ensure sidebar footer shows correct current user
  // This fixes the issue where stale cached names would persist after page refresh
  // Must be called AFTER WMSDatabase.init() so that the profile is fully available
  if (typeof WMSAuth !== 'undefined' && typeof WMSAuth._renderHeaderUser === 'function') {
    WMSAuth._renderHeaderUser();
  }

  updateGlobalHeaderProfile();
  enforceUserPermissions();
  setupEventListeners();
  
  // Initialize session tracking and activity monitoring
  await initializeSession();

  // Show/hide admin-only UI elements
  if (window.WMSAuth && WMSAuth.isAdmin()) {
    const adminTab = document.getElementById('ptab-admin');
    if (adminTab) adminTab.style.display = '';
  }

  // SAFETY MECHANISM: Ensure sidebar footer is always displaying the current logged-in user
  // by setting up a periodic refresh that catches any edge cases where stale data might show
  // This completely prevents the "Earl Administrator" hardcoded text from appearing
  setInterval(() => {
    if (typeof WMSAuth !== 'undefined' && typeof WMSAuth._renderHeaderUser === 'function') {
      WMSAuth._renderHeaderUser();
    }
    updateGlobalHeaderProfile();
  }, 5000); // Refresh every 5 seconds to ensure freshness

  await renderDashboard();

  if (!productsCache) getCachedProducts().catch(() => {});
});
