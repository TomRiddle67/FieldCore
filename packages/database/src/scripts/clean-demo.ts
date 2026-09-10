import { createDatabaseClient } from '../client.js';
import { users, devices } from '../schema/index.js';
import { sql } from 'drizzle-orm';

const connectionString =
  process.env.DATABASE_URL ||
  'postgres://fieldcore:fieldcore_dev_password@localhost:5432/fieldcore';

async function main() {
  const { db, client } = createDatabaseClient(connectionString);
  console.log('Cleaning PostgreSQL domain and sync tables for fresh demo...');

  // Truncate all tables and reset sequence generators
  await db.execute(
    sql`TRUNCATE TABLE measurements, inspections, sites, projects,
      change_log, idempotency_records, conflicts, sync_cursors,
      devices, users
    RESTART IDENTITY CASCADE;`
  );

  // Re-seed default user and demo devices
  const defaultUserId = '11111111-1111-4111-8111-111111111111';
  await db.insert(users).values({
    id: defaultUserId,
    email: 'engineer@fieldcore.io',
    name: 'Field Operations Engineer',
    role: 'GEOLOGIST',
  });

  const devDevices = [
    { id: '00000000-0000-0000-0000-000000000000', name: 'Default Device' },
    { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Field Device A' },
    { id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', name: 'Field Device B' },
  ];

  for (const dev of devDevices) {
    await db.insert(devices).values({
      id: dev.id,
      userId: defaultUserId,
      deviceIdentifier: `dev-${dev.id.slice(0, 8)}`,
      name: dev.name,
      platform: 'DESKTOP',
      isRevoked: false,
      lastRevalidatedAt: new Date().toISOString(),
      offlineAuthWindowDays: 30,
    });
  }

  console.log('✓ PostgreSQL cleaned and reset cleanly (sequences at 1, registered devices ready).');
  await client.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to clean database:', err);
  process.exit(1);
});
