#!/usr/bin/env bash
# restart-gui.sh: Kill the running Myrlin GUI, wait, relaunch.
# Works on Windows (MINGW/Git Bash) and Unix.

set -e

PORT="${PORT:-3456}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "[restart] Finding processes on port $PORT..."

# Find PIDs listening on the port (Windows netstat + Unix lsof)
if command -v netstat &>/dev/null && [[ "$OSTYPE" == "msys" || "$OSTYPE" == "mingw"* || "$OSTYPE" == "cygwin"* ]]; then
  # Windows: netstat output format, extract PIDs listening on our port
  PIDS=$(netstat -ano 2>/dev/null | grep ":${PORT} " | grep "LISTENING" | awk '{print $5}' | sort -u)
elif command -v lsof &>/dev/null; then
  # Unix/Mac
  PIDS=$(lsof -ti :"$PORT" 2>/dev/null || true)
else
  echo "[restart] Cannot detect processes, neither netstat nor lsof available"
  exit 1
fi

if [ -z "$PIDS" ]; then
  echo "[restart] No process found on port $PORT"
else
  for PID in $PIDS; do
    if [ "$PID" = "0" ]; then continue; fi
    echo "[restart] Killing PID $PID..."
    # Try graceful first, then force
    kill "$PID" 2>/dev/null || taskkill //PID "$PID" //F 2>/dev/null || true
  done

  echo "[restart] Waiting for port to free up..."
  sleep 2

  # Verify port is free
  REMAINING=$(netstat -ano 2>/dev/null | grep ":${PORT} " | grep "LISTENING" | awk '{print $5}' | sort -u || true)
  if [ -n "$REMAINING" ]; then
    echo "[restart] Port still in use by PID(s): $REMAINING, force killing..."
    for PID in $REMAINING; do
      if [ "$PID" = "0" ]; then continue; fi
      taskkill //PID "$PID" //F 2>/dev/null || kill -9 "$PID" 2>/dev/null || true
    done
    sleep 1
  fi
fi

echo "[restart] Launching Myrlin GUI..."
cd "$PROJECT_DIR"
node src/supervisor.js &
CHILD_PID=$!

# Wait a moment for the server to start
sleep 2

# Check if it's actually running
if kill -0 "$CHILD_PID" 2>/dev/null; then
  echo "[restart] Myrlin GUI running (PID $CHILD_PID) on http://localhost:$PORT"
  echo "[restart] Refresh your browser to pick up changes."
else
  echo "[restart] ERROR: Process exited immediately. Check logs above."
  exit 1
fi
