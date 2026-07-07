/**
 * db.js - Supabase Online-Only Database Layer for WMS
 * Single Supabase client shared across the app (exposed as window._sb).
 * No localStorage fallback — requires an active internet connection.
 * Realtime subscriptions invalidate the products cache automatically.
 */

const DEFAULT_CATEGORIES = ['Electronics', 'Display', 'Office Supply', 'Furniture', 'Networking'];
const DEFAULT_LOCATIONS  = ['Rack A1', 'Rack A2', 'Rack B1', 'Rack B2', 'Rack B3', 'Rack C1', 'Rack C2', 'Rack C3'];

// ── Single Supabase client ────────────────────────────────────────────────────
const SUPABASE_URL = "https://fjpvrxucmxlfojwmbdfu.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZqcHZyeHVjbXhsZm9qd21iZGZ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NTM0OTAsImV4cCI6MjA5NzQyOTQ5MH0.Fh6qJI1U1RhKc2ZHsxDABd7SdReYo9TnDTyGpeghfYk";

if (!window.supabase) {
  console.error('[WMS] Supabase SDK not loaded. Make sure the CDN script tag is present.');
}

// Shared client — reused by auth.js and login.html via window._sb
const supabase = window.supabase
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;
window._sb = supabase; // expose for auth.js / login.html

// ── Caches ───────────────────────────────────────────────────────────────────
let settingsCache = null;

// productsCache is invalidated automatically by Realtime on any product change
// (see subscribeRealtimeInvalidation at the bottom of this file)

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fetches ALL rows from a Supabase table in 1000-row batches.
 * Supabase enforces a hard cap of 1000 rows per request by default.
 */
async function fetchAllRows(queryFn) {
  const BATCH = 1000;
  let allRows = [];
  let from = 0;
  while (true) {
    const { data, error } = await queryFn(from, from + BATCH - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    allRows = allRows.concat(data);
    if (data.length < BATCH) break;
    from += BATCH;
  }
  return allRows;
}

/** Generate a collision-safe transaction ID using crypto.randomUUID */
function generateTxId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return 'TX-' + crypto.randomUUID().replace(/-/g, '').substring(0, 12).toUpperCase();
  }
  // Fallback (very unlikely to be needed in any modern browser)
  return 'TX-' + Math.random().toString(36).substring(2, 14).toUpperCase();
}

/**
 * Parse a product's location field.
 * Supports both JSON map {"Rack A1":50} and plain text "Rack A1".
 */
function parseLocations(locationStr, stockOnHand = 0) {
  if (!locationStr) return {};
  const trimmed = String(locationStr).trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const cleaned = {};
      for (const [loc, qty] of Object.entries(parsed)) {
        const q = parseInt(qty) || 0;
        if (q > 0 && loc && loc !== '0' && loc !== 'N/A' && loc !== 'Pending') {
          cleaned[loc] = q;
        }
      }
      return cleaned;
    } catch (_) { /* fall through */ }
  }
  const cleaned = {};
  if (trimmed && trimmed !== '0' && trimmed !== 'Pending' && trimmed !== 'N/A') {
    cleaned[trimmed] = parseInt(stockOnHand) || 0;
  }
  return cleaned;
}
window.parseLocations = parseLocations;

function normalizeLocationField(locationVal, stockVal) {
  if (!locationVal) return JSON.stringify({});
  const trimmed = String(locationVal).trim();
  if (!trimmed || trimmed === '0' || trimmed === 'N/A' || trimmed === 'Pending') {
    return JSON.stringify({});
  }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const cleaned = {};
      for (const [loc, qty] of Object.entries(parsed)) {
        const q = parseInt(qty) || 0;
        if (q > 0 && loc && loc !== '0' && loc !== 'N/A' && loc !== 'Pending') {
          cleaned[loc] = q;
        }
      }
      return JSON.stringify(cleaned);
    } catch (_) { /* fall through */ }
  }
  const obj = {};
  obj[trimmed] = parseInt(stockVal) || 0;
  return JSON.stringify(obj);
}

function enrichProductData(product, lowLimit) {
  const stock    = parseInt(product.stock_on_hand  ?? product.quantity    ?? 0) || 0;
  const reserved = parseInt(product.reserved_stock ?? 0) || 0;
  const reorder  = parseInt(product.reorder_level  ?? product.min_qty ?? lowLimit) || lowLimit;

  const available = stock - reserved;
  let status = 'In Stock';
  if (available <= 0)       status = 'Out of Stock';
  else if (available <= reorder) status = 'Low Stock';

  return {
    sku:            product.sku,
    name:           product.name,
    category:       product.category,
    location:       product.location,
    stock_on_hand:  stock,
    reserved_stock: reserved,
    available_stock: available,
    reorder_level:  reorder,
    price:          parseFloat(product.price) || 0,
    status,
    barcode:        product.barcode || product.sku,
    expiry_date:    product.expiry_date || null,
    updated_at:     product.updated_at || new Date().toISOString()
  };
}

// ── Connectivity guard ────────────────────────────────────────────────────────
function requireOnline() {
  if (!supabase) {
    throw new Error('Database unavailable. Please check your internet connection and reload the page.');
  }
}

// ── WMSDatabase ───────────────────────────────────────────────────────────────
class WMSDatabase {

  static async init() {
    requireOnline();
    // Verify connection with a fast probe
    const { error } = await supabase.from('settings').select('key').limit(1);
    if (error) {
      throw new Error('Could not connect to the database. Please check your internet connection.');
    }
    // Start Realtime product cache invalidation
    this._subscribeRealtimeInvalidation();
  }

  // ── Products ────────────────────────────────────────────────────────────────

  static async getProducts() {
    requireOnline();
    const settings = await this.getSettings();
    const lowLimit = settings.lowStockThreshold || 15;
    try {
      const data = await fetchAllRows((from, to) =>
        supabase.from('products').select('*').order('sku').range(from, to)
      );
      return data.map(p => enrichProductData(p, lowLimit));
    } catch (err) {
      console.error('[WMS] getProducts error:', err);
      if (window.showToast) window.showToast('Failed to load inventory. Check your connection.', 'error');
      return [];
    }
  }

  static async getProduct(sku) {
    if (!sku) return null;
    requireOnline();
    const cleanSku = sku.toUpperCase().trim();
    const settings = await this.getSettings();
    const lowLimit = settings.lowStockThreshold || 15;

    const { data, error } = await supabase
      .from('products').select('*').eq('sku', cleanSku).maybeSingle();
    if (error) { console.error('[WMS] getProduct error:', error); return null; }
    return data ? enrichProductData(data, lowLimit) : null;
  }

  static async saveProduct(productData) {
    requireOnline();
    const cleanSku = productData.sku.toUpperCase().trim();
    const stock    = parseInt(productData.stock_on_hand ?? productData.quantity ?? 0) || 0;

    const record = {
      sku:            cleanSku,
      name:           productData.name.trim(),
      category:       productData.category || 'Uncategorized',
      location:       normalizeLocationField(productData.location, stock),
      stock_on_hand:  stock,
      reserved_stock: parseInt(productData.reserved_stock) || 0,
      reorder_level:  parseInt(productData.reorder_level ?? productData.minQty) || 15,
      price:          parseFloat(productData.price) || 0,
      barcode:        cleanSku,
      expiry_date:    productData.expiry_date || null,
      updated_at:     new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('products').upsert(record).select().single();
    if (error) { console.error('[WMS] saveProduct error:', error); throw error; }

    const settings = await this.getSettings();
    return enrichProductData(data, settings.lowStockThreshold || 15);
  }

  static async deleteProduct(sku) {
    requireOnline();
    const { error } = await supabase
      .from('products').delete().eq('sku', sku.toUpperCase().trim());
    if (error) { console.error('[WMS] deleteProduct error:', error); throw error; }
  }

  // ── Transactions ────────────────────────────────────────────────────────────

  static async getTransactions() {
    requireOnline();
    const { data, error } = await supabase
      .from('transactions').select('*')
      .order('timestamp', { ascending: false }).limit(200);
    if (error) { console.error('[WMS] getTransactions error:', error); return []; }
    return data.map(tx => ({
      id:          tx.id,
      timestamp:   tx.timestamp,
      type:        tx.type,
      sku:         tx.sku,
      productName: tx.product_name || tx.productName,
      category:    tx.category || '',
      quantity:    tx.quantity,
      price:       tx.price || 0,
      docRef:      tx.doc_ref || tx.docRef,
      location:    tx.location || 'N/A',
      operator:    tx.operator,
      notes:       tx.notes
    }));
  }

  static async logTransaction({ type, sku, productName, category, quantity, price, docRef, location, notes }) {
    requireOnline();
    // Always prefer the live Supabase auth profile for operator tagging — this guarantees
    // every transaction is attributed to the actual logged-in user, not a stale localStorage value.
    const authProfile = (typeof window !== 'undefined' && window.WMSAuth && window.WMSAuth.profile)
      ? window.WMSAuth.profile
      : null;
    const currentUser = authProfile
      ? { name: authProfile.full_name || authProfile.email || 'Unknown' }
      : this.getCurrentUser();
    const cleanSku    = sku.toUpperCase().trim();
    const parsedQty   = parseInt(quantity) || 0;
    const parsedPrice = parseFloat(price) || 0;

    // ── Pre-validate stock before writing ──────────────────────────────────
    const { data: preCheck } = await supabase
      .from('products').select('stock_on_hand, location').eq('sku', cleanSku).maybeSingle();

    if (preCheck) {
      const preLocObj = parseLocations(preCheck.location, parseInt(preCheck.stock_on_hand) || 0);
      if (type === 'Stock In') {
        if (!preLocObj[location] && Object.keys(preLocObj).length >= 5) {
          throw new Error(`SKU ${cleanSku} is already stored in 5 locations. Stock in at an existing location or consolidate first.`);
        }
      } else if (type === 'Stock Out') {
        const avail = preLocObj[location] || 0;
        if (avail < parsedQty) {
          throw new Error(`Insufficient stock at ${location}. Available: ${avail} units.`);
        }
      }
    }

    // ── Insert transaction ─────────────────────────────────────────────────
    const txRecord = {
      id:           generateTxId(),
      timestamp:    new Date().toISOString(),
      type,
      sku:          cleanSku,
      product_name: productName,
      category:     category || '',
      quantity:     parsedQty,
      price:        parsedPrice,
      doc_ref:      docRef ? docRef.trim() : 'N/A',
      location:     location || 'N/A',
      operator:     currentUser ? currentUser.name : 'System',
      notes:        notes ? notes.trim() : ''
    };

    const { data: inserted, error: insertErr } = await supabase
      .from('transactions').insert(txRecord).select().single();
    if (insertErr) { console.error('[WMS] logTransaction insert error:', insertErr); throw insertErr; }

    // ── Update product stock ───────────────────────────────────────────────
    const { data: currentProduct } = await supabase
      .from('products').select('stock_on_hand, location').eq('sku', cleanSku).maybeSingle();

    if (currentProduct) {
      const currentStock = parseInt(currentProduct.stock_on_hand) || 0;
      const locObj = parseLocations(currentProduct.location, currentStock);

      if (type === 'Stock In') {
        locObj[location] = (locObj[location] || 0) + parsedQty;
      } else if (type === 'Stock Out') {
        locObj[location] = (locObj[location] || 0) - parsedQty;
        if (locObj[location] <= 0) delete locObj[location];
      }

      const newStock = Object.values(locObj).reduce((a, b) => a + b, 0);
      await supabase.from('products').update({
        stock_on_hand: newStock,
        location:      JSON.stringify(locObj),
        updated_at:    txRecord.timestamp
      }).eq('sku', cleanSku);
    }

    return {
      id:          inserted.id,
      timestamp:   inserted.timestamp,
      type:        inserted.type,
      sku:         inserted.sku,
      productName: inserted.product_name,
      category:    inserted.category || category || '',
      quantity:    inserted.quantity,
      price:       inserted.price ?? parsedPrice,
      docRef:      inserted.doc_ref,
      location:    inserted.location || 'N/A',
      operator:    inserted.operator,
      notes:       inserted.notes
    };
  }

  // ── Users ────────────────────────────────────────────────────────────────────

  static async getUsers() {
    requireOnline();
    const { data, error } = await supabase.from('users').select('*').order('username');
    if (error) { console.error('[WMS] getUsers error:', error); return []; }
    return data;
  }

  static async saveUser(userData) {
    requireOnline();
    const cleanUsername = userData.username.trim().toLowerCase();
    const record = {
      username: cleanUsername,
      name:     userData.name.trim(),
      email:    userData.email.trim(),
      role:     userData.role || 'Operator'
    };
    const { data, error } = await supabase.from('users').upsert(record).select().single();
    if (error) { console.error('[WMS] saveUser error:', error); throw error; }
    return data;
  }

  static async deleteUser(username) {
    requireOnline();
    const cleanUsername = username.trim().toLowerCase();
    const { error } = await supabase.from('users').delete().eq('username', cleanUsername);
    if (error) { console.error('[WMS] deleteUser error:', error); throw error; }

    const currentUser = this.getCurrentUser();
    if (currentUser && currentUser.username.toLowerCase() === cleanUsername) {
      const users = await this.getUsers();
      const fallback = users.find(u => u.role === 'Administrator') || users[0] ||
        { username: 'admin', name: 'Administrator', role: 'Administrator' };
      this.setCurrentUser(fallback);
    }
  }

  // Active session is cached in localStorage (lightweight — no sensitive data)
  static getCurrentUser() {
    try {
      return JSON.parse(localStorage.getItem('wms_current_user')) ||
        { username: 'admin', name: 'Administrator', role: 'Administrator' };
    } catch (_) {
      return { username: 'admin', name: 'Administrator', role: 'Administrator' };
    }
  }

  static setCurrentUser(user) {
    localStorage.setItem('wms_current_user', JSON.stringify(user));
  }

  // ── Login logs ────────────────────────────────────────────────────────────────

  static async getLoginLogs() {
    requireOnline();
    const { data, error } = await supabase
      .from('login_log').select('*')
      .order('timestamp', { ascending: false }).limit(100);
    if (error) { console.error('[WMS] getLoginLogs error:', error); return []; }
    return data || [];
  }

  // ── Realtime subscriptions ────────────────────────────────────────────────────

  /**
   * Invalidate the in-memory products cache whenever a product row changes
   * on Supabase, so any tab/user sees fresh data on next render.
   */
  static _subscribeRealtimeInvalidation() {
    if (!supabase) return;
    supabase.channel('wms-product-invalidation')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => {
        // Null out the app-level cache so the next getCachedProducts() re-fetches
        if (typeof productsCache !== 'undefined') productsCache = null;
        // Notify app.js to do the same
        window.dispatchEvent(new CustomEvent('wms:products-changed'));
      })
      .subscribe();

    // Also invalidate settingsCache when settings change from any tab/device
    supabase.channel('wms-settings-invalidation')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, () => {
        settingsCache = null;
      })
      .subscribe();
  }

  static subscribeToRealtimeLogs(onTxChange, onLoginChange) {
    if (!supabase) return null;
    const txChannel = supabase.channel('realtime-transactions-all')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions' }, payload => {
        onTxChange(payload.new);
      }).subscribe();

    const loginChannel = supabase.channel('realtime-logins-all')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'login_log' }, payload => {
        onLoginChange(payload.new);
      }).subscribe();

    return {
      unsubscribe: () => {
        supabase.removeChannel(txChannel);
        supabase.removeChannel(loginChannel);
      }
    };
  }

  // ── Settings ──────────────────────────────────────────────────────────────────

  static async getSettings() {
    if (settingsCache !== null) return settingsCache;
    requireOnline();
    const { data, error } = await supabase
      .from('settings').select('value').eq('key', 'general').maybeSingle();
    if (error) console.error('[WMS] getSettings error:', error);
    if (data && data.value) {
      settingsCache = data.value;
      return settingsCache;
    }
    // First-run default
    settingsCache = {
      warehouseName:     'Ace Remnants Butuan HQ',
      lowStockThreshold: 15,
      categories:        DEFAULT_CATEGORIES,
      locations:         DEFAULT_LOCATIONS,
      theme:             'dark'
    };
    return settingsCache;
  }

  static async saveSettings(newSettings) {
    requireOnline();
    const current = await this.getSettings();
    const updated = { ...current, ...newSettings };
    const { error } = await supabase.from('settings').upsert({ key: 'general', value: updated });
    if (error) { console.error('[WMS] saveSettings error:', error); throw error; }
    settingsCache = updated;
    return updated;
  }

  // ── Database reset ─────────────────────────────────────────────────────────────

  static async resetDatabase() {
    requireOnline();
    settingsCache = null;

    const defaultSettings = {
      warehouseName:     'Ace Remnants Butuan HQ',
      lowStockThreshold: 15,
      categories:        DEFAULT_CATEGORIES,
      locations:         DEFAULT_LOCATIONS,
      theme:             'dark'
    };

    try {
      // Wipe tables — neq trick avoids the "must include filter" restriction
      await supabase.from('transactions').delete().neq('id', '__none__');
      await supabase.from('products').delete().neq('sku', '__none__');
      await supabase.from('settings').delete().eq('key', 'general');
      await supabase.from('settings').insert({ key: 'general', value: defaultSettings });

      this.setCurrentUser({ username: 'admin', name: 'Administrator', role: 'Administrator' });
      settingsCache = defaultSettings;
      return true;
    } catch (e) {
      console.error('[WMS] resetDatabase error:', e);
      return false;
    }
  }

  // ── Batch product save (used by Excel/CSV import) ─────────────────────────────

  static async saveProductsBatch(productsArray) {
    requireOnline();
    const settings = await this.getSettings();
    const lowLimit  = settings.lowStockThreshold || 15;

    const records = productsArray.map(p => {
      const cleanSku = String(p.sku).toUpperCase().trim();
      const stock    = parseInt(p.stock_on_hand ?? p.quantity ?? 0) || 0;
      return {
        sku:            cleanSku,
        name:           String(p.name).trim(),
        category:       p.category || 'Uncategorized',
        location:       normalizeLocationField(p.location, stock),
        stock_on_hand:  stock,
        reserved_stock: parseInt(p.reserved_stock ?? 0) || 0,
        reorder_level:  parseInt(p.reorder_level ?? p.min_qty ?? p.minQty ?? lowLimit) || lowLimit,
        price:          parseFloat(p.price) || 0,
        barcode:        cleanSku,
        expiry_date:    p.expiry_date || null,
        updated_at:     new Date().toISOString()
      };
    });

    // Upsert in chunks of 500 to stay within Supabase limits
    const CHUNK = 500;
    for (let i = 0; i < records.length; i += CHUNK) {
      const chunk = records.slice(i, i + CHUNK);
      const { error } = await supabase.from('products').upsert(chunk);
      if (error) { console.error('[WMS] saveProductsBatch error:', error); throw error; }
    }
  }

  // ── Export / Import ────────────────────────────────────────────────────────────

  static async exportData() {
    requireOnline();
    const [products, transactions, settings] = await Promise.all([
      this.getProducts(),
      this.getTransactions(),
      this.getSettings()
    ]);
    return JSON.stringify({ products, transactions, settings, exportedAt: new Date().toISOString() }, null, 2);
  }

  static async importData(jsonData) {
    requireOnline();
    settingsCache = null;
    try {
      const data = JSON.parse(jsonData);
      if (!data.products || !data.transactions || !data.settings) return false;

      // Wipe & re-seed
      await supabase.from('transactions').delete().neq('id', '__none__');
      await supabase.from('products').delete().neq('sku', '__none__');
      await supabase.from('settings').delete().eq('key', 'general');
      await supabase.from('settings').insert({ key: 'general', value: data.settings });

      if (data.products.length > 0) {
        const rows = data.products.map(p => ({
          sku:            p.sku,
          name:           p.name,
          category:       p.category,
          location:       normalizeLocationField(p.location, p.stock_on_hand ?? p.quantity ?? 0),
          stock_on_hand:  parseInt(p.stock_on_hand ?? p.quantity ?? 0) || 0,
          reserved_stock: parseInt(p.reserved_stock ?? 0) || 0,
          reorder_level:  parseInt(p.reorder_level ?? p.min_qty ?? p.minQty ?? 15) || 15,
          price:          parseFloat(p.price) || 0,
          barcode:        p.barcode || p.sku,
          expiry_date:    p.expiry_date || null,
          updated_at:     p.updated_at || new Date().toISOString()
        }));
        await supabase.from('products').insert(rows);
      }

      if (data.transactions.length > 0) {
        const txs = data.transactions.map(t => ({
          id:           t.id,
          timestamp:    t.timestamp,
          type:         t.type,
          sku:          t.sku,
          product_name: t.product_name || t.productName,
          category:     t.category || '',
          quantity:     t.quantity,
          price:        t.price || 0,
          doc_ref:      t.doc_ref || t.docRef,
          location:     t.location || 'N/A',
          operator:     t.operator,
          notes:        t.notes
        }));
        await supabase.from('transactions').insert(txs);
      }

      return true;
    } catch (e) {
      console.error('[WMS] importData error:', e);
      return false;
    }
  }
}
