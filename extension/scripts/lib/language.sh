#!/usr/bin/env bash
#
# language.sh — resolve the selected extension language by directory convention.
#
# Sourced by other scripts; not executable on its own.
#
# A directory is an extension implementation iff it contains a `language.env`
# manifest. That marker (rather than the mere presence of a Dockerfile) is what
# distinguishes go/ from proxy/, which also ships a Dockerfile but is not a
# language. Adding a language means creating <dir>/language.env plus a
# conforming Dockerfile — no script in this repo needs to change.
#
# See docs/extension-contract.md §8.

# list_languages <project_dir> — print available language directory names.
list_languages() {
    local root="${1:?list_languages requires the project dir}"
    (cd "$root" && ls -d */language.env 2>/dev/null | cut -d/ -f1)
}

# load_language <project_dir> [language] — validate and export the selection.
#
# Exports:
#   LANGUAGE               selected directory name
#   LANGUAGE_NAME          human-readable name from the manifest
#   EXTENSION_DIR          absolute path to the language directory
#   EXTENSION_DOCKERFILE   path relative to the project root, for compose
#   LANGUAGE_TEST_CMD      unit-test command
#   LANGUAGE_SETUP_CMD     optional pre-test install step
load_language() {
    local root="${1:?load_language requires the project dir}"
    local lang="${2:-${LANGUAGE:-go}}"
    local manifest="$root/$lang/language.env"

    if [[ ! -f "$manifest" ]]; then
        local available
        available="$(list_languages "$root" | tr '\n' ' ')"
        echo "[language] ERROR: unknown LANGUAGE '$lang' — no $lang/language.env found." >&2
        echo "[language]        Available: ${available:-<none>}" >&2
        echo "[language]        To add one, see docs/extension-contract.md §8." >&2
        return 1
    fi

    # Clear first so a manifest that omits a field does not inherit the value
    # from a previously loaded language.
    LANGUAGE_NAME=""
    LANGUAGE_DOCKERFILE=""
    LANGUAGE_SETUP_CMD=""
    LANGUAGE_BUILD_CMD=""
    LANGUAGE_TEST_CMD=""
    LANGUAGE_RUN_CMD=""

    # shellcheck disable=SC1090
    source "$manifest"

    LANGUAGE="$lang"
    LANGUAGE_NAME="${LANGUAGE_NAME:-$lang}"
    LANGUAGE_DOCKERFILE="${LANGUAGE_DOCKERFILE:-Dockerfile}"
    EXTENSION_DIR="$root/$lang"
    EXTENSION_DOCKERFILE="$lang/$LANGUAGE_DOCKERFILE"

    if [[ ! -f "$root/$EXTENSION_DOCKERFILE" ]]; then
        echo "[language] ERROR: $lang/language.env declares LANGUAGE_DOCKERFILE=$LANGUAGE_DOCKERFILE, but $root/$EXTENSION_DOCKERFILE does not exist." >&2
        return 1
    fi

    export LANGUAGE LANGUAGE_NAME EXTENSION_DIR EXTENSION_DOCKERFILE
    export LANGUAGE_SETUP_CMD LANGUAGE_BUILD_CMD LANGUAGE_TEST_CMD LANGUAGE_RUN_CMD
}
