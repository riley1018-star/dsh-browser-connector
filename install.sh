#!/usr/bin/env bash
# =============================================================================
# DSH Browser Connector — installer (macOS, v1)
#
#   ./install.sh                install / upgrade (idempotent)
#   ./install.sh --uninstall    remove everything this script installed
#   ./install.sh --profile DIR  target a specific DSH profile directory
#
# What it does:
#   1. copies the plugin into ~/.dsh/dsh-browser-connector
#   2. generates a per-install RSA keypair for the Chrome extension
#      (stable extension ID; the private key never leaves your machine)
#   3. registers the Native Messaging host manifest for Chrome
#   4. appends an MCP registration block to your DSH profile's cordis.patch.yml
#      (backed up first, wrapped in markers, idempotent)
#
# After install: load chrome-extension/ as an unpacked extension, restart DSH.
# Env overrides (mainly for automated tests): DSH_BROWSER_NODE, DSH_BC_HOME,
# DSH_BC_NMH_DIR, DSH_BC_PROFILE_DIR.
# =============================================================================
set -euo pipefail

APP_NAME="dsh-browser-connector"
NM_HOST_NAME="com.dsh_browser_bridge"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PLUGIN_HOME="${DSH_BC_HOME:-$HOME/.dsh/$APP_NAME}"
NMH_DIR="${DSH_BC_NMH_DIR:-$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts}"
PROFILE_DIR="${DSH_BC_PROFILE_DIR:-}"
ACTION="install"

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) ACTION="uninstall"; shift ;;
    --profile) PROFILE_DIR="${2:?--profile needs a directory}"; shift 2 ;;
    --help|-h) grep '^#' "$0" | head -20; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# --- locate node -------------------------------------------------------------
find_node() {
  if [ -n "${DSH_BROWSER_NODE:-}" ] && [ -x "${DSH_BROWSER_NODE}" ]; then
    echo "$DSH_BROWSER_NODE"; return 0
  fi
  local cand
  for cand in "$HOME"/.dsh/dsh-runtimes/*/dependencies/node/bin/node; do
    if [ -x "$cand" ]; then echo "$cand"; return 0; fi
  done
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  return 1
}

# --- locate DSH profile ------------------------------------------------------
find_profile() {
  if [ -n "$PROFILE_DIR" ]; then echo "$PROFILE_DIR"; return 0; fi
  local profs=()
  local d
  while IFS= read -r d; do profs+=("$d"); done < <(
    find "$HOME/.dsh/profiles" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort
  )
  case "${#profs[@]}" in
    0) return 1 ;;
    1) echo "${profs[0]}"; return 0 ;;
  esac
  if [ -t 0 ]; then
    echo "Multiple DSH profiles found:" >&2
    local i=1
    for d in "${profs[@]}"; do echo "  $i) $d" >&2; i=$((i+1)); done
    printf 'Choose one [1-%d]: ' "${#profs[@]}" >&2
    local choice; read -r choice
    [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#profs[@]}" ] \
      || die "invalid choice"
    echo "${profs[$((choice-1))]}"
  else
    return 1
  fi
}

PATCH_FILE=""
resolve_patch_file() {
  PROFILE_DIR="$(find_profile)" || die "no DSH profile found under ~/.dsh/profiles — pass --profile DIR"
  PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
  [ -f "$PATCH_FILE" ] || die "cordis.patch.yml not found at $PATCH_FILE"
}

BEGIN_MARK="# >>> $APP_NAME (managed by install.sh) >>>"
END_MARK="# <<< $APP_NAME <<<"

strip_patch_block() { # $1 = file
  local f="$1"
  if grep -qF "$BEGIN_MARK" "$f" 2>/dev/null; then
    local tmp; tmp="$(mktemp)"
    awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
      index($0,b)==1 {skip=1; next}
      index($0,e)==1 {skip=0; next}
      !skip {print}
    ' "$f" > "$tmp" && cat "$tmp" > "$f"
    rm -f "$tmp"
  fi
}

# =============================================================================
if [ "$ACTION" = "uninstall" ]; then
  say "Uninstalling $APP_NAME"
  resolve_patch_file
  cp "$PATCH_FILE" "$PATCH_FILE.bak-$(date +%s)"
  strip_patch_block "$PATCH_FILE"
  say "removed MCP registration from $PATCH_FILE (backup kept)"
  if [ -f "$NMH_DIR/$NM_HOST_NAME.json" ]; then
    rm -f "$NMH_DIR/$NM_HOST_NAME.json"
    say "removed Native Messaging host manifest"
  fi
  case "$PLUGIN_HOME" in
    "$HOME/.dsh/$APP_NAME") rm -rf "$PLUGIN_HOME"; say "removed $PLUGIN_HOME" ;;
    *) warn "PLUGIN_HOME is not the default location; leaving $PLUGIN_HOME in place" ;;
  esac
  cat <<EOF

Remaining manual steps:
  1. chrome://extensions → remove "DSH Browser Connector"
  2. Restart DeepSeek Harness.
EOF
  exit 0
fi

# =============================================================================
say "Installing $APP_NAME"

[ "$(uname)" = "Darwin" ] || warn "v1 is tested on macOS only; paths for the Native Messaging host may differ on your OS"

NODE="$(find_node)" || die "no node found: install DeepSeek Harness (bundles node), or put node on PATH, or set DSH_BROWSER_NODE"
say "node: $NODE"
"$NODE" --version >/dev/null 2>&1 || die "node at $NODE is not executable"

resolve_patch_file
say "DSH profile: $PROFILE_DIR"

# 1. copy files ----------------------------------------------------------------
say "copying files to $PLUGIN_HOME"
mkdir -p "$PLUGIN_HOME"
rsync -a --delete \
  --exclude '.git' --exclude '.github' --exclude 'tools' \
  --exclude 'keys' --exclude 'state' --exclude 'state-*' \
  --exclude 'install.sh' \
  "$REPO_DIR/" "$PLUGIN_HOME/"
mkdir -p "$PLUGIN_HOME/state"
chmod +x "$PLUGIN_HOME/bridge/host.sh"
echo "$NODE" > "$PLUGIN_HOME/bridge/.node-path"

# 2. extension keypair + ID + manifest injection -------------------------------
say "generating extension identity (per-install, private key stays local)"
EXT_ID="$(PLUGIN_HOME="$PLUGIN_HOME" "$NODE" - <<'JS'
const crypto = require("crypto"), fs = require("fs"), path = require("path");
const home = process.env.PLUGIN_HOME;
const keysDir = path.join(home, "keys");
fs.mkdirSync(keysDir, { recursive: true });
const privFile = path.join(keysDir, "ext-private.pem");
const derFile = path.join(keysDir, "ext-public.der");
if (!fs.existsSync(privFile) || !fs.existsSync(derFile)) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  fs.writeFileSync(privFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(derFile, publicKey.export({ type: "spki", format: "der" }));
}
const der = fs.readFileSync(derFile);
const manifestPath = path.join(home, "chrome-extension", "manifest.json");
const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
m.key = der.toString("base64");
fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
const hex = crypto.createHash("sha256").update(der).digest("hex").slice(0, 32);
const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
fs.writeFileSync(path.join(keysDir, "ext-id.txt"), id + "\n");
console.log(id);
JS
)"
[ -n "$EXT_ID" ] || die "failed to compute extension ID"
say "extension ID: $EXT_ID"

# 3. Native Messaging host manifest ---------------------------------------------
say "registering Native Messaging host"
mkdir -p "$NMH_DIR"
cat > "$NMH_DIR/$NM_HOST_NAME.json" <<EOF
{
  "name": "$NM_HOST_NAME",
  "description": "DSH Browser Connector bridge (Native Messaging host)",
  "path": "$PLUGIN_HOME/bridge/host.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF

# 4. cordis.patch.yml registration (idempotent, backed up) ----------------------
say "registering MCP server in $PATCH_FILE"
cp "$PATCH_FILE" "$PATCH_FILE.bak-$(date +%s)"
strip_patch_block "$PATCH_FILE"
cat >> "$PATCH_FILE" <<EOF
$BEGIN_MARK
- insert:
    - id: browser-connector-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: browser
        transport: stdio
        command: $NODE
        args:
          - $PLUGIN_HOME/mcp-server/server.js
        failOnStartupError: false
$END_MARK
EOF

cat <<EOF

$(printf '\033[1;32mInstallation complete.\033[0m')  Two manual steps remain:

  1. Load the extension:
     chrome://extensions → enable Developer mode → "Load unpacked" →
       $PLUGIN_HOME/chrome-extension
     (if upgrading from a previous install: click Reload on the extension card)

  2. Restart DeepSeek Harness.

Verify in a new DSH session: ask the agent to call mcp__browser__browser_status.
Extension ID: $EXT_ID
EOF
