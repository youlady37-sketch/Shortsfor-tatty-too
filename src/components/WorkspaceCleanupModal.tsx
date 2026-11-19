import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  BookmarkCheck,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import type {
  CleanupBrowserPlan,
  CleanupServerExecutionReport,
  CleanupServerPlan,
} from '../types.ts';
import { formatBytesRu } from '../utils/browserMediaVault.ts';
import {
  type BrowserCleanupExecutionReport,
  buildBrowserCleanupPlan,
  executeBrowserWorkspaceCleanup,
} from '../utils/workspaceCleanup.ts';

interface WorkspaceCleanupModalProps {
  isOpen: boolean;
  isExporting: boolean;
  onClose: () => void;
  onCleanupExecuted: (preserveAdPresets: boolean) => void;
}

export const WorkspaceCleanupModal: React.FC<WorkspaceCleanupModalProps> = ({
  isOpen,
  isExporting,
  onClose,
  onCleanupExecuted,
}) => {
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [serverPlan, setServerPlan] = useState<CleanupServerPlan | null>(null);
  const [browserPlan, setBrowserPlan] = useState<CleanupBrowserPlan | null>(null);
  const [preserveAdPresets, setPreserveAdPresets] = useState(true);
  const [confirmedCheck, setConfirmedCheck] = useState(false);

  const [isExecuting, setIsExecuting] = useState(false);
  const [serverReport, setServerReport] = useState<CleanupServerExecutionReport | null>(null);
  const [browserReport, setBrowserReport] = useState<BrowserCleanupExecutionReport | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);

  const loadPlan = async (preserveFlag = preserveAdPresets) => {
    setLoadingPlan(true);
    setPlanError(null);
    setConfirmedCheck(false);
    setServerReport(null);
    setBrowserReport(null);
    setExecutionError(null);

    try {
      const [srvRes, brPlan] = await Promise.all([
        fetch(`/api/workspace/cleanup-plan?preserveAdPresets=${preserveFlag ? 'true' : 'false'}`),
        buildBrowserCleanupPlan({ preserveAdPresets: preserveFlag }),
      ]);
      const srvData = await srvRes.json();
      if (!srvRes.ok || !srvData.plan) {
        throw new Error(srvData.error || 'Не удалось построить список очистки сервера.');
      }
      setServerPlan(srvData.plan as CleanupServerPlan);
      setBrowserPlan(brPlan);
    } catch (err) {
      setPlanError(
        err instanceof Error ? err.message : 'Ошибка подготовки списка очистки.',
      );
    } finally {
      setLoadingPlan(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setPreserveAdPresets(true);
      void loadPlan(true);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const hasOverlap = (serverPlan?.overlapCount ?? 0) > 0;
  const totalBytesToFree =
    (serverPlan?.counts.totalServerBytes ?? 0) + (browserPlan?.totalBrowserBytes ?? 0);

  const handleTogglePreservePresets = (nextValue: boolean) => {
    setPreserveAdPresets(nextValue);
    void loadPlan(nextValue);
  };

  const handleConfirmCleanup = async () => {
    if (!confirmedCheck || hasOverlap || isExporting) return;
    setIsExecuting(true);
    setExecutionError(null);

    try {
      const [srvRes, brRes] = await Promise.all([
        fetch('/api/workspace/cleanup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true, preserveAdPresets }),
        }),
        executeBrowserWorkspaceCleanup({ preserveAdPresets }),
      ]);

      const srvJson = await srvRes.json();
      if (!srvRes.ok || !srvJson.report) {
        throw new Error(srvJson.error || 'Ошибка очистки серверных данных.');
      }

      setServerReport(srvJson.report as CleanupServerExecutionReport);
      setBrowserReport(brRes);
      onCleanupExecuted(preserveAdPresets);
    } catch (err) {
      setExecutionError(
        err instanceof Error ? err.message : 'Ошибка при очистке рабочего пространства.',
      );
    } finally {
      setIsExecuting(false);
    }
  };

  const cleanupFinished = Boolean(serverReport && browserReport);
  const cleanupAllSuccess = Boolean(serverReport?.success && browserReport?.success);

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-[#121826] border border-[#242E42] rounded-lg max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-[#1F2937] flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Trash2 className="w-4 h-4 text-red-400 shrink-0" />
            <h2 className="text-sm font-semibold text-white">
              Полная очистка рабочего пространства
            </h2>
          </div>
          <button
            type="button"
            disabled={isExecuting}
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white disabled:opacity-40"
            aria-label="Закрыть"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4 text-xs">
          {isExporting && (
            <div className="p-3 bg-amber-950/35 border border-amber-800/60 rounded text-amber-200 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <span>
                Сейчас выполняется сборка экспорта FFmpeg. Дождитесь завершения экспорта перед
                очисткой.
              </span>
            </div>
          )}

          {loadingPlan && (
            <div className="py-10 flex items-center justify-center gap-2 text-slate-300">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Подготовка списка удаления и проверка защищённых ресурсов…</span>
            </div>
          )}

          {planError && (
            <div className="p-3 bg-red-950/35 border border-red-900/60 rounded text-red-200">
              {planError}
            </div>
          )}

          {!loadingPlan && serverPlan && browserPlan && !cleanupFinished && (
            <>
              {hasOverlap && (
                <div className="p-3 bg-red-950/45 border border-red-800 rounded text-red-200 space-y-1">
                  <div className="font-semibold">
                    Операция заблокирована: обнаружено пересечение с защищёнными ресурсами
                  </div>
                  <div className="font-mono">{serverPlan.overlapPaths.join(', ')}</div>
                </div>
              )}

              <div className="p-3.5 bg-red-950/25 border border-red-900/50 rounded space-y-1.5 text-red-200">
                <div className="font-semibold text-red-300 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  Внимание: удаление временных файлов выпуска необратимо
                </div>
                <p className="leading-relaxed">
                  Будут удалены все загруженные исходники, готовые MP4, промежуточные сегменты,
                  история экспортов, временные рекламные баннеры, GIF, рекламное аудио, слои
                  текущего выпуска и кэш браузера (IndexedDB / OPFS / Cache Storage / рабочие ключи).
                </p>
              </div>

              {/* Persistent Advertiser Presets Choice */}
              <div className="p-3.5 bg-[#0B0F17] border border-[#242E42] rounded space-y-2">
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={preserveAdPresets}
                    onChange={(e) => handleTogglePreservePresets(e.target.checked)}
                    className="w-4 h-4 mt-0.5 accent-[#DC2626]"
                  />
                  <div className="space-y-1">
                    <div className="font-semibold text-slate-100 flex items-center gap-1.5">
                      <BookmarkCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      Сохранять постоянные рекламные пресеты (рекомендуется)
                    </div>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      Сохраняются названия рекламодателей, шаблоны требований, настройки размещения,
                      громкости и аудио. Временные изображения, GIF, аудиофайлы и слои текущего
                      выпуска удаляются в любом случае.
                    </p>
                    <div className="text-[11px] font-mono text-slate-300">
                      {preserveAdPresets
                        ? `Будет сохранено пресетов — сервер: ${serverPlan.preservedPresetsCount}, IndexedDB: ${browserPlan.idbPresetsCount}`
                        : `Отказ от сохранения: все пресеты (сервер: ${serverPlan.preservedPresetsCount || 'файл при наличии'}, IndexedDB: ${browserPlan.idbPresetsCount}) также будут удалены`}
                    </div>
                  </div>
                </label>
              </div>

              {/* Deletion Summary Counts */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                <div className="bg-[#0B0F17] border border-[#1F2937] rounded p-2.5">
                  <div className="text-slate-400 text-[11px]">Исходные видео и аудио</div>
                  <div className="font-mono tabular-nums text-slate-100 font-semibold mt-0.5">
                    Сервер: {serverPlan.counts.sourceVideosCount + serverPlan.counts.sourceAudioCount} · IDB:{' '}
                    {browserPlan.idbSourcesCount}
                  </div>
                </div>
                <div className="bg-[#0B0F17] border border-[#1F2937] rounded p-2.5">
                  <div className="text-slate-400 text-[11px]">Готовые MP4 экспортов</div>
                  <div className="font-mono tabular-nums text-slate-100 font-semibold mt-0.5">
                    Сервер: {serverPlan.counts.exportedMp4Count} · IDB: {browserPlan.idbExportsCount}
                  </div>
                </div>
                <div className="bg-[#0B0F17] border border-[#1F2937] rounded p-2.5">
                  <div className="text-slate-400 text-[11px]">Временная реклама (изобр. / аудио)</div>
                  <div className="font-mono tabular-nums text-slate-100 font-semibold mt-0.5">
                    Сервер: {serverPlan.counts.adFilesCount} ({serverPlan.counts.adVisualFilesCount ?? serverPlan.counts.adFilesCount}/
                    {serverPlan.counts.adAudioFilesCount ?? 0}) · IDB: {browserPlan.idbAdsCount}
                  </div>
                </div>
                <div className="bg-[#0B0F17] border border-[#1F2937] rounded p-2.5">
                  <div className="text-slate-400 text-[11px]">OPFS / Cache / Storage</div>
                  <div className="font-mono tabular-nums text-slate-100 font-semibold mt-0.5">
                    {browserPlan.opfsFilesCount} / {browserPlan.cacheEntriesCount} /{' '}
                    {browserPlan.storageKeysCount}
                  </div>
                </div>
                <div className="bg-[#0B0F17] border border-[#1F2937] rounded p-2.5 col-span-2">
                  <div className="text-slate-400 text-[11px]">Будет освобождено места</div>
                  <div className="font-mono tabular-nums text-emerald-300 font-semibold mt-0.5">
                    {formatBytesRu(totalBytesToFree)} (сервер: {formatBytesRu(serverPlan.counts.totalServerBytes)},
                    браузер: {formatBytesRu(browserPlan.totalBrowserBytes)})
                  </div>
                </div>
              </div>

              {/* Protected Resources List */}
              <div className="bg-[#0B0F17] border border-emerald-900/50 rounded p-3.5 space-y-2">
                <div className="font-semibold text-emerald-300 flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 shrink-0" />
                  Защищённые ресурсы бренда и приложения (НЕ удаляются, пересечение: 0)
                </div>
                <ul className="space-y-1 text-[11px] text-slate-300">
                  {serverPlan.protectedResources.map((item) => (
                    <li key={item.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">
                        [{item.categoryLabel ?? item.kind}] {item.label}
                      </span>
                      <span className="font-mono text-slate-500 shrink-0 truncate max-w-[220px]" title={item.relativePath}>
                        {item.relativePath}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <label className="flex items-start gap-2.5 p-3 bg-[#0B0F17] border border-[#1F2937] rounded cursor-pointer">
                <input
                  type="checkbox"
                  checked={confirmedCheck}
                  onChange={(e) => setConfirmedCheck(e.target.checked)}
                  className="w-4 h-4 mt-0.5 accent-[#DC2626]"
                />
                <span className="text-slate-200 leading-relaxed">
                  Подтверждаю удаление всех рабочих видео, экспортов, временных рекламных файлов и
                  кэша браузера
                  {preserveAdPresets ? ' (с сохранением постоянных рекламных пресетов)' : ' (включая все рекламные пресеты)'}.
                  Понимаю, что отменить удаление нельзя.
                </span>
              </label>
            </>
          )}

          {executionError && (
            <div className="p-3 bg-red-950/40 border border-red-900/60 rounded text-red-200">
              {executionError}
            </div>
          )}

          {/* Post-Cleanup Verification Report */}
          {cleanupFinished && serverReport && browserReport && (
            <div className="space-y-3">
              <div
                className={`p-3.5 rounded border flex items-start gap-2.5 ${
                  cleanupAllSuccess
                    ? 'bg-emerald-950/30 border-emerald-800/60 text-emerald-200'
                    : 'bg-amber-950/35 border-amber-800/60 text-amber-200'
                }`}
              >
                {cleanupAllSuccess ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                )}
                <div>
                  <div className="font-semibold">
                    {cleanupAllSuccess
                      ? 'Очистка рабочего пространства выполнена и подтверждена'
                      : 'Очистка выполнена частично — требуются повторные действия'}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-300">
                    Удалено объектов: {serverReport.deletedItems.length + browserReport.deletedItems.length} ·
                    Освобождено на сервере: {formatBytesRu(serverReport.freedServerBytes)}
                  </div>
                </div>
              </div>

              {(serverReport.errors.length > 0 || browserReport.errors.length > 0) && (
                <div className="p-3 bg-red-950/35 border border-red-900/60 rounded space-y-1 text-red-200">
                  <div className="font-semibold">Ошибки и оставшиеся элементы:</div>
                  {[...serverReport.errors, ...browserReport.errors].map((e, i) => (
                    <div key={i}>{e}</div>
                  ))}
                  {[...serverReport.remainingItems, ...browserReport.remainingItems].map(
                    (rem, i) => (
                      <div key={i} className="font-mono text-[11px]">
                        Осталось: {rem}
                      </div>
                    ),
                  )}
                </div>
              )}

              <div className="bg-[#0B0F17] border border-[#1F2937] rounded p-3.5 space-y-2">
                <div className="font-semibold text-slate-200">
                  Проверка хранилищ браузера и сервера
                </div>
                {browserReport.verification.map((v) => (
                  <div key={v.id} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="text-slate-300 truncate">{v.label}</span>
                    <span className={v.ok ? 'text-emerald-400' : 'text-red-400'}>
                      {v.detail}
                    </span>
                  </div>
                ))}
              </div>

              <div className="bg-[#0B0F17] border border-[#1F2937] rounded p-3.5 space-y-2">
                <div className="font-semibold text-slate-200">
                  Проверка сохранности защищённых ресурсов бренда
                </div>
                {serverReport.protectedVerification.map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="text-slate-300 truncate">{p.label}</span>
                    <span className={p.ok ? 'text-emerald-400 inline-flex items-center gap-1' : 'text-red-400 inline-flex items-center gap-1'}>
                      {p.ok ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                      {p.detail}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3.5 border-t border-[#1F2937] flex items-center justify-end gap-3">
          {!cleanupFinished ? (
            <>
              <button
                type="button"
                disabled={isExecuting}
                onClick={onClose}
                className="px-3.5 py-2 text-xs font-medium bg-[#0B0F17] border border-[#242E42] text-slate-300 rounded hover:text-white"
              >
                Отмена
              </button>
              <button
                type="button"
                disabled={!confirmedCheck || hasOverlap || isExporting || isExecuting || loadingPlan}
                onClick={() => void handleConfirmCleanup()}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-[#DC2626] text-white rounded hover:bg-[#B91C1C] disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
              >
                {isExecuting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Очистка и проверка…
                  </>
                ) : (
                  <>
                    <Trash2 className="w-3.5 h-3.5" />
                    Подтвердить полную очистку
                  </>
                )}
              </button>
            </>
          ) : (
            <>
              {!cleanupAllSuccess && (
                <button
                  type="button"
                  onClick={() => void loadPlan(preserveAdPresets)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-[#1F2937] text-white rounded hover:bg-[#374151]"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Повторить очистку
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium bg-[#DC2626] text-white rounded hover:bg-[#B91C1C]"
              >
                Готово
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
