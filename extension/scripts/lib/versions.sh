#!/usr/bin/env bash
#
# versions.sh — single source of truth for dependency versions.
#
# Sourced by other scripts; not executable on its own. Derives the tee-node
# version from the Go module pin so that non-Go language images (which build
# tee-node from source) can never drift from the Go image.
#
# Exports:
#   TEE_NODE_VERSION  full module pin, e.g. v0.0.21-0.20260619120252-31fc839ae6d2
#   TEE_NODE_REF      git-resolvable ref: the commit SHA for a pseudo-version,
#                     or the tag itself for a plain tag
#   TEE_PROXY_VERSION tee-proxy tag used by proxy/Dockerfile
#
# Why TEE_NODE_REF exists: Go pseudo-versions embed an abbreviated commit SHA
# (v0.0.21-0.<timestamp>-<sha12>) and are NOT git tags. `git clone --branch`
# cannot resolve a SHA, and `git fetch <sha>` needs a full 40-char SHA plus
# server-side allowAnySHA1InWant. A blobless partial clone followed by checkout
# handles tags and abbreviated SHAs alike — see docker/node-base.Dockerfile.

# Resolve the extension module's go.mod. Works both before and after the Go
# implementation moves into go/ (Phase 1), so this file needs no update.
_versions_gomod() {
    local root="$1"
    if [[ -f "$root/go/go.mod" ]]; then
        echo "$root/go/go.mod"
    elif [[ -f "$root/go.mod" ]]; then
        echo "$root/go.mod"
    else
        return 1
    fi
}

# Extract a module's version from a go.mod require line.
_versions_pin() {
    local gomod="$1" module="$2"
    grep -E "^[[:space:]]*${module//\//\\/}[[:space:]]+v" "$gomod" 2>/dev/null \
        | head -1 | awk '{print $2}'
}

# Convert a module version to a git-resolvable ref.
#
# Pseudo-versions carry a 14-digit UTC timestamp followed by a 12-hex commit
# prefix. The separator before the timestamp varies by form:
#   v0.0.0-20260619120252-31fc839ae6d2          (no prior tag)
#   v0.0.21-0.20260619120252-31fc839ae6d2       (after a release tag)
#   v0.0.21-rc.1.0.20260619120252-31fc839ae6d2  (after a prerelease tag)
# so anchor on the timestamp+sha suffix rather than on the separator.
_versions_ref() {
    local version="$1"
    if [[ "$version" =~ [0-9]{14}-([0-9a-f]{12})$ ]]; then
        echo "${BASH_REMATCH[1]}"
    else
        echo "$version"
    fi
}

# load_versions <project_dir> — sets and exports the version variables.
load_versions() {
    local root="${1:?load_versions requires the project dir}"
    local gomod
    gomod="$(_versions_gomod "$root")" || {
        echo "[versions] ERROR: no go.mod found under $root (looked in go/ and .)" >&2
        return 1
    }

    TEE_NODE_VERSION="$(_versions_pin "$gomod" "github.com/flare-foundation/tee-node")"
    if [[ -z "$TEE_NODE_VERSION" ]]; then
        echo "[versions] ERROR: no tee-node require line in $gomod" >&2
        return 1
    fi
    TEE_NODE_REF="$(_versions_ref "$TEE_NODE_VERSION")"

    TEE_PROXY_VERSION="$(grep -E '^ARG TEE_PROXY_VERSION=' "$root/proxy/Dockerfile" 2>/dev/null | head -1 | cut -d= -f2)"

    export TEE_NODE_VERSION TEE_NODE_REF TEE_PROXY_VERSION
}
