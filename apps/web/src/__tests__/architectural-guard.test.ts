import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Stage 6 Architectural Guard: UI Components Never Access Raw Dexie Tables', () => {
  const componentsDir = path.resolve(__dirname, '../components');

  function getFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files = files.concat(getFiles(fullPath));
      } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
        files.push(fullPath);
      }
    }
    return files;
  }

  it('verifies that no component file imports FieldCoreDexie directly', () => {
    const files = getFiles(componentsDir);
    expect(files.length).toBeGreaterThan(0);

    const violations: { file: string; match: string }[] = [];
    const forbiddenPatterns = [
      /import\s+.*FieldCoreDexie.*from/i,
      /db\.projects\b/,
      /db\.sites\b/,
      /db\.inspections\b/,
      /db\.measurements\b/,
      /db\.sync_operations\b/,
      /db\.conflicts\b/,
    ];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(content)) {
          violations.push({ file: path.relative(componentsDir, file), match: pattern.toString() });
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
