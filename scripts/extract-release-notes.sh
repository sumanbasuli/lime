#!/usr/bin/env bash

set -euo pipefail
export LC_ALL=C

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 <version-or-tag> [changelog-path]" >&2
  exit 1
fi

VERSION="${1#v}"
CHANGELOG_PATH="${2:-}"

if [[ -z "${CHANGELOG_PATH}" ]]; then
  if [[ -f "CHANGELOG.md" ]]; then
    CHANGELOG_PATH="CHANGELOG.md"
  elif [[ -f "changelog.md" ]]; then
    CHANGELOG_PATH="changelog.md"
  else
    CHANGELOG_PATH="CHANGELOG.md"
  fi
fi

if [[ ! -f "${CHANGELOG_PATH}" ]]; then
  echo "Changelog not found: ${CHANGELOG_PATH}" >&2
  exit 1
fi

awk -v version="${VERSION}" '
function heading_version(line, value) {
  value = line
  sub(/^##[[:space:]]+/, "", value)
  sub(/^[[]/, "", value)
  sub(/[]].*$/, "", value)
  sub(/[[:space:]]+-.*$/, "", value)
  sub(/[[:space:]]*$/, "", value)
  if (substr(value, 1, 1) == "v") {
    value = substr(value, 2)
  }
  return value
}

/^##[[:space:]]+/ {
  if (found) {
    exit
  }

  if (heading_version($0) == version) {
    found = 1
  }

  next
}

found {
  lines[++line_count] = $0
  if ($0 ~ /[^[:space:]]/) {
    emitted = 1
  }
}

END {
  if (!found || !emitted) {
    exit 42
  }

  first = 1
  while (first <= line_count && lines[first] ~ /^[[:space:]]*$/) {
    first++
  }

  last = line_count
  while (last >= first && lines[last] ~ /^[[:space:]]*$/) {
    last--
  }

  for (line_index = first; line_index <= last; line_index++) {
    print lines[line_index]
  }
}
' "${CHANGELOG_PATH}" || {
  status=$?
  if [[ ${status} -eq 42 ]]; then
    echo "No release notes found for v${VERSION} in ${CHANGELOG_PATH}" >&2
  fi
  exit "${status}"
}
