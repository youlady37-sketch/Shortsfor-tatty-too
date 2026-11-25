export const DEFAULT_SHORT_NUMBER = 1;
export const MIN_SHORT_NUMBER = 1;
export const MAX_SHORT_NUMBER = 9999;

export interface ExportJobNamingContext {
  shortNumber?: number;
  result?: {
    shortNumber?: number;
    versionA?: { fileName?: string };
    versionB?: { fileName?: string };
  };
}

/**
 * Normalizes a production Shorts number into a safe positive integer (1..9999).
 * Accepts numbers or numeric strings (optionally prefixed with "№" or "#").
 * Invalid or out-of-range inputs fall back cleanly without throwing.
 */
export function normalizeShortNumber(
  input: unknown,
  fallback: number = DEFAULT_SHORT_NUMBER,
): number {
  const safeFallback =
    typeof fallback === 'number' &&
    Number.isInteger(fallback) &&
    fallback >= MIN_SHORT_NUMBER &&
    fallback <= MAX_SHORT_NUMBER
      ? fallback
      : DEFAULT_SHORT_NUMBER;

  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return safeFallback;
    const truncated = Math.trunc(input);
    if (truncated < MIN_SHORT_NUMBER || truncated > MAX_SHORT_NUMBER) {
      return safeFallback;
    }
    return truncated;
  }

  if (typeof input === 'string') {
    const match = /^\s*(?:№|#)?\s*0*(\d{1,4})\s*$/.exec(input);
    if (!match) return safeFallback;
    const parsed = Number.parseInt(match[1], 10);
    if (!Number.isFinite(parsed) || parsed < MIN_SHORT_NUMBER || parsed > MAX_SHORT_NUMBER) {
      return safeFallback;
    }
    return parsed;
  }

  return safeFallback;
}

/**
 * Formats a production Shorts number as a zero-padded segment (at least 2 digits: 01..09, 24, 105).
 */
export function formatShortNumberSegment(
  shortNumber: unknown,
  fallback: number = DEFAULT_SHORT_NUMBER,
): string {
  const normalized = normalizeShortNumber(shortNumber, fallback);
  return String(normalized).padStart(2, '0');
}

export function buildShortExportFileName(
  shortNumber: unknown,
  version: 'A' | 'B',
  fallback: number = DEFAULT_SHORT_NUMBER,
): string {
  const numSegment = formatShortNumberSegment(shortNumber, fallback);
  return `delo_v_kadre_short_${numSegment}_version_${version}.mp4`;
}

export function buildShortExportFileNames(
  shortNumber: unknown,
  fallback: number = DEFAULT_SHORT_NUMBER,
): { versionA: string; versionB: string } {
  return {
    versionA: buildShortExportFileName(shortNumber, 'A', fallback),
    versionB: buildShortExportFileName(shortNumber, 'B', fallback),
  };
}

const SAFE_SHORT_FILENAME_REGEX = /^delo_v_kadre_short_\d{2,4}_version_[AB]\.mp4$/;

export function resolveExportDownloadFileName(params: {
  file: 'version_a.mp4' | 'version_b.mp4';
  jobStatus?: ExportJobNamingContext | null;
  fallbackShortNumber?: number;
}): string {
  const version: 'A' | 'B' = params.file === 'version_a.mp4' ? 'A' : 'B';
  const fallback = params.fallbackShortNumber ?? DEFAULT_SHORT_NUMBER;
  const recordedName =
    version === 'A'
      ? params.jobStatus?.result?.versionA?.fileName
      : params.jobStatus?.result?.versionB?.fileName;

  if (
    typeof recordedName === 'string' &&
    SAFE_SHORT_FILENAME_REGEX.test(recordedName) &&
    recordedName.endsWith(`_version_${version}.mp4`)
  ) {
    return recordedName;
  }

  const effectiveShortNumber =
    params.jobStatus?.result?.shortNumber ?? params.jobStatus?.shortNumber ?? fallback;

  return buildShortExportFileName(effectiveShortNumber, version, fallback);
}
