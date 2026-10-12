#!/bin/sh
set -eu
cd /app/server
node dist/scripts/migrate.js
pnpm --config.verify-deps-before-run=false exec vitest run src/modules/annotation src/modules/position-converter
