import type {
  CutSegment,
  MediaProbeInfo,
  SourceLibraryItem,
  SourceRole,
  SourceVideoMetadata,
  UploadedAsset,
} from '../types.ts';

export type LibrarySortMode = 'segment' | 'timestamp' | 'uploadedAt' | 'name';

export interface ResolvedSegmentAsset {
  key: string;
  sourceId?: string;
  sourceRole?: 'fragment8' | 'fragment9';
  fileName: string;
  originalName: string;
  url: string;
  filePath: string;
  probe: MediaProbeInfo;
  metadata?: SourceVideoMetadata;
}

export interface SeriesMappedRange {
  startSec: number;
  endSec: number;
  startTimecode: string;
  endTimecode: string;
  exceedsClipRange: boolean;
}

/**
 * Parses timecodes like:
 *  - "00.04.35.514" / "00:04:35.514" / "00:04:35,514"
 *  - "00.00.00" / "00:04:10"
 *  - "04:10" / "04:10.5"
 */
export function parseTimecodeStringToSec(raw: string | null | undefined): number | null {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(',', '.');
  if (!cleaned) return null;

  // HH.MM.SS.mmm or HH:MM:SS.mmm
  const hmsMs = /^(\d{1,3})[.:](\d{2})[.:](\d{2})[.:](\d{1,3})$/.exec(cleaned);
  if (hmsMs) {
    const h = Number(hmsMs[1]);
    const m = Number(hmsMs[2]);
    const s = Number(hmsMs[3]);
    const msStr = hmsMs[4].padEnd(3, '0').slice(0, 3);
    const ms = Number(msStr);
    if (m >= 60 || s >= 60) return null;
    return Number((h * 3600 + m * 60 + s + ms / 1000).toFixed(3));
  }

  // HH.MM.SS or HH:MM:SS
  const hms = /^(\d{1,3})[.:](\d{2})[.:](\d{2})$/.exec(cleaned);
  if (hms) {
    const h = Number(hms[1]);
    const m = Number(hms[2]);
    const s = Number(hms[3]);
    if (m >= 60 || s >= 60) return null;
    return h * 3600 + m * 60 + s;
  }

  // MM:SS or MM:SS.mmm
  const msOnly = /^(\d{1,3})[.:](\d{2})(?:\.(\d{1,3}))?$/.exec(cleaned);
  if (msOnly) {
    const m = Number(msOnly[1]);
    const s = Number(msOnly[2]);
    const ms = msOnly[3] ? Number(msOnly[3].padEnd(3, '0').slice(0, 3)) : 0;
    if (s >= 60) return null;
    return Number((m * 60 + s + ms / 1000).toFixed(3));
  }

  return null;
}

export function formatSecToSeriesTimecode(sec: number, includeMs = true): string {
  const clamped = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const totalMs = Math.round(clamped * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const base = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return includeMs ? `${base}.${String(ms).padStart(3, '0')}` : base;
}

export function normalizeTimecodeDisplay(raw: string | null | undefined): string | null {
  const sec = parseTimecodeStringToSec(raw);
  if (sec === null) return null;
  return formatSecToSeriesTimecode(sec, true);
}

/**
 * Parses filenames matching patterns such as:
 *   Следствие_вели_1_сезон_-_1_серия-00.00.00.000-00.04.35.514-seg01.mp4
 * Also gracefully handles underscores/spaces/colons and missing fields.
 */
export function parseSourceFilenameMetadata(originalName: string): SourceVideoMetadata {
  const base = originalName
    .trim()
    .replace(/\.[^.\/\\]+$/, '');

  // 1. Segment number: -seg01, _seg1, seg02, part03, фрагмент_04
  let segmentNumber: number | null = null;
  let working = base;
  const segMatch = /(?:^|[-_\s])(?:seg|part|фрагмент)[-_\s]?(\d{1,4})$/i.exec(working);
  if (segMatch) {
    segmentNumber = Number(segMatch[1]);
    working = working.slice(0, segMatch.index);
  } else {
    const anySegMatch = /[-_\s]seg(\d{1,4})(?:[-_\s]|$)/i.exec(working);
    if (anySegMatch) {
      segmentNumber = Number(anySegMatch[1]);
      working = (working.slice(0, anySegMatch.index) + working.slice(anySegMatch.index + anySegMatch[0].length)).trim();
    }
  }

  // 2. Time range: 00.00.00.000-00.04.35.514 or 00:00:00.000-00:04:35.514
  let originalStartTime: string | null = null;
  let originalEndTime: string | null = null;
  let originalStartSec: number | null = null;
  let originalEndSec: number | null = null;

  const timeRangeRegex =
    /(?:^|[-_\s])(\d{2}[.:]\d{2}[.:]\d{2}(?:[.,]\d{1,3})?)\s*[-–—]\s*(\d{2}[.:]\d{2}[.:]\d{2}(?:[.,]\d{1,3})?)(?=$|[-_\s])/;
  const timeMatch = timeRangeRegex.exec(working);
  if (timeMatch) {
    const startParsed = parseTimecodeStringToSec(timeMatch[1]);
    const endParsed = parseTimecodeStringToSec(timeMatch[2]);
    if (startParsed !== null && endParsed !== null) {
      originalStartSec = startParsed;
      originalEndSec = endParsed;
      originalStartTime = formatSecToSeriesTimecode(startParsed, true);
      originalEndTime = formatSecToSeriesTimecode(endParsed, true);
      working = working.slice(0, timeMatch.index) + working.slice(timeMatch.index + timeMatch[0].length);
    }
  }

  // 3. Season & Episode
  let season: number | null = null;
  let episode: number | null = null;
  let earliestMetaIndex = working.length;

  const seasonMatch = /(?:^|[-_\s])(\d{1,3})[-_\s]*(?:сезон|season|сез)(?=$|[-_\s])/i.exec(working);
  if (seasonMatch) {
    season = Number(seasonMatch[1]);
    earliestMetaIndex = Math.min(earliestMetaIndex, seasonMatch.index);
  }

  const episodeMatch = /(?:^|[-_\s])(\d{1,4})[-_\s]*(?:серия|episode|выпуск|сер)(?=$|[-_\s])/i.exec(working);
  if (episodeMatch) {
    episode = Number(episodeMatch[1]);
    earliestMetaIndex = Math.min(earliestMetaIndex, episodeMatch.index);
  }

  if (season === null && episode === null) {
    const seShortMatch = /(?:^|[-_\s])s(\d{1,3})[-_\s]*e(\d{1,4})(?=$|[-_\s])/i.exec(working);
    if (seShortMatch) {
      season = Number(seShortMatch[1]);
      episode = Number(seShortMatch[2]);
      earliestMetaIndex = Math.min(earliestMetaIndex, seShortMatch.index);
    }
  }

  const hasStructuredFields =
    season !== null ||
    episode !== null ||
    originalStartSec !== null ||
    segmentNumber !== null;

  let program = '';
  if (hasStructuredFields) {
    const rawProgram = working.slice(0, earliestMetaIndex);
    program = rawProgram
      .replace(/[-_]+$/g, '')
      .replace(/^[-_]+/g, '')
      .replace(/_+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return {
    program,
    season,
    episode,
    originalStartTime,
    originalEndTime,
    originalStartSec,
    originalEndSec,
    segmentNumber,
    isAutoParsed: hasStructuredFields,
  };
}

export function reconcileSourceMetadata(
  patch: Partial<SourceVideoMetadata>,
  current?: SourceVideoMetadata,
): SourceVideoMetadata {
  const base: SourceVideoMetadata = current ?? {
    program: '',
    season: null,
    episode: null,
    originalStartTime: null,
    originalEndTime: null,
    originalStartSec: null,
    originalEndSec: null,
    segmentNumber: null,
    isAutoParsed: false,
  };

  const nextProgram =
    patch.program !== undefined ? String(patch.program).trim().slice(0, 200) : base.program;

  const parseIntOrNull = (val: unknown, currentVal: number | null): number | null => {
    if (val === undefined) return currentVal;
    if (val === null || val === '') return null;
    const num = Number(val);
    if (!Number.isFinite(num) || num < 0) return currentVal;
    return Math.floor(num);
  };

  const nextSeason = parseIntOrNull(patch.season, base.season);
  const nextEpisode = parseIntOrNull(patch.episode, base.episode);
  const nextSegNum = parseIntOrNull(patch.segmentNumber, base.segmentNumber);

  let nextStartTime = base.originalStartTime;
  let nextStartSec = base.originalStartSec;
  if (patch.originalStartTime !== undefined) {
    if (!patch.originalStartTime || !String(patch.originalStartTime).trim()) {
      nextStartTime = null;
      nextStartSec = null;
    } else {
      const sec = parseTimecodeStringToSec(String(patch.originalStartTime));
      if (sec !== null) {
        nextStartSec = sec;
        nextStartTime = formatSecToSeriesTimecode(sec, true);
      }
    }
  } else if (patch.originalStartSec !== undefined) {
    if (patch.originalStartSec === null) {
      nextStartSec = null;
      nextStartTime = null;
    } else if (Number.isFinite(Number(patch.originalStartSec)) && Number(patch.originalStartSec) >= 0) {
      nextStartSec = Number(Number(patch.originalStartSec).toFixed(3));
      nextStartTime = formatSecToSeriesTimecode(nextStartSec, true);
    }
  }

  let nextEndTime = base.originalEndTime;
  let nextEndSec = base.originalEndSec;
  if (patch.originalEndTime !== undefined) {
    if (!patch.originalEndTime || !String(patch.originalEndTime).trim()) {
      nextEndTime = null;
      nextEndSec = null;
    } else {
      const sec = parseTimecodeStringToSec(String(patch.originalEndTime));
      if (sec !== null) {
        nextEndSec = sec;
        nextEndTime = formatSecToSeriesTimecode(sec, true);
      }
    }
  } else if (patch.originalEndSec !== undefined) {
    if (patch.originalEndSec === null) {
      nextEndSec = null;
      nextEndTime = null;
    } else if (Number.isFinite(Number(patch.originalEndSec)) && Number(patch.originalEndSec) >= 0) {
      nextEndSec = Number(Number(patch.originalEndSec).toFixed(3));
      nextEndTime = formatSecToSeriesTimecode(nextEndSec, true);
    }
  }

  return {
    program: nextProgram,
    season: nextSeason,
    episode: nextEpisode,
    originalStartTime: nextStartTime,
    originalEndTime: nextEndTime,
    originalStartSec: nextStartSec,
    originalEndSec: nextEndSec,
    segmentNumber: nextSegNum,
    isAutoParsed: patch.isAutoParsed ?? false,
  };
}

export function mapLocalRangeToOriginalSeries(
  metadata: SourceVideoMetadata | undefined,
  localStartSec: number,
  localEndSec: number,
): SeriesMappedRange | null {
  if (!metadata || metadata.originalStartSec === null || metadata.originalStartSec === undefined) {
    return null;
  }
  const safeStart = Math.max(0, Number(localStartSec) || 0);
  const safeEnd = Math.max(safeStart, Number(localEndSec) || 0);
  const startSec = Number((metadata.originalStartSec + safeStart).toFixed(3));
  const endSec = Number((metadata.originalStartSec + safeEnd).toFixed(3));
  const exceedsClipRange =
    metadata.originalEndSec !== null &&
    metadata.originalEndSec !== undefined &&
    endSec > metadata.originalEndSec + 0.5;

  return {
    startSec,
    endSec,
    startTimecode: formatSecToSeriesTimecode(startSec, false),
    endTimecode: formatSecToSeriesTimecode(endSec, false),
    exceedsClipRange,
  };
}

function compareNullableNumAsc(a: number | null | undefined, b: number | null | undefined): number {
  const aHas = typeof a === 'number' && Number.isFinite(a);
  const bHas = typeof b === 'number' && Number.isFinite(b);
  if (aHas && bHas) return a - b;
  if (aHas) return -1;
  if (bHas) return 1;
  return 0;
}

export function sortLibrarySources(
  items: SourceLibraryItem[],
  mode: LibrarySortMode = 'segment',
): SourceLibraryItem[] {
  const copy = [...items];
  copy.sort((a, b) => {
    if (mode === 'uploadedAt') {
      return b.uploadedAt.localeCompare(a.uploadedAt);
    }
    if (mode === 'name') {
      return a.originalName.localeCompare(b.originalName, 'ru');
    }

    const progA = (a.metadata.program || '').toLowerCase();
    const progB = (b.metadata.program || '').toLowerCase();
    if (progA !== progB) {
      if (!progA) return 1;
      if (!progB) return -1;
      return progA.localeCompare(progB, 'ru');
    }

    const seasonCmp = compareNullableNumAsc(a.metadata.season, b.metadata.season);
    if (seasonCmp !== 0) return seasonCmp;

    const epCmp = compareNullableNumAsc(a.metadata.episode, b.metadata.episode);
    if (epCmp !== 0) return epCmp;

    if (mode === 'timestamp') {
      const tsCmp = compareNullableNumAsc(a.metadata.originalStartSec, b.metadata.originalStartSec);
      if (tsCmp !== 0) return tsCmp;
      const segCmp = compareNullableNumAsc(a.metadata.segmentNumber, b.metadata.segmentNumber);
      if (segCmp !== 0) return segCmp;
    } else {
      const segCmp = compareNullableNumAsc(a.metadata.segmentNumber, b.metadata.segmentNumber);
      if (segCmp !== 0) return segCmp;
      const tsCmp = compareNullableNumAsc(a.metadata.originalStartSec, b.metadata.originalStartSec);
      if (tsCmp !== 0) return tsCmp;
    }

    return a.originalName.localeCompare(b.originalName, 'ru');
  });
  return copy;
}

export function formatEpisodeLabel(meta: SourceVideoMetadata): string {
  const parts: string[] = [];
  if (meta.program) parts.push(meta.program);
  if (meta.season !== null) parts.push(`${meta.season} сезон`);
  if (meta.episode !== null) parts.push(`${meta.episode} серия`);
  return parts.length > 0 ? parts.join(' · ') : 'Без серии / произвольные файлы';
}

export function formatSourceOptionLabel(item: SourceLibraryItem): string {
  const segTag =
    item.metadata.segmentNumber !== null
      ? `seg${String(item.metadata.segmentNumber).padStart(2, '0')}`
      : null;
  const rangeTag =
    item.metadata.originalStartSec !== null && item.metadata.originalEndSec !== null
      ? `${formatSecToSeriesTimecode(item.metadata.originalStartSec, false)}–${formatSecToSeriesTimecode(item.metadata.originalEndSec, false)}`
      : null;
  const metaPrefix = [segTag, rangeTag].filter(Boolean).join(' · ');
  const durTag = `${item.probe.durationSec.toFixed(1)} с`;
  return metaPrefix
    ? `[${metaPrefix}] ${item.originalName} (${durTag})`
    : `${item.originalName} (${durTag})`;
}

export function resolveSegmentMediaAsset(
  seg: Pick<CutSegment, 'sourceId' | 'sourceRole'>,
  libraryItems: SourceLibraryItem[] = [],
  uploadedAssets: Partial<Record<SourceRole, UploadedAsset>> = {},
): ResolvedSegmentAsset | null {
  if (seg.sourceId) {
    const found = libraryItems.find((item) => item.id === seg.sourceId);
    if (!found) return null;
    return {
      key: `lib:${found.id}:${found.fileName}`,
      sourceId: found.id,
      sourceRole: found.legacyRole,
      fileName: found.fileName,
      originalName: found.originalName,
      url: found.url,
      filePath: found.filePath,
      probe: found.probe,
      metadata: found.metadata,
    };
  }

  if (seg.sourceRole) {
    const legacyUploaded = uploadedAssets[seg.sourceRole];
    if (legacyUploaded) {
      const matchingLib = libraryItems.find(
        (item) => item.filePath === legacyUploaded.filePath || item.legacyRole === seg.sourceRole,
      );
      return {
        key: `role:${seg.sourceRole}:${legacyUploaded.fileName}`,
        sourceId: matchingLib?.id,
        sourceRole: seg.sourceRole,
        fileName: legacyUploaded.fileName,
        originalName: legacyUploaded.originalName,
        url: legacyUploaded.url,
        filePath: legacyUploaded.filePath,
        probe: legacyUploaded.probe,
        metadata: matchingLib?.metadata,
      };
    }

    const fallbackLib = libraryItems.find((item) => item.legacyRole === seg.sourceRole);
    if (fallbackLib) {
      return {
        key: `lib:${fallbackLib.id}:${fallbackLib.fileName}`,
        sourceId: fallbackLib.id,
        sourceRole: fallbackLib.legacyRole,
        fileName: fallbackLib.fileName,
        originalName: fallbackLib.originalName,
        url: fallbackLib.url,
        filePath: fallbackLib.filePath,
        probe: fallbackLib.probe,
        metadata: fallbackLib.metadata,
      };
    }
  }

  return null;
}
