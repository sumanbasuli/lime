#!/usr/bin/env bash

set -euo pipefail
export LC_ALL=C

if [[ $# -eq 2 && "$1" == --file ]]; then
  version="$(cat -- "$2")"
  if ! cmp -s -- "$2" <(printf '%s' "${version}") && ! cmp -s -- "$2" <(printf '%s\n' "${version}"); then
    echo "VERSION must contain exactly one line, with at most one final newline." >&2
    exit 1
  fi
elif [[ $# -eq 1 ]]; then
  version="$1"
else
  echo "usage: $0 <version> | --file <version-file>" >&2
  exit 1
fi
if [[ ${#version} -gt 120 || ! "${version}" =~ ^[0-9]+[.][0-9]+[.][0-9]+(-[A-Za-z0-9]+([-.][A-Za-z0-9]+)*)?$ ]]; then
  echo "Version must be a numeric major.minor.patch with an optional prerelease suffix." >&2
  exit 1
fi
