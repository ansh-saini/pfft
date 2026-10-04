#!/bin/sh
# Puts the model server on a stable public HTTPS URL with Tailscale Funnel:
# https://<this mac>.<tailnet>.ts.net. Only Funnel reaches the server;
# llama-server itself listens on localhost. --bg keeps the Funnel in Tailscale's
# own config, so it comes back with Tailscale after a restart.
#
# Once: install Tailscale (brew install --cask tailscale), open it and sign in.
# The first run prints a link to allow Funnel for this tailnet if it is off.
# Usage: llm/funnel.sh
set -eu

TS="$(command -v tailscale || true)"
[ -n "$TS" ] || TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
[ -x "$TS" ] || { echo "Tailscale not found. brew install --cask tailscale, then sign in."; exit 1; }

"$TS" funnel --bg "http://127.0.0.1:${LLM_PORT:-8089}"
"$TS" funnel status
echo "Set LLM_BASE_URL in Vercel to the https:// URL above (no trailing slash)."
