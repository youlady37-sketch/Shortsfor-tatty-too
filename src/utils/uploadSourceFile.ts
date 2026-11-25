import type {
  SourceLibraryItem,
  SourceRole,
  SourceVideoMetadata,
  UploadedAsset,
} from '../types.ts';

const CHUNK_SIZE_BYTES = 4 * 1024 * 1024; // 4 MiB — safely below Cloud Run 32 MiB request limit

export interface UploadSourceResponse {
  asset: UploadedAsset;
  assignedAssets: Partial<Record<SourceRole, UploadedAsset>>;
}

async function parseJsonResponseSafe<T>(res: Response): Promise<T> {
  const raw = await res.text();
  const trimmed = raw.trim();

  if (!trimmed) {
    if (!res.ok) {
      throw new Error(`Сервер вернул пустой ответ с ошибкой (HTTP ${res.status}).`);
    }
    throw new Error('Сервер вернул пустой ответ.');
  }

  if (trimmed.startsWith('<')) {
    if (res.status === 413) {
      throw new Error(
        'Файл превысил лимит одного HTTP-запроса (HTTP 413). Повторите загрузку — используется чанковая передача.',
      );
    }
    throw new Error(
      `Шлюз или сервер вернул HTML вместо JSON (HTTP ${res.status}). Попробуйте повторить загрузку.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`Некорректный ответ сервера (HTTP ${res.status}): ${trimmed.slice(0, 180)}`);
  }

  if (!res.ok) {
    const msg =
      parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : `Ошибка загрузки файла на сервер (HTTP ${res.status}).`;
    throw new Error(msg);
  }

  return parsed as T;
}

export async function uploadLibraryVideoToServer(params: {
  file: File;
  onProgress?: (percent: number) => void;
}): Promise<SourceLibraryItem> {
  const { file, onProgress } = params;

  if (file.size <= CHUNK_SIZE_BYTES) {
    onProgress?.(10);
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch('/api/library/upload', {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
    const data = await parseJsonResponseSafe<{ item: SourceLibraryItem }>(res);
    onProgress?.(100);
    return data.item;
  }

  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE_BYTES));
  onProgress?.(2);

  const initRes = await fetch('/api/library/upload/init', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      originalName: file.name,
      mimeType: file.type || 'video/mp4',
      totalSizeBytes: file.size,
      totalChunks,
    }),
  });
  const { uploadId } = await parseJsonResponseSafe<{ uploadId: string }>(initRes);

  for (let i = 0; i < totalChunks; i += 1) {
    const start = i * CHUNK_SIZE_BYTES;
    const end = Math.min(file.size, start + CHUNK_SIZE_BYTES);
    const chunkBlob = file.slice(start, end);

    const chunkRes = await fetch(
      `/api/library/upload/chunk/${encodeURIComponent(uploadId)}/${i}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: chunkBlob,
      },
    );
    await parseJsonResponseSafe<{ ok: boolean }>(chunkRes);
    const pct = Math.min(95, Math.round(((i + 1) / totalChunks) * 92) + 3);
    onProgress?.(pct);
  }

  const completeRes = await fetch('/api/library/upload/complete', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId }),
  });

  const completeData = await parseJsonResponseSafe<{ item: SourceLibraryItem }>(completeRes);
  onProgress?.(100);
  return completeData.item;
}

export async function updateLibraryVideoMetadata(
  id: string,
  patch: Partial<SourceVideoMetadata>,
): Promise<SourceLibraryItem> {
  const res = await fetch(`/api/library/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await parseJsonResponseSafe<{ item: SourceLibraryItem }>(res);
  return data.item;
}

export async function deleteLibraryVideoFromServer(id: string): Promise<void> {
  const res = await fetch(`/api/library/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  await parseJsonResponseSafe<{ ok: boolean }>(res);
}

export async function uploadSourceFileToServer(params: {
  role: SourceRole;
  file: File;
  assignBothSlots?: boolean;
  onProgress?: (percent: number) => void;
}): Promise<UploadSourceResponse> {
  const { role, file, assignBothSlots = false, onProgress } = params;

  // Small files (<= 4 MiB) go in a single FormData request; larger files use 4 MiB chunked upload
  if (file.size <= CHUNK_SIZE_BYTES) {
    onProgress?.(10);
    const formData = new FormData();
    formData.append('role', role);
    formData.append('assignBothSlots', String(assignBothSlots));
    formData.append('file', file);

    const res = await fetch('/api/upload-clip', {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
    const data = await parseJsonResponseSafe<{
      asset: UploadedAsset;
      assignedAssets?: Partial<Record<SourceRole, UploadedAsset>>;
    }>(res);
    onProgress?.(100);
    return {
      asset: data.asset,
      assignedAssets: data.assignedAssets ?? { [role]: data.asset },
    };
  }

  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE_BYTES));
  onProgress?.(2);

  const initRes = await fetch('/api/upload-clip/init', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      role,
      originalName: file.name,
      mimeType: file.type || 'application/octet-stream',
      totalSizeBytes: file.size,
      totalChunks,
      assignBothSlots,
    }),
  });

  const initData = await parseJsonResponseSafe<{ uploadId: string }>(initRes);
  const { uploadId } = initData;

  for (let i = 0; i < totalChunks; i += 1) {
    const start = i * CHUNK_SIZE_BYTES;
    const end = Math.min(file.size, start + CHUNK_SIZE_BYTES);
    const chunkBlob = file.slice(start, end);

    const chunkRes = await fetch(
      `/api/upload-clip/chunk/${encodeURIComponent(uploadId)}/${i}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: chunkBlob,
      },
    );
    await parseJsonResponseSafe<{ ok: boolean }>(chunkRes);
    const pct = Math.min(95, Math.round(((i + 1) / totalChunks) * 92) + 3);
    onProgress?.(pct);
  }

  const completeRes = await fetch('/api/upload-clip/complete', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId }),
  });

  const completeData = await parseJsonResponseSafe<{
    asset: UploadedAsset;
    assignedAssets?: Partial<Record<SourceRole, UploadedAsset>>;
  }>(completeRes);
  onProgress?.(100);

  return {
    asset: completeData.asset,
    assignedAssets: completeData.assignedAssets ?? { [role]: completeData.asset },
  };
}

export async function assignUploadedVideoToBothSlots(
  fromRole: 'fragment8' | 'fragment9',
): Promise<Partial<Record<SourceRole, UploadedAsset>>> {
  const res = await fetch('/api/upload-clip/assign-both', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromRole }),
  });
  const data = await parseJsonResponseSafe<{
    assignedAssets: Partial<Record<SourceRole, UploadedAsset>>;
  }>(res);
  return data.assignedAssets;
}
