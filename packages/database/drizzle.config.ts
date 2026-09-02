import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: ['./src/schema/domain.ts', './src/schema/sync.ts'],
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgres://fieldcore:fieldcore_dev_password@localhost:5432/fieldcore',
  },
});
