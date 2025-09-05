import 'dotenv/config';
import { Client } from 'pg';

type Row = { id: string | number; session: string };

async function main() {
  const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!url) {
    console.error('Missing DATABASE_URL (or SUPABASE_DB_URL) in environment');
    process.exit(1);
  }
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    let offset = 0;
    const limit = 1000; // batch size
    let totalUpserts = 0;
    for (;;) {
      const { rows } = await client.query<Row>(
        `select id, session from public.session order by id asc offset $1 limit $2`,
        [offset, limit]
      );
      if (!rows.length) break;

      const upserts: { post_id: number; user_id: number }[] = [];
      for (const r of rows) {
        try {
          const uid = Number(r.id);
          const doc = JSON.parse(r.session || '{}');
          const confs: any[] = Array.isArray(doc.confessions) ? doc.confessions : [];
          for (const c of confs) {
            const pid = Number(c?.id);
            if (Number.isFinite(pid) && pid > 0 && Number.isFinite(uid) && uid > 0) {
              upserts.push({ post_id: pid, user_id: uid });
            }
          }
        } catch {
          // ignore bad rows
        }
      }

      if (upserts.length) {
        // Build single upsert query
        const values: string[] = [];
        const params: any[] = [];
        upserts.forEach((u, i) => {
          const idx = i * 2;
          values.push(`($${idx + 1}, $${idx + 2})`);
          params.push(u.post_id, u.user_id);
        });
        const sql = `insert into public.post_user_map (post_id, user_id) values ${values.join(',')} on conflict (post_id) do update set user_id=excluded.user_id, updated_at=now()`;
        await client.query(sql, params);
        totalUpserts += upserts.length;
      }

      offset += rows.length;
      console.log(`Processed ${offset} session rows... (upserts so far: ${totalUpserts})`);
    }

    console.log(`Backfill complete. Total mappings upserted: ${totalUpserts}`);
  } catch (e) {
    console.error('Backfill failed:', e);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();

