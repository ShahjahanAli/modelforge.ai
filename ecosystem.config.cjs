/**
 * PM2 ecosystem for Ubuntu production.
 *
 * Loads APP_ROOT/.env (preferred) and .env.production (fallback) into every
 * process. Without this, gateway crash-loops: loadEnv() requires DATABASE_URL,
 * JWT_SECRET, INTERNAL_SERVICE_TOKEN, etc., which are not in the hardcoded env.
 *
 *   cd /var/www/modelforge.ai
 *   cp -n .env.production .env   # once; edit secrets/ports on the server
 *   pm2 delete modelforge-gateway modelforge-web modelforge-usage-worker modelforge-invoice-worker
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *
 * After editing .env:
 *   pm2 restart ecosystem.config.cjs --update-env
 *
 * Override deploy root: MODELFORGE_APP_ROOT=/path pm2 start ecosystem.config.cjs
 */
const fs = require("fs");
const path = require("path");

const APP_ROOT = process.env.MODELFORGE_APP_ROOT || __dirname;

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const raw of fs.readFileSync(filePath, "utf8").split(/\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const cleaned = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = cleaned.indexOf("=");
    if (eq <= 0) continue;
    const key = cleaned.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = cleaned.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function isTruthy(value) {
  if (value === undefined || value === null || value === "") return false;
  return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

const envProductionPath = path.join(APP_ROOT, ".env.production");
const envPath = path.join(APP_ROOT, ".env");
const fileEnv = {
  ...parseEnvFile(envProductionPath),
  ...parseEnvFile(envPath),
};

const loadedFrom = [
  fs.existsSync(envProductionPath) ? ".env.production" : null,
  fs.existsSync(envPath) ? ".env" : null,
].filter(Boolean);

if (loadedFrom.length === 0) {
  console.warn(
    `[ecosystem] WARNING: no .env or .env.production under ${APP_ROOT} — processes will miss secrets.`,
  );
} else {
  console.log(`[ecosystem] loaded env from ${loadedFrom.join(" + ")} (${APP_ROOT})`);
}

for (const required of ["DATABASE_URL", "JWT_SECRET", "INTERNAL_SERVICE_TOKEN", "AUTH_SECRET"]) {
  if (!fileEnv[required]) {
    console.warn(`[ecosystem] WARNING: ${required} is missing — gateway/web will fail to start.`);
  }
}

/** Path defaults only when the file does not set them. File values always win. */
const pathDefaults = {
  MODEL_WEIGHTS_DIR: `${APP_ROOT}/data/models`,
  LLAMA_SERVER_BIN: `${APP_ROOT}/vendor/llama.cpp/llama-server`,
  MODELFORGE_SIGNING_DIR: `${APP_ROOT}/data/signing`,
  VOICE_UPLOAD_DIR: `${APP_ROOT}/data/audio`,
  GATEWAY_INTERNAL_URL: "http://127.0.0.1:9000",
};

const sharedEnv = {
  ...pathDefaults,
  ...fileEnv,
  NODE_ENV: "production",
};

const redisEnabled = isTruthy(sharedEnv.REDIS_ENABLED);

const common = {
  cwd: APP_ROOT,
  instances: 1,
  exec_mode: "fork",
  autorestart: true,
  watch: false,
  kill_timeout: 10_000,
  min_uptime: "10s",
  exp_backoff_restart_delay: 2000,
};

const apps = [
  {
    ...common,
    name: "modelforge-gateway",
    script: "./apps/gateway/dist/index.js",
    node_args: "--enable-source-maps",
    max_restarts: 30,
    restart_delay: 3000,
    env: { ...sharedEnv },
  },
  {
    ...common,
    name: "modelforge-web",
    script: "./scripts/run-web.mjs",
    args: "start",
    node_args: "--enable-source-maps",
    max_restarts: 30,
    restart_delay: 3000,
    env: { ...sharedEnv },
  },
];

if (redisEnabled) {
  apps.push(
    {
      ...common,
      name: "modelforge-usage-worker",
      script: "./apps/gateway/dist/workers/usage-worker.js",
      max_restarts: 20,
      restart_delay: 5000,
      env: { ...sharedEnv },
    },
    {
      ...common,
      name: "modelforge-invoice-worker",
      script: "./apps/gateway/dist/workers/invoice-worker.js",
      max_restarts: 20,
      restart_delay: 5000,
      env: { ...sharedEnv },
    },
  );
} else {
  console.log(
    "[ecosystem] REDIS_ENABLED=false — not starting BullMQ workers (gateway writes usage to Postgres).",
  );
}

module.exports = { apps };
