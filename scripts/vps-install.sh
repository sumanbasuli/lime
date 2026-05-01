#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "scripts/vps-install.sh is deprecated. Use scripts/debian-install.sh instead." >&2
exec "${SCRIPT_DIR}/debian-install.sh" "$@"
