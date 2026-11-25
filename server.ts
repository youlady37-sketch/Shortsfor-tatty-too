import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import {
  extractTimelineAudioForTranscription,
  probeMedia,
  renderDualShortsExport,
} from './src/server/ffmpegPipeline.ts';
import { analyzeSegmentAutoFraming } from './src/server/autoFraming.ts';
import { generateCoverArtwork, transcribeAudioToSubtitles } from './src/server/geminiService.ts';
import {
  checkCloudObjectExists,
  deleteCloudObject,
  getStorageEnvironmentInfo,
  restoreFileFromCloud,
  uploadFileToCloud,
} from './src/server/persistentStorage.ts';
import {
  AdStorageManager,
  detectAdAudioFormat,
  detectAdFormat,
  probeAdAsset,
  probeAdAudioAsset,
} from './src/server/adStorage.ts';
import {
  buildServerCleanupPlan,
  executeServerCleanup,
} from './src/server/workspaceCleanup.ts';
import {
  parseSourceFilenameMetadata,
  reconcileSourceMetadata,
  resolveSegmentMediaAsset,
  sortLibrarySources,
} from './src/shared/sourceLibrary.ts';
import {
  buildShortExportFileNames,
  normalizeShortNumber,
  resolveExportDownloadFileName,
} from './src/shared/exportNaming.ts';
import type {
  AdOverlayLayer,
  AdPreset,
  AspectRatioOption,
  CutSegment,
  ExportHistoryItem,
  ExportJobStatus,
  ExportRequestPayload,
  ImageSizeOption,
  MissingLibrarySource,
  MissingUploadedAsset,
  OverlayPlacementMode,
  PreloadedCategory,
  PreloadedOverlay,
  SegmentAutoFrameResult,
  SourceLibraryItem,
  SourceRole,
  UploadedAsset,
} from './src/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STORAGE_DIR = process.env.STUDIO_STORAGE_DIR
  ? path.resolve(process.env.STUDIO_STORAGE_DIR)
  : path.join(__dirname, 'storage');
const UPLOADS_DIR = path.join(STORAGE_DIR, 'uploads');
const EXPORTS_DIR = path.join(STORAGE_DIR, 'exports');
const TEMP_DIR = path.join(STORAGE_DIR, 'temp');
const AISTUDIO_ASSETS_DIR = path.join(__dirname, 'public', 'assets', 'aistudio');

const UPLOADED_STATE_PATH = path.join(STORAGE_DIR, 'uploaded_state.json');
const LIBRARY_STATE_PATH = path.join(STORAGE_DIR, 'library_state.json');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(EXPORTS_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

const uploadedAssets: Partial<Record<SourceRole, UploadedAsset>> = {};
const savedAssetRecords: Partial<Record<SourceRole, UploadedAsset>> = {};
const activeLibraryItems = new Map<string, SourceLibraryItem>();
const savedLibraryRecords = new Map<string, SourceLibraryItem>();
const exportJobs = new Map<string, ExportJobStatus>();
const adManager = new AdStorageManager(STORAGE_DIR);

const ALLOWED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v']);

function isValidLibraryId(id: string): boolean {
  return /^src_[a-zA-Z0-9_-]{3,80}$/.test(id);
}

function isAllowedVideoUpload(originalName: string, mimeType: string): boolean {
  const ext = path.extname(originalName).toLowerCase();
  if (ALLOWED_VIDEO_EXTENSIONS.has(ext)) return true;
  if (!ext && mimeType.toLowerCase().startsWith('video/')) return true;
  return false;
}

function sanitizeVideoExtension(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase().replace(/[^a-z0-9.]/g, '');
  return ALLOWED_VIDEO_EXTENSIONS.has(ext) ? ext : '.mp4';
}

function isInsideUploadsDir(targetPath: string): boolean {
  const resolvedUploads = path.resolve(UPLOADS_DIR);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget.startsWith(resolvedUploads + path.sep);
}

function normalizeMulterOriginalName(rawName: string): string {
  const safe = rawName || 'video.mp4';
  const hasHighByteOnly = /^[\u0000-\u00ff]+$/.test(safe) && /[\u0080-\u00ff]/.test(safe);
  if (hasHighByteOnly) {
    try {
      const decoded = Buffer.from(safe, 'latin1').toString('utf8');
      if (decoded && !decoded.includes('\uFFFD') && decoded !== safe) {
        return path.basename(decoded);
      }
    } catch {
      // keep raw
    }
  }
  return path.basename(safe);
}

function isValidNonEmptyFile(filePath: string | undefined): { exists: boolean; sizeBytes: number } {
  if (!filePath) return { exists: false, sizeBytes: 0 };
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile() && stat.size > 0) {
      return { exists: true, sizeBytes: stat.size };
    }
  } catch {
    // missing
  }
  return { exists: false, sizeBytes: 0 };
}

function loadUploadedState() {
  if (!fs.existsSync(UPLOADED_STATE_PATH)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(UPLOADED_STATE_PATH, 'utf-8')) as Partial<
      Record<SourceRole, UploadedAsset>
    >;
    for (const [role, asset] of Object.entries(raw)) {
      if (!asset) continue;
      savedAssetRecords[role as SourceRole] = asset;
      if (isValidNonEmptyFile(asset.filePath).exists) {
        uploadedAssets[role as SourceRole] = asset;
      }
    }
  } catch {
    // ignore corrupt state
  }
}

function saveUploadedState() {
  try {
    fs.writeFileSync(UPLOADED_STATE_PATH, JSON.stringify(savedAssetRecords, null, 2), 'utf-8');
  } catch {
    // ignore write failures
  }
}

function saveLibraryState() {
  try {
    const items = Array.from(savedLibraryRecords.values());
    fs.writeFileSync(LIBRARY_STATE_PATH, JSON.stringify(items, null, 2), 'utf-8');
  } catch {
    // ignore write failures
  }
}

function loadLibraryState() {
  let loadedFromDisk = false;
  if (fs.existsSync(LIBRARY_STATE_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(LIBRARY_STATE_PATH, 'utf-8')) as unknown;
      const items = Array.isArray(raw) ? (raw as SourceLibraryItem[]) : [];
      for (const item of items) {
        if (!item?.id || !isValidLibraryId(item.id)) continue;
        const normalized: SourceLibraryItem = {
          ...item,
          metadata: item.metadata ?? parseSourceFilenameMetadata(item.originalName || item.fileName),
          warnings: Array.isArray(item.warnings) ? item.warnings : [],
          uploadedAt: item.uploadedAt || new Date().toISOString(),
        };
        savedLibraryRecords.set(normalized.id, normalized);
        if (isValidNonEmptyFile(normalized.filePath).exists) {
          activeLibraryItems.set(normalized.id, normalized);
        }
      }
      loadedFromDisk = true;
    } catch {
      // ignore corrupt library state
    }
  }

  // Migrate any legacy fragment8/fragment9 records that are on disk & not yet tracked in library_state.json
  let migrated = false;
  for (const legacyRole of ['fragment8', 'fragment9'] as const) {
    const legacy = savedAssetRecords[legacyRole];
    if (!legacy || !isValidNonEmptyFile(legacy.filePath).exists) continue;
    const alreadyInLibrary = Array.from(savedLibraryRecords.values()).some(
      (item) =>
        item.legacyRole === legacyRole ||
        (item.filePath && path.resolve(item.filePath) === path.resolve(legacy.filePath)),
    );
    if (!alreadyInLibrary) {
      const id = `src_legacy_${legacyRole}`;
      const item: SourceLibraryItem = {
        id,
        fileName: legacy.fileName,
        originalName: legacy.originalName,
        url: legacy.url,
        filePath: legacy.filePath,
        probe: legacy.probe,
        warnings: legacy.warnings ?? [],
        uploadedAt: new Date().toISOString(),
        legacyRole,
        metadata: parseSourceFilenameMetadata(legacy.originalName),
      };
      savedLibraryRecords.set(id, item);
      activeLibraryItems.set(id, item);
      migrated = true;
    }
  }

  if (migrated && !loadedFromDisk) {
    saveLibraryState();
  } else if (migrated) {
    saveLibraryState();
  }
}

async function syncUploadedAssetsAvailability(): Promise<{
  available: Partial<Record<SourceRole, UploadedAsset>>;
  missing: Partial<Record<SourceRole, MissingUploadedAsset>>;
}> {
  const available: Partial<Record<SourceRole, UploadedAsset>> = {};
  const missing: Partial<Record<SourceRole, MissingUploadedAsset>> = {};

  for (const [roleKey, record] of Object.entries(savedAssetRecords)) {
    const role = roleKey as SourceRole;
    if (!record) continue;
    let check = isValidNonEmptyFile(record.filePath);

    if (!check.exists && record.fileName && record.filePath) {
      const restored = await restoreFileFromCloud(`uploads/${record.fileName}`, record.filePath);
      if (restored) {
        check = isValidNonEmptyFile(record.filePath);
      }
    }

    if (check.exists) {
      uploadedAssets[role] = record;
      available[role] = record;
    } else {
      delete uploadedAssets[role];
      missing[role] = {
        role,
        originalName: record.originalName,
        fileName: record.fileName,
        sizeBytes: record.probe?.sizeBytes ?? 0,
        probe: record.probe,
        reason:
          'Исходный файл отсутствует на диске контейнера (возможно, среда Cloud Run была перезапущена).',
      };
    }
  }

  return { available, missing };
}

async function syncLibraryAvailability(): Promise<{
  items: SourceLibraryItem[];
  missingItems: MissingLibrarySource[];
}> {
  const availableList: SourceLibraryItem[] = [];
  const missingList: MissingLibrarySource[] = [];

  for (const [id, record] of savedLibraryRecords.entries()) {
    let check = isValidNonEmptyFile(record.filePath);

    if (!check.exists && record.fileName && record.filePath) {
      const restored = await restoreFileFromCloud(`uploads/${record.fileName}`, record.filePath);
      if (restored) {
        check = isValidNonEmptyFile(record.filePath);
      }
    }

    if (check.exists) {
      activeLibraryItems.set(id, record);
      availableList.push(record);
    } else {
      activeLibraryItems.delete(id);
      missingList.push({
        id: record.id,
        originalName: record.originalName,
        fileName: record.fileName,
        sizeBytes: record.probe?.sizeBytes ?? 0,
        probe: record.probe,
        uploadedAt: record.uploadedAt,
        legacyRole: record.legacyRole,
        metadata: record.metadata,
        reason:
          'Исходный файл отсутствует на диске контейнера. Загрузите файл заново или восстановите его из IndexedDB.',
      });
    }
  }

  return {
    items: sortLibrarySources(availableList, 'segment'),
    missingItems: missingList,
  };
}

loadUploadedState();
loadLibraryState();

const PRELOADED_DEFINITIONS: Array<{
  id: string;
  fileName: string;
  label: string;
  kind: 'image' | 'audio';
  category: PreloadedCategory;
  hasAlpha?: boolean;
  overlayPlacement?: OverlayPlacementMode;
  note: string;
}> = [
  {
    id: 'preloaded:audio-logo',
    fileName: '__________________14455776.wav',
    label: 'Фирменный звуковой логотип (WAV)',
    kind: 'audio',
    category: 'audio',
    note: 'Загруженный звук (3.94 с, 32 кГц, стерео). Используется в Версии А на финальной заставке.',
  },
  {
    id: 'preloaded:overlay-corner-marks',
    fileName: 'shorts-overlay-corner-marks_140c6f21.png',
    label: 'Угловые рамки видоискателя 9:16 (прозрачный оверлей)',
    kind: 'image',
    category: 'overlay',
    hasAlpha: true,
    overlayPlacement: 'full-frame',
    note: 'Чистый полноэкранный PNG 1080×1920 с прозрачным центром и угловыми метками кадра.',
  },
  {
    id: 'preloaded:rubric-dopros-marker',
    fileName: 'rubric-01-dopros-marker_f108d902.png',
    label: 'Маркер рубрики «ДОПРОС» (420×180, альфа)',
    kind: 'image',
    category: 'rubric-marker',
    hasAlpha: true,
    overlayPlacement: 'top-left-badge',
    note: 'Прозрачная плашка для левого верхнего угла безопасной зоны при наложении на сцену.',
  },
  {
    id: 'preloaded:rubric-povorot-marker',
    fileName: 'rubric-02-povorot-dela-marker_b282cd9e.png',
    label: 'Маркер рубрики «ПОВОРОТ ДЕЛА» (480×180, альфа)',
    kind: 'image',
    category: 'rubric-marker',
    hasAlpha: true,
    overlayPlacement: 'top-left-badge',
    note: 'Прозрачная плашка рубрики для акцентирования ключевого момента версии.',
  },
  {
    id: 'preloaded:rubric-zagadka-marker',
    fileName: 'rubric-03-kriminalnaya-zagadka-marker_065519fd.png',
    label: 'Маркер рубрики «КРИМИНАЛЬНАЯ ЗАГАДКА» (520×180, альфа)',
    kind: 'image',
    category: 'rubric-marker',
    hasAlpha: true,
    overlayPlacement: 'top-left-badge',
    note: 'Прозрачная плашка для детективной интриги в верхней левой зоне.',
  },
  {
    id: 'preloaded:rubric-dopros-title',
    fileName: 'rubric-01-dopros-title_d285a688.png',
    label: 'Заставка рубрики «ДОПРОС — Диалог под давлением»',
    kind: 'image',
    category: 'rubric-title',
    hasAlpha: false,
    overlayPlacement: 'full-frame',
    note: 'Полноэкранная карточка 1080×1920 для открытия или финала рубрики «Допрос».',
  },
  {
    id: 'preloaded:rubric-povorot-title',
    fileName: 'rubric-02-povorot-dela-title_89f5a12a.png',
    label: 'Заставка рубрики «ПОВОРОТ ДЕЛА»',
    kind: 'image',
    category: 'rubric-title',
    hasAlpha: false,
    overlayPlacement: 'full-frame',
    note: 'Полноэкранная карточка 1080×1920 для перебивки или заставки рубрики «Поворот дела».',
  },
  {
    id: 'preloaded:rubric-zagadka-title',
    fileName: 'rubric-03-kriminalnaya-zagadka-title_f06d4097.png',
    label: 'Заставка рубрики «КРИМИНАЛЬНАЯ ЗАГАДКА»',
    kind: 'image',
    category: 'rubric-title',
    hasAlpha: false,
    overlayPlacement: 'full-frame',
    note: 'Полноэкранная карточка 1080×1920 для рубрики «Криминальная загадка».',
  },
  {
    id: 'preloaded:shorts-04',
    fileName: 'shorts-04-final-cta_bbd9e262.png',
    label: 'Финальная заставка «СЛЕДСТВИЕ / Подписывайтесь» (shorts-04)',
    kind: 'image',
    category: 'endplate',
    hasAlpha: true,
    overlayPlacement: 'full-frame',
    note: 'PNG 1080×1920: содержит текст «СЛЕДСТВИЕ / Следующее дело — завтра / Подписывайтесь».',
  },
  {
    id: 'preloaded:shorts-01',
    fileName: 'shorts-01-title-card_0a7f7883.png',
    label: 'Титульный шаблон «ДЕЛО № 021» (shorts-01)',
    kind: 'image',
    category: 'title-card',
    hasAlpha: true,
    overlayPlacement: 'full-frame',
    note: 'PNG 1080×1920 с прозрачным фоном: титульная карточка «ДЕЛО № 021 / Он не был свидетелем».',
  },
  {
    id: 'preloaded:shorts-02',
    fileName: 'shorts-02-scene-subtitles_4b7a4edb.png',
    label: 'Рамка субтитров (shorts-02)',
    kind: 'image',
    category: 'overlay',
    hasAlpha: true,
    overlayPlacement: 'full-frame',
    note: 'PNG 1080×1920: угловые рамки и образец плашки субтитров.',
  },
  {
    id: 'preloaded:shorts-03',
    fileName: 'shorts-03-plot-twist-accent_acecf962.png',
    label: 'Акцент-шаблон (shorts-03)',
    kind: 'image',
    category: 'overlay',
    hasAlpha: true,
    overlayPlacement: 'full-frame',
    note: 'PNG 1080×1920: угловые рамки с бордовым акцентом слова в субтитре.',
  },
  {
    id: 'preloaded:subtitle-document',
    fileName: 'shorts-subtitle-document_7d25a4b5.png',
    label: 'Плашка «Из материалов дела» (498×98, альфа)',
    kind: 'image',
    category: 'subtitle-ref',
    hasAlpha: true,
    overlayPlacement: 'bottom-center-subtitle',
    note: 'Прозрачная плашка для нижнего центра кадра — пометка документальной вставки.',
  },
  {
    id: 'preloaded:subtitle-basic',
    fileName: 'shorts-subtitle-basic_1cf29ce7.png',
    label: 'Образец плашки субтитров: базовая (640×97)',
    kind: 'image',
    category: 'subtitle-ref',
    hasAlpha: true,
    overlayPlacement: 'bottom-center-subtitle',
    note: 'Референс оформления однострочного субтитра канала.',
  },
  {
    id: 'preloaded:subtitle-accent',
    fileName: 'shorts-subtitle-accent_789e04f0.png',
    label: 'Образец плашки субтитров: акцент (640×97)',
    kind: 'image',
    category: 'subtitle-ref',
    hasAlpha: true,
    overlayPlacement: 'bottom-center-subtitle',
    note: 'Референс оформления субтитра с бордовым выделением ключевого слова.',
  },
  {
    id: 'preloaded:subtitle-two-lines',
    fileName: 'shorts-subtitle-two-lines_a90117ba.png',
    label: 'Образец плашки субтитров: 2 строки (494×142)',
    kind: 'image',
    category: 'subtitle-ref',
    hasAlpha: true,
    overlayPlacement: 'bottom-center-subtitle',
    note: 'Референс оформления двухстрочного субтитра канала.',
  },
  {
    id: 'preloaded:logo-horizontal-light',
    fileName: '03-logo-horizontal-mono-light_c71ba116.png',
    label: 'Логотип «ДЕЛО В КАДРЕ» светлый монохром (для видео)',
    kind: 'image',
    category: 'brand-logo',
    hasAlpha: true,
    overlayPlacement: 'top-center-logo',
    note: 'Горизонтальный логотип 2400×620 с прозрачным фоном для наложения на тёмные сцены.',
  },
  {
    id: 'preloaded:logo-horizontal-primary',
    fileName: '01-main-logo-horizontal-primary_67a20df9.png',
    label: 'Основной горизонтальный логотип «ДЕЛО В КАДРЕ»',
    kind: 'image',
    category: 'brand-logo',
    hasAlpha: true,
    overlayPlacement: 'top-center-logo',
    note: 'Фирменный цветной логотип 2400×620 с прозрачным фоном для светлых фонов и обложек.',
  },
  {
    id: 'preloaded:logo-horizontal-dark',
    fileName: '03-logo-horizontal-mono-dark_0c5105cc.png',
    label: 'Логотип «ДЕЛО В КАДРЕ» тёмный монохром',
    kind: 'image',
    category: 'brand-logo',
    hasAlpha: true,
    overlayPlacement: 'top-center-logo',
    note: 'Монохромный тёмный логотип 2400×620 с прозрачным фоном.',
  },
  {
    id: 'preloaded:symbol-primary',
    fileName: '04-symbol-only-primary_c71406cc.png',
    label: 'Знак-папка «ДЕЛО В КАДРЕ» (1100×1000, альфа)',
    kind: 'image',
    category: 'brand-logo',
    hasAlpha: true,
    overlayPlacement: 'top-left-badge',
    note: 'Отдельный знак бренда с прозрачным фоном для водяного знака или уголка.',
  },
  {
    id: 'preloaded:youtube-avatar',
    fileName: '02-compact-sign-youtube-avatar_68ec7525.png',
    label: 'Аватар YouTube-канала (1200×1200)',
    kind: 'image',
    category: 'brand-logo',
    hasAlpha: true,
    note: 'Квадратный знак-аватар 1200×1200 для профиля YouTube и соцсетей.',
  },
  {
    id: 'preloaded:youtube-banner',
    fileName: 'youtube-banner-delo-v-kadre-2560x1440_675a6c72.png',
    label: 'Баннер YouTube-канала (2560×1440)',
    kind: 'image',
    category: 'brand-logo',
    hasAlpha: false,
    note: 'Готовая шапка канала YouTube 2560×1440 «Криминальные истории. Сильные сцены. Неожиданные повороты.»',
  },
];

async function getPreloadedAssets(): Promise<PreloadedOverlay[]> {
  const results: PreloadedOverlay[] = [];
  for (const def of PRELOADED_DEFINITIONS) {
    const absPath = path.join(AISTUDIO_ASSETS_DIR, def.fileName);
    if (!fs.existsSync(absPath)) continue;
    try {
      const probe = await probeMedia(absPath);
      results.push({
        id: def.id,
        fileName: def.fileName,
        label: def.label,
        url: `/assets/aistudio/${def.fileName}`,
        kind: def.kind,
        category: def.category,
        hasAlpha: def.hasAlpha,
        overlayPlacement: def.overlayPlacement,
        width: probe.width || undefined,
        height: probe.height || undefined,
        durationSec: probe.durationSec || undefined,
        note: def.note,
      });
    } catch {
      results.push({
        id: def.id,
        fileName: def.fileName,
        label: def.label,
        url: `/assets/aistudio/${def.fileName}`,
        kind: def.kind,
        category: def.category,
        hasAlpha: def.hasAlpha,
        overlayPlacement: def.overlayPlacement,
        note: def.note,
      });
    }
  }
  return results;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    } catch {
      // ignore
    }
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const rawExt = path.extname(normalizeMulterOriginalName(file.originalname)).toLowerCase().replace(/[^a-z0-9.]/g, '');
    const ext = rawExt || '.bin';
    const safeName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 },
});

const adDiskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, adManager.getAdsDir()),
  filename: (_req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.png').toLowerCase();
    const safeName = `ad_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, safeName);
  },
});

const uploadAd = multer({
  storage: adDiskStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
});

function buildRoleWarnings(role: SourceRole, probe: Awaited<ReturnType<typeof probeMedia>>): string[] {
  const warnings: string[] = [];
  if (role === 'fragment8') {
    if (!probe.hasVideo) {
      warnings.push('Файл не содержит видеодорожку.');
    }
    if (probe.durationSec < 266) {
      warnings.push(
        `Длительность файла (${probe.durationSec.toFixed(1)} с) меньше таймкода 00:04:10–00:04:26 (250–266 с). Если фрагмент уже вырезан отдельно, скорректируйте In/Out сегментов вручную.`,
      );
    }
  }
  if (role === 'fragment9') {
    if (!probe.hasVideo) {
      warnings.push('Файл не содержит видеодорожку.');
    }
    if (probe.durationSec < 75) {
      warnings.push(
        `Длительность файла (${probe.durationSec.toFixed(1)} с) меньше ожидаемого диапазона 00:00:00–00:01:15 (0–75 с). Уточните границы монтажа.`,
      );
    }
  }
  if ((role === 'music' || role === 'audioLogo') && !probe.hasAudio) {
    warnings.push('Аудиопоток в файле не обнаружен.');
  }
  return warnings;
}

function saveJobStatus(job: ExportJobStatus) {
  try {
    const dir = path.join(EXPORTS_DIR, job.jobId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(job, null, 2), 'utf-8');
  } catch {
    // ignore status write failure
  }
}

function readJobStatus(jobId: string): ExportJobStatus | null {
  const mem = exportJobs.get(jobId);
  if (mem) return mem;
  if (!/^job_\d+$/.test(jobId)) return null;
  const statusFile = path.join(EXPORTS_DIR, jobId, 'status.json');
  if (!fs.existsSync(statusFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(statusFile, 'utf-8')) as ExportJobStatus;
  } catch {
    return null;
  }
}

async function getExportHistory(): Promise<ExportHistoryItem[]> {
  const history: ExportHistoryItem[] = [];
  try {
    const entries = fs
      .readdirSync(EXPORTS_DIR)
      .filter((name) => /^job_\d+$/.test(name))
      .sort()
      .reverse();

    for (const jobId of entries) {
      const status = readJobStatus(jobId);
      const dir = path.join(EXPORTS_DIR, jobId);
      const aPath = path.join(dir, 'version_a.mp4');
      const bPath = path.join(dir, 'version_b.mp4');
      const aFile = isValidNonEmptyFile(aPath);
      const bFile = isValidNonEmptyFile(bPath);

      const [aCloud, bCloud] = await Promise.all([
        !aFile.exists ? checkCloudObjectExists(`exports/${jobId}/version_a.mp4`) : Promise.resolve(false),
        !bFile.exists ? checkCloudObjectExists(`exports/${jobId}/version_b.mp4`) : Promise.resolve(false),
      ]);

      history.push({
        jobId,
        createdAt:
          status?.result?.createdAt ??
          status?.startedAt ??
          new Date(Number(jobId.replace('job_', '')) || Date.now()).toISOString(),
        updatedAt: status?.updatedAt ?? new Date().toISOString(),
        status: status?.status ?? (aFile.exists && bFile.exists ? 'completed' : 'failed'),
        totalDurationSec: status?.result?.totalDurationSec ?? 0,
        versionAOnServer: aFile.exists,
        versionASizeOnServer: aFile.sizeBytes,
        versionBOnServer: bFile.exists,
        versionBSizeOnServer: bFile.sizeBytes,
        versionAOnCloud: aCloud,
        versionBOnCloud: bCloud,
        result: status?.result,
        error: status?.error,
      });
    }
  } catch {
    // ignore directory read errors
  }
  return history;
}

async function getLatestCompletedExport() {
  try {
    const entries = fs
      .readdirSync(EXPORTS_DIR)
      .filter((name) => /^job_\d+$/.test(name))
      .sort()
      .reverse();

    for (const jobId of entries) {
      const dir = path.join(EXPORTS_DIR, jobId);
      const aPath = path.join(dir, 'version_a.mp4');
      const bPath = path.join(dir, 'version_b.mp4');

      let aFile = isValidNonEmptyFile(aPath);
      let bFile = isValidNonEmptyFile(bPath);

      if (!aFile.exists) {
        const restoredA = await restoreFileFromCloud(`exports/${jobId}/version_a.mp4`, aPath);
        if (restoredA) aFile = isValidNonEmptyFile(aPath);
      }
      if (!bFile.exists) {
        const restoredB = await restoreFileFromCloud(`exports/${jobId}/version_b.mp4`, bPath);
        if (restoredB) bFile = isValidNonEmptyFile(bPath);
      }

      const status = readJobStatus(jobId);
      if (status?.status === 'completed' && status.result) {
        const needsB = Boolean(status.result.versionB);
        if (aFile.exists && (!needsB || bFile.exists)) {
          return status.result;
        }
      }

      // Never treat status.json as proof that MP4 exists — required MP4 file(s) must physically exist
      if (!aFile.exists || !bFile.exists) {
        continue;
      }

      try {
        const [probeA, probeB] = await Promise.all([probeMedia(aPath), probeMedia(bPath)]);
        if (probeA.hasVideo && probeB.hasVideo && probeA.durationSec > 0 && probeB.durationSec > 0) {
          const recoveredShortNumber = normalizeShortNumber(status?.shortNumber, 1);
          const recoveredNames = buildShortExportFileNames(recoveredShortNumber);
          const recovered = {
            jobId,
            shortNumber: recoveredShortNumber,
            createdAt: new Date(Number(jobId.replace('job_', '')) || Date.now()).toISOString(),
            mainDurationSec: Number(Math.max(0, probeA.durationSec - 2).toFixed(2)),
            endplateDurationSec: 2.0,
            totalDurationSec: Number(probeA.durationSec.toFixed(2)),
            versionA: {
              version: 'A' as const,
              title: 'Версия А — основная (MP4, H.264/AAC, речь + музыка + звуковой логотип)',
              url: `/api/download-export/${jobId}/version_a.mp4`,
              fileName: recoveredNames.versionA,
              probe: probeA,
            },
            versionB: {
              version: 'B' as const,
              title: 'Версия Б — без музыки (MP4, H.264/AAC, речь + тишина на заставке)',
              url: `/api/download-export/${jobId}/version_b.mp4`,
              fileName: recoveredNames.versionB,
              probe: probeB,
            },
          };
          saveJobStatus({
            jobId,
            status: 'completed',
            stageIndex: 6,
            totalStages: 6,
            stageLabel: 'Экспорт завершён',
            detail: 'Готовы файлы Версия А и Версия Б (MP4, H.264/AAC)',
            startedAt: recovered.createdAt,
            updatedAt: new Date().toISOString(),
            result: recovered,
          });
          return recovered;
        }
      } catch {
        // incomplete mp4, skip
      }
    }
  } catch {
    // ignore
  }
  return null;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.use('/uploads', express.static(UPLOADS_DIR));
  app.use('/exports', express.static(EXPORTS_DIR));
  app.use('/ads', express.static(adManager.getAdsDir()));

  app.get('/api/ads/state', async (_req, res) => {
    try {
      const adState = await adManager.syncAndGetAll();
      res.json(adState);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Ошибка загрузки рекламных настроек.',
      });
    }
  });

  app.post('/api/upload-ad', uploadAd.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'Рекламный файл не получен.' });
      }
      const format = detectAdFormat(req.file.originalname, req.file.mimetype);
      if (!format) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {
          // ignore
        }
        return res.status(400).json({
          error: 'Поддерживаются только рекламные форматы PNG, JPG/JPEG, WEBP и GIF (включая анимированные).',
        });
      }
      const assetId =
        typeof req.body.assetId === 'string' && req.body.assetId.trim()
          ? req.body.assetId.trim()
          : `ad_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      const probed = await probeAdAsset({
        id: assetId,
        filePath: req.file.path,
        fileName: req.file.filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype || `image/${format === 'jpg' ? 'jpeg' : format}`,
        format,
        url: `/ads/${req.file.filename}`,
      });

      await adManager.registerUploadedAsset(probed);
      res.json({ asset: probed });
    } catch (error) {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {
          // ignore
        }
      }
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Ошибка анализа рекламного файла.',
      });
    }
  });

  app.delete('/api/ads/asset/:assetId', (req, res) => {
    const deleted = adManager.deleteAsset(req.params.assetId);
    res.json({ ok: true, deleted });
  });

  app.post('/api/upload-ad-audio', uploadAd.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'Рекламный аудиофайл не получен.' });
      }
      const format = detectAdAudioFormat(req.file.originalname, req.file.mimetype);
      if (!format) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {
          // ignore
        }
        return res.status(400).json({
          error: 'Поддерживаются только рекламные аудиоформаты MP3, WAV, AAC, M4A и OGG.',
        });
      }

      const audioId =
        typeof req.body.audioId === 'string' && req.body.audioId.trim()
          ? req.body.audioId.trim()
          : `adaudio_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      const mimeFallback: Record<string, string> = {
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        aac: 'audio/aac',
        m4a: 'audio/mp4',
        ogg: 'audio/ogg',
      };

      const probed = await probeAdAudioAsset({
        id: audioId,
        filePath: req.file.path,
        fileName: req.file.filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype || mimeFallback[format] || 'audio/mpeg',
        format,
        url: `/ads/${req.file.filename}`,
      });

      await adManager.registerUploadedAudioAsset(probed);
      res.json({ audioAsset: probed });
    } catch (error) {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {
          // ignore
        }
      }
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Ошибка анализа рекламного аудиофайла.',
      });
    }
  });

  app.delete('/api/ads/audio/:audioId', (req, res) => {
    const deleted = adManager.deleteAudioAsset(req.params.audioId);
    res.json({ ok: true, deleted });
  });

  app.put('/api/ads/state', (req, res) => {
    try {
      const layers = Array.isArray(req.body?.layers) ? (req.body.layers as AdOverlayLayer[]) : [];
      const saved = adManager.updateLayers(layers);
      res.json({ layers: saved });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Ошибка сохранения рекламного слоя.',
      });
    }
  });

  app.post('/api/ads/presets', (req, res) => {
    try {
      const preset = req.body?.preset as AdPreset | undefined;
      if (!preset?.id || !preset?.name) {
        return res.status(400).json({ error: 'Некорректные данные рекламного пресета.' });
      }
      const presets = adManager.savePreset(preset);
      res.json({ presets });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Ошибка сохранения пресета рекламодателя.',
      });
    }
  });

  app.delete('/api/ads/presets/:presetId', (req, res) => {
    const presets = adManager.deletePreset(req.params.presetId);
    res.json({ presets });
  });

  app.get('/api/workspace/cleanup-plan', (req, res) => {
    try {
      const preserveAdPresets = req.query.preserveAdPresets !== 'false';
      const plan = buildServerCleanupPlan({
        rootDir: __dirname,
        storageDir: STORAGE_DIR,
        scope: 'production',
        preserveAdPresets,
      });
      res.json({ plan });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Ошибка построения списка очистки.',
      });
    }
  });

  app.post('/api/workspace/cleanup', async (req, res) => {
    try {
      if (req.body?.confirm !== true) {
        return res.status(400).json({
          error: 'Требуется явное подтверждение полной очистки рабочего пространства.',
        });
      }
      const preserveAdPresets = req.body?.preserveAdPresets !== false;
      const runningJob = Array.from(exportJobs.values()).find((j) => j.status === 'running');
      if (runningJob) {
        return res.status(409).json({
          error: `Сейчас выполняется экспорт (${runningJob.jobId}). Дождитесь завершения перед очисткой рабочего пространства.`,
        });
      }

      const report = await executeServerCleanup({
        rootDir: __dirname,
        storageDir: STORAGE_DIR,
        scope: 'production',
        preserveAdPresets,
        resetInMemoryState: ({ clearPresets }) => {
          for (const key of Object.keys(uploadedAssets) as SourceRole[]) {
            delete uploadedAssets[key];
          }
          for (const key of Object.keys(savedAssetRecords) as SourceRole[]) {
            delete savedAssetRecords[key];
          }
          activeLibraryItems.clear();
          savedLibraryRecords.clear();
          exportJobs.clear();
          adManager.resetInMemory({ clearPresets });
        },
        deleteCloudKey: async (relativeKey) => {
          await deleteCloudObject(relativeKey);
        },
      });
      res.json({ report });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Ошибка выполнения очистки сервера.',
      });
    }
  });

  app.get('/api/project-state', async (_req, res) => {
    try {
      const [preloaded, uploadedSync, librarySync, latestExport, exportHistory] = await Promise.all([
        getPreloadedAssets(),
        syncUploadedAssetsAvailability(),
        syncLibraryAvailability(),
        getLatestCompletedExport(),
        getExportHistory(),
      ]);
      res.json({
        preloaded,
        uploaded: uploadedSync.available,
        missingUploaded: uploadedSync.missing,
        library: librarySync.items,
        missingLibrary: librarySync.missingItems,
        latestExport,
        exportHistory,
        storage: getStorageEnvironmentInfo(),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Ошибка чтения активов' });
    }
  });

  app.get('/api/exports', async (_req, res) => {
    try {
      const [latestExport, exportHistory] = await Promise.all([
        getLatestCompletedExport(),
        getExportHistory(),
      ]);
      res.json({
        latestExport,
        exportHistory,
        storage: getStorageEnvironmentInfo(),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Ошибка проверки экспортов' });
    }
  });

  interface ChunkUploadSession {
    uploadId: string;
    mode: 'legacy' | 'library';
    role?: SourceRole;
    originalName: string;
    mimeType: string;
    totalSizeBytes: number;
    totalChunks: number;
    assignBothSlots: boolean;
    tempDir: string;
    createdAt: number;
  }

  const chunkUploadSessions = new Map<string, ChunkUploadSession>();

  const isFileReferencedElsewhere = (
    targetFilePath: string | undefined,
    excludedRoles: Set<SourceRole>,
    excludedLibraryIds: Set<string> = new Set(),
  ): boolean => {
    if (!targetFilePath) return false;
    const normalizedTarget = path.resolve(targetFilePath);
    for (const [r, rec] of Object.entries(savedAssetRecords)) {
      if (excludedRoles.has(r as SourceRole) || !rec?.filePath) continue;
      if (path.resolve(rec.filePath) === normalizedTarget) {
        return true;
      }
    }
    for (const [id, item] of savedLibraryRecords.entries()) {
      if (excludedLibraryIds.has(id) || !item?.filePath) continue;
      if (path.resolve(item.filePath) === normalizedTarget) {
        return true;
      }
    }
    return false;
  };

  const finalizeLibraryVideoUpload = async (params: {
    filePath: string;
    fileName: string;
    originalName: string;
    mimeType: string;
  }): Promise<SourceLibraryItem> => {
    const { filePath, fileName, originalName, mimeType } = params;
    const probe = await probeMedia(filePath);
    if (!probe.hasVideo) {
      if (fs.existsSync(filePath) && isInsideUploadsDir(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // ignore
        }
      }
      throw new Error(`Файл «${originalName}» не содержит видеодорожки.`);
    }

    const id = `src_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const metadata = parseSourceFilenameMetadata(originalName);
    const warnings: string[] = [];
    if (!probe.hasAudio) {
      warnings.push('В файле не обнаружена аудиодорожка.');
    }

    const item: SourceLibraryItem = {
      id,
      fileName,
      originalName,
      url: `/uploads/${fileName}`,
      filePath,
      mimeType,
      probe,
      warnings,
      uploadedAt: new Date().toISOString(),
      metadata,
    };

    savedLibraryRecords.set(id, item);
    activeLibraryItems.set(id, item);
    saveLibraryState();
    await uploadFileToCloud(filePath, `uploads/${fileName}`, mimeType || 'video/mp4');
    return item;
  };

  const finalizeUploadedClip = async (params: {
    role: SourceRole;
    filePath: string;
    fileName: string;
    originalName: string;
    mimeType: string;
    assignBothSlots: boolean;
  }): Promise<{
    asset: UploadedAsset;
    assignedAssets: Partial<Record<SourceRole, UploadedAsset>>;
  }> => {
    const { role, filePath, fileName, originalName, mimeType, assignBothSlots } = params;
    const probe = await probeMedia(filePath);

    const targetRoles: SourceRole[] =
      assignBothSlots && (role === 'fragment8' || role === 'fragment9')
        ? ['fragment8', 'fragment9']
        : [role];

    const targetRoleSet = new Set<SourceRole>(targetRoles);
    const obsoleteFiles = new Map<string, string>();
    for (const targetRole of targetRoles) {
      const previous = savedAssetRecords[targetRole];
      if (previous?.filePath && path.resolve(previous.filePath) !== path.resolve(filePath)) {
        if (!isFileReferencedElsewhere(previous.filePath, targetRoleSet)) {
          obsoleteFiles.set(path.resolve(previous.filePath), previous.fileName);
        }
      }
    }

    for (const [oldPath, oldFileName] of obsoleteFiles.entries()) {
      if (fs.existsSync(oldPath) && isInsideUploadsDir(oldPath)) {
        try {
          fs.unlinkSync(oldPath);
        } catch {
          // ignore cleanup failures
        }
      }
      if (oldFileName) {
        void deleteCloudObject(`uploads/${oldFileName}`);
      }
    }

    const assignedAssets: Partial<Record<SourceRole, UploadedAsset>> = {};
    for (const targetRole of targetRoles) {
      const asset: UploadedAsset = {
        role: targetRole,
        fileName,
        originalName,
        url: `/uploads/${fileName}`,
        filePath,
        probe,
        warnings: buildRoleWarnings(targetRole, probe),
      };
      uploadedAssets[targetRole] = asset;
      savedAssetRecords[targetRole] = asset;
      assignedAssets[targetRole] = asset;

      if (targetRole === 'fragment8' || targetRole === 'fragment9') {
        const legacyLibId = `src_legacy_${targetRole}`;
        const libItem: SourceLibraryItem = {
          id: legacyLibId,
          fileName,
          originalName,
          url: `/uploads/${fileName}`,
          filePath,
          mimeType,
          probe,
          warnings: asset.warnings,
          uploadedAt: new Date().toISOString(),
          legacyRole: targetRole,
          metadata: parseSourceFilenameMetadata(originalName),
        };
        savedLibraryRecords.set(legacyLibId, libItem);
        activeLibraryItems.set(legacyLibId, libItem);
      }
    }

    saveUploadedState();
    saveLibraryState();
    await uploadFileToCloud(filePath, `uploads/${fileName}`, mimeType || 'application/octet-stream');

    const primaryAsset = assignedAssets[role] ?? Object.values(assignedAssets)[0]!;
    return { asset: primaryAsset, assignedAssets };
  };

  // --- Source Video Library API ---
  app.get('/api/library', async (_req, res) => {
    try {
      const sync = await syncLibraryAvailability();
      res.json(sync);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Ошибка чтения библиотеки исходников.',
      });
    }
  });

  app.post('/api/library/upload', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'Видеофайл не получен.' });
      }
      const originalName = normalizeMulterOriginalName(req.file.originalname);
      if (!isAllowedVideoUpload(originalName, req.file.mimetype)) {
        if (fs.existsSync(req.file.path) && isInsideUploadsDir(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
        return res.status(400).json({
          error: 'Поддерживаются только видеофайлы (MP4, MOV, MKV, AVI, WEBM, M4V).',
        });
      }

      const item = await finalizeLibraryVideoUpload({
        filePath: req.file.path,
        fileName: req.file.filename,
        originalName,
        mimeType: req.file.mimetype || 'video/mp4',
      });
      res.json({ item });
    } catch (error) {
      if (req.file?.path && fs.existsSync(req.file.path) && isInsideUploadsDir(req.file.path)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {
          // ignore
        }
      }
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Ошибка загрузки видео в библиотеку.',
      });
    }
  });

  app.post('/api/library/upload/init', (req, res) => {
    try {
      const { originalName, mimeType, totalSizeBytes, totalChunks } = req.body as {
        originalName?: string;
        mimeType?: string;
        totalSizeBytes?: number;
        totalChunks?: number;
      };
      if (!originalName || typeof originalName !== 'string') {
        return res.status(400).json({ error: 'Не указано имя видеофайла.' });
      }
      if (!isAllowedVideoUpload(originalName, mimeType || 'video/mp4')) {
        return res.status(400).json({
          error: 'Поддерживаются только видеофайлы (MP4, MOV, MKV, AVI, WEBM, M4V).',
        });
      }
      if (!totalChunks || !Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 4000) {
        return res.status(400).json({ error: 'Некорректное количество фрагментов загрузки.' });
      }

      const uploadId = `libup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const tempDir = path.join(TEMP_DIR, uploadId);
      fs.mkdirSync(tempDir, { recursive: true });

      chunkUploadSessions.set(uploadId, {
        uploadId,
        mode: 'library',
        originalName: path.basename(originalName),
        mimeType: mimeType || 'video/mp4',
        totalSizeBytes: Number(totalSizeBytes ?? 0),
        totalChunks,
        assignBothSlots: false,
        tempDir,
        createdAt: Date.now(),
      });

      res.json({ uploadId });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Не удалось инициализировать загрузку видео.',
      });
    }
  });

  app.post(
    '/api/library/upload/chunk/:uploadId/:chunkIndex',
    express.raw({ type: 'application/octet-stream', limit: '8mb' }),
    (req, res) => {
      try {
        const { uploadId, chunkIndex } = req.params;
        if (!/^[a-zA-Z0-9_-]{4,80}$/.test(uploadId)) {
          return res.status(400).json({ error: 'Некорректный uploadId.' });
        }
        const session = chunkUploadSessions.get(uploadId);
        if (!session || session.mode !== 'library') {
          return res.status(404).json({ error: 'Сессия загрузки не найдена или истекла.' });
        }
        const idx = Number(chunkIndex);
        if (!Number.isInteger(idx) || idx < 0 || idx >= session.totalChunks) {
          return res.status(400).json({ error: 'Некорректный номер фрагмента загрузки.' });
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          return res.status(400).json({ error: 'Пустой фрагмент файла.' });
        }

        const partPath = path.join(session.tempDir, `chunk_${String(idx).padStart(6, '0')}.part`);
        fs.writeFileSync(partPath, req.body);
        res.json({ ok: true, index: idx, bytes: req.body.length });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Ошибка записи фрагмента файла на сервер.',
        });
      }
    },
  );

  app.post('/api/library/upload/complete', async (req, res) => {
    const { uploadId } = req.body as { uploadId?: string };
    if (!uploadId || !/^[a-zA-Z0-9_-]{4,80}$/.test(uploadId)) {
      return res.status(400).json({ error: 'Некорректный uploadId.' });
    }
    const session = chunkUploadSessions.get(uploadId);
    if (!session || session.mode !== 'library') {
      return res.status(404).json({ error: 'Сессия загрузки не найдена или уже завершена.' });
    }

    const ext = sanitizeVideoExtension(session.originalName);
    const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    const destPath = path.join(UPLOADS_DIR, fileName);

    try {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      const writeFd = fs.openSync(destPath, 'w');
      try {
        for (let i = 0; i < session.totalChunks; i += 1) {
          const partPath = path.join(session.tempDir, `chunk_${String(i).padStart(6, '0')}.part`);
          if (!fs.existsSync(partPath)) {
            throw new Error(`Отсутствует фрагмент загрузки #${i + 1} из ${session.totalChunks}.`);
          }
          const chunkBuf = fs.readFileSync(partPath);
          fs.writeSync(writeFd, chunkBuf);
        }
      } finally {
        fs.closeSync(writeFd);
      }

      const item = await finalizeLibraryVideoUpload({
        filePath: destPath,
        fileName,
        originalName: session.originalName,
        mimeType: session.mimeType,
      });

      res.json({ item });
    } catch (error) {
      if (fs.existsSync(destPath) && isInsideUploadsDir(destPath)) {
        try {
          fs.unlinkSync(destPath);
        } catch {
          // ignore
        }
      }
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Ошибка сборки загруженного видео.',
      });
    } finally {
      chunkUploadSessions.delete(uploadId);
      try {
        fs.rmSync(session.tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  app.patch('/api/library/:id', (req, res) => {
    const id = String(req.params.id ?? '');
    if (!isValidLibraryId(id)) {
      return res.status(400).json({ error: 'Некорректный идентификатор исходника.' });
    }
    const existing = savedLibraryRecords.get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Исходник в библиотеке не найден.' });
    }
    const updatedMetadata = reconcileSourceMetadata(req.body ?? {}, existing.metadata);
    const updated: SourceLibraryItem = {
      ...existing,
      metadata: updatedMetadata,
    };
    savedLibraryRecords.set(id, updated);
    if (activeLibraryItems.has(id)) {
      activeLibraryItems.set(id, updated);
    }
    saveLibraryState();
    res.json({ item: updated });
  });

  app.delete('/api/library/:id', (req, res) => {
    const id = String(req.params.id ?? '');
    if (!isValidLibraryId(id)) {
      return res.status(400).json({ error: 'Некорректный идентификатор исходника.' });
    }
    const existing = savedLibraryRecords.get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Исходник не найден в библиотеке.' });
    }

    const referencedElsewhere = isFileReferencedElsewhere(
      existing.filePath,
      new Set(existing.legacyRole ? [existing.legacyRole] : []),
      new Set([id]),
    );

    if (!referencedElsewhere && existing.filePath && isInsideUploadsDir(existing.filePath)) {
      if (fs.existsSync(existing.filePath)) {
        try {
          fs.unlinkSync(existing.filePath);
        } catch {
          // ignore unlink error
        }
      }
    }
    if (!referencedElsewhere && existing.fileName) {
      void deleteCloudObject(`uploads/${existing.fileName}`);
    }

    if (
      existing.legacyRole &&
      savedAssetRecords[existing.legacyRole]?.filePath &&
      path.resolve(savedAssetRecords[existing.legacyRole]!.filePath) === path.resolve(existing.filePath)
    ) {
      delete uploadedAssets[existing.legacyRole];
      delete savedAssetRecords[existing.legacyRole];
      saveUploadedState();
    }

    savedLibraryRecords.delete(id);
    activeLibraryItems.delete(id);
    saveLibraryState();
    res.json({ ok: true, deletedId: id });
  });

  app.post('/api/upload-clip', upload.single('file'), async (req, res) => {
    try {
      const role = req.body.role as SourceRole;
      if (!role || !['fragment8', 'fragment9', 'music', 'endplate', 'audioLogo'].includes(role)) {
        return res.status(400).json({ error: 'Неверная роль файла.' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'Файл не получен.' });
      }

      const assignBothSlots =
        req.body.assignBothSlots === 'true' || req.body.assignBothSlots === true;

      const result = await finalizeUploadedClip({
        role,
        filePath: req.file.path,
        fileName: req.file.filename,
        originalName: normalizeMulterOriginalName(req.file.originalname),
        mimeType: req.file.mimetype || 'application/octet-stream',
        assignBothSlots,
      });

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Ошибка анализа медиафайла' });
    }
  });

  app.post('/api/upload-clip/init', (req, res) => {
    try {
      const { role, originalName, mimeType, totalSizeBytes, totalChunks, assignBothSlots } = req.body as {
        role?: SourceRole;
        originalName?: string;
        mimeType?: string;
        totalSizeBytes?: number;
        totalChunks?: number;
        assignBothSlots?: boolean;
      };
      if (!role || !['fragment8', 'fragment9', 'music', 'endplate', 'audioLogo'].includes(role)) {
        return res.status(400).json({ error: 'Неверная роль файла.' });
      }
      if (!originalName || !totalChunks || totalChunks < 1 || totalChunks > 2000) {
        return res.status(400).json({ error: 'Некорректные параметры чанковой загрузки.' });
      }

      const uploadId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const tempDir = path.join(TEMP_DIR, uploadId);
      fs.mkdirSync(tempDir, { recursive: true });

      chunkUploadSessions.set(uploadId, {
        uploadId,
        mode: 'legacy',
        role,
        originalName,
        mimeType: mimeType || 'application/octet-stream',
        totalSizeBytes: Number(totalSizeBytes ?? 0),
        totalChunks,
        assignBothSlots: Boolean(assignBothSlots),
        tempDir,
        createdAt: Date.now(),
      });

      res.json({ uploadId });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Не удалось инициализировать загрузку файла.',
      });
    }
  });

  app.post(
    '/api/upload-clip/chunk/:uploadId/:chunkIndex',
    express.raw({ type: 'application/octet-stream', limit: '8mb' }),
    (req, res) => {
      try {
        const { uploadId, chunkIndex } = req.params;
        const session = chunkUploadSessions.get(uploadId);
        if (!session) {
          return res.status(404).json({ error: 'Сессия загрузки не найдена или истекла.' });
        }
        const idx = Number(chunkIndex);
        if (!Number.isInteger(idx) || idx < 0 || idx >= session.totalChunks) {
          return res.status(400).json({ error: 'Некорректный номер фрагмента загрузки.' });
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          return res.status(400).json({ error: 'Пустой фрагмент файла.' });
        }

        const partPath = path.join(session.tempDir, `chunk_${String(idx).padStart(6, '0')}.part`);
        fs.writeFileSync(partPath, req.body);
        res.json({ ok: true, index: idx, bytes: req.body.length });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Ошибка записи фрагмента файла на сервер.',
        });
      }
    },
  );

  app.post('/api/upload-clip/complete', async (req, res) => {
    const { uploadId } = req.body as { uploadId?: string };
    if (!uploadId) {
      return res.status(400).json({ error: 'Не указан uploadId.' });
    }
    const session = chunkUploadSessions.get(uploadId);
    if (!session) {
      return res.status(404).json({ error: 'Сессия загрузки не найдена или уже завершена.' });
    }

    const ext = path.extname(session.originalName) || '.mp4';
    const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    const destPath = path.join(UPLOADS_DIR, fileName);

    try {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      const writeFd = fs.openSync(destPath, 'w');
      try {
        for (let i = 0; i < session.totalChunks; i += 1) {
          const partPath = path.join(session.tempDir, `chunk_${String(i).padStart(6, '0')}.part`);
          if (!fs.existsSync(partPath)) {
            throw new Error(`Отсутствует фрагмент загрузки #${i + 1} из ${session.totalChunks}.`);
          }
          const chunkBuf = fs.readFileSync(partPath);
          fs.writeSync(writeFd, chunkBuf);
        }
      } finally {
        fs.closeSync(writeFd);
      }

      const result = await finalizeUploadedClip({
        role: session.role!,
        filePath: destPath,
        fileName,
        originalName: session.originalName,
        mimeType: session.mimeType,
        assignBothSlots: session.assignBothSlots,
      });

      res.json(result);
    } catch (error) {
      if (fs.existsSync(destPath)) {
        try {
          fs.unlinkSync(destPath);
        } catch {
          // ignore
        }
      }
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Ошибка сборки загруженного файла.',
      });
    } finally {
      chunkUploadSessions.delete(uploadId);
      try {
        fs.rmSync(session.tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  app.post('/api/upload-clip/assign-both', async (req, res) => {
    try {
      const { fromRole } = req.body as { fromRole?: 'fragment8' | 'fragment9' };
      if (fromRole !== 'fragment8' && fromRole !== 'fragment9') {
        return res.status(400).json({ error: 'Неверная исходная роль видео.' });
      }
      const source = uploadedAssets[fromRole] ?? savedAssetRecords[fromRole];
      if (!source || !isValidNonEmptyFile(source.filePath).exists) {
        return res.status(404).json({ error: 'Исходный видеофайл не найден на сервере.' });
      }

      const targetRole: 'fragment8' | 'fragment9' =
        fromRole === 'fragment8' ? 'fragment9' : 'fragment8';

      const prevOther = savedAssetRecords[targetRole];
      if (
        prevOther?.filePath &&
        path.resolve(prevOther.filePath) !== path.resolve(source.filePath) &&
        !isFileReferencedElsewhere(prevOther.filePath, new Set([targetRole]))
      ) {
        if (fs.existsSync(prevOther.filePath)) {
          try {
            fs.unlinkSync(prevOther.filePath);
          } catch {
            // ignore
          }
        }
        if (prevOther.fileName) {
          void deleteCloudObject(`uploads/${prevOther.fileName}`);
        }
      }

      const mirroredAsset: UploadedAsset = {
        ...source,
        role: targetRole,
        warnings: buildRoleWarnings(targetRole, source.probe),
      };
      uploadedAssets[fromRole] = source;
      uploadedAssets[targetRole] = mirroredAsset;
      savedAssetRecords[fromRole] = source;
      savedAssetRecords[targetRole] = mirroredAsset;
      saveUploadedState();

      res.json({
        assignedAssets: {
          [fromRole]: source,
          [targetRole]: mirroredAsset,
        },
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Не удалось назначить файл обоим слотам.',
      });
    }
  });

  app.delete('/api/upload-clip/:role', (req, res) => {
    const role = req.params.role as SourceRole;
    const existing = savedAssetRecords[role] ?? uploadedAssets[role];
    const legacyLibId = `src_legacy_${role}`;
    const sharedElsewhere = isFileReferencedElsewhere(
      existing?.filePath,
      new Set([role]),
      new Set([legacyLibId]),
    );

    if (!sharedElsewhere && existing && isInsideUploadsDir(existing.filePath) && fs.existsSync(existing.filePath)) {
      try {
        fs.unlinkSync(existing.filePath);
      } catch {
        // ignore
      }
    }
    if (!sharedElsewhere && existing?.fileName) {
      void deleteCloudObject(`uploads/${existing.fileName}`);
    }
    delete uploadedAssets[role];
    delete savedAssetRecords[role];
    savedLibraryRecords.delete(legacyLibId);
    activeLibraryItems.delete(legacyLibId);
    saveUploadedState();
    saveLibraryState();
    res.json({ ok: true });
  });

  app.post('/api/transcribe', async (req, res) => {
    try {
      const { segments } = req.body as { segments: CutSegment[] };
      if (!Array.isArray(segments) || segments.length === 0) {
        return res.status(400).json({ error: 'Добавьте монтажные сегменты перед распознаванием речи.' });
      }
      const workDir = path.join(TEMP_DIR, `tx_${Date.now()}`);
      const mergedAudio = await extractTimelineAudioForTranscription({
        segments,
        assets: {
          fragment8: uploadedAssets.fragment8,
          fragment9: uploadedAssets.fragment9,
        },
        libraryItems: Array.from(activeLibraryItems.values()),
        workDir,
      });

      const result = await transcribeAudioToSubtitles(mergedAudio);
      fs.rmSync(workDir, { recursive: true, force: true });
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Ошибка распознавания речи.',
      });
    }
  });

  app.post('/api/export', (req, res) => {
    try {
      const payload = req.body as ExportRequestPayload;

      if (!Array.isArray(payload.segments) || payload.segments.length === 0) {
        return res.status(400).json({ error: 'Таймлайн пуст. Добавьте хотя бы один сегмент.' });
      }

      const librarySnapshot = Array.from(activeLibraryItems.values());
      const assetsSnapshot = { ...uploadedAssets };

      for (const seg of payload.segments) {
        const resolved = resolveSegmentMediaAsset(seg, librarySnapshot, assetsSnapshot);
        if (!resolved) {
          const fallbackLabel = seg.sourceId
            ? `исходник ${seg.sourceId}`
            : seg.sourceRole === 'fragment8'
              ? 'Фрагмент 8'
              : seg.sourceRole === 'fragment9'
                ? 'Фрагмент 9'
                : 'источник не выбран';
          return res.status(400).json({
            error: `Отсутствует исходный видеофайл для сегмента «${seg.beatTitle}» (${fallbackLabel}). Выберите или загрузите видео в библиотеке перед экспортом.`,
          });
        }
      }

      const endplateDur = Math.min(2.0, Math.max(1.5, Number(payload.endplateDurationSec) || 2.0));

      let endplatePath = path.join(AISTUDIO_ASSETS_DIR, 'shorts-04-final-cta_bbd9e262.png');
      let endplateIsVideo = false;
      if (payload.endplateAssetId === 'uploaded:endplate' && uploadedAssets.endplate) {
        endplatePath = uploadedAssets.endplate.filePath;
        endplateIsVideo =
          uploadedAssets.endplate.probe.hasVideo &&
          !['png', 'mjpeg', 'webp'].includes(uploadedAssets.endplate.probe.videoCodec ?? '');
      } else if (payload.endplateAssetId) {
        const preloadedEndplate = PRELOADED_DEFINITIONS.find(
          (d) => d.id === payload.endplateAssetId && d.kind === 'image',
        );
        if (preloadedEndplate) {
          const candidatePath = path.join(AISTUDIO_ASSETS_DIR, preloadedEndplate.fileName);
          if (fs.existsSync(candidatePath)) {
            endplatePath = candidatePath;
          }
        }
      }

      let audioLogoPath = path.join(AISTUDIO_ASSETS_DIR, '__________________14455776.wav');
      if (payload.audioLogoAssetId === 'uploaded:audioLogo' && uploadedAssets.audioLogo) {
        audioLogoPath = uploadedAssets.audioLogo.filePath;
      }

      const overlayPathMap: Record<string, string> = {};
      const overlayPlacementMap: Record<string, OverlayPlacementMode> = {};
      for (const def of PRELOADED_DEFINITIONS) {
        if (def.kind === 'image') {
          overlayPathMap[def.id] = path.join(AISTUDIO_ASSETS_DIR, def.fileName);
          if (def.overlayPlacement) {
            overlayPlacementMap[def.id] = def.overlayPlacement;
          }
        }
      }

      const resolvedShortNumber = normalizeShortNumber(payload.shortNumber, 1);
      const jobId = `job_${Date.now()}`;
      const jobDir = path.join(EXPORTS_DIR, jobId);
      const now = new Date().toISOString();

      const jobState: ExportJobStatus = {
        jobId,
        shortNumber: resolvedShortNumber,
        status: 'running',
        stageIndex: 0,
        totalStages: 6,
        stageLabel: 'Инициализация задачи экспорта',
        detail: 'Проверка исходных файлов и подготовка FFmpeg',
        startedAt: now,
        updatedAt: now,
      };
      exportJobs.set(jobId, jobState);
      saveJobStatus(jobState);

      void renderDualShortsExport({
        jobId,
        shortNumber: resolvedShortNumber,
        jobDir,
        exportBaseUrl: '/api/download-export',
        segments: payload.segments,
        subtitles: payload.subtitles ?? [],
        assets: assetsSnapshot,
        libraryItems: librarySnapshot,
        overlayPathMap,
        overlayPlacementMap,
        endplatePath,
        endplateIsVideo,
        endplateDurationSec: endplateDur,
        audioLogoPath,
        useUploadedMusic: Boolean(payload.useUploadedMusic),
        musicGainDb: Number(payload.musicGainDb ?? -22),
        includeVersionB: payload.includeVersionB !== false,
        adLayers: Array.isArray(payload.adLayers) ? payload.adLayers : [],
        adAssetsMap: adManager.getAssetPathMap(),
        adAudioAssetsMap: adManager.getAudioAssetPathMap(),
        onProgress: (stageIndex, totalStages, stageLabel, detail) => {
          const cur = exportJobs.get(jobId);
          if (!cur || cur.status !== 'running') return;
          const next: ExportJobStatus = {
            ...cur,
            stageIndex,
            totalStages,
            stageLabel,
            detail,
            updatedAt: new Date().toISOString(),
          };
          exportJobs.set(jobId, next);
          saveJobStatus(next);
        },
      })
        .then(async (result) => {
          const uploads = [
            uploadFileToCloud(path.join(jobDir, 'version_a.mp4'), `exports/${jobId}/version_a.mp4`, 'video/mp4'),
          ];
          if (result.versionB) {
            uploads.push(
              uploadFileToCloud(path.join(jobDir, 'version_b.mp4'), `exports/${jobId}/version_b.mp4`, 'video/mp4'),
            );
          }
          await Promise.all(uploads);

          const cur = exportJobs.get(jobId);
          const done: ExportJobStatus = {
            ...(cur ?? jobState),
            status: 'completed',
            stageIndex: 6,
            totalStages: 6,
            stageLabel: 'Экспорт завершён',
            detail: result.versionB
              ? 'Готовы файлы Версия А и Версия Б (MP4, H.264/AAC)'
              : 'Готов файл Версия А (MP4, H.264/AAC)',
            updatedAt: new Date().toISOString(),
            result,
          };
          exportJobs.set(jobId, done);
          saveJobStatus(done);
          await uploadFileToCloud(path.join(jobDir, 'status.json'), `exports/${jobId}/status.json`, 'application/json');
        })
        .catch((err) => {
          const cur = exportJobs.get(jobId);
          const failed: ExportJobStatus = {
            ...(cur ?? jobState),
            status: 'failed',
            updatedAt: new Date().toISOString(),
            error: err instanceof Error ? err.message : 'Ошибка сборки видео в FFmpeg.',
          };
          exportJobs.set(jobId, failed);
          saveJobStatus(failed);
        });

      res.status(202).json({ job: jobState });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Ошибка запуска задачи экспорта.',
      });
    }
  });

  app.get('/api/export/:jobId', (req, res) => {
    const job = readJobStatus(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Задача экспорта не найдена.' });
    }
    res.json({ job });
  });

  const handleExportDownload = async (req: express.Request, res: express.Response) => {
    const jobId = String(req.params.jobId ?? '');
    const file = String(req.params.file ?? '');
    if (!/^job_\d+$/.test(jobId) || !['version_a.mp4', 'version_b.mp4'].includes(file)) {
      return res.status(400).json({ error: 'Некорректный путь к файлу экспорта.' });
    }
    const targetPath = path.join(EXPORTS_DIR, jobId, file);
    let fileCheck = isValidNonEmptyFile(targetPath);

    if (!fileCheck.exists) {
      const restored = await restoreFileFromCloud(`exports/${jobId}/${file}`, targetPath);
      if (restored) {
        fileCheck = isValidNonEmptyFile(targetPath);
      }
    }

    if (!fileCheck.exists) {
      return res.status(404).json({
        error:
          'Файл экспорта отсутствует на сервере (возможно, временное хранилище контейнера Cloud Run было очищено при перезапуске).',
        code: 'EXPORT_FILE_MISSING',
      });
    }

    const totalSize = fileCheck.sizeBytes;
    const jobStatus = readJobStatus(jobId);
    const downloadName = resolveExportDownloadFileName({
      file: file as 'version_a.mp4' | 'version_b.mp4',
      jobStatus,
    });

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-File-Size', String(totalSize));

    if (req.method === 'HEAD') {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      res.setHeader('Content-Length', String(totalSize));
      return res.status(200).end();
    }

    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (!match) {
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        return res.status(416).json({ error: 'Некорректный заголовок Range.' });
      }

      const start = match[1] ? Number.parseInt(match[1], 10) : 0;
      const requestedEnd = match[2] ? Number.parseInt(match[2], 10) : totalSize - 1;
      const end = Math.min(requestedEnd, totalSize - 1);

      if (
        Number.isNaN(start) ||
        Number.isNaN(end) ||
        start < 0 ||
        start >= totalSize ||
        end < start
      ) {
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        return res.status(416).json({ error: 'Запрошенный диапазон байтов выходит за пределы файла.' });
      }

      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      res.setHeader('Content-Length', String(chunkSize));

      const stream = fs.createReadStream(targetPath, { start, end });
      req.on('close', () => {
        stream.destroy();
      });
      stream.on('error', () => {
        if (!res.headersSent) {
          res.status(500).json({ error: 'Ошибка чтения фрагмента MP4-файла.' });
        } else {
          res.destroy();
        }
      });
      stream.pipe(res);
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.setHeader('Content-Length', String(totalSize));
    const stream = fs.createReadStream(targetPath);
    req.on('close', () => {
      stream.destroy();
    });
    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Ошибка потокового чтения MP4-файла.' });
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  };

  app.head('/api/download-export/:jobId/:file', handleExportDownload);
  app.get('/api/download-export/:jobId/:file', handleExportDownload);

  app.post('/api/generate-cover', async (req, res) => {
    try {
      const { prompt, imageSize, aspectRatio } = req.body as {
        prompt?: string;
        imageSize?: ImageSizeOption;
        aspectRatio?: AspectRatioOption;
      };
      if (!prompt || !prompt.trim()) {
        return res.status(400).json({ error: 'Введите описание обложки для генерации.' });
      }
      const allowedSizes: ImageSizeOption[] = ['1K', '2K', '4K'];
      const allowedRatios: AspectRatioOption[] = ['9:16', '16:9', '1:1'];
      const size: ImageSizeOption = allowedSizes.includes(imageSize as ImageSizeOption)
        ? (imageSize as ImageSizeOption)
        : '1K';
      const ratio: AspectRatioOption = allowedRatios.includes(aspectRatio as AspectRatioOption)
        ? (aspectRatio as AspectRatioOption)
        : '9:16';

      const result = await generateCoverArtwork({
        prompt,
        imageSize: size,
        aspectRatio: ratio,
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Ошибка генерации обложки.',
      });
    }
  });

  app.post('/api/auto-frame', async (req, res) => {
    try {
      const { segments } = req.body as {
        segments?: Array<{
          id: string;
          sourceId?: string;
          sourceRole?: 'fragment8' | 'fragment9';
          startSec: number;
          endSec: number;
        }>;
      };
      if (!Array.isArray(segments) || segments.length === 0) {
        return res.json({ results: {} });
      }

      const librarySnapshot = Array.from(activeLibraryItems.values());
      const results: Record<string, SegmentAutoFrameResult> = {};
      for (const seg of segments) {
        const asset = resolveSegmentMediaAsset(seg, librarySnapshot, uploadedAssets);
        if (!asset || !fs.existsSync(asset.filePath)) continue;
        const startSec = Math.max(0, Number(seg.startSec) || 0);
        const endSec = Math.min(
          asset.probe.durationSec || Number(seg.endSec) || startSec + 1,
          Math.max(startSec + 0.2, Number(seg.endSec) || startSec + 1),
        );
        if (endSec - startSec < 0.2) continue;
        try {
          results[seg.id] = await analyzeSegmentAutoFraming({
            filePath: asset.filePath,
            sizeBytes: asset.probe.sizeBytes,
            srcWidth: asset.probe.width || 1920,
            srcHeight: asset.probe.height || 1080,
            startSec,
            endSec,
            segmentId: seg.id,
          });
        } catch {
          // skip failed single segment analysis without failing whole request
        }
      }
      res.json({ results });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Ошибка автоматического анализа кадрирования.',
      });
    }
  });

  // Always return JSON (never HTML) for errors inside /api/* routes
  app.use('/api', (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : 'Внутренняя ошибка API сервера.';
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    const distIndexPath = path.join(distDir, 'index.html');
    app.use(
      express.static(distDir, {
        setHeaders: (res, filePath) => {
          if (path.resolve(filePath) === path.resolve(distIndexPath)) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
          }
        },
      }),
    );
    app.get('/{*path}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.sendFile(distIndexPath);
    });
  }

  const port = Number(process.env.STUDIO_PORT) || 3000;
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${port}`);
  });
  server.requestTimeout = 0;
  server.headersTimeout = 120000;
}

startServer();
