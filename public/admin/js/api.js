const api = {
  post: async (url, body = {}) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(auth.getToken() ? { 'Authorization': `Bearer ${auth.getToken()}` } : {})
      },
      body: JSON.stringify(body)
    });
    if (res.status === 401) { auth.logout(); return; }
    return res.json();
  },

  // Clients
  clients: {
    list:   () => api.post('/api/admin/clients/list'),
    create: (d) => api.post('/api/admin/clients/create', d),
    update: (d) => api.post('/api/admin/clients/update', d),
    delete: (id) => api.post('/api/admin/clients/delete', { id }),
    toggle: (id, aktif) => api.post('/api/admin/clients/toggle', { id, aktif }),
  },

  // Templates
  templates: {
    list:   (klien_id) => api.post('/api/admin/templates/list', { klien_id }),
    create: (d) => api.post('/api/admin/templates/create', d),
    update: (d) => api.post('/api/admin/templates/update', d),
    delete: (id) => api.post('/api/admin/templates/delete', { id }),
  },

  // Knowledge Base
  kb: {
    list:   (klien_id) => api.post('/api/admin/kb/list', { klien_id }),
    create: (d) => api.post('/api/admin/kb/create', d),
    update: (d) => api.post('/api/admin/kb/update', d),
    delete: (id) => api.post('/api/admin/kb/delete', { id }),
  },

  // History & Stats
  history:        (d) => api.post('/api/admin/history', d),
  historyPending: (d = {}) => api.post('/api/admin/history/pending', d),
  historyApprove: (d) => api.post('/api/admin/history/approve', d),
  historyReject:  (d) => api.post('/api/admin/history/reject', d),
  historyEdit:    (d) => api.post('/api/admin/history/edit', d),
  stats: {
    summary:  () => api.post('/api/admin/stats/summary'),
    daily:    (d) => api.post('/api/admin/stats/daily', d),
    range:    (d) => api.post('/api/admin/stats/range', d),
    advanced: (d) => api.post('/api/admin/stats/advanced', d),
  },

  // Audit log
  audit: (d = {}) => api.post('/api/admin/audit', d),

  // WhatsApp QR
  wa: {
    qr: (client_id) => api.post('/api/admin/wa/qr', { client_id }),
  }
};
