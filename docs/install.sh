#!/usr/bin/env bash
# Axion install script — curl -fsSL https://axion.amplifiedsmp.org/install.sh | sh
set -e

PACKAGE="@axion-labs-ai/quark-cli"

info()  { printf '\033[36m==>\033[0m %s\n' "$1"; }
fail()  { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js (v18+) is required but wasn't found. Install it from https://nodejs.org, then re-run this script."
fi

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  fail "Node.js v18+ is required (found v$(node -v 2>/dev/null)). Upgrade at https://nodejs.org."
fi

if ! command -v npm >/dev/null 2>&1; then
  fail "npm wasn't found alongside Node.js. Reinstall Node.js from https://nodejs.org."
fi

info "Installing Axion ($PACKAGE) globally via npm..."
if npm install -g "$PACKAGE" 2>/tmp/axion-install-err.log; then
  info "Installed! Run 'axion' to get started."
else
  if grep -qi "EACCES\|permission denied" /tmp/axion-install-err.log 2>/dev/null; then
    info "Permission error — retrying with sudo..."
    sudo npm install -g "$PACKAGE"
    info "Installed! Run 'axion' to get started."
  else
    cat /tmp/axion-install-err.log >&2
    fail "npm install failed. See the output above."
  fi
  rm -f /tmp/axion-install-err.log
fi
