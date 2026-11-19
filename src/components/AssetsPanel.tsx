import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Film,
  HardDrive,
  Layers,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { StorageStatusCard } from './StorageStatusCard.tsx';
import type {
  BrowserVaultDiagnostics,
  MissingUploadedAsset,
  PreloadedOverlay,
  SourceRole,
  StorageEnvironmentInfo,
  UploadedAsset,
} from '../types.ts';
import {
  deleteSourceFromVault,
  saveSourceToVault,
} from '../utils/browserMediaVault.ts';
import {
  assignUploadedVideoToBothSlots,
  uploadSourceFileToServer,
} from '../utils/uploadSourceFile.ts';

type PreloadedFilterKey = 'all' | 'montage' | 'subtitles' | 'brand' | 'audio';

interface AssetsPanelProps {
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

const UPLOAD_SLOTS: Array<{
  role: SourceRole;
  title: string;
  required: boolean;
  accept: string;
  hint: string;
}> = [
  {
    role: 'fragment8',
    title: 'Фрагмент 8 («Следствие вели…»)',
    required: true,
    accept: 'video/*,.mp4,.mov,.mkv,.avi',
    hint: 'Целевой таймкод внутри файла: 00:04:10–00:04:26. После загрузки длительность проверяется через ffprobe.',
  },
  {
    role: 'fragment9',
    title: 'Фрагмент 9 («Следствие вели…»)',
    required: true,
    accept: 'video/*,.mp4,.mov,.mkv,.avi',
    hint: 'Целевой таймкод внутри файла: 00:00:00–00:01:15. После загрузки длительность проверяется через ffprobe.',
  },
  {
    role: 'music',
    title: 'Фоновая музыка для Версии А (необязательно)',
    required: false,
    accept: 'audio/*,.mp3,.wav,.aac,.m4a,.flac',
    hint: 'Только трек с подтверждёнными правами на коммерческое использование YouTube. В Версию Б не попадает.',
  },
  {
    role: 'endplate',
    title: 'Чистая финальная заставка «ДЕЛО В КАДРЕ» (замена)',
    required: false,
    accept: 'image/png,image/jpeg,video/mp4,video/quicktime',
    hint: 'Опционально: заменяет загруженный шаблон shorts-04, если нужен вариант без надписи «Подписывайтесь».',
  },
  {
    role: 'audioLogo',
    title: 'Свой звуковой логотип (замена WAV)',
    required: false,
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

export const AssetsPanel: React.FC<AssetsPanelProps> = ({
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
  const [uploadingRole, setUploadingRole] = useState<SourceRole | null>(null);
  const [uploadPercent, setUploadPercent] = useState<number>(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [assignBothVideoSlots, setAssignBothVideoSlots] = useState<boolean>(true);
  const [linkingRole, setLinkingRole] = useState<'fragment8' | 'fragment9' | null>(null);
  const [preloadedFilter, setPreloadedFilter] = useState<PreloadedFilterKey>('all');

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

  const handleFileChange = async (role: SourceRole, file: File | null) => {
    if (!file) return;
    setUploadError(null);
    onVaultWarning(null);
    setUploadingRole(role);
    setUploadPercent(0);
    const isVideoSlot = role === 'fragment8' || role === 'fragment9';

    try {
      // 1. Сначала загружаем файл на сервер (чанками по 4 MiB для обхода лимита 32 MiB),
      // НЕ изменяя и НЕ удаляя локальную запись IndexedDB до успешного ответа сервера.
      const uploadRes = await uploadSourceFileToServer({
        role,
        file,
        assignBothSlots: isVideoSlot && assignBothVideoSlots,
        onProgress: (pct) => setUploadPercent(pct),
      });

      if (onAssetsSynced) {
        onAssetsSynced(uploadRes.assignedAssets);
      } else {
        onAssetUploaded(role, uploadRes.asset);
      }

      // 2. Только после успешной загрузки на сервер обновляем локальную резервную копию в IndexedDB.
      const rolesToSave = Object.keys(uploadRes.assignedAssets) as SourceRole[];
      const targetRoles = rolesToSave.length > 0 ? rolesToSave : [role];
      for (const targetRole of targetRoles) {
        const vaultRes = await saveSourceToVault(targetRole, file, file.name);
        if (!vaultRes.ok) {
          onVaultWarning(
            vaultRes.error ||
              'Файл загружен на сервер, но обновить резервную копию в IndexedDB не удалось.',
          );
          break;
        }
      }
      onVaultRefresh();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Ошибка загрузки файла.');
    } finally {
      setUploadingRole(null);
      setUploadPercent(0);
    }
  };

  const handleAssignBothFromSlot = async (fromRole: 'fragment8' | 'fragment9') => {
    setUploadError(null);
    setLinkingRole(fromRole);
    try {
      const assigned = await assignUploadedVideoToBothSlots(fromRole);
      if (onAssetsSynced) {
        onAssetsSynced(assigned);
      } else if (assigned.fragment8 && assigned.fragment9) {
        onAssetUploaded('fragment8', assigned.fragment8);
        onAssetUploaded('fragment9', assigned.fragment9);
      }
    } catch (err) {
      setUploadError(
        err instanceof Error ? err.message : 'Не удалось назначить файл обоим монтажным слотам.',
      );
    } finally {
      setLinkingRole(null);
    }
  };

  const handleDelete = async (role: SourceRole) => {
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
          Исходные видеоматериалы и аудио
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Настоящий монтаж без генерации кадров: для сборки MP4 необходимы оригинальные «Фрагмент 8» и «Фрагмент 9».
        </p>
      </div>

      <StorageStatusCard
        diagnostics={diagnostics}
        storageInfo={storageInfo}
        vaultWarning={vaultWarning}
        onOpenCleanupModal={onOpenCleanupModal}
      />

      {uploadError && (
        <div className="p-3 bg-red-950/40 border border-red-900/60 rounded text-xs text-red-300">
          {uploadError}
        </div>
      )}

      <label className="flex items-start gap-2.5 p-3 bg-[#121826] border border-[#1F2937] rounded-lg text-xs text-slate-300 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={assignBothVideoSlots}
          onChange={(e) => setAssignBothVideoSlots(e.target.checked)}
          className="mt-0.5 accent-[#DC2626]"
        />
        <span>
          <span className="font-medium text-slate-100">
            Подключать загружаемый MP4 сразу к обоим монтажным слотам («Фрагмент 8» и «Фрагмент 9»)
          </span>
          <span className="block text-[11px] text-slate-400 mt-0.5">
            Удобно, если вы загружаете один исходный файл с компьютера для всех сцен на таймлайне. Снимите отметку, чтобы загрузить два разных видеофайла отдельно.
          </span>
        </span>
      </label>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {UPLOAD_SLOTS.map((slot) => {
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
                  ) : slot.required || missing ? (
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
                    {inVault && (
                      <div className="inline-flex items-center gap-1.5 text-[11px] text-emerald-300/90 pt-0.5">
                        <HardDrive className="w-3 h-3" />
                        Резервная копия сохранена в браузере (восстановится после перезапуска сервера)
                      </div>
                    )}

                    {asset.warnings.map((w, i) => (
                      <div
                        key={i}
                        className="mt-2 p-2 bg-amber-950/30 border border-amber-800/50 rounded text-[11px] text-amber-300 leading-relaxed"
                      >
                        {w}
                      </div>
                    ))}
                  </div>
                )}

                {!asset && missing && !inVault && (
                  <div className="mt-3 p-2.5 bg-amber-950/35 border border-amber-800/60 rounded text-[11px] text-amber-200 leading-relaxed">
                    {isRestoring ? (
                      <span>
                        Восстановление файла «{missing.originalName}» из локального хранилища браузера на сервер…
                      </span>
                    ) : (
                      <span>
                        Ранее загруженный файл «{missing.originalName}» ({(missing.sizeBytes / (1024 * 1024)).toFixed(1)} МБ) отсутствует на диске контейнера после перезапуска и не найден в IndexedDB этого браузера. Выберите файл заново.
                      </span>
                    )}
                  </div>
                )}

                {!asset && inVault && vaultItem && (
                  <div className="mt-3 p-2.5 bg-sky-950/35 border border-sky-800/60 rounded text-[11px] text-sky-200 leading-relaxed flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {isRestoring
                        ? `Восстановление «${vaultItem.originalName}» из IndexedDB на сервер…`
                        : `В IndexedDB найдена локальная запись «${vaultItem.originalName}» (${(vaultItem.sizeBytes / (1024 * 1024)).toFixed(1)} МБ). Автовосстановление отключено — выберите новый MP4 с компьютера (локальная копия сохранится до завершения загрузки) или запустите восстановление вручную.`}
                    </span>
                    {!isRestoring && (
                      <button
                        type="button"
                        onClick={() => onRestoreFromVault(slot.role)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-sky-700/80 hover:bg-sky-600 text-white rounded text-[11px] font-medium whitespace-nowrap"
                      >
                        <RefreshCw className="w-3 h-3" />
                        Восстановить из IndexedDB
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
                      : 'Анализ файла…'
                    : asset
                      ? 'Заменить с компьютера'
                      : 'Выбрать файл с компьютера'}
                  <input
                    type="file"
                    accept={slot.accept}
                    disabled={isUploading}
                    onChange={(e) => {
                      handleFileChange(slot.role, e.target.files?.[0] ?? null);
                      e.target.value = '';
                    }}
                    className="hidden"
                  />
                </label>

                {asset &&
                  (slot.role === 'fragment8' || slot.role === 'fragment9') &&
                  uploadedAssets[slot.role === 'fragment8' ? 'fragment9' : 'fragment8']?.filePath !==
                    asset.filePath && (
                    <button
                      type="button"
                      disabled={linkingRole === slot.role}
                      onClick={() =>
                        void handleAssignBothFromSlot(slot.role as 'fragment8' | 'fragment9')
                      }
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-[#0B0F17] border border-[#242E42] text-sky-300 rounded hover:border-sky-600 disabled:opacity-50 transition-colors whitespace-nowrap"
                    >
                      <Layers className="w-3.5 h-3.5" />
                      {linkingRole === slot.role
                        ? 'Подключение…'
                        : slot.role === 'fragment8'
                          ? 'Подключить и к Фрагменту 9'
                          : 'Подключить и к Фрагменту 8'}
                    </button>
                  )}

                {asset && (
                  <button
                    type="button"
                    onClick={() => handleDelete(slot.role)}
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

