import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookmarkPlus,
  CheckCircle2,
  Eye,
  Film,
  Layers,
  Music,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type {
  AdAnchor,
  AdAssetInfo,
  AdAudioAssetInfo,
  AdAudioLayerConfig,
  AdGifBehavior,
  AdOverlayLayer,
  AdPreset,
  AdPromptParseResult,
  SubtitleCue,
} from '../types.ts';
import { computeAdOverlayBox, evaluateAdCollisions } from '../utils/adGeometry.ts';
import { parseAdvertiserPrompt } from '../utils/adPromptParser.ts';
import {
  deleteAdAssetFromVault,
  saveAdAssetToVault,
  saveAdAudioToVault,
} from '../utils/browserMediaVault.ts';

interface AdsPanelProps {
  adAssets: AdAssetInfo[];
  adAudioAssets: AdAudioAssetInfo[];
  adLayers: AdOverlayLayer[];
  adPresets: AdPreset[];
  selectedLayerId: string | null;
  mainDurationSec: number;
  endplateDurationSec: number;
  subtitles: SubtitleCue[];
  onSelectLayer: (id: string | null) => void;
  onAdAssetUploaded: (asset: AdAssetInfo) => void;
  onAdAssetDeleted: (assetId: string) => void;
  onAdAudioUploaded: (audio: AdAudioAssetInfo) => void;
  onAdAudioDeleted: (audioId: string) => void;
  onUpdateLayers: (layers: AdOverlayLayer[]) => void;
  onSavePreset: (preset: AdPreset) => void;
  onDeletePreset: (presetId: string) => void;
  onVaultWarning: (msg: string | null) => void;
}

const ANCHOR_GRID: Array<{ value: AdAnchor; label: string }> = [
  { value: 'top-left', label: 'Верх-Л' },
  { value: 'top-center', label: 'Верх-Ц' },
  { value: 'top-right', label: 'Верх-П' },
  { value: 'center-left', label: 'Центр-Л' },
  { value: 'center', label: 'Центр' },
  { value: 'center-right', label: 'Центр-П' },
  { value: 'bottom-left', label: 'Низ-Л' },
  { value: 'bottom-center', label: 'Низ-Ц' },
  { value: 'bottom-right', label: 'Низ-П' },
];

const EXAMPLE_PROMPT =
  'Показывай плашку с 00:04 до 00:14 сверху по центру, ширина 42%, отступ от края 60 px, плавное появление 0.4 с и исчезновение 0.4 с, не перекрывать субтитры и лица, GIF зациклить.';

export const AdsPanel: React.FC<AdsPanelProps> = ({
  adAssets,
  adAudioAssets,
  adLayers,
  adPresets,
  selectedLayerId,
  mainDurationSec,
  endplateDurationSec,
  subtitles,
  onSelectLayer,
  onAdAssetUploaded,
  onAdAssetDeleted,
  onAdAudioUploaded,
  onAdAudioDeleted,
  onUpdateLayers,
  onSavePreset,
  onDeletePreset,
  onVaultWarning,
}) => {
  const [isUploading, setIsUploading] = useState(false);
  const [isUploadingAudio, setIsUploadingAudio] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [parseResult, setParseResult] = useState<AdPromptParseResult | null>(null);
  const [presetName, setPresetName] = useState('');
  const [advertiserName, setAdvertiserName] = useState('');
  const [isPreviewPlayingAudio, setIsPreviewPlayingAudio] = useState(false);
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);
  const audioGainNodeRef = useRef<{ ctx: AudioContext; gain: GainNode } | null>(null);

  const activeLayer =
    adLayers.find((l) => l.id === selectedLayerId) ?? adLayers[0] ?? null;
  const activeAsset = activeLayer
    ? adAssets.find((a) => a.id === activeLayer.adAssetId) ?? null
    : adAssets[0] ?? null;
  const activeLayerAudioAsset = activeLayer?.audio?.audioAssetId
    ? adAudioAssets.find((a) => a.id === activeLayer.audio?.audioAssetId) ?? null
    : null;

  useEffect(() => {
    const el = audioPreviewRef.current;
    if (el) {
      el.pause();
    }
    setIsPreviewPlayingAudio(false);
  }, [activeLayer?.id, activeLayer?.audio?.audioAssetId]);

  const computedBox = useMemo(() => {
    if (!activeLayer || !activeAsset) return null;
    return computeAdOverlayBox(activeLayer, activeAsset);
  }, [activeLayer, activeAsset]);

  const collisionWarnings = useMemo(() => {
    if (!activeLayer || !computedBox) return null;
    return evaluateAdCollisions(activeLayer, computedBox, subtitles);
  }, [activeLayer, computedBox, subtitles]);

  const defaultAudioConfig = (startSec = 3): AdAudioLayerConfig => ({
    enabled: false,
    audioAssetId: null,
    startSec,
    durationSec: null,
    trimStartSec: 0,
    trimEndSec: null,
    volumeDb: -8,
    fadeInSec: 0.25,
    fadeOutSec: 0.3,
  });

  const createDefaultLayer = (asset: AdAssetInfo): AdOverlayLayer => {
    const startSec = 3;
    const endSec = Math.min(
      Math.max(8, mainDurationSec > 10 ? 12 : mainDurationSec || 10),
      Math.max(8, mainDurationSec || 15),
    );
    return {
      id: `adlayer_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: `Реклама: ${asset.originalName}`,
      enabled: true,
      confirmed: false,
      adAssetId: asset.id,
      promptText: '',
      startSec,
      endSec,
      anchor: 'top-center',
      customXPercent: 50,
      customYPercent: 20,
      sizeMode: 'percent',
      widthValue: 40,
      heightValue: null,
      preserveAspectRatio: true,
      marginXPx: 48,
      marginYPx: 240,
      scale: 1,
      opacity: 1,
      fadeInSec: 0.35,
      fadeOutSec: 0.35,
      gifBehavior: 'loop',
      avoidSubtitles: true,
      avoidFaces: true,
      allowOnEndplate: false,
      audio: defaultAudioConfig(startSec),
      updatedAt: new Date().toISOString(),
    };
  };

  const handleUploadAdFile = async (file: File | null, replaceAssetId?: string) => {
    if (!file) return;
    setUploadError(null);
    onVaultWarning(null);
    setIsUploading(true);
    try {
      const formData = new FormData();
      if (replaceAssetId) {
        formData.append('assetId', replaceAssetId);
      }
      formData.append('file', file);
      const res = await fetch('/api/upload-ad', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok || !data.asset) {
        throw new Error(data.error || 'Не удалось загрузить рекламный материал.');
      }
      const asset = data.asset as AdAssetInfo;
      const vaultRes = await saveAdAssetToVault(asset, file);
      if (!vaultRes.ok && vaultRes.error) {
        onVaultWarning(vaultRes.error);
      }
      onAdAssetUploaded(asset);

      if (replaceAssetId && activeLayer && activeLayer.adAssetId === replaceAssetId) {
        updateActiveLayer({ adAssetId: asset.id, confirmed: false });
      } else if (adLayers.length === 0) {
        const newLayer = createDefaultLayer(asset);
        onUpdateLayers([newLayer]);
        onSelectLayer(newLayer.id);
      } else if (!activeLayer) {
        const newLayer = createDefaultLayer(asset);
        onUpdateLayers([...adLayers, newLayer]);
        onSelectLayer(newLayer.id);
      }
    } catch (err) {
      setUploadError(
        err instanceof Error ? err.message : 'Ошибка загрузки рекламного файла.',
      );
    } finally {
      setIsUploading(false);
    }
  };

  const handleUploadAdAudio = async (file: File | null, replaceAudioId?: string) => {
    if (!file) return;
    setUploadError(null);
    onVaultWarning(null);
    setIsUploadingAudio(true);
    try {
      const formData = new FormData();
      if (replaceAudioId) {
        formData.append('audioId', replaceAudioId);
      }
      formData.append('file', file);
      const res = await fetch('/api/upload-ad-audio', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok || !data.audioAsset) {
        throw new Error(data.error || 'Не удалось загрузить рекламное аудио.');
      }
      const audioAsset = data.audioAsset as AdAudioAssetInfo;
      const vaultRes = await saveAdAudioToVault(audioAsset, file);
      if (!vaultRes.ok && vaultRes.error) {
        onVaultWarning(vaultRes.error);
      }
      onAdAudioUploaded(audioAsset);

      if (activeLayer) {
        const curAudio = activeLayer.audio ?? defaultAudioConfig(activeLayer.startSec);
        updateActiveLayer({
          audio: {
            ...curAudio,
            enabled: true,
            audioAssetId: audioAsset.id,
            startSec: curAudio.startSec ?? activeLayer.startSec,
            trimStartSec: 0,
            trimEndSec: Number(audioAsset.durationSec.toFixed(2)),
          },
        });
      }
    } catch (err) {
      setUploadError(
        err instanceof Error ? err.message : 'Ошибка загрузки рекламного аудиофайла.',
      );
    } finally {
      setIsUploadingAudio(false);
    }
  };

  const handleDeleteAsset = async (assetId: string) => {
    await fetch(`/api/ads/asset/${encodeURIComponent(assetId)}`, { method: 'DELETE' });
    await deleteAdAssetFromVault(assetId);
    onAdAssetDeleted(assetId);
  };

  const handleDeleteAudioAsset = async (audioId: string) => {
    await fetch(`/api/ads/audio/${encodeURIComponent(audioId)}`, { method: 'DELETE' });
    await deleteAdAssetFromVault(audioId);
    onAdAudioDeleted(audioId);
  };

  const updateActiveLayer = (patch: Partial<AdOverlayLayer>) => {
    if (!activeLayer) return;
    const next = adLayers.map((l) =>
      l.id === activeLayer.id
        ? { ...l, ...patch, updatedAt: new Date().toISOString() }
        : l,
    );
    onUpdateLayers(next);
  };

  const updateActiveLayerAudio = (patch: Partial<AdAudioLayerConfig>) => {
    if (!activeLayer) return;
    const base = activeLayer.audio ?? defaultAudioConfig(activeLayer.startSec);
    updateActiveLayer({
      audio: {
        ...base,
        ...patch,
      },
    });
  };

  const handleDetachAudioFromLayer = () => {
    if (!activeLayer) return;
    if (audioPreviewRef.current) {
      audioPreviewRef.current.pause();
    }
    setIsPreviewPlayingAudio(false);
    updateActiveLayer({
      audio: {
        ...(activeLayer.audio ?? defaultAudioConfig(activeLayer.startSec)),
        enabled: false,
        audioAssetId: null,
      },
    });
  };

  const handleToggleAudioPreview = () => {
    const el = audioPreviewRef.current;
    if (!el || !activeLayerAudioAsset) return;
    const audioCfg = activeLayer?.audio ?? defaultAudioConfig(activeLayer?.startSec ?? 0);

    if (isPreviewPlayingAudio) {
      el.pause();
      setIsPreviewPlayingAudio(false);
      return;
    }

    try {
      if (!audioGainNodeRef.current) {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (Ctx) {
          const ctx = new Ctx();
          const src = ctx.createMediaElementSource(el);
          const gain = ctx.createGain();
          src.connect(gain);
          gain.connect(ctx.destination);
          audioGainNodeRef.current = { ctx, gain };
        }
      }
      if (audioGainNodeRef.current) {
        if (audioGainNodeRef.current.ctx.state === 'suspended') {
          void audioGainNodeRef.current.ctx.resume();
        }
        const linearGain = Math.pow(10, (audioCfg.volumeDb ?? -8) / 20);
        audioGainNodeRef.current.gain.gain.value = Math.min(2.0, Math.max(0.01, linearGain));
      } else {
        const linear = Math.pow(10, (audioCfg.volumeDb ?? -8) / 20);
        el.volume = Math.min(1, Math.max(0.05, linear));
      }
    } catch {
      const linear = Math.pow(10, (audioCfg.volumeDb ?? -8) / 20);
      el.volume = Math.min(1, Math.max(0.05, linear));
    }

    const trimStart = Math.max(0, audioCfg.trimStartSec || 0);
    el.currentTime = trimStart;
    void el.play().then(() => setIsPreviewPlayingAudio(true)).catch(() => setIsPreviewPlayingAudio(false));
  };

  const handlePreviewTimeUpdate = () => {
    const el = audioPreviewRef.current;
    if (!el || !activeLayerAudioAsset || !isPreviewPlayingAudio) return;
    const audioCfg = activeLayer?.audio;
    if (!audioCfg) return;
    const trimStart = Math.max(0, audioCfg.trimStartSec || 0);
    const trimEnd =
      audioCfg.trimEndSec !== null && audioCfg.trimEndSec !== undefined
        ? Math.min(activeLayerAudioAsset.durationSec, audioCfg.trimEndSec)
        : activeLayerAudioAsset.durationSec;
    const stopAt =
      audioCfg.durationSec && audioCfg.durationSec > 0
        ? Math.min(trimEnd, trimStart + audioCfg.durationSec)
        : trimEnd;
    if (el.currentTime >= stopAt) {
      el.pause();
      el.currentTime = trimStart;
      setIsPreviewPlayingAudio(false);
    }
  };

  const handleAddLayer = () => {
    const targetAsset = activeAsset ?? adAssets[0];
    if (!targetAsset) return;
    const created = createDefaultLayer(targetAsset);
    onUpdateLayers([...adLayers, created]);
    onSelectLayer(created.id);
    setParseResult(null);
  };

  const handleDeleteLayer = (layerId: string) => {
    const next = adLayers.filter((l) => l.id !== layerId);
    onUpdateLayers(next);
    if (selectedLayerId === layerId) {
      onSelectLayer(next[0]?.id ?? null);
    }
    setParseResult(null);
  };

  const handleParsePrompt = () => {
    if (!activeLayer) return;
    const parsed = parseAdvertiserPrompt(activeLayer.promptText, {
      mainDurationSec,
      endplateDurationSec,
      currentLayer: activeLayer,
    });
    setParseResult(parsed);
  };

  const handleApplyAndConfirmParsed = () => {
    if (!activeLayer) return;
    const patch: Partial<AdOverlayLayer> = parseResult?.extractedParams
      ? { ...parseResult.extractedParams }
      : {};
    patch.confirmed = true;
    patch.enabled = true;
    updateActiveLayer(patch);
  };

  const handleSaveCurrentAsPreset = () => {
    if (!activeLayer) return;
    const trimmed = presetName.trim() || activeLayer.name || 'Пресет рекламодателя';
    const trimmedAdv = advertiserName.trim() || undefined;
    const {
      id: _id,
      adAssetId: _aid,
      updatedAt: _u,
      audio,
      ...restLayerConfig
    } = activeLayer;
    const audioConfig = audio
      ? {
          enabled: audio.enabled,
          startSec: audio.startSec,
          durationSec: audio.durationSec,
          trimStartSec: audio.trimStartSec,
          trimEndSec: audio.trimEndSec,
          volumeDb: audio.volumeDb,
          fadeInSec: audio.fadeInSec,
          fadeOutSec: audio.fadeOutSec,
        }
      : null;

    // Persistent preset stores reusable settings only (temporary binary media is NOT tied to cleanup)
    const preset: AdPreset = {
      id: `preset_${Date.now()}`,
      name: trimmed,
      advertiserName: trimmedAdv,
      requirementsTemplate: activeLayer.promptText.trim() || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      adAssetId: null,
      assetSnapshot: null,
      layerConfig: {
        ...restLayerConfig,
        audioConfig,
      },
    };
    onSavePreset(preset);
    setPresetName('');
    setAdvertiserName('');
  };

  const handleApplyPreset = (preset: AdPreset) => {
    const linkedAsset =
      (preset.adAssetId && adAssets.find((a) => a.id === preset.adAssetId)) ||
      adAssets[0] ||
      null;
    if (!linkedAsset) {
      setUploadError(
        'Загрузите рекламный баннер/GIF для текущего выпуска — затем примените сохранённый пресет рекламодателя.',
      );
      return;
    }
    const { audioConfig, ...visualConfig } = preset.layerConfig;
    const restoredAudio: AdAudioLayerConfig = audioConfig
      ? {
          ...audioConfig,
          audioAssetId: adAudioAssets[0]?.id ?? null,
          enabled: Boolean(audioConfig.enabled && adAudioAssets[0]),
        }
      : defaultAudioConfig(visualConfig.startSec);

    const newLayer: AdOverlayLayer = {
      ...visualConfig,
      id: `adlayer_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      adAssetId: linkedAsset.id,
      audio: restoredAudio,
      confirmed: true,
      updatedAt: new Date().toISOString(),
    };
    onUpdateLayers([...adLayers, newLayer]);
    onSelectLayer(newLayer.id);
    setParseResult(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            Рекламные плашки (PNG, JPG, WEBP, GIF)
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Независимый слой поверх видео в 1080×1920 · Одинаково вшивается в Версию А и Версию Б без искажения пропорций
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <label className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#DC2626] text-white rounded hover:bg-[#B91C1C] cursor-pointer transition-colors whitespace-nowrap">
            <Upload className="w-3.5 h-3.5" />
            {isUploading ? 'Анализ файла…' : 'Загрузить баннер / GIF'}
            <input
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif"
              disabled={isUploading}
              onChange={(e) => {
                void handleUploadAdFile(e.target.files?.[0] ?? null);
                e.target.value = '';
              }}
              className="hidden"
            />
          </label>

          <label className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#121826] border border-[#242E42] text-slate-200 rounded hover:border-slate-500 cursor-pointer transition-colors whitespace-nowrap">
            <Music className="w-3.5 h-3.5" />
            {isUploadingAudio ? 'Анализ аудио…' : 'Загрузить аудио (MP3/WAV/AAC/M4A/OGG)'}
            <input
              type="file"
              accept=".mp3,.wav,.aac,.m4a,.ogg,audio/mpeg,audio/wav,audio/aac,audio/mp4,audio/ogg"
              disabled={isUploadingAudio}
              onChange={(e) => {
                void handleUploadAdAudio(e.target.files?.[0] ?? null);
                e.target.value = '';
              }}
              className="hidden"
            />
          </label>

          {adAssets.length > 0 && (
            <button
              type="button"
              onClick={handleAddLayer}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#121826] border border-[#242E42] text-slate-200 rounded hover:border-slate-500 transition-colors whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              Новый слой рекламы
            </button>
          )}
        </div>
      </div>

      {uploadError && (
        <div className="p-3 bg-red-950/40 border border-red-900/60 rounded text-xs text-red-300">
          {uploadError}
        </div>
      )}

      {/* Uploaded Ad Assets Strip */}
      <div className="bg-[#121826] border border-[#1F2937] rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-100">
            Загруженные рекламные материалы ({adAssets.length})
          </h3>
          <span className="text-xs text-slate-400">
            Поддержка прозрачности альфа-канала и анимированного GIF
          </span>
        </div>

        {adAssets.length === 0 ? (
          <div className="p-6 text-center border border-dashed border-[#242E42] rounded-md text-xs text-slate-400">
            Загрузите рекламную плашку (PNG с прозрачностью, JPG, WEBP или анимированный GIF),
            чтобы настроить позицию, время показа и промпт рекламодателя.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {adAssets.map((asset) => (
              <div
                key={asset.id}
                className="bg-[#0B0F17] border border-[#1F2937] rounded-md p-3 flex flex-col gap-2.5"
              >
                <div className="h-24 bg-[#111827] border border-[#1F2937] rounded flex items-center justify-center overflow-hidden p-1">
                  <img
                    src={asset.url}
                    alt={asset.originalName}
                    referrerPolicy="no-referrer"
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
                <div className="min-w-0 text-xs space-y-0.5">
                  <div className="font-medium text-slate-100 truncate" title={asset.originalName}>
                    {asset.originalName}
                  </div>
                  <div className="text-[11px] font-mono tabular-nums text-slate-400">
                    {asset.format.toUpperCase()} · {asset.width}×{asset.height}
                    {asset.isAnimatedGif ? ` · ${asset.frameCount} кд.` : ''}
                    {asset.hasAlpha ? ' · Альфа' : ''}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 pt-1 border-t border-[#1F2937]">
                  <label className="inline-flex items-center gap-1 text-[11px] text-slate-300 hover:text-white cursor-pointer">
                    <RefreshCw className="w-3 h-3" />
                    Заменить
                    <input
                      type="file"
                      accept=".png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif"
                      disabled={isUploading}
                      onChange={(e) => {
                        void handleUploadAdFile(e.target.files?.[0] ?? null, asset.id);
                        e.target.value = '';
                      }}
                      className="hidden"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void handleDeleteAsset(asset.id)}
                    className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-red-400"
                  >
                    <Trash2 className="w-3 h-3" />
                    Удалить
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {adAudioAssets.length > 0 && (
          <div className="pt-3 border-t border-[#1F2937] space-y-2">
            <div className="text-xs font-semibold text-slate-200">
              Загруженные рекламные аудиофайлы ({adAudioAssets.length})
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {adAudioAssets.map((audioItem) => (
                <div
                  key={audioItem.id}
                  className="bg-[#0B0F17] border border-[#1F2937] rounded px-3 py-2 flex items-center justify-between gap-2 text-xs"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-slate-100 truncate" title={audioItem.originalName}>
                      {audioItem.originalName}
                    </div>
                    <div className="text-[11px] font-mono tabular-nums text-slate-400">
                      {audioItem.format.toUpperCase()} · {audioItem.durationSec.toFixed(2)} с ·{' '}
                      {Math.round(audioItem.sampleRate / 1000)} кГц
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleDeleteAudioAsset(audioItem.id)}
                    className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-red-400 shrink-0"
                    title="Удалить рекламный аудиофайл"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Удалить
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Active Layer Tabs + Editor */}
      {adLayers.length > 0 && activeLayer && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {adLayers.map((layer, idx) => (
              <button
                key={layer.id}
                type="button"
                onClick={() => {
                  onSelectLayer(layer.id);
                  setParseResult(null);
                }}
                className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap ${
                  layer.id === activeLayer.id
                    ? 'bg-[#161E2E] border-slate-500 text-white'
                    : 'bg-[#121826] border-[#1F2937] text-slate-400 hover:text-slate-200'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                <span>
                  {idx + 1}. {layer.name}
                </span>
                <span className="text-[11px] text-slate-400 tabular-nums">
                  ({layer.startSec.toFixed(1)}–{layer.endSec.toFixed(1)} с)
                </span>
              </button>
            ))}
          </div>

          {/* Prompt Parser Card */}
          <div className="bg-[#121826] border border-[#1F2937] rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  Промпт рекламодателя (безопасный разбор параметров)
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Опишите требования в свободной форме — система разберёт их локально, покажет конфликты и запросит подтверждение.
                </p>
              </div>
              <button
                type="button"
                onClick={() => updateActiveLayer({ promptText: EXAMPLE_PROMPT })}
                className="text-xs text-slate-300 hover:text-white underline"
              >
                Подставить пример
              </button>
            </div>

            <textarea
              rows={3}
              value={activeLayer.promptText}
              onChange={(e) =>
                updateActiveLayer({ promptText: e.target.value, confirmed: false })
              }
              placeholder="Например: Показывать плашку с 00:05 до 00:15 сверху по центру, ширина 40%, отступ 50 px, плавное появление 0.4 с, не перекрывать субтитры и лица, GIF зациклить"
              className="w-full px-3 py-2 text-xs bg-[#0B0F17] border border-[#1F2937] rounded text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-slate-500 leading-relaxed"
            />

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleParsePrompt}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-[#1F2937] text-white rounded hover:bg-[#374151] transition-colors whitespace-nowrap"
              >
                <Sparkles className="w-3.5 h-3.5" />
                Разобрать требования
              </button>

              <button
                type="button"
                disabled={Boolean(parseResult && parseResult.conflicts.length > 0)}
                onClick={handleApplyAndConfirmParsed}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-[#DC2626] text-white rounded hover:bg-[#B91C1C] disabled:opacity-45 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                {activeLayer.confirmed
                  ? 'Параметры подтверждены'
                  : 'Подтвердить и применить к ролику'}
              </button>

              {!activeLayer.confirmed && (
                <span className="text-xs text-amber-300">
                  Требуется подтверждение параметров перед вшиванием в MP4
                </span>
              )}
            </div>

            {parseResult && (
              <div className="space-y-2.5 pt-2 border-t border-[#1F2937] text-xs">
                {parseResult.extractedSummary.length > 0 && (
                  <div className="p-3 bg-[#0B0F17] border border-[#1F2937] rounded space-y-1">
                    <div className="font-medium text-emerald-300">
                      Распознанные параметры:
                    </div>
                    <ul className="list-disc list-inside text-slate-300 space-y-0.5">
                      {parseResult.extractedSummary.map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {parseResult.conflicts.length > 0 && (
                  <div className="p-3 bg-red-950/35 border border-red-900/60 rounded space-y-1 text-red-200">
                    <div className="font-semibold">Обнаружены конфликты в инструкции:</div>
                    <ul className="list-disc list-inside space-y-0.5">
                      {parseResult.conflicts.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {parseResult.missingParams.length > 0 && (
                  <div className="p-3 bg-amber-950/30 border border-amber-800/50 rounded space-y-1 text-amber-200">
                    <div className="font-medium">Недостающие параметры (задайте вручную):</div>
                    <ul className="list-disc list-inside space-y-0.5">
                      {parseResult.missingParams.map((m, i) => (
                        <li key={i}>{m}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {parseResult.warnings.length > 0 && (
                  <div className="p-3 bg-amber-950/25 border border-amber-800/40 rounded space-y-1 text-amber-200">
                    {parseResult.warnings.map((w, i) => (
                      <div key={i}>{w}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Manual Placement & Timing Controls */}
          <div className="bg-[#121826] border border-[#1F2937] rounded-lg p-5 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <input
                  type="checkbox"
                  checked={activeLayer.enabled}
                  onChange={(e) => updateActiveLayer({ enabled: e.target.checked })}
                  className="w-4 h-4 accent-[#DC2626]"
                />
                <input
                  type="text"
                  value={activeLayer.name}
                  onChange={(e) => updateActiveLayer({ name: e.target.value })}
                  className="bg-[#0B0F17] border border-[#1F2937] rounded px-2.5 py-1 text-sm font-medium text-slate-100 focus:outline-none focus:border-slate-500 min-w-[220px]"
                />
              </div>

              <button
                type="button"
                onClick={() => handleDeleteLayer(activeLayer.id)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-400 hover:text-red-400"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Удалить слой
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
              <label className="block">
                <span className="block text-slate-400 mb-1">Рекламный файл</span>
                <select
                  value={activeLayer.adAssetId}
                  onChange={(e) => updateActiveLayer({ adAssetId: e.target.value })}
                  className="w-full px-2.5 py-1.5 bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200 focus:outline-none focus:border-slate-500"
                >
                  {adAssets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.originalName} ({a.format.toUpperCase()}, {a.width}×{a.height})
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="block text-slate-400 mb-1">Начало показа (сек)</span>
                <input
                  type="number"
                  step="0.1"
                  min={0}
                  value={activeLayer.startSec}
                  onChange={(e) =>
                    updateActiveLayer({
                      startSec: Math.max(0, Number(e.target.value) || 0),
                    })
                  }
                  className="w-full px-2.5 py-1.5 font-mono tabular-nums bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200 focus:outline-none focus:border-slate-500"
                />
              </label>

              <label className="block">
                <span className="block text-slate-400 mb-1">Конец показа (сек)</span>
                <input
                  type="number"
                  step="0.1"
                  min={0.1}
                  value={activeLayer.endSec}
                  onChange={(e) =>
                    updateActiveLayer({
                      endSec: Math.max(0.1, Number(e.target.value) || 0.1),
                    })
                  }
                  className="w-full px-2.5 py-1.5 font-mono tabular-nums bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200 focus:outline-none focus:border-slate-500"
                />
              </label>

              <label className="block">
                <span className="block text-slate-400 mb-1">
                  Непрозрачность ({Math.round(activeLayer.opacity * 100)}%)
                </span>
                <input
                  type="range"
                  min={0.15}
                  max={1}
                  step={0.05}
                  value={activeLayer.opacity}
                  onChange={(e) =>
                    updateActiveLayer({ opacity: Number(e.target.value) })
                  }
                  className="w-full accent-[#DC2626] mt-2"
                />
              </label>
            </div>

            {/* Position Grid + Custom X/Y + Sizing */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 pt-2 border-t border-[#1F2937] text-xs">
              <div>
                <div className="text-slate-400 mb-2">Зона привязки на экране 9:16</div>
                <div className="grid grid-cols-3 gap-1.5">
                  {ANCHOR_GRID.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => updateActiveLayer({ anchor: item.value })}
                      className={`px-2 py-1.5 rounded border text-[11px] font-medium transition-colors ${
                        activeLayer.anchor === item.value
                          ? 'bg-[#DC2626] border-[#DC2626] text-white'
                          : 'bg-[#0B0F17] border-[#1F2937] text-slate-300 hover:border-slate-500'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => updateActiveLayer({ anchor: 'custom' })}
                  className={`mt-1.5 w-full px-2 py-1.5 rounded border text-[11px] font-medium transition-colors ${
                    activeLayer.anchor === 'custom'
                      ? 'bg-[#DC2626] border-[#DC2626] text-white'
                      : 'bg-[#0B0F17] border-[#1F2937] text-slate-300 hover:border-slate-500'
                  }`}
                >
                  Произвольные координаты (X% / Y%)
                </button>
                {activeLayer.anchor === 'custom' && (
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <label className="block">
                      <span className="text-[11px] text-slate-400">X центр (%)</span>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={activeLayer.customXPercent}
                        onChange={(e) =>
                          updateActiveLayer({
                            customXPercent: Math.min(100, Math.max(0, Number(e.target.value) || 0)),
                          })
                        }
                        className="w-full px-2 py-1 font-mono bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200 mt-0.5"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[11px] text-slate-400">Y центр (%)</span>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={activeLayer.customYPercent}
                        onChange={(e) =>
                          updateActiveLayer({
                            customYPercent: Math.min(100, Math.max(0, Number(e.target.value) || 0)),
                          })
                        }
                        className="w-full px-2 py-1 font-mono bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200 mt-0.5"
                      />
                    </label>
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="block text-slate-400 mb-1">Единицы ширины</span>
                    <select
                      value={activeLayer.sizeMode}
                      onChange={(e) =>
                        updateActiveLayer({
                          sizeMode: e.target.value as 'percent' | 'px',
                          widthValue: e.target.value === 'percent' ? 40 : 420,
                        })
                      }
                      className="w-full px-2 py-1.5 bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200"
                    >
                      <option value="percent">% ширины кадра</option>
                      <option value="px">Пиксели (1080p)</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="block text-slate-400 mb-1">
                      Ширина ({activeLayer.sizeMode === 'percent' ? '%' : 'px'})
                    </span>
                    <input
                      type="number"
                      min={activeLayer.sizeMode === 'percent' ? 5 : 24}
                      max={activeLayer.sizeMode === 'percent' ? 100 : 1080}
                      value={activeLayer.widthValue}
                      onChange={(e) =>
                        updateActiveLayer({
                          widthValue: Math.max(5, Number(e.target.value) || 5),
                        })
                      }
                      className="w-full px-2 py-1.5 font-mono tabular-nums bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200"
                    />
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="block text-slate-400 mb-1">Отступ X (px)</span>
                    <input
                      type="number"
                      min={0}
                      max={400}
                      value={activeLayer.marginXPx}
                      onChange={(e) =>
                        updateActiveLayer({ marginXPx: Math.max(0, Number(e.target.value) || 0) })
                      }
                      className="w-full px-2 py-1.5 font-mono tabular-nums bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200"
                    />
                  </label>
                  <label className="block">
                    <span className="block text-slate-400 mb-1">Отступ Y (px)</span>
                    <input
                      type="number"
                      min={0}
                      max={800}
                      value={activeLayer.marginYPx}
                      onChange={(e) =>
                        updateActiveLayer({ marginYPx: Math.max(0, Number(e.target.value) || 0) })
                      }
                      className="w-full px-2 py-1.5 font-mono tabular-nums bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200"
                    />
                  </label>
                </div>

                <label className="block">
                  <span className="block text-slate-400 mb-1">
                    Масштаб ({activeLayer.scale.toFixed(2)}×)
                  </span>
                  <input
                    type="range"
                    min={0.3}
                    max={2.0}
                    step={0.05}
                    value={activeLayer.scale}
                    onChange={(e) => updateActiveLayer({ scale: Number(e.target.value) })}
                    className="w-full accent-[#DC2626]"
                  />
                </label>
              </div>

              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="block text-slate-400 mb-1">Появление (сек)</span>
                    <input
                      type="number"
                      step="0.05"
                      min={0}
                      max={3}
                      value={activeLayer.fadeInSec}
                      onChange={(e) =>
                        updateActiveLayer({ fadeInSec: Math.max(0, Number(e.target.value) || 0) })
                      }
                      className="w-full px-2 py-1.5 font-mono tabular-nums bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200"
                    />
                  </label>
                  <label className="block">
                    <span className="block text-slate-400 mb-1">Затухание (сек)</span>
                    <input
                      type="number"
                      step="0.05"
                      min={0}
                      max={3}
                      value={activeLayer.fadeOutSec}
                      onChange={(e) =>
                        updateActiveLayer({ fadeOutSec: Math.max(0, Number(e.target.value) || 0) })
                      }
                      className="w-full px-2 py-1.5 font-mono tabular-nums bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200"
                    />
                  </label>
                </div>

                <label className="block">
                  <span className="block text-slate-400 mb-1">Поведение GIF-анимации</span>
                  <select
                    value={activeLayer.gifBehavior}
                    onChange={(e) =>
                      updateActiveLayer({ gifBehavior: e.target.value as AdGifBehavior })
                    }
                    className="w-full px-2.5 py-1.5 bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200"
                  >
                    <option value="loop">Зацикливать весь интервал</option>
                    <option value="freeze">Остановить на последнем кадре</option>
                    <option value="stop">Проиграть один цикл и скрыть</option>
                  </select>
                </label>

                <div className="space-y-1.5 pt-1">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={activeLayer.preserveAspectRatio}
                      onChange={(e) =>
                        updateActiveLayer({ preserveAspectRatio: e.target.checked })
                      }
                      className="accent-[#DC2626]"
                    />
                    <span className="text-slate-300">Сохранять пропорции (без искажения)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={activeLayer.avoidSubtitles}
                      onChange={(e) =>
                        updateActiveLayer({ avoidSubtitles: e.target.checked })
                      }
                      className="accent-[#DC2626]"
                    />
                    <span className="text-slate-300">Предупреждать о перекрытии субтитров</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={activeLayer.avoidFaces}
                      onChange={(e) => updateActiveLayer({ avoidFaces: e.target.checked })}
                      className="accent-[#DC2626]"
                    />
                    <span className="text-slate-300">Предупреждать о перекрытии зоны лиц</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={activeLayer.allowOnEndplate}
                      onChange={(e) =>
                        updateActiveLayer({ allowOnEndplate: e.target.checked })
                      }
                      className="accent-[#DC2626]"
                    />
                    <span className="text-slate-300">
                      Разрешить показ на финальной заставке (по умолчанию выкл.)
                    </span>
                  </label>
                </div>
              </div>
            </div>

            {/* Live Geometry & Collision Feedback */}
            {computedBox && (
              <div className="p-3 bg-[#0B0F17] border border-[#1F2937] rounded text-xs space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-slate-300 font-mono tabular-nums">
                  <span className="inline-flex items-center gap-1.5 font-sans">
                    <Eye className="w-3.5 h-3.5 text-slate-400" />
                    Итоговые координаты на кадре 1080×1920:
                  </span>
                  <span>
                    X: {computedBox.xPx}px · Y: {computedBox.yPx}px · {computedBox.widthPx}×
                    {computedBox.heightPx}px
                  </span>
                </div>
                {computedBox.clampedToFrame && (
                  <p className="text-amber-300">
                    Координаты автоматически ограничены границами кадра 1080×1920 без обрезания.
                  </p>
                )}
                {collisionWarnings?.messages.map((msg, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-amber-300">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>{msg}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Ad Layer Audio Track Card */}
          <div className="bg-[#121826] border border-[#1F2937] rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                  <Volume2 className="w-4 h-4 text-slate-300" />
                  Аудиодорожка рекламного слоя (опционально)
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Микшируется с оригинальной речью без клиппинга и увеличения длины Shorts · Одинаково в Версии А и Версии Б
                </p>
              </div>

              <div className="flex items-center gap-2">
                {activeLayer.audio?.audioAssetId && (
                  <button
                    type="button"
                    onClick={handleDetachAudioFromLayer}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs bg-[#0B0F17] border border-[#242E42] text-slate-300 hover:text-red-300 rounded"
                    title="Убрать аудио без удаления рекламного изображения"
                  >
                    <VolumeX className="w-3.5 h-3.5" />
                    Удалить аудио со слоя
                  </button>
                )}
                <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#1F2937] hover:bg-[#374151] text-white rounded cursor-pointer">
                  <Upload className="w-3.5 h-3.5" />
                  {activeLayer.audio?.audioAssetId ? 'Заменить звук' : 'Загрузить звук'}
                  <input
                    type="file"
                    accept=".mp3,.wav,.aac,.m4a,.ogg,audio/mpeg,audio/wav,audio/aac,audio/mp4,audio/ogg"
                    disabled={isUploadingAudio}
                    onChange={(e) => {
                      void handleUploadAdAudio(e.target.files?.[0] ?? null);
                      e.target.value = '';
                    }}
                    className="hidden"
                  />
                </label>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(activeLayer.audio?.enabled)}
                    disabled={!activeLayer.audio?.audioAssetId}
                    onChange={(e) => updateActiveLayerAudio({ enabled: e.target.checked })}
                    className="w-4 h-4 accent-[#DC2626]"
                  />
                  <span className="text-slate-200 font-medium">Включить рекламный звук</span>
                </label>

                <select
                  value={activeLayer.audio?.audioAssetId ?? ''}
                  onChange={(e) => {
                    const nextId = e.target.value || null;
                    const chosen = adAudioAssets.find((a) => a.id === nextId);
                    updateActiveLayerAudio({
                      audioAssetId: nextId,
                      enabled: Boolean(nextId),
                      trimStartSec: 0,
                      trimEndSec: chosen ? Number(chosen.durationSec.toFixed(2)) : null,
                    });
                  }}
                  className="w-full px-2.5 py-1.5 bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200"
                >
                  <option value="">Без рекламного аудио</option>
                  {adAudioAssets.map((aud) => (
                    <option key={aud.id} value={aud.id}>
                      {aud.originalName} ({aud.format.toUpperCase()}, {aud.durationSec.toFixed(1)} с)
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="block text-slate-400 mb-1">Старт в ролике (с)</span>
                  <input
                    type="number"
                    step="0.1"
                    min={0}
                    value={activeLayer.audio?.startSec ?? activeLayer.startSec}
                    onChange={(e) =>
                      updateActiveLayerAudio({
                        startSec: Math.max(0, Number(e.target.value) || 0),
                      })
                    }
                    className="w-full px-2 py-1.5 font-mono tabular-nums bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200"
                  />
                </label>
                <label className="block">
                  <span className="block text-slate-400 mb-1">Длительность (с)</span>
                  <input
                    type="number"
                    step="0.1"
                    min={0}
                    placeholder="Авто"
                    value={activeLayer.audio?.durationSec ?? ''}
                    onChange={(e) =>
                      updateActiveLayerAudio({
                        durationSec:
                          e.target.value === ''
                            ? null
                            : Math.max(0.1, Number(e.target.value) || 0.1),
                      })
                    }
                    className="w-full px-2 py-1.5 font-mono tabular-nums bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="block text-slate-400 mb-1">Обрезка от (с)</span>
                  <input
                    type="number"
                    step="0.1"
                    min={0}
                    value={activeLayer.audio?.trimStartSec ?? 0}
                    onChange={(e) =>
                      updateActiveLayerAudio({
                        trimStartSec: Math.max(0, Number(e.target.value) || 0),
                      })
                    }
                    className="w-full px-2 py-1.5 font-mono tabular-nums bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200"
                  />
                </label>
                <label className="block">
                  <span className="block text-slate-400 mb-1">Обрезка до (с)</span>
                  <input
                    type="number"
                    step="0.1"
                    min={0.1}
                    placeholder="Конец"
                    value={activeLayer.audio?.trimEndSec ?? ''}
                    onChange={(e) =>
                      updateActiveLayerAudio({
                        trimEndSec:
                          e.target.value === ''
                            ? null
                            : Math.max(0.1, Number(e.target.value) || 0.1),
                      })
                    }
                    className="w-full px-2 py-1.5 font-mono tabular-nums bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200"
                  />
                </label>
              </div>

              <div className="space-y-2">
                <label className="block">
                  <span className="block text-slate-400 mb-1">
                    Громкость ({activeLayer.audio?.volumeDb ?? -8} дБ)
                  </span>
                  <input
                    type="range"
                    min={-36}
                    max={6}
                    step={1}
                    value={activeLayer.audio?.volumeDb ?? -8}
                    onChange={(e) =>
                      updateActiveLayerAudio({ volumeDb: Number(e.target.value) })
                    }
                    className="w-full accent-[#DC2626]"
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="block text-[11px] text-slate-400">Вход (с)</span>
                    <input
                      type="number"
                      step="0.05"
                      min={0}
                      max={3}
                      value={activeLayer.audio?.fadeInSec ?? 0.25}
                      onChange={(e) =>
                        updateActiveLayerAudio({
                          fadeInSec: Math.max(0, Number(e.target.value) || 0),
                        })
                      }
                      className="w-full px-2 py-1 font-mono tabular-nums bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200"
                    />
                  </label>
                  <label className="block">
                    <span className="block text-[11px] text-slate-400">Выход (с)</span>
                    <input
                      type="number"
                      step="0.05"
                      min={0}
                      max={3}
                      value={activeLayer.audio?.fadeOutSec ?? 0.3}
                      onChange={(e) =>
                        updateActiveLayerAudio({
                          fadeOutSec: Math.max(0, Number(e.target.value) || 0),
                        })
                      }
                      className="w-full px-2 py-1 font-mono tabular-nums bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200"
                    />
                  </label>
                </div>
              </div>
            </div>

            {activeLayerAudioAsset && (
              <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-[#0B0F17] border border-[#1F2937] rounded text-xs">
                <div className="text-slate-300 font-mono tabular-nums">
                  {activeLayerAudioAsset.originalName} · {activeLayerAudioAsset.format.toUpperCase()} ·{' '}
                  {activeLayerAudioAsset.durationSec.toFixed(2)} с
                </div>
                <div className="flex items-center gap-2">
                  <audio
                    ref={audioPreviewRef}
                    src={activeLayerAudioAsset.url}
                    preload="metadata"
                    onTimeUpdate={handlePreviewTimeUpdate}
                    onEnded={() => setIsPreviewPlayingAudio(false)}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={handleToggleAudioPreview}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#1F2937] hover:bg-[#374151] text-white rounded text-xs"
                  >
                    {isPreviewPlayingAudio ? (
                      <>
                        <Square className="w-3 h-3" />
                        Стоп прослушивание
                      </>
                    ) : (
                      <>
                        <Play className="w-3 h-3" />
                        Прослушать с обрезкой и громкостью
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Saved Reusable Advertiser Presets */}
      <div className="bg-[#121826] border border-[#1F2937] rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">
              Постоянные пресеты рекламодателей ({adPresets.length})
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Хранятся отдельно от временных файлов выпуска · Сохраняют рекламодателя, шаблон требований, размещение, громкость и аудио-настройки
            </p>
          </div>

          {activeLayer && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={advertiserName}
                onChange={(e) => setAdvertiserName(e.target.value)}
                placeholder="Рекламодатель"
                className="px-2.5 py-1.5 text-xs bg-[#0B0F17] border border-[#1F2937] rounded text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-slate-500 w-36"
              />
              <input
                type="text"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="Название пресета"
                className="px-2.5 py-1.5 text-xs bg-[#0B0F17] border border-[#1F2937] rounded text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-slate-500 w-44"
              />
              <button
                type="button"
                onClick={handleSaveCurrentAsPreset}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#1F2937] text-white rounded hover:bg-[#374151] whitespace-nowrap"
              >
                <BookmarkPlus className="w-3.5 h-3.5" />
                Сохранить пресет
              </button>
            </div>
          )}
        </div>

        {adPresets.length === 0 ? (
          <p className="text-xs text-slate-500">
            Сохранённых пресетов пока нет. Настройте рекламный слой и сохраните его для быстрого
            переиспользования между выпусками.
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {adPresets.map((preset) => (
              <div
                key={preset.id}
                className="bg-[#0B0F17] border border-[#1F2937] rounded p-3.5 flex items-start justify-between gap-3 text-xs"
              >
                <div className="min-w-0 space-y-1">
                  <div className="font-medium text-slate-100 truncate">
                    {preset.advertiserName ? `${preset.advertiserName} — ` : ''}
                    {preset.name}
                  </div>
                  <div className="text-slate-400 font-mono tabular-nums">
                    {preset.layerConfig.startSec.toFixed(1)}–{preset.layerConfig.endSec.toFixed(1)}{' '}
                    с · {preset.layerConfig.anchor} ·{' '}
                    {preset.layerConfig.widthValue}
                    {preset.layerConfig.sizeMode === 'percent' ? '%' : 'px'}
                    {preset.layerConfig.audioConfig
                      ? ` · аудио ${preset.layerConfig.audioConfig.volumeDb} дБ`
                      : ''}
                  </div>
                  {(preset.requirementsTemplate || preset.layerConfig.promptText) && (
                    <p className="text-[11px] text-slate-500 line-clamp-2">
                      {preset.requirementsTemplate || preset.layerConfig.promptText}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleApplyPreset(preset)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 bg-[#1F2937] hover:bg-[#374151] text-slate-100 rounded text-[11px]"
                  >
                    <Film className="w-3 h-3" />
                    Применить
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeletePreset(preset.id)}
                    className="p-1 text-slate-500 hover:text-red-400"
                    title="Удалить пресет"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
