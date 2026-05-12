// PM2 process manager — free, ringan, auto-restart
// Install: npm install -g pm2
// Start:   pm2 start ecosystem.config.js
// Monitor: pm2 monit
// Logs:    pm2 logs chatbot
// Startup: pm2 startup && pm2 save   (auto-start saat server reboot)

module.exports = {
  apps: [{
    name:        "chatbot",
    script:      "src/index.js",
    instances:   1,               // single instance (pakai 1 core saja)
    exec_mode:   "fork",

    // Auto-restart jika crash
    autorestart:  true,
    max_restarts: 10,
    min_uptime:   "10s",
    restart_delay: 3000,

    // Restart otomatis jika memory melebihi 256MB
    max_memory_restart: "256M",

    // Environment production
    env: {
      NODE_ENV:  "production",
      LOG_LEVEL: "info"
    },

    // Structured log ke file (PM2 rotate otomatis)
    out_file:    "./logs/app.log",
    error_file:  "./logs/error.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    merge_logs:  true,

    // Graceful shutdown: tunggu 5 detik sebelum SIGKILL
    kill_timeout: 5000,
    listen_timeout: 8000,

    // Watch: matikan di production (boros resource)
    watch: false
  }]
};
