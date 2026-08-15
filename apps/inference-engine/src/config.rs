use serde::Deserialize;
use std::env;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize)]
pub struct AppConfig {
    pub server: ServerConfig,
    pub models: ModelsConfig,
    pub limits: LimitsConfig,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServerConfig {
    pub grpc_port: u16,
    pub total_ram_budget_mb: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelsConfig {
    pub weights_dir: String,
    pub use_mmap: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LimitsConfig {
    pub max_concurrent_per_model: usize,
    pub max_context_length: u32,
    pub default_n_threads: i32,
    #[serde(default = "default_true")]
    pub enable_continuous_batching: bool,
    #[serde(default = "default_batch_seqs")]
    pub batch_max_sequences: usize,
}

fn default_true() -> bool {
    true
}

fn default_batch_seqs() -> usize {
    4
}

impl AppConfig {
    pub fn load() -> anyhow::Result<Self> {
        let path = env::var("INFERENCE_CONFIG").unwrap_or_else(|_| "config.toml".into());
        let raw = fs::read_to_string(&path).unwrap_or_else(|_| include_str!("../config.toml").to_string());
        let mut cfg: AppConfig = toml::from_str(&raw)?;

        if let Ok(v) = env::var("GRPC_PORT") {
            cfg.server.grpc_port = v.parse()?;
        }
        if let Ok(v) = env::var("TOTAL_RAM_BUDGET_MB") {
            cfg.server.total_ram_budget_mb = v.parse()?;
        }
        if let Ok(v) = env::var("MODEL_WEIGHTS_DIR") {
            cfg.models.weights_dir = v;
        }
        if let Ok(v) = env::var("USE_MMAP") {
            cfg.models.use_mmap = v.parse().unwrap_or(true);
        }
        if let Ok(v) = env::var("DEFAULT_N_THREADS") {
            cfg.limits.default_n_threads = v.parse()?;
        }
        if let Ok(v) = env::var("MAX_CONCURRENT_PER_MODEL") {
            cfg.limits.max_concurrent_per_model = v.parse()?;
        }
        if let Ok(v) = env::var("ENABLE_CONTINUOUS_BATCHING") {
            cfg.limits.enable_continuous_batching = v.parse().unwrap_or(true);
        }

        Ok(cfg)
    }

    pub fn resolve_weights_path(&self, relative_or_name: &str) -> PathBuf {
        let candidate = PathBuf::from(relative_or_name);
        if candidate.is_absolute() {
            // Only allow absolute paths under the configured weights_dir for safety
            let base = PathBuf::from(&self.models.weights_dir);
            if candidate.starts_with(&base) {
                return candidate;
            }
            return base.join(
                candidate
                    .file_name()
                    .unwrap_or_else(|| std::ffi::OsStr::new(relative_or_name)),
            );
        }
        PathBuf::from(&self.models.weights_dir).join(relative_or_name)
    }
}
