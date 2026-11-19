import { GoogleGenAI, Type } from '@google/genai';
import fs from 'node:fs';
import type { AspectRatioOption, ImageSizeOption, SubtitleCue } from '../types.ts';

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY не задан. Проверьте панель Settings > Secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export async function transcribeAudioToSubtitles(audioFilePath: string): Promise<{
  rawText: string;
  cues: SubtitleCue[];
}> {
  const ai = getGeminiClient();
  const audioBuffer = fs.readFileSync(audioFilePath);
  const base64Audio = audioBuffer.toString('base64');

  const transcribeResponse = await ai.models.generateContent({
    model: 'gemini-3.5-transcribe',
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: 'audio/mp3',
            data: base64Audio,
          },
        },
        {
          text: [
            'Дословно расшифруй русскую речь из аудиофрагмента.',
            'Строго сохраняй оригинальные слова, интонационную пунктуацию и порядок фраз.',
            'Не добавляй выдуманных слов и не перефразируй реплики.',
            'Если слышишь тайминги фраз, укажи их в формате [MM:SS.m - MM:SS.m] перед каждой репликой.',
          ].join(' '),
        },
      ],
    },
  });

  const rawText = (transcribeResponse.text ?? '').trim();
  if (!rawText) {
    return { rawText: '', cues: [] };
  }

  const formatResponse = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: [
      'Преобразуй следующую дословную расшифровку в массив субтитров.',
      'Правила:',
      '1. Не изменяй ни одного слова из расшифровки.',
      '2. В каждом субтитре максимум 2 короткие строки (line1 и line2, до 34 символов в строке).',
      '3. Сохраняй грамотную русскую пунктуацию.',
      '4. startSec и endSec указывай в секундах (числа), равномерно распределяя реплики если точный тайминг не указан.',
      '',
      rawText,
    ].join('\n'),
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            startSec: { type: Type.NUMBER },
            endSec: { type: Type.NUMBER },
            line1: { type: Type.STRING },
            line2: { type: Type.STRING },
          },
          required: ['startSec', 'endSec', 'line1', 'line2'],
        },
      },
    },
  });

  let parsed: Array<{ startSec: number; endSec: number; line1: string; line2: string }> = [];
  try {
    parsed = JSON.parse((formatResponse.text ?? '[]').trim());
  } catch {
    parsed = [];
  }

  const cues: SubtitleCue[] = parsed.map((item, idx) => ({
    id: `sub-${Date.now()}-${idx}`,
    startSec: Math.max(0, Number(item.startSec) || 0),
    endSec: Math.max((Number(item.startSec) || 0) + 0.5, Number(item.endSec) || 1),
    line1: String(item.line1 ?? '').slice(0, 42),
    line2: String(item.line2 ?? '').slice(0, 42),
  }));

  return { rawText, cues };
}

export async function generateCoverArtwork(params: {
  prompt: string;
  imageSize: ImageSizeOption;
  aspectRatio: AspectRatioOption;
}): Promise<{ imageDataUrl: string; modelText: string }> {
  const ai = getGeminiClient();

  const fullPrompt = [
    'Editorial documentary crime-archive cover artwork for a YouTube Shorts episode thumbnail.',
    'Restrained moody Soviet-era archival aesthetic, crisp film grain, subtle tungsten desk lamp shadows, dark slate background.',
    'No violent gore, no weapons, no blood, no fake text overlays.',
    params.prompt.trim(),
  ].join(' ');

  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-image-preview',
    contents: {
      parts: [{ text: fullPrompt }],
    },
    config: {
      imageConfig: {
        aspectRatio: params.aspectRatio,
        imageSize: params.imageSize,
      },
    },
  });

  let imageDataUrl = '';
  let modelText = '';

  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData?.data) {
      const mime = part.inlineData.mimeType ?? 'image/png';
      imageDataUrl = `data:${mime};base64,${part.inlineData.data}`;
    } else if (part.text) {
      modelText += part.text;
    }
  }

  if (!imageDataUrl) {
    throw new Error('Модель не вернула изображение. Попробуйте уточнить описание обложки.');
  }

  return { imageDataUrl, modelText: modelText.trim() };
}
