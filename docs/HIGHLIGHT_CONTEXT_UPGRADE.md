# Upgrade the deployed highlight-context branch

This release merges upstream commit `99aa7dce705986eac29a8f73aa65331de5f50680`.
It keeps the existing context API and generation policy. Context is optional:
missing or rebuilding context falls back to the original highlight.

## Required rehearsal

Run the image verification workflow. It covers new installs, upstream upgrades,
the deployed custom migration, repeat runs, schema drift and rollback on dependent objects.

Restore a fresh production dump into an isolated database whose name starts with
`bookorbit_context_test_`. Run `dist/scripts/context-upgrade-rehearsal.js` with its
`DATABASE_URL`. It checks every existing public table and column, excluding the
three disposable context tables, before and after the actual migration command.
Run persistence tests in a separate empty test database, never in the restored copy.

## Production upgrade

The current deployment uses Compose in `/opt/dockers/us-bwh/bookorbit`.
Its old revision is `1a9b9f8404885622dc03fe772aa6ccd5ef34b64f`.
Its recovery image is:
`ghcr.io/edenz223/bookorbit@sha256:55e7b58373f8a76ba512fa1f83a62f953f2bcdecb292564a9c3cbf753e11e247`.

1. Publish and pull the tested image. Record its immutable digest.
2. Stop app, transmission and filebrowser. Keep PostgreSQL running.
3. Make a fresh custom-format database dump. Back up Compose, .env, credentials,
   application data and download/filebrowser state with restricted permissions.
   Verify the dump by restoring it to a separate database, then drop that database.
4. Use the new image with its entrypoint overridden to run only
   `node dist/scripts/prepare-context-upgrade.js --source-revision 1a9b9f8404885622dc03fe772aa6ccd5ef34b64f`.
   Supply the deployment's database connection; do not run normal startup yet.
   Expected result: `legacy`.
5. Run the same command with `--apply --backup-verified` after verifying the backup
   and stopped writers. Expected result: `prepared`.
   This drops only the three context cache tables and the exact old migration
   ledger row in one transaction. It never uses CASCADE.
6. Run `node dist/scripts/migrate.js` with the new image. This applies upstream
   migrations 0109 through 0124 and generated context migration 0125.
7. Set APP_IMAGE to the new immutable digest and recreate only app.
   Keep existing Compose limits, mounts, network settings and encryption keys.
8. Check health, library listing, highlights, notes, reader positions and device
   sync. Check context worker logs, backlog and container memory. Resume
   transmission and filebrowser only after checks pass.

The preflight checks image revision, the entire migration prefix and exact cache
table columns, constraints and indexes. Unknown or partial states stop the upgrade.
The old and new context SQL have the same hash, so timestamp validation is required.
After preparation or full upgrade, running preparation again returns `not-needed`.
If preparation succeeded but migration failed, keep the app stopped and resolve
the migration or restore the backup before restarting.

## Rollback

Stop the new app and all writers. Restore the pre-upgrade database into a clean
database and restore any changed application/download/filebrowser data and saved
configuration. Select the recorded old image digest and start the old app.
Do not connect the old image directly to the upgraded database. No automatic
down-migration is provided.

## Automatic device position conversion

The context worker converts missing KOReader xpointer positions to CFIs before
extracting context. It reuses the reader conversion service and restricts queries
to the claimed user-owned annotations, with at most 25 jobs per batch.

Context pipeline version 2 automatically requeues old results, including rows
previously marked unavailable because no CFI existed. Opening the reader is no
longer required. Positions that cannot be converted remain unavailable, and
unsupported formats retain their existing fallback to the original highlight.
No database schema migration is required for this update.
