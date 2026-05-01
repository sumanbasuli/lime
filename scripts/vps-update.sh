#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "scripts/vps-update.sh is deprecated. Use scripts/debian-update.sh instead." >&2
exec "${SCRIPT_DIR}/debian-update.sh" "$@"
