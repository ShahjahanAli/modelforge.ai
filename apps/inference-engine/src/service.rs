use crate::batching::BatchCoordinator;
use crate::error::EngineError;
use crate::model_pool::{ChatMessage, GenerateParams, ModelPool};
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::Stream;
use tonic::{Request, Response, Status};

pub mod pb {
    tonic::include_proto!("inference");
}

use pb::inference_engine_server::InferenceEngine;
use pb::*;

pub struct InferenceService {
    pub pool: Arc<ModelPool>,
    pub batching: Arc<BatchCoordinator>,
}

fn status_from(err: EngineError) -> Status {
    let msg = format!("{}: {}", err.code(), err);
    match &err {
        EngineError::ModelNotFound(_) => Status::not_found(msg),
        EngineError::InvalidArgument(_) => Status::invalid_argument(msg),
        EngineError::DeadlineExceeded => Status::deadline_exceeded(msg),
        EngineError::Oom(_) | EngineError::ModelUnavailable(_) => Status::unavailable(msg),
        EngineError::Internal(_) => Status::internal(msg),
    }
}

#[tonic::async_trait]
impl InferenceEngine for InferenceService {
    async fn load_model(
        &self,
        request: Request<LoadModelRequest>,
    ) -> Result<Response<LoadModelResponse>, Status> {
        let req = request.into_inner();
        match self.pool.load_model(
            &req.model_id,
            &req.weights_path,
            req.context_length as u32,
            req.n_threads,
            &req.quantization,
            req.use_mmap,
        ) {
            Ok((ms, ram)) => Ok(Response::new(LoadModelResponse {
                success: true,
                error: String::new(),
                load_time_ms: ms as i64,
                ram_used_mb: ram as i64,
            })),
            Err(e) => Ok(Response::new(LoadModelResponse {
                success: false,
                error: format!("{}: {}", e.code(), e),
                load_time_ms: 0,
                ram_used_mb: 0,
            })),
        }
    }

    async fn unload_model(
        &self,
        request: Request<UnloadModelRequest>,
    ) -> Result<Response<UnloadModelResponse>, Status> {
        let req = request.into_inner();
        match self.pool.unload_model(&req.model_id) {
            Ok(()) => Ok(Response::new(UnloadModelResponse {
                success: true,
                error: String::new(),
            })),
            Err(e) => Ok(Response::new(UnloadModelResponse {
                success: false,
                error: format!("{}: {}", e.code(), e),
            })),
        }
    }

    async fn list_loaded_models(
        &self,
        _request: Request<Empty>,
    ) -> Result<Response<ModelList>, Status> {
        let models = self
            .pool
            .list()
            .into_iter()
            .map(|m| LoadedModel {
                model_id: m.model_id,
                ram_used_mb: m.ram_used_mb as i64,
                loaded_at_unix: m.loaded_at_unix,
                active_requests: m.active_requests,
                tokens_per_sec_avg: m.tokens_per_sec_avg,
            })
            .collect();
        Ok(Response::new(ModelList { models }))
    }

    async fn health_check(
        &self,
        _request: Request<Empty>,
    ) -> Result<Response<HealthStatus>, Status> {
        let (healthy, total, used, count, cores) = self.pool.health();
        Ok(Response::new(HealthStatus {
            healthy,
            total_ram_mb: total as i64,
            used_ram_mb: used as i64,
            loaded_model_count: count,
            physical_core_count: cores,
        }))
    }

    type GenerateStream =
        Pin<Box<dyn Stream<Item = Result<GenerateChunk, Status>> + Send + 'static>>;

    async fn generate(
        &self,
        request: Request<GenerateRequest>,
    ) -> Result<Response<Self::GenerateStream>, Status> {
        let req = request.into_inner();
        if req.model_id.is_empty() {
            return Err(Status::invalid_argument("model_id required"));
        }
        if req.messages.is_empty() {
            return Err(Status::invalid_argument("messages required"));
        }

        let params = GenerateParams {
            model_id: req.model_id,
            messages: req
                .messages
                .into_iter()
                .map(|m| ChatMessage {
                    role: m.role,
                    content: m.content,
                })
                .collect(),
            temperature: if req.temperature == 0.0 {
                0.7
            } else {
                req.temperature
            },
            max_tokens: if req.max_tokens <= 0 {
                512
            } else {
                req.max_tokens
            },
            top_p: if req.top_p == 0.0 { 1.0 } else { req.top_p },
            stop_sequences: req.stop_sequences,
        };

        let mut token_rx = self.batching.submit(params).await;
        let (tx, rx) = mpsc::channel::<Result<GenerateChunk, Status>>(64);

        tokio::spawn(async move {
            while let Some(item) = token_rx.recv().await {
                let mapped = match item {
                    Ok(tok) => {
                        let chunk = GenerateChunk {
                            delta: tok.delta,
                            is_final: tok.is_final,
                            prompt_tokens: tok.prompt_tokens,
                            completion_tokens: tok.completion_tokens,
                            finish_reason: tok.finish_reason,
                        };
                        let done = chunk.is_final;
                        let send = tx.send(Ok(chunk)).await;
                        if send.is_err() || done {
                            break;
                        }
                        continue;
                    }
                    Err(e) => tx.send(Err(status_from(e))).await,
                };
                if mapped.is_err() {
                    break;
                }
            }
        });

        Ok(Response::new(Box::pin(ReceiverStream::new(rx))))
    }
}
