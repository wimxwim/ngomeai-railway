if (localStorage.getItem('admin_token')) {
  window.location.replace('/admin/dashboard.html');
}

document.getElementById('submitBtn').addEventListener('click', doLogin);
document.getElementById('username').addEventListener('keydown', function(e) { if (e.key === 'Enter') doLogin(); });
document.getElementById('password').addEventListener('keydown', function(e) { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const errEl    = document.getElementById('error');
  const spinner  = document.getElementById('spinner');
  const btnText  = document.getElementById('btnText');
  const btn      = document.getElementById('submitBtn');

  if (!username || !password) {
    errEl.textContent = 'Username dan password wajib diisi';
    errEl.classList.remove('hidden');
    return;
  }

  errEl.classList.add('hidden');
  btn.disabled = true;
  spinner.classList.remove('hidden');
  btnText.textContent = 'Memproses...';

  try {
    const res  = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (data.success) {
      localStorage.setItem('admin_token', data.data.token);
      localStorage.setItem('admin_username', username);
      window.location.replace('/admin/dashboard.html');
    } else {
      errEl.textContent = data.error || 'Username atau password salah';
      errEl.classList.remove('hidden');
      btn.disabled = false;
      spinner.classList.add('hidden');
      btnText.textContent = 'Masuk';
    }
  } catch (err) {
    errEl.textContent = 'Tidak dapat terhubung ke server. Pastikan server berjalan.';
    errEl.classList.remove('hidden');
    btn.disabled = false;
    spinner.classList.add('hidden');
    btnText.textContent = 'Masuk';
  }
}
