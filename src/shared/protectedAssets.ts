import type { ProtectedResourceEntry, ProtectedResourceKind } from '../types.ts';

export const WORKSPACE_LOCAL_STORAGE_PREFIX = 'delo_v_kadre_workspace_';
export const APP_TECHNICAL_SETTINGS_KEY = 'delo_v_kadre_app_settings_v1';

export const PROTECTED_RESOURCE_CATEGORIES: Record<
  ProtectedResourceKind,
  { label: string; description: string }
> = {
  'brand-audio': {
    label: 'Звуки',
    description: 'Фирменные звуковые логотипы, отбивки и постоянные аудиоэффекты канала',
  },
  'brand-font': {
    label: 'Шрифты',
    description: 'Конфигурации и файлы фирменной типографики и субтитров',
  },
  'brand-intro-outro': {
    label: 'Заставки',
    description: 'Постоянные шаблоны финальных и стартовых заставок канала',
  },
  'brand-image': {
    label: 'Изображения',
    description: 'Постоянные титульные карточки, фоны и фото-шаблоны бренда',
  },
  'brand-transition': {
    label: 'Переходы',
    description: 'Фирменные переходы между сценами (медиафайлы и пресеты переходов)',
  },
  'brand-animation': {
    label: 'Анимации',
    description: 'Постоянные брендовые анимированные плашки, титры и оверлеи',
  },
  'brand-graphic': {
    label: 'Графические элементы',
    description: 'Рамки субтитров, акцентные плашки, логотипы и элементы оформления',
  },
  'app-config': {
    label: 'Настройки приложения',
    description: 'Технические параметры интерфейса и конфигурации студии',
  },
};

export const PROTECTED_BRAND_RESOURCES: ProtectedResourceEntry[] = [
  {
    id: 'preloaded:audio-logo',
    kind: 'brand-audio',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-audio'].label,
    label: 'Фирменный звуковой логотип (WAV)',
    relativePath: 'public/assets/aistudio/__________________14455776.wav',
    storageScope: 'server-public',
    protected: true,
    reason: 'Постоянный фирменный аудиологотип канала «ДЕЛО В КАДРЕ»',
  },
  {
    id: 'preloaded:shorts-04',
    kind: 'brand-intro-outro',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-intro-outro'].label,
    label: 'Финальная заставка-шаблон (shorts-04)',
    relativePath: 'public/assets/aistudio/shorts-04-final-cta_bbd9e262.png',
    storageScope: 'server-public',
    protected: true,
    reason: 'Постоянный фирменный шаблон концовки канала',
  },
  {
    id: 'preloaded:shorts-01',
    kind: 'brand-image',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-image'].label,
    label: 'Титульный шаблон (shorts-01)',
    relativePath: 'public/assets/aistudio/shorts-01-title-card_0a7f7883.png',
    storageScope: 'server-public',
    protected: true,
    reason: 'Постоянный фирменный титр-шаблон канала',
  },
  {
    id: 'preloaded:shorts-02',
    kind: 'brand-graphic',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-graphic'].label,
    label: 'Рамка субтитров (shorts-02)',
    relativePath: 'public/assets/aistudio/shorts-02-scene-subtitles_4b7a4edb.png',
    storageScope: 'server-public',
    protected: true,
    reason: 'Постоянный фирменный графический шаблон рамки субтитров',
  },
  {
    id: 'preloaded:shorts-03',
    kind: 'brand-graphic',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-graphic'].label,
    label: 'Акцент-шаблон (shorts-03)',
    relativePath: 'public/assets/aistudio/shorts-03-plot-twist-accent_acecf962.png',
    storageScope: 'server-public',
    protected: true,
    reason: 'Постоянный фирменный акцент-элемент оформления',
  },
  {
    id: 'preloaded:overlay-corner-marks',
    kind: 'brand-graphic',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-graphic'].label,
    label: 'Оверлей угловых рамок 9:16 (corner-marks)',
    relativePath: 'public/assets/aistudio/shorts-overlay-corner-marks_140c6f21.png',
    storageScope: 'server-public',
    protected: true,
    reason: 'Постоянный прозрачный графический оверлей рамок видоискателя 9:16',
  },
  {
    id: 'preloaded:rubric-dopros-marker',
    kind: 'brand-graphic',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-graphic'].label,
    label: 'Плашка рубрики «ДОПРОС» (маркер)',
    relativePath: 'public/assets/aistudio/rubric-01-dopros-marker_f108d902.png',
    storageScope: 'server-public',
    protected: true,
    reason: 'Постоянный маркер рубрики «ДОПРОС»',
  },
  {
    id: 'preloaded:rubric-dopros-title',
    kind: 'brand-intro-outro',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-intro-outro'].label,
    label: 'Титровая заставка «ДОПРОС» (1080×1920)',
    relativePath: 'public/assets/aistudio/rubric-01-dopros-title_d285a688.png',
    storageScope: 'server-public',
    protected: true,
    reason: 'Постоянная титровая карточка рубрики «ДОПРОС»',
  },
  {
    id: 'preloaded:rubric-povorot-marker',
    kind: 'brand-graphic',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-graphic'].label,
    label: 'Плашка рубрики «ПОВОРОТ ДЕЛА» (маркер)',
    relativePath: 'public/assets/aistudio/rubric-02-povorot-dela-marker_b282cd9e.png',
    storageScope: 'server-public',
    protected: true,
    reason: 'Постоянный маркер рубрики «ПОВОРОТ ДЕЛА»',
  },
  {
    id: 'preloaded:rubric-povorot-title',
    kind: 'brand-intro-outro',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-intro-outro'].label,
    label: 'Титровая заставка «ПОВОРОТ ДЕЛА» (1080×1920)',
    relativePath: 'public/assets/aistudio/rubric-02-povorot-dela-title_89f5a12a.png',
    storageScope: 'server-public',
    protected: true,
    reason: 'Постоянная титровая карточка рубрики «ПОВОРОТ ДЕЛА»',
  },
  {
    id: 'preloaded:rubric-zagadka-marker',
    kind: 'brand-graphic',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-graphic'].label,
    label: 'Плашка рубрики «КРИМИНАЛЬНАЯ ЗАГАДКА» (маркер)',
    relativePath: 'public/assets/aistudio/rubric-03-kriminalnaya-zagadka-marker_065519fd.png',
    storageScope: 'server-public',
    protected: true,
    reason: 'Постоянный маркер рубрики «КРИМИНАЛЬНАЯ ЗАГАДКА»',
  },
  {
    id: 'preloaded:rubric-zagadka-title',
    kind: 'brand-intro-outro',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-intro-outro'].label,
    label: 'Титровая заставка «КРИМИНАЛЬНАЯ ЗАГАДКА» (1080×1920)',
    relativePath: 'public/assets/aistudio/rubric-03-kriminalnaya-zagadka-title_f06d4097.png',
    storageScope: 'server-public',
    protected: true,
    reason: 'Постоянная титровая карточка рубрики «КРИМИНАЛЬНАЯ ЗАГАДКА»',
  },
  {
    id: 'preloaded:subtitle-basic',
    kind: 'brand-graphic',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-graphic'].label,
    label: 'Плашка субтитров: базовая (shorts-subtitle-basic)',
    relativePath: 'public/assets/aistudio/shorts-subtitle-basic_1cf29ce7.png',
    storageScope: 'server-public',
    protected: true,
    reason: 'Постоянный графический шаблон базовой плашки субтитров',
  },
  {
    id: 'preloaded:subtitle-accent',
    kind: 'brand-graphic',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-graphic'].label,
    label: 'Плашка субтитров: акцент (shorts-subtitle-accent)',
    relativePath: 'public/assets/aistudio/shorts-subtitle-accent_789e04f0.png',
    storageScope: 'server-public',
    protected: true,
    reason: 'Постоянный графический шаблон акцентной плашки субтитров',
  },
  {
    id: 'preloaded:subtitle-document',
    kind: 'brand-graphic',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-graphic'].label,
    label: 'Плашка «Из материалов дела» (shorts-subtitle-document)',
    relativePath: 'public/assets/aistudio/shorts-subtitle-document_7d25a4b5.png',
    storageScope: 'server-public',
    protected: true,
    reason: 'Постоянная графическая плашка «Из материалов дела»',
  },
  {
    id: 'preloaded:subtitle-two-lines',
    kind: 'brand-graphic',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-graphic'].label,
    label: 'Плашка субтитров: 2 строки (shorts-subtitle-two-lines)',
    relativePath: 'public/assets/aistudio/shorts-subtitle-two-lines_a90117ba.png',
    storageScope: 'server-public',
    protected: true,
    reason: 'Постоянный графический шаблон двухстрочной плашки субтитров',
  },
  {
    id: 'preloaded:logo-horizontal-primary',
    kind: 'brand-image',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-image'].label,
    label: 'Основной горизонтальный логотип «ДЕЛО В КАДРЕ»',
    relativePath: 'public/assets/aistudio/01-main-logo-horizontal-primary_67a20df9.png',
    storageScope: 'server-public',
    protected: true,
    reason: 'Постоянный основной логотип канала',
  },
  {
    id: 'preloaded:logo-horizontal-dark',
    kind: 'brand-image',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-image'].label,
    label: 'Горизонтальный логотип (монохром тёмный)',
    relativePath: 'public/assets/aistudio/03-logo-horizontal-mono-dark_0c5105cc.png',
    storageScope: 'server-public',
    protected: true,
    reason: 'Постоянный монохромный тёмный логотип канала',
  },
  {
    id: 'preloaded:logo-horizontal-light',
    kind: 'brand-image',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-image'].label,
    label: 'Горизонтальный логотип (монохром светлый)',
    relativePath: 'public/assets/aistudio/03-logo-horizontal-mono-light_c71ba116.png',
    storageScope: 'server-public',
    protected: true,
    reason: 'Постоянный светлый логотип для тёмных фонов и видео',
  },
  {
    id: 'preloaded:symbol-primary',
    kind: 'brand-graphic',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-graphic'].label,
    label: 'Фирменный знак-папка бренда (symbol-only)',
    relativePath: 'public/assets/aistudio/04-symbol-only-primary_c71406cc.png',
    storageScope: 'server-public',
    protected: true,
    reason: 'Постоянный графический знак канала «ДЕЛО В КАДРЕ»',
  },
  {
    id: 'preloaded:youtube-avatar',
    kind: 'brand-image',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-image'].label,
    label: 'Аватар YouTube-канала (1200×1200)',
    relativePath: 'public/assets/aistudio/02-compact-sign-youtube-avatar_68ec7525.png',
    storageScope: 'server-public',
    protected: true,
    reason: 'Постоянный аватар YouTube-канала «ДЕЛО В КАДРЕ»',
  },
  {
    id: 'preloaded:youtube-banner',
    kind: 'brand-image',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-image'].label,
    label: 'Баннер YouTube-канала (2560×1440)',
    relativePath: 'public/assets/aistudio/youtube-banner-delo-v-kadre-2560x1440_675a6c72.png',
    storageScope: 'server-public',
    protected: true,
    reason: 'Постоянная шапка YouTube-канала «ДЕЛО В КАДРЕ»',
  },
  {
    id: 'brand-font:noto-sans',
    kind: 'brand-font',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['brand-font'].label,
    label: 'Шрифтовая конфигурация субтитров (Noto Sans Bold)',
    relativePath: 'src/server/ffmpegPipeline.ts',
    storageScope: 'app-config',
    protected: true,
    reason: 'Встроенная типографика субтитров и конвейера FFmpeg',
  },
  {
    id: 'app-config:technical-settings',
    kind: 'app-config',
    categoryLabel: PROTECTED_RESOURCE_CATEGORIES['app-config'].label,
    label: 'Технические настройки интерфейса студии',
    relativePath: APP_TECHNICAL_SETTINGS_KEY,
    storageScope: 'browser-settings',
    protected: true,
    reason: 'Параметры работы приложения (зоны Shorts, интерфейс), не привязанные к выпуску',
  },
];

export function normalizeCanonicalPath(inputPath: string): string {
  return inputPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

/**
 * Ensures source videos, exported MP4s, temporary files, and release ad media
 * can NEVER be added into the protected brand registry.
 */
export function isForbiddenProtectedCandidate(relativePath: string): boolean {
  const normalized = normalizeCanonicalPath(relativePath).toLowerCase();
  if (!normalized) return true;
  if (
    normalized.startsWith('storage/uploads/') ||
    normalized.startsWith('storage/exports/') ||
    normalized.startsWith('storage/temp/') ||
    normalized.startsWith('storage/ads/') ||
    normalized === 'storage/uploaded_state.json' ||
    normalized === 'storage/library_state.json' ||
    normalized === 'storage/ad_state.json'
  ) {
    return true;
  }
  return false;
}

/**
 * Returns the complete validated list of permanent protected resources.
 * New entries added to PROTECTED_BRAND_RESOURCES (or passed via extraEntries)
 * in any of the 7 brand categories are protected automatically without modifying cleanup logic.
 */
export function getProtectedBrandResources(
  extraEntries: ProtectedResourceEntry[] = [],
): ProtectedResourceEntry[] {
  const seenIds = new Set<string>();
  const combined: ProtectedResourceEntry[] = [];

  for (const entry of [...PROTECTED_BRAND_RESOURCES, ...extraEntries]) {
    if (entry.protected !== true) continue;
    if (
      entry.storageScope !== 'browser-settings' &&
      isForbiddenProtectedCandidate(entry.relativePath)
    ) {
      continue;
    }
    if (seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);
    combined.push({
      ...entry,
      categoryLabel:
        entry.categoryLabel ?? PROTECTED_RESOURCE_CATEGORIES[entry.kind]?.label ?? entry.kind,
    });
  }

  return combined;
}

export function isProtectedRelativePath(
  candidateRelativePath: string,
  extraProtected: ProtectedResourceEntry[] = [],
): boolean {
  const normalized = normalizeCanonicalPath(candidateRelativePath);
  if (!normalized) return false;

  // Never mark release-specific temporary paths as protected
  if (isForbiddenProtectedCandidate(normalized)) {
    return false;
  }

  const registry = getProtectedBrandResources(extraProtected);
  for (const entry of registry) {
    if (
      entry.storageScope === 'server-public' ||
      entry.storageScope === 'server-persistent' ||
      entry.storageScope === 'app-config'
    ) {
      if (normalized === normalizeCanonicalPath(entry.relativePath)) {
        return true;
      }
    }
  }

  // Never allow deletion outside storage/ (e.g. public/, src/, server.ts, package.json)
  if (
    normalized === 'public' ||
    normalized.startsWith('public/') ||
    normalized === 'src' ||
    normalized.startsWith('src/') ||
    normalized === 'server.ts' ||
    normalized === 'package.json' ||
    normalized === 'index.html'
  ) {
    return true;
  }

  return false;
}

export function isProtectedBrowserKey(
  key: string,
  extraProtected: ProtectedResourceEntry[] = [],
): boolean {
  if (key === APP_TECHNICAL_SETTINGS_KEY) return true;
  const registry = getProtectedBrandResources(extraProtected);
  for (const entry of registry) {
    if (entry.storageScope === 'browser-settings' && entry.relativePath === key) {
      return true;
    }
  }
  return false;
}

export function findProtectedOverlap(
  candidatePaths: string[],
  extraProtected: ProtectedResourceEntry[] = [],
): string[] {
  const overlaps: string[] = [];
  for (const candidate of candidatePaths) {
    if (isProtectedRelativePath(candidate, extraProtected)) {
      overlaps.push(candidate);
    }
  }
  return overlaps;
}
