/**
 * PM2 ecosystem config for Ubuntu production deployment.
 * Place the repo under /var/www/modelforge.ai and run:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 */
const APP_ROOT = "/var/www/modelforge.ai";

module.exports = {
  apps: [
    {
      name: "modelforge-gateway",
      cwd: APP_ROOT,
      script: "./apps/gateway/dist/index.js",
      node_args: "--enable-source-maps",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 15,
      restart_delay: 3000,
      watch: false,
      env: {
        NODE_ENV: "production",
        GATEWAY_PORT: "9000",
        INFERENCE_BACKEND: "llama-server",
        MODEL_WEIGHTS_DIR: `${APP_ROOT}/data/models`,
        LLAMA_SERVER_BIN: `${APP_ROOT}/vendor/llama.cpp/llama-server`,
        LLAMA_SERVER_PORT_BASE: "9100",
        LLAMA_AUTO_LOAD: "true",
        USE_MMAP: "true",
        DEFAULT_N_THREADS: "8",
        MAX_CONCURRENT_PER_MODEL: "2",
        INFERENCE_TIMEOUT_MS: "900000",
        MODELFORGE_SIGNING_DIR: `${APP_ROOT}/data/signing`,
        MODELFORGE_PII_REDACT: "true",
      },
    },
    {
      name: "modelforge-web",
      cwd: APP_ROOT,
      script: "./scripts/run-web.mjs",
      args: "start",
      node_args: "--enable-source-maps",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 15,
      restart_delay: 3000,
      watch: false,
      env: {
        NODE_ENV: "production",
        WEB_PORT: "9001",
        GATEWAY_INTERNAL_URL: "http://127.0.0.1:9000",
      },
    },
    {
      name: "modelforge-usage-worker",
      cwd: APP_ROOT,
      script: "./apps/gateway/dist/workers/usage-worker.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      env: {
        NODE_ENV: "production",
        REDIS_ENABLED: "true",
      },
    },
    {
      name: "modelforge-invoice-worker",
      cwd: APP_ROOT,
      script: "./apps/gateway/dist/workers/invoice-worker.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      env: {
        NODE_ENV: "production",
        REDIS_ENABLED: "true",
      },
    },
  ],
};
