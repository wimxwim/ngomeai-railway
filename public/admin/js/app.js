// ─── XSS Escape ────────────────────────────────────────────────────────────
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Toast ─────────────────────────────────────────────────────────────────
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type === 'success' ? 'toast-success' : 'toast-error'}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ─── Modal ─────────────────────────────────────────────────────────────────
function showModal({ title, fields, onSubmit, submitLabel = 'Simpan' }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">
        <h3 class="modal-title">${esc(title)}</h3>
        <button id="closeModal" class="modal-close">✕</button>
      </div>
      <form id="modalForm">
        ${fields.map(f => `
          <div class="form-group">
            <label>${esc(f.label)}${f.required ? ' <span style="color:#dc2626">*</span>' : ''}</label>
            ${f.type === 'textarea'
              ? `<textarea name="${esc(f.name)}" rows="3" placeholder="${esc(f.placeholder||'')}">${esc(f.value||'')}</textarea>`
              : f.type === 'select'
              ? `<select name="${esc(f.name)}">${(f.options||[]).map(o => `<option value="${esc(o.value)}" ${f.value===o.value?'selected':''}>${esc(o.label)}</option>`).join('')}</select>`
              : `<input type="${esc(f.type||'text')}" name="${esc(f.name)}" placeholder="${esc(f.placeholder||'')}" value="${esc(f.value||'')}">`
            }
          </div>
        `).join('')}
        <div class="flex gap-3" style="margin-top:20px">
          <button type="submit" class="btn btn-primary w-full">${esc(submitLabel)}</button>
          <button type="button" id="cancelModal" class="btn btn-ghost">Batal</button>
        </div>
      </form>
    </div>`;

  document.body.appendChild(overlay);
  overlay.querySelector('#closeModal').onclick = () => overlay.remove();
  overlay.querySelector('#cancelModal').onclick = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector('#modalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    await onSubmit(data);
    overlay.remove();
  });
}

function confirmDelete(msg, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:380px;text-align:center">
      <div style="font-size:32px;margin-bottom:12px">🗑️</div>
      <h3 class="modal-title" style="margin-bottom:8px">Konfirmasi Hapus</h3>
      <p class="text-sm text-muted" style="margin-bottom:20px">${msg}</p>
      <div class="flex gap-3">
        <button id="confirmYes" class="btn btn-danger w-full">Ya, Hapus</button>
        <button id="confirmNo" class="btn btn-ghost w-full">Batal</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#confirmNo').onclick = () => overlay.remove();
  overlay.querySelector('#confirmYes').onclick = () => { overlay.remove(); onConfirm(); };
}

// ─── Layout ────────────────────────────────────────────────────────────────
function renderLayout(pageTitle, contentHtml) {
  const nav = [
    { id: 'dashboard', label: '📊 Dashboard',      href: '/admin/dashboard.html' },
    { id: 'clients',   label: '👥 Klien',           href: '/admin/clients.html' },
    { id: 'templates', label: '📝 Template',        href: '/admin/templates.html' },
    { id: 'kb',        label: '🧠 Knowledge Base',  href: '/admin/kb.html' },
    { id: 'history',   label: '💬 Chat History',    href: '/admin/history.html' },
    { id: 'stats',     label: '📈 Statistik',       href: '/admin/stats.html' },
  ];
  const current = window.location.pathname.split('/').pop().replace('.html', '');

  document.body.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <div class="sidebar-brand">
          <span style="font-size:22px">🤖</span>
          <span>NgomeAI</span>
        </div>
        <nav class="sidebar-nav">
          ${nav.map(n => `
            <a href="${n.href}" class="sidebar-link ${current === n.id ? 'active' : ''}">${n.label}</a>
          `).join('')}
        </nav>
        <div class="sidebar-footer">
          <div class="sidebar-user">${auth.getUsername()}</div>
          <button onclick="auth.logout()" class="btn btn-ghost btn-sm" style="justify-content:flex-start">🚪 Logout</button>
        </div>
      </aside>
      <main class="main">
        <h1 class="page-title">${pageTitle}</h1>
        ${contentHtml}
      </main>
    </div>`;
}
