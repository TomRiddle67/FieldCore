import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

/**
 * Factory to create a Drizzle database client with schema.
 */
export function createDatabaseClient(connectionString: string) {
  const client = postgres(connectionString);
  const db = drizzle(client, { schema });
  return { db, client };
}

export type Database = ReturnType<typeof createDatabaseClient>['db'];
