import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Film, HardDrive, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { AdsPanel } from './components/AdsPanel.tsx';
import { AssetsPanel } from './components/AssetsPanel.tsx';
import { CoverStudio } from './components/CoverStudio.tsx';
import { MonitorPreview } from './components/MonitorPreview.tsx';
import { QualityChecklist } from './components/QualityChecklist.tsx';
import { SubtitleEditor } from './components/SubtitleEditor.tsx';
import { TimelineEditor } from './components/TimelineEditor.tsx';
import { WorkspaceCleanupModal } from './components/WorkspaceCleanupModal.tsx';
import {
  backupExportResultToVault,
  downloadBothExportVersions,
  downloadExportFile,
} from './utils/downloadExportFile.ts';
import {
  deleteAdPresetFromVault,
  getBrowserVaultDiagnostics,
  getSourceFromVault,
  listAdAssetsInVault,
  listAdAudioInVault,
  listAdPresetsInVault,
  listExportsInVault,
  listSourcesInVault,
  saveAdPresetToVault,
  syncAdPresetsVault,
} from './utils/browserMediaVault.ts';
import { uploadSourceFileToServer } from './utils/uploadSourceFile.ts';
import type {
  AdAssetInfo,
  AdAudioAssetInfo,
  AdOverlayLayer,
  AdPreset,
  BrowserVaultDiagnostics,
  CutSegment,
  DownloadProgressInfo,
  ExportHistoryItem,
  ExportJobResult,
  ExportJobStatus,
  ExportVaultBackupState,
  MissingUploadedAsset,
  PreloadedOverlay,
  SourceRole,
  StorageEnvironmentInfo,
  SubtitleCue,
  UploadedAsset,
} from './types.ts';

type TabKey = 'timeline' | 'subtitles' | 'ads' | 'assets' | 'cover' | 'qc';

const INITIAL_SEGMENTS: CutSegment[] = [
  {
    id: 'seg-hook',
    sourceRole: 'fragment8',
    beatTitle: '1. Сильный начальный хук (приговор Соколову)',
    startSec: 250, // 00:04:10
    endSec: 262, // 00:04:22
    cropOffsetX: 0,
    overlayId: null,
  },
  {
    id: 'seg-lawyer-advice',
    sourceRole: 'fragment9',
    beatTitle: '2. Совет адвоката и надежда на мягкий приговор',
    startSec: 0, // 00:00:00
    endSec: 13,
    cropOffsetX: 0,
    overlayId: null,
  },
  {
    id: 'seg-five-years',
    sourceRole: 'fragment9',
    beatTitle: '3. Обещанные пять лет',
    startSec: 15,
    endSec: 27,
    cropOffsetX: 0,
    overlayId: null,
  },
  {
    id: 'seg-real-verdict',
    sourceRole: 'fragment9',
    beatTitle: '4. Реальный приговор',
    startSec: 30,
    endSec: 41,
    cropOffsetX: 0,
    overlayId: null,
  },
  {
    id: 'seg-final-line',
    sourceRole: 'fragment9',
    beatTitle: '5. Реплика: «Извините, Артём Александрович…»',
    startSec: 64,
    endSec: 73, // up to 00:01:13
    cropOffsetX: 0,
    overlayId: null,
  },
];

const INITIAL_SUBTITLES: SubtitleCue[] = [
  {
    id: 'sub-final-quote',
    startSec: 48.0,
    endSec: 56.5,
    line1: 'Извините, Артём Александрович,',
    line2: 'что я вам не поверил.',
  },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('timeline');
  const [preloaded, setPreloaded] = useState<PreloadedOverlay[]>([]);
  const [uploadedAssets, setUploadedAssets] = useState<
    Partial<Record<SourceRole, UploadedAsset>>
  >({});
  const [missingAssets, setMissingAssets] = useState<
    Partial<Record<SourceRole, MissingUploadedAsset>>
  >({});
  const [restoringRoles, setRestoringRoles] = useState<Partial<Record<SourceRole, boolean>>>({});
  const [vaultSources, setVaultSources] = useState<
    Record<string, { originalName: string; sizeBytes: number; savedAt: string }>
  >({});
  const [vaultExports, setVaultExports] = useState<
    Record<string, { jobId: string; version: 'A' | 'B'; fileName: string; sizeBytes: number; savedAt: string }>
  >({});
  const [exportHistory, setExportHistory] = useState<ExportHistoryItem[]>([]);
  const [storageInfo, setStorageInfo] = useState<StorageEnvironmentInfo | null>(null);
  const [vaultDiagnostics, setVaultDiagnostics] = useState<BrowserVaultDiagnostics | null>(null);
  const [vaultWarning, setVaultWarning] = useState<string | null>(null);
  const [exportBackupState, setExportBackupState] = useState<ExportVaultBackupState | null>(null);

  const [segments, setSegments] = useState<CutSegment[]>(INITIAL_SEGMENTS);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(
    INITIAL_SEGMENTS[0].id,
  );
  const [subtitles, setSubtitles] = useState<SubtitleCue[]>(INITIAL_SUBTITLES);

  const [endplateAssetId, setEndplateAssetId] = useState<string>('preloaded:shorts-04');
  const [endplateDurationSec, setEndplateDurationSec] = useState<number>(2.0);
  const [audioLogoAssetId, setAudioLogoAssetId] = useState<string>('preloaded:audio-logo');
  const [useUploadedMusic, setUseUploadedMusic] = useState<boolean>(false);
  const [musicGainDb, setMusicGainDb] = useState<number>(-22);

  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [pollNotice, setPollNotice] = useState<string | null>(null);
  const [exportJob, setExportJob] = useState<ExportJobStatus | null>(null);
  const [exportElapsedSec, setExportElapsedSec] = useState<number>(0);
  const [exportResult, setExportResult] = useState<ExportJobResult | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressInfo | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [failedDownloadKey, setFailedDownloadKey] = useState<string | null>(null);
  const [adAssets, setAdAssets] = useState<AdAssetInfo[]>([]);
  const [adAudioAssets, setAdAudioAssets] = useState<AdAudioAssetInfo[]>([]);
  const [adLayers, setAdLayers] = useState<AdOverlayLayer[]>([]);
  const [adPresets, setAdPresets] = useState<AdPreset[]>([]);
  const [selectedAdLayerId, setSelectedAdLayerId] = useState<string | null>(null);
  const [isCleanupModalOpen, setIsCleanupModalOpen] = useState(false);
  const pollTimerRef = useRef<number | null>(null);

  const refreshVaultLists = async () => {
    const [sources, exportsMap, diag] = await Promise.all([
      listSourcesInVault(),
      listExportsInVault(),
      getBrowserVaultDiagnostics(),
    ]);
    setVaultSources(sources);
    setVaultExports(exportsMap);
    setVaultDiagnostics(diag);
    return { sources, exportsMap, diag };
  };

  const refreshExportHistory = async () => {
    try {
      const res = await fetch('/api/exports');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.exportHistory)) {
        setExportHistory(data.exportHistory);
      }
      if (data.latestExport !== undefined) {
        setExportResult(data.latestExport);
      }
      if (data.storage) {
        setStorageInfo(data.storage);
      }
    } catch {
      // ignore transient error
    }
  };

  const restoreSourceRoleFromVault = async (
    role: SourceRole,
    isCancelled?: () => boolean,
  ): Promise<boolean> => {
    const cached = await getSourceFromVault(role);
    if (!cached || isCancelled?.()) return false;

    setRestoringRoles((prev) => ({ ...prev, [role]: true }));
    try {
      const file = new File([cached.blob], cached.originalName, {
        type: cached.mimeType || 'application/octet-stream',
      });
      const result = await uploadSourceFileToServer({
        role,
        file,
        assignBothSlots: false,
      });
      if (!isCancelled?.()) {
        handleAssetsSynced(result.assignedAssets);
        return true;
      }
    } catch (err) {
      setVaultWarning(
        err instanceof Error
          ? err.message
          : `Ошибка при восстановлении «${cached.originalName}» из IndexedDB.`,
      );
    } finally {
      if (!isCancelled?.()) {
        setRestoringRoles((prev) => {
          const next = { ...prev };
          delete next[role];
          return next;
        });
      }
    }
    return false;
  };

  useEffect(() => {
    let cancelled = false;

    const loadInitialState = async () => {
      await refreshVaultLists();
      try {
        const res = await fetch('/api/project-state');
        const data = await res.json();
        if (cancelled) return;

        if (Array.isArray(data.preloaded)) {
          setPreloaded(data.preloaded);
        }
        const serverUploaded = (data.uploaded ?? {}) as Partial<Record<SourceRole, UploadedAsset>>;
        setUploadedAssets(serverUploaded);

        if (data.missingUploaded) {
          setMissingAssets(data.missingUploaded);
        }
        if (data.latestExport) {
          setExportResult(data.latestExport);
        }
        if (Array.isArray(data.exportHistory)) {
          setExportHistory(data.exportHistory);
        }
        if (data.storage) {
          setStorageInfo(data.storage);
        }

        // Автоматическое восстановление исходников из IndexedDB при открытии проекта отключено:
        // пользователь выбирает MP4 вручную с компьютера (или запускает восстановление по желанию),
        // чтобы не блокировать обычную загрузку и не перезаписывать серверное состояние.

        // Load Ad assets, audio, layers, presets + restore missing ad files & persistent presets from IndexedDB v2
        try {
          const [adRes, vaultAds, vaultAdAudio, vaultPresets] = await Promise.all([
            fetch('/api/ads/state'),
            listAdAssetsInVault(),
            listAdAudioInVault(),
            listAdPresetsInVault(),
          ]);
          if (adRes.ok && !cancelled) {
            const adData = await adRes.json();
            const serverAds: AdAssetInfo[] = Array.isArray(adData.assets) ? adData.assets : [];
            const serverAdIds = new Set(serverAds.map((a) => a.id));
            const restoredAds: AdAssetInfo[] = [...serverAds];

            for (const rec of vaultAds) {
              if (cancelled) break;
              if (!serverAdIds.has(rec.id) && rec.assetInfo) {
                const file = new File([rec.blob], rec.assetInfo.originalName, {
                  type: rec.assetInfo.mimeType || 'image/png',
                });
                const fd = new FormData();
                fd.append('assetId', rec.id);
                fd.append('file', file);
                const upAdRes = await fetch('/api/upload-ad', { method: 'POST', body: fd });
                if (upAdRes.ok) {
                  const upAdJson = await upAdRes.json();
                  if (upAdJson.asset) {
                    restoredAds.push(upAdJson.asset as AdAssetInfo);
                  }
                }
              }
            }

            const serverAudio: AdAudioAssetInfo[] = Array.isArray(adData.audioAssets)
              ? (adData.audioAssets as AdAudioAssetInfo[])
              : [];
            const serverAudioIds = new Set(serverAudio.map((a) => a.id));
            const restoredAudio: AdAudioAssetInfo[] = [...serverAudio];

            for (const rec of vaultAdAudio) {
              if (cancelled) break;
              if (!serverAudioIds.has(rec.id) && rec.audioInfo) {
                const file = new File([rec.blob], rec.audioInfo.originalName, {
                  type: rec.audioInfo.mimeType || 'audio/mpeg',
                });
                const fd = new FormData();
                fd.append('audioId', rec.id);
                fd.append('file', file);
                const upAudioRes = await fetch('/api/upload-ad-audio', { method: 'POST', body: fd });
                if (upAudioRes.ok) {
                  const upAudioJson = await upAudioRes.json();
                  if (upAudioJson.audioAsset) {
                    restoredAudio.push(upAudioJson.audioAsset as AdAudioAssetInfo);
                  }
                }
              }
            }

            const serverPresets: AdPreset[] = Array.isArray(adData.presets)
              ? (adData.presets as AdPreset[])
              : [];
            let syncedPresets: AdPreset[] = serverPresets;
            if (serverPresets.length > 0) {
              void syncAdPresetsVault(serverPresets);
            } else if (vaultPresets.length > 0) {
              syncedPresets = vaultPresets;
              for (const vp of vaultPresets) {
                if (cancelled) break;
                await fetch('/api/ads/presets', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ preset: vp }),
                }).catch(() => undefined);
              }
            }

            if (!cancelled) {
              setAdAssets(restoredAds);
              setAdAudioAssets(restoredAudio);
              const layers = Array.isArray(adData.layers) ? (adData.layers as AdOverlayLayer[]) : [];
              setAdLayers(layers);
              setSelectedAdLayerId(layers[0]?.id ?? null);
              setAdPresets(syncedPresets);
            }
          }
        } catch {
          // ignore ad state init error
        }

        if (!cancelled) {
          await refreshVaultLists();
        }
      } catch {
        // ignore startup failure
      }
    };

    void loadInitialState();

    return () => {
      cancelled = true;
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isExporting || !exportJob?.startedAt) return;
    const tick = () => {
      const startedMs = Date.parse(exportJob.startedAt);
      if (!Number.isNaN(startedMs)) {
        setExportElapsedSec(Math.max(0, Math.floor((Date.now() - startedMs) / 1000)));
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [isExporting, exportJob?.startedAt]);

  const mainDurationSec = useMemo(
    () =>
      segments.reduce((acc, seg) => acc + Math.max(0, seg.endSec - seg.startSec), 0),
    [segments],
  );
  const totalDurationSec = mainDurationSec + endplateDurationSec;

  const activeSegment =
    segments.find((s) => s.id === selectedSegmentId) ?? segments[0] ?? null;

  const hasBothSources = Boolean(uploadedAssets.fragment8 && uploadedAssets.fragment9);

  const handleAssetsSynced = (assigned: Partial<Record<SourceRole, UploadedAsset>>) => {
    setUploadedAssets((prev) => ({ ...prev, ...assigned }));
    setMissingAssets((prev) => {
      const next = { ...prev };
      for (const roleKey of Object.keys(assigned)) {
        delete next[roleKey as SourceRole];
      }
      return next;
    });
    if (assigned.music) setUseUploadedMusic(true);
    if (assigned.endplate) setEndplateAssetId('uploaded:endplate');
    if (assigned.audioLogo) setAudioLogoAssetId('uploaded:audioLogo');
    void refreshVaultLists();
  };

  const handleAssetUploaded = (role: SourceRole, asset: UploadedAsset) => {
    handleAssetsSynced({ [role]: asset });
  };

  const handleAssetRemoved = (role: SourceRole) => {
    setUploadedAssets((prev) => {
      const next = { ...prev };
      delete next[role];
      return next;
    });
    setMissingAssets((prev) => {
      const next = { ...prev };
      delete next[role];
      return next;
    });
    if (role === 'music') setUseUploadedMusic(false);
    if (role === 'endplate') setEndplateAssetId('preloaded:shorts-04');
    if (role === 'audioLogo') setAudioLogoAssetId('preloaded:audio-logo');
    void refreshVaultLists();
  };

  const handleDownloadFile = async (params: {
    jobId: string;
    version: 'A' | 'B';
    url: string;
    fileName: string;
    expectedSizeBytes?: number;
  }) => {
    setDownloadError(null);
    setFailedDownloadKey(null);
    setDownloadProgress({
      jobId: params.jobId,
      version: params.version,
      downloadedBytes: 0,
      totalBytes: params.expectedSizeBytes ?? 0,
      percent: 0,
      source: 'server-range',
    });

    try {
      const outcome = await downloadExportFile({
        ...params,
        onProgress: (info) => setDownloadProgress(info),
      });
      if (outcome.vaultSaveResult && !outcome.vaultSaveResult.ok && outcome.vaultSaveResult.error) {
        setVaultWarning(outcome.vaultSaveResult.error);
      }
      await refreshVaultLists();
    } catch (err) {
      setFailedDownloadKey(`${params.jobId}:${params.version}`);
      setDownloadError(
        err instanceof Error ? err.message : 'Не удалось скачать MP4-файл.',
      );
    } finally {
      setDownloadProgress(null);
    }
  };

  const handleDownloadBoth = async (result: ExportJobResult) => {
    setDownloadError(null);
    setFailedDownloadKey(null);
    setDownloadProgress({
      jobId: result.jobId,
      version: 'A',
      downloadedBytes: 0,
      totalBytes: result.versionA.probe.sizeBytes,
      percent: 0,
      source: 'server-range',
      batchStep: { current: 1, total: 2 },
    });

    try {
      const outcome = await downloadBothExportVersions({
        result,
        onProgress: (info) => setDownloadProgress(info),
      });
      if (outcome.vaultWarning) {
        setVaultWarning(outcome.vaultWarning);
      }
      await refreshVaultLists();
    } catch (err) {
      setDownloadError(
        err instanceof Error ? err.message : 'Не удалось последовательно скачать обе версии MP4.',
      );
    } finally {
      setDownloadProgress(null);
    }
  };

  const handleUpdateSegment = (id: string, patch: Partial<CutSegment>) => {
    setSegments((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const handleMoveSegment = (id: string, dir: -1 | 1) => {
    setSegments((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      const nextIdx = idx + dir;
      if (idx < 0 || nextIdx < 0 || nextIdx >= prev.length) return prev;
      const copy = [...prev];
      const [item] = copy.splice(idx, 1);
      copy.splice(nextIdx, 0, item);
      return copy;
    });
  };

  const handleDeleteSegment = (id: string) => {
    setSegments((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((s) => s.id !== id);
      if (selectedSegmentId === id) {
        setSelectedSegmentId(next[0]?.id ?? null);
      }
      return next;
    });
  };

  const handleAddSegment = () => {
    const id = `seg-${Date.now()}`;
    setSegments((prev) => [
      ...prev,
      {
        id,
        sourceRole: 'fragment9',
        beatTitle: 'Новый монтажный фрагмент',
        startSec: 0,
        endSec: 5,
        cropOffsetX: 0,
        overlayId: null,
      },
    ]);
    setSelectedSegmentId(id);
  };

  const parseJsonSafe = async (res: Response): Promise<Record<string, unknown>> => {
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { error: `HTTP ${res.status}: ${text.slice(0, 220)}` };
    }
  };

  const pollJobStatus = async (jobId: string, retryAttempt = 0) => {
    try {
      const res = await fetch(`/api/export/${encodeURIComponent(jobId)}`);

      if (res.status === 429) {
        const retryAfterHeader = res.headers.get('Retry-After');
        const headerSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
        const backoffSteps = [10, 15, 25, 35];
        const waitSec =
          Number.isFinite(headerSec) && headerSec > 0
            ? Math.min(60, Math.ceil(headerSec))
            : backoffSteps[Math.min(retryAttempt, backoffSteps.length - 1)];

        setPollNotice(
          `Шлюз ограничил частоту опроса (HTTP 429) — повторная проверка через ${waitSec} с. Сборка FFmpeg на сервере продолжается.`,
        );
        pollTimerRef.current = window.setTimeout(() => {
          void pollJobStatus(jobId, retryAttempt + 1);
        }, waitSec * 1000);
        return;
      }

      const data = await parseJsonSafe(res);
      if (!res.ok) {
        throw new Error(
          typeof data.error === 'string'
            ? data.error
            : `Ошибка проверки статуса (HTTP ${res.status}).`,
        );
      }
      const job = data.job as ExportJobStatus | undefined;
      if (!job) {
        throw new Error('Сервер вернул некорректный статус задачи экспорта.');
      }
      setPollNotice(null);
      setExportJob(job);

      if (job.status === 'completed' && job.result) {
        const completedResult = job.result;
        setExportResult(completedResult);
        setIsExporting(false);
        setActiveTab('qc');
        void refreshExportHistory();
        void backupExportResultToVault(completedResult, (backupState) => {
          setExportBackupState(backupState);
          if (backupState.error) {
            setVaultWarning(backupState.error);
          }
        }).then(() => refreshVaultLists());
        return;
      }

      if (job.status === 'failed') {
        setExportError(job.error || 'Сборка MP4 завершилась с ошибкой FFmpeg.');
        setIsExporting(false);
        return;
      }

      pollTimerRef.current = window.setTimeout(() => {
        void pollJobStatus(jobId, 0);
      }, 6000);
    } catch (err) {
      const isNetworkErr = err instanceof TypeError;
      if (isNetworkErr && retryAttempt < 5) {
        const waitSec = 8 + retryAttempt * 5;
        setPollNotice(`Временный сбой сети — повторная проверка статуса через ${waitSec} с…`);
        pollTimerRef.current = window.setTimeout(() => {
          void pollJobStatus(jobId, retryAttempt + 1);
        }, waitSec * 1000);
        return;
      }
      setPollNotice(null);
      setExportError(
        err instanceof Error
          ? err.message
          : 'Потеряна связь с сервером при проверке статуса экспорта.',
      );
      setIsExporting(false);
    }
  };

  const handleExport = async () => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setExportError(null);
    setPollNotice(null);
    setExportResult(null);
    setExportElapsedSec(0);
    setIsExporting(true);

    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          segments,
          subtitles,
          endplateAssetId,
          endplateDurationSec,
          audioLogoAssetId,
          musicGainDb,
          useUploadedMusic,
          adLayers,
        }),
      });
      const data = await parseJsonSafe(res);
      if (!res.ok) {
        throw new Error(
          typeof data.error === 'string'
            ? data.error
            : `Не удалось запустить экспорт MP4 (HTTP ${res.status}).`,
        );
      }
      const job = data.job as ExportJobStatus | undefined;
      if (!job?.jobId) {
        throw new Error('Сервер не вернул идентификатор задачи экспорта.');
      }
      setExportJob(job);
      pollTimerRef.current = window.setTimeout(() => {
        void pollJobStatus(job.jobId, 0);
      }, 6000);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Ошибка запуска сборки видео.');
      setIsExporting(false);
    }
  };

  const persistAdLayers = (nextLayers: AdOverlayLayer[]) => {
    setAdLayers(nextLayers);
    void fetch('/api/ads/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layers: nextLayers }),
    });
  };

  const handleAdAssetUploaded = (asset: AdAssetInfo) => {
    setAdAssets((prev) => [asset, ...prev.filter((a) => a.id !== asset.id)]);
    void refreshVaultLists();
  };

  const handleAdAssetDeleted = (assetId: string) => {
    setAdAssets((prev) => prev.filter((a) => a.id !== assetId));
    const nextLayers = adLayers.filter((l) => l.adAssetId !== assetId);
    persistAdLayers(nextLayers);
    void refreshVaultLists();
  };

  const handleAdAudioUploaded = (audio: AdAudioAssetInfo) => {
    setAdAudioAssets((prev) => [audio, ...prev.filter((a) => a.id !== audio.id)]);
    void refreshVaultLists();
  };

  const handleAdAudioDeleted = (audioId: string) => {
    setAdAudioAssets((prev) => prev.filter((a) => a.id !== audioId));
    const hasAttached = adLayers.some((l) => l.audio?.audioAssetId === audioId);
    if (hasAttached) {
      const nextLayers = adLayers.map((l) =>
        l.audio?.audioAssetId === audioId
          ? {
              ...l,
              audio: {
                ...l.audio,
                enabled: false,
                audioAssetId: null,
              },
              updatedAt: new Date().toISOString(),
            }
          : l,
      );
      persistAdLayers(nextLayers);
    }
    void refreshVaultLists();
  };

  const handleSaveAdPreset = async (preset: AdPreset) => {
    try {
      const vaultRes = await saveAdPresetToVault(preset);
      if (!vaultRes.ok && vaultRes.error) {
        setVaultWarning(vaultRes.error);
      }
      const res = await fetch('/api/ads/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset }),
      });
      const data = await res.json();
      if (res.ok && Array.isArray(data.presets)) {
        setAdPresets(data.presets);
        void syncAdPresetsVault(data.presets as AdPreset[]);
      }
    } catch {
      // ignore
    }
  };

  const handleDeleteAdPreset = async (presetId: string) => {
    try {
      await deleteAdPresetFromVault(presetId);
      const res = await fetch(`/api/ads/presets/${encodeURIComponent(presetId)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (res.ok && Array.isArray(data.presets)) {
        setAdPresets(data.presets);
        void syncAdPresetsVault(data.presets as AdPreset[]);
      }
    } catch {
      // ignore
    }
  };

  const handleCleanupExecuted = (preserveAdPresets: boolean) => {
    setUploadedAssets({});
    setMissingAssets({});
    setRestoringRoles({});
    setExportHistory([]);
    setExportResult(null);
    setExportJob(null);
    setExportError(null);
    setExportBackupState(null);
    setDownloadError(null);
    setFailedDownloadKey(null);
    setAdAssets([]);
    setAdAudioAssets([]);
    setAdLayers([]);
    if (!preserveAdPresets) {
      setAdPresets([]);
    }
    setSelectedAdLayerId(null);
    setSegments(INITIAL_SEGMENTS);
    setSelectedSegmentId(INITIAL_SEGMENTS[0].id);
    setSubtitles(INITIAL_SUBTITLES);
    setEndplateAssetId('preloaded:shorts-04');
    setAudioLogoAssetId('preloaded:audio-logo');
    setUseUploadedMusic(false);
    void refreshVaultLists();
    void refreshExportHistory();
  };

  const navItems: Array<{ key: TabKey; label: string }> = [
    { key: 'timeline', label: 'Монтаж' },
    { key: 'subtitles', label: 'Субтитры' },
    { key: 'ads', label: 'Реклама' },
    { key: 'assets', label: 'Активы и звук' },
    { key: 'cover', label: 'Обложка 1K–4K' },
    { key: 'qc', label: 'Контроль качества' },
  ];

  return (
    <div className="min-h-screen bg-[#0B0F17] text-[#F1F5F9] flex flex-col">
      {/* Top Bar: 3-zone contract */}
      <header className="border-b border-[#1F2937] bg-[#0B0F17]/95 backdrop-blur sticky top-0 z-20">
        <div className="max-w-[1440px] mx-auto px-6 h-16 flex items-center justify-between gap-8">
          <a
            href="/"
            className="text-base font-bold tracking-tight text-white whitespace-nowrap shrink-0"
          >
            ДЕЛО В КАДРЕ
          </a>

          <nav className="flex items-center gap-6 overflow-x-auto">
            {navItems.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setActiveTab(item.key)}
                className={`text-sm font-medium transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 ${
                  activeTab === item.key
                    ? 'text-white border-[#DC2626]'
                    : 'text-slate-400 border-transparent hover:text-slate-200'
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="shrink-0">
            <button
              type="button"
              onClick={handleExport}
              disabled={!hasBothSources || isExporting}
              title={
                hasBothSources
                  ? 'Собрать готовые MP4 (Версия А и Версия Б)'
                  : 'Загрузите Фрагмент 8 и Фрагмент 9 во вкладке «Активы и звук»'
              }
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-[#DC2626] text-white rounded hover:bg-[#B91C1C] disabled:opacity-45 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              {isExporting
                ? `Этап ${exportJob?.stageIndex ?? 0}/${exportJob?.totalStages ?? 6}…`
                : 'Экспорт А + Б'}
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-6 py-6 space-y-6">
        {/* Missing Video Sources Banner */}
        {!hasBothSources && (
          <div className="bg-[#121826] border border-amber-800/60 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="text-xs leading-relaxed">
                <div className="font-semibold text-amber-200 text-sm">
                  Для сборки готовых MP4 не хватает исходных видеофайлов «Следствие вели…»
                </div>
                <p className="text-slate-300 mt-1">
                  К проекту приложены фирменные шаблоны, маркеры рубрик, логотипы и звуковой логотип WAV ({preloaded.length || 22} шт.), но отсутствуют видео{' '}
                  <span className="font-mono text-slate-100">Фрагмент 8</span> (00:04:10–00:04:26) и{' '}
                  <span className="font-mono text-slate-100">Фрагмент 9</span> (00:00:00–00:01:15).
                  Имитация или генерация кадров запрещена. Загрузите оригинальные видеофайлы, чтобы
                  разблокировать экспорт Версии А и Версии Б.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setActiveTab('assets')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-[#0B0F17] border border-[#242E42] text-slate-100 rounded hover:border-slate-500 transition-colors whitespace-nowrap shrink-0"
            >
              <Film className="w-3.5 h-3.5" />
              Загрузить исходники
            </button>
          </div>
        )}

        {(exportJob || exportError) && (
          <div
            className={`rounded-lg border p-4 space-y-3 ${
              exportError || exportJob?.status === 'failed'
                ? 'bg-red-950/35 border-red-900/60'
                : exportJob?.status === 'completed'
                  ? 'bg-[#121826] border-emerald-800/60'
                  : 'bg-[#121826] border-[#242E42]'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                {exportError || exportJob?.status === 'failed' ? (
                  <XCircle className="w-4 h-4 text-red-400 shrink-0" />
                ) : exportJob?.status === 'completed' ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                ) : (
                  <Loader2 className="w-4 h-4 text-red-400 animate-spin shrink-0" />
                )}

                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-100">
                    {exportError || exportJob?.status === 'failed'
                      ? 'Ошибка экспорта MP4'
                      : exportJob?.status === 'completed'
                        ? 'Экспорт завершён — готовы оба файла MP4'
                        : `Этап ${exportJob?.stageIndex ?? 0} из ${exportJob?.totalStages ?? 6}: ${exportJob?.stageLabel ?? 'Подготовка…'}`}
                  </div>
                  <p className="text-xs text-slate-300 mt-0.5 break-words">
                    {exportError || exportJob?.error || exportJob?.detail}
                  </p>
                  {pollNotice && !exportError && (
                    <p className="text-xs text-amber-300 mt-1 break-words">{pollNotice}</p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                {exportJob && (
                  <span className="font-mono text-xs tabular-nums text-slate-400">
                    {exportElapsedSec} с
                  </span>
                )}
                {!isExporting && (
                  <button
                    type="button"
                    onClick={() => {
                      setExportError(null);
                      setExportJob(null);
                    }}
                    className="text-xs text-slate-400 hover:text-white transition-colors"
                  >
                    Скрыть
                  </button>
                )}
              </div>
            </div>

            {isExporting && exportJob && (
              <div className="w-full h-1.5 bg-[#0B0F17] rounded overflow-hidden">
                <div
                  className="h-full bg-[#DC2626] transition-all duration-300"
                  style={{
                    width: `${Math.max(8, Math.round((exportJob.stageIndex / exportJob.totalStages) * 100))}%`,
                  }}
                />
              </div>
            )}

            {exportJob?.status === 'completed' && exportJob.result && (
              <div className="space-y-3 pt-1">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-xs font-semibold text-emerald-300">
                    Готовый выпуск ({exportJob.result.jobId})
                  </div>
                  {exportBackupState?.jobId === exportJob.result.jobId && (
                    <span
                      className={`inline-flex items-center gap-1.5 text-[11px] ${
                        exportBackupState.status === 'backing-up'
                          ? 'text-sky-300'
                          : exportBackupState.status === 'saved'
                            ? 'text-emerald-300'
                            : 'text-amber-300'
                      }`}
                    >
                      {exportBackupState.status === 'backing-up' ? (
                        <>
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Резервирование в IndexedDB…
                        </>
                      ) : exportBackupState.status === 'saved' ? (
                        <>
                          <HardDrive className="w-3 h-3" />
                          Обе версии зарезервированы в IndexedDB
                        </>
                      ) : (
                        <>
                          <AlertTriangle className="w-3 h-3" />
                          {exportBackupState.error || 'Ошибка резервирования в IndexedDB'}
                        </>
                      )}
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    disabled={Boolean(downloadProgress)}
                    onClick={() => void handleDownloadBoth(exportJob.result!)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium bg-[#DC2626] text-white rounded hover:bg-[#B91C1C] disabled:opacity-50 transition-colors whitespace-nowrap"
                  >
                    {downloadProgress?.jobId === exportJob.result.jobId && downloadProgress.batchStep ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Скачивание {downloadProgress.batchStep.current}/
                        {downloadProgress.batchStep.total} ({downloadProgress.percent}%)…
                      </>
                    ) : (
                      <>
                        <Download className="w-3.5 h-3.5" />
                        Скачать обе версии
                      </>
                    )}
                  </button>

                  {[
                    {
                      label: 'Скачать Версию А',
                      report: exportJob.result.versionA,
                    },
                    {
                      label: 'Скачать Версию Б',
                      report: exportJob.result.versionB,
                    },
                  ].map(({ label, report }) => {
                    const isDownloadingThis =
                      downloadProgress?.jobId === exportJob.result?.jobId &&
                      downloadProgress?.version === report.version;
                    const isFailed = failedDownloadKey === `${exportJob.result?.jobId}:${report.version}`;
                    const inVault = Boolean(vaultExports[`${exportJob.result?.jobId}:${report.version}`]);

                    return (
                      <button
                        key={report.version}
                        type="button"
                        disabled={Boolean(downloadProgress)}
                        onClick={() =>
                          void handleDownloadFile({
                            jobId: exportJob.result!.jobId,
                            version: report.version,
                            url: report.url,
                            fileName: report.fileName,
                            expectedSizeBytes: report.probe.sizeBytes,
                          })
                        }
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0B0F17] border border-[#242E42] text-slate-100 rounded hover:border-slate-500 disabled:opacity-50 transition-colors whitespace-nowrap"
                      >
                        {isDownloadingThis ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            Загрузка {downloadProgress.percent}%…
                          </>
                        ) : isFailed ? (
                          <>
                            <RefreshCw className="w-3.5 h-3.5 text-amber-300" />
                            Повторить ({report.version === 'A' ? 'А' : 'Б'})
                          </>
                        ) : (
                          <>
                            <Download className="w-3.5 h-3.5" />
                            {label} ({(report.probe.sizeBytes / (1024 * 1024)).toFixed(1)} МБ
                            {inVault ? ' · IndexedDB' : ''})
                          </>
                        )}
                      </button>
                    );
                  })}
                </div>
                {downloadError && (
                  <p className="text-xs text-red-300 break-words">{downloadError}</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Main Studio Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-8 space-y-6">
            {activeTab === 'timeline' && (
              <TimelineEditor
                segments={segments}
                selectedSegmentId={selectedSegmentId}
                onSelectSegment={setSelectedSegmentId}
                onUpdateSegment={handleUpdateSegment}
                onMoveSegment={handleMoveSegment}
                onDeleteSegment={handleDeleteSegment}
                onAddSegment={handleAddSegment}
                adLayers={adLayers}
                adAssets={adAssets}
                onUpdateAdLayer={(id, patch) =>
                  persistAdLayers(
                    adLayers.map((l) =>
                      l.id === id ? { ...l, ...patch, updatedAt: new Date().toISOString() } : l,
                    ),
                  )
                }
                onDeleteAdLayer={(id) => persistAdLayers(adLayers.filter((l) => l.id !== id))}
                onOpenAdsTab={(layerId) => {
                  if (layerId) setSelectedAdLayerId(layerId);
                  setActiveTab('ads');
                }}
                uploadedAssets={uploadedAssets}
                preloaded={preloaded}
                endplateAssetId={endplateAssetId}
                onChangeEndplateAssetId={setEndplateAssetId}
                endplateDurationSec={endplateDurationSec}
                onChangeEndplateDurationSec={setEndplateDurationSec}
                audioLogoAssetId={audioLogoAssetId}
                onChangeAudioLogoAssetId={setAudioLogoAssetId}
                useUploadedMusic={useUploadedMusic}
                onChangeUseUploadedMusic={setUseUploadedMusic}
                musicGainDb={musicGainDb}
                onChangeMusicGainDb={setMusicGainDb}
              />
            )}

            {activeTab === 'subtitles' && (
              <SubtitleEditor
                subtitles={subtitles}
                onChangeSubtitles={setSubtitles}
                segments={segments}
                uploadedAssets={uploadedAssets}
              />
            )}

            {activeTab === 'ads' && (
              <AdsPanel
                adAssets={adAssets}
                adAudioAssets={adAudioAssets}
                adLayers={adLayers}
                adPresets={adPresets}
                selectedLayerId={selectedAdLayerId}
                mainDurationSec={mainDurationSec}
                endplateDurationSec={endplateDurationSec}
                subtitles={subtitles}
                onSelectLayer={setSelectedAdLayerId}
                onAdAssetUploaded={handleAdAssetUploaded}
                onAdAssetDeleted={handleAdAssetDeleted}
                onAdAudioUploaded={handleAdAudioUploaded}
                onAdAudioDeleted={handleAdAudioDeleted}
                onUpdateLayers={persistAdLayers}
                onSavePreset={(preset) => void handleSaveAdPreset(preset)}
                onDeletePreset={(presetId) => void handleDeleteAdPreset(presetId)}
                onVaultWarning={setVaultWarning}
              />
            )}

            {activeTab === 'assets' && (
              <AssetsPanel
                uploadedAssets={uploadedAssets}
                missingAssets={missingAssets}
                restoringRoles={restoringRoles}
                vaultSources={vaultSources}
                diagnostics={vaultDiagnostics}
                storageInfo={storageInfo}
                vaultWarning={vaultWarning}
                preloaded={preloaded}
                selectedSegmentId={activeSegment?.id ?? null}
                selectedSegmentTitle={activeSegment?.beatTitle ?? null}
                onAssetUploaded={handleAssetUploaded}
                onAssetsSynced={handleAssetsSynced}
                onAssetRemoved={handleAssetRemoved}
                onRestoreFromVault={(role) => {
                  void restoreSourceRoleFromVault(role).then(() => refreshVaultLists());
                }}
                onVaultWarning={setVaultWarning}
                onVaultRefresh={() => void refreshVaultLists()}
                onOpenCleanupModal={() => setIsCleanupModalOpen(true)}
                onApplyOverlayToSelectedSegment={(overlayId) => {
                  if (activeSegment) {
                    handleUpdateSegment(activeSegment.id, { overlayId });
                    setActiveTab('timeline');
                  }
                }}
                onUseAsEndplate={(assetId) => {
                  setEndplateAssetId(assetId);
                  setActiveTab('timeline');
                }}
              />
            )}

            {activeTab === 'cover' && <CoverStudio />}

            {activeTab === 'qc' && (
              <QualityChecklist
                segments={segments}
                subtitles={subtitles}
                adLayers={adLayers}
                uploadedAssets={uploadedAssets}
                preloaded={preloaded}
                endplateAssetId={endplateAssetId}
                endplateDurationSec={endplateDurationSec}
                audioLogoAssetId={audioLogoAssetId}
                mainDurationSec={mainDurationSec}
                totalDurationSec={totalDurationSec}
                exportResult={exportResult}
                exportHistory={exportHistory}
                vaultExports={vaultExports}
                diagnostics={vaultDiagnostics}
                storageInfo={storageInfo}
                vaultWarning={vaultWarning}
                exportBackupState={exportBackupState}
                downloadProgress={downloadProgress}
                downloadError={downloadError}
                failedDownloadKey={failedDownloadKey}
                onDownloadFile={(p) => void handleDownloadFile(p)}
                onDownloadBoth={(r) => void handleDownloadBoth(r)}
                onOpenCleanupModal={() => setIsCleanupModalOpen(true)}
              />
            )}
          </div>

          <div className="lg:col-span-4 lg:sticky lg:top-22">
            <MonitorPreview
              segments={segments}
              activeSegment={activeSegment}
              uploadedAssets={uploadedAssets}
              preloaded={preloaded}
              subtitles={subtitles}
              adLayers={adLayers}
              adAssets={adAssets}
              endplateAssetId={endplateAssetId}
              endplateDurationSec={endplateDurationSec}
              audioLogoAssetId={audioLogoAssetId}
              totalDurationSec={totalDurationSec}
              mainDurationSec={mainDurationSec}
            />
          </div>
        </div>
      </main>

      <WorkspaceCleanupModal
        isOpen={isCleanupModalOpen}
        isExporting={isExporting}
        onClose={() => setIsCleanupModalOpen(false)}
        onCleanupExecuted={handleCleanupExecuted}
      />
    </div>
  );
}
