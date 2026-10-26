import { Pool } from 'pg';
import { createPostgresClientConfig } from '../db/postgres-connection-config';
import { prepareContextUpgrade } from './context-upgrade';

async function main() {
  const args = process.argv.slice(2);
  const supported = new Set(['--apply', '--backup-verified', '--source-revision']);
  for (let i = 0; i < args.length; i++) {
    if (!supported.has(args[i])) throw new Error('Unknown upgrade argument');
    if (args[i] === '--source-revision') i++;
  }
  const revisionIndex = args.indexOf('--source-revision');
  const sourceRevision = revisionIndex < 0 ? '' : args[revisionIndex + 1];
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool(createPostgresClientConfig(process.env.DATABASE_URL, { max: 1 }));
  try {
    const result = await prepareContextUpgrade(pool, {
      sourceRevision,
      apply: args.includes('--apply'),
      backupVerified: args.includes('--backup-verified'),
    });
    console.log(JSON.stringify({ result }));
  } finally {
    await pool.end();
  }
}
void main().catch(() => {
  console.error('Context upgrade refused or failed. Check image revision, backup, stopped writers, schema and migration ledger.');
  process.exitCode = 1;
});
