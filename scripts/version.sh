#!/usr/bin/env bash
# Remuda's version is written in six places across three manifests and two
# lockfiles. This script is the one thing that reads and writes all six, so a
# bump can't land in some of them and miss the rest.
#
# Usage:
#   ./scripts/version.sh                 print the current version
#   ./scripts/version.sh --check         verify all six agree
#   ./scripts/version.sh --check v0.3.0  ...and that they equal 0.3.0
#   ./scripts/version.sh --set 0.3.0     rewrite all six
#
# Cutting a release:
#   ./scripts/version.sh --set 0.3.0
#   git commit -am 'chore(release): 0.3.0'   # then merge to main
#   git tag v0.3.0 && git push origin v0.3.0
#
# Reads and writes use the same anchors, so whatever `--check` accepts is
# exactly what `--set` produces. Deliberately depends on nothing but awk:
# it runs in CI before any toolchain is installed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TAURI_CONF="src-tauri/tauri.conf.json"
CARGO_TOML="src-tauri/Cargo.toml"
CARGO_LOCK="src-tauri/Cargo.lock"
NPM_PKG="app/package.json"
NPM_LOCK="app/package-lock.json"

# The top-level "version" of each JSON file sits at one indent; the copy npm
# keeps in package-lock's `packages[""]` stanza sits at three. Dependency
# stanzas share that three-indent shape, but `packages[""]` is the first
# entry npm writes, so first-match-wins picks it out.
PAT_JSON_TOP='^  "version":'
PAT_JSON_PKG='^      "version":'
PAT_TOML='^version = '
# In Cargo.lock the version lives on the line *after* the package name, and
# ~500 dependency stanzas share the `version = ` shape — the name is the
# only thing that identifies ours.
PAT_LOCK_NAME='^name = "remuda"$'

# Print the value of the first line of $1 matching regex $2 — that is, the
# last double-quoted string on it. Works for both `"version": "1.2.3",` and
# `version = "1.2.3"`.
first_quoted() {
  awk -v pat="$2" '
    $0 ~ pat { n = split($0, p, "\""); print p[n - 1]; exit }
  ' "$ROOT/$1"
}

# Same, but for the line following the first match — Cargo.lock's shape.
quoted_after() {
  awk -v pat="$2" '
    $0 ~ pat { getline; n = split($0, p, "\""); print p[n - 1]; exit }
  ' "$ROOT/$1"
}

# Rewrite the quoted value on the first line of $1 matching regex $2 to $3,
# leaving indentation, spacing and any trailing comma exactly as they were.
# `after=1` targets the line following the match instead of the match itself.
rewrite() {
  local file="$ROOT/$1" pat="$2" ver="$3" after="${4:-0}" tmp
  tmp="$(mktemp)"
  awk -v pat="$pat" -v ver="$ver" -v after="$after" '
    function swap(line,   n, p, i, out) {
      n = split(line, p, "\"")
      p[n - 1] = ver
      out = p[1]
      for (i = 2; i <= n; i++) out = out "\"" p[i]
      return out
    }
    !done && $0 ~ pat {
      if (after) { print; getline }
      print swap($0)
      done = 1
      next
    }
    { print }
    END { if (!done) exit 1 }
  ' "$file" > "$tmp" || { rm -f "$tmp"; echo "error: no line matching /${pat}/ in $1" >&2; return 1; }
  mv "$tmp" "$file"
}

# label<TAB>version for all six, in the order the release notes read best.
read_all() {
  printf '%s\t%s\n' \
    "$TAURI_CONF"          "$(first_quoted "$TAURI_CONF" "$PAT_JSON_TOP")" \
    "$CARGO_TOML"          "$(first_quoted "$CARGO_TOML" "$PAT_TOML")" \
    "$CARGO_LOCK"          "$(quoted_after "$CARGO_LOCK" "$PAT_LOCK_NAME")" \
    "$NPM_PKG"             "$(first_quoted "$NPM_PKG" "$PAT_JSON_TOP")" \
    "$NPM_LOCK"            "$(first_quoted "$NPM_LOCK" "$PAT_JSON_TOP")" \
    "$NPM_LOCK (packages)" "$(first_quoted "$NPM_LOCK" "$PAT_JSON_PKG")"
}

write_all() {
  local ver="$1"
  rewrite "$TAURI_CONF" "$PAT_JSON_TOP" "$ver"
  rewrite "$CARGO_TOML" "$PAT_TOML"     "$ver"
  rewrite "$CARGO_LOCK" "$PAT_LOCK_NAME" "$ver" 1
  rewrite "$NPM_PKG"    "$PAT_JSON_TOP" "$ver"
  rewrite "$NPM_LOCK"   "$PAT_JSON_TOP" "$ver"
  rewrite "$NPM_LOCK"   "$PAT_JSON_PKG" "$ver"
}

# Verify all six agree, and — if $1 is given — that they equal it. Prints the
# table either way, and annotates the offending files when run under Actions.
check() {
  local expected="${1:-}" fail=0 file found

  if [ -n "$expected" ]; then
    expected="${expected#v}"
    echo "expected                          ${expected}"
  fi
  while IFS=$'\t' read -r file found; do
    printf '%-33s %s\n' "$file" "${found:-<not found>}"
  done < <(read_all)

  # With nothing to compare against, the first file's version is the one the
  # other five have to match.
  [ -n "$expected" ] || expected="$(first_quoted "$TAURI_CONF" "$PAT_JSON_TOP")"

  while IFS=$'\t' read -r file found; do
    if [ "$found" != "$expected" ]; then
      if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
        echo "::error file=${file%% *}::version is ${found:-<not found>}, expected ${expected}"
      else
        echo "error: ${file} is ${found:-<not found>}, expected ${expected}" >&2
      fi
      fail=1
    fi
  done < <(read_all)

  if [ "$fail" -ne 0 ]; then
    echo "Run ./scripts/version.sh --set ${expected} and commit the result." >&2
    return 1
  fi
  echo "version=${expected}" >> "${GITHUB_OUTPUT:-/dev/null}"
}

case "${1:-}" in
  --set)
    version="${2:-}"
    version="${version#v}"
    if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
      echo "usage: $0 --set X.Y.Z" >&2
      exit 2
    fi
    write_all "$version"
    # Re-read rather than trust the writes: a substitution that silently
    # missed is the exact failure this script exists to prevent.
    check "$version" >/dev/null
    echo "Set every version to ${version}:"
    check "$version"
    ;;
  --check)
    check "${2:-}"
    ;;
  "")
    first_quoted "$TAURI_CONF" "$PAT_JSON_TOP"
    ;;
  -h|--help)
    sed -n '2,17p' "$0" | sed 's|^# \{0,1\}||'
    ;;
  *)
    echo "usage: $0 [--check [VERSION] | --set VERSION]" >&2
    exit 2
    ;;
esac
