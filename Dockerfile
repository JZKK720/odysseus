FROM python:3.12-slim

# System deps. tmux is required by Cookbook for background downloads/serves.
# openssh-client is required for Cookbook remote server tests, setup, probes,
# downloads, and serves from Docker installs.
# git/cmake are required when Cookbook builds llama.cpp on first llama.cpp
# launch inside Docker.
# nodejs/npm provide npx for the optional built-in Browser MCP server.
# gosu lets the entrypoint drop privileges cleanly so signals still reach
# uvicorn directly (no extra shell layer like `su`/`sudo` would add).
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    curl \
    git \
    nodejs \
    npm \
    tmux \
    openssh-client \
    gosu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first (layer cache). Optional extras (PyMuPDF AGPL, etc.)
# are opt-in so the default image stays MIT-core; see requirements-optional.txt.
ARG INSTALL_OPTIONAL=false
COPY requirements.txt requirements-optional.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && if [ "$INSTALL_OPTIONAL" = "true" ]; then pip install --no-cache-dir -r requirements-optional.txt; fi

# Pre-bake the FastEmbed models so the container doesn't need
# network egress (HuggingFace) at first chat/embedding request. Without
# this step, the slim image fails the first VectorRAG init on hosts
# where HF is blocked, leaving RAG in DEGRADED state forever. The
# models land in /app/.cache/fastembed, which matches FASTEMBED_CACHE_PATH
# in .env.example and is owned by root here; the entrypoint chowns
# /app recursively to PUID:PGID at first boot, so the files end up
# readable by the app user too.
#
# Two models are baked because the app uses them in two different code
# paths with different model names:
#   - sentence-transformers/all-MiniLM-L6-v2  — used by src/embeddings.py
#     (the FastEmbedClient wrapper, controlled by FASTEMBED_MODEL env var)
#   - qdrant/all-MiniLM-L6-v2-onnx           — used directly by
#     src/rag_vector.py and src/memory_vector.py via
#     fastembed.TextEmbedding() with no model_name arg, so they fall
#     back to the fastembed library default. Baking the library default
#     too means both code paths find a cached model on first boot.
#
# Set FASTEMBED_MODEL_BAKE=false in the build to skip (saves ~200 MB
# and 1-3 min in CI when the host definitely has HF access at runtime
# and a smaller image is preferred).
ARG FASTEMBED_MODELS="sentence-transformers/all-MiniLM-L6-v2 qdrant/all-MiniLM-L6-v2-onnx"
ARG FASTEMBED_MODEL_BAKE=true
RUN if [ "$FASTEMBED_MODEL_BAKE" = "true" ]; then \
      FASTEMBED_CACHE_PATH=/app/.cache/fastembed \
      HF_HUB_DISABLE_SYMLINKS=1 \
      bash -c 'set -e; \
        for m in ${FASTEMBED_MODELS}; do \
          echo "  - pre-baking $${m}"; \
          python -c "from fastembed import TextEmbedding; t = TextEmbedding(\"$${m}\"); list(t.embed([\"warmup\"]))" || exit 1; \
        done; \
        echo "FastEmbed models pre-baked to /app/.cache/fastembed"'; \
    fi

# Copy app code
COPY . .

# Create data directory (mount a volume here for persistence)
RUN mkdir -p data logs services/cache/search

# Entrypoint that drops to PUID/PGID (default 1000:1000) and repairs
# ownership on the bind-mounted /app/data and /app/logs. Without this,
# the container runs as root and writes root-owned files into host
# bind mounts — any later non-root run (or a host user trying to
# update them) silently fails on EPERM, breaking skill extraction,
# prefs persistence, mail attachments, etc.
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 7000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7000"]
