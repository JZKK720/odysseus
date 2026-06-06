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

# Pre-bake the default FastEmbed model so the container doesn't need
# network egress (HuggingFace) at first chat/embedding request. Without
# this step, the slim image fails the first VectorRAG init on hosts
# where HF is blocked, leaving RAG in DEGRADED state forever. The model
# lands in /app/.cache/fastembed, which matches FASTEMBED_CACHE_PATH in
# .env.example and is owned by root here; the entrypoint chowns /app
# recursively to PUID:PGID at first boot, so the model ends up readable
# by the app user too.
#
# Set FASTEMBED_MODEL_BAKE=false in the build to skip (saves ~90 MB
# and ~1-2 min on the workflow when the host definitely has HF access
# at runtime and you want a smaller image).
ARG FASTEMBED_MODEL=sentence-transformers/all-MiniLM-L6-v2
ARG FASTEMBED_MODEL_BAKE=true
RUN if [ "$FASTEMBED_MODEL_BAKE" = "true" ]; then \
      FASTEMBED_CACHE_PATH=/app/.cache/fastembed \
      HF_HUB_DISABLE_SYMLINKS=1 \
      python -c "from fastembed import TextEmbedding; t = TextEmbedding('${FASTEMBED_MODEL}'); list(t.embed(['warmup']))" \
      && echo "FastEmbed model '${FASTEMBED_MODEL}' pre-baked to /app/.cache/fastembed"; \
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
