#!/usr/bin/env bash
#
# test-unit.sh — run a language implementation's unit tests.
#
# Dispatches via the LANGUAGE_TEST_CMD in each <lang>/language.env, so there is
# no hardcoded per-language logic here and adding a language needs no change to
# this script.
#
# These are the implementation's own tests. For cross-language wire-format
# conformance, use ./scripts/test-conformance.sh. For the on-chain end-to-end
# test, use ./scripts/test.sh.
#
# Usage:
#   ./scripts/test-unit.sh              # the LANGUAGE from .env
#   ./scripts/test-unit.sh python       # a specific language
#   ./scripts/test-unit.sh --all        # every discovered language
#   ./scripts/test-unit.sh --skip-setup # reuse installed deps
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[0;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[test-unit]${NC} $*"; }
warn() { echo -e "${YELLOW}[test-unit]${NC} $*"; }
die()  { echo -e "${RED}[test-unit] ERROR:${NC} $*" >&2; exit 1; }

# shellcheck source=lib/language.sh
source "$SCRIPT_DIR/lib/language.sh"

SKIP_SETUP=false
RUN_ALL=false
TARGET=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --all)        RUN_ALL=true; shift ;;
        --skip-setup) SKIP_SETUP=true; shift ;;
        -h|--help)    sed -n '2,17p' "$0"; exit 0 ;;
        -*)           die "unknown flag: $1" ;;
        *)            TARGET="$1"; shift ;;
    esac
done

if [[ -f "$PROJECT_DIR/.env" ]]; then
    set -a; source "$PROJECT_DIR/.env"; set +a
fi

run_language() {
    local lang="$1"
    load_language "$PROJECT_DIR" "$lang" || return 1

    echo ""
    echo -e "${CYAN}=== $LANGUAGE_NAME ($lang) ===${NC}"

    if [[ -z "$LANGUAGE_TEST_CMD" ]]; then
        warn "$lang/language.env defines no LANGUAGE_TEST_CMD — skipping"
        return 0
    fi

    if [[ "$SKIP_SETUP" == "false" && -n "$LANGUAGE_SETUP_CMD" ]]; then
        log "setup: $LANGUAGE_SETUP_CMD"
        ( cd "$EXTENSION_DIR" && eval "$LANGUAGE_SETUP_CMD" ) || return 1
    fi
    if [[ -n "$LANGUAGE_BUILD_CMD" ]]; then
        log "build: $LANGUAGE_BUILD_CMD"
        ( cd "$EXTENSION_DIR" && eval "$LANGUAGE_BUILD_CMD" >/dev/null ) || return 1
    fi

    log "test: $LANGUAGE_TEST_CMD"
    ( cd "$EXTENSION_DIR" && eval "$LANGUAGE_TEST_CMD" ) || return 1
}

FAILED_LANGS=()
if [[ "$RUN_ALL" == "true" ]]; then
    while read -r lang; do
        [[ -n "$lang" ]] || continue
        run_language "$lang" || FAILED_LANGS+=("$lang")
    done < <(list_languages "$PROJECT_DIR")
else
    lang="${TARGET:-${LANGUAGE:-go}}"
    run_language "$lang" || FAILED_LANGS+=("$lang")
fi

echo ""
if [[ ${#FAILED_LANGS[@]} -gt 0 ]]; then
    die "unit tests FAILED for: ${FAILED_LANGS[*]}"
fi
log "unit tests passed"
