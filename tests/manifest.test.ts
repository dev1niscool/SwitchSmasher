import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PayloadManifest } from '../src/types/index.ts';

const directory = join(import.meta.dirname, '../public/payloads');
const manifest: PayloadManifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));

for (const type of ['hekate', 'fusee'] as const) {
  test(`${type}: every version maps to an existing binary and an official release`, () => {
    const entry = manifest[type];
    assert(entry.versions.some(v => v.version === entry.latest));
    assert.equal(new Set(entry.versions.map(v => v.version)).size, entry.versions.length);
    assert(entry.versions.length <= manifest.maxVersionsToKeep);
    for (const version of entry.versions) {
      assert.match(version.file, /^[a-zA-Z0-9_.-]+\.bin$/);
      assert(statSync(join(directory, type, version.file)).size > 0);
      assert(version.url.startsWith(`https://github.com/${entry.repo}/releases/tag/`));
      assert(Number.isFinite(Date.parse(version.date)));
    }
    assert.deepEqual(readdirSync(join(directory, type)).sort(), entry.versions.map(v => v.file).sort());
  });
}
