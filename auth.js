/**
 * auth.js — Session guard, Supabase Auth integration, profile management
 * Loaded FIRST in index.html — redirects to login.html if not authenticated.
 *
 * Reuses the single Supabase client created by db.js (window._sb).
 * db.js MUST be loaded before auth.js.
 */

// Reuse the shared client from db.js — no second createClient() call
const authSb = window._sb || null;

// ── Current session state ────────────────────────────────────────────────────
window.WMSAuth = {
  session: null,
  profile: null,

  // Called once on page load — redirects to login if not authenticated
  async init() {
    // Check for hardcoded admin bypass
    const bypassSession = localStorage.getItem('wms_bypass_session');
    if (bypassSession) {
      this.session = JSON.parse(bypassSession);
      this.profile = JSON.parse(localStorage.getItem('wms_bypass_profile'));
      
      if (window.WMSDatabase) {
        WMSDatabase.setCurrentUser({
          username: this.profile.email,
          name: this.profile.full_name,
          role: this.profile.role,
          email: this.profile.email,
          id: this.session.user.id,
          phone: this.profile.phone || '',
          department: this.profile.department || ''
        });
      }
      this._renderHeaderUser();
      return this.profile;
    }

    if (!authSb) {
      console.error('Supabase not loaded — auth cannot initialize.');
      window.location.replace('login.html');
      return;
    }

    const { data: { session } } = await authSb.auth.getSession();

    if (!session) {
      window.location.replace('login.html');
      return;
    }

    // Fetch profile and verify still approved
    const { data: profile } = await authSb.from('user_profiles')
      .select('*')
      .eq('id', session.user.id)
      .maybeSingle();

    if (!profile || profile.status !== 'approved') {
      await authSb.auth.signOut();
      window.location.replace('login.html');
      return;
    }

    this.session = session;
    this.profile = profile;

    // Patch WMSDatabase.getCurrentUser() so existing code picks up the real user
    if (window.WMSDatabase) {
      WMSDatabase.setCurrentUser({
        username: profile.email,
        name: profile.full_name,
        role: profile.role,
        email: profile.email,
        id: session.user.id,
        phone: profile.phone || '',
        department: profile.department || ''
      });
    }

    // Update header badge
    this._renderHeaderUser();

    // Listen for auth state changes (e.g. token expiry, sign-out from another tab)
    authSb.auth.onAuthStateChange(async (event) => {
      if (event === 'SIGNED_OUT' && !localStorage.getItem('wms_bypass_session')) {
        window.location.replace('login.html');
      }
    });

    // If admin — load pending user notifications
    if (profile.role === 'Administrator') {
      this._loadAdminNotifications();
    }

    return profile;
  },

  // Sign out
  async signOut() {
    localStorage.removeItem('wms_bypass_session');
    localStorage.removeItem('wms_bypass_profile');
    try {
      if (authSb) {
        await authSb.from('login_log').insert({
          user_id: this.session?.user?.id,
          email: this.profile?.email,
          full_name: this.profile?.full_name,
          timestamp: new Date().toISOString(),
          event: 'logout'
        }).catch(() => {});
      }
    } catch (_) {}
    if (authSb) await authSb.auth.signOut();
    window.location.replace('login.html');
  },

  // Update the header avatar and name
  _renderHeaderUser() {
    const p = this.profile;
    if (!p) return;
    const initials = p.full_name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
    const badge = document.getElementById('global-profile-initials');
    const nameEl = document.getElementById('global-header-username');
    if (badge) badge.textContent = initials;
    if (nameEl) nameEl.textContent = p.full_name;
  },

  // Load unread admin notifications and show badge
  async _loadAdminNotifications() {
    const { data } = await authSb.from('admin_notifications')
      .select('*')
      .eq('read', false)
      .order('timestamp', { ascending: false });

    if (data && data.length > 0) {
      this._showNotificationBadge(data.length, data);
    }
  },

  _showNotificationBadge(count, notifications) {
    // Update the sidebar notification dot on the Operators nav link
    const opsLink = document.querySelector('[data-view="view-users"]');
    if (opsLink) {
      const existing = opsLink.querySelector('.notif-dot');
      if (!existing) {
        const dot = document.createElement('span');
        dot.className = 'notif-dot';
        dot.textContent = count;
        opsLink.appendChild(dot);
      } else {
        existing.textContent = count;
      }
    }
    // Also show a toast for each pending request
    notifications.filter(n => n.type === 'new_user_request').forEach(n => {
      if (window.showToast) showToast(`📋 ${n.message}`, 'warning');
    });
  },

  // Mark all admin notifications as read
  async markNotificationsRead() {
    if (authSb) {
      await authSb.from('admin_notifications')
        .update({ read: true })
        .eq('read', false)
        .catch(() => {});
    }
    const dot = document.querySelector('.notif-dot');
    if (dot) dot.remove();
  },

  // ── Profile CRUD ─────────────────────────────────────────────────────────

  async getProfile() {
    if (localStorage.getItem('wms_bypass_session')) {
      return JSON.parse(localStorage.getItem('wms_bypass_profile'));
    }
    if (!authSb) return this.profile || null;
    const { data } = await authSb.from('user_profiles')
      .select('*')
      .eq('id', this.session.user.id)
      .maybeSingle();
    return data;
  },

  async updateProfile({ full_name, phone, department }) {
    if (localStorage.getItem('wms_bypass_session')) {
      this.profile.full_name = full_name;
      this.profile.phone = phone;
      this.profile.department = department;
      localStorage.setItem('wms_bypass_profile', JSON.stringify(this.profile));
      localStorage.setItem('wms_bypass_profile_saved', JSON.stringify(this.profile)); // Persist permanently across logouts
      this._renderHeaderUser();
      if (window.WMSDatabase) {
        WMSDatabase.setCurrentUser({
          username: this.profile.email,
          name: full_name,
          role: this.profile.role,
          email: this.profile.email,
          id: this.session.user.id,
          phone: phone || '',
          department: department || ''
        });
      }
      return;
    }

    const { error } = await authSb.from('user_profiles')
      .update({ full_name, phone, department, updated_at: new Date().toISOString() })
      .eq('id', this.session.user.id);
    if (error) throw error;
    this.profile.full_name = full_name;
    this.profile.phone = phone;
    this.profile.department = department;
    this._renderHeaderUser();
    if (window.WMSDatabase) {
      WMSDatabase.setCurrentUser({
        username: this.profile.email,
        name: full_name,
        role: this.profile.role,
        email: this.profile.email,
        id: this.session.user.id,
        phone: phone || '',
        department: department || ''
      });
    }
  },

  async updatePassword(newPassword) {
    if (!authSb) throw new Error('Supabase not available. Password changes require an online connection.');
    const { error } = await authSb.auth.updateUser({ password: newPassword });
    if (error) throw error;
  },

  // ── Admin: user management ───────────────────────────────────────────────

  async getPendingUsers() {
    let pending = [];
    if (authSb) {
      try {
        const { data } = await authSb.from('user_profiles')
          .select('*')
          .eq('status', 'pending')
          .order('created_at', { ascending: false });
        if (data) pending = [...data];
      } catch (err) {
        console.error(err);
      }
    }
    const localUsers = JSON.parse(localStorage.getItem('wms_local_users') || '[]');
    const localPending = localUsers.filter(u => u.status === 'pending');
    return [...pending, ...localPending];
  },

  async getAllUsers() {
    let users = [];
    if (authSb) {
      try {
        const { data } = await authSb.from('user_profiles')
          .select('*')
          .order('created_at', { ascending: false });
        if (data) users = [...data];
      } catch (err) {
        console.error(err);
      }
    }
    const localUsers = JSON.parse(localStorage.getItem('wms_local_users') || '[]');
    return [...users, ...localUsers];
  },

  async approveUser(userId) {
    if (this.profile?.role !== 'Administrator') throw new Error('Admin only');
    
    if (String(userId).startsWith('local-')) {
      const localUsers = JSON.parse(localStorage.getItem('wms_local_users') || '[]');
      const idx = localUsers.findIndex(u => u.id === userId);
      if (idx !== -1) {
        localUsers[idx].status = 'approved';
        localStorage.setItem('wms_local_users', JSON.stringify(localUsers));
      }
      return;
    }

    if (!authSb) return;
    const { error } = await authSb.from('user_profiles')
      .update({ status: 'approved', updated_at: new Date().toISOString() })
      .eq('id', userId);
    if (error) throw error;
    await authSb.from('admin_notifications')
      .update({ read: true })
      .eq('user_id', userId);
  },

  async rejectUser(userId) {
    if (this.profile?.role !== 'Administrator') throw new Error('Admin only');

    if (String(userId).startsWith('local-')) {
      const localUsers = JSON.parse(localStorage.getItem('wms_local_users') || '[]');
      const idx = localUsers.findIndex(u => u.id === userId);
      if (idx !== -1) {
        localUsers[idx].status = 'rejected';
        localStorage.setItem('wms_local_users', JSON.stringify(localUsers));
      }
      return;
    }

    if (!authSb) return;
    const { error } = await authSb.from('user_profiles')
      .update({ status: 'rejected', updated_at: new Date().toISOString() })
      .eq('id', userId);
    if (error) throw error;
  },

  async deleteAuthUser(userId) {
    if (this.profile?.role !== 'Administrator') throw new Error('Admin only');

    if (String(userId).startsWith('local-')) {
      const localUsers = JSON.parse(localStorage.getItem('wms_local_users') || '[]');
      const filtered = localUsers.filter(u => u.id !== userId);
      localStorage.setItem('wms_local_users', JSON.stringify(filtered));
      return;
    }

    if (!authSb) return;
    await authSb.from('user_profiles').delete().eq('id', userId);
  },

  async changeUserRole(userId, newRole) {
    if (this.profile?.role !== 'Administrator') throw new Error('Admin only');

    if (String(userId).startsWith('local-')) {
      const localUsers = JSON.parse(localStorage.getItem('wms_local_users') || '[]');
      const idx = localUsers.findIndex(u => u.id === userId);
      if (idx !== -1) {
        localUsers[idx].role = newRole;
        localStorage.setItem('wms_local_users', JSON.stringify(localUsers));
      }
      return;
    }

    if (!authSb) return;
    const { error } = await authSb.from('user_profiles')
      .update({ role: newRole, updated_at: new Date().toISOString() })
      .eq('id', userId);
    if (error) throw error;
  },

  isAdmin() {
    return this.profile?.role === 'Administrator';
  },

  getCurrentUserName() {
    return this.profile?.full_name || 'Unknown';
  }
};
