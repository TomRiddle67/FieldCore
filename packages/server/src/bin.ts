import { createServer } from './server.js';
import { createDatabaseClient, users, devices } from '@fieldcore/database';
import { eq } from 'drizzle-orm';
import { hashPassword } from './auth/password.js';

const connectionString =
  process.env.DATABASE_URL ||
  'postgres://fieldcore:fieldcore_dev_password@localhost:5432/fieldcore';

const { db } = createDatabaseClient(connectionString);

/**
 * Seeds the development database with a default user (if absent) and three
 * well-known devices (Device A, Device B, Default).
 *
 * The default user is seeded with a hashed password so login works out of the
 * box for local development:
 *   email:    engineer@fieldcore.io
 *   password: fieldcore-dev-password
 */
async function seedDevDevices() {
  const defaultUserId = '11111111-1111-4111-8111-111111111111';
  const devPassword = 'fieldcore-dev-password';

  const existingUser = await db.select().from(users).where(eq(users.id, defaultUserId));
  if (existingUser.length === 0) {
    const passwordHash = await hashPassword(devPassword);
    await db.insert(users).values({
      id: defaultUserId,
      email: 'engineer@fieldcore.io',
      name: 'Field Operations Engineer',
      role: 'GEOLOGIST',
      passwordHash,
    });
    console.log('[bin] Seeded dev user: engineer@fieldcore.io / fieldcore-dev-password');
  } else if (!existingUser[0].passwordHash) {
    // Backfill password_hash for rows created before this migration
    const passwordHash = await hashPassword(devPassword);
    await db
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, defaultUserId));
    console.log('[bin] Backfilled password_hash for dev user');
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
