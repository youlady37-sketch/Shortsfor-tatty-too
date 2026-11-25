import type {
  AdAssetInfo,
  AdAudioAssetInfo,
  AdPreset,
  BrowserVaultDiagnostics,
  SourceLibraryItem,
  SourceRole,
  VaultSaveResult,
} from '../types.ts';

const DB_NAME = 'delo_v_kadre_media_vault_v1';
const DB_VERSION = 3;
const SOURCES_STORE = 'sources';
const LIBRARY_SOURCES_STORE = 'librarySources';
const EXPORTS_STORE = 'exports';
const ADS_STORE = 'ads';
const AD_PRESETS_STORE = 'adPresets';

export interface VaultAdRecord {
  id: string;
  kind?: 'image' | 'audio';
  assetInfo?: AdAssetInfo;
  audioInfo?: AdAudioAssetInfo;
  savedAt: string;
  blob: Blob;
}

export interface VaultAdPresetRecord {
  id: string;
  preset: AdPreset;
  savedAt: string;
}

export interface VaultSourceRecord {
  role: SourceRole;
  originalName: string;
  sizeBytes: number;
  mimeType: string;
  savedAt: string;
  blob: Blob;
}

export interface VaultLibrarySourceRecord {
  id: string;
  originalName: string;
  sizeBytes: number;
  mimeType: string;
  savedAt: string;
  item?: SourceLibraryItem;
  blob: Blob;
}

export interface VaultExportRecord {
  key: string; // `${jobId}:${version}`
  jobId: string;
  version: 'A' | 'B';
  fileName: string;
  sizeBytes: number;
  savedAt: string;
  blob: Blob;
}

let persistenceRequested = false;
let cachedPersistedResult: boolean | null = null;
let lastBackupState: {
  status: 'idle' | 'saving' | 'saved' | 'error';
  message: string | null;
  at: string | null;
} = {
  status: 'idle',
  message: null,
  at: null,
};

function updateLastBackupState(
  status: 'idle' | 'saving' | 'saved' | 'error',
  message: string | null,
): void {
  lastBackupState = {
    status,
    message,
    at: status === 'idle' ? null : new Date().toISOString(),
  };
}

export function setVaultBackupProgress(message: string): void {
  updateLastBackupState('saving', message);
}

export function setVaultBackupError(message: string): void {
  updateLastBackupState('error', message);
}

export function formatBytesRu(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) {
    return '—';
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} КБ`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} ГБ`;
}

export function classifyIndexedDbError(err: unknown, context: string): VaultSaveResult {
  const domName =
    err && typeof err === 'object' && 'name' in err ? String((err as { name?: unknown }).name) : '';
  const domCode =
    err && typeof err === 'object' && 'code' in err ? Number((err as { code?: unknown }).code) : 0;
  const rawMessage =
    err instanceof Error
      ? err.message
      : err && typeof err === 'object' && 'message' in err
        ? String((err as { message?: unknown }).message)
        : String(err ?? 'Неизвестная ошибка IndexedDB');

  const isQuota =
    domName === 'QuotaExceededError' ||
    domCode === 22 ||
    domCode === 1014 ||
    /quota|exceeded|space|disk/i.test(rawMessage);

  if (isQuota) {
    return {
      ok: false,
      quotaExceeded: true,
      error: `${context}: недостаточно свободного места / квоты IndexedDB (QuotaExceededError). Удалите ненужные данные сайтов в браузере или скачайте файлы на диск.`,
    };
  }

  if (domName === 'AbortError' || /abort/i.test(rawMessage)) {
    return {
      ok: false,
      error: `${context}: транзакция записи в IndexedDB прервана (tx.onabort${rawMessage ? `: ${rawMessage}` : ''}).`,
    };
  }

  if (domName === 'SecurityError' || /security|denied|private/i.test(rawMessage)) {
    return {
      ok: false,
      error: `${context}: браузер запретил доступ к IndexedDB (${rawMessage}).`,
    };
  }

  return {
    ok: false,
    error: `${context}: ошибка записи в IndexedDB (${domName ? `${domName}: ` : ''}${rawMessage}).`,
  };
}

export async function ensurePersistentStorage(): Promise<boolean | null> {
  if (typeof navigator === 'undefined' || !navigator.storage) {
    return null;
  }
  try {
    if (!persistenceRequested && typeof navigator.storage.persist === 'function') {
      persistenceRequested = true;
      cachedPersistedResult = await navigator.storage.persist();
      return cachedPersistedResult;
    }
    if (typeof navigator.storage.persisted === 'function') {
      cachedPersistedResult = await navigator.storage.persisted();
      return cachedPersistedResult;
    }
  } catch {
    return cachedPersistedResult;
  }
  return cachedPersistedResult;
}

export async function checkQuotaBeforeWrite(requiredBytes: number): Promise<VaultSaveResult> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return { ok: true };
  }
  try {
    const estimate = await navigator.storage.estimate();
    const quota = typeof estimate.quota === 'number' ? estimate.quota : null;
    const usage = typeof estimate.usage === 'number' ? estimate.usage : 0;
    if (quota !== null && quota > 0) {
      const remaining = Math.max(0, quota - usage);
      if (remaining < requiredBytes) {
        return {
          ok: false,
          quotaExceeded: true,
          error: `Недостаточно квоты IndexedDB: требуется ${formatBytesRu(requiredBytes)}, доступно ${formatBytesRu(remaining)} (из ${formatBytesRu(quota)}).`,
        };
      }
    }
    return { ok: true };
  } catch {
    // If estimate() fails transiently, let IndexedDB transaction determine writability
    return { ok: true };
  }
}

export async function getBrowserVaultDiagnostics(): Promise<BrowserVaultDiagnostics> {
  const supported = typeof indexedDB !== 'undefined';
  const persisted = await ensurePersistentStorage();

  let quotaBytes: number | null = null;
  let usageBytes: number | null = null;
  let indexedDbUsageBytes: number | null = null;

  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      quotaBytes = typeof est.quota === 'number' ? est.quota : null;
      usageBytes = typeof est.usage === 'number' ? est.usage : null;
      const details = (est as StorageEstimate & { usageDetails?: Record<string, number> })
        .usageDetails;
      if (details && typeof details.indexedDB === 'number') {
        indexedDbUsageBytes = details.indexedDB;
      }
    }
  } catch {
    // ignore estimate failure
  }

  return {
    supported,
    persisted,
    quotaBytes,
    usageBytes,
    indexedDbUsageBytes,
    lastBackupStatus: lastBackupState.status,
    lastBackupMessage: lastBackupState.message,
    lastBackupAt: lastBackupState.at,
  };
}

function openVaultDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB недоступен в текущем браузере.'));
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SOURCES_STORE)) {
        db.createObjectStore(SOURCES_STORE, { keyPath: 'role' });
      }
      if (!db.objectStoreNames.contains(LIBRARY_SOURCES_STORE)) {
        db.createObjectStore(LIBRARY_SOURCES_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(EXPORTS_STORE)) {
        db.createObjectStore(EXPORTS_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(ADS_STORE)) {
        db.createObjectStore(ADS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(AD_PRESETS_STORE)) {
        db.createObjectStore(AD_PRESETS_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error('Не удалось открыть локальное хранилище IndexedDB.'));
    req.onblocked = () =>
      reject(new Error('База IndexedDB заблокирована другой открытой вкладкой.'));
  });
}

function commitPutTransaction(
  db: IDBDatabase,
  storeName: string,
  record: VaultSourceRecord | VaultLibrarySourceRecord | VaultExportRecord | VaultAdRecord,
  context: string,
): Promise<VaultSaveResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (res: VaultSaveResult) => {
      if (settled) return;
      settled = true;
      resolve(res);
    };

    try {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const putReq = store.put(record);

      putReq.onerror = () => {
        // Wait for tx.onabort/tx.onerror if needed, or resolve with classified error
        const err = putReq.error ?? tx.error;
        finish(classifyIndexedDbError(err, context));
      };

      tx.oncomplete = () => {
        finish({
          ok: true,
          bytesWritten: record.blob.size,
        });
      };

      tx.onerror = () => {
        const err = tx.error ?? putReq.error;
        finish(classifyIndexedDbError(err, context));
      };

      tx.onabort = () => {
        const err = tx.error ?? putReq.error ?? new DOMException('Транзакция отменена', 'AbortError');
        finish(classifyIndexedDbError(err, context));
      };
    } catch (err) {
      finish(classifyIndexedDbError(err, context));
    }
  });
}

export async function isValidMp4Blob(blob: Blob): Promise<boolean> {
  if (!blob || blob.size < 16) return false;
  try {
    const headerBuf = await blob.slice(0, 16).arrayBuffer();
    const bytes = new Uint8Array(headerBuf);
    const boxType = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    return boxType === 'ftyp';
  } catch {
    return false;
  }
}

export async function saveSourceToVault(
  role: SourceRole,
  file: File | Blob,
  originalName: string,
): Promise<VaultSaveResult> {
  const context = `Резервирование исходника «${originalName}»`;
  if (!file || file.size <= 0) {
    const errRes: VaultSaveResult = { ok: false, error: `${context}: файл пуст.` };
    updateLastBackupState('error', errRes.error ?? null);
    return errRes;
  }

  updateLastBackupState('saving', `Сохранение «${originalName}» (${formatBytesRu(file.size)}) в IndexedDB…`);
  await ensurePersistentStorage();

  const quotaCheck = await checkQuotaBeforeWrite(file.size);
  if (!quotaCheck.ok) {
    updateLastBackupState('error', quotaCheck.error ?? 'Недостаточно места в IndexedDB.');
    return quotaCheck;
  }

  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    const record: VaultSourceRecord = {
      role,
      originalName,
      sizeBytes: file.size,
      mimeType: file.type || 'application/octet-stream',
      savedAt: new Date().toISOString(),
      blob: file,
    };

    const writeResult = await commitPutTransaction(db, SOURCES_STORE, record, context);
    if (writeResult.ok) {
      updateLastBackupState(
        'saved',
        `Исходник «${originalName}» (${formatBytesRu(file.size)}) полностью записан в IndexedDB.`,
      );
    } else {
      updateLastBackupState('error', writeResult.error ?? 'Ошибка записи в IndexedDB.');
    }
    return writeResult;
  } catch (err) {
    const classified = classifyIndexedDbError(err, context);
    updateLastBackupState('error', classified.error ?? 'Ошибка IndexedDB.');
    return classified;
  } finally {
    db?.close();
  }
}

export async function getSourceFromVault(role: SourceRole): Promise<VaultSourceRecord | null> {
  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    const record = await new Promise<VaultSourceRecord | null>((resolve, reject) => {
      const tx = db!.transaction(SOURCES_STORE, 'readonly');
      const req = tx.objectStore(SOURCES_STORE).get(role);
      req.onsuccess = () => resolve((req.result as VaultSourceRecord | undefined) ?? null);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error ?? new Error('Транзакция чтения прервана'));
    });
    if (!record || !record.blob || record.blob.size <= 0) return null;
    return record;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export async function deleteSourceFromVault(role: SourceRole): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(SOURCES_STORE, 'readwrite');
      tx.objectStore(SOURCES_STORE).delete(role);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    // ignore deletion failure
  } finally {
    db?.close();
  }
}

export async function listSourcesInVault(): Promise<
  Record<string, { originalName: string; sizeBytes: number; savedAt: string }>
> {
  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    const all = await new Promise<VaultSourceRecord[]>((resolve, reject) => {
      const tx = db!.transaction(SOURCES_STORE, 'readonly');
      const req = tx.objectStore(SOURCES_STORE).getAll();
      req.onsuccess = () => resolve((req.result as VaultSourceRecord[]) ?? []);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error);
    });
    const map: Record<string, { originalName: string; sizeBytes: number; savedAt: string }> = {};
    for (const item of all) {
      if (item.blob && item.blob.size > 0) {
        map[item.role] = {
          originalName: item.originalName,
          sizeBytes: item.blob.size,
          savedAt: item.savedAt,
        };
      }
    }
    return map;
  } catch {
    return {};
  } finally {
    db?.close();
  }
}

export async function saveLibrarySourceToVault(
  item: SourceLibraryItem,
  file: File | Blob,
): Promise<VaultSaveResult> {
  const context = `Резервирование видео «${item.originalName}»`;
  if (!file || file.size <= 0) {
    return { ok: false, error: `${context}: файл пуст.` };
  }
  await ensurePersistentStorage();
  const quotaCheck = await checkQuotaBeforeWrite(file.size);
  if (!quotaCheck.ok) {
    return quotaCheck;
  }

  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    const record: VaultLibrarySourceRecord = {
      id: item.id,
      originalName: item.originalName,
      sizeBytes: file.size,
      mimeType: file.type || item.mimeType || 'video/mp4',
      savedAt: new Date().toISOString(),
      item,
      blob: file,
    };
    return await commitPutTransaction(db, LIBRARY_SOURCES_STORE, record, context);
  } catch (err) {
    return classifyIndexedDbError(err, context);
  } finally {
    db?.close();
  }
}

export async function getLibrarySourceFromVault(
  id: string,
): Promise<VaultLibrarySourceRecord | null> {
  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    if (!db.objectStoreNames.contains(LIBRARY_SOURCES_STORE)) return null;
    const rec = await new Promise<VaultLibrarySourceRecord | null>((resolve, reject) => {
      const tx = db!.transaction(LIBRARY_SOURCES_STORE, 'readonly');
      const req = tx.objectStore(LIBRARY_SOURCES_STORE).get(id);
      req.onsuccess = () => resolve((req.result as VaultLibrarySourceRecord | undefined) ?? null);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error);
    });
    if (!rec || !rec.blob || rec.blob.size <= 0) return null;
    return rec;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export async function deleteLibrarySourceFromVault(id: string): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    if (!db.objectStoreNames.contains(LIBRARY_SOURCES_STORE)) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(LIBRARY_SOURCES_STORE, 'readwrite');
      tx.objectStore(LIBRARY_SOURCES_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    // ignore deletion failure
  } finally {
    db?.close();
  }
}

export async function listLibrarySourcesInVault(): Promise<
  Record<string, { originalName: string; sizeBytes: number; savedAt: string }>
> {
  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    if (!db.objectStoreNames.contains(LIBRARY_SOURCES_STORE)) return {};
    const all = await new Promise<VaultLibrarySourceRecord[]>((resolve, reject) => {
      const tx = db!.transaction(LIBRARY_SOURCES_STORE, 'readonly');
      const req = tx.objectStore(LIBRARY_SOURCES_STORE).getAll();
      req.onsuccess = () => resolve((req.result as VaultLibrarySourceRecord[]) ?? []);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error);
    });
    const map: Record<string, { originalName: string; sizeBytes: number; savedAt: string }> = {};
    for (const rec of all) {
      if (rec.blob && rec.blob.size > 0) {
        map[rec.id] = {
          originalName: rec.originalName,
          sizeBytes: rec.blob.size,
          savedAt: rec.savedAt,
        };
      }
    }
    return map;
  } catch {
    return {};
  } finally {
    db?.close();
  }
}

export async function saveExportToVault(
  jobId: string,
  version: 'A' | 'B',
  fileName: string,
  blob: Blob,
): Promise<VaultSaveResult> {
  const context = `Резервирование Версии ${version === 'A' ? 'А' : 'Б'} (${fileName})`;
  if (!blob || blob.size <= 0) {
    const errRes: VaultSaveResult = { ok: false, error: `${context}: получен пустой файл.` };
    updateLastBackupState('error', errRes.error ?? null);
    return errRes;
  }

  const valid = await isValidMp4Blob(blob);
  if (!valid) {
    const errRes: VaultSaveResult = {
      ok: false,
      error: `${context}: файл не является корректным MP4 (отсутствует заголовок ftyp).`,
    };
    updateLastBackupState('error', errRes.error ?? null);
    return errRes;
  }

  updateLastBackupState(
    'saving',
    `Запись Версии ${version === 'A' ? 'А' : 'Б'} (${formatBytesRu(blob.size)}) в IndexedDB…`,
  );
  await ensurePersistentStorage();

  const quotaCheck = await checkQuotaBeforeWrite(blob.size);
  if (!quotaCheck.ok) {
    updateLastBackupState('error', quotaCheck.error ?? 'Недостаточно квоты IndexedDB.');
    return quotaCheck;
  }

  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    const record: VaultExportRecord = {
      key: `${jobId}:${version}`,
      jobId,
      version,
      fileName,
      sizeBytes: blob.size,
      savedAt: new Date().toISOString(),
      blob,
    };

    const writeResult = await commitPutTransaction(db, EXPORTS_STORE, record, context);
    if (writeResult.ok) {
      updateLastBackupState(
        'saved',
        `Версия ${version === 'A' ? 'А' : 'Б'} (${formatBytesRu(blob.size)}) полностью сохранена в IndexedDB.`,
      );
    } else {
      updateLastBackupState('error', writeResult.error ?? 'Ошибка записи в IndexedDB.');
    }
    return writeResult;
  } catch (err) {
    const classified = classifyIndexedDbError(err, context);
    updateLastBackupState('error', classified.error ?? 'Ошибка записи в IndexedDB.');
    return classified;
  } finally {
    db?.close();
  }
}

export async function getExportFromVault(
  jobId: string,
  version: 'A' | 'B',
  expectedSizeBytes?: number,
): Promise<VaultExportRecord | null> {
  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    const record = await new Promise<VaultExportRecord | null>((resolve, reject) => {
      const tx = db!.transaction(EXPORTS_STORE, 'readonly');
      const req = tx.objectStore(EXPORTS_STORE).get(`${jobId}:${version}`);
      req.onsuccess = () => resolve((req.result as VaultExportRecord | undefined) ?? null);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error);
    });
    if (!record || !record.blob) return null;
    if (expectedSizeBytes && expectedSizeBytes > 0 && record.blob.size !== expectedSizeBytes) {
      return null;
    }
    const validMp4 = await isValidMp4Blob(record.blob);
    if (!validMp4) return null;
    return record;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export async function listExportsInVault(): Promise<
  Record<string, { jobId: string; version: 'A' | 'B'; fileName: string; sizeBytes: number; savedAt: string }>
> {
  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    const all = await new Promise<VaultExportRecord[]>((resolve, reject) => {
      const tx = db!.transaction(EXPORTS_STORE, 'readonly');
      const req = tx.objectStore(EXPORTS_STORE).getAll();
      req.onsuccess = () => resolve((req.result as VaultExportRecord[]) ?? []);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error);
    });
    const map: Record<
      string,
      { jobId: string; version: 'A' | 'B'; fileName: string; sizeBytes: number; savedAt: string }
    > = {};
    for (const item of all) {
      if (item.blob && item.blob.size > 0) {
        map[item.key] = {
          jobId: item.jobId,
          version: item.version,
          fileName: item.fileName,
          sizeBytes: item.blob.size,
          savedAt: item.savedAt,
        };
      }
    }
    return map;
  } catch {
    return {};
  } finally {
    db?.close();
  }
}

export async function saveAdAssetToVault(
  assetInfo: AdAssetInfo,
  file: Blob,
): Promise<VaultSaveResult> {
  const context = `Резервирование рекламного файла «${assetInfo.originalName}»`;
  if (!file || file.size <= 0) {
    return { ok: false, error: `${context}: файл пуст.` };
  }
  await ensurePersistentStorage();
  const quotaCheck = await checkQuotaBeforeWrite(file.size);
  if (!quotaCheck.ok) {
    return quotaCheck;
  }

  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    const record: VaultAdRecord = {
      id: assetInfo.id,
      assetInfo,
      savedAt: new Date().toISOString(),
      blob: file,
    };
    return await commitPutTransaction(db, ADS_STORE, record, context);
  } catch (err) {
    return classifyIndexedDbError(err, context);
  } finally {
    db?.close();
  }
}

export async function getAdAssetFromVault(assetId: string): Promise<VaultAdRecord | null> {
  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    const rec = await new Promise<VaultAdRecord | null>((resolve, reject) => {
      const tx = db!.transaction(ADS_STORE, 'readonly');
      const req = tx.objectStore(ADS_STORE).get(assetId);
      req.onsuccess = () => resolve((req.result as VaultAdRecord | undefined) ?? null);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error);
    });
    if (!rec || !rec.blob || rec.blob.size <= 0) return null;
    return rec;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export async function listAdAssetsInVault(): Promise<VaultAdRecord[]> {
  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    const all = await new Promise<VaultAdRecord[]>((resolve, reject) => {
      const tx = db!.transaction(ADS_STORE, 'readonly');
      const req = tx.objectStore(ADS_STORE).getAll();
      req.onsuccess = () => resolve((req.result as VaultAdRecord[]) ?? []);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error);
    });
    return all.filter((r) => r.blob && r.blob.size > 0 && r.kind !== 'audio' && Boolean(r.assetInfo));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

export async function saveAdAudioToVault(
  audioInfo: AdAudioAssetInfo,
  file: Blob,
): Promise<VaultSaveResult> {
  const context = `Резервирование рекламного аудио «${audioInfo.originalName}»`;
  if (!file || file.size <= 0) {
    return { ok: false, error: `${context}: файл пуст.` };
  }
  await ensurePersistentStorage();
  const quotaCheck = await checkQuotaBeforeWrite(file.size);
  if (!quotaCheck.ok) {
    return quotaCheck;
  }

  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    const record: VaultAdRecord = {
      id: audioInfo.id,
      kind: 'audio',
      audioInfo,
      savedAt: new Date().toISOString(),
      blob: file,
    };
    return await commitPutTransaction(db, ADS_STORE, record, context);
  } catch (err) {
    return classifyIndexedDbError(err, context);
  } finally {
    db?.close();
  }
}

export async function listAdAudioInVault(): Promise<VaultAdRecord[]> {
  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    const all = await new Promise<VaultAdRecord[]>((resolve, reject) => {
      const tx = db!.transaction(ADS_STORE, 'readonly');
      const req = tx.objectStore(ADS_STORE).getAll();
      req.onsuccess = () => resolve((req.result as VaultAdRecord[]) ?? []);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error);
    });
    return all.filter((r) => r.blob && r.blob.size > 0 && r.kind === 'audio' && Boolean(r.audioInfo));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

export async function deleteAdAssetFromVault(assetId: string): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(ADS_STORE, 'readwrite');
      tx.objectStore(ADS_STORE).delete(assetId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    // ignore
  } finally {
    db?.close();
  }
}

export async function saveAdPresetToVault(preset: AdPreset): Promise<VaultSaveResult> {
  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    const record: VaultAdPresetRecord = {
      id: preset.id,
      preset,
      savedAt: new Date().toISOString(),
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(AD_PRESETS_STORE, 'readwrite');
      tx.objectStore(AD_PRESETS_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return { ok: true };
  } catch (err) {
    return classifyIndexedDbError(err, `Сохранение пресета «${preset.name}»`);
  } finally {
    db?.close();
  }
}

export async function deleteAdPresetFromVault(presetId: string): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(AD_PRESETS_STORE, 'readwrite');
      tx.objectStore(AD_PRESETS_STORE).delete(presetId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    // ignore
  } finally {
    db?.close();
  }
}

export async function listAdPresetsInVault(): Promise<AdPreset[]> {
  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    const all = await new Promise<VaultAdPresetRecord[]>((resolve, reject) => {
      if (!db!.objectStoreNames.contains(AD_PRESETS_STORE)) {
        resolve([]);
        return;
      }
      const tx = db!.transaction(AD_PRESETS_STORE, 'readonly');
      const req = tx.objectStore(AD_PRESETS_STORE).getAll();
      req.onsuccess = () => resolve((req.result as VaultAdPresetRecord[]) ?? []);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error);
    });
    return all.map((r) => r.preset).filter(Boolean);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

export async function syncAdPresetsVault(presets: AdPreset[]): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    if (!db.objectStoreNames.contains(AD_PRESETS_STORE)) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(AD_PRESETS_STORE, 'readwrite');
      const store = tx.objectStore(AD_PRESETS_STORE);
      store.clear();
      for (const preset of presets) {
        store.put({
          id: preset.id,
          preset,
          savedAt: new Date().toISOString(),
        } satisfies VaultAdPresetRecord);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    // ignore sync failure
  } finally {
    db?.close();
  }
}

export async function inspectIndexedDbVaultSummary(): Promise<{
  sourcesCount: number;
  exportsCount: number;
  adsCount: number;
  presetsCount: number;
  totalBytes: number;
}> {
  let db: IDBDatabase | null = null;
  try {
    db = await openVaultDb();
    const readStore = <T,>(storeName: string): Promise<T[]> =>
      new Promise((resolve, reject) => {
        if (!db!.objectStoreNames.contains(storeName)) {
          resolve([]);
          return;
        }
        const tx = db!.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve((req.result as T[]) ?? []);
        req.onerror = () => reject(req.error);
      });

    const [sources, libSources, exportsList, ads, presets] = await Promise.all([
      readStore<VaultSourceRecord>(SOURCES_STORE),
      readStore<VaultLibrarySourceRecord>(LIBRARY_SOURCES_STORE),
      readStore<VaultExportRecord>(EXPORTS_STORE),
      readStore<VaultAdRecord>(ADS_STORE),
      readStore<VaultAdPresetRecord>(AD_PRESETS_STORE),
    ]);

    const totalBytes =
      sources.reduce((a, s) => a + (s.blob?.size ?? 0), 0) +
      libSources.reduce((a, s) => a + (s.blob?.size ?? 0), 0) +
      exportsList.reduce((a, e) => a + (e.blob?.size ?? 0), 0) +
      ads.reduce((a, ad) => a + (ad.blob?.size ?? 0), 0);

    return {
      sourcesCount: sources.length + libSources.length,
      exportsCount: exportsList.length,
      adsCount: ads.length,
      presetsCount: presets.length,
      totalBytes,
    };
  } catch {
    return {
      sourcesCount: 0,
      exportsCount: 0,
      adsCount: 0,
      presetsCount: 0,
      totalBytes: 0,
    };
  } finally {
    db?.close();
  }
}

export async function clearAllVaultMediaStores(options?: {
  preserveAdPresets?: boolean;
}): Promise<{
  clearedStores: string[];
  preservedStores: string[];
  errors: string[];
}> {
  const preserveAdPresets = options?.preserveAdPresets !== false;
  let db: IDBDatabase | null = null;
  const clearedStores: string[] = [];
  const preservedStores: string[] = [];
  const errors: string[] = [];
  const storeNames = [SOURCES_STORE, LIBRARY_SOURCES_STORE, EXPORTS_STORE, ADS_STORE];
  if (!preserveAdPresets) {
    storeNames.push(AD_PRESETS_STORE);
  } else {
    preservedStores.push(AD_PRESETS_STORE);
  }

  try {
    db = await openVaultDb();
    for (const storeName of storeNames) {
      if (!db.objectStoreNames.contains(storeName)) continue;
      await new Promise<void>((resolve, reject) => {
        const tx = db!.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error(`Ошибка очистки ${storeName}`));
        tx.onabort = () => reject(tx.error ?? new Error(`Транзакция очистки ${storeName} прервана`));
      });
      clearedStores.push(storeName);
    }
    updateLastBackupState('idle', null);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'Ошибка очистки IndexedDB');
  } finally {
    db?.close();
  }
  return { clearedStores, preservedStores, errors };
}

