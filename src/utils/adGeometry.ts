import type { AdAssetInfo, AdOverlayLayer, SubtitleCue } from '../types.ts';

export const FRAME_WIDTH = 1080;
export const FRAME_HEIGHT = 1920;

export interface ComputedAdBox {
  widthPx: number;
  heightPx: number;
  xPx: number;
  yPx: number;
  leftPct: number;
  topPct: number;
  widthPct: number;
  heightPct: number;
  clampedToFrame: boolean;
}

export interface AdCollisionWarnings {
  overlapsSubtitles: boolean;
  overlapsFacesZone: boolean;
  overlapsShortsUi: boolean;
  messages: string[];
}

function makeEven(n: number): number {
  const rounded = Math.round(n);
  return Math.max(2, rounded % 2 === 0 ? rounded : rounded - 1);
}

export function computeAdOverlayBox(
  layer: AdOverlayLayer,
  asset: Pick<AdAssetInfo, 'width' | 'height'> | null | undefined,
): ComputedAdBox {
  const naturalW = Math.max(2, asset?.width || 400);
  const naturalH = Math.max(2, asset?.height || 200);
  const aspect = naturalW / naturalH;
  const scale = Math.min(2.5, Math.max(0.1, Number(layer.scale) || 1));

  let rawWidthPx =
    layer.sizeMode === 'percent'
      ? (Math.min(100, Math.max(5, Number(layer.widthValue) || 35)) / 100) * FRAME_WIDTH
      : Math.max(20, Number(layer.widthValue) || 320);

  rawWidthPx *= scale;

  let rawHeightPx: number;
  if (layer.preserveAspectRatio || !layer.heightValue || layer.heightValue <= 0) {
    rawHeightPx = rawWidthPx / aspect;
  } else {
    rawHeightPx =
      layer.sizeMode === 'percent'
        ? (Math.min(100, Math.max(5, Number(layer.heightValue))) / 100) * FRAME_HEIGHT * scale
        : Math.max(20, Number(layer.heightValue)) * scale;
  }

  let clampedToFrame = false;
  // Fit strictly within 1080x1920 while preserving aspect ratio when requested
  if (rawWidthPx > FRAME_WIDTH) {
    clampedToFrame = true;
    const ratio = FRAME_WIDTH / rawWidthPx;
    rawWidthPx = FRAME_WIDTH;
    if (layer.preserveAspectRatio) rawHeightPx *= ratio;
  }
  if (rawHeightPx > FRAME_HEIGHT) {
    clampedToFrame = true;
    const ratio = FRAME_HEIGHT / rawHeightPx;
    rawHeightPx = FRAME_HEIGHT;
    if (layer.preserveAspectRatio) rawWidthPx *= ratio;
  }

  const widthPx = Math.min(FRAME_WIDTH, makeEven(rawWidthPx));
  const heightPx = Math.min(FRAME_HEIGHT, makeEven(rawHeightPx));

  const marginX = Math.max(0, Math.min(480, Number(layer.marginXPx) || 0));
  const marginY = Math.max(0, Math.min(800, Number(layer.marginYPx) || 0));

  let rawX = 0;
  let rawY = 0;

  switch (layer.anchor) {
    case 'top-left':
      rawX = marginX;
      rawY = marginY;
      break;
    case 'top-center':
      rawX = (FRAME_WIDTH - widthPx) / 2;
      rawY = marginY;
      break;
    case 'top-right':
      rawX = FRAME_WIDTH - widthPx - marginX;
      rawY = marginY;
      break;
    case 'center-left':
      rawX = marginX;
      rawY = (FRAME_HEIGHT - heightPx) / 2;
      break;
    case 'center':
      rawX = (FRAME_WIDTH - widthPx) / 2;
      rawY = (FRAME_HEIGHT - heightPx) / 2;
      break;
    case 'center-right':
      rawX = FRAME_WIDTH - widthPx - marginX;
      rawY = (FRAME_HEIGHT - heightPx) / 2;
      break;
    case 'bottom-left':
      rawX = marginX;
      rawY = FRAME_HEIGHT - heightPx - marginY;
      break;
    case 'bottom-center':
      rawX = (FRAME_WIDTH - widthPx) / 2;
      rawY = FRAME_HEIGHT - heightPx - marginY;
      break;
    case 'bottom-right':
      rawX = FRAME_WIDTH - widthPx - marginX;
      rawY = FRAME_HEIGHT - heightPx - marginY;
      break;
    case 'custom': {
      const cx = Math.min(100, Math.max(0, Number(layer.customXPercent) || 50)) / 100;
      const cy = Math.min(100, Math.max(0, Number(layer.customYPercent) || 50)) / 100;
      rawX = cx * FRAME_WIDTH - widthPx / 2;
      rawY = cy * FRAME_HEIGHT - heightPx / 2;
      break;
    }
  }

  const maxX = Math.max(0, FRAME_WIDTH - widthPx);
  const maxY = Math.max(0, FRAME_HEIGHT - heightPx);

  if (rawX < 0 || rawX > maxX || rawY < 0 || rawY > maxY) {
    clampedToFrame = true;
  }

  const xPx = Math.round(Math.min(maxX, Math.max(0, rawX)));
  const yPx = Math.round(Math.min(maxY, Math.max(0, rawY)));

  return {
    widthPx,
    heightPx,
    xPx,
    yPx,
    leftPct: (xPx / FRAME_WIDTH) * 100,
    topPct: (yPx / FRAME_HEIGHT) * 100,
    widthPct: (widthPx / FRAME_WIDTH) * 100,
    heightPct: (heightPx / FRAME_HEIGHT) * 100,
    clampedToFrame,
  };
}

function rectsIntersect(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number },
): boolean {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

export function evaluateAdCollisions(
  layer: AdOverlayLayer,
  box: ComputedAdBox,
  subtitles: SubtitleCue[],
): AdCollisionWarnings {
  const adRect = {
    x1: box.xPx,
    y1: box.yPx,
    x2: box.xPx + box.widthPx,
    y2: box.yPx + box.heightPx,
  };

  // Subtitles in ASS: MarginV=330, FontSize=56 (2 lines -> approx y 1350..1620, x 100..980)
  const subtitleRect = { x1: 90, y1: 1330, x2: 990, y2: 1640 };
  const hasSubtitleOverlapInTime =
    subtitles.length === 0 ||
    subtitles.some((cue) => cue.startSec < layer.endSec && cue.endSec > layer.startSec);
  const overlapsSubtitles =
    hasSubtitleOverlapInTime && rectsIntersect(adRect, subtitleRect);

  // Typical face / portrait central band in vertical 9:16 crop: x 240..840, y 280..980
  const facesRect = { x1: 240, y1: 280, x2: 840, y2: 980 };
  const overlapsFacesZone = rectsIntersect(adRect, facesRect);

  // YouTube Shorts UI chrome zones: top 12% (0..230), bottom 17% (1594..1920), right 14% (928..1080)
  const topUi = { x1: 0, y1: 0, x2: FRAME_WIDTH, y2: Math.round(FRAME_HEIGHT * 0.12) };
  const bottomUi = { x1: 0, y1: Math.round(FRAME_HEIGHT * 0.83), x2: FRAME_WIDTH, y2: FRAME_HEIGHT };
  const rightUi = {
    x1: Math.round(FRAME_WIDTH * 0.86),
    y1: Math.round(FRAME_HEIGHT * 0.25),
    x2: FRAME_WIDTH,
    y2: Math.round(FRAME_HEIGHT * 0.83),
  };
  const overlapsShortsUi =
    rectsIntersect(adRect, topUi) ||
    rectsIntersect(adRect, bottomUi) ||
    rectsIntersect(adRect, rightUi);

  const messages: string[] = [];
  if (layer.avoidSubtitles && overlapsSubtitles) {
    messages.push(
      'Рекламная плашка пересекается с зоной субтитров (нижняя треть кадра, y 1330–1640 px).',
    );
  } else if (overlapsSubtitles) {
    messages.push('Плашка частично заходит в зону субтитров (ниже 69% высоты кадра).');
  }

  if (layer.avoidFaces && overlapsFacesZone) {
    messages.push(
      'Плашка заходит в центральную зону лиц (x 240–840, y 280–980 px). Сдвиньте её ближе к краю.',
    );
  }

  if (overlapsShortsUi) {
    messages.push(
      'Плашка заходит в опасную зону интерфейса YouTube Shorts (верх 12%, низ 17% или правый столбец 14%).',
    );
  }

  return {
    overlapsSubtitles,
    overlapsFacesZone,
    overlapsShortsUi,
    messages,
  };
}
