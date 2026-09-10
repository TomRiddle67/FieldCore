import { createDatabaseClient } from '../client.js';
import { sql } from 'drizzle-orm';

async function main() {
  const db = createDatabaseClient();
  console.log('Cleaning PostgreSQL domain and sync tables for fresh demo...');

  await db.execute(
    sql`TRUNCATE change_log, idempotency_records, conflicts, measurements, inspections, sites, projects CASCADE;`
  );

  console.log('✓ Database cleaned successfully. Only registered devices remain.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to clean database:', err);
  process.exit(1);
});
