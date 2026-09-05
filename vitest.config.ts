import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Disable parallel test file execution across the monorepo.
     *
     * The adversarial-push and adversarial-pull test suites both run end-to-end
     * against the same shared local Postgres container. Running them in parallel
     * causes cross-test contamination: one file's beforeEach/afterEach lifecycle
     * operations on shared tables (projects, change_log, idempotency_records, conflicts)
     * interfere with the other file's in-flight test assertions.
     *
     * The total test runtime increase is negligible (~3-5s) since these are the only
     * files touching Postgres; all other packages run against fake-indexeddb or pure
     * in-memory state.
     */
    fileParallelism: false,
  },
});
