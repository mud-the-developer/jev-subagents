#!/usr/bin/env bash
set -euo pipefail

command -v bun >/dev/null || { printf '%s\n' 'Bun1.4.3 is required. Do not run with sudo.' >&2; exit 1; }
bun --no-env-file --no-install -e 'if (Bun.version !== "1.4.3") { console.error("Bun1.4.3 is required."); process.exit(1); }'
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
exec bun --no-env-file --no-install --config=./src/worker-bunfig.toml --tsconfig-override=./tsconfig.json ./scripts/setup.ts "$@"
