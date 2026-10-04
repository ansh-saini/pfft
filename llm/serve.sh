#!/bin/sh
# The tagger's model server: llama.cpp's llama-server on this Mac's GPU (Metal),
# listening on localhost only. Tailscale Funnel (funnel.sh) is the one way
# in from outside. launchd runs this script (install.sh); run it by hand to test.
#
# Needs: brew install llama.cpp
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

DIR="${FINANCE_LLM_HOME:-$HOME/.finance-llm}"
export LLAMA_CACHE="$DIR/models"
MODEL="${LLM_HF_REPO:-unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M}"
PORT="${LLM_PORT:-8089}"

# Once downloaded, load the file directly so a restart without internet works.
QUANT="${MODEL##*:}"
REPO_DIR="$LLAMA_CACHE/models--$(echo "${MODEL%:*}" | sed 's#/#--#g')"
FILE="$(find "$REPO_DIR" -name "*${QUANT}.gguf" 2>/dev/null | head -n 1 || true)"
if [ -n "$FILE" ]; then
  SOURCE="-m $FILE"
else
  SOURCE="-hf $MODEL"
fi

# caffeinate -i keeps the Mac from idle-sleeping while the server runs.
# One slot: a transaction is one call, and the slot keeps the cached prompt.
# --reasoning off: the model answers at once, so the JSON schema holds from the
# first token; otherwise text before the JSON is taken as "thinking" and the
# reply can come back empty.
# shellcheck disable=SC2086
exec caffeinate -i llama-server $SOURCE \
  --host 127.0.0.1 --port "$PORT" \
  --api-key-file "$DIR/api-key" \
  --ctx-size 8192 --parallel 1 --cache-reuse 256 \
  --n-gpu-layers 99 --jinja --reasoning off
