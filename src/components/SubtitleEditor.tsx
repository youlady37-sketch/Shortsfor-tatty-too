import React, { useState } from 'react';
import { Download, Mic, Plus, Trash2 } from 'lucide-react';
import { resolveSegmentMediaAsset } from '../shared/sourceLibrary.ts';
import type { CutSegment, SourceLibraryItem, SubtitleCue, UploadedAsset } from '../types.ts';

interface SubtitleEditorProps {
  subtitles: SubtitleCue[];
  onChangeSubtitles: (next: SubtitleCue[]) => void;
  segments: CutSegment[];
  libraryItems: SourceLibraryItem[];
  uploadedAssets: Partial<Record<'fragment8' | 'fragment9' | 'music' | 'endplate' | 'audioLogo', UploadedAsset>>;
}

function formatSrtTime(sec: number): string {
  const clamped = Math.max(0, sec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export const SubtitleEditor: React.FC<SubtitleEditorProps> = ({
  subtitles,
  onChangeSubtitles,
  segments,
  libraryItems,
  uploadedAssets,
}) => {
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawTranscript, setRawTranscript] = useState<string>('');

  const canTranscribe =
    segments.length > 0 &&
    segments.every((s) => Boolean(resolveSegmentMediaAsset(s, libraryItems, uploadedAssets)));

  const handleAutoTranscribe = async () => {
    setError(null);
    setIsTranscribing(true);
    try {
      const res = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Не удалось расшифровать аудиодорожку.');
      }
      setRawTranscript(data.rawText || '');
      if (Array.isArray(data.cues) && data.cues.length > 0) {
        onChangeSubtitles(data.cues);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка распознавания речи.');
    } finally {
      setIsTranscribing(false);
    }
  };

  const handleDownloadSrt = () => {
    const srt = subtitles
      .map((cue, idx) => {
        const text = cue.line2.trim() ? `${cue.line1}\n${cue.line2}` : cue.line1;
        return `${idx + 1}\n${formatSrtTime(cue.startSec)} --> ${formatSrtTime(cue.endSec)}\n${text}\n`;
      })
      .join('\n');
    const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'delo_v_kadre_subtitles.srt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const updateCue = (id: string, patch: Partial<SubtitleCue>) => {
    onChangeSubtitles(subtitles.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const addCue = () => {
    const lastEnd = subtitles.length > 0 ? subtitles[subtitles.length - 1].endSec : 0;
    onChangeSubtitles([
      ...subtitles,
      {
        id: `sub-${Date.now()}`,
        startSec: Number(lastEnd.toFixed(1)),
        endSec: Number((lastEnd + 2.5).toFixed(1)),
        line1: '',
        line2: '',
      },
    ]);
  };

  const removeCue = (id: string) => {
    onChangeSubtitles(subtitles.filter((c) => c.id !== id));
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            Встроенные русскоязычные субтитры (максимум 2 строки)
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Точное соответствие оригинальной речи · Безопасная зона 1080×1920 · Гарнитура Noto Sans Bold
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={handleDownloadSrt}
            disabled={subtitles.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#121826] border border-[#242E42] text-slate-200 rounded hover:border-slate-500 disabled:opacity-40 transition-colors whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            Скачать .SRT
          </button>

          <button
            type="button"
            onClick={handleAutoTranscribe}
            disabled={!canTranscribe || isTranscribing}
            title={
              canTranscribe
                ? 'Дословно распознать речь из загруженных видеосегментов'
                : 'Привяжите загруженные видео из библиотеки ко всем сегментам таймлайна'
            }
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#121826] border border-[#242E42] text-slate-200 rounded hover:border-slate-500 disabled:opacity-40 transition-colors whitespace-nowrap"
          >
            <Mic className="w-3.5 h-3.5" />
            {isTranscribing ? 'Распознавание…' : 'Распознать речь (Gemini)'}
          </button>

          <button
            type="button"
            onClick={addCue}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#DC2626] text-white rounded hover:bg-[#B91C1C] transition-colors whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            Добавить реплику
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-950/40 border border-red-900/60 rounded text-xs text-red-300">
          {error}
        </div>
      )}

      {rawTranscript && (
        <div className="bg-[#121826] border border-[#1F2937] rounded-lg p-4">
          <div className="text-xs font-medium text-slate-300 mb-1.5">
            Дословная расшифровка исходника
          </div>
          <pre className="text-xs text-slate-400 whitespace-pre-wrap font-sans leading-relaxed">
            {rawTranscript}
          </pre>
        </div>
      )}

      <div className="bg-[#121826] border border-[#1F2937] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#1F2937] text-[11px] font-medium text-slate-400">
                <th className="py-2.5 px-3 w-10">#</th>
                <th className="py-2.5 px-3 w-24">Начало, с</th>
                <th className="py-2.5 px-3 w-24">Конец, с</th>
                <th className="py-2.5 px-3">Строка 1 (до 34 симв.)</th>
                <th className="py-2.5 px-3">Строка 2 (необяз.)</th>
                <th className="py-2.5 px-3 w-12"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1F2937] text-xs">
              {subtitles.map((cue, idx) => {
                const line1Warn = cue.line1.length > 36;
                const line2Warn = cue.line2.length > 36;
                return (
                  <tr key={cue.id} className="hover:bg-[#161E2E]/60">
                    <td className="py-2 px-3 font-mono tabular-nums text-slate-500">
                      {idx + 1}
                    </td>
                    <td className="py-2 px-3">
                      <input
                        type="number"
                        step="0.1"
                        min={0}
                        value={cue.startSec}
                        onChange={(e) =>
                          updateCue(cue.id, { startSec: Math.max(0, Number(e.target.value)) })
                        }
                        className="w-20 px-2 py-1 font-mono tabular-nums bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200 focus:outline-none focus:border-slate-500"
                      />
                    </td>
                    <td className="py-2 px-3">
                      <input
                        type="number"
                        step="0.1"
                        min={0.1}
                        value={cue.endSec}
                        onChange={(e) =>
                          updateCue(cue.id, { endSec: Math.max(0.1, Number(e.target.value)) })
                        }
                        className="w-20 px-2 py-1 font-mono tabular-nums bg-[#0B0F17] border border-[#1F2937] rounded text-slate-200 focus:outline-none focus:border-slate-500"
                      />
                    </td>
                    <td className="py-2 px-3">
                      <input
                        type="text"
                        value={cue.line1}
                        onChange={(e) => updateCue(cue.id, { line1: e.target.value })}
                        placeholder="Первая строка субтитра"
                        className={`w-full px-2.5 py-1 bg-[#0B0F17] border rounded text-slate-100 focus:outline-none ${
                          line1Warn
                            ? 'border-amber-600 focus:border-amber-500'
                            : 'border-[#1F2937] focus:border-slate-500'
                        }`}
                      />
                    </td>
                    <td className="py-2 px-3">
                      <input
                        type="text"
                        value={cue.line2}
                        onChange={(e) => updateCue(cue.id, { line2: e.target.value })}
                        placeholder="Вторая строка (если нужна)"
                        className={`w-full px-2.5 py-1 bg-[#0B0F17] border rounded text-slate-100 focus:outline-none ${
                          line2Warn
                            ? 'border-amber-600 focus:border-amber-500'
                            : 'border-[#1F2937] focus:border-slate-500'
                        }`}
                      />
                    </td>
                    <td className="py-2 px-3 text-right">
                      <button
                        type="button"
                        onClick={() => removeCue(cue.id)}
                        className="p-1 text-slate-500 hover:text-red-400"
                        title="Удалить субтитр"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}

              {subtitles.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-500">
                    Список субтитров пуст. Нажмите «Добавить реплику» или «Распознать речь (Gemini)»
                    после загрузки видеофрагментов.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
