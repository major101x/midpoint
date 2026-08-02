#!/usr/bin/env bash
#
# check-versions.sh — fail fast when dependency pins drift apart.
#
# The Go image pins tee-node via go.mod; non-Go images build tee-node from
# source at TEE_NODE_REF. If those diverge, the node and proxy disagree on
# signature formats and the symptom is an opaque "signature check fail" at
# runtime, long after the build. Same for tee-proxy between tools/go.mod and
# proxy/Dockerfile.
#
# Run standalone, or let pre-build.sh invoke it as a pre-flight.
#
# Usage: ./scripts/check-versions.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[check-versions]${NC} $*"; }
warn() { echo -e "${YELLOW}[check-versions] WARN:${NC} $*" >&2; }
die()  { echo -e "${RED}[check-versions] ERROR:${NC} $*" >&2; exit 1; }

# shellcheck source=lib/versions.sh
source "$SCRIPT_DIR/lib/versions.sh"
load_versions "$PROJECT_DIR" || die "could not load versions"

# Locate the two go.mod files (extension module may be at ./ or ./go/).
if [[ -f "$PROJECT_DIR/go/go.mod" ]]; then
    EXT_GOMOD="$PROJECT_DIR/go/go.mod"
else
    EXT_GOMOD="$PROJECT_DIR/go.mod"
fi
TOOLS_GOMOD="$PROJECT_DIR/tools/go.mod"

pin() { grep -E "^[[:space:]]*${2//\//\\/}[[:space:]]+v" "$1" 2>/dev/null | head -1 | awk '{print $2}'; }

FAILED=0

# --- 1. tee-node must match between the extension module and tools ---
EXT_NODE="$(pin "$EXT_GOMOD" github.com/flare-foundation/tee-node)"
TOOLS_NODE="$(pin "$TOOLS_GOMOD" github.com/flare-foundation/tee-node)"
if [[ -z "$EXT_NODE" ]]; then
    die "no tee-node pin in $EXT_GOMOD"
elif [[ -z "$TOOLS_NODE" ]]; then
    warn "no tee-node pin in $TOOLS_GOMOD — skipping cross-check"
elif [[ "$EXT_NODE" != "$TOOLS_NODE" ]]; then
    echo -e "${RED}  tee-node mismatch:${NC}" >&2
    echo "    $EXT_GOMOD:   $EXT_NODE" >&2
    echo "    $TOOLS_GOMOD: $TOOLS_NODE" >&2
    FAILED=1
else
    log "tee-node       $EXT_NODE (extension == tools)"
fi

# --- 2. go-flare-common must match too (drift here breaks ABI encoding) ---
EXT_COMMON="$(pin "$EXT_GOMOD" github.com/flare-foundation/go-flare-common)"
TOOLS_COMMON="$(pin "$TOOLS_GOMOD" github.com/flare-foundation/go-flare-common)"
if [[ -n "$EXT_COMMON" && -n "$TOOLS_COMMON" && "$EXT_COMMON" != "$TOOLS_COMMON" ]]; then
    echo -e "${RED}  go-flare-common mismatch:${NC}" >&2
    echo "    $EXT_GOMOD:   $EXT_COMMON" >&2
    echo "    $TOOLS_GOMOD: $TOOLS_COMMON" >&2
    FAILED=1
elif [[ -n "$EXT_COMMON" ]]; then
    log "go-flare-common $EXT_COMMON (extension == tools)"
fi

# --- 3. tee-proxy: tools/go.mod must match proxy/Dockerfile's build ARG ---
TOOLS_PROXY="$(pin "$TOOLS_GOMOD" github.com/flare-foundation/tee-proxy)"
if [[ -z "$TEE_PROXY_VERSION" ]]; then
    warn "no ARG TEE_PROXY_VERSION in proxy/Dockerfile — skipping cross-check"
elif [[ -z "$TOOLS_PROXY" ]]; then
    warn "no tee-proxy pin in $TOOLS_GOMOD — skipping cross-check"
elif [[ "$TOOLS_PROXY" != "$TEE_PROXY_VERSION" ]]; then
    echo -e "${RED}  tee-proxy mismatch:${NC}" >&2
    echo "    $TOOLS_GOMOD:        $TOOLS_PROXY" >&2
    echo "    proxy/Dockerfile:    $TEE_PROXY_VERSION" >&2
    FAILED=1
else
    log "tee-proxy      $TOOLS_PROXY (tools == proxy/Dockerfile)"
fi

# --- 4. Report the ref that language images will clone ---
log "TEE_NODE_REF   $TEE_NODE_REF $([[ "$TEE_NODE_REF" != "$TEE_NODE_VERSION" ]] && echo '(commit SHA from pseudo-version)' || echo '(tag)')"

if [[ "$FAILED" -ne 0 ]]; then
    echo "" >&2
    die "version pins are inconsistent. Align them before building, or the Go and non-Go images will run different tee-node builds."
fi

log "all version pins consistent"
