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
    // Local offline bypass — ONLY trusted for locally-registered users (id starts with "local-").
    // This prevents anyone from crafting a fake bypass session to impersonate a Supabase user.
    const bypassSession = localStorage.getItem('wms_bypass_session');
    if (bypassSession) {
      const bypassProfile = JSON.parse(localStorage.getItem('wms_bypass_profile') || 'null');

      // Validate: must be a local user and must be approved
      if (!bypassProfile || !bypassProfile.id || !String(bypassProfile.id).startsWith('local-')) {
        // Not a valid local user — clear and redirect
        localStorage.removeItem('wms_bypass_session');
        localStorage.removeItem('wms_bypass_profile');
        window.location.replace('login.html');
        return;
      }
      if (bypassProfile.status !== 'approved') {
        // Local user not yet approved — clear and redirect
        localStorage.removeItem('wms_bypass_session');
        localStorage.removeItem('wms_bypass_profile');
        window.location.replace('login.html');
        return;
      }

      this.session = JSON.parse(bypassSession);
      this.profile = bypassProfile;

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

    // Fetch profile using RPC — avoids RLS session timing issues
    const { data: profileRows } = await authSb.rpc('get_my_profile', {
      user_id: session.user.id
    });
    const profile = profileRows && profileRows.length > 0 ? profileRows[0] : null;

    if (!profile || profile.status !== 'approved') {
      await authSb.auth.signOut();
      window.location.replace('login.html');
      return;
    }

    const normalizedProfile = {
      ...profile,
      full_name: profile.full_name || profile.name || session.user.user_metadata?.full_name || session.user.email || 'Unknown',
      email: profile.email || session.user.email || ''
    };

    this.session = session;
    this.profile = normalizedProfile;

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
        // Fire and forget — don't block signout on log insert
        authSb.from('login_log').insert({
          user_id: this.session?.user?.id,
          email: this.profile?.email,
          full_name: this.profile?.full_name,
          timestamp: new Date().toISOString(),
          event: 'logout'
        }).then(() => {}).catch(() => {});
        // Small delay to let the insert fire before redirect
        await new Promise(r => setTimeout(r, 150));
      }
    } catch (_) {}
    if (authSb) await authSb.auth.signOut();
    window.location.replace('login.html');
  },

  // Update the header avatar and name
  _renderHeaderUser() {
    const p = this.profile;
    if (!p) return;
    const initials = (p.full_name || '?').split(' ').filter(Boolean).map(n => n[0]).join('').toUpperCase().substring(0, 2);
    const badge = document.getElementById('global-profile-initials');
    const nameEl = document.getElementById('global-header-username');
    const roleEl = document.getElementById('global-header-role');
    if (badge) badge.textContent = initials || '??';
    if (nameEl) nameEl.textContent = p.full_name || p.name || 'User';
    if (roleEl) roleEl.textContent = p.role || 'Operator';
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
      authSb.from('admin_notifications')
        .update({ read: true })
        .eq('read', false)
        .then(() => {}).catch(() => {});
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
    const { data: profileRows } = await authSb.rpc('get_my_profile', {
      user_id: this.session.user.id
    });
    return profileRows && profileRows.length > 0 ? profileRows[0] : null;
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
      return this.profile;
    }

    if (!authSb) {
      throw new Error('Supabase auth client not available. Profile changes require an online connection.');
    }

    const userId = this.session?.user?.id;
    if (!userId) {
      throw new Error('Unable to resolve current user session. Please sign in again.');
    }

    const updates = {
      full_name,
      phone,
      department,
      updated_at: new Date().toISOString()
    };

    let data = null;
    let error = null;

    const updateResult = await authSb.from('user_profiles')
      .update(updates)
      .eq('id', userId)
      .select()
      .maybeSingle();

    data = updateResult.data;
    error = updateResult.error;

    if (error) {
      throw error;
    }

    if (!data) {
      const insertResult = await authSb.from('user_profiles')
        .insert({
          id: userId,
          email: this.profile?.email || null,
          status: this.profile?.status || 'approved',
          created_at: new Date().toISOString(),
          ...updates
        })
        .select()
        .maybeSingle();
      data = insertResult.data;
      error = insertResult.error;
      if (error) throw error;
    }

    if (!data || data.id !== userId) {
      const verifyResult = await authSb.from('user_profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();
      if (verifyResult.error) throw verifyResult.error;
      data = verifyResult.data;
      if (!data) {
        throw new Error('Profile update completed but profile row could not be verified. Please refresh and try again.');
      }
      console.warn('[WMS] Verified profile row after update for user:', userId);
    }

    const mergedProfile = {
      ...this.profile,
      ...data,
      full_name,
      name: full_name,
      phone,
      department
    };

    this.profile = mergedProfile;

    if (authSb && typeof authSb.auth.updateUser === 'function') {
      const { error: metadataError } = await authSb.auth.updateUser({ data: { full_name } });
      if (metadataError) {
        console.warn('[WMS] profile metadata update failed:', metadataError.message || metadataError);
      }
    }

    this._renderHeaderUser();
    if (window.WMSDatabase) {
      WMSDatabase.setCurrentUser({
        username: this.profile.email,
        name: full_name,
        role: this.profile.role,
        email: this.profile.email,
        id: userId,
        phone: phone || '',
        department: department || ''
      });
    }
    return this.profile;
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
    return pending.map(u => ({
      id:        u.id        || '',
      email:     u.email     || '',
      full_name: u.full_name || u.name || '(No name)',
      role:      u.role      || 'Operator',
      status:    u.status    || 'pending',
      created_at: u.created_at || ''
    }));
  },

  async getAllUsers() {
    let users = [];
    if (authSb) {
      try {
        // Prefer a database function that can return all user profiles for admins.
        const { data: rpcData, error: rpcError } = await authSb.rpc('get_all_user_profiles');
        if (!rpcError && Array.isArray(rpcData)) {
          users = [...rpcData];
        } else {
          if (rpcError) {
            console.warn('[WMS] getAllUsers RPC unavailable, falling back to direct user_profiles query:', rpcError.message || rpcError);
          }
          const { data, error } = await authSb.from('user_profiles')
            .select('*')
            .order('created_at', { ascending: false });
          if (error) {
            throw error;
          }
          if (data) users = [...data];
        }
      } catch (err) {
        console.error('[WMS] getAllUsers failed:', err);
      }
    }
    // Normalize all rows — user_profiles uses full_name, local users may use name
    return users.map(u => ({
      id:        u.id        || '',
      email:     u.email     || '',
      full_name: u.full_name || u.name || '(No name)',
      role:      u.role      || 'Operator',
      status:    u.status    || 'unknown',
      created_at: u.created_at || ''
    }));
  },

  async approveUser(userId) {
    if (this.profile?.role !== 'Administrator') throw new Error('Admin only');
    if (!authSb) return;
    const { error } = await authSb.from('user_profiles')
      .update({ status: 'approved', updated_at: new Date().toISOString() })
      .eq('id', userId);
    if (error) throw error;
    // Mark notification read — fire and forget
    authSb.from('admin_notifications')
      .update({ read: true }).eq('user_id', userId)
      .then(() => {}).catch(() => {});
  },

  async rejectUser(userId) {
    if (this.profile?.role !== 'Administrator') throw new Error('Admin only');
    if (!authSb) return;
    const { error } = await authSb.from('user_profiles')
      .update({ status: 'rejected', updated_at: new Date().toISOString() })
      .eq('id', userId);
    if (error) throw error;
  },

  async deleteAuthUser(userId) {
    if (this.profile?.role !== 'Administrator') throw new Error('Admin only');
    // Prevent self-deletion
    if (this.session?.user?.id === userId) throw new Error('You cannot delete your own account.');
    if (!authSb) return;
    // Delete from user_profiles (Supabase auth user itself requires admin API — we just revoke access)
    await authSb.from('user_profiles').delete().eq('id', userId);
    // Belt-and-suspenders: also remove from legacy users table if present
    authSb.from('users').delete().eq('id', userId).then(() => {}).catch(() => {});
  },

  async changeUserRole(userId, newRole) {
    if (this.profile?.role !== 'Administrator') throw new Error('Admin only');
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
