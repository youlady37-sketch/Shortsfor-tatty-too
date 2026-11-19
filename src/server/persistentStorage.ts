import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { StorageEnvironmentInfo } from '../types.ts';

const GCS_BUCKET = (process.env.GCS_BUCKET || '').trim() || null;
const GCS_PREFIX = ((process.env.GCS_PREFIX || 'delo-v-kadre-shorts').trim()).replace(/^\/+|\/+$/g, '');

let cachedToken: { token: string; expiresAtMs: number } | null = null;

async function getGcsAccessToken(): Promise<string | null> {
  if (!GCS_BUCKET) return null;
  if (process.env.GOOGLE_ACCESS_TOKEN) {
    return process.env.GOOGLE_ACCESS_TOKEN;
  }
  if (cachedToken && Date.now() < cachedToken.expiresAtMs - 60_000) {
    return cachedToken.token;
  }
  try {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(2500),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;
    cachedToken = {
      token: data.access_token,
      expiresAtMs: Date.now() + (data.expires_in ?? 300) * 1000,
    };
    return cachedToken.token;
  } catch {
    return null;
  }
}

function buildObjectName(relativeKey: string): string {
  const clean = relativeKey.replace(/^\/+/, '');
  return GCS_PREFIX ? `${GCS_PREFIX}/${clean}` : clean;
}

export function getStorageEnvironmentInfo(): StorageEnvironmentInfo {
  if (GCS_BUCKET) {
    return {
      mode: 'gcs',
      gcsBucket: GCS_BUCKET,
      summary: `Внешнее объектное хранилище Google Cloud Storage (${GCS_BUCKET}) активно.`,
    };
  }
  return {
    mode: 'ephemeral-container',
    gcsBucket: null,
    summary:
      'Диск контейнера Cloud Run эфемерный (без GCS_BUCKET). Исходники и готовые MP4 резервируются в постоянном хранилище браузера (OPFS/IndexedDB).',
  };
}

export async function uploadFileToCloud(
  localPath: string,
  relativeKey: string,
  contentType = 'application/octet-stream',
): Promise<boolean> {
  if (!GCS_BUCKET || !fs.existsSync(localPath)) return false;
  const token = await getGcsAccessToken();
  if (!token) return false;

  const objectName = buildObjectName(relativeKey);
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(
    GCS_BUCKET,
  )}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;

  try {
    const stat = fs.statSync(localPath);
    const stream = fs.createReadStream(localPath);
    const webStream = Readable.toWeb(stream) as unknown as ReadableStream;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': contentType,
        'Content-Length': String(stat.size),
      },
      body: webStream,
      duplex: 'half',
    } as RequestInit);
    return res.ok;
  } catch {
    return false;
  }
}

export async function checkCloudObjectExists(relativeKey: string): Promise<boolean> {
  if (!GCS_BUCKET) return false;
  const token = await getGcsAccessToken();
  if (!token) return false;

  const objectName = buildObjectName(relativeKey);
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(
    GCS_BUCKET,
  )}/o/${encodeURIComponent(objectName)}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function restoreFileFromCloud(
  relativeKey: string,
  localDestPath: string,
): Promise<boolean> {
  if (!GCS_BUCKET) return false;
  const token = await getGcsAccessToken();
  if (!token) return false;

  const objectName = buildObjectName(relativeKey);
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(
    GCS_BUCKET,
  )}/o/${encodeURIComponent(objectName)}?alt=media`;

  const tmpPath = `${localDestPath}.tmp_${Date.now()}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok || !res.body) return false;

    fs.mkdirSync(path.dirname(localDestPath), { recursive: true });
    const outStream = fs.createWriteStream(tmpPath);
    const readable = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream);
    await pipeline(readable, outStream);
    fs.renameSync(tmpPath, localDestPath);
    return fs.existsSync(localDestPath) && fs.statSync(localDestPath).size > 0;
  } catch {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    return false;
  }
}

export async function deleteCloudObject(relativeKey: string): Promise<void> {
  if (!GCS_BUCKET) return;
  const token = await getGcsAccessToken();
  if (!token) return;

  const objectName = buildObjectName(relativeKey);
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(
    GCS_BUCKET,
  )}/o/${encodeURIComponent(objectName)}`;

  try {
    await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // ignore deletion failure
  }
}
