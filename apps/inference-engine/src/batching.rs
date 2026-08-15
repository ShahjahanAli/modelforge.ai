//! Per-model continuous batching scheduler.
//!
//! On CPU the concurrency ceiling is low; this still helps by:
//! - Fair FIFO admission into a small parallel window
//! - Shared worker loop per loaded model
//! - Clean cancellation when the client disconnects
//!
//! When `enable_continuous_batching` is false, callers use `generate_stream` directly.

use crate::error::EngineError;
use crate::model_pool::{generate_stream, GenerateParams, GenerateToken, ModelPool};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, Semaphore};
use tracing::info;
use uuid::Uuid;

struct BatchRequest {
    id: String,
    params: GenerateParams,
    tx: mpsc::Sender<Result<GenerateToken, EngineError>>,
}

struct ModelScheduler {
    tx: mpsc::Sender<BatchRequest>,
}

pub struct BatchCoordinator {
    pool: Arc<ModelPool>,
    schedulers: Mutex<HashMap<String, ModelScheduler>>,
    max_sequences: usize,
}

impl BatchCoordinator {
    pub fn new(pool: Arc<ModelPool>) -> Self {
        let max_sequences = pool.config().limits.batch_max_sequences.max(1);
        Self {
            pool,
            schedulers: Mutex::new(HashMap::new()),
            max_sequences,
        }
    }

    pub async fn submit(
        &self,
        params: GenerateParams,
    ) -> mpsc::Receiver<Result<GenerateToken, EngineError>> {
        let (tx, rx) = mpsc::channel(64);
        if !self.pool.config().limits.enable_continuous_batching {
            let pool = self.pool.clone();
            tokio::spawn(async move {
                generate_stream(pool, params, tx).await;
            });
            return rx;
        }

        let model_id = params.model_id.clone();
        let req = BatchRequest {
            id: Uuid::new_v4().to_string(),
            params,
            tx,
        };

        let sender = {
            let mut map = self.schedulers.lock().await;
            if let Some(s) = map.get(&model_id) {
                s.tx.clone()
            } else {
                let (stx, srx) = mpsc::channel::<BatchRequest>(128);
                map.insert(
                    model_id.clone(),
                    ModelScheduler { tx: stx.clone() },
                );
                let pool = self.pool.clone();
                let max_seq = self.max_sequences;
                tokio::spawn(async move {
                    run_scheduler(pool, model_id, srx, max_seq).await;
                });
                stx
            }
        };

        if sender.send(req).await.is_err() {
            // Scheduler died; fall back
            let (ftx, frx) = mpsc::channel(64);
            // Can't recover original tx easily; drop
            let _ = ftx;
            return frx;
        }
        rx
    }
}

async fn run_scheduler(
    pool: Arc<ModelPool>,
    model_id: String,
    mut rx: mpsc::Receiver<BatchRequest>,
    max_sequences: usize,
) {
    info!(%model_id, max_sequences, "Continuous batching scheduler started");
    let gate = Arc::new(Semaphore::new(max_sequences));

    while let Some(req) = rx.recv().await {
        let permit = match gate.clone().acquire_owned().await {
            Ok(p) => p,
            Err(_) => break,
        };
        let pool = pool.clone();
        tokio::spawn(async move {
            generate_stream(pool, req.params, req.tx).await;
            drop(permit);
        });
    }
    info!(%model_id, "Continuous batching scheduler stopped");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AppConfig;

    #[tokio::test]
    async fn scheduler_emits_tokens_for_echo_model() {
        let cfg = AppConfig::load().expect("config");
        let pool = Arc::new(ModelPool::new(cfg));
        pool.load_model("echo", "missing.gguf", 2048, 2, "Q4_K_M", true)
            .expect("load");
        let coord = BatchCoordinator::new(pool);
        let mut rx = coord
            .submit(GenerateParams {
                model_id: "echo".into(),
                messages: vec![crate::model_pool::ChatMessage {
                    role: "user".into(),
                    content: "hi".into(),
                }],
                temperature: 0.7,
                max_tokens: 32,
                top_p: 1.0,
                stop_sequences: vec![],
            })
            .await;

        let mut got_final = false;
        while let Some(tok) = rx.recv().await {
            let tok = tok.expect("token");
            if tok.is_final {
                got_final = true;
                break;
            }
        }
        assert!(got_final);
    }
}
