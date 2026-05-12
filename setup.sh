#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  Setup otomatis — satu perintah dari nol ke production
#  Cocok untuk: Ubuntu 22.04 / 24.04 LTS, single server
#
#  Cara pakai:
#    chmod +x setup.sh
#    sudo ./setup.sh
# ═══════════════════════════════════════════════════════════

set -e

DOMAIN="${1:-}"          # opsional: ./setup.sh yourdomain.com
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_USER="${SUDO_USER:-$USER}"

echo ""
echo "════════════════════════════════════════"
echo "  Chatbot Setup — $(date '+%Y-%m-%d')"
echo "════════════════════════════════════════"
echo ""

# ─── 1. Update & install tools ─────────────────────────────
echo "[1/7] Install dependensi sistem..."
apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx curl

# ─── 2. Install Node.js 22 (via NodeSource) ────────────────
echo "[2/7] Install Node.js 22..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "  Node: $(node -v) | npm: $(npm -v)"

# ─── 3. Install PM2 ────────────────────────────────────────
echo "[3/7] Install PM2..."
npm install -g pm2 --quiet
echo "  PM2: $(pm2 --version)"

# ─── 4. Setup project ──────────────────────────────────────
echo "[4/7] Install npm dependencies..."
cd "$APP_DIR"
npm install --omit=dev --quiet

# Buat folder logs
mkdir -p logs
chown -R "$NODE_USER":"$NODE_USER" logs

# Salin .env jika belum ada
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  ⚠️  .env dibuat dari .env.example — WAJIB isi nilainya dulu!"
fi

# ─── 5. Start DB ───────────────────────────────────────────
echo "[5/7] Start PostgreSQL (Docker)..."
if command -v docker &>/dev/null; then
  docker compose up -d
  sleep 3
  node src/scripts/init-db.js
  # Jalankan migrations (idempotent)
  export $(grep -v '^#' .env | xargs)
  PGPASSWORD="$PGPASSWORD" psql "$DATABASE_URL" -f sql/migration_001_add_processed_messages.sql 2>/dev/null || true
  PGPASSWORD="$PGPASSWORD" psql "$DATABASE_URL" -f sql/migration_002_provider_system_prompt.sql 2>/dev/null || true
  PGPASSWORD="$PGPASSWORD" psql "$DATABASE_URL" -f sql/migration_003_audit_log.sql 2>/dev/null || true
  PGPASSWORD="$PGPASSWORD" psql "$DATABASE_URL" -f sql/migration_004_gowa_provider.sql 2>/dev/null || true
  PGPASSWORD="$PGPASSWORD" psql "$DATABASE_URL" -f sql/migration_005_conversations_state.sql 2>/dev/null || true
else
  echo "  ⚠️  Docker tidak ditemukan — pastikan PostgreSQL sudah jalan manual."
fi

# ─── 6. Setup nginx ────────────────────────────────────────
echo "[6/7] Setup nginx..."
NGINX_CONF="/etc/nginx/sites-available/chatbot"
cp "$APP_DIR/nginx/chatbot.conf" "$NGINX_CONF"

if [ -n "$DOMAIN" ]; then
  # Ganti placeholder domain
  sed -i "s/yourdomain.com/$DOMAIN/g" "$NGINX_CONF"
  echo "  Domain: $DOMAIN"
else
  # Pakai config HTTP saja (tanpa SSL) untuk localhost dev
  cat > "$NGINX_CONF" << 'NGINX'
limit_req_zone $binary_remote_addr zone=webhook_limit:10m rate=20r/m;
server {
    listen 80 default_server;
    client_max_body_size 512k;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    server_tokens off;
    location /webhook {
        limit_req zone=webhook_limit burst=10 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_connect_timeout 5s;
        proxy_read_timeout 10s;
    }
    location /health {
        proxy_pass http://127.0.0.1:3000;
    }
    location / { return 404; }
}
NGINX
  echo "  ⚠️  Tanpa domain → HTTP saja. Jalankan: sudo certbot --nginx -d DOMAIN untuk HTTPS"
fi

# Aktifkan site
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/chatbot
rm -f /etc/nginx/sites-enabled/default    # hapus default nginx

nginx -t && systemctl reload nginx
echo "  nginx OK"

# ─── 7. Start app via PM2 ──────────────────────────────────
echo "[7/7] Start chatbot via PM2..."
cd "$APP_DIR"
sudo -u "$NODE_USER" pm2 start ecosystem.config.js --env production 2>/dev/null || \
  sudo -u "$NODE_USER" pm2 restart chatbot

# Auto-start PM2 saat server reboot
sudo -u "$NODE_USER" pm2 save
pm2 startup systemd -u "$NODE_USER" --hp "/home/$NODE_USER" | tail -1 | bash || true

echo ""
echo "════════════════════════════════════════"
echo "  ✅ Setup selesai!"
echo ""
echo "  Cek status  : pm2 status"
echo "  Lihat log   : pm2 logs chatbot"
echo "  Monitor     : pm2 monit"
echo "  Health check: curl http://localhost/health"
if [ -n "$DOMAIN" ]; then
  echo "  Pasang SSL  : sudo certbot --nginx -d $DOMAIN"
fi
echo "════════════════════════════════════════"
