import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Eye, EyeOff, Film, Layers, Play, Square, Volume2 } from 'lucide-react';
import { resolveSegmentMediaAsset } from '../shared/sourceLibrary.ts';
import type {
  AdAssetInfo,
  AdOverlayLayer,
  CutSegment,
  PreloadedOverlay,
  SegmentAutoFrameResult,
  SourceLibraryItem,
  SubtitleCue,
  UploadedAsset,
} from '../types.ts';
import { computeAdOverlayBox, evaluateAdCollisions } from '../utils/adGeometry.ts';

interface MonitorPreviewProps {
  segments: CutSegment[];
  libraryItems: SourceLibraryItem[];
  activeSegment: CutSegment | null;
  uploadedAssets: Partial<Record<'fragment8' | 'fragment9' | 'music' | 'endplate' | 'audioLogo', UploadedAsset>>;
  preloaded: PreloadedOverlay[];
  subtitles: SubtitleCue[];
  adLayers: AdOverlayLayer[];
  adAssets: AdAssetInfo[];
  endplateAssetId: string;
  endplateDurationSec: number;
  audioLogoAssetId: string;
  totalDurationSec: number;
  mainDurationSec: number;
  autoFrameResult?: SegmentAutoFrameResult | null;
}

function interpolateCropOffsetX(
  keyframes: SegmentAutoFrameResult['keyframes'],
  tSec: number,
): number {
  if (keyframes.length === 0) return 0;
  if (keyframes.length === 1 || tSec <= keyframes[0].t) {
    return keyframes[0].cropOffsetX;
  }
  const last = keyframes[keyframes.length - 1];
  if (tSec >= last.t) return last.cropOffsetX;

  for (let i = 0; i < keyframes.length - 1; i += 1) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    if (tSec >= a.t && tSec <= b.t) {
      if (b.shotCut || b.t - a.t <= 0.001) return a.cropOffsetX;
      const alpha = (tSec - a.t) / (b.t - a.t);
      return Math.round(a.cropOffsetX + (b.cropOffsetX - a.cropOffsetX) * alpha);
    }
  }
  return last.cropOffsetX;
}

export const MonitorPreview: React.FC<MonitorPreviewProps> = ({
  segments,
  libraryItems,
  activeSegment,
  uploadedAssets,
  preloaded,
  subtitles,
  adLayers,
  adAssets,
  endplateAssetId,
  endplateDurationSec,
  audioLogoAssetId,
  totalDurationSec,
  mainDurationSec,
  autoFrameResult,
}) => {
  const [showSafeZones, setShowSafeZones] = useState(true);
  const [showAllAdLayersInPreview, setShowAllAdLayersInPreview] = useState(true);
  const [previewMode, setPreviewMode] = useState<'segment' | 'endplate'>('segment');
  const [localTimeSec, setLocalTimeSec] = useState(0);
  const [isPlayingAudioLogo, setIsPlayingAudioLogo] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const activeAsset = activeSegment
    ? resolveSegmentMediaAsset(activeSegment, libraryItems, uploadedAssets)
    : null;
  const activeOverlay = activeSegment?.overlayId
    ? preloaded.find((p) => p.id === activeSegment.overlayId)
    : undefined;

  const activeSegmentTimelineOffset = useMemo(() => {
    if (!activeSegment) return 0;
    let offset = 0;
    for (const seg of segments) {
      if (seg.id === activeSegment.id) break;
      offset += Math.max(0, seg.endSec - seg.startSec);
    }
    return offset;
  }, [segments, activeSegment]);

  const currentTimelineSec =
    previewMode === 'endplate'
      ? mainDurationSec + 0.5
      : activeSegmentTimelineOffset + localTimeSec;

  const endplateOverlay =
    endplateAssetId === 'uploaded:endplate' && uploadedAssets.endplate
      ? { url: uploadedAssets.endplate.url, label: uploadedAssets.endplate.originalName }
      : preloaded.find((p) => p.id === endplateAssetId) ??
        preloaded.find((p) => p.id === 'preloaded:shorts-04');

  const audioLogoSource =
    audioLogoAssetId === 'uploaded:audioLogo' && uploadedAssets.audioLogo
      ? uploadedAssets.audioLogo.url
      : preloaded.find((p) => p.id === 'preloaded:audio-logo')?.url ?? '';

  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || !activeSegment || !activeAsset) return;
    vid.currentTime = activeSegment.startSec;
    setLocalTimeSec(0);
  }, [activeSegment?.id, activeSegment?.startSec, activeAsset?.url]);

  const handleVideoTimeUpdate = () => {
    const vid = videoRef.current;
    if (!vid || !activeSegment) return;
    if (vid.currentTime >= activeSegment.endSec) {
      vid.pause();
      vid.currentTime = activeSegment.startSec;
    }
    setLocalTimeSec(Math.max(0, vid.currentTime - activeSegment.startSec));
  };

  const toggleLogoAudio = () => {
    const el = audioRef.current;
    if (!el) return;
    if (isPlayingAudioLogo) {
      el.pause();
      el.currentTime = 0;
      setIsPlayingAudioLogo(false);
    } else {
      el.currentTime = 0;
      el.play().catch(() => {});
      setIsPlayingAudioLogo(true);
    }
  };

  const previewCue =
    subtitles.find(
      (c) => currentTimelineSec >= c.startSec && currentTimelineSec <= c.endSec,
    ) ?? subtitles[0];

  const visibleAdLayers = useMemo(() => {
    return adLayers
      .filter((layer) => {
        if (!layer.enabled) return false;
        if (previewMode === 'endplate' && !layer.allowOnEndplate) return false;
        if (showAllAdLayersInPreview && previewMode === 'segment') return true;
        return currentTimelineSec >= layer.startSec && currentTimelineSec <= layer.endSec;
      })
      .map((layer) => {
        const asset = adAssets.find((a) => a.id === layer.adAssetId) ?? null;
        const box = computeAdOverlayBox(layer, asset);
        const collisions = evaluateAdCollisions(layer, box, subtitles);
        return { layer, asset, box, collisions };
      })
      .filter((item) => item.asset !== null);
  }, [adLayers, adAssets, previewMode, showAllAdLayersInPreview, currentTimelineSec, subtitles]);

  const anyCollisionMessage = visibleAdLayers.flatMap((v) => v.collisions.messages)[0] ?? null;

  const isAutoFraming = activeSegment ? activeSegment.framingMode !== 'manual' : true;
  const effectiveCropOffsetX = activeSegment
    ? isAutoFraming && autoFrameResult && autoFrameResult.keyframes.length > 0
      ? interpolateCropOffsetX(autoFrameResult.keyframes, localTimeSec)
      : activeSegment.cropOffsetX
    : 0;

  const objectPositionX = activeSegment
    ? `${Math.round(((effectiveCropOffsetX + 100) / 200) * 100)}%`
    : '50%';

  const durationOk = totalDurationSec >= 55 && totalDurationSec <= 59;

  return (
    <aside className="flex flex-col bg-[#121826] border border-[#1F2937] rounded-lg p-4 h-fit">
      <div className="flex items-center justify-between gap-2 pb-3 border-b border-[#1F2937]">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">Монитор 9:16</h2>
          <p className="text-xs text-slate-400 tabular-nums">
            1080×1920 ·{' '}
            <span className={durationOk ? 'text-emerald-400' : 'text-amber-400'}>
              {totalDurationSec.toFixed(1)} с
            </span>{' '}
            (цель 55–59 с)
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowSafeZones((v) => !v)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-300 bg-[#0B0F17] border border-[#1F2937] rounded hover:text-white hover:border-slate-600 transition-colors whitespace-nowrap shrink-0"
          title="Показать/скрыть безопасную зону YouTube Shorts"
        >
          {showSafeZones ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
          Зоны Shorts
        </button>
      </div>

      {/* Mode Switch */}
      <div className="grid grid-cols-2 gap-1 p-1 mt-3 bg-[#0B0F17] border border-[#1F2937] rounded-md">
        <button
          type="button"
          onClick={() => setPreviewMode('segment')}
          className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
            previewMode === 'segment'
              ? 'bg-[#1F2937] text-white'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Сцена / Кадр
        </button>
        <button
          type="button"
          onClick={() => setPreviewMode('endplate')}
          className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
            previewMode === 'endplate'
              ? 'bg-[#1F2937] text-white'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Заставка ({endplateDurationSec.toFixed(1)} с)
        </button>
      </div>

      {adLayers.some((l) => l.enabled) && (
        <label className="mt-2.5 flex items-center justify-between gap-2 text-[11px] text-slate-300 cursor-pointer">
          <span className="inline-flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-slate-400" />
            Показ рекламы в предпросмотре всегда
          </span>
          <input
            type="checkbox"
            checked={showAllAdLayersInPreview}
            onChange={(e) => setShowAllAdLayersInPreview(e.target.checked)}
            className="accent-[#DC2626]"
          />
        </label>
      )}

      {/* 9:16 Viewport */}
      <div className="mt-3 mx-auto w-full max-w-[280px] aspect-[9/16] relative bg-[#0B0F17] border border-[#242E42] rounded-md overflow-hidden select-none">
        {previewMode === 'endplate' ? (
          <div className="w-full h-full bg-[#111318] flex items-center justify-center relative">
            {endplateOverlay ? (
              <img
                src={endplateOverlay.url}
                alt={endplateOverlay.label}
                referrerPolicy="no-referrer"
                className="w-full h-full object-contain"
              />
            ) : (
              <div className="p-4 text-center text-xs text-slate-400">
                Финальная заставка не выбрана
              </div>
            )}
          </div>
        ) : activeAsset ? (
          <video
            ref={videoRef}
            src={activeAsset.url}
            controls
            onTimeUpdate={handleVideoTimeUpdate}
            style={{ objectPosition: `${objectPositionX} 50%` }}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center p-6 text-center bg-[#0B0F17]">
            <Film className="w-8 h-8 text-slate-600 mb-3" />
            <p className="text-xs font-medium text-slate-300">
              {activeSegment?.sourceId
                ? 'Исходник не найден в библиотеке'
                : activeSegment?.sourceRole === 'fragment8'
                  ? 'Ожидается исходник («Фрагмент 8» или видео из библиотеки)'
                  : activeSegment?.sourceRole === 'fragment9'
                    ? 'Ожидается исходник («Фрагмент 9» или видео из библиотеки)'
                    : 'Выберите исходник в библиотеке'}
            </p>
            <p className="text-[11px] text-slate-500 mt-1.5 leading-relaxed">
              Загрузите видеофайлы во вкладке «Активы и звук» и привяжите нужный фрагмент к сегменту, чтобы увидеть живой кадр 9:16.
            </p>
          </div>
        )}

        {/* Optional PNG Overlay (matches FFmpeg overlayPlacement) */}
        {previewMode === 'segment' && activeOverlay && (
          <img
            src={activeOverlay.url}
            alt={activeOverlay.label}
            referrerPolicy="no-referrer"
            className={
              activeOverlay.overlayPlacement === 'top-left-badge'
                ? 'absolute left-[6%] top-[12.5%] w-[33%] h-auto object-contain pointer-events-none'
                : activeOverlay.overlayPlacement === 'top-center-logo'
                  ? 'absolute left-1/2 -translate-x-1/2 top-[12.5%] w-[52%] h-auto object-contain pointer-events-none'
                  : activeOverlay.overlayPlacement === 'bottom-center-subtitle'
                    ? 'absolute left-1/2 -translate-x-1/2 top-[74%] w-[70%] h-auto object-contain pointer-events-none'
                    : 'absolute inset-0 w-full h-full object-contain pointer-events-none'
            }
          />
        )}

        {/* Subtitle Preview inside Safe Zone */}
        {previewMode === 'segment' && previewCue && (
          <div className="absolute inset-x-4 bottom-[18%] flex flex-col items-center text-center pointer-events-none">
            <div className="bg-black/75 px-2.5 py-1 rounded text-[13px] leading-snug font-semibold text-white shadow">
              <div>{previewCue.line1}</div>
              {previewCue.line2 && <div>{previewCue.line2}</div>}
            </div>
          </div>
        )}

        {/* Live Ad Overlay Layers (PNG / JPG / WEBP / animated GIF) */}
        {visibleAdLayers.map(({ layer, asset, box, collisions }) => (
          <div
            key={layer.id}
            style={{
              left: `${box.leftPct}%`,
              top: `${box.topPct}%`,
              width: `${box.widthPct}%`,
              height: `${box.heightPct}%`,
              opacity: layer.opacity,
            }}
            className={`absolute pointer-events-none ${
              collisions.messages.length > 0
                ? 'ring-1 ring-amber-400'
                : layer.confirmed
                  ? 'ring-1 ring-emerald-400/60'
                  : 'ring-1 ring-sky-400/60'
            }`}
          >
            <img
              src={asset!.url}
              alt={layer.name}
              referrerPolicy="no-referrer"
              className="w-full h-full object-fill"
            />
          </div>
        ))}

        {/* YouTube Shorts Safe-Zone Guides */}
        {showSafeZones && (
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute top-0 inset-x-0 h-[12%] bg-red-500/10 border-b border-dashed border-red-400/40" />
            <div className="absolute bottom-0 inset-x-0 h-[17%] bg-red-500/10 border-t border-dashed border-red-400/40" />
            <div className="absolute right-0 top-[25%] bottom-[17%] w-[14%] bg-red-500/10 border-l border-dashed border-red-400/40" />
          </div>
        )}
      </div>

      {anyCollisionMessage && (
        <div className="mt-2.5 p-2 bg-amber-950/35 border border-amber-800/50 rounded text-[11px] text-amber-200 flex items-start gap-1.5 leading-snug">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
          <span>{anyCollisionMessage}</span>
        </div>
      )}

      {/* Summary Metrics + Audio Logo Check */}
      <div className="mt-4 pt-3 border-t border-[#1F2937] space-y-2.5 text-xs">
        <div className="flex items-center justify-between text-slate-400">
          <span>Основной монтаж</span>
          <span className="font-mono tabular-nums text-slate-200">{mainDurationSec.toFixed(1)} с</span>
        </div>
        <div className="flex items-center justify-between text-slate-400">
          <span>Финальная заставка</span>
          <span className="font-mono tabular-nums text-slate-200">{endplateDurationSec.toFixed(1)} с</span>
        </div>
        <div className="flex items-center justify-between text-slate-400">
          <span>Активная реклама</span>
          <span className="font-mono tabular-nums text-slate-200">
            {adLayers.filter((l) => l.enabled && l.confirmed).length} / {adLayers.length} слоёв
          </span>
        </div>
        <div className="flex items-center justify-between text-slate-400">
          <span>Режим кадра</span>
          <span className="font-mono tabular-nums text-slate-200">
            {activeSegment
              ? `${isAutoFraming ? 'Авто' : 'Ручн.'} X: ${effectiveCropOffsetX > 0 ? `+${effectiveCropOffsetX}` : effectiveCropOffsetX}%`
              : '—'}
          </span>
        </div>

        {audioLogoSource && (
          <div className="pt-2 border-t border-[#1F2937] flex items-center justify-between gap-2">
            <span className="text-slate-400 flex items-center gap-1.5 truncate">
              <Volume2 className="w-3.5 h-3.5 shrink-0 text-slate-400" />
              Звуковой логотип
            </span>
            <audio
              ref={audioRef}
              src={audioLogoSource}
              onEnded={() => setIsPlayingAudioLogo(false)}
              className="hidden"
            />
            <button
              type="button"
              onClick={toggleLogoAudio}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200 hover:border-slate-600 transition-colors whitespace-nowrap shrink-0"
            >
              {isPlayingAudioLogo ? (
                <>
                  <Square className="w-3 h-3" /> Стоп
                </>
              ) : (
                <>
                  <Play className="w-3 h-3" /> Прослушать
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </aside>
  );
};

