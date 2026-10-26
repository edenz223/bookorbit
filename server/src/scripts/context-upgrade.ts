import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { Pool } from 'pg';
import { contextSchemaQuery, legacyContextSchema } from './context-upgrade-schema';

export const LEGACY_CONTEXT_HASH = '3e50be1479dc984bc88489653ab4e8178ae828ec6d6be5e37b4e8a2d7fdf31ba';
export const LEGACY_CONTEXT_TIME = '1791787292883';
export const LEGACY_CONTEXT_REVISION = '1a9b9f8404885622dc03fe772aa6ccd5ef34b64f';

export function contextMigrationsFolder(): string {
  const folders = [join(__dirname, '..', '..', 'migrations'), join(__dirname, '..', 'db', 'migrations')];
  const folder = folders.find((candidate) => existsSync(join(candidate, 'meta', '_journal.json')));
  if (!folder) throw new Error('Migration journal not found');
  return folder;
}
function schemaSignature(rows: typeof legacyContextSchema): string {
  return JSON.stringify(
    rows.map((row) => ({
      ...row,
      definition: row.definition
        .replace(/\('([^']*)'::character varying\)::text/g, "'$1'::character varying")
        .replace(/\(ARRAY\[([^\]]*)\]\)::text\[\]/g, 'ARRAY[$1]'),
    })),
  );
}

type UpgradeOptions = { apply?: boolean; sourceRevision: string; backupVerified?: boolean; migrationsFolder?: string };

export async function prepareContextUpgrade(pool: Pool, options: UpgradeOptions): Promise<'prepared' | 'legacy' | 'not-needed'> {
  if (options.sourceRevision !== LEGACY_CONTEXT_REVISION) throw new Error('Unexpected source image revision');
  if (options.apply && !options.backupVerified) throw new Error('Apply requires a verified backup and stopped writers');
  const migrations = readMigrationFiles({ migrationsFolder: options.migrationsFolder ?? contextMigrationsFolder() });
  const client = await pool.connect();
  try {
    await client.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY');
    await client.query("SET LOCAL lock_timeout = '5s'");
    if (options.apply) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('bookorbit'), hashtext('migration-ledger-compatibility'))");
      await client.query('LOCK TABLE drizzle.__drizzle_migrations IN EXCLUSIVE MODE');
    }
    const ledger = await client.query<{ hash: string; created_at: string }>(
      'SELECT hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at, id',
    );
    const known = new Map(migrations.map((entry) => [entry.hash, String(entry.folderMillis)]));
    const legacy = ledger.rows.filter((row) => row.hash === LEGACY_CONTEXT_HASH && row.created_at === LEGACY_CONTEXT_TIME);
    for (const row of ledger.rows) {
      if (known.get(row.hash) === row.created_at) continue;
      if (row.hash === LEGACY_CONTEXT_HASH) {
        if (row.created_at !== LEGACY_CONTEXT_TIME) throw new Error('Unexpected legacy migration timestamp');
      } else if (known.get(row.hash) !== row.created_at) throw new Error('Unknown or modified migration ledger');
    }
    if (new Set(ledger.rows.map((row) => row.hash)).size !== ledger.rows.length) throw new Error('Duplicate migration ledger entries');
    const actualSchema = (await client.query(contextSchemaQuery)).rows;
    if (!legacy.length) {
      const expected = migrations.filter((entry) => entry.folderMillis <= Number(ledger.rows.at(-1)?.created_at ?? 0));
      if (expected.length !== ledger.rows.length || expected.some((entry, index) => entry.hash !== ledger.rows[index].hash))
        throw new Error('Incomplete migration ledger');
      const hasContextMigration = expected.some((entry) => entry.sql.some((sql) => sql.includes('CREATE TABLE "annotation_contexts"')));
      if (hasContextMigration !== actualSchema.length > 0) throw new Error('Partial context upgrade state');
      if (hasContextMigration && schemaSignature(actualSchema) !== schemaSignature(legacyContextSchema)) throw new Error('Unexpected context schema');
      await client.query('COMMIT');
      return 'not-needed';
    }
    const prefix = migrations.filter((entry) => entry.folderMillis < Number(LEGACY_CONTEXT_TIME));
    if (ledger.rows.length !== prefix.length + 1 || prefix.some((entry, index) => entry.hash !== ledger.rows[index].hash))
      throw new Error('Legacy upgrade requires the exact deployed migration prefix');
    if (schemaSignature(actualSchema) !== schemaSignature(legacyContextSchema)) throw new Error('Unexpected legacy context schema');
    if (!options.apply) {
      await client.query('COMMIT');
      return 'legacy';
    }
    await client.query(
      'LOCK TABLE public.annotation_contexts, public.annotation_context_files, public.annotation_context_maintenance IN ACCESS EXCLUSIVE MODE',
    );
    await client.query('DROP TABLE public.annotation_contexts, public.annotation_context_files, public.annotation_context_maintenance');
    const deleted = await client.query('DELETE FROM drizzle.__drizzle_migrations WHERE hash = $1 AND created_at = $2', [
      LEGACY_CONTEXT_HASH,
      LEGACY_CONTEXT_TIME,
    ]);
    if (deleted.rowCount !== 1) throw new Error('Legacy ledger changed during preparation');
    await client.query('COMMIT');
    return 'prepared';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
