import { Pool } from 'pg';
import { prepareContextUpgrade, LEGACY_CONTEXT_REVISION } from './context-upgrade';
import { execFileSync } from 'node:child_process';

async function main() {
  const url = process.env.DATABASE_URL!;
  if (!new URL(url).pathname.startsWith('/bookorbit_context_test_')) throw new Error('Isolated rehearsal database required');
  const pool = new Pool({ connectionString: url });
  try {
    const columns = (
      await pool.query<{ table_name: string; column_name: string }>(
        "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name NOT LIKE 'annotation_context%' ORDER BY table_name,ordinal_position",
      )
    ).rows;
    const tables = new Map<string, string[]>();
    for (const row of columns) tables.set(row.table_name, [...(tables.get(row.table_name) ?? []), row.column_name]);
    const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
    async function snapshot() {
      const result = new Map<string, string>();
      for (const [table, fields] of tables) {
        const query =
          "SELECT md5(coalesce(string_agg(value, chr(10) ORDER BY value),'')) AS hash FROM (SELECT row_to_json(t)::text AS value FROM (SELECT " +
          fields.map(quote).join(',') +
          ' FROM public.' +
          quote(table) +
          ') t) rows';
        result.set(table, (await pool.query(query)).rows[0].hash);
      }
      return result;
    }
    const before = await snapshot();
    const options = { sourceRevision: LEGACY_CONTEXT_REVISION };
    if ((await prepareContextUpgrade(pool, options)) !== 'legacy') throw new Error('Expected legacy production snapshot');
    await prepareContextUpgrade(pool, { ...options, apply: true, backupVerified: true });
    execFileSync(process.execPath, ['dist/scripts/migrate.js'], { stdio: 'inherit' });
    const after = await snapshot();
    const changed = [...before].filter(([table, hash]) => after.get(table) !== hash).map(([table]) => table);
    if (changed.length) throw new Error('Existing data changed: ' + changed.join(', '));
    if ((await prepareContextUpgrade(pool, options)) !== 'not-needed') throw new Error('Upgrade did not complete');
    console.log(JSON.stringify({ tablesVerified: tables.size, result: 'all-existing-columns-preserved' }));
  } finally {
    await pool.end();
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
