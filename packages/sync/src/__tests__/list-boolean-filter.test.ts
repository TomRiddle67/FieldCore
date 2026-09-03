import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { FieldCoreDexie } from '../db/database.js';
import { ProjectRepository } from '../repository/project.js';
import type { RepositoryContext } from '../repository/base.js';

/**
 * Regression guard for Dexie/IndexedDB boolean-to-key coercion.
 *
 * ProjectRepository.list() uses `.where('isDeleted').equals(0)` to filter
 * active records. IndexedDB stores booleans as 0/1 integer keys, so this
 * works today — but the coercion behavior is a Dexie implementation detail,
 * not a spec guarantee. If a Dexie version bump ever changes how booleans
 * are indexed, this test fails loudly instead of silently returning wrong
 * results in production.
 */
describe('list() Boolean Filter — Dexie IndexedDB Regression Guard', () => {
  let db: FieldCoreDexie;
  const context: RepositoryContext = {
    userId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    deviceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
    clientId: 'client-offline-01',
  };

  beforeEach(() => {
    db = new FieldCoreDexie(`test_db_list_bool_${Date.now()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('list(false) excludes soft-deleted records; list(true) includes them', async () => {
    const repo = new ProjectRepository(db, context);

    const p = await repo.create({ name: 'Boolean Filter Test', code: 'BFT-01' });
    await repo.delete(p.id);

    const active = await repo.list(false);
    const all = await repo.list(true);

    expect(active).toHaveLength(0);
    expect(all).toHaveLength(1);
    expect(all[0].isDeleted).toBe(true);
  });

  it('list(false) returns active records correctly when mixed with deleted', async () => {
    const repo = new ProjectRepository(db, context);

    const alive = await repo.create({ name: 'Still Active', code: 'SA-01' });
    const doomed = await repo.create({ name: 'Will Be Deleted', code: 'WBD-01' });
    await repo.delete(doomed.id);

    const active = await repo.list(false);
    const all = await repo.list(true);

    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(alive.id);
    expect(all).toHaveLength(2);
  });
});
