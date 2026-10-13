#!/bin/bash
# DSH Browser Connector — Native Messaging Host launcher.
# Launched by Chrome (registered via com.dsh_browser_bridge.json in the
# browser's NativeMessagingHosts directory).
#
# Node resolution order:
#   1. bridge/.node-path   (written by install.sh — the node found at install time)
#   2. DSH bundled runtime node (~/.dsh/dsh-runtimes/*/dependencies/node)
#   3. node on PATH
DIR="$(cd "$(dirname "$0")" && pwd)"

NODE=""
if [ -f "$DIR/.node-path" ]; then
  CAND="$(cat "$DIR/.node-path" 2>/dev/null)"
  [ -n "$CAND" ] && [ -x "$CAND" ] && NODE="$CAND"
fi
if [ -z "$NODE" ]; then
  for CAND in "$HOME"/.dsh/dsh-runtimes/*/dependencies/node/bin/node; do
    if [ -x "$CAND" ]; then NODE="$CAND"; break; fi
  done
fi
if [ -z "$NODE" ]; then
  NODE="$(command -v node)"
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  exit 1
fi
exec "$NODE" "$DIR/host.js"
