# Inference Engine

CPU-only GGUF serving via **llama.cpp** (`llama-cpp-2`) and tonic gRPC.

## Requirements

- Rust 1.78+ (`rustup`)
- Clang / LLVM (for `bindgen` used by llama-cpp-2)
- CMake (pulled transitively for llama.cpp build)

## Run

```bash
cd apps/inference-engine
cargo run --release
```

Optional env overrides: see root `.env.example`.

## Smoke test with grpcurl

```bash
# Load (echo stub if GGUF missing)
grpcurl -plaintext -d "{\"model_id\":\"demo\",\"weights_path\":\"demo.gguf\",\"context_length\":2048,\"n_threads\":4,\"use_mmap\":true}" \
  localhost:50051 inference.InferenceEngine/LoadModel

grpcurl -plaintext -d "{\"model_id\":\"demo\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}],\"max_tokens\":32,\"stream\":true}" \
  localhost:50051 inference.InferenceEngine/Generate
```

Place real `.gguf` files under `MODEL_WEIGHTS_DIR` (default `./data/models`).
