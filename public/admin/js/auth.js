const auth = {
  getToken: () => localStorage.getItem('admin_token'),
  getUsername: () => localStorage.getItem('admin_username') || 'Admin',
  isAuthenticated: () => !!localStorage.getItem('admin_token'),
  logout: async () => {
    try { await api.post('/api/admin/logout'); } catch {}
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_username');
    window.location.href = '/admin/index.html';
  },
  requireAuth: () => {
    if (!auth.isAuthenticated()) window.location.href = '/admin/index.html';
  }
};
