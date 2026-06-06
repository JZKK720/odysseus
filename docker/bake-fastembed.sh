#!/bin/sh
# Bake the FastEmbed models the Odysseus app needs at first request, so
# the running container doesn't reach out to HuggingFace (which it can't
# from many self-hosted networks).
#
# Models baked (set FASTEMBED_MODELS env to override, space-separated):
#   sentence-transformers/all-MiniLM-L6-v2
#     — the single FastEmbed model the app actually uses at runtime.
#     `src/embeddings.py` instantiates TextEmbedding with this name
#     (controlled by FASTEMBED_MODEL env var), and fastembed's
#     list_supported_models() shows this is the library default —
#     so src/rag_vector.py / src/memory_vector.py (which call
#     fastembed.TextEmbedding() with no model_name arg) also pick this
#     same model. Under the hood, fastembed fetches the model from the
#     qdrant/all-MiniLM-L6-v2-onnx HF repo (fastembed renames the
#     sentence-transformers/* entry to that qdrant/* path internally),
#     but you can NOT pass qdrant/* to TextEmbedding() — that name
#     isn't in list_supported_models() and throws ValueError.
#
# Reads FASTEMBED_MODELS from the calling environment (Dockerfile passes
# the right default if unset). The cache dir is FASTEMBED_CACHE_PATH.
# Symlinks are disabled to match the Windows self-heal in
# src/embeddings.py (network-share symlinks can be unreadable).
set -eu

MODELS_DEFAULT="sentence-transformers/all-MiniLM-L6-v2"
MODELS="${FASTEMBED_MODELS:-$MODELS_DEFAULT}"
CACHE_DIR="${FASTEMBED_CACHE_PATH:-/app/.cache/fastembed}"
mkdir -p "$CACHE_DIR"

for m in $MODELS; do
    echo "  - pre-baking $m into $CACHE_DIR"
    MODEL="$m" python - <<'PY'
import os
from fastembed import TextEmbedding
m = os.environ["MODEL"]
te = TextEmbedding(m)
list(te.embed(["warmup"]))
print(f"    warmed up: {m}")
PY
done

echo "FastEmbed models pre-baked to $CACHE_DIR"
