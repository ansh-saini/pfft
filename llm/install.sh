#!/bin/sh
# Installs the model server as a launchd agent: it starts at login and restarts
# if it stops. Creates the API key on first run and prints it; set the same
# value as LLM_API_KEY in Vercel.
#
# Usage: llm/install.sh
set -eu

DIR="${FINANCE_LLM_HOME:-$HOME/.finance-llm}"
HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.finance.llm"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$DIR/models" "$HOME/Library/LaunchAgents"

if [ ! -s "$DIR/api-key" ]; then
  (umask 077 && openssl rand -hex 32 > "$DIR/api-key")
  echo "Created $DIR/api-key"
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>$HERE/serve.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>FINANCE_LLM_HOME</key><string>$DIR</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/llm.log</string>
  <key>StandardErrorPath</key><string>$DIR/llm.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Started $LABEL. Log: $DIR/llm.log"
echo "Waiting for the model to load..."
i=0
until curl -sf "http://127.0.0.1:${LLM_PORT:-8089}/health" >/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 1800 ]; then echo "Not up after 30 min; see $DIR/llm.log"; exit 1; fi
  sleep 1
done
echo "Model server is up on http://127.0.0.1:${LLM_PORT:-8089}"
echo "LLM_API_KEY=$(cat "$DIR/api-key")"
