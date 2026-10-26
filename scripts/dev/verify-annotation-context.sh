#!/bin/sh
set -eu
cd /app/server
node dist/scripts/migrate.js
CONTEXT_UPGRADE_TEST_DATABASE_URL="$DATABASE_URL" pnpm --config.verify-deps-before-run=false exec vitest run src/scripts/context-upgrade.test.ts
pnpm --config.verify-deps-before-run=false exec vitest run src/modules/annotation src/modules/position-converter src/modules/scanner/scanner.repository.test.ts src/db/migration-journal.test.ts
pnpm --config.verify-deps-before-run=false exec tsc --noEmit -p tsconfig.build.json
pnpm --config.verify-deps-before-run=false run lint:check
