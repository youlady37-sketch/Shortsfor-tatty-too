import type {
  AdAnchor,
  AdGifBehavior,
  AdOverlayLayer,
  AdPromptParseResult,
  AdSizeUnit,
} from '../types.ts';

function parseTimeToken(raw: string): number | null {
  const clean = raw.trim().replace(',', '.');
  const mmss = /^(\d{1,2}):(\d{2}(?:\.\d+)?)$/.exec(clean);
  if (mmss) {
    const mins = Number(mmss[1]);
    const secs = Number(mmss[2]);
    if (Number.isFinite(mins) && Number.isFinite(secs) && secs < 60) {
      return Number((mins * 60 + secs).toFixed(2));
    }
    return null;
  }
  const num = Number(clean);
  return Number.isFinite(num) && num >= 0 ? Number(num.toFixed(2)) : null;
}

export function parseAdvertiserPrompt(
  promptText: string,
  options: {
    mainDurationSec: number;
    endplateDurationSec: number;
    currentLayer: AdOverlayLayer;
  },
): AdPromptParseResult {
  const raw = promptText.trim();
  const lower = raw.toLowerCase();
  const extracted: Partial<AdOverlayLayer> = {};
  const summary: string[] = [];
  const conflicts: string[] = [];
  const missingParams: string[] = [];
  const warnings: string[] = [];

  if (!raw) {
    return {
      extractedParams: {},
      extractedSummary: [],
      conflicts: [],
      missingParams: ['Введите текст инструкции рекламодателя для разбора.'],
      warnings: [],
      parsedAt: new Date().toISOString(),
    };
  }

  // 1. Time interval & duration
  let foundStart: number | null = null;
  let foundEnd: number | null = null;
  let foundDuration: number | null = null;

  const rangeMatch =
    /(?:с|от|from)\s*(\d{1,2}:\d{2}(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s*(?:с|сек|секунд[ыу]?|s)?\s*(?:до|по|to|-|–|—)\s*(\d{1,2}:\d{2}(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s*(?:с|сек|секунд[ыу]?|s)?/i.exec(
      lower,
    ) ||
    /(\d{1,2}:\d{2}(?:[.,]\d+)?)\s*(?:-|–|—)\s*(\d{1,2}:\d{2}(?:[.,]\d+)?)/i.exec(lower);

  if (rangeMatch) {
    foundStart = parseTimeToken(rangeMatch[1]);
    foundEnd = parseTimeToken(rangeMatch[2]);
  } else {
    const startOnlyMatch =
      /(?:начин[а-яё]*|старт[а-яё]*|показ[а-яё]*\s+с|появля[а-яё]*\s+(?:на|с)|start\s*(?:at)?|на)\s*(\d{1,2}:\d{2}(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s*(?:с|сек|секунд[еу]?|s)\b/i.exec(
        lower,
      );
    if (startOnlyMatch) {
      foundStart = parseTimeToken(startOnlyMatch[1]);
    }
  }

  const durationMatch =
    /(?:длительн[а-яё]*|продолжительн[а-яё]*|на\s+протяжении|на|duration|for)\s*(\d+(?:[.,]\d+)?)\s*(?:с|сек|секунд[ыу]?|s)(?![а-яёa-z])/i.exec(
      lower,
    );
  if (durationMatch && !(rangeMatch && durationMatch.index === rangeMatch.index)) {
    const d = Number(durationMatch[1].replace(',', '.'));
    if (Number.isFinite(d) && d > 0) {
      foundDuration = Number(d.toFixed(2));
    }
  }

  if (foundStart !== null && foundEnd !== null) {
    if (foundDuration !== null && Math.abs(foundEnd - foundStart - foundDuration) > 0.35) {
      conflicts.push(
        `Указан интервал ${foundStart}–${foundEnd} с (${(foundEnd - foundStart).toFixed(1)} с) и отдельная длительность ${foundDuration} с — уточните итоговое время вручную.`,
      );
    }
    if (foundEnd <= foundStart) {
      conflicts.push(
        `Конец показа (${foundEnd} с) не может быть меньше или равен началу (${foundStart} с).`,
      );
    } else {
      extracted.startSec = foundStart;
      extracted.endSec = foundEnd;
      summary.push(`Интервал показа: ${foundStart.toFixed(1)}–${foundEnd.toFixed(1)} с`);
    }
  } else if (foundStart !== null && foundDuration !== null) {
    extracted.startSec = foundStart;
    extracted.endSec = Number((foundStart + foundDuration).toFixed(2));
    summary.push(
      `Интервал показа: ${foundStart.toFixed(1)}–${extracted.endSec.toFixed(1)} с (${foundDuration} с)`,
    );
  } else if (foundStart !== null) {
    extracted.startSec = foundStart;
    missingParams.push('Не указана длительность или время окончания показа.');
    summary.push(`Старт показа: ${foundStart.toFixed(1)} с`);
  } else if (foundDuration !== null) {
    const startBase = options.currentLayer.startSec ?? 2;
    extracted.startSec = startBase;
    extracted.endSec = Number((startBase + foundDuration).toFixed(2));
    missingParams.push('Не указана секунда начала показа (взято текущее значение).');
    summary.push(`Длительность показа: ${foundDuration} с`);
  } else {
    missingParams.push('Не указан временной интервал показа (например: «с 5 до 15 сек»).');
  }

  // 2. Endplate rule (STRICT: disabled by default unless explicitly requested)
  const explicitNoEndplate =
    /(?:не\s+показыва[а-яё]*|без|убрать|не\s+добавля[а-яё]*|исключ[а-яё]*)[^.!?\n]{0,30}(?:заставк|финал|концовк|endplate)/i.test(
      lower,
    );
  const explicitEndplate =
    !explicitNoEndplate &&
    /(?:на\s+(?:финальн[а-яё]*\s+)?заставк|показывать\s+(?:и\s+)?на\s+заставк|в\s+концовк|allowOnEndplate|on\s+endplate)/i.test(
      lower,
    );

  if (explicitEndplate) {
    extracted.allowOnEndplate = true;
    summary.push('Отображение на финальной заставке: явно разрешено');
  } else if (explicitNoEndplate) {
    extracted.allowOnEndplate = false;
    summary.push('Отображение на финальной заставке: отключено');
  } else {
    extracted.allowOnEndplate = false;
  }

  // 3. Position / Anchor & directional conflicts
  const hasTop = /(?:сверху|вверху|верхн|top)/i.test(lower);
  const hasBottom = /(?:снизу|внизу|нижн|bottom)/i.test(lower);
  const hasLeft = /(?:слева|лев[а-яё]*|left)/i.test(lower);
  const hasRight = /(?:справа|прав[а-яё]*|right)/i.test(lower);
  const hasCenter = /(?:по\s*центру|в\s*центре|center|середин)/i.test(lower);
  const aboveSubtitles = /(?:над\s+субтитр|выше\s+субтитр)/i.test(lower);

  if (hasTop && hasBottom) {
    conflicts.push('В промпте одновременно указаны верхнее и нижнее расположение плашки.');
  }
  if (hasLeft && hasRight) {
    conflicts.push('В промпте одновременно указаны левая и правая стороны кадра.');
  }

  let detectedAnchor: AdAnchor | null = null;
  if (aboveSubtitles) {
    detectedAnchor = 'custom';
    extracted.customXPercent = 50;
    extracted.customYPercent = 60;
    summary.push('Позиция: над зоной субтитров (50% X, 60% Y)');
  } else if (hasTop && hasLeft && !hasRight && !hasBottom) {
    detectedAnchor = 'top-left';
  } else if (hasTop && hasRight && !hasLeft && !hasBottom) {
    detectedAnchor = 'top-right';
  } else if (hasTop && !hasBottom) {
    detectedAnchor = 'top-center';
  } else if (hasBottom && hasLeft && !hasRight && !hasTop) {
    detectedAnchor = 'bottom-left';
  } else if (hasBottom && hasRight && !hasLeft && !hasTop) {
    detectedAnchor = 'bottom-right';
  } else if (hasBottom && !hasTop) {
    detectedAnchor = 'bottom-center';
  } else if (hasLeft && !hasRight) {
    detectedAnchor = 'center-left';
  } else if (hasRight && !hasLeft) {
    detectedAnchor = 'center-right';
  } else if (hasCenter) {
    detectedAnchor = 'center';
  }

  if (detectedAnchor) {
    extracted.anchor = detectedAnchor;
    if (!aboveSubtitles) {
      const anchorLabels: Record<AdAnchor, string> = {
        'top-left': 'Верхний левый угол',
        'top-center': 'Сверху по центру',
        'top-right': 'Верхний правый угол',
        'center-left': 'Слева по центру',
        center: 'По центру экрана',
        'center-right': 'Справа по центру',
        'bottom-left': 'Нижний левый угол',
        'bottom-center': 'Снизу по центру',
        'bottom-right': 'Нижний правый угол',
        custom: 'Пользовательская позиция',
      };
      summary.push(`Позиция: ${anchorLabels[detectedAnchor]}`);
    }
  } else {
    missingParams.push('Не указана позиция на экране (например: «сверху по центру» или «нижний левый угол»).');
  }

  // 4. Size (% or px, WxH)
  const wxhMatch = /(\d{2,4})\s*[xх×]\s*(\d{2,4})\s*(?:px|пикс)?/i.exec(lower);
  const widthPctMatch =
    /(?:ширин[а-яё]*|размер[а-яё]*|width)\s*(?::|=|около|примерно)?\s*(\d{1,3}(?:[.,]\d+)?)\s*%/i.exec(lower) ||
    /(\d{1,3}(?:[.,]\d+)?)\s*%\s*(?:ширин|экрана|кадра)/i.exec(lower);
  const widthPxMatch =
    /(?:ширин[а-яё]*|width)\s*(?::|=|около)?\s*(\d{2,4})\s*(?:px|пикс)/i.exec(lower);
  const heightPxMatch =
    /(?:высот[а-яё]*|height)\s*(?::|=|около)?\s*(\d{2,4})\s*(?:px|пикс)/i.exec(lower);

  if (wxhMatch) {
    const w = Number(wxhMatch[1]);
    const h = Number(wxhMatch[2]);
    extracted.sizeMode = 'px';
    extracted.widthValue = Math.max(20, Math.min(1080, w));
    extracted.heightValue = Math.max(20, Math.min(1920, h));
    extracted.preserveAspectRatio = false;
    summary.push(`Размер: ${extracted.widthValue}×${extracted.heightValue} px (без авто-пропорций)`);
    warnings.push('Заданы точные W×H — проверьте, сохраняются ли пропорции исходного баннера.');
  } else if (widthPctMatch) {
    const pct = Number(widthPctMatch[1].replace(',', '.'));
    extracted.sizeMode = 'percent' as AdSizeUnit;
    extracted.widthValue = Math.min(100, Math.max(5, pct));
    extracted.preserveAspectRatio = true;
    summary.push(`Ширина: ${extracted.widthValue}% от ширины кадра`);
  } else if (widthPxMatch) {
    const px = Number(widthPxMatch[1]);
    extracted.sizeMode = 'px';
    extracted.widthValue = Math.min(1080, Math.max(20, px));
    if (heightPxMatch) {
      extracted.heightValue = Math.min(1920, Math.max(20, Number(heightPxMatch[1])));
      extracted.preserveAspectRatio = false;
      summary.push(`Размер: ${extracted.widthValue}×${extracted.heightValue} px`);
    } else {
      extracted.heightValue = null;
      extracted.preserveAspectRatio = true;
      summary.push(`Ширина: ${extracted.widthValue} px (пропорционально)`);
    }
  } else {
    missingParams.push('Не указан размер плашки (в % ширины экрана или в пикселях).');
  }

  // 5. Margins
  const marginMatch =
    /(?:отступ[а-яё]*|margin[a-z]*|от\s+кра[а-яё]*)\s*(?::|=)?\s*(\d{1,3})\s*(?:px|пикс)?/i.exec(lower);
  if (marginMatch) {
    const m = Math.min(400, Math.max(0, Number(marginMatch[1])));
    extracted.marginXPx = m;
    extracted.marginYPx = m;
    summary.push(`Отступ от краёв: ${m} px`);
  }

  // 6. Scale
  const scaleMatch = /(?:масштаб[а-яё]*|scale)\s*(?::|=)?\s*(\d+(?:[.,]\d+)?)\s*(%)?/i.exec(lower);
  if (scaleMatch) {
    const val = Number(scaleMatch[1].replace(',', '.'));
    const normalized = scaleMatch[2] ? val / 100 : val > 3 ? val / 100 : val;
    if (Number.isFinite(normalized) && normalized > 0) {
      extracted.scale = Number(Math.min(2.5, Math.max(0.1, normalized)).toFixed(2));
      summary.push(`Масштаб: ${extracted.scale}×`);
    }
  }

  // 7. Opacity
  const opacityMatch =
    /(?:непрозрачн[а-яё]*|прозрачн[а-яё]*|opacity)\s*(?::|=)?\s*(\d{1,3})\s*%?/i.exec(lower);
  if (opacityMatch) {
    const pct = Math.min(100, Math.max(5, Number(opacityMatch[1])));
    extracted.opacity = Number((pct / 100).toFixed(2));
    summary.push(`Непрозрачность: ${pct}%`);
  } else if (/полупрозрач/i.test(lower)) {
    extracted.opacity = 0.75;
    summary.push('Непрозрачность: 75% (полупрозрачная)');
  }

  // 8. Fade in/out animation
  const noFade = /без\s+(?:анимац|плавн|fade)/i.test(lower);
  const fadeInMatch =
    /(?:появлен[а-яё]*|fade\s*in|вход)\s*(?::|=)?\s*(\d+(?:[.,]\d+)?)\s*(?:с|сек|s)?/i.exec(lower);
  const fadeOutMatch =
    /(?:исчезновен[а-яё]*|затухан[а-яё]*|fade\s*out|выход)\s*(?::|=)?\s*(\d+(?:[.,]\d+)?)\s*(?:с|сек|s)?/i.exec(
      lower,
    );
  const generalFadeMatch =
    /(?:плавн[а-яё]*|fade)\s*(?:появлен[а-яё]*\s+и\s+исчезновен[а-яё]*)?\s*(?::|=)?\s*(\d+(?:[.,]\d+)?)\s*(?:с|сек|s)/i.exec(
      lower,
    );

  if (noFade) {
    extracted.fadeInSec = 0;
    extracted.fadeOutSec = 0;
    summary.push('Анимация: мгновенное появление/скрытие (0 с)');
  } else {
    if (fadeInMatch) {
      extracted.fadeInSec = Math.min(3, Math.max(0, Number(fadeInMatch[1].replace(',', '.'))));
    }
    if (fadeOutMatch) {
      extracted.fadeOutSec = Math.min(3, Math.max(0, Number(fadeOutMatch[1].replace(',', '.'))));
    }
    if (!fadeInMatch && !fadeOutMatch && generalFadeMatch) {
      const f = Math.min(3, Math.max(0, Number(generalFadeMatch[1].replace(',', '.'))));
      extracted.fadeInSec = f;
      extracted.fadeOutSec = f;
    } else if (!fadeInMatch && !fadeOutMatch && /плавн/i.test(lower)) {
      extracted.fadeInSec = 0.35;
      extracted.fadeOutSec = 0.35;
    }
    if (extracted.fadeInSec !== undefined || extracted.fadeOutSec !== undefined) {
      summary.push(
        `Анимация fade: вход ${(extracted.fadeInSec ?? options.currentLayer.fadeInSec).toFixed(2)} с, выход ${(extracted.fadeOutSec ?? options.currentLayer.fadeOutSec).toFixed(2)} с`,
      );
    }
  }

  // 9. Aspect ratio
  if (/сохран[а-яё]*\s+пропорц|keep\s*aspect|preserve\s*aspect/i.test(lower)) {
    extracted.preserveAspectRatio = true;
    summary.push('Пропорции: сохранять строго');
  }

  // 10. GIF playback behavior
  let gifBehavior: AdGifBehavior | undefined;
  if (/зацикл|loop|повторя[а-яё]*\s+gif/i.test(lower)) {
    gifBehavior = 'loop';
    summary.push('GIF-поведение: зацикливание (loop)');
  } else if (/останов[а-яё]*\s+на\s+последн|зафиксир[а-яё]*\s+последн|freeze/i.test(lower)) {
    gifBehavior = 'freeze';
    summary.push('GIF-поведение: фиксация на последнем кадре');
  } else if (/один\s+раз|однократ|скрыть\s+после|stop\s+after/i.test(lower)) {
    gifBehavior = 'stop';
    summary.push('GIF-поведение: один цикл и скрытие');
  }
  if (gifBehavior) {
    extracted.gifBehavior = gifBehavior;
  }

  // 11. Subtitle & face protection rules + explicit conflict checks
  const avoidSubtitles =
    /не\s+(?:перекрыв[а-яё]*|закрыв[а-яё]*)[^.!?\n]{0,25}субтитр/i.test(lower) ||
    /без\s+перекрыт[а-яё]*\s+субтитр/i.test(lower);
  const avoidFaces =
    /не\s+(?:перекрыв[а-яё]*|закрыв[а-яё]*)[^.!?\n]{0,25}лиц/i.test(lower) ||
    /не\s+заслоня[а-яё]*\s+лиц/i.test(lower);

  if (avoidSubtitles) {
    extracted.avoidSubtitles = true;
    summary.push('Защита субтитров: включена');
    if (
      extracted.anchor &&
      ['bottom-left', 'bottom-center', 'bottom-right'].includes(extracted.anchor)
    ) {
      conflicts.push(
        'Конфликт требований: указано «не перекрывать субтитры», но выбрана нижняя позиция кадра (где проходят субтитры). Скорректируйте позицию или используйте «над субтитрами».',
      );
    }
  }

  if (avoidFaces) {
    extracted.avoidFaces = true;
    summary.push('Защита лиц: включена');
    if (
      extracted.anchor &&
      ['center', 'center-left', 'center-right'].includes(extracted.anchor)
    ) {
      conflicts.push(
        'Конфликт требований: указано «не перекрывать лица», но выбрана центральная зона кадра.',
      );
    }
  }

  // 12. Check mainDuration vs endplate boundary
  const effectiveEnd = extracted.endSec ?? options.currentLayer.endSec;
  const effectiveAllowEndplate = extracted.allowOnEndplate ?? options.currentLayer.allowOnEndplate;
  if (!effectiveAllowEndplate && options.mainDurationSec > 0 && effectiveEnd > options.mainDurationSec) {
    warnings.push(
      `Время окончания (${effectiveEnd.toFixed(1)} с) выходит за пределы основного ролика (${options.mainDurationSec.toFixed(1)} с). Поскольку показ на заставке не запрошен, слой будет ограничен концом основного монтажа.`,
    );
  }
  if (
    effectiveAllowEndplate &&
    options.mainDurationSec > 0 &&
    effectiveEnd > options.mainDurationSec + options.endplateDurationSec
  ) {
    warnings.push(
      `Время окончания (${effectiveEnd.toFixed(1)} с) превышает общую длину ролика с заставкой (${(options.mainDurationSec + options.endplateDurationSec).toFixed(1)} с).`,
    );
  }

  return {
    extractedParams: extracted,
    extractedSummary: summary,
    conflicts,
    missingParams,
    warnings,
    parsedAt: new Date().toISOString(),
  };
}
