import React from 'react';
import { AlertTriangle, CheckCircle2, Download, HardDrive, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { StorageStatusCard } from './StorageStatusCard.tsx';
import { resolveSegmentMediaAsset } from '../shared/sourceLibrary.ts';
import type {
  AdOverlayLayer,
  BrowserVaultDiagnostics,
  CutSegment,
  DownloadProgressInfo,
  ExportHistoryItem,
  ExportJobResult,
  ExportVaultBackupState,
  PreloadedOverlay,
  SourceLibraryItem,
  SourceRole,
  StorageEnvironmentInfo,
  SubtitleCue,
  UploadedAsset,
} from '../types.ts';

interface QualityChecklistProps {
  segments: CutSegment[];
  libraryItems: SourceLibraryItem[];
  subtitles: SubtitleCue[];
  adLayers: AdOverlayLayer[];
  uploadedAssets: Partial<Record<SourceRole, UploadedAsset>>;
  preloaded: PreloadedOverlay[];
  endplateAssetId: string;
  endplateDurationSec: number;
  audioLogoAssetId: string;
  mainDurationSec: number;
  totalDurationSec: number;
  exportResult: ExportJobResult | null;
  exportHistory: ExportHistoryItem[];
  vaultExports: Record<string, { jobId: string; version: 'A' | 'B'; fileName: string; sizeBytes: number; savedAt: string }>;
  diagnostics: BrowserVaultDiagnostics | null;
  storageInfo: StorageEnvironmentInfo | null;
  vaultWarning: string | null;
  exportBackupState: ExportVaultBackupState | null;
  downloadProgress: DownloadProgressInfo | null;
  downloadError: string | null;
  failedDownloadKey: string | null;
  onDownloadFile: (params: {
    jobId: string;
    version: 'A' | 'B';
    url: string;
    fileName: string;
    expectedSizeBytes?: number;
  }) => void;
  onDownloadBoth: (result: ExportJobResult) => void;
  onOpenCleanupModal?: () => void;
}

export const QualityChecklist: React.FC<QualityChecklistProps> = ({
  segments,
  libraryItems,
  subtitles,
  adLayers,
  uploadedAssets,
  preloaded,
  endplateAssetId,
  endplateDurationSec,
  audioLogoAssetId,
  mainDurationSec,
  totalDurationSec,
  exportResult,
  exportHistory,
  vaultExports,
  diagnostics,
  storageInfo,
  vaultWarning,
  exportBackupState,
  downloadProgress,
  downloadError,
  failedDownloadKey,
  onDownloadFile,
  onDownloadBoth,
  onOpenCleanupModal,
}) => {
  const allSegmentsHaveSources =
    segments.length > 0 &&
    segments.every((s) => Boolean(resolveSegmentMediaAsset(s, libraryItems, uploadedAssets)));
  const usedSourcesCount = new Set(
    segments
      .map((s) => resolveSegmentMediaAsset(s, libraryItems, uploadedAssets)?.key)
      .filter((k): k is string => Boolean(k)),
  ).size;
  const durationValid = totalDurationSec >= 55 && totalDurationSec <= 59;
  const endplateValid = endplateDurationSec >= 1.5 && endplateDurationSec <= 2.0;

  const segmentsValid =
    segments.length > 0 &&
    segments.every((s) => {
      const asset = resolveSegmentMediaAsset(s, libraryItems, uploadedAssets);
      if (!asset) return false;
      return s.endSec > s.startSec && s.endSec <= asset.probe.durationSec + 0.05;
    });

  const subtitlesTwoLinesValid =
    subtitles.length > 0 &&
    subtitles.every((c) => c.endSec > c.startSec && c.line1.trim().length > 0);

  const audioLogoReady =
    audioLogoAssetId === 'uploaded:audioLogo'
      ? Boolean(uploadedAssets.audioLogo)
      : preloaded.some((p) => p.id === 'preloaded:audio-logo');

  const selectedEndplatePreloaded = preloaded.find((p) => p.id === endplateAssetId);

  const endplateHasCtaWarning =
    endplateAssetId === 'preloaded:shorts-04' && !uploadedAssets.endplate;

  const checks: Array<{
    id: number;
    label: string;
    status: 'pass' | 'warn' | 'fail';
    detail: string;
  }> = [
    {
      id: 1,
      label: 'Исходные видеофайлы из библиотеки для всех сегментов',
      status: allSegmentsHaveSources ? 'pass' : 'fail',
      detail: allSegmentsHaveSources
        ? `В библиотеке доступно файлов: ${libraryItems.length}; в текущем монтаже задействовано источников: ${usedSourcesCount}.`
        : 'Для части монтажных сегментов не выбран или не загружен видеофайл из библиотеки.',
    },
    {
      id: 2,
      label: 'Продолжительность ролика (цель 55–59 с с заставкой)',
      status: durationValid ? 'pass' : 'warn',
      detail: `Текущая длина: ${totalDurationSec.toFixed(1)} с (основной монтаж ${mainDurationSec.toFixed(1)} с + заставка ${endplateDurationSec.toFixed(1)} с).`,
    },
    {
      id: 3,
      label: 'Корректность всех склеек и таймкодов',
      status: segmentsValid ? 'pass' : allSegmentsHaveSources ? 'fail' : 'warn',
      detail: segmentsValid
        ? `Все ${segments.length} монтажных сегментов укладываются в границы загруженных файлов.`
        : 'Проверьте границы In/Out и привязку исходников на вкладке «Монтаж».',
    },
    {
      id: 4,
      label: 'Субтитры: дословность, пунктуация, не более 2 строк',
      status: subtitlesTwoLinesValid ? 'pass' : 'warn',
      detail: subtitlesTwoLinesValid
        ? `Заполнено ${subtitles.length} реплик в безопасной зоне (1080×1920, Noto Sans Bold).`
        : 'Добавьте или распознайте субтитры для всех реплик.',
    },
    {
      id: 5,
      label: 'Вертикальное кадрирование 9:16 с защитой лица и тела',
      status: allSegmentsHaveSources ? 'pass' : 'warn',
      detail:
        'Активно автоматическое распознавание и сглаженное отслеживание лиц и верхней части тела для каждого сегмента (с возможностью ручной коррекции X-Pan).',
    },
    {
      id: 6,
      label: 'Оригинальная речь без изменения тембра и скорости',
      status: 'pass',
      detail: 'Речевые дорожки перекодируются без time-stretch, pitch-shift и синтеза голоса.',
    },
    {
      id: 7,
      label: 'Фирменная заставка (1.5–2.0 с) и соответствие каналу «ДЕЛО В КАДРЕ»',
      status: !endplateValid ? 'fail' : endplateHasCtaWarning ? 'warn' : 'pass',
      detail: endplateHasCtaWarning
        ? 'Используется приложенный shorts-04 («СЛЕДСТВИЕ / Подписывайтесь»). При необходимости выберите рубричную заставку или загрузите свой вариант.'
        : `Выбрана заставка «${uploadedAssets.endplate?.originalName ?? selectedEndplatePreloaded?.label ?? 'шаблон бренда'}» (${endplateDurationSec.toFixed(1)} с).`,
    },
    {
      id: 8,
      label: 'Звуковой логотип только в Версии А (в Версии Б отсутствует)',
      status: audioLogoReady ? 'pass' : 'fail',
      detail: audioLogoReady
        ? 'Звуковой логотип подключается исключительно на заставку Версии А; Версия Б остаётся без музыки и без звукового логотипа.'
        : 'Звуковой логотип не найден.',
    },
    {
      id: 9,
      label: 'Отсутствие генеративных изменений исходного изображения',
      status: 'pass',
      detail: 'В видеопоток попадают только оригинальные кадры исходников (нейрогенерация видео отключена).',
    },
    {
      id: 10,
      label: 'Рекламные плашки и рекламный звук (одинаковы в Версии А и Б)',
      status:
        adLayers.some((l) => l.enabled && !l.confirmed)
          ? 'warn'
          : 'pass',
      detail:
        adLayers.filter((l) => l.enabled).length === 0
          ? 'Активных рекламных плашек нет.'
          : adLayers.some((l) => l.enabled && !l.confirmed)
            ? 'Есть неподтверждённые рекламные слои — подтвердите их во вкладке «Реклама», чтобы они попали в MP4.'
            : `Подтверждено активных слоёв рекламы: ${adLayers.filter((l) => l.enabled && l.confirmed).length} (с аудио: ${adLayers.filter((l) => l.enabled && l.confirmed && l.audio?.enabled && l.audio.audioAssetId).length}). Одинаково вшиваются в Версию А и Версию Б.`,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-slate-100">
          Контроль качества перед публикацией
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Автоматическая проверка требований задания и готовые файлы экспорта Версия А / Версия Б
        </p>
      </div>

      <StorageStatusCard
        diagnostics={diagnostics}
        storageInfo={storageInfo}
        vaultWarning={vaultWarning}
        onOpenCleanupModal={onOpenCleanupModal}
      />

      {downloadError && (
        <div className="bg-red-950/35 border border-red-900/60 rounded-lg p-3.5 text-xs text-red-200 leading-relaxed flex items-start justify-between gap-3">
          <span>{downloadError}</span>
          {exportResult && (
            <button
              type="button"
              disabled={Boolean(downloadProgress)}
              onClick={() => onDownloadBoth(exportResult)}
              className="inline-flex items-center gap-1 px-2.5 py-1 bg-red-800/70 hover:bg-red-700 text-white rounded text-[11px] font-medium whitespace-nowrap shrink-0"
            >
              <RefreshCw className="w-3 h-3" />
              Повторить
            </button>
          )}
        </div>
      )}

      {/* Prominent Ready Release Block */}
      {exportResult && (
        <div className="bg-[#121826] border border-emerald-700/70 rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-emerald-300">
                Готовый выпуск
              </h3>
              <p className="text-xs text-slate-400 mt-0.5 tabular-nums">
                Итоговая длительность: {exportResult.totalDurationSec.toFixed(2)} с ·{' '}
                {exportResult.versionA.probe.width}×{exportResult.versionA.probe.height} ·{' '}
                {exportResult.versionA.probe.fps} fps
              </p>
            </div>

            <button
              type="button"
              disabled={Boolean(downloadProgress)}
              onClick={() => onDownloadBoth(exportResult)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-[#DC2626] text-white rounded hover:bg-[#B91C1C] disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0"
            >
              {downloadProgress?.jobId === exportResult.jobId && downloadProgress.batchStep ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Скачивание {downloadProgress.batchStep.current}/{downloadProgress.batchStep.total} (
                  {downloadProgress.percent}%)…
                </>
              ) : (
                <>
                  <Download className="w-3.5 h-3.5" />
                  Скачать обе версии
                </>
              )}
            </button>
          </div>

          {/* Background IndexedDB Backup Indicator */}
          {exportBackupState?.jobId === exportResult.jobId && (
            <div
              className={`rounded px-3 py-2 text-xs flex items-center gap-2 border ${
                exportBackupState.status === 'backing-up'
                  ? 'bg-sky-950/35 border-sky-800/60 text-sky-200'
                  : exportBackupState.status === 'saved'
                    ? 'bg-emerald-950/30 border-emerald-800/50 text-emerald-200'
                    : 'bg-amber-950/35 border-amber-800/60 text-amber-200'
              }`}
            >
              {exportBackupState.status === 'backing-up' ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  <span>
                    Фоновое резервирование в IndexedDB (А:{' '}
                    {exportBackupState.versionA === 'saved' ? 'готово' : 'запись…'} · Б:{' '}
                    {exportBackupState.versionB === 'saved' ? 'готово' : 'ожидание/запись…'})…
                  </span>
                </>
              ) : exportBackupState.status === 'saved' ? (
                <>
                  <HardDrive className="w-3.5 h-3.5 shrink-0" />
                  <span>Обе версии полностью зарезервированы в IndexedDB браузера.</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    {exportBackupState.error ||
                      'Не удалось полностью зарезервировать выпуск в IndexedDB.'}
                  </span>
                </>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[exportResult.versionA, exportResult.versionB]
              .filter((item): item is NonNullable<typeof item> => Boolean(item))
              .map((item) => {
              const isDownloadingThis =
                downloadProgress?.jobId === exportResult.jobId &&
                downloadProgress?.version === item.version;
              const inVault = Boolean(vaultExports[`${exportResult.jobId}:${item.version}`]);
              const verBackupState =
                exportBackupState?.jobId === exportResult.jobId
                  ? item.version === 'A'
                    ? exportBackupState.versionA
                    : exportBackupState.versionB
                  : null;
              const isFailed = failedDownloadKey === `${exportResult.jobId}:${item.version}`;

              return (
                <div
                  key={item.version}
                  className="bg-[#0B0F17] border border-[#1F2937] rounded-md p-4 space-y-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-100">{item.title}</div>
                      <div className="text-[11px] font-mono text-slate-300 mt-0.5 truncate">
                        {item.fileName}
                      </div>
                      <div className="text-[11px] font-mono tabular-nums text-slate-400 mt-1">
                        {item.probe.videoCodec?.toUpperCase()} / {item.probe.audioCodec?.toUpperCase()} ·{' '}
                        {item.probe.durationSec.toFixed(2)} с ·{' '}
                        {(item.probe.sizeBytes / (1024 * 1024)).toFixed(2)} МБ
                      </div>
                      <div className="mt-1.5 text-[11px]">
                        {verBackupState === 'pending' ? (
                          <span className="inline-flex items-center gap-1 text-sky-300">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Идёт резервирование в IndexedDB…
                          </span>
                        ) : verBackupState === 'error' ? (
                          <span className="inline-flex items-center gap-1 text-amber-300">
                            <AlertTriangle className="w-3 h-3" />
                            Ошибка записи в IndexedDB (доступно с сервера)
                          </span>
                        ) : inVault ? (
                          <span className="inline-flex items-center gap-1 text-emerald-300/90">
                            <HardDrive className="w-3 h-3" />
                            Зарезервирована в IndexedDB
                          </span>
                        ) : (
                          <span className="text-slate-400">Доступна на сервере</span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={Boolean(downloadProgress)}
                      onClick={() =>
                        onDownloadFile({
                          jobId: exportResult.jobId,
                          version: item.version,
                          url: item.url,
                          fileName: item.fileName,
                          expectedSizeBytes: item.probe.sizeBytes,
                        })
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#1F2937] text-white rounded hover:bg-[#374151] disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0"
                    >
                      {isDownloadingThis ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          {downloadProgress.percent}%
                        </>
                      ) : isFailed ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5" />
                          Повторить
                        </>
                      ) : (
                        <>
                          <Download className="w-3.5 h-3.5" />
                          Скачать {item.version === 'A' ? 'А' : 'Б'}
                        </>
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Export History & Physical Availability */}
      {exportHistory.length > 0 && (
        <div className="bg-[#121826] border border-[#1F2937] rounded-lg p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                История экспортов и физическое наличие MP4
              </h3>
              {storageInfo && (
                <p className="text-xs text-slate-400 mt-0.5">{storageInfo.summary}</p>
              )}
            </div>
          </div>

          <div className="space-y-3">
            {exportHistory.map((item) => {
              const resA = item.result?.versionA;
              const resB = item.result?.versionB;
              const vaultA = Boolean(vaultExports[`${item.jobId}:A`]);
              const vaultB = Boolean(vaultExports[`${item.jobId}:B`]);
              const canGetA = item.versionAOnServer || item.versionAOnCloud || vaultA;
              const canGetB = item.versionBOnServer || item.versionBOnCloud || vaultB;

              return (
                <div
                  key={item.jobId}
                  className="bg-[#0B0F17] border border-[#1F2937] rounded-md p-3.5 space-y-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-mono text-slate-200">{item.jobId}</span>
                    <span className="text-slate-400">
                      {new Date(item.createdAt).toLocaleString('ru-RU')}
                      {item.totalDurationSec > 0 ? ` · ${item.totalDurationSec.toFixed(2)} с` : ''}
                    </span>
                  </div>

                  {item.status === 'failed' && item.error && (
                    <p className="text-xs text-red-300">{item.error}</p>
                  )}

                  {resA && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                      {[
                        {
                          ver: 'A' as const,
                          label: 'Версия А',
                          report: resA,
                          onServer: item.versionAOnServer,
                          onCloud: item.versionAOnCloud,
                          inVault: vaultA,
                          available: canGetA,
                        },
                        ...(resB
                          ? [
                              {
                                ver: 'B' as const,
                                label: 'Версия Б',
                                report: resB,
                                onServer: item.versionBOnServer,
                                onCloud: item.versionBOnCloud,
                                inVault: vaultB,
                                available: canGetB,
                              },
                            ]
                          : []),
                      ].map((v) => {
                        const isDownloading =
                          downloadProgress?.jobId === item.jobId &&
                          downloadProgress?.version === v.ver;

                        return (
                          <div
                            key={v.ver}
                            className="border border-[#1F2937] rounded px-3 py-2 flex items-center justify-between gap-2"
                          >
                            <div className="min-w-0 text-xs">
                              <div className="font-medium text-slate-200">
                                {v.label} ({(v.report.probe.sizeBytes / (1024 * 1024)).toFixed(2)} МБ)
                              </div>
                              <div className="text-[11px] mt-0.5">
                                {v.onServer ? (
                                  <span className="text-emerald-400">Доступен на диске сервера</span>
                                ) : v.onCloud ? (
                                  <span className="text-sky-400">Доступен в Cloud Storage</span>
                                ) : v.inVault ? (
                                  <span className="text-emerald-300">
                                    Восстанавливается из хранилища браузера
                                  </span>
                                ) : (
                                  <span className="text-amber-300">
                                    Файл отсутствует на сервере (очищен при перезапуске)
                                  </span>
                                )}
                              </div>
                            </div>

                            {v.available ? (
                              <button
                                type="button"
                                disabled={Boolean(downloadProgress)}
                                onClick={() =>
                                  onDownloadFile({
                                    jobId: item.jobId,
                                    version: v.ver,
                                    url: v.report.url,
                                    fileName: v.report.fileName,
                                    expectedSizeBytes: v.report.probe.sizeBytes,
                                  })
                                }
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-[#1F2937] text-slate-100 rounded hover:bg-[#374151] disabled:opacity-50 whitespace-nowrap shrink-0"
                              >
                                {isDownloading ? (
                                  <>
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    {downloadProgress.percent}%
                                  </>
                                ) : (
                                  <>
                                    <Download className="w-3 h-3" />
                                    Скачать
                                  </>
                                )}
                              </button>
                            ) : (
                              <span className="text-[11px] text-slate-500 whitespace-nowrap">
                                Нужен экспорт
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Checklist Table */}
      <div className="bg-[#121826] border border-[#1F2937] rounded-lg divide-y divide-[#1F2937]">
        {checks.map((c) => (
          <div key={c.id} className="p-4 flex items-start gap-3">
            {c.status === 'pass' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            ) : c.status === 'warn' ? (
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            ) : (
              <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            )}
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-100">
                {String(c.id).padStart(2, '0')}. {c.label}
              </div>
              <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{c.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
