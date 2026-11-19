import React from 'react';
import { AlertTriangle, CheckCircle2, HardDrive, Loader2, Trash2 } from 'lucide-react';
import type { BrowserVaultDiagnostics, StorageEnvironmentInfo } from '../types.ts';
import { formatBytesRu } from '../utils/browserMediaVault.ts';

interface StorageStatusCardProps {
  diagnostics: BrowserVaultDiagnostics | null;
  storageInfo: StorageEnvironmentInfo | null;
  vaultWarning: string | null;
  onOpenCleanupModal?: () => void;
}

export const StorageStatusCard: React.FC<StorageStatusCardProps> = ({
  diagnostics,
  storageInfo,
  vaultWarning,
  onOpenCleanupModal,
}) => {
  const activeError =
    vaultWarning ||
    (diagnostics?.lastBackupStatus === 'error' ? diagnostics.lastBackupMessage : null);

  return (
    <div className="bg-[#121826] border border-[#1F2937] rounded-lg p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <HardDrive className="w-4 h-4 text-slate-300" />
          <h3 className="text-sm font-semibold text-slate-100">
            Статус хранилища браузера (IndexedDB)
          </h3>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {diagnostics && (
            <span
              className={`text-[11px] px-2 py-0.5 rounded border ${
                !diagnostics.supported
                  ? 'bg-red-950/40 border-red-800/60 text-red-300'
                  : diagnostics.persisted === true
                    ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                    : 'bg-[#0B0F17] border-[#242E42] text-slate-300'
              }`}
            >
              {!diagnostics.supported
                ? 'IndexedDB недоступен'
                : diagnostics.persisted === true
                  ? 'navigator.storage.persist(): true (защищённое)'
                  : diagnostics.persisted === false
                    ? 'navigator.storage.persist(): false (штатный режим best-effort)'
                    : 'persist(): не поддерживается'}
            </span>
          )}

          {onOpenCleanupModal && (
            <button
              type="button"
              onClick={onOpenCleanupModal}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-[#0B0F17] border border-red-900/60 text-red-300 rounded hover:bg-red-950/40 hover:border-red-700 transition-colors whitespace-nowrap"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Полная очистка рабочего пространства
            </button>
          )}
        </div>
      </div>

      {storageInfo && (
        <p className="text-xs text-slate-400 leading-relaxed">{storageInfo.summary}</p>
      )}

      {diagnostics && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div className="bg-[#0B0F17] border border-[#1F2937] rounded p-2.5">
            <div className="text-slate-400 text-[11px]">Общий доступный объём</div>
            <div className="font-mono tabular-nums text-slate-100 font-medium mt-0.5">
              {formatBytesRu(diagnostics.quotaBytes)}
            </div>
          </div>

          <div className="bg-[#0B0F17] border border-[#1F2937] rounded p-2.5">
            <div className="text-slate-400 text-[11px]">Занято место</div>
            <div className="font-mono tabular-nums text-slate-100 font-medium mt-0.5">
              {formatBytesRu(diagnostics.usageBytes)}
              {diagnostics.indexedDbUsageBytes !== null && (
                <span className="text-slate-400 font-normal">
                  {' '}
                  (IndexedDB: {formatBytesRu(diagnostics.indexedDbUsageBytes)})
                </span>
              )}
            </div>
          </div>

          <div className="bg-[#0B0F17] border border-[#1F2937] rounded p-2.5">
            <div className="text-slate-400 text-[11px]">Последнее резервирование</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-slate-100 font-medium">
              {diagnostics.lastBackupStatus === 'saving' ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 text-sky-400 animate-spin shrink-0" />
                  <span className="truncate text-sky-300">Запись в IndexedDB…</span>
                </>
              ) : diagnostics.lastBackupStatus === 'saved' ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="truncate text-emerald-300">
                    Сохранено
                    {diagnostics.lastBackupAt
                      ? ` (${new Date(diagnostics.lastBackupAt).toLocaleTimeString('ru-RU')})`
                      : ''}
                  </span>
                </>
              ) : diagnostics.lastBackupStatus === 'error' ? (
                <>
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span className="truncate text-amber-300">Ошибка сохранения</span>
                </>
              ) : (
                <span className="text-slate-400 font-normal">Ожидание сохранения</span>
              )}
            </div>
          </div>
        </div>
      )}

      {diagnostics?.lastBackupMessage && diagnostics.lastBackupStatus !== 'error' && (
        <p className="text-[11px] text-slate-400 leading-relaxed">
          {diagnostics.lastBackupMessage}
        </p>
      )}

      {activeError && (
        <div className="p-2.5 bg-amber-950/35 border border-amber-800/60 rounded text-xs text-amber-200 flex items-start gap-2 leading-relaxed">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <span>{activeError}</span>
        </div>
      )}
    </div>
  );
};
