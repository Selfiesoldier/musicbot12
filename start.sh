#!/bin/bash
set -e

echo "=================================================="
echo "🚀 Highrise Music Bot v2 (Docker / Render)"
echo "=================================================="

# 1. Start local Botguard PO Token server on 127.0.0.1:4416 in background
if [ -f "/app/pot-provider/build/main.js" ]; then
  echo "🛡️ [POT Provider] Starting local Botguard PO Token server on port 4416..."
  PORT=4416 NODE_OPTIONS="--max-old-space-size=64" node /app/pot-provider/build/main.js --port 4416 &
  POT_PID=$!
  echo "🛡️ [POT Provider] PID: $POT_PID running in background on port 4416"
else
  echo "⚠️ [POT Provider] Build not found at /app/pot-provider/build/main.js — skipping"
fi

export PORT="${PORT:-10000}"
export NODE_OPTIONS="--max-old-space-size=160 --expose-gc"
export MUSIC_API_URL="http://127.0.0.1:${PORT}"
export SERVER_URL="http://127.0.0.1:${PORT}"

if [ -n "$RENDER_EXTERNAL_URL" ]; then
  export PUBLIC_URL="$RENDER_EXTERNAL_URL"
elif [ -z "$PUBLIC_URL" ]; then
  export PUBLIC_URL="http://127.0.0.1:${PORT}"
fi

echo "📻 Starting Node.js Music Engine Server on port ${PORT}..."
node server.js &
NODE_PID=$!

echo "⏳ Waiting 4s for Web Server to bind port ${PORT}..."
sleep 4

echo "🤖 Starting Highrise Python Bot (main.py)..."
python3 -u main.py &
BOT_PID=$!

echo "✅ All services active! (POT: $POT_PID | Web: $NODE_PID | Bot: $BOT_PID)"

# Supervisor loop: if either critical process dies, exit container so Render can reboot
wait -n $NODE_PID $BOT_PID
