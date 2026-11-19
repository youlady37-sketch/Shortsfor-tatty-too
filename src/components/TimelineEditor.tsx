import React from 'react';
import { ArrowDown, ArrowUp, Layers, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import type {
  AdAssetInfo,
  AdOverlayLayer,
  CutSegment,
  PreloadedOverlay,
  UploadedAsset,
} from '../types.ts';

interface TimelineEditorProps {
  segments: CutSegment[];
  selectedSegmentId: string | null;
  onSelectSegment: (id: string) => void;
  onUpdateSegment: (id: string, patch: Partial<CutSegment>) => void;
  onMoveSegment: (id: string, dir: -1 | 1) => void;
  onDeleteSegment: (id: string) => void;
  onAddSegment: () => void;
  adLayers: AdOverlayLayer[];
  adAssets: AdAssetInfo[];
  onUpdateAdLayer: (id: string, patch: Partial<AdOverlayLayer>) => void;
  onDeleteAdLayer: (id: string) => void;
  onOpenAdsTab: (layerId?: string) => void;
  uploadedAssets: Partial<Record<'fragment8' | 'fragment9' | 'music' | 'endplate' | 'audioLogo', UploadedAsset>>;
  preloaded: PreloadedOverlay[];
  endplateAssetId: string;
  onChangeEndplateAssetId: (id: string) => void;
  endplateDurationSec: number;
  onChangeEndplateDurationSec: (val: number) => void;
  audioLogoAssetId: string;
  onChangeAudioLogoAssetId: (id: string) => void;
  useUploadedMusic: boolean;
  onChangeUseUploadedMusic: (val: boolean) => void;
  musicGainDb: number;
  onChangeMusicGainDb: (val: number) => void;
}

function formatSecToTimecode(sec: number): string {
  const clamped = Math.max(0, sec);
  const mins = Math.floor(clamped / 60);
  const secs = (clamped % 60).toFixed(1).padStart(4, '0');
  return `${String(mins).padStart(2, '0')}:${secs}`;
}

export const TimelineEditor: React.FC<TimelineEditorProps> = ({
  segments,
  selectedSegmentId,
  onSelectSegment,
  onUpdateSegment,
  onMoveSegment,
  onDeleteSegment,
  onAddSegment,
  adLayers,
  adAssets,
  onUpdateAdLayer,
  onDeleteAdLayer,
  onOpenAdsTab,
  uploadedAssets,
  preloaded,
  endplateAssetId,
  onChangeEndplateAssetId,
  endplateDurationSec,
  onChangeEndplateDurationSec,
  audioLogoAssetId,
  onChangeAudioLogoAssetId,
  useUploadedMusic,
  onChangeUseUploadedMusic,
  musicGainDb,
  onChangeMusicGainDb,
}) => {
  const montageOverlays = preloaded.filter(
    (p) => p.kind === 'image' && Boolean(p.overlayPlacement),
  );
  const fullOverlays = montageOverlays.filter((p) => p.category === 'overlay');
  const rubricMarkers = montageOverlays.filter((p) => p.category === 'rubric-marker');
  const brandOverlays = montageOverlays.filter(
    (p) => p.category === 'brand-logo' || p.id === 'preloaded:subtitle-document',
  );
  const titleCards = montageOverlays.filter(
    (p) =>
      p.category === 'rubric-title' ||
      p.category === 'title-card' ||
      p.category === 'endplate',
  );
  const endplateOptions = preloaded.filter(
    (p) =>
      p.kind === 'image' &&
      (p.category === 'endplate' ||
        p.category === 'rubric-title' ||
        p.category === 'title-card'),
  );

  return (
    <div className="space-y-6">
      {/* Segments Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            Драматургическая сборка (5 этапов + финал)
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Оригинальные голоса, тембр и скорость речи сохраняются без изменений · Кадрирование 9:16 с защитой лиц
          </p>
        </div>

        <button
          type="button"
          onClick={onAddSegment}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#121826] border border-[#242E42] text-slate-200 rounded hover:border-slate-500 transition-colors whitespace-nowrap shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          Добавить склейку
        </button>
      </div>

      {/* Cut Segments List */}
      <div className="space-y-3">
        {segments.map((seg, idx) => {
          const isSelected = seg.id === selectedSegmentId;
          const segDur = Math.max(0, seg.endSec - seg.startSec);
          const sourceAsset = uploadedAssets[seg.sourceRole];
          const sourceReady = Boolean(sourceAsset);
          const outOfBounds =
            sourceAsset && seg.endSec > sourceAsset.probe.durationSec + 0.05;

          return (
            <div
              key={seg.id}
              onClick={() => onSelectSegment(seg.id)}
              className={`rounded-lg border p-4 transition-colors cursor-pointer ${
                isSelected
                  ? 'bg-[#161E2E] border-slate-500'
                  : 'bg-[#121826] border-[#1F2937] hover:border-[#2C374B]'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-mono text-xs tabular-nums text-slate-400 w-6 shrink-0">
                    {String(idx + 1).padStart(2, '0')}.
                  </span>
                  <input
                    type="text"
                    value={seg.beatTitle}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onUpdateSegment(seg.id, { beatTitle: e.target.value })}
                    className="bg-transparent text-sm font-medium text-slate-100 focus:outline-none border-b border-transparent focus:border-slate-500 min-w-[220px]"
                  />
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-mono text-xs tabular-nums text-slate-300">
                    {segDur.toFixed(1)} с
                  </span>
                  <span className="text-slate-600" aria-hidden="true">·</span>
                  <span
                    className={`text-xs ${
                      !sourceReady
                        ? 'text-amber-400'
                        : outOfBounds
                          ? 'text-red-400'
                          : 'text-emerald-400'
                    }`}
                  >
                    {!sourceReady
                      ? 'Файл не загружен'
                      : outOfBounds
                        ? 'Вне границ файла'
                        : 'Источник готов'}
                  </span>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onMoveSegment(seg.id, -1);
                    }}
                    disabled={idx === 0}
                    className="p-1.5 text-slate-400 hover:text-white disabled:opacity-30"
                    title="Переместить выше"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onMoveSegment(seg.id, 1);
                    }}
                    disabled={idx === segments.length - 1}
                    className="p-1.5 text-slate-400 hover:text-white disabled:opacity-30"
                    title="Переместить ниже"
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteSegment(seg.id);
                    }}
                    disabled={segments.length <= 1}
                    className="p-1.5 text-slate-400 hover:text-red-400 disabled:opacity-30"
                    title="Удалить сегмент"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Controls Grid */}
              <div
                className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3"
                onClick={(e) => e.stopPropagation()}
              >
                <label className="block">
                  <span className="block text-[11px] text-slate-400 mb-1">Исходник</span>
                  <select
                    value={seg.sourceRole}
                    onChange={(e) =>
                      onUpdateSegment(seg.id, {
                        sourceRole: e.target.value as 'fragment8' | 'fragment9',
                      })
                    }
                    className="w-full px-2.5 py-1.5 text-xs bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200 focus:outline-none focus:border-slate-500"
                  >
                    <option value="fragment8">Фрагмент 8 (04:10–04:26)</option>
                    <option value="fragment9">Фрагмент 9 (00:00–01:15)</option>
                  </select>
                </label>

                <label className="block">
                  <span className="block text-[11px] text-slate-400 mb-1">
                    In, сек ({formatSecToTimecode(seg.startSec)})
                  </span>
                  <input
                    type="number"
                    step="0.5"
                    min={0}
                    value={seg.startSec}
                    onChange={(e) =>
                      onUpdateSegment(seg.id, { startSec: Math.max(0, Number(e.target.value)) })
                    }
                    className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200 focus:outline-none focus:border-slate-500"
                  />
                </label>

                <label className="block">
                  <span className="block text-[11px] text-slate-400 mb-1">
                    Out, сек ({formatSecToTimecode(seg.endSec)})
                  </span>
                  <input
                    type="number"
                    step="0.5"
                    min={0.5}
                    value={seg.endSec}
                    onChange={(e) =>
                      onUpdateSegment(seg.id, { endSec: Math.max(0.5, Number(e.target.value)) })
                    }
                    className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200 focus:outline-none focus:border-slate-500"
                  />
                </label>

                <label className="block">
                  <span className="block text-[11px] text-slate-400 mb-1">
                    Пан 9:16 (X: {seg.cropOffsetX > 0 ? `+${seg.cropOffsetX}` : seg.cropOffsetX}%)
                  </span>
                  <input
                    type="range"
                    min={-100}
                    max={100}
                    step={5}
                    value={seg.cropOffsetX}
                    onChange={(e) =>
                      onUpdateSegment(seg.id, { cropOffsetX: Number(e.target.value) })
                    }
                    className="w-full accent-[#DC2626] mt-1.5"
                  />
                </label>

                <label className="block">
                  <span className="block text-[11px] text-slate-400 mb-1">Оверлей PNG</span>
                  <select
                    value={seg.overlayId ?? ''}
                    onChange={(e) =>
                      onUpdateSegment(seg.id, { overlayId: e.target.value || null })
                    }
                    className="w-full px-2.5 py-1.5 text-xs bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200 focus:outline-none focus:border-slate-500"
                  >
                    <option value="">Без оверлея (чистый кадр)</option>
                    {fullOverlays.length > 0 && (
                      <optgroup label="Оверлеи 9:16 и рамки">
                        {fullOverlays.map((ov) => (
                          <option key={ov.id} value={ov.id}>
                            {ov.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {rubricMarkers.length > 0 && (
                      <optgroup label="Плашки-маркеры рубрик">
                        {rubricMarkers.map((ov) => (
                          <option key={ov.id} value={ov.id}>
                            {ov.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {brandOverlays.length > 0 && (
                      <optgroup label="Логотипы и документальные плашки">
                        {brandOverlays.map((ov) => (
                          <option key={ov.id} value={ov.id}>
                            {ov.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {titleCards.length > 0 && (
                      <optgroup label="Полноэкранные заставки и титры">
                        {titleCards.map((ov) => (
                          <option key={ov.id} value={ov.id}>
                            {ov.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </label>
              </div>
            </div>
          );
        })}
      </div>

      {/* Independent Ad Overlay Track */}
      <div className="bg-[#121826] border border-[#1F2937] rounded-lg p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <Layers className="w-4 h-4 text-slate-300" />
              Независимый слой рекламы ({adLayers.length})
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Перемещайте рекламные плашки во времени, включайте/отключайте и удаляйте без изменения исходных сегментов.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onOpenAdsTab()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0B0F17] border border-[#242E42] text-slate-200 rounded hover:border-slate-500 whitespace-nowrap"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            Настроить в «Реклама»
          </button>
        </div>

        {adLayers.length === 0 ? (
          <p className="text-xs text-slate-500">
            Рекламные плашки не добавлены. Вы можете загрузить PNG, JPG, WEBP или анимированный GIF во вкладке «Реклама».
          </p>
        ) : (
          <div className="space-y-2.5">
            {adLayers.map((layer) => {
              const asset = adAssets.find((a) => a.id === layer.adAssetId);
              return (
                <div
                  key={layer.id}
                  className="bg-[#0B0F17] border border-[#1F2937] rounded p-3 flex flex-wrap items-center justify-between gap-3 text-xs"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <input
                      type="checkbox"
                      checked={layer.enabled}
                      onChange={(e) => onUpdateAdLayer(layer.id, { enabled: e.target.checked })}
                      className="w-4 h-4 accent-[#DC2626]"
                      title="Включить/выключить слой рекламы"
                    />
                    <div className="min-w-0">
                      <div className="font-medium text-slate-100 truncate">{layer.name}</div>
                      <div className="text-[11px] text-slate-400 font-mono tabular-nums">
                        {asset ? `${asset.format.toUpperCase()} ${asset.width}×${asset.height}` : 'Файл не привязан'} ·{' '}
                        {layer.confirmed ? 'подтверждён' : 'ожидает подтверждения'}
                        {layer.audio?.audioAssetId
                          ? ` · звук: ${layer.audio.enabled ? `вкл (${layer.audio.volumeDb} дБ)` : 'выкл'}`
                          : ''}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5">
                    {layer.audio?.audioAssetId && (
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateAdLayer(layer.id, {
                            audio: { ...layer.audio!, enabled: !layer.audio!.enabled },
                          })
                        }
                        className={`px-2 py-1 rounded border text-[11px] ${
                          layer.audio.enabled
                            ? 'bg-emerald-950/40 border-emerald-700/60 text-emerald-300'
                            : 'bg-[#121826] border-[#1F2937] text-slate-400'
                        }`}
                        title="Включить/отключить рекламное аудио этого слоя"
                      >
                        {layer.audio.enabled ? 'Аудио ВКЛ' : 'Аудио ВЫКЛ'}
                      </button>
                    )}
                    <label className="flex items-center gap-1.5 text-slate-400">
                      <span>С, с</span>
                      <input
                        type="number"
                        step="0.5"
                        min={0}
                        value={layer.startSec}
                        onChange={(e) =>
                          onUpdateAdLayer(layer.id, {
                            startSec: Math.max(0, Number(e.target.value) || 0),
                          })
                        }
                        className="w-16 px-2 py-1 font-mono tabular-nums bg-[#121826] border border-[#1F2937] rounded text-slate-200"
                      />
                    </label>
                    <label className="flex items-center gap-1.5 text-slate-400">
                      <span>До, с</span>
                      <input
                        type="number"
                        step="0.5"
                        min={0.5}
                        value={layer.endSec}
                        onChange={(e) =>
                          onUpdateAdLayer(layer.id, {
                            endSec: Math.max(0.5, Number(e.target.value) || 0.5),
                          })
                        }
                        className="w-16 px-2 py-1 font-mono tabular-nums bg-[#121826] border border-[#1F2937] rounded text-slate-200"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => onOpenAdsTab(layer.id)}
                      className="px-2.5 py-1 bg-[#121826] border border-[#1F2937] rounded text-slate-200 hover:border-slate-500"
                    >
                      Правка
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteAdLayer(layer.id)}
                      className="p-1 text-slate-500 hover:text-red-400"
                      title="Удалить рекламный слой"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Endplate & Audio Mix Settings */}
      <div className="bg-[#121826] border border-[#1F2937] rounded-lg p-5 space-y-4">
        <h3 className="text-sm font-semibold text-slate-100">
          Финальная заставка и звуковой микс (Версия А / Б)
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <label className="block">
            <span className="block text-xs text-slate-400 mb-1.5">Визуальная заставка</span>
            <select
              value={endplateAssetId}
              onChange={(e) => onChangeEndplateAssetId(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200 focus:outline-none focus:border-slate-500"
            >
              {endplateOptions.length > 0 ? (
                endplateOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))
              ) : (
                <option value="preloaded:shorts-04">Загруженный shorts-04 (PNG)</option>
              )}
              {uploadedAssets.endplate && (
                <option value="uploaded:endplate">
                  Свой шаблон: {uploadedAssets.endplate.originalName}
                </option>
              )}
            </select>
          </label>

          <label className="block">
            <span className="block text-xs text-slate-400 mb-1.5">
              Длительность заставки ({endplateDurationSec.toFixed(1)} с)
            </span>
            <input
              type="range"
              min={1.5}
              max={2.0}
              step={0.1}
              value={endplateDurationSec}
              onChange={(e) => onChangeEndplateDurationSec(Number(e.target.value))}
              className="w-full accent-[#DC2626] mt-2"
            />
          </label>

          <label className="block">
            <span className="block text-xs text-slate-400 mb-1.5">Звуковой логотип (Версия А)</span>
            <select
              value={audioLogoAssetId}
              onChange={(e) => onChangeAudioLogoAssetId(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200 focus:outline-none focus:border-slate-500"
            >
              <option value="preloaded:audio-logo">Загруженный WAV (14455776.wav)</option>
              {uploadedAssets.audioLogo && (
                <option value="uploaded:audioLogo">
                  Свой звук: {uploadedAssets.audioLogo.originalName}
                </option>
              )}
            </select>
          </label>

          <div className="block">
            <span className="block text-xs text-slate-400 mb-1.5">
              Фоновая музыка в Версии А ({musicGainDb} дБ)
            </span>
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={useUploadedMusic}
                disabled={!uploadedAssets.music}
                onChange={(e) => onChangeUseUploadedMusic(e.target.checked)}
                className="w-4 h-4 accent-[#DC2626]"
                title={uploadedAssets.music ? 'Включить музыку в Версию А' : 'Сначала загрузите лицензионный трек'}
              />
              <input
                type="range"
                min={-34}
                max={-10}
                step={1}
                disabled={!useUploadedMusic || !uploadedAssets.music}
                value={musicGainDb}
                onChange={(e) => onChangeMusicGainDb(Number(e.target.value))}
                className="w-full accent-[#DC2626] disabled:opacity-40"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
