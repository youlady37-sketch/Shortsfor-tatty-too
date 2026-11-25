import fs from 'node:fs';
import path from 'node:path';
import {
  findProtectedOverlap,
  getProtectedBrandResources,
  isProtectedRelativePath,
  normalizeCanonicalPath,
} from '../shared/protectedAssets.ts';
import type {
  CleanupServerExecutionReport,
  CleanupServerPlan,
  CleanupTargetItem,
  CleanupVerificationItem,
  ProtectedResourceEntry,
} from '../types.ts';

function getFileSizeSafe(filePath: string): number {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

function collectFilesRecursively(
  dirPath: string,
  rootBaseDir: string,
): Array<{ absPath: string; relPath: string; sizeBytes: number; name: string }> {
  if (!fs.existsSync(dirPath)) return [];
  const results: Array<{ absPath: string; relPath: string; sizeBytes: number; name: string }> = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const absPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFilesRecursively(absPath, rootBaseDir));
    } else if (entry.isFile()) {
      const relPath = normalizeCanonicalPath(path.relative(rootBaseDir, absPath));
      results.push({
        absPath,
        relPath,
        sizeBytes: getFileSizeSafe(absPath),
        name: entry.name,
      });
    }
  }
  return results;
}

function isAudioExtension(fileName: string): boolean {
  return /\.(wav|mp3|aac|m4a|flac|ogg|oga)$/i.test(fileName);
}

function countPresetsInFile(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export function buildServerCleanupPlan(params: {
  rootDir: string;
  storageDir: string;
  scope: 'production' | 'isolated-test';
  preserveAdPresets?: boolean;
  extraProtectedResources?: ProtectedResourceEntry[];
}): CleanupServerPlan {
  const {
    rootDir,
    storageDir,
    scope,
    preserveAdPresets = true,
    extraProtectedResources = [],
  } = params;
  const uploadsDir = path.join(storageDir, 'uploads');
  const exportsDir = path.join(storageDir, 'exports');
  const tempDir = path.join(storageDir, 'temp');
  const adsDir = path.join(storageDir, 'ads');
  const persistentPresetsPath = path.join(storageDir, 'persistent', 'ad_presets.json');
  const legacyPresetsPath = path.join(storageDir, 'ad_presets.json');

  const targets: CleanupTargetItem[] = [];
  let sourceVideosCount = 0;
  let sourceAudioCount = 0;
  let exportedMp4Count = 0;
  let intermediateFilesCount = 0;
  let adFilesCount = 0;
  let adVisualFilesCount = 0;
  let adAudioFilesCount = 0;
  let stateFilesCount = 0;
  let totalServerBytes = 0;

  // 1. storage/uploads
  for (const file of collectFilesRecursively(uploadsDir, rootDir)) {
    const isAudio = isAudioExtension(file.name);
    if (isAudio) {
      sourceAudioCount += 1;
    } else {
      sourceVideosCount += 1;
    }
    totalServerBytes += file.sizeBytes;
    targets.push({
      category: isAudio ? 'source-audio' : 'source-video',
      label: file.name,
      pathOrKey: file.relPath,
      sizeBytes: file.sizeBytes,
    });
  }

  // 2. storage/exports (MP4s + intermediate segments + status.json)
  for (const file of collectFilesRecursively(exportsDir, rootDir)) {
    totalServerBytes += file.sizeBytes;
    if (/^version_[ab]\.mp4$/i.test(file.name) || file.name.endsWith('.mp4')) {
      exportedMp4Count += 1;
      targets.push({
        category: 'exported-mp4',
        label: file.relPath,
        pathOrKey: file.relPath,
        sizeBytes: file.sizeBytes,
      });
    } else if (file.name === 'status.json') {
      stateFilesCount += 1;
      targets.push({
        category: 'state-json',
        label: file.relPath,
        pathOrKey: file.relPath,
        sizeBytes: file.sizeBytes,
      });
    } else {
      intermediateFilesCount += 1;
      targets.push({
        category: 'intermediate-temp',
        label: file.relPath,
        pathOrKey: file.relPath,
        sizeBytes: file.sizeBytes,
      });
    }
  }

  // 3. storage/temp
  for (const file of collectFilesRecursively(tempDir, rootDir)) {
    intermediateFilesCount += 1;
    totalServerBytes += file.sizeBytes;
    targets.push({
      category: 'intermediate-temp',
      label: file.relPath,
      pathOrKey: file.relPath,
      sizeBytes: file.sizeBytes,
    });
  }

  // 4. storage/ads (temporary release ad images/GIFs AND temporary ad audio files — ALWAYS deleted)
  for (const file of collectFilesRecursively(adsDir, rootDir)) {
    const isAudio = isAudioExtension(file.name);
    adFilesCount += 1;
    if (isAudio) {
      adAudioFilesCount += 1;
    } else {
      adVisualFilesCount += 1;
    }
    totalServerBytes += file.sizeBytes;
    targets.push({
      category: isAudio ? 'ad-audio' : 'ad-asset',
      label: file.name,
      pathOrKey: file.relPath,
      sizeBytes: file.sizeBytes,
    });
  }

  // 5. Temporary release state JSON files in storage/ (never includes persistent presets when preserveAdPresets=true)
  for (const jsonName of ['uploaded_state.json', 'library_state.json', 'ad_state.json']) {
    const absPath = path.join(storageDir, jsonName);
    if (fs.existsSync(absPath)) {
      const sizeBytes = getFileSizeSafe(absPath);
      const relPath = normalizeCanonicalPath(path.relative(rootDir, absPath));
      stateFilesCount += 1;
      totalServerBytes += sizeBytes;
      targets.push({
        category: 'state-json',
        label: jsonName,
        pathOrKey: relPath,
        sizeBytes,
      });
    }
  }

  // 6. Persistent advertiser presets: preserved by default, deleted ONLY if user explicitly declines
  const persistentPresetsCount = countPresetsInFile(persistentPresetsPath);
  const legacyPresetsCount = countPresetsInFile(legacyPresetsPath);
  const preservedPresetsCount = preserveAdPresets
    ? persistentPresetsCount + legacyPresetsCount
    : 0;

  if (!preserveAdPresets) {
    for (const presetFilePath of [persistentPresetsPath, legacyPresetsPath]) {
      if (fs.existsSync(presetFilePath)) {
        const sizeBytes = getFileSizeSafe(presetFilePath);
        const relPath = normalizeCanonicalPath(path.relative(rootDir, presetFilePath));
        stateFilesCount += 1;
        totalServerBytes += sizeBytes;
        targets.push({
          category: 'state-json',
          label: `Постоянные пресеты (${relPath})`,
          pathOrKey: relPath,
          sizeBytes,
        });
      }
    }
  }

  const protectedResources = getProtectedBrandResources(extraProtectedResources);
  const candidatePaths = targets.map((t) => t.pathOrKey);
  const overlapPaths = findProtectedOverlap(candidatePaths, extraProtectedResources);

  return {
    generatedAt: new Date().toISOString(),
    scope,
    preserveAdPresets,
    preservedPresetsCount,
    counts: {
      sourceVideosCount,
      sourceAudioCount,
      exportedMp4Count,
      intermediateFilesCount,
      adFilesCount,
      adVisualFilesCount,
      adAudioFilesCount,
      stateFilesCount,
      totalServerBytes,
    },
    targets,
    protectedResources,
    overlapCount: overlapPaths.length,
    overlapPaths,
  };
}

export async function executeServerCleanup(params: {
  rootDir: string;
  storageDir: string;
  scope: 'production' | 'isolated-test';
  preserveAdPresets?: boolean;
  extraProtectedResources?: ProtectedResourceEntry[];
  resetInMemoryState?: (options: { clearPresets: boolean }) => void;
  deleteCloudKey?: (relativeKey: string) => Promise<void>;
}): Promise<CleanupServerExecutionReport> {
  const {
    rootDir,
    storageDir,
    scope,
    preserveAdPresets = true,
    extraProtectedResources = [],
    resetInMemoryState,
    deleteCloudKey,
  } = params;
  const plan = buildServerCleanupPlan({
    rootDir,
    storageDir,
    scope,
    preserveAdPresets,
    extraProtectedResources,
  });

  if (plan.overlapCount > 0) {
    return {
      executedAt: new Date().toISOString(),
      scope,
      success: false,
      deletedItems: [],
      remainingItems: plan.overlapPaths,
      errors: [
        `Обнаружено пересечение со списком защищённых ресурсов (${plan.overlapPaths.join(', ')}). Очистка заблокирована.`,
      ],
      freedServerBytes: 0,
      protectedVerification: [],
      deletionVerification: [],
    };
  }

  const deletedItems: string[] = [];
  const remainingItems: string[] = [];
  const errors: string[] = [];
  let freedServerBytes = 0;

  // Execute deletion of individual planned files safely (checking protected guard per file)
  for (const target of plan.targets) {
    if (isProtectedRelativePath(target.pathOrKey, extraProtectedResources)) {
      errors.push(`Отклонено удаление защищённого ресурса: ${target.pathOrKey}`);
      remainingItems.push(target.pathOrKey);
      continue;
    }
    const absTarget = path.resolve(rootDir, target.pathOrKey);
    const resolvedStorage = path.resolve(storageDir);
    if (!absTarget.startsWith(resolvedStorage + path.sep)) {
      errors.push(`Путь выходит за пределы каталога storage: ${target.pathOrKey}`);
      remainingItems.push(target.pathOrKey);
      continue;
    }

    try {
      if (fs.existsSync(absTarget)) {
        fs.rmSync(absTarget, { force: true });
      }
      if (deleteCloudKey) {
        const relToStorage = normalizeCanonicalPath(path.relative(storageDir, absTarget));
        if (
          relToStorage.startsWith('uploads/') ||
          relToStorage.startsWith('exports/') ||
          relToStorage.startsWith('ads/') ||
          (!preserveAdPresets && relToStorage === 'persistent/ad_presets.json')
        ) {
          await deleteCloudKey(relToStorage);
        }
      }
      deletedItems.push(target.pathOrKey);
      freedServerBytes += target.sizeBytes;
    } catch (err) {
      errors.push(
        `Не удалось удалить ${target.pathOrKey}: ${err instanceof Error ? err.message : 'ошибка ФС'}`,
      );
      remainingItems.push(target.pathOrKey);
    }
  }

  // Clean empty job/temp directories inside storage/uploads, exports, temp, ads while recreating base roots
  for (const sub of ['uploads', 'exports', 'temp', 'ads']) {
    const dir = path.join(storageDir, sub);
    if (fs.existsSync(dir)) {
      try {
        const children = fs.readdirSync(dir);
        for (const child of children) {
          const childPath = path.join(dir, child);
          const relChild = normalizeCanonicalPath(path.relative(rootDir, childPath));
          if (
            !isProtectedRelativePath(relChild, extraProtectedResources) &&
            fs.statSync(childPath).isDirectory()
          ) {
            fs.rmSync(childPath, { recursive: true, force: true });
          }
        }
      } catch {
        // ignore sub-cleanup error
      }
    }
    fs.mkdirSync(dir, { recursive: true });
  }

  resetInMemoryState?.({ clearPresets: !preserveAdPresets });

  // Verification Pass 1: Verify every planned target is physically gone
  const deletionVerification: CleanupVerificationItem[] = [];
  for (const target of plan.targets) {
    const absTarget = path.resolve(rootDir, target.pathOrKey);
    const stillExists = fs.existsSync(absTarget);
    if (stillExists && !remainingItems.includes(target.pathOrKey)) {
      remainingItems.push(target.pathOrKey);
    }
    deletionVerification.push({
      id: `del:${target.pathOrKey}`,
      label: target.label,
      pathOrKey: target.pathOrKey,
      ok: !stillExists,
      detail: stillExists ? 'Файл остался на диске' : 'Физически удалён',
    });
  }

  // Verification Pass 2: Verify every protected brand resource on server remains physically intact
  const protectedVerification: CleanupVerificationItem[] = [];
  for (const entry of getProtectedBrandResources(extraProtectedResources)) {
    if (
      entry.storageScope !== 'server-public' &&
      entry.storageScope !== 'server-persistent' &&
      entry.storageScope !== 'app-config'
    ) {
      continue;
    }
    const absProtected = path.resolve(rootDir, entry.relativePath);
    const size = getFileSizeSafe(absProtected);
    const intact = size > 0;
    if (!intact) {
      errors.push(`КРИТИЧЕСКАЯ ПРОВЕРКА: защищённый ресурс отсутствует (${entry.relativePath}).`);
    }
    protectedVerification.push({
      id: entry.id,
      label: entry.label,
      pathOrKey: entry.relativePath,
      ok: intact,
      detail: intact
        ? `Сохранён (${(size / 1024).toFixed(1)} КБ)`
        : 'Отсутствует или пустой файл',
    });
  }

  // Verification Pass 3: If preserveAdPresets=true and persistent/ad_presets.json existed, verify intact
  if (preserveAdPresets) {
    const persistentPresetsPath = path.join(storageDir, 'persistent', 'ad_presets.json');
    if (fs.existsSync(persistentPresetsPath)) {
      const count = countPresetsInFile(persistentPresetsPath);
      protectedVerification.push({
        id: 'persistent:ad-presets',
        label: 'Постоянные рекламные пресеты (persistent/ad_presets.json)',
        pathOrKey: normalizeCanonicalPath(path.relative(rootDir, persistentPresetsPath)),
        ok: true,
        detail: `Сохранено пресетов: ${count}`,
      });
    }
  }

  const success =
    errors.length === 0 &&
    remainingItems.length === 0 &&
    protectedVerification.every((p) => p.ok);

  return {
    executedAt: new Date().toISOString(),
    scope,
    success,
    deletedItems,
    remainingItems,
    errors,
    freedServerBytes,
    protectedVerification,
    deletionVerification,
  };
}
