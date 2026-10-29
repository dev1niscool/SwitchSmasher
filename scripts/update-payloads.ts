#!/usr/bin/env node
/** Refresh the bundled library from official stable GitHub releases. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

interface PayloadVersion {
  version: string;
  prerelease: boolean;
  file: string;
  date: string;
  url: string;
}
interface PayloadEntry {
  name: string;
  repo: string;
  latest: string;
  versions: PayloadVersion[];
}
interface Manifest {
  hekate: PayloadEntry;
  fusee: PayloadEntry;
  lastUpdated: string;
  maxVersionsToKeep: number;
}
interface GitHubRelease {
  tag_name: string;
  prerelease: boolean;
  published_at: string;
  html_url: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

const PAYLOADS_DIR = path.join(process.cwd(), 'public', 'payloads');
const MANIFEST_PATH = path.join(PAYLOADS_DIR, 'manifest.json');
const REQUEST_TIMEOUT_MS = 60_000;

export async function fetchJSON<T>(url: string, fetcher: typeof fetch = fetch): Promise<T> {
  const headers: Record<string, string> = {
    'User-Agent': 'Switch-Smasher-Payload-Updater',
    Accept: 'application/vnd.github+json',
  };
  // Only send the workflow credential to GitHub's API, never asset hosts.
  if (process.env.GITHUB_TOKEN && new URL(url).origin === 'https://api.github.com') {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const response = await fetcher(url, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub request failed: HTTP ${response.status} (${url})`);
  return await response.json() as T;
}

export async function downloadFile(
  url: string,
  destPath: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Payload download failed: HTTP ${response.status} (${url})`);
  if (/text\/html|application\/json/i.test(response.headers.get('content-type') ?? '')) {
    throw new Error(`Payload download returned a document instead of a binary (${url})`);
  }
  // Read the complete response before touching the existing file. Interrupted
  // downloads must never replace a usable payload with partial data.
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error(`Payload download was empty (${url})`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const temporaryPath = `${destPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, bytes);
    fs.renameSync(temporaryPath, destPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function findPayloadAsset(release: GitHubRelease, kind: 'hekate' | 'fusee') {
  const asset = release.assets.find((candidate) => kind === 'hekate'
    ? /^hekate_ctcaer_[\d.]+\.bin$/.test(candidate.name)
    : candidate.name === 'fusee.bin');
  if (!asset) throw new Error(`No ${kind} payload binary in release ${release.tag_name}`);
  return asset;
}

async function updatePayload(manifest: Manifest, kind: 'hekate' | 'fusee'): Promise<boolean> {
  const entry = manifest[kind];
  console.log(`Checking ${entry.name} releases...`);
  const release = await fetchJSON<GitHubRelease>(
    `https://api.github.com/repos/${entry.repo}/releases/latest`,
  );
  const version = release.tag_name.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version) || release.prerelease) {
    throw new Error(`Unexpected stable release version: ${release.tag_name}`);
  }
  const asset = findPayloadAsset(release, kind);
  const file = kind === 'hekate' ? `hekate_ctcaer_${version}.bin` : `fusee_${version}.bin`;
  const destPath = path.join(PAYLOADS_DIR, kind, file);
  const recorded = entry.versions.find((item) => item.version === version);
  if (entry.latest === version && recorded?.file === file && fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
    console.log(`${entry.name} is up to date (v${version})`);
    return false;
  }
  console.log(`Downloading ${asset.name}...`);
  await downloadFile(asset.browser_download_url, destPath);
  entry.versions = [{
    version,
    prerelease: release.prerelease,
    file,
    date: release.published_at.split('T')[0],
    url: release.html_url,
  }, ...entry.versions.filter((item) => item.version !== version)]
    .slice(0, manifest.maxVersionsToKeep);
  entry.latest = version;
  return true;
}

async function main() {
  console.log('Switch Smasher Payload Updater\n');
  const original = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  const manifest = structuredClone(original);
  if (!Number.isInteger(manifest.maxVersionsToKeep) || manifest.maxVersionsToKeep < 1) {
    throw new Error('maxVersionsToKeep must be a positive integer');
  }
  const updatedPayloads: string[] = [];
  for (const kind of ['hekate', 'fusee'] as const) {
    if (await updatePayload(manifest, kind)) {
      updatedPayloads.push(`${kind === 'hekate' ? 'Hekate' : 'Fusee'} to v${manifest[kind].latest}`);
    }
  }
  if (updatedPayloads.length === 0) {
    console.log('\nNo updates available.');
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'updated=false\n');
    return;
  }
  // Publish metadata only after both sources succeeded. Prune files afterwards,
  // so a failed update cannot leave the old manifest pointing at deleted files.
  manifest.lastUpdated = new Date().toISOString();
  const temporaryManifest = `${MANIFEST_PATH}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(temporaryManifest, MANIFEST_PATH);
  } finally {
    fs.rmSync(temporaryManifest, { force: true });
  }
  for (const kind of ['hekate', 'fusee'] as const) {
    const retained = new Set(manifest[kind].versions.map((item) => item.file));
    for (const old of original[kind].versions) {
      if (!retained.has(old.file)) fs.rmSync(path.join(PAYLOADS_DIR, kind, old.file), { force: true });
    }
  }
  const commitMessage = `chore(payloads): update ${updatedPayloads.join(' and ')}`;
  console.log(`\n${commitMessage}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `updated=true\ncommit_message=${commitMessage}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error('Payload update failed:', error);
    process.exitCode = 1;
  });
}
