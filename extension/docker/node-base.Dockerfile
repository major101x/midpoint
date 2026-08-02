# Shared tee-node builder — produces the `server` binary that non-Go language
# images run alongside their extension process.
#
# Built once as local/tee-node-base:${TEE_NODE_REF} and consumed by every
# two-process language image, so a new language's Dockerfile is ~30 lines rather
# than ~110. The Go image does not use this: it links tee-node as a library and
# ships a single binary (see go/Dockerfile and docs/extension-contract.md §1).
#
# Build directly:
#   docker build -f docker/node-base.Dockerfile --build-arg TEE_NODE_REF=<ref> -t local/tee-node-base:<ref> docker/
#
# scripts/start-services.sh builds this automatically when the selected language
# needs it, tagging by TEE_NODE_REF so a pin bump invalidates the cache naturally.

# Same digest-pinned golang image as go/Dockerfile, so the server binary bytes
# are identical no matter which language image embeds it.
FROM golang:1.25.1-trixie@sha256:ff83f3762390c2cccb53618ccc18af23e556aff9b1db4428637e9f63287c8171 AS builder

ARG SOURCE_DATE_EPOCH
ENV SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH

# Git-resolvable tee-node ref, derived from the Go module pin by
# scripts/lib/versions.sh. Required — there is no default, because a stale
# default is exactly the drift this image exists to prevent.
ARG TEE_NODE_REF

WORKDIR /build

# apt normally resolves to whatever package versions the mirror serves at build time.
# Redirect apt at snapshot.debian.org keyed on SOURCE_DATE_EPOCH so every build
# installs the exact package set that existed at that instant.
# NOTE: adapted from https://github.com/reproducible-containers/repro-sources-list.sh/blob/master/alternative/Dockerfile.debian-13
RUN \
  --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt,sharing=locked \
  if [ "${SOURCE_DATE_EPOCH:-0}" -gt 0 ] 2>/dev/null; then \
    snapshot="$(/bin/bash -euc "printf \"%(%Y%m%dT%H%M%SZ)T\n\" \"${SOURCE_DATE_EPOCH}\"")" && \
    sed -i -e '/Types: deb/ a\Snapshot: true' /etc/apt/sources.list.d/debian.sources && \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' >/etc/apt/apt.conf.d/keep-cache && \
    apt-get install --update --snapshot "${snapshot}" -o Acquire::Check-Valid-Until=false -o Acquire::https::Verify-Peer=false -y ca-certificates && \
    rm -rf /var/log/* /var/cache/ldconfig/aux-cache; \
  else \
    apt-get update && apt-get install -y ca-certificates && \
    rm -rf /var/log/* /var/cache/ldconfig/aux-cache; \
  fi

# Fetch tee-node at exactly the pinned ref.
#
# Two approaches are deliberately NOT used here:
#
#   git clone --branch ${TEE_NODE_REF}
#     The Go module pin is frequently a pseudo-version
#     (v0.0.21-0.20260619120252-31fc839ae6d2) whose last segment is a commit
#     SHA. --branch resolves tags and branches only, so it fails on a SHA.
#
#   git fetch --depth 1 origin ${TEE_NODE_REF}
#     Fetching a raw commit requires the server to allow it
#     (uploadpack.allowAnySHA1InWant) AND a full 40-char SHA. The pin gives an
#     abbreviated 12-char SHA, and GitHub rejects it: "couldn't find remote ref".
#
# A blobless partial clone fetches all refs cheaply (deferring file contents),
# after which an abbreviated SHA resolves locally. Works for tags and SHAs alike.
RUN test -n "${TEE_NODE_REF}" || (echo "ERROR: TEE_NODE_REF build arg is required" >&2 && exit 1)
RUN git clone --filter=blob:none https://github.com/flare-foundation/tee-node.git tee-node && \
    cd tee-node && \
    git checkout "${TEE_NODE_REF}" && \
    echo "tee-node at $(git rev-parse HEAD)"

WORKDIR /build/tee-node

RUN go mod download
RUN go mod verify

# -trimpath strips build-host paths; -buildid= clears go's non-deterministic build id;
# -s -w drop symbol and dwarf tables; -buildvcs=false omits embedded vcs metadata;
# CGO_ENABLED=0 produces a static binary, avoiding link-time libc variance.
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOFLAGS="-buildvcs=false" \
    go build -trimpath -ldflags="-buildid= -s -w" -o /app/server ./cmd/extension

# Carry the Confidential Space root cert alongside the binary — language images
# copy both from this stage.
RUN cp /build/tee-node/assets/google_confidential_space_root.crt /app/google_confidential_space_root.crt

RUN if [ "${SOURCE_DATE_EPOCH:-0}" -gt 0 ] 2>/dev/null; then find /app -exec touch -h -d @${SOURCE_DATE_EPOCH} {} +; fi

# Minimal final stage: language images only ever COPY --from this image.
FROM scratch
COPY --from=builder /app/server /app/server
COPY --from=builder /app/google_confidential_space_root.crt /app/assets/google_confidential_space_root.crt
