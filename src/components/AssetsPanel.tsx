import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Edit3,
  Film,
  FolderOpen,
  HardDrive,
  Layers,
  Loader2,
  RefreshCw,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { StorageStatusCard } from './StorageStatusCard.tsx';
import {
  formatEpisodeLabel,
  sortLibrarySources,
  type LibrarySortMode,
} from '../shared/sourceLibrary.ts';
import type {
  BrowserVaultDiagnostics,
  MissingLibrarySource,
  MissingUploadedAsset,
  PreloadedOverlay,
  SourceLibraryItem,
  SourceRole,
  SourceVideoMetadata,
  StorageEnvironmentInfo,
  UploadedAsset,
} from '../types.ts';
import {
  deleteLibrarySourceFromVault,
  deleteSourceFromVault,
  formatBytesRu,
  saveLibrarySourceToVault,
  saveSourceToVault,
} from '../utils/browserMediaVault.ts';
import {
  deleteLibraryVideoFromServer,
  updateLibraryVideoMetadata,
  uploadLibraryVideoToServer,
  uploadSourceFileToServer,
} from '../utils/uploadSourceFile.ts';

type PreloadedFilterKey = 'all' | 'montage' | 'subtitles' | 'brand' | 'audio';

interface AssetsPanelProps {
  libraryItems: SourceLibraryItem[];
  missingLibraryItems: MissingLibrarySource[];
  restoringLibraryIds: Record<string, boolean>;
  vaultLibrarySources: Record<string, { originalName: string; sizeBytes: number; savedAt: string }>;
  uploadedAssets: Partial<Record<SourceRole, UploadedAsset>>;
  missingAssets: Partial<Record<SourceRole, MissingUploadedAsset>>;
  restoringRoles: Partial<Record<SourceRole, boolean>>;
  vaultSources: Record<string, { originalName: string; sizeBytes: number; savedAt: string }>;
  diagnostics: BrowserVaultDiagnostics | null;
  storageInfo: StorageEnvironmentInfo | null;
  vaultWarning: string | null;
  preloaded: PreloadedOverlay[];
  selectedSegmentId?: string | null;
  selectedSegmentTitle?: string | null;
  onLibraryItemsAdded: (items: SourceLibraryItem[]) => void;
  onLibraryItemUpdated: (item: SourceLibraryItem) => void;
  onLibraryItemRemoved: (id: string) => void;
  onRestoreLibraryItemFromVault: (id: string) => void;
  onAssetUploaded: (role: SourceRole, asset: UploadedAsset) => void;
  onAssetsSynced?: (assigned: Partial<Record<SourceRole, UploadedAsset>>) => void;
  onAssetRemoved: (role: SourceRole) => void;
  onRestoreFromVault: (role: SourceRole) => void;
  onVaultWarning: (warning: string | null) => void;
  onVaultRefresh: () => void;
  onOpenCleanupModal?: () => void;
  onApplyOverlayToSelectedSegment?: (overlayId: string) => void;
  onUseAsEndplate?: (assetId: string) => void;
}

const AUX_UPLOAD_SLOTS: Array<{
  role: 'music' | 'endplate' | 'audioLogo';
  title: string;
  accept: string;
  hint: string;
}> = [
  {
    role: 'music',
    title: 'Фоновая музыка для Версии А (необязательно)',
    accept: 'audio/*,.mp3,.wav,.aac,.m4a,.flac',
    hint: 'Только трек с подтверждёнными правами на коммерческое использование YouTube. В Версию Б не попадает.',
  },
  {
    role: 'endplate',
    title: 'Чистая финальная заставка «ДЕЛО В КАДРЕ» (замена)',
    accept: 'image/png,image/jpeg,video/mp4,video/quicktime',
    hint: 'Опционально: заменяет загруженный шаблон shorts-04, если нужен вариант без надписи «Подписывайтесь».',
  },
  {
    role: 'audioLogo',
    title: 'Свой звуковой логотип (замена WAV)',
    accept: 'audio/*,.wav,.mp3,.aac',
    hint: 'По умолчанию уже подключён загруженный вами файл __________________14455776.wav (3.94 с).',
  },
];

const LIGHT_BACKDROP_IDS = new Set([
  'preloaded:logo-horizontal-primary',
  'preloaded:logo-horizontal-dark',
  'preloaded:symbol-primary',
  'preloaded:youtube-avatar',
]);

function matchesPreloadedFilter(item: PreloadedOverlay, filter: PreloadedFilterKey): boolean {
  if (filter === 'all') return true;
  if (filter === 'audio') return item.kind === 'audio' || item.category === 'audio';
  if (filter === 'subtitles') return item.category === 'subtitle-ref';
  if (filter === 'brand') return item.category === 'brand-logo';
  return (
    item.category === 'overlay' ||
    item.category === 'rubric-marker' ||
    item.category === 'rubric-title' ||
    item.category === 'title-card' ||
    item.category === 'endplate'
  );
}

interface UploadQueueStatus {
  currentIndex: number;
  totalCount: number;
  fileName: string;
  percent: number;
}

interface MetadataDraft {
  program: string;
  season: string;
  episode: string;
  originalStartTime: string;
  originalEndTime: string;
  segmentNumber: string;
}

export const AssetsPanel: React.FC<AssetsPanelProps> = ({
  libraryItems,
  missingLibraryItems,
  restoringLibraryIds,
  vaultLibrarySources,
  uploadedAssets,
  missingAssets,
  restoringRoles,
  vaultSources,
  diagnostics,
  storageInfo,
  vaultWarning,
  preloaded,
  selectedSegmentId,
  selectedSegmentTitle,
  onLibraryItemsAdded,
  onLibraryItemUpdated,
  onLibraryItemRemoved,
  onRestoreLibraryItemFromVault,
  onAssetUploaded,
  onAssetsSynced,
  onAssetRemoved,
  onRestoreFromVault,
  onVaultWarning,
  onVaultRefresh,
  onOpenCleanupModal,
  onApplyOverlayToSelectedSegment,
  onUseAsEndplate,
}) => {
  const [libraryQueue, setLibraryQueue] = useState<UploadQueueStatus | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [programFilter, setProgramFilter] = useState<string>('all');
  const [seasonFilter, setSeasonFilter] = useState<string>('all');
  const [episodeFilter, setEpisodeFilter] = useState<string>('all');
  const [sortMode, setSortMode] = useState<LibrarySortMode>('segment');
  const [groupByEpisode, setGroupByEpisode] = useState<boolean>(true);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<MetadataDraft | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const [uploadingRole, setUploadingRole] = useState<SourceRole | null>(null);
  const [uploadPercent, setUploadPercent] = useState<number>(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [preloadedFilter, setPreloadedFilter] = useState<PreloadedFilterKey>('all');

  const distinctPrograms = useMemo(() => {
    const set = new Set<string>();
    for (const item of libraryItems) {
      if (item.metadata.program) set.add(item.metadata.program);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ru'));
  }, [libraryItems]);

  const distinctSeasons = useMemo(() => {
    const set = new Set<number>();
    for (const item of libraryItems) {
      if (programFilter !== 'all' && item.metadata.program !== programFilter) continue;
      if (item.metadata.season !== null) set.add(item.metadata.season);
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [libraryItems, programFilter]);

  const distinctEpisodes = useMemo(() => {
    const set = new Set<number>();
    for (const item of libraryItems) {
      if (programFilter !== 'all' && item.metadata.program !== programFilter) continue;
      if (seasonFilter !== 'all' && String(item.metadata.season) !== seasonFilter) continue;
      if (item.metadata.episode !== null) set.add(item.metadata.episode);
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [libraryItems, programFilter, seasonFilter]);

  const filteredSortedLibrary = useMemo(() => {
    const filtered = libraryItems.filter((item) => {
      if (programFilter !== 'all' && item.metadata.program !== programFilter) return false;
      if (seasonFilter !== 'all' && String(item.metadata.season) !== seasonFilter) return false;
      if (episodeFilter !== 'all' && String(item.metadata.episode) !== episodeFilter) return false;
      return true;
    });
    return sortLibrarySources(filtered, sortMode);
  }, [libraryItems, programFilter, seasonFilter, episodeFilter, sortMode]);

  const groupedLibrary = useMemo(() => {
    if (!groupByEpisode) {
      return [{ groupKey: 'all', label: '', items: filteredSortedLibrary }];
    }
    const groups = new Map<string, { groupKey: string; label: string; items: SourceLibraryItem[] }>();
    for (const item of filteredSortedLibrary) {
      const key = `${item.metadata.program || 'other'}|${item.metadata.season ?? 'none'}|${item.metadata.episode ?? 'none'}`;
      const existing = groups.get(key);
      if (existing) {
        existing.items.push(item);
      } else {
        groups.set(key, {
          groupKey: key,
          label: formatEpisodeLabel(item.metadata),
          items: [item],
        });
      }
    }
    return Array.from(groups.values());
  }, [filteredSortedLibrary, groupByEpisode]);

  const filteredPreloaded = useMemo(
    () => preloaded.filter((item) => matchesPreloadedFilter(item, preloadedFilter)),
    [preloaded, preloadedFilter],
  );

  const filterCounts = useMemo(
    () => ({
      all: preloaded.length,
      montage: preloaded.filter((i) => matchesPreloadedFilter(i, 'montage')).length,
      subtitles: preloaded.filter((i) => matchesPreloadedFilter(i, 'subtitles')).length,
      brand: preloaded.filter((i) => matchesPreloadedFilter(i, 'brand')).length,
      audio: preloaded.filter((i) => matchesPreloadedFilter(i, 'audio')).length,
    }),
    [preloaded],
  );

  const handleLibraryFilesSelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    setLibraryError(null);
    onVaultWarning(null);

    const added: SourceLibraryItem[] = [];
    const errors: string[] = [];

    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      setLibraryQueue({
        currentIndex: i + 1,
        totalCount: files.length,
        fileName: file.name,
        percent: 0,
      });

      try {
        const uploadedItem = await uploadLibraryVideoToServer({
          file,
          onProgress: (pct) => {
            setLibraryQueue({
              currentIndex: i + 1,
              totalCount: files.length,
              fileName: file.name,
              percent: pct,
            });
          },
        });
        added.push(uploadedItem);

        const vaultRes = await saveLibrarySourceToVault(uploadedItem, file);
        if (!vaultRes.ok && vaultRes.error) {
          onVaultWarning(vaultRes.error);
        }
      } catch (err) {
        errors.push(
          `«${file.name}»: ${err instanceof Error ? err.message : 'ошибка загрузки видео'}`,
        );
      }
    }

    if (added.length > 0) {
      onLibraryItemsAdded(added);
      onVaultRefresh();
    }
    if (errors.length > 0) {
      setLibraryError(errors.join(' | '));
    }
    setLibraryQueue(null);
  };

  const handleDeleteLibraryItem = async (id: string) => {
    setLibraryError(null);
    setDeletingId(id);
    try {
      await deleteLibraryVideoFromServer(id);
      await deleteLibrarySourceFromVault(id);
      setConfirmDeleteId(null);
      if (editingId === id) {
        setEditingId(null);
        setEditDraft(null);
      }
      onLibraryItemRemoved(id);
      onVaultRefresh();
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : 'Не удалось удалить видео из библиотеки.');
    } finally {
      setDeletingId(null);
    }
  };

  const startEditMetadata = (item: SourceLibraryItem) => {
    setEditingId(item.id);
    setEditDraft({
      program: item.metadata.program || '',
      season: item.metadata.season !== null ? String(item.metadata.season) : '',
      episode: item.metadata.episode !== null ? String(item.metadata.episode) : '',
      originalStartTime: item.metadata.originalStartTime || '',
      originalEndTime: item.metadata.originalEndTime || '',
      segmentNumber: item.metadata.segmentNumber !== null ? String(item.metadata.segmentNumber) : '',
    });
  };

  const handleSaveMetadata = async (id: string) => {
    if (!editDraft) return;
    setSavingEdit(true);
    setLibraryError(null);
    try {
      const patch: Partial<SourceVideoMetadata> = {
        program: editDraft.program.trim(),
        season: editDraft.season.trim() ? Number(editDraft.season.trim()) : null,
        episode: editDraft.episode.trim() ? Number(editDraft.episode.trim()) : null,
        originalStartTime: editDraft.originalStartTime.trim() || null,
        originalEndTime: editDraft.originalEndTime.trim() || null,
        segmentNumber: editDraft.segmentNumber.trim() ? Number(editDraft.segmentNumber.trim()) : null,
      };
      const updated = await updateLibraryVideoMetadata(id, patch);
      onLibraryItemUpdated(updated);
      setEditingId(null);
      setEditDraft(null);
    } catch (err) {
      setLibraryError(
        err instanceof Error ? err.message : 'Не удалось сохранить метаданные исходника.',
      );
    } finally {
      setSavingEdit(false);
    }
  };

  const handleAuxFileChange = async (role: SourceRole, file: File | null) => {
    if (!file) return;
    setUploadError(null);
    onVaultWarning(null);
    setUploadingRole(role);
    setUploadPercent(0);

    try {
      const uploadRes = await uploadSourceFileToServer({
        role,
        file,
        assignBothSlots: false,
        onProgress: (pct) => setUploadPercent(pct),
      });

      if (onAssetsSynced) {
        onAssetsSynced(uploadRes.assignedAssets);
      } else {
        onAssetUploaded(role, uploadRes.asset);
      }

      const vaultRes = await saveSourceToVault(role, file, file.name);
      if (!vaultRes.ok) {
        onVaultWarning(
          vaultRes.error ||
            'Файл загружен на сервер, но обновить резервную копию в IndexedDB не удалось.',
        );
      }
      onVaultRefresh();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Ошибка загрузки файла.');
    } finally {
      setUploadingRole(null);
      setUploadPercent(0);
    }
  };

  const handleDeleteAux = async (role: SourceRole) => {
    await fetch(`/api/upload-clip/${role}`, { method: 'DELETE' });
    await deleteSourceFromVault(role);
    onAssetRemoved(role);
  };

  const filterButtons: Array<{ key: PreloadedFilterKey; label: string }> = [
    { key: 'all', label: `Все (${filterCounts.all})` },
    { key: 'montage', label: `Оверлеи и заставки (${filterCounts.montage})` },
    { key: 'subtitles', label: `Субтитры (${filterCounts.subtitles})` },
    { key: 'brand', label: `Логотипы и YouTube (${filterCounts.brand})` },
    { key: 'audio', label: `Звук (${filterCounts.audio})` },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-slate-100">
          Библиотека исходных видеоматериалов и звук
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Загружайте произвольное число MP4-фрагментов целой серии (например, «Следствие вели…»), фильтруйте по сезонам/сериям и комбинируйте любые части на таймлайне без перезаписи друг друга.
        </p>
      </div>

      <StorageStatusCard
        diagnostics={diagnostics}
        storageInfo={storageInfo}
        vaultWarning={vaultWarning}
        onOpenCleanupModal={onOpenCleanupModal}
      />

      {/* Source Video Library Section */}
      <div className="bg-[#121826] border border-[#1F2937] rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <FolderOpen className="w-4 h-4 text-red-400" />
              Библиотека исходников ({libraryItems.length})
            </h3>
            <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
              Поддерживается пакетный выбор (можно сразу выделить все части серии). Имена вида{' '}
              <span className="font-mono text-slate-300">
                Следствие_вели_1_сезон_-_1_серия-00.00.00.000-00.04.35.514-seg01.mp4
              </span>{' '}
              разбираются автоматически; оригинальное имя файла всегда сохраняется.
            </p>
          </div>

          <label
            className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              libraryQueue
                ? 'bg-[#1F2937] text-slate-300 cursor-wait'
                : 'bg-[#DC2626] hover:bg-[#B91C1C] text-white cursor-pointer'
            }`}
          >
            {libraryQueue ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Загрузка {libraryQueue.currentIndex}/{libraryQueue.totalCount} ({libraryQueue.percent}%)
              </>
            ) : (
              <>
                <Upload className="w-3.5 h-3.5" />
                Загрузить видео
              </>
            )}
            <input
              type="file"
              multiple
              accept="video/*,.mp4,.mov,.mkv,.avi,.webm,.m4v"
              disabled={Boolean(libraryQueue)}
              onChange={(e) => {
                void handleLibraryFilesSelected(e.target.files);
                e.target.value = '';
              }}
              className="hidden"
            />
          </label>
        </div>

        {libraryQueue && (
          <div className="p-3 bg-[#0B0F17] border border-[#242E42] rounded space-y-2 text-xs">
            <div className="flex items-center justify-between gap-2 text-slate-200">
              <span className="truncate">
                Файл {libraryQueue.currentIndex} из {libraryQueue.totalCount}:{' '}
                <span className="font-mono">{libraryQueue.fileName}</span>
              </span>
              <span className="font-mono tabular-nums text-slate-300 shrink-0">
                {libraryQueue.percent}%
              </span>
            </div>
            <div className="w-full h-1.5 bg-[#121826] rounded overflow-hidden">
              <div
                className="h-full bg-[#DC2626] transition-all duration-150"
                style={{ width: `${Math.max(4, libraryQueue.percent)}%` }}
              />
            </div>
          </div>
        )}

        {libraryError && (
          <div className="p-3 bg-red-950/40 border border-red-900/60 rounded text-xs text-red-300 break-words">
            {libraryError}
          </div>
        )}

        {/* Filter & Sort Controls */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5 pt-1">
          <label className="block">
            <span className="block text-[11px] text-slate-400 mb-1">Программа</span>
            <select
              value={programFilter}
              onChange={(e) => {
                setProgramFilter(e.target.value);
                setSeasonFilter('all');
                setEpisodeFilter('all');
              }}
              className="w-full px-2.5 py-1.5 text-xs bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200 focus:outline-none focus:border-slate-500"
            >
              <option value="all">Все программы ({libraryItems.length})</option>
              {distinctPrograms.map((prog) => (
                <option key={prog} value={prog}>
                  {prog}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="block text-[11px] text-slate-400 mb-1">Сезон</span>
            <select
              value={seasonFilter}
              onChange={(e) => {
                setSeasonFilter(e.target.value);
                setEpisodeFilter('all');
              }}
              className="w-full px-2.5 py-1.5 text-xs bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200 focus:outline-none focus:border-slate-500"
            >
              <option value="all">Все сезоны</option>
              {distinctSeasons.map((s) => (
                <option key={s} value={String(s)}>
                  {s} сезон
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="block text-[11px] text-slate-400 mb-1">Серия</span>
            <select
              value={episodeFilter}
              onChange={(e) => setEpisodeFilter(e.target.value)}
              className="w-full px-2.5 py-1.5 text-xs bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200 focus:outline-none focus:border-slate-500"
            >
              <option value="all">Все серии</option>
              {distinctEpisodes.map((ep) => (
                <option key={ep} value={String(ep)}>
                  {ep} серия
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="block text-[11px] text-slate-400 mb-1">Сортировка</span>
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as LibrarySortMode)}
              className="w-full px-2.5 py-1.5 text-xs bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200 focus:outline-none focus:border-slate-500"
            >
              <option value="segment">По номеру фрагмента (seg)</option>
              <option value="timestamp">По таймкоду в серии</option>
              <option value="uploadedAt">Сначала новые загрузки</option>
              <option value="name">По имени файла</option>
            </select>
          </label>

          <label className="flex items-end pb-1.5 gap-2 text-xs text-slate-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={groupByEpisode}
              onChange={(e) => setGroupByEpisode(e.target.checked)}
              className="w-4 h-4 accent-[#DC2626]"
            />
            <span>Группировать по сериям</span>
          </label>
        </div>

        {/* Missing library files notice */}
        {missingLibraryItems.length > 0 && (
          <div className="space-y-2 pt-1">
            {missingLibraryItems.map((missing) => {
              const inVault = Boolean(vaultLibrarySources[missing.id]);
              const isRestoring = Boolean(restoringLibraryIds[missing.id]);
              return (
                <div
                  key={missing.id}
                  className="p-3 bg-amber-950/30 border border-amber-800/50 rounded text-xs flex flex-wrap items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-amber-200 truncate">
                      Отсутствует на сервере: {missing.originalName}
                    </div>
                    <div className="text-[11px] text-amber-300/80 mt-0.5">
                      {missing.reason}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {inVault && (
                      <button
                        type="button"
                        disabled={isRestoring}
                        onClick={() => onRestoreLibraryItemFromVault(missing.id)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-sky-700/80 hover:bg-sky-600 text-white rounded text-[11px] font-medium disabled:opacity-50"
                      >
                        <RefreshCw className={`w-3 h-3 ${isRestoring ? 'animate-spin' : ''}`} />
                        {isRestoring ? 'Восстановление…' : 'Восстановить из IndexedDB'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleDeleteLibraryItem(missing.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 bg-[#0B0F17] border border-[#242E42] text-slate-300 hover:text-red-300 rounded text-[11px]"
                    >
                      <Trash2 className="w-3 h-3" />
                      Удалить запись
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Library Items List */}
        {filteredSortedLibrary.length === 0 ? (
          <div className="py-10 px-4 text-center bg-[#0B0F17] border border-dashed border-[#242E42] rounded-md space-y-2">
            <Film className="w-7 h-7 text-slate-600 mx-auto" />
            <div className="text-xs font-medium text-slate-300">
              {libraryItems.length === 0
                ? 'В библиотеке пока нет загруженных видеофайлов'
                : 'Нет видеофайлов, подходящих под выбранные фильтры'}
            </div>
            <p className="text-[11px] text-slate-500 max-w-lg mx-auto">
              Нажмите «Загрузить видео» и выберите один или сразу все MP4-фрагменты серии. Каждый файл получит уникальный ID и не затрёт остальные.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {groupedLibrary.map((group) => (
              <div key={group.groupKey} className="space-y-2">
                {groupByEpisode && (
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-300 px-1 pt-1 border-b border-[#1F2937] pb-1.5">
                    <span>{group.label}</span>
                    <span className="font-mono text-[11px] text-slate-500">
                      {group.items.length} файл(ов)
                    </span>
                  </div>
                )}

                <div className="space-y-2">
                  {group.items.map((item) => {
                    const inVault = Boolean(vaultLibrarySources[item.id]);
                    const isEditing = editingId === item.id;
                    const isConfirmDelete = confirmDeleteId === item.id;

                    return (
                      <div
                        key={item.id}
                        className="bg-[#0B0F17] border border-[#1F2937] rounded-md p-3.5 space-y-2.5"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 space-y-1 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                              <span
                                className="text-xs font-semibold text-slate-100 break-all"
                                title={item.originalName}
                              >
                                {item.originalName}
                              </span>
                              {item.metadata.segmentNumber !== null && (
                                <span className="px-1.5 py-0.5 rounded bg-[#1F2937] text-[10px] font-mono text-slate-200 shrink-0">
                                  seg{String(item.metadata.segmentNumber).padStart(2, '0')}
                                </span>
                              )}
                              {item.legacyRole && (
                                <span className="px-1.5 py-0.5 rounded bg-sky-950/50 border border-sky-800/60 text-[10px] text-sky-300 shrink-0">
                                  {item.legacyRole === 'fragment8' ? 'Слот: Фрагмент 8' : 'Слот: Фрагмент 9'}
                                </span>
                              )}
                            </div>

                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                              <span>
                                {item.metadata.program || 'Программа не указана'}
                                {item.metadata.season !== null ? ` · ${item.metadata.season} сезон` : ''}
                                {item.metadata.episode !== null ? ` · ${item.metadata.episode} серия` : ''}
                              </span>
                              {item.metadata.originalStartTime && item.metadata.originalEndTime ? (
                                <span className="font-mono text-slate-300">
                                  В серии: {item.metadata.originalStartTime} – {item.metadata.originalEndTime}
                                </span>
                              ) : (
                                <span className="text-slate-500">
                                  Таймкод в серии не задан
                                </span>
                              )}
                            </div>

                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono tabular-nums text-slate-400">
                              <span className="text-slate-200">{item.probe.durationSec.toFixed(2)} с</span>
                              <span>
                                {item.probe.width}×{item.probe.height} · {item.probe.fps} fps ·{' '}
                                {item.probe.videoCodec || 'video'}
                              </span>
                              <span>{formatBytesRu(item.probe.sizeBytes)}</span>
                              {inVault && (
                                <span className="inline-flex items-center gap-1 text-emerald-300/90 font-sans">
                                  <HardDrive className="w-3 h-3" />
                                  IndexedDB
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() =>
                                isEditing ? setEditingId(null) : startEditMetadata(item)
                              }
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-[#121826] border border-[#242E42] text-slate-200 rounded hover:border-slate-500 transition-colors"
                            >
                              <Edit3 className="w-3 h-3" />
                              {isEditing ? 'Скрыть' : 'Метаданные'}
                            </button>

                            {isConfirmDelete ? (
                              <div className="inline-flex items-center gap-1.5 bg-red-950/40 border border-red-800/60 rounded px-2 py-1">
                                <span className="text-[11px] text-red-200">Удалить?</span>
                                <button
                                  type="button"
                                  disabled={deletingId === item.id}
                                  onClick={() => void handleDeleteLibraryItem(item.id)}
                                  className="px-2 py-0.5 text-[11px] font-medium bg-red-700 hover:bg-red-600 text-white rounded disabled:opacity-50"
                                >
                                  {deletingId === item.id ? '…' : 'Да'}
                                </button>
                                <button
                                  type="button"
                                  disabled={deletingId === item.id}
                                  onClick={() => setConfirmDeleteId(null)}
                                  className="px-1.5 py-0.5 text-[11px] text-slate-300 hover:text-white"
                                >
                                  Нет
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(item.id)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] bg-[#121826] border border-[#242E42] text-slate-400 hover:text-red-400 hover:border-red-900/60 rounded transition-colors"
                                title="Удалить этот файл из библиотеки"
                              >
                                <Trash2 className="w-3 h-3" />
                                Удалить
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Inline Manual Metadata Editor */}
                        {isEditing && editDraft && (
                          <div className="pt-3 border-t border-[#1F2937] grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2.5 text-xs">
                            <label className="block lg:col-span-2">
                              <span className="block text-[10px] text-slate-400 mb-1">Программа</span>
                              <input
                                type="text"
                                value={editDraft.program}
                                onChange={(e) =>
                                  setEditDraft({ ...editDraft, program: e.target.value })
                                }
                                placeholder="Следствие вели"
                                className="w-full px-2 py-1 bg-[#121826] border border-[#242E42] rounded text-slate-100"
                              />
                            </label>
                            <label className="block">
                              <span className="block text-[10px] text-slate-400 mb-1">Сезон</span>
                              <input
                                type="number"
                                min={0}
                                value={editDraft.season}
                                onChange={(e) =>
                                  setEditDraft({ ...editDraft, season: e.target.value })
                                }
                                className="w-full px-2 py-1 font-mono bg-[#121826] border border-[#242E42] rounded text-slate-100"
                              />
                            </label>
                            <label className="block">
                              <span className="block text-[10px] text-slate-400 mb-1">Серия</span>
                              <input
                                type="number"
                                min={0}
                                value={editDraft.episode}
                                onChange={(e) =>
                                  setEditDraft({ ...editDraft, episode: e.target.value })
                                }
                                className="w-full px-2 py-1 font-mono bg-[#121826] border border-[#242E42] rounded text-slate-100"
                              />
                            </label>
                            <label className="block">
                              <span className="block text-[10px] text-slate-400 mb-1">Начало (серия)</span>
                              <input
                                type="text"
                                value={editDraft.originalStartTime}
                                onChange={(e) =>
                                  setEditDraft({ ...editDraft, originalStartTime: e.target.value })
                                }
                                placeholder="00:00:00.000"
                                className="w-full px-2 py-1 font-mono bg-[#121826] border border-[#242E42] rounded text-slate-100"
                              />
                            </label>
                            <label className="block">
                              <span className="block text-[10px] text-slate-400 mb-1">Конец (серия)</span>
                              <input
                                type="text"
                                value={editDraft.originalEndTime}
                                onChange={(e) =>
                                  setEditDraft({ ...editDraft, originalEndTime: e.target.value })
                                }
                                placeholder="00:04:35.514"
                                className="w-full px-2 py-1 font-mono bg-[#121826] border border-[#242E42] rounded text-slate-100"
                              />
                            </label>
                            <label className="block">
                              <span className="block text-[10px] text-slate-400 mb-1">Фрагмент №</span>
                              <input
                                type="number"
                                min={0}
                                value={editDraft.segmentNumber}
                                onChange={(e) =>
                                  setEditDraft({ ...editDraft, segmentNumber: e.target.value })
                                }
                                className="w-full px-2 py-1 font-mono bg-[#121826] border border-[#242E42] rounded text-slate-100"
                              />
                            </label>
                            <div className="lg:col-span-5 flex items-end gap-2">
                              <button
                                type="button"
                                disabled={savingEdit}
                                onClick={() => void handleSaveMetadata(item.id)}
                                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-emerald-700 hover:bg-emerald-600 text-white rounded disabled:opacity-50"
                              >
                                <Save className="w-3.5 h-3.5" />
                                {savingEdit ? 'Сохранение…' : 'Сохранить метаданные'}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingId(null);
                                  setEditDraft(null);
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-400 hover:text-white"
                              >
                                <X className="w-3.5 h-3.5" />
                                Отмена
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Auxiliary Music / Endplate / Audio Logo Slots */}
      {uploadError && (
        <div className="p-3 bg-red-950/40 border border-red-900/60 rounded text-xs text-red-300">
          {uploadError}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {AUX_UPLOAD_SLOTS.map((slot) => {
          const asset = uploadedAssets[slot.role];
          const missing = missingAssets[slot.role];
          const isRestoring = Boolean(restoringRoles[slot.role]);
          const vaultItem = vaultSources[slot.role];
          const inVault = Boolean(vaultItem);
          const isUploading = uploadingRole === slot.role;

          return (
            <div
              key={slot.role}
              className="bg-[#121826] border border-[#1F2937] rounded-lg p-4 flex flex-col justify-between gap-3"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-medium text-slate-100">{slot.title}</h3>
                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">{slot.hint}</p>
                  </div>
                  {asset ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  ) : isRestoring ? (
                    <RefreshCw className="w-4 h-4 text-sky-400 animate-spin shrink-0 mt-0.5" />
                  ) : missing ? (
                    <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  ) : null}
                </div>

                {asset && (
                  <div className="mt-3 pt-3 border-t border-[#1F2937] text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-200 font-medium truncate">
                        {asset.originalName}
                      </span>
                      <span className="font-mono tabular-nums text-slate-400 shrink-0">
                        {asset.probe.durationSec.toFixed(1)} с
                      </span>
                    </div>
                    <div className="text-slate-400 font-mono tabular-nums">
                      {asset.probe.hasVideo
                        ? `${asset.probe.width}×${asset.probe.height} · ${asset.probe.fps} fps · ${asset.probe.videoCodec}`
                        : `Аудио: ${asset.probe.audioCodec} · ${asset.probe.sampleRate ?? 48000} Гц`}
                    </div>
                  </div>
                )}

                {!asset && inVault && vaultItem && (
                  <div className="mt-3 p-2.5 bg-sky-950/35 border border-sky-800/60 rounded text-[11px] text-sky-200 leading-relaxed flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {isRestoring
                        ? `Восстановление «${vaultItem.originalName}»…`
                        : `Локальная копия: «${vaultItem.originalName}».`}
                    </span>
                    {!isRestoring && (
                      <button
                        type="button"
                        onClick={() => onRestoreFromVault(slot.role)}
                        className="inline-flex items-center gap-1 px-2 py-1 bg-sky-700/80 hover:bg-sky-600 text-white rounded text-[11px] font-medium"
                      >
                        <RefreshCw className="w-3 h-3" />
                        Восстановить
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0B0F17] border border-[#242E42] rounded text-slate-200 hover:border-slate-500 cursor-pointer transition-colors whitespace-nowrap">
                  <Upload className="w-3.5 h-3.5" />
                  {isUploading
                    ? uploadPercent > 0
                      ? `Загрузка ${uploadPercent}%…`
                      : 'Анализ…'
                    : asset
                      ? 'Заменить'
                      : 'Выбрать файл'}
                  <input
                    type="file"
                    accept={slot.accept}
                    disabled={isUploading}
                    onChange={(e) => {
                      void handleAuxFileChange(slot.role, e.target.files?.[0] ?? null);
                      e.target.value = '';
                    }}
                    className="hidden"
                  />
                </label>

                {asset && (
                  <button
                    type="button"
                    onClick={() => void handleDeleteAux(slot.role)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-400 hover:text-red-400 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Удалить
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Preloaded Brand & Montage Attachments */}
      <div className="pt-2 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">
              Фирменные материалы для монтажа и канала ({preloaded.length} шт.)
            </h3>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Защищённые шаблоны оформления, маркеры рубрик, заставки, субтитры и графика YouTube. Не удаляются при очистке рабочей области.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {filterButtons.map((btn) => (
            <button
              key={btn.key}
              type="button"
              onClick={() => setPreloadedFilter(btn.key)}
              className={`px-2.5 py-1.5 rounded text-xs font-medium border transition-colors whitespace-nowrap ${
                preloadedFilter === btn.key
                  ? 'bg-[#DC2626] border-[#DC2626] text-white'
                  : 'bg-[#121826] border-[#1F2937] text-slate-300 hover:border-slate-500'
              }`}
            >
              {btn.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredPreloaded.map((item) => {
            const canApplyOverlay = Boolean(item.overlayPlacement && onApplyOverlayToSelectedSegment);
            const canUseAsEndplate = Boolean(
              (item.category === 'endplate' ||
                item.category === 'rubric-title' ||
                item.category === 'title-card') &&
                onUseAsEndplate,
            );
            const lightBg = LIGHT_BACKDROP_IDS.has(item.id);

            return (
              <div
                key={item.id}
                className="bg-[#121826] border border-[#1F2937] rounded-lg p-3.5 flex flex-col justify-between gap-2.5"
              >
                <div className="space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-medium text-slate-100 leading-snug">
                      {item.label}
                    </span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="font-mono text-[10px] tabular-nums text-slate-300 bg-[#0B0F17] border border-[#1F2937] px-1.5 py-0.5 rounded">
                        {item.kind === 'image'
                          ? `${item.width}×${item.height}`
                          : `${item.durationSec?.toFixed(2) ?? '3.94'} с`}
                      </span>
                      {item.kind === 'image' && (
                        <span className="font-mono text-[10px] text-slate-400 bg-[#0B0F17] border border-[#1F2937] px-1.5 py-0.5 rounded">
                          {item.hasAlpha ? 'PNG альфа' : 'PNG'}
                        </span>
                      )}
                    </div>
                  </div>

                  {item.kind === 'image' ? (
                    <div
                      className={`w-full h-36 border border-[#1F2937] rounded flex items-center justify-center overflow-hidden p-2 ${
                        lightBg ? 'bg-slate-100' : 'bg-[#0B0F17]'
                      }`}
                    >
                      <img
                        src={item.url}
                        alt={item.label}
                        referrerPolicy="no-referrer"
                        className="max-h-full max-w-full object-contain"
                      />
                    </div>
                  ) : (
                    <audio controls src={item.url} className="w-full h-9" />
                  )}

                  <p className="text-[11px] text-slate-400 leading-relaxed">{item.note}</p>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-[#1F2937]">
                  <a
                    href={item.url}
                    download={item.fileName}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-[#0B0F17] border border-[#242E42] text-slate-200 rounded hover:border-slate-500 transition-colors whitespace-nowrap"
                  >
                    <Download className="w-3 h-3" />
                    Скачать
                  </a>

                  {canApplyOverlay && (
                    <button
                      type="button"
                      disabled={!selectedSegmentId}
                      title={
                        selectedSegmentTitle
                          ? `Наложить на сцену: ${selectedSegmentTitle}`
                          : 'Выберите монтажный фрагмент на вкладке «Монтаж»'
                      }
                      onClick={() => onApplyOverlayToSelectedSegment?.(item.id)}
                      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-[#0B0F17] border border-[#242E42] text-sky-300 rounded hover:border-sky-600 disabled:opacity-45 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                    >
                      <Layers className="w-3 h-3" />
                      Наложить на сцену
                    </button>
                  )}

                  {canUseAsEndplate && (
                    <button
                      type="button"
                      onClick={() => onUseAsEndplate?.(item.id)}
                      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-[#0B0F17] border border-[#242E42] text-emerald-300 rounded hover:border-emerald-600 transition-colors whitespace-nowrap"
                    >
                      <Film className="w-3 h-3" />
                      Сделать заставкой
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
