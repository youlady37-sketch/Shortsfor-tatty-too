import React, { useState } from 'react';
import { Download, Image as ImageIcon } from 'lucide-react';
import type { AspectRatioOption, ImageSizeOption } from '../types.ts';

const IMAGE_SIZES: ImageSizeOption[] = ['1K', '2K', '4K'];
const ASPECT_RATIOS: AspectRatioOption[] = ['9:16', '16:9', '1:1'];

export const CoverStudio: React.FC = () => {
  const [prompt, setPrompt] = useState(
    'Архивная папка советского уголовного дела на тёмном деревянном столе, свет настольной лампы, строгий документальный стиль, глубокие тени, без текста и без лиц.',
  );
  const [imageSize, setImageSize] = useState<ImageSizeOption>('1K');
  const [aspectRatio, setAspectRatio] = useState<AspectRatioOption>('9:16');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [modelNote, setModelNote] = useState<string>('');

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    setError(null);
    setIsGenerating(true);

    try {
      const res = await fetch('/api/generate-cover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, imageSize, aspectRatio }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Не удалось сгенерировать обложку.');
      }
      setGeneratedUrl(data.imageDataUrl);
      setModelNote(data.modelText || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка генерации изображения.');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-slate-100">
          Генератор обложки выпуска (gemini-3-pro-image-preview)
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Используется только для обложки/оформления публикации YouTube. Не вставляется вместо оригинальных видеокадров.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <form
          onSubmit={handleGenerate}
          className="lg:col-span-7 bg-[#121826] border border-[#1F2937] rounded-lg p-5 space-y-5"
        >
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-2">
              Описание обложки (без оружия, крови и реконструкции насилия)
            </label>
            <textarea
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-[#0B0F17] border border-[#1F2937] rounded text-slate-100 focus:outline-none focus:border-slate-500 leading-relaxed"
              placeholder="Опишите атмосферу обложки для канала «ДЕЛО В КАДРЕ»..."
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <span className="block text-xs font-medium text-slate-300 mb-2">
                Разрешение изображения (Image Size)
              </span>
              <div className="grid grid-cols-3 gap-1.5 p-1 bg-[#0B0F17] border border-[#1F2937] rounded-md">
                {IMAGE_SIZES.map((size) => (
                  <button
                    key={size}
                    type="button"
                    onClick={() => setImageSize(size)}
                    className={`py-1.5 text-xs font-mono font-medium rounded transition-colors ${
                      imageSize === size
                        ? 'bg-[#DC2626] text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {size}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="block text-xs font-medium text-slate-300 mb-2">
                Соотношение сторон
              </span>
              <div className="grid grid-cols-3 gap-1.5 p-1 bg-[#0B0F17] border border-[#1F2937] rounded-md">
                {ASPECT_RATIOS.map((ratio) => (
                  <button
                    key={ratio}
                    type="button"
                    onClick={() => setAspectRatio(ratio)}
                    className={`py-1.5 text-xs font-mono font-medium rounded transition-colors ${
                      aspectRatio === ratio
                        ? 'bg-[#1F2937] text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {ratio}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {error && (
            <div className="p-3 bg-red-950/40 border border-red-900/60 rounded text-xs text-red-300 leading-relaxed">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between gap-4 pt-1">
            <span className="text-xs text-slate-400 font-mono tabular-nums">
              Модель: gemini-3-pro-image-preview · {imageSize} · {aspectRatio}
            </span>

            <button
              type="submit"
              disabled={isGenerating || !prompt.trim()}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-[#DC2626] text-white rounded hover:bg-[#B91C1C] disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              <ImageIcon className="w-3.5 h-3.5" />
              {isGenerating ? `Генерация (${imageSize})…` : `Создать обложку (${imageSize})`}
            </button>
          </div>
        </form>

        <div className="lg:col-span-5 bg-[#121826] border border-[#1F2937] rounded-lg p-5 flex flex-col justify-between gap-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-300">Результат обложки</span>
            {generatedUrl && (
              <a
                href={generatedUrl}
                download={`delo_v_kadre_cover_${imageSize}.png`}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-[#0B0F17] border border-[#242E42] text-slate-200 rounded hover:border-slate-500 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Скачать PNG
              </a>
            )}
          </div>

          <div className="w-full min-h-[300px] bg-[#0B0F17] border border-[#1F2937] rounded flex items-center justify-center overflow-hidden p-3">
            {generatedUrl ? (
              <img
                src={generatedUrl}
                alt="Сгенерированная обложка выпуска"
                referrerPolicy="no-referrer"
                className="max-h-[380px] w-auto object-contain rounded"
              />
            ) : (
              <div className="text-center text-xs text-slate-500 max-w-[260px] leading-relaxed">
                Выберите размер (1K, 2K или 4K), формат и нажмите «Создать обложку», чтобы
                подготовить превью для YouTube.
              </div>
            )}
          </div>

          {modelNote && (
            <p className="text-[11px] text-slate-400 leading-relaxed">{modelNote}</p>
          )}
        </div>
      </div>
    </div>
  );
};
