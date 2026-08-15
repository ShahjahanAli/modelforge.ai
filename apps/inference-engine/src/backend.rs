//! Real llama.cpp generation via llama-cpp-2 (CPU-only).
//! Decode runs on a blocking thread pool.

use crate::error::EngineError;
use crate::model_pool::{estimate_tokens, hit_stop, GenerateParams, GenerateToken, ResidentModelHandle};
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaChatMessage, LlamaModel, Special};
use llama_cpp_2::sampling::LlamaSampler;
use std::num::NonZeroU32;
use std::path::Path;
use std::sync::Arc;
use std::sync::OnceLock;
use tokio::sync::mpsc;
use tracing::info;

static BACKEND: OnceLock<Result<LlamaBackend, String>> = OnceLock::new();

fn backend() -> Result<&'static LlamaBackend, EngineError> {
    let slot = BACKEND.get_or_init(|| LlamaBackend::init().map_err(|e| e.to_string()));
    match slot {
        Ok(b) => Ok(b),
        Err(e) => Err(EngineError::ModelUnavailable(format!("llama backend: {e}"))),
    }
}

pub fn load_model(path: &Path, use_mmap: bool) -> Result<Arc<LlamaModel>, EngineError> {
    let params = LlamaModelParams::default()
        .with_n_gpu_layers(0)
        .with_use_mmap(use_mmap);
    let model = LlamaModel::load_from_file(backend()?, path, &params)
        .map_err(|e| EngineError::ModelUnavailable(format!("load failed: {e}")))?;
    Ok(Arc::new(model))
}

pub async fn generate_real(
    handle: &ResidentModelHandle,
    params: &GenerateParams,
    prompt: &str,
    prompt_tokens_est: i32,
    tx: &mpsc::Sender<Result<GenerateToken, EngineError>>,
) -> Result<i32, EngineError> {
    let model = handle
        .model()
        .ok_or_else(|| EngineError::ModelUnavailable("model weights not resident".into()))?;
    let n_threads = handle.n_threads();
    let ctx_len = handle.context_length();
    let temperature = params.temperature;
    let top_p = params.top_p;
    let max_tokens = params.max_tokens.max(1) as usize;
    let stops = params.stop_sequences.clone();
    let messages: Vec<(String, String)> = params
        .messages
        .iter()
        .map(|m| (m.role.clone(), m.content.clone()))
        .collect();
    let prompt_owned = prompt.to_string();
    let (btx, mut brx) = mpsc::channel::<Result<GenerateToken, EngineError>>(64);

    tokio::task::spawn_blocking(move || {
        if let Err(e) = run_llama(
            &model,
            n_threads,
            ctx_len,
            temperature,
            top_p,
            max_tokens,
            &stops,
            &messages,
            &prompt_owned,
            prompt_tokens_est,
            &btx,
        ) {
            let _ = btx.blocking_send(Err(e));
        }
    });

    let mut completion_tokens = 0i32;
    while let Some(item) = brx.recv().await {
        match item {
            Ok(tok) => {
                completion_tokens = tok.completion_tokens;
                let is_final = tok.is_final;
                if tx.send(Ok(tok)).await.is_err() {
                    break;
                }
                if is_final {
                    break;
                }
            }
            Err(e) => {
                let _ = tx.send(Err(e)).await;
                return Err(EngineError::Internal("generate failed".into()));
            }
        }
    }
    Ok(completion_tokens)
}

fn run_llama(
    model: &LlamaModel,
    n_threads: i32,
    ctx_len: u32,
    temperature: f32,
    top_p: f32,
    max_tokens: usize,
    stops: &[String],
    messages: &[(String, String)],
    fallback_prompt: &str,
    prompt_tokens_est: i32,
    tx: &mpsc::Sender<Result<GenerateToken, EngineError>>,
) -> Result<(), EngineError> {
    let backend = backend()?;

    let n_ctx = NonZeroU32::new(ctx_len.max(512)).unwrap_or(NonZeroU32::new(4096).unwrap());
    let ctx_params = LlamaContextParams::default()
        .with_n_ctx(Some(n_ctx))
        .with_n_threads(n_threads)
        .with_n_threads_batch(n_threads);

    let mut ctx = model
        .new_context(backend, ctx_params)
        .map_err(|e| EngineError::ModelUnavailable(format!("context failed: {e}")))?;

    let chat_msgs: Vec<LlamaChatMessage> = messages
        .iter()
        .filter_map(|(role, content)| LlamaChatMessage::new(role.clone(), content.clone()).ok())
        .collect();

    let prompt = model
        .chat_template(None)
        .ok()
        .and_then(|template| {
            model
                .apply_chat_template(&template, chat_msgs.as_slice(), true)
                .ok()
        })
        .unwrap_or_else(|| fallback_prompt.to_string());

    let tokens = model
        .str_to_token(&prompt, AddBos::Always)
        .map_err(|e| EngineError::InvalidArgument(format!("tokenize failed: {e}")))?;

    let prompt_tokens = tokens.len() as i32;
    info!(prompt_tokens, "Prompt tokenized");

    let mut batch = LlamaBatch::new(tokens.len().max(512), 1);
    let last_index = tokens.len().saturating_sub(1) as i32;
    for (i, token) in (0_i32..).zip(tokens.into_iter()) {
        batch
            .add(token, i, &[0], i == last_index)
            .map_err(|e| EngineError::Internal(format!("batch add: {e}")))?;
    }

    ctx.decode(&mut batch)
        .map_err(|e| EngineError::Internal(format!("decode prompt: {e}")))?;

    let mut sampler = LlamaSampler::chain_simple([
        LlamaSampler::temp(temperature.max(0.0)),
        LlamaSampler::top_p(top_p.clamp(0.01, 1.0), 1),
        LlamaSampler::dist(1234),
    ]);

    let mut n_cur = batch.n_tokens();
    let mut produced = String::new();
    let mut completion_tokens = 0i32;

    for _ in 0..max_tokens {
        let token = sampler.sample(&ctx, batch.n_tokens() - 1);
        sampler.accept(token);

        if model.is_eog_token(token) {
            let _ = tx.blocking_send(Ok(GenerateToken {
                delta: String::new(),
                is_final: true,
                prompt_tokens: prompt_tokens.max(prompt_tokens_est),
                completion_tokens,
                finish_reason: "stop".into(),
            }));
            return Ok(());
        }

        let piece = model.token_to_str(token, Special::Tokenize).unwrap_or_default();
        produced.push_str(&piece);
        completion_tokens += 1;
        let stop = hit_stop(&produced, stops);

        if tx
            .blocking_send(Ok(GenerateToken {
                delta: piece,
                is_final: stop,
                prompt_tokens: prompt_tokens.max(prompt_tokens_est),
                completion_tokens,
                finish_reason: if stop { "stop".into() } else { String::new() },
            }))
            .is_err()
        {
            return Ok(());
        }
        if stop {
            return Ok(());
        }

        batch.clear();
        batch
            .add(token, n_cur, &[0], true)
            .map_err(|e| EngineError::Internal(format!("batch add token: {e}")))?;
        n_cur += 1;
        ctx.decode(&mut batch)
            .map_err(|e| EngineError::Internal(format!("decode token: {e}")))?;
    }

    let _ = tx.blocking_send(Ok(GenerateToken {
        delta: String::new(),
        is_final: true,
        prompt_tokens: prompt_tokens.max(prompt_tokens_est),
        completion_tokens,
        finish_reason: "length".into(),
    }));
    Ok(())
}

#[allow(dead_code)]
pub fn estimate_prompt_tokens(text: &str) -> i32 {
    estimate_tokens(text)
}
