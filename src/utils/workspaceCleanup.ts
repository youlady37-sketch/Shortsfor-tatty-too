import {
  APP_TECHNICAL_SETTINGS_KEY,
  WORKSPACE_LOCAL_STORAGE_PREFIX,
  isProtectedBrowserKey,
} from '../shared/protectedAssets.ts';
import type {
  CleanupBrowserPlan,
  CleanupTargetItem,
  CleanupVerificationItem,
} from '../types.ts';
import {
  clearAllVaultMediaStores,
  inspectIndexedDbVaultSummary,
} from './browserMediaVault.ts';

export interface BrowserCleanupExecutionReport {
  success: boolean;
  deletedItems: string[];
  remainingItems: string[];
  preservedItems: string[];
  errors: string[];
  verification: CleanupVerificationItem[];
}

export function isWorkspaceCacheName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes('delo') ||
    lower.includes('shorts') ||
    lower.includes('export') ||
    lower.includes('media') ||
    lower.includes('ad-preview')
  );
}

export function isWorkspaceOpfsEntry(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes('delo') ||
    lower.includes('shorts') ||
    lower.includes('export') ||
    lower.includes('media') ||
    lower.includes('ad-preview') ||
    lower.includes('ad_preview') ||
    lower.includes('workspace') ||
    lower.includes('segment') ||
    lower.startsWith('tmp_')
  );
}

function isWorkspaceStorageKey(key: string): boolean {
  if (isProtectedBrowserKey(key)) return false;
  return key.startsWith(WORKSPACE_LOCAL_STORAGE_PREFIX);
}

async function measureDirectoryBytes(dirHandle: FileSystemDirectoryHandle): Promise<number> {
  let total = 0;
  for await (const [, child] of dirHandle.entries()) {
    if (child.kind === 'file') {
      try {
        const f = await (child as FileSystemFileHandle).getFile();
        total += f.size;
      } catch {
        // ignore
      }
    } else if (child.kind === 'directory') {
      total += await measureDirectoryBytes(child as FileSystemDirectoryHandle);
    }
  }
  return total;
}

async function listOpfsWorkspaceEntries(): Promise<
  Array<{ name: string; kind: string; sizeBytes: number; isWorkspace: boolean }>
> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
    return [];
  }
  try {
    const root = await navigator.storage.getDirectory();
    const items: Array<{ name: string; kind: string; sizeBytes: number; isWorkspace: boolean }> = [];
    for await (const [name, handle] of root.entries()) {
      let sizeBytes = 0;
      if (handle.kind === 'file') {
        try {
          const file = await (handle as FileSystemFileHandle).getFile();
          sizeBytes = file.size;
        } catch {
          // ignore
        }
      } else if (handle.kind === 'directory') {
        try {
          sizeBytes = await measureDirectoryBytes(handle as FileSystemDirectoryHandle);
        } catch {
          // ignore
        }
      }
      items.push({
        name,
        kind: handle.kind,
        sizeBytes,
        isWorkspace: isWorkspaceOpfsEntry(name),
      });
    }
    return items;
  } catch {
    return [];
  }
}

export async function buildBrowserCleanupPlan(options?: {
  preserveAdPresets?: boolean;
}): Promise<CleanupBrowserPlan> {
  const preserveAdPresets = options?.preserveAdPresets !== false;
  const idb = await inspectIndexedDbVaultSummary();
  const allOpfsEntries = await listOpfsWorkspaceEntries();
  const opfsWorkspaceEntries = allOpfsEntries.filter((e) => e.isWorkspace);
  const targets: CleanupTargetItem[] = [];
  const preservedKeys: string[] = [];

  if (
    idb.sourcesCount > 0 ||
    idb.exportsCount > 0 ||
    idb.adsCount > 0 ||
    (!preserveAdPresets && idb.presetsCount > 0)
  ) {
    targets.push({
      category: 'browser-idb',
      label: `IndexedDB (исходников: ${idb.sourcesCount}, экспортов: ${idb.exportsCount}, рекламных файлов: ${idb.adsCount}${!preserveAdPresets ? `, пресетов: ${idb.presetsCount}` : ''})`,
      pathOrKey: 'indexeddb:delo_v_kadre_media_vault_v1',
      sizeBytes: idb.totalBytes,
    });
  }

  if (preserveAdPresets) {
    preservedKeys.push(`indexeddb:adPresets (пресетов: ${idb.presetsCount})`);
  }

  let opfsBytes = 0;
  for (const entry of opfsWorkspaceEntries) {
    opfsBytes += entry.sizeBytes;
    targets.push({
      category: 'browser-opfs',
      label: `OPFS: ${entry.name}`,
      pathOrKey: `opfs:${entry.name}`,
      sizeBytes: entry.sizeBytes,
    });
  }
  for (const extEntry of allOpfsEntries.filter((e) => !e.isWorkspace)) {
    preservedKeys.push(`opfs(external):${extEntry.name}`);
  }

  let cacheEntriesCount = 0;
  if (typeof caches !== 'undefined') {
    try {
      const keys = await caches.keys();
      for (const cacheKey of keys) {
        if (isWorkspaceCacheName(cacheKey)) {
          cacheEntriesCount += 1;
          targets.push({
            category: 'browser-cache',
            label: `Cache Storage: ${cacheKey}`,
            pathOrKey: `cache:${cacheKey}`,
            sizeBytes: 0,
          });
        } else {
          preservedKeys.push(`cache(external):${cacheKey}`);
        }
      }
    } catch {
      // ignore cache API restriction
    }
  }

  let storageKeysCount = 0;
  if (typeof window !== 'undefined') {
    try {
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        if (!key) continue;
        if (key === APP_TECHNICAL_SETTINGS_KEY) {
          preservedKeys.push(`localStorage:${key}`);
        } else if (isWorkspaceStorageKey(key)) {
          storageKeysCount += 1;
          targets.push({
            category: 'browser-storage',
            label: `localStorage: ${key}`,
            pathOrKey: `localStorage:${key}`,
            sizeBytes: (window.localStorage.getItem(key) ?? '').length * 2,
          });
        }
      }
      for (let i = 0; i < window.sessionStorage.length; i += 1) {
        const key = window.sessionStorage.key(i);
        if (!key) continue;
        if (isWorkspaceStorageKey(key)) {
          storageKeysCount += 1;
          targets.push({
            category: 'browser-storage',
            label: `sessionStorage: ${key}`,
            pathOrKey: `sessionStorage:${key}`,
            sizeBytes: (window.sessionStorage.getItem(key) ?? '').length * 2,
          });
        }
      }
    } catch {
      // ignore storage read error
    }
  }

  return {
    preserveAdPresets,
    idbSourcesCount: idb.sourcesCount,
    idbExportsCount: idb.exportsCount,
    idbAdsCount: idb.adsCount,
    idbPresetsCount: idb.presetsCount,
    opfsFilesCount: opfsWorkspaceEntries.length,
    cacheEntriesCount,
    storageKeysCount,
    totalBrowserBytes: idb.totalBytes + opfsBytes,
    targets,
    preservedKeys,
  };
}

export async function executeBrowserWorkspaceCleanup(options?: {
  preserveAdPresets?: boolean;
}): Promise<BrowserCleanupExecutionReport> {
  const preserveAdPresets = options?.preserveAdPresets !== false;
  const deletedItems: string[] = [];
  const remainingItems: string[] = [];
  const preservedItems: string[] = [];
  const errors: string[] = [];
  const verification: CleanupVerificationItem[] = [];

  // 1. IndexedDB media stores (always clear sources, exports, temporary ad assets & audio; preserve/clear adPresets by user choice)
  const idbRes = await clearAllVaultMediaStores({ preserveAdPresets });
  for (const s of idbRes.clearedStores) {
    deletedItems.push(`indexeddb:${s}`);
  }
  for (const s of idbRes.preservedStores) {
    preservedItems.push(`indexeddb:${s}`);
  }
  errors.push(...idbRes.errors);

  const postIdb = await inspectIndexedDbVaultSummary();
  const idbTempCleared =
    postIdb.sourcesCount === 0 &&
    postIdb.exportsCount === 0 &&
    postIdb.adsCount === 0 &&
    (preserveAdPresets || postIdb.presetsCount === 0);
  if (!idbTempCleared) {
    remainingItems.push('indexeddb:delo_v_kadre_media_vault_v1');
  }
  verification.push({
    id: 'verify-idb',
    label: 'IndexedDB хранилище выпусков, исходников и временной рекламы',
    pathOrKey: 'indexeddb:delo_v_kadre_media_vault_v1',
    ok: idbTempCleared,
    detail: idbTempCleared
      ? preserveAdPresets
        ? `Очищено (пресетов сохранено: ${postIdb.presetsCount})`
        : 'Полностью очищено (0 записей, включая пресеты)'
      : `Остались записи (исходники: ${postIdb.sourcesCount}, экспорты: ${postIdb.exportsCount}, реклама: ${postIdb.adsCount}, пресеты: ${postIdb.presetsCount})`,
  });

  // 2. OPFS workspace files (delete only workspace entries, preserve non-workspace entries)
  if (typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function') {
    try {
      const root = await navigator.storage.getDirectory();
      const opfsItems = await listOpfsWorkspaceEntries();
      for (const entry of opfsItems) {
        if (!entry.isWorkspace) {
          preservedItems.push(`opfs:${entry.name}`);
          continue;
        }
        try {
          await root.removeEntry(entry.name, { recursive: true });
          deletedItems.push(`opfs:${entry.name}`);
        } catch (err) {
          errors.push(`OPFS (${entry.name}): ${err instanceof Error ? err.message : 'ошибка удаления'}`);
          remainingItems.push(`opfs:${entry.name}`);
        }
      }
      const postOpfsWorkspace = (await listOpfsWorkspaceEntries()).filter((e) => e.isWorkspace);
      verification.push({
        id: 'verify-opfs',
        label: 'OPFS (рабочие файлы приложения)',
        pathOrKey: 'opfs:workspace',
        ok: postOpfsWorkspace.length === 0,
        detail:
          postOpfsWorkspace.length === 0
            ? 'Рабочие файлы в OPFS очищены (0)'
            : `Осталось рабочих записей в OPFS: ${postOpfsWorkspace.length}`,
      });
    } catch {
      verification.push({
        id: 'verify-opfs',
        label: 'OPFS (рабочие файлы приложения)',
        pathOrKey: 'opfs:workspace',
        ok: true,
        detail: 'Файлы рабочего пространства в OPFS отсутствуют',
      });
    }
  }

  // 3. Cache Storage (workspace caches only, preserve external caches)
  if (typeof caches !== 'undefined') {
    try {
      const cacheNames = await caches.keys();
      for (const name of cacheNames) {
        if (!isWorkspaceCacheName(name)) {
          preservedItems.push(`cache:${name}`);
          continue;
        }
        const removed = await caches.delete(name);
        if (removed) {
          deletedItems.push(`cache:${name}`);
        } else {
          remainingItems.push(`cache:${name}`);
        }
      }
      const afterCaches = (await caches.keys()).filter(isWorkspaceCacheName);
      verification.push({
        id: 'verify-caches',
        label: 'Cache Storage (временные кэши релиза)',
        pathOrKey: 'caches',
        ok: afterCaches.length === 0,
        detail:
          afterCaches.length === 0
            ? 'Кэши выпуска отсутствуют'
            : `Не удалены кэши: ${afterCaches.join(', ')}`,
      });
    } catch {
      // ignore if caches unavailable
    }
  }

  // 4. localStorage & sessionStorage workspace keys (preserve APP_TECHNICAL_SETTINGS_KEY and external keys)
  if (typeof window !== 'undefined') {
    try {
      const lsKeysToDelete: string[] = [];
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const k = window.localStorage.key(i);
        if (k && isWorkspaceStorageKey(k)) {
          lsKeysToDelete.push(k);
        } else if (k === APP_TECHNICAL_SETTINGS_KEY) {
          preservedItems.push(`localStorage:${k}`);
        }
      }
      for (const k of lsKeysToDelete) {
        window.localStorage.removeItem(k);
        deletedItems.push(`localStorage:${k}`);
      }

      const ssKeysToDelete: string[] = [];
      for (let i = 0; i < window.sessionStorage.length; i += 1) {
        const k = window.sessionStorage.key(i);
        if (k && isWorkspaceStorageKey(k)) {
          ssKeysToDelete.push(k);
        }
      }
      for (const k of ssKeysToDelete) {
        window.sessionStorage.removeItem(k);
        deletedItems.push(`sessionStorage:${k}`);
      }

      const remainingKeys: string[] = [];
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const k = window.localStorage.key(i);
        if (k && isWorkspaceStorageKey(k)) remainingKeys.push(k);
      }
      for (let i = 0; i < window.sessionStorage.length; i += 1) {
        const k = window.sessionStorage.key(i);
        if (k && isWorkspaceStorageKey(k)) remainingKeys.push(k);
      }
      remainingItems.push(...remainingKeys);
      verification.push({
        id: 'verify-web-storage',
        label: 'localStorage / sessionStorage рабочего пространства',
        pathOrKey: 'webStorage:workspace',
        ok: remainingKeys.length === 0,
        detail:
          remainingKeys.length === 0
            ? 'Рабочие ключи удалены; технические настройки приложения сохранены'
            : `Остались ключи: ${remainingKeys.join(', ')}`,
      });
    } catch (err) {
      errors.push(
        `Web Storage: ${err instanceof Error ? err.message : 'ошибка очистки ключей'}`,
      );
    }
  }

  return {
    success: errors.length === 0 && remainingItems.length === 0 && verification.every((v) => v.ok),
    deletedItems,
    remainingItems,
    preservedItems,
    errors,
    verification,
  };
}
