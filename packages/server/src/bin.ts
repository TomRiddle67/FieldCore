import { createServer } from './server.js';
import { createDatabaseClient, users, devices } from '@fieldcore/database';
import { eq } from 'drizzle-orm';

const connectionString =
  process.env.DATABASE_URL ||
  'postgres://fieldcore:fieldcore_dev_password@localhost:5432/fieldcore';

const { db } = createDatabaseClient(connectionString);

async function seedDevDevices() {
  const defaultUserId = '11111111-1111-4111-8111-111111111111';
  const existingUser = await db.select().from(users).where(eq(users.id, defaultUserId));
  if (existingUser.length === 0) {
    await db.insert(users).values({
      id: defaultUserId,
      email: 'engineer@fieldcore.io',
      name: 'Field Operations Engineer',
      role: 'GEOLOGIST',
    });
  }

  const devDevices = [
    { id: '00000000-0000-0000-0000-000000000000', name: 'Default Device' },
    { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Field Device A' },
    { id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', name: 'Field Device B' },
  ];

  for (const dev of devDevices) {
    const existing = await db.select().from(devices).where(eq(devices.id, dev.id));
    if (existing.length === 0) {
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
  }
}

const app = createServer({ db, logger: false });

const port = Number(process.env.PORT || 3001);

seedDevDevices().catch(console.error).finally(() => {
  app.listen({ port, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      console.error('Failed to start server:', err);
      process.exit(1);
    }
    console.log(`FieldCore Sync Server listening on ${address}`);
  });
});
