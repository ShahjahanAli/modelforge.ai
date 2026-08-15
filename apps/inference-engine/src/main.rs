mod backend;
mod batching;
mod config;
mod error;
mod model_pool;
mod service;

use batching::BatchCoordinator;
use config::AppConfig;
use model_pool::ModelPool;
use service::pb::inference_engine_server::InferenceEngineServer;
use service::InferenceService;
use std::net::SocketAddr;
use std::sync::Arc;
use tonic::transport::Server;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse()?))
        .init();

    let cfg = AppConfig::load()?;
    std::fs::create_dir_all(&cfg.models.weights_dir).ok();

    let pool = Arc::new(ModelPool::new(cfg.clone()));
    let batching = Arc::new(BatchCoordinator::new(pool.clone()));
    let svc = InferenceService { pool, batching };

    let addr: SocketAddr = format!("0.0.0.0:{}", cfg.server.grpc_port).parse()?;
    info!(
        %addr,
        ram_budget_mb = cfg.server.total_ram_budget_mb,
        weights_dir = %cfg.models.weights_dir,
        continuous_batching = cfg.limits.enable_continuous_batching,
        "ModelForge inference engine starting"
    );

    Server::builder()
        .add_service(InferenceEngineServer::new(svc))
        .serve(addr)
        .await?;

    Ok(())
}
