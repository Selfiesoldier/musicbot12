#!/bin/bash
set -e

if [ -f "cookies.b64" ]; then
  echo "🍪 Restoring authenticated YouTube cookies..."
  base64 -d cookies.b64 > cookies.txt 2>/dev/null || true
fi

echo "=================================================="
echo "🚀 Highrise Music Bot v2 (Docker / Render)"
echo "=================================================="

# 1. Start local Botguard PO Token server on 127.0.0.1:4416
if [ -f "/app/pot-provider/build/main.js" ]; then
  echo "🛡️ [POT Provider] Starting local Botguard PO Token server on port 4416..."
  (
    while true; do
      PORT=4416 NODE_OPTIONS="--max-old-space-size=64" node /app/pot-provider/build/main.js --port 4416 || true
      echo "⚠️ [POT Provider] Process stopped, restarting in 3s..."
      sleep 3
    done
  ) &
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

mkdir -p logs cache tts_cache

# 2. Start Highrise Python Bot in self-healing watchdog loop
(
  echo "⏳ Waiting 4s for Web Server to initialize before starting Bot..."
  sleep 4
  while true; do
    echo "🤖 [Bot Watchdog] Starting Highrise Python Bot..."
    python3 -u main.py 2>&1 | tee -a logs/bot.log || true
    echo "⚠️ [Bot Watchdog] Bot exited with code $?. Reconnecting in 5s..."
    sleep 5
  done
) &

# 3. Start Node.js Web Server in self-healing watchdog loop (keeps container alive 24/7)
echo "📻 [Server Watchdog] Starting Node.js Music Engine Server on port ${PORT}..."
while true; do
  node server.js || true
  echo "⚠️ [Server Watchdog] Node.js server exited. Auto-rebooting in 2s..."
  sleep 2
done
