import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

async function main() {
  const url = process.env.DB_URL || process.env.SUPABASE_DB_URL;
  if (!url) {
    console.error('Missing DATABASE_URL (or SUPABASE_DB_URL) in environment');
    process.exit(1);
  }
  const sqlPath = process.argv[2] || join(__dirname, 'sql', '001_init.sql');
  let sql: string;
  try {
    sql = readFileSync(sqlPath, 'utf8');
  } catch (e) {
    console.error('Failed to read SQL file at', sqlPath, e);
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.query('begin');
    await client.query(sql);
    await client.query('commit');
    console.log('Migration applied successfully from', sqlPath);
  } catch (e) {
    try { await client.query('rollback'); } catch {}
    console.error('Migration failed:', e);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();

