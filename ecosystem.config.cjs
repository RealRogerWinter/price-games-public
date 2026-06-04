const path = require("path");

module.exports = {
  apps: [
    {
      name: "price-game",
      script: "apps/server/dist/index.js",
      // Resolve paths relative to this config's location so the repo can live
      // anywhere; override with PM2 env or run from the repo root.
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        PORT: 3001,
      },
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "500M",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: path.join(__dirname, "logs", "error.log"),
      out_file: path.join(__dirname, "logs", "out.log"),
      merge_logs: true,
      max_restarts: 10,
      min_uptime: "10s",
      kill_timeout: 5000,
      listen_timeout: 3000,
    },
  ],
};
