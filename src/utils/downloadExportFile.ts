import type {
  DownloadProgressInfo,
  ExportJobResult,
  ExportVaultBackupState,
  VaultSaveResult,
} from '../types.ts';
import {
  getExportFromVault,
  isValidMp4Blob,
  saveExportToVault,
  setVaultBackupError,
  setVaultBackupProgress,
} from './browserMediaVault.ts';

const CHUNK_SIZE_BYTES = 4 * 1024 * 1024; // 4 MiB — safely below Cloud Run 32 MiB HTTP/1 limit

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getRetryDelayMs(res: Response, attempt: number): number {
  const retryAfter = res.headers.get('Retry-After');
  const sec = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(sec) && sec > 0) {
    return Math.min(30_000, Math.ceil(sec) * 1000);
  }
  const steps = [3000, 6000, 12000, 20000, 30000];
  return steps[Math.min(attempt, steps.length - 1)];
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) return parsed.error;
    } catch {
      // plain text / HTML
    }
    if (text.includes('Cookie check') || text.includes('verifyCanSetCookies')) {
      return 'Шлюз предпросмотра вернул HTML-страницу проверки cookie вместо видеофайла. Обновите страницу студии и повторите загрузку.';
    }
    return `HTTP ${res.status}: ${text.slice(0, 180)}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function assertNotCookieCheckOrHtml(res: Response): void {
  if (res.type === 'opaqueredirect') {
    throw new Error(
      'Запрос перенаправлен на проверку авторизации/cookie шлюза предпросмотра. Откройте студию в отдельной вкладке и повторите скачивание.',
    );
  }
  if (res.redirected && res.url.includes('__cookie_check.html')) {
    throw new Error(
      'Шлюз предпросмотра перенаправил скачивание на страницу Cookie check вместо MP4. Обновите страницу или откройте приложение в отдельной вкладке.',
    );
  }
  const ct = (res.headers.get('Content-Type') || '').toLowerCase();
  if (ct.includes('text/html')) {
    throw new Error(
      `Сервер или прокси вернул HTML (${ct}) вместо видеофайла MP4. Загрузка прервана, чтобы не сохранить повреждённый файл.`,
    );
  }
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 5,
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, {
      ...init,
      credentials: 'include',
      cache: 'no-store',
    });

    if (res.status === 429 && attempt < maxRetries) {
      await sleep(getRetryDelayMs(res, attempt));
      continue;
    }

    return res;
  }
  throw new Error('Превышен лимит повторных попыток при HTTP 429.');
}

function triggerBrowserSave(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

export async function fetchExportBlobVerified(params: {
  url: string;
  jobId: string;
  version: 'A' | 'B';
  fileName: string;
  expectedSizeBytes?: number;
  batchStep?: { current: number; total: number };
  onProgress?: (info: DownloadProgressInfo) => void;
}): Promise<{
  blob: Blob;
  source: 'server-range' | 'browser-vault';
  vaultSaveResult?: VaultSaveResult;
}> {
  const { url, jobId, version, fileName, expectedSizeBytes, batchStep, onProgress } = params;

  // 1. Check verified copy in persistent browser vault first
  const cached = await getExportFromVault(jobId, version, expectedSizeBytes);
  if (cached) {
    onProgress?.({
      jobId,
      version,
      downloadedBytes: cached.blob.size,
      totalBytes: cached.blob.size,
      percent: 100,
      source: 'browser-vault',
      batchStep,
    });
    return {
      blob: cached.blob,
      source: 'browser-vault',
      vaultSaveResult: { ok: true, bytesWritten: cached.blob.size },
    };
  }

  // 2. HEAD probe to verify status, MIME type, auth cookies, and exact byte length
  const headRes = await fetchWithRetry(url, { method: 'HEAD' });
  assertNotCookieCheckOrHtml(headRes);

  if (!headRes.ok) {
    const msg = await readErrorMessage(headRes);
    throw new Error(msg);
  }

  const headContentType = (headRes.headers.get('Content-Type') || '').toLowerCase();
  if (
    headContentType &&
    !headContentType.startsWith('video/mp4') &&
    !headContentType.startsWith('application/octet-stream')
  ) {
    throw new Error(`Неожиданный MIME-тип ответа: ${headContentType}. Ожидался video/mp4.`);
  }

  const xFileSize = Number(headRes.headers.get('X-File-Size') || '0');
  const contentLength = Number(headRes.headers.get('Content-Length') || '0');
  const totalBytes =
    (Number.isFinite(xFileSize) && xFileSize > 0 ? xFileSize : 0) ||
    (Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0) ||
    (expectedSizeBytes && expectedSizeBytes > 0 ? expectedSizeBytes : 0);

  if (totalBytes <= 0) {
    throw new Error('Сервер не вернул корректный размер MP4-файла (Content-Length / X-File-Size).');
  }

  // 3. Download sequentially in 4 MiB Range chunks
  const chunks: ArrayBuffer[] = [];
  let offset = 0;

  while (offset < totalBytes) {
    const end = Math.min(offset + CHUNK_SIZE_BYTES - 1, totalBytes - 1);
    const expectedChunkLen = end - offset + 1;

    const chunkRes = await fetchWithRetry(url, {
      method: 'GET',
      headers: {
        Range: `bytes=${offset}-${end}`,
      },
    });

    assertNotCookieCheckOrHtml(chunkRes);

    if (!chunkRes.ok) {
      const msg = await readErrorMessage(chunkRes);
      throw new Error(`Ошибка при загрузке диапазона ${offset}-${end}: ${msg}`);
    }

    const chunkMime = (chunkRes.headers.get('Content-Type') || '').toLowerCase();
    if (
      !chunkMime.startsWith('video/mp4') &&
      !chunkMime.startsWith('application/octet-stream')
    ) {
      throw new Error(`Фрагмент вернул некорректный MIME-тип: ${chunkMime || 'пусто'}.`);
    }

    if (chunkRes.status !== 206 && !(offset === 0 && chunkRes.status === 200)) {
      throw new Error(
        `Сервер вернул HTTP ${chunkRes.status} вместо 206 Partial Content для Range-запроса.`,
      );
    }

    const buf = await chunkRes.arrayBuffer();
    if (chunkRes.status === 206 && buf.byteLength !== expectedChunkLen) {
      throw new Error(
        `Неполный фрагмент данных: получено ${buf.byteLength} байт вместо ${expectedChunkLen}.`,
      );
    }

    chunks.push(buf);
    offset += buf.byteLength;

    onProgress?.({
      jobId,
      version,
      downloadedBytes: offset,
      totalBytes,
      percent: Math.min(100, Math.round((offset / totalBytes) * 100)),
      source: 'server-range',
      batchStep,
    });

    if (chunkRes.status === 200) {
      break;
    }

    if (offset < totalBytes) {
      await sleep(80);
    }
  }

  const blob = new Blob(chunks, { type: 'video/mp4' });
  if (blob.size !== totalBytes) {
    throw new Error(
      `Итоговый размер файла (${blob.size} байт) не совпадает с ожидаемым (${totalBytes} байт). Сохранение отменено.`,
    );
  }

  const validMp4 = await isValidMp4Blob(blob);
  if (!validMp4) {
    throw new Error(
      'Полученный файл не прошёл проверку заголовка MP4 (отсутствует сигнатура ftyp). Сохранение отменено.',
    );
  }

  const vaultSaveResult = await saveExportToVault(jobId, version, fileName, blob);
  return { blob, source: 'server-range', vaultSaveResult };
}

export async function downloadExportFile(params: {
  url: string;
  jobId: string;
  version: 'A' | 'B';
  fileName: string;
  expectedSizeBytes?: number;
  batchStep?: { current: number; total: number };
  onProgress?: (info: DownloadProgressInfo) => void;
}): Promise<{
  source: 'server-range' | 'browser-vault';
  sizeBytes: number;
  vaultSaveResult?: VaultSaveResult;
}> {
  const { blob, source, vaultSaveResult } = await fetchExportBlobVerified(params);
  triggerBrowserSave(blob, params.fileName);
  return { source, sizeBytes: blob.size, vaultSaveResult };
}

export async function downloadBothExportVersions(params: {
  result: ExportJobResult;
  onProgress?: (info: DownloadProgressInfo) => void;
}): Promise<{ vaultWarning: string | null }> {
  const { result, onProgress } = params;
  const warnings: string[] = [];

  const hasB = Boolean(result.versionB);
  const resA = await downloadExportFile({
    url: result.versionA.url,
    jobId: result.jobId,
    version: 'A',
    fileName: result.versionA.fileName,
    expectedSizeBytes: result.versionA.probe.sizeBytes,
    batchStep: hasB ? { current: 1, total: 2 } : undefined,
    onProgress,
  });
  if (resA.vaultSaveResult && !resA.vaultSaveResult.ok && resA.vaultSaveResult.error) {
    warnings.push(resA.vaultSaveResult.error);
  }

  if (result.versionB) {
    // Sequential pause so browser does not block the second download prompt
    await sleep(450);

    const resB = await downloadExportFile({
      url: result.versionB.url,
      jobId: result.jobId,
      version: 'B',
      fileName: result.versionB.fileName,
      expectedSizeBytes: result.versionB.probe.sizeBytes,
      batchStep: { current: 2, total: 2 },
      onProgress,
    });
    if (resB.vaultSaveResult && !resB.vaultSaveResult.ok && resB.vaultSaveResult.error) {
      warnings.push(resB.vaultSaveResult.error);
    }
  }

  return { vaultWarning: warnings.length > 0 ? warnings.join(' ') : null };
}

export async function backupExportResultToVault(
  result: ExportJobResult,
  onStateChange?: (state: ExportVaultBackupState) => void,
): Promise<ExportVaultBackupState> {
  const state: ExportVaultBackupState = {
    jobId: result.jobId,
    status: 'backing-up',
    versionA: 'pending',
    versionB: result.versionB ? 'pending' : 'saved',
  };
  setVaultBackupProgress(`Резервирование готового выпуска ${result.jobId} в IndexedDB…`);
  onStateChange?.({ ...state });

  const errors: string[] = [];

  // Version A
  try {
    const resA = await fetchExportBlobVerified({
      url: result.versionA.url,
      jobId: result.jobId,
      version: 'A',
      fileName: result.versionA.fileName,
      expectedSizeBytes: result.versionA.probe.sizeBytes,
    });
    if (resA.vaultSaveResult?.ok) {
      state.versionA = 'saved';
    } else {
      state.versionA = 'error';
      errors.push(
        resA.vaultSaveResult?.error || 'Не удалось завершить запись Версии А в IndexedDB.',
      );
    }
  } catch (err) {
    state.versionA = 'error';
    errors.push(
      `Версия А: ${err instanceof Error ? err.message : 'ошибка фонового сохранения.'}`,
    );
  }
  onStateChange?.({ ...state, error: errors.join(' ') || undefined });

  // Version B (only if present)
  if (result.versionB) {
    try {
      const resB = await fetchExportBlobVerified({
        url: result.versionB.url,
        jobId: result.jobId,
        version: 'B',
        fileName: result.versionB.fileName,
        expectedSizeBytes: result.versionB.probe.sizeBytes,
      });
      if (resB.vaultSaveResult?.ok) {
        state.versionB = 'saved';
      } else {
        state.versionB = 'error';
        errors.push(
          resB.vaultSaveResult?.error || 'Не удалось завершить запись Версии Б в IndexedDB.',
        );
      }
    } catch (err) {
      state.versionB = 'error';
      errors.push(
        `Версия Б: ${err instanceof Error ? err.message : 'ошибка фонового сохранения.'}`,
      );
    }
  }

  if (state.versionA === 'saved' && state.versionB === 'saved') {
    state.status = 'saved';
  } else if (state.versionA === 'saved' || state.versionB === 'saved') {
    state.status = 'partial';
    state.error = errors.join(' ');
    if (state.error) setVaultBackupError(state.error);
  } else {
    state.status = 'error';
    state.error = errors.join(' ');
    if (state.error) setVaultBackupError(state.error);
  }

  onStateChange?.({ ...state });
  return state;
}
