//! Model pool with RAM-budgeted LRU eviction and mmap-backed loads.
//!
//! Generation uses llama-cpp-2 when available. If the GGUF file is missing or
//! llama.cpp fails to initialize (common in CI without models), a deterministic
//! echo generator is used so the gRPC surface remains testable.

use crate::config::AppConfig;
use crate::error::EngineError;
use llama_cpp_2::model::LlamaModel;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, Semaphore};
use tracing::{info, warn};

#[derive(Clone, Debug)]
pub struct LoadedModelInfo {
    pub model_id: String,
    pub weights_path: PathBuf,
    pub ram_used_mb: u64,
    pub loaded_at_unix: i64,
    pub active_requests: i32,
    pub tokens_per_sec_avg: f64,
    pub n_threads: i32,
    pub context_length: u32,
}

struct ResidentModel {
    model_id: String,
    weights_path: PathBuf,
    ram_used_mb: u64,
    loaded_at_unix: i64,
    last_used_at: RwLock<Instant>,
    active_requests: AtomicI32,
    tokens_generated: AtomicU64,
    elapsed_ms: AtomicU64,
    n_threads: i32,
    context_length: u32,
    semaphore: Arc<Semaphore>,
    /// Retaining this Arc keeps mmap-backed weights resident across requests.
    model: Option<Arc<LlamaModel>>,
}

pub struct ModelPool {
    cfg: AppConfig,
    models: RwLock<HashMap<String, Arc<ResidentModel>>>,
}

impl ModelPool {
    pub fn new(cfg: AppConfig) -> Self {
        Self {
            cfg,
            models: RwLock::new(HashMap::new()),
        }
    }

    pub fn config(&self) -> &AppConfig {
        &self.cfg
    }

    pub fn list(&self) -> Vec<LoadedModelInfo> {
        self.models
            .read()
            .values()
            .map(|m| LoadedModelInfo {
                model_id: m.model_id.clone(),
                weights_path: m.weights_path.clone(),
                ram_used_mb: m.ram_used_mb,
                loaded_at_unix: m.loaded_at_unix,
                active_requests: m.active_requests.load(Ordering::Relaxed),
                tokens_per_sec_avg: Self::tps(m),
                n_threads: m.n_threads,
                context_length: m.context_length,
            })
            .collect()
    }

    pub fn used_ram_mb(&self) -> u64 {
        self.models.read().values().map(|m| m.ram_used_mb).sum()
    }

    pub fn health(
        &self,
    ) -> (
        bool,
        u64,
        u64,
        i32,
        i32,
    ) {
        let loaded = self.models.read().len() as i32;
        let used = self.used_ram_mb();
        let total = self.cfg.server.total_ram_budget_mb;
        let cores = num_cpus::get_physical() as i32;
        (true, total, used, loaded, cores)
    }

    fn tps(m: &ResidentModel) -> f64 {
        let tokens = m.tokens_generated.load(Ordering::Relaxed) as f64;
        let ms = m.elapsed_ms.load(Ordering::Relaxed) as f64;
        if ms <= 0.0 {
            0.0
        } else {
            tokens / (ms / 1000.0)
        }
    }

    fn estimate_ram_mb(path: &Path) -> u64 {
        std::fs::metadata(path)
            .map(|m| (m.len() / (1024 * 1024)).max(64))
            .unwrap_or(512)
    }

    fn now_unix() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    fn try_probe_gguf(path: &Path) -> bool {
        path.exists()
            && path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("gguf"))
                .unwrap_or(false)
    }

    pub fn load_model(
        &self,
        model_id: &str,
        weights_path: &str,
        context_length: u32,
        n_threads: i32,
        _quantization: &str,
        use_mmap: bool,
    ) -> Result<(u64, u64), EngineError> {
        if model_id.is_empty() {
            return Err(EngineError::InvalidArgument("model_id required".into()));
        }

        {
            let guard = self.models.read();
            if guard.contains_key(model_id) {
                let m = &guard[model_id];
                return Ok((0, m.ram_used_mb));
            }
        }

        let path = self.cfg.resolve_weights_path(weights_path);
        let start = Instant::now();
        let real = Self::try_probe_gguf(&path);
        if !real {
            warn!(
                model_id,
                path = %path.display(),
                "GGUF not found; loading echo stub so pool/API remain usable"
            );
        } else {
            info!(
                model_id,
                path = %path.display(),
                use_mmap,
                "Loading GGUF model (mmap={})",
                use_mmap || self.cfg.models.use_mmap
            );
        }

        let ram = if real {
            Self::estimate_ram_mb(&path)
        } else {
            64
        };

        self.evict_until(ram)?;
        let model = if real {
            Some(crate::backend::load_model(
                &path,
                use_mmap || self.cfg.models.use_mmap,
            )?)
        } else {
            None
        };

        let threads = if n_threads > 0 {
            n_threads
        } else {
            self.cfg.limits.default_n_threads
        };
        let ctx = if context_length > 0 {
            context_length.min(self.cfg.limits.max_context_length)
        } else {
            4096
        };

        let resident = Arc::new(ResidentModel {
            model_id: model_id.to_string(),
            weights_path: path,
            ram_used_mb: ram,
            loaded_at_unix: Self::now_unix(),
            last_used_at: RwLock::new(Instant::now()),
            active_requests: AtomicI32::new(0),
            tokens_generated: AtomicU64::new(0),
            elapsed_ms: AtomicU64::new(0),
            n_threads: threads,
            context_length: ctx,
            semaphore: Arc::new(Semaphore::new(self.cfg.limits.max_concurrent_per_model)),
            model,
        });

        self.models
            .write()
            .insert(model_id.to_string(), resident.clone());

        let ms = start.elapsed().as_millis() as u64;
        info!(model_id, ram_mb = ram, load_time_ms = ms, "Model loaded into pool");
        Ok((ms, ram))
    }

    fn evict_until(&self, needed_mb: u64) -> Result<(), EngineError> {
        let budget = self.cfg.server.total_ram_budget_mb;
        loop {
            let used = self.used_ram_mb();
            if used + needed_mb <= budget {
                return Ok(());
            }
            let victim = {
                let guard = self.models.read();
                guard
                    .values()
                    .filter(|m| m.active_requests.load(Ordering::Relaxed) == 0)
                    .min_by_key(|m| *m.last_used_at.read())
                    .map(|m| m.model_id.clone())
            };
            match victim {
                Some(id) => {
                    info!(model_id = %id, "Evicting LRU model to free RAM");
                    self.unload_model(&id)?;
                }
                None => {
                    return Err(EngineError::Oom(format!(
                        "need {needed_mb}MB, used {used}MB, budget {budget}MB, no idle models to evict"
                    )));
                }
            }
        }
    }

    pub fn unload_model(&self, model_id: &str) -> Result<(), EngineError> {
        let mut guard = self.models.write();
        match guard.get(model_id) {
            None => Err(EngineError::ModelNotFound(model_id.into())),
            Some(m) if m.active_requests.load(Ordering::Relaxed) > 0 => Err(
                EngineError::ModelUnavailable("model has active requests".into()),
            ),
            Some(_) => {
                guard.remove(model_id);
                Ok(())
            }
        }
    }

    pub fn ensure_loaded(&self, model_id: &str) -> Result<Arc<ResidentModelHandle>, EngineError> {
        let guard = self.models.read();
        let m = guard
            .get(model_id)
            .cloned()
            .ok_or_else(|| EngineError::ModelNotFound(model_id.into()))?;
        Ok(Arc::new(ResidentModelHandle { inner: m }))
    }
}

/// Public handle so generate/batching modules don't depend on private fields.
pub struct ResidentModelHandle {
    inner: Arc<ResidentModel>,
}

impl ResidentModelHandle {
    pub fn model_id(&self) -> &str {
        &self.inner.model_id
    }
    pub fn weights_path(&self) -> &Path {
        &self.inner.weights_path
    }
    pub fn real_weights(&self) -> bool {
        self.inner.model.is_some()
    }
    pub fn model(&self) -> Option<Arc<LlamaModel>> {
        self.inner.model.clone()
    }
    pub fn n_threads(&self) -> i32 {
        self.inner.n_threads
    }
    pub fn context_length(&self) -> u32 {
        self.inner.context_length
    }
    pub fn semaphore(&self) -> Arc<Semaphore> {
        self.inner.semaphore.clone()
    }
    pub fn begin_request(&self) {
        self.inner.active_requests.fetch_add(1, Ordering::Relaxed);
    }
    pub fn end_request(&self) {
        self.inner.active_requests.fetch_sub(1, Ordering::Relaxed);
    }
    pub fn record_tokens(&self, tokens: u64, elapsed_ms: u64) {
        self.inner
            .tokens_generated
            .fetch_add(tokens, Ordering::Relaxed);
        self.inner.elapsed_ms.fetch_add(elapsed_ms, Ordering::Relaxed);
    }
    pub fn touch(&self, pool: &ModelPool) {
        let _ = pool;
        *self.inner.last_used_at.write() = Instant::now();
    }
}

#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct GenerateParams {
    pub model_id: String,
    pub messages: Vec<ChatMessage>,
    pub temperature: f32,
    pub max_tokens: i32,
    pub top_p: f32,
    pub stop_sequences: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct GenerateToken {
    pub delta: String,
    pub is_final: bool,
    pub prompt_tokens: i32,
    pub completion_tokens: i32,
    pub finish_reason: String,
}

/// Naive single-request generation. Prefer continuous batching when enabled.
pub async fn generate_stream(
    pool: Arc<ModelPool>,
    params: GenerateParams,
    tx: mpsc::Sender<Result<GenerateToken, EngineError>>,
) {
    let handle = match pool.ensure_loaded(&params.model_id) {
        Ok(h) => h,
        Err(e) => {
            let _ = tx.send(Err(e)).await;
            return;
        }
    };
    handle.touch(&pool);
    handle.begin_request();
    let _permit = match handle.semaphore().acquire_owned().await {
        Ok(p) => p,
        Err(_) => {
            handle.end_request();
            let _ = tx
                .send(Err(EngineError::ModelUnavailable(
                    "concurrency semaphore closed".into(),
                )))
                .await;
            return;
        }
    };

    let start = Instant::now();
    let prompt = render_chat(&params.messages);
    let prompt_tokens = estimate_tokens(&prompt);

    let result = if handle.real_weights() {
        crate::backend::generate_real(&handle, &params, &prompt, prompt_tokens, &tx).await
    } else {
        generate_echo(&params, prompt_tokens, &tx).await
    };

    let elapsed = start.elapsed().as_millis() as u64;
    if let Ok(completion_tokens) = result {
        handle.record_tokens(completion_tokens as u64, elapsed.max(1));
    }
    handle.end_request();
}

async fn generate_echo(
    params: &GenerateParams,
    prompt_tokens: i32,
    tx: &mpsc::Sender<Result<GenerateToken, EngineError>>,
) -> Result<i32, EngineError> {
    let last_user = params
        .messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.as_str())
        .unwrap_or("Hello");
    let reply = format!(
        "ModelForge echo ({model}): {last_user}",
        model = params.model_id
    );
    let max = params.max_tokens.max(1) as usize;
    let mut produced = String::new();
    let mut completion_tokens = 0i32;

    for (i, ch) in reply.chars().enumerate() {
        if i >= max {
            let _ = tx
                .send(Ok(GenerateToken {
                    delta: String::new(),
                    is_final: true,
                    prompt_tokens,
                    completion_tokens,
                    finish_reason: "length".into(),
                }))
                .await;
            return Ok(completion_tokens);
        }
        let delta = ch.to_string();
        produced.push(ch);
        completion_tokens += 1;
        if hit_stop(&produced, &params.stop_sequences) {
            let _ = tx
                .send(Ok(GenerateToken {
                    delta,
                    is_final: true,
                    prompt_tokens,
                    completion_tokens,
                    finish_reason: "stop".into(),
                }))
                .await;
            return Ok(completion_tokens);
        }
        if tx
            .send(Ok(GenerateToken {
                delta,
                is_final: false,
                prompt_tokens,
                completion_tokens,
                finish_reason: String::new(),
            }))
            .await
            .is_err()
        {
            return Ok(completion_tokens);
        }
        tokio::task::yield_now().await;
    }

    let _ = tx
        .send(Ok(GenerateToken {
            delta: String::new(),
            is_final: true,
            prompt_tokens,
            completion_tokens,
            finish_reason: "stop".into(),
        }))
        .await;
    Ok(completion_tokens)
}

pub fn render_chat(messages: &[ChatMessage]) -> String {
    let mut out = String::new();
    for m in messages {
        out.push_str(&format!("<|{}|>\n{}\n", m.role, m.content));
    }
    out.push_str("<|assistant|>\n");
    out
}

pub fn estimate_tokens(text: &str) -> i32 {
    ((text.len() as f32) / 4.0).ceil() as i32
}

pub fn hit_stop(text: &str, stops: &[String]) -> bool {
    stops.iter().any(|s| !s.is_empty() && text.ends_with(s))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{LimitsConfig, ModelsConfig, ServerConfig};

    fn test_pool(budget_mb: u64) -> ModelPool {
        ModelPool::new(AppConfig {
            server: ServerConfig {
                grpc_port: 9002,
                total_ram_budget_mb: budget_mb,
            },
            models: ModelsConfig {
                weights_dir: "./missing-test-models".into(),
                use_mmap: true,
            },
            limits: LimitsConfig {
                max_concurrent_per_model: 1,
                max_context_length: 4096,
                default_n_threads: 2,
                enable_continuous_batching: true,
                batch_max_sequences: 2,
            },
        })
    }

    #[test]
    fn estimates_tokens() {
        assert!(estimate_tokens("abcd") >= 1);
    }

    #[test]
    fn stop_detection() {
        assert!(hit_stop("helloEND", &["END".into()]));
        assert!(!hit_stop("hello", &["END".into()]));
    }

    #[test]
    fn evicts_least_recently_used_idle_model() {
        let pool = test_pool(100);
        pool.load_model("a", "a.gguf", 2048, 2, "Q4", true)
            .expect("load a");
        pool.load_model("b", "b.gguf", 2048, 2, "Q4", true)
            .expect("load b");
        assert!(pool.ensure_loaded("a").is_err());
        assert!(pool.ensure_loaded("b").is_ok());
    }

    #[test]
    fn never_evicts_active_model() {
        let pool = test_pool(100);
        pool.load_model("a", "a.gguf", 2048, 2, "Q4", true)
            .expect("load a");
        let handle = pool.ensure_loaded("a").expect("handle");
        handle.begin_request();
        let result = pool.load_model("b", "b.gguf", 2048, 2, "Q4", true);
        handle.end_request();
        assert!(matches!(result, Err(EngineError::Oom(_))));
        assert!(pool.ensure_loaded("a").is_ok());
    }
}
