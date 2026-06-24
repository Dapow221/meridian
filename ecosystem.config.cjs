module.exports = {
  apps: [
    {
      name: "meridian",
      script: "index.js",
      cwd: __dirname,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_restarts: 10,
      min_uptime: "10s",
      env: {
        NODE_ENV: "production",
        // Prefer IPv4: some hosts (e.g. VPS) have AAAA records resolvable but no
        // working IPv6 route, which makes Node's fetch hang until ETIMEDOUT.
        // Safe on dual-stack and IPv4-only environments.
        NODE_OPTIONS: "--dns-result-order=ipv4first",
      },
    },
  ],
};
