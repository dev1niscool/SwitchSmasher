import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { downloadFile, fetchJSON, findPayloadAsset } from '../scripts/update-payloads.ts';

const respond = (response: Response): typeof fetch => async () => response;

test('release lookup rejects HTTP API errors instead of parsing them as releases', async () => {
  await assert.rejects(fetchJSON('https://api.github.com/test', respond(new Response('{}', { status: 403 }))), /HTTP 403/);
});

test('failed, empty, and interrupted downloads preserve the previous binary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'switch-smasher-updater-'));
  const destination = join(directory, 'payload.bin');
  const original = Buffer.from([1, 2, 3]);
  try {
    await writeFile(destination, original);
    const interrupted = new ReadableStream({ start(controller) { controller.error(new Error('connection lost')); } });
    for (const response of [
      new Response('Not found', { status: 404 }),
      new Response(new Uint8Array()),
      new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } }),
      new Response(interrupted),
    ]) {
      await assert.rejects(downloadFile('https://example.com/payload.bin', destination, respond(response)));
      assert.deepEqual(await readFile(destination), original);
      assert.deepEqual(await readdir(directory), ['payload.bin']);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('complete downloads create their directory and atomically replace binaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'switch-smasher-updater-'));
  const destination = join(directory, 'hekate', 'payload.bin');
  try {
    await downloadFile('https://example.com/payload.bin', destination, respond(new Response(new Uint8Array([4, 5, 6]))));
    assert.deepEqual(await readFile(destination), Buffer.from([4, 5, 6]));
    await downloadFile('https://example.com/payload.bin', destination, respond(new Response(new Uint8Array([7, 8]))));
    assert.deepEqual(await readFile(destination), Buffer.from([7, 8]));
    assert.deepEqual(await readdir(join(directory, 'hekate')), ['payload.bin']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('asset selection excludes RAM-specific Hekate and fails on missing binaries', () => {
  const release = {
    tag_name: 'v6.5.4', prerelease: false, published_at: '2026-09-28T00:00:00Z', html_url: 'https://example.com',
    assets: [
      { name: 'hekate_ctcaer_6.5.4__ram8GB.bin', browser_download_url: 'https://example.com/ram' },
      { name: 'hekate_ctcaer_6.5.4.bin', browser_download_url: 'https://example.com/standard' },
    ],
  };
  assert.equal(findPayloadAsset(release, 'hekate').browser_download_url, 'https://example.com/standard');
  assert.throws(() => findPayloadAsset(release, 'fusee'), /No fusee payload/);
});
