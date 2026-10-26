import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { installPostgresExtensions } from './postgres-extensions';
import { contextMigrationsFolder, LEGACY_CONTEXT_HASH, LEGACY_CONTEXT_TIME, LEGACY_CONTEXT_REVISION, prepareContextUpgrade } from './context-upgrade';

const url = process.env.CONTEXT_UPGRADE_TEST_DATABASE_URL;
describe.skipIf(!url)('context database upgrade', () => {
  let admin: Pool;
  let pool: Pool;
  let database: string;
  let directory: string;
  const options = { sourceRevision: LEGACY_CONTEXT_REVISION };
  const apply = { ...options, apply: true, backupVerified: true };

  beforeAll(() => {
    admin = new Pool({ connectionString: url });
  });
  beforeEach(async () => {
    database = 'bookorbit_context_test_upgrade_' + randomUUID().replaceAll('-', '');
    await admin.query('CREATE DATABASE "' + database + '"');
    const connection = new URL(url!);
    connection.pathname = '/' + database;
    pool = new Pool({ connectionString: connection.href });
    await installPostgresExtensions(pool);
    directory = await mkdtemp(join(tmpdir(), 'context-upgrade-'));
  });
  afterEach(async () => {
    await pool?.end();
    if (database) await admin.query('DROP DATABASE "' + database + '"');
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  afterAll(async () => {
    await admin?.end();
  });

  async function prefix(length: number) {
    await cp(contextMigrationsFolder(), directory, { recursive: true });
    const path = join(directory, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(path, 'utf8'));
    journal.entries = journal.entries.slice(0, length);
    await writeFile(path, JSON.stringify(journal));
    await migrate(drizzle(pool), { migrationsFolder: directory });
  }
  async function legacy() {
    await prefix(109);
    const sql = await readFile(join(__dirname, 'fixtures', 'legacy-annotation-context.sql'), 'utf8');
    expect(createHash('sha256').update(sql).digest('hex')).toBe(LEGACY_CONTEXT_HASH);
    for (const statement of sql.split('--> statement-breakpoint')) await pool.query(statement);
    await pool.query('INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ($1,$2)', [LEGACY_CONTEXT_HASH, LEGACY_CONTEXT_TIME]);
    await pool.query("INSERT INTO annotation_context_maintenance(name) VALUES ('backfill')");
  }
  async function finish() {
    await migrate(drizzle(pool), { migrationsFolder: contextMigrationsFolder() });
    await migrate(drizzle(pool), { migrationsFolder: contextMigrationsFolder() });
    const hashes = (await pool.query('SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows.map((row) => row.hash);
    expect(hashes).toEqual(readMigrationFiles({ migrationsFolder: contextMigrationsFolder() }).map((entry) => entry.hash));
    expect(await prepareContextUpgrade(pool, options)).toBe('not-needed');
  }

  it('installs clean databases and is repeatable', async () => {
    await finish();
  });
  it('upgrades the exact deployed database without changing annotations', async () => {
    await legacy();
    const user = (await pool.query("INSERT INTO users(username,name,password_hash) VALUES ('upgrade-test','Upgrade test','test-only') RETURNING id"))
      .rows[0].id;
    const library = (await pool.query("INSERT INTO libraries(name) VALUES ('Upgrade fixture') RETURNING id")).rows[0].id;
    const folder = (await pool.query("INSERT INTO library_folders(library_id,path) VALUES ($1,'/books/upgrade') RETURNING id", [library])).rows[0].id;
    const book = (
      await pool.query("INSERT INTO books(library_id,library_folder_id,folder_path) VALUES ($1,$2,'/books/upgrade') RETURNING id", [library, folder])
    ).rows[0].id;
    await pool.query("INSERT INTO annotations(user_id,book_id,text,note) VALUES ($1,$2,'selected text','keep this note')", [user, book]);
    const before = (await pool.query('SELECT * FROM annotations ORDER BY id')).rows;
    expect(await prepareContextUpgrade(pool, options)).toBe('legacy');
    expect((await pool.query('SELECT count(*)::int AS count FROM annotation_context_maintenance')).rows[0].count).toBe(1);
    expect(await prepareContextUpgrade(pool, apply)).toBe('prepared');
    expect(await prepareContextUpgrade(pool, apply)).toBe('not-needed');
    await finish();
    expect((await pool.query('SELECT * FROM annotations ORDER BY id')).rows).toMatchObject(before);
    expect((await pool.query('SELECT count(*)::int AS count FROM annotation_contexts')).rows[0].count).toBe(0);
  });
  it('upgrades an unmodified upstream database', async () => {
    await prefix(125);
    expect(await prepareContextUpgrade(pool, options)).toBe('not-needed');
    await finish();
  });
  it('refuses an unexpected image, missing backup, modified timestamp and unknown schema', async () => {
    await legacy();
    await expect(prepareContextUpgrade(pool, { ...options, sourceRevision: 'unknown' })).rejects.toThrow('revision');
    await expect(prepareContextUpgrade(pool, { ...options, apply: true })).rejects.toThrow('backup');
    await pool.query('UPDATE drizzle.__drizzle_migrations SET created_at=created_at+1 WHERE hash=$1', [LEGACY_CONTEXT_HASH]);
    await expect(prepareContextUpgrade(pool, apply)).rejects.toThrow('timestamp');
    await pool.query('UPDATE drizzle.__drizzle_migrations SET created_at=$1 WHERE hash=$2', [LEGACY_CONTEXT_TIME, LEGACY_CONTEXT_HASH]);
    await pool.query('ALTER TABLE annotation_contexts ADD COLUMN unexpected integer');
    await expect(prepareContextUpgrade(pool, apply)).rejects.toThrow('schema');
    expect((await pool.query('SELECT count(*)::int AS count FROM annotation_context_maintenance')).rows[0].count).toBe(1);
  });
  it('rolls back cleanup if another table depends on the cache', async () => {
    await legacy();
    await pool.query('CREATE VIEW protected_contexts AS SELECT * FROM annotation_contexts');
    await expect(prepareContextUpgrade(pool, apply)).rejects.toThrow();
    expect((await pool.query('SELECT hash FROM drizzle.__drizzle_migrations WHERE hash=$1', [LEGACY_CONTEXT_HASH])).rows).toHaveLength(1);
    expect((await pool.query('SELECT count(*)::int AS count FROM annotation_context_maintenance')).rows[0].count).toBe(1);
  });
  it('refuses partial cleanup', async () => {
    await legacy();
    await pool.query('DROP TABLE annotation_context_maintenance');
    await expect(prepareContextUpgrade(pool, apply)).rejects.toThrow('schema');
  });
});
