export type SourceRole = 'fragment8' | 'fragment9' | 'music' | 'endplate' | 'audioLogo';

export interface MediaProbeInfo {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
  sizeBytes: number;
}

export interface UploadedAsset {
  role: SourceRole;
  fileName: string;
  originalName: string;
  url: string;
  filePath: string;
  probe: MediaProbeInfo;
  warnings: string[];
}

export type PreloadedCategory =
  | 'endplate'
  | 'title-card'
  | 'overlay'
  | 'rubric-marker'
  | 'rubric-title'
  | 'subtitle-ref'
  | 'brand-logo'
  | 'audio';

export type OverlayPlacementMode =
  | 'full-frame'
  | 'top-left-badge'
  | 'top-center-logo'
  | 'bottom-center-subtitle';

export interface PreloadedOverlay {
  id: string;
  fileName: string;
  label: string;
  url: string;
  kind: 'image' | 'audio';
  category?: PreloadedCategory;
  hasAlpha?: boolean;
  overlayPlacement?: OverlayPlacementMode;
  width?: number;
  height?: number;
  durationSec?: number;
  note: string;
}

export interface CutSegment {
  id: string;
  sourceRole: 'fragment8' | 'fragment9';
  beatTitle: string;
  startSec: number;
  endSec: number;
  cropOffsetX: number; // -100 (left) to 100 (right)
  overlayId: string | null;
}

export interface SubtitleCue {
  id: string;
  startSec: number;
  endSec: number;
  line1: string;
  line2: string;
}

export type AdFormat = 'png' | 'jpg' | 'webp' | 'gif';
export type AdAudioFormat = 'mp3' | 'wav' | 'aac' | 'm4a' | 'ogg';
export type AdGifBehavior = 'loop' | 'freeze' | 'stop';
export type AdSizeUnit = 'percent' | 'px';
export type AdAnchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'
  | 'custom';

export interface AdAssetInfo {
  id: string;
  fileName: string;
  originalName: string;
  mimeType: string;
  format: AdFormat;
  url: string;
  filePath: string;
  width: number;
  height: number;
  durationSec: number;
  isAnimatedGif: boolean;
  frameCount: number;
  hasAlpha: boolean;
  sizeBytes: number;
  uploadedAt: string;
}

export interface AdAudioAssetInfo {
  id: string;
  fileName: string;
  originalName: string;
  mimeType: string;
  format: AdAudioFormat;
  url: string;
  filePath: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
  audioCodec: string | null;
  sizeBytes: number;
  uploadedAt: string;
}

export interface AdAudioLayerConfig {
  enabled: boolean;
  audioAssetId: string | null;
  startSec: number;
  durationSec: number | null;
  trimStartSec: number;
  trimEndSec: number | null;
  volumeDb: number;
  fadeInSec: number;
  fadeOutSec: number;
}

export interface AdOverlayLayer {
  id: string;
  name: string;
  enabled: boolean;
  confirmed: boolean;
  adAssetId: string;
  promptText: string;
  startSec: number;
  endSec: number;
  anchor: AdAnchor;
  customXPercent: number;
  customYPercent: number;
  sizeMode: AdSizeUnit;
  widthValue: number;
  heightValue: number | null;
  preserveAspectRatio: boolean;
  marginXPx: number;
  marginYPx: number;
  scale: number;
  opacity: number;
  fadeInSec: number;
  fadeOutSec: number;
  gifBehavior: AdGifBehavior;
  avoidSubtitles: boolean;
  avoidFaces: boolean;
  allowOnEndplate: boolean;
  audio?: AdAudioLayerConfig;
  updatedAt: string;
}

export interface AdPromptParseResult {
  extractedParams: Partial<AdOverlayLayer>;
  extractedSummary: string[];
  conflicts: string[];
  missingParams: string[];
  warnings: string[];
  parsedAt: string;
}

export type AdPresetAudioSettings = Omit<AdAudioLayerConfig, 'audioAssetId'>;

export interface AdPreset {
  id: string;
  name: string;
  advertiserName?: string;
  requirementsTemplate?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  adAssetId?: string | null;
  assetSnapshot?: AdAssetInfo | null;
  layerConfig: Omit<AdOverlayLayer, 'id' | 'adAssetId' | 'updatedAt' | 'audio'> & {
    audioConfig?: AdPresetAudioSettings | null;
  };
}

export interface ExportRequestPayload {
  segments: CutSegment[];
  subtitles: SubtitleCue[];
  endplateAssetId: string; // 'preloaded:shorts-04' or 'uploaded:endplate'
  endplateDurationSec: number; // 1.5 - 2.0
  audioLogoAssetId: string; // 'preloaded:audio-logo' or 'uploaded:audioLogo'
  musicGainDb: number; // e.g. -22
  useUploadedMusic: boolean;
  adLayers?: AdOverlayLayer[];
}

export interface ExportedFileReport {
  version: 'A' | 'B';
  title: string;
  url: string;
  fileName: string;
  probe: MediaProbeInfo;
}

export interface ExportJobResult {
  jobId: string;
  createdAt: string;
  mainDurationSec: number;
  endplateDurationSec: number;
  totalDurationSec: number;
  versionA: ExportedFileReport;
  versionB: ExportedFileReport;
}

export interface ExportJobStatus {
  jobId: string;
  status: 'running' | 'completed' | 'failed';
  stageIndex: number;
  totalStages: number;
  stageLabel: string;
  detail: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
  result?: ExportJobResult;
}

export type ImageSizeOption = '1K' | '2K' | '4K';
export type AspectRatioOption = '9:16' | '16:9' | '1:1';

export interface MissingUploadedAsset {
  role: SourceRole;
  originalName: string;
  fileName: string;
  sizeBytes: number;
  probe: MediaProbeInfo;
  reason: string;
}

export interface StorageEnvironmentInfo {
  mode: 'gcs' | 'ephemeral-container';
  gcsBucket: string | null;
  summary: string;
}

export interface ExportHistoryItem {
  jobId: string;
  createdAt: string;
  updatedAt: string;
  status: 'running' | 'completed' | 'failed';
  totalDurationSec: number;
  versionAOnServer: boolean;
  versionASizeOnServer: number;
  versionBOnServer: boolean;
  versionBSizeOnServer: number;
  versionAOnCloud: boolean;
  versionBOnCloud: boolean;
  result?: ExportJobResult;
  error?: string;
}

export interface DownloadProgressInfo {
  jobId: string;
  version: 'A' | 'B';
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  source: 'server-range' | 'browser-vault';
  batchStep?: { current: number; total: number };
}

export interface VaultSaveResult {
  ok: boolean;
  error?: string;
  quotaExceeded?: boolean;
  bytesWritten?: number;
}

export interface BrowserVaultDiagnostics {
  supported: boolean;
  persisted: boolean | null;
  quotaBytes: number | null;
  usageBytes: number | null;
  indexedDbUsageBytes: number | null;
  lastBackupStatus: 'idle' | 'saving' | 'saved' | 'error';
  lastBackupMessage: string | null;
  lastBackupAt: string | null;
}

export interface ExportVaultBackupState {
  jobId: string;
  status: 'idle' | 'backing-up' | 'saved' | 'partial' | 'error';
  versionA: 'pending' | 'saved' | 'error';
  versionB: 'pending' | 'saved' | 'error';
  error?: string;
}

export type ProtectedResourceKind =
  | 'brand-audio'
  | 'brand-font'
  | 'brand-intro-outro'
  | 'brand-image'
  | 'brand-transition'
  | 'brand-animation'
  | 'brand-graphic'
  | 'app-config';

export interface ProtectedResourceEntry {
  id: string;
  kind: ProtectedResourceKind;
  categoryLabel?: string;
  label: string;
  relativePath: string;
  storageScope: 'server-public' | 'server-persistent' | 'app-config' | 'browser-settings';
  protected: true;
  reason: string;
}

export interface CleanupTargetItem {
  category:
    | 'source-video'
    | 'source-audio'
    | 'exported-mp4'
    | 'intermediate-temp'
    | 'ad-asset'
    | 'ad-audio'
    | 'state-json'
    | 'browser-idb'
    | 'browser-opfs'
    | 'browser-cache'
    | 'browser-storage';
  label: string;
  pathOrKey: string;
  sizeBytes: number;
}

export interface CleanupServerPlan {
  generatedAt: string;
  scope: 'production' | 'isolated-test';
  preserveAdPresets: boolean;
  preservedPresetsCount: number;
  counts: {
    sourceVideosCount: number;
    sourceAudioCount: number;
    exportedMp4Count: number;
    intermediateFilesCount: number;
    adFilesCount: number;
    adVisualFilesCount?: number;
    adAudioFilesCount?: number;
    stateFilesCount: number;
    totalServerBytes: number;
  };
  targets: CleanupTargetItem[];
  protectedResources: ProtectedResourceEntry[];
  overlapCount: number;
  overlapPaths: string[];
}

export interface CleanupBrowserPlan {
  preserveAdPresets: boolean;
  idbSourcesCount: number;
  idbExportsCount: number;
  idbAdsCount: number;
  idbPresetsCount: number;
  opfsFilesCount: number;
  cacheEntriesCount: number;
  storageKeysCount: number;
  totalBrowserBytes: number;
  targets: CleanupTargetItem[];
  preservedKeys: string[];
}

export interface CleanupVerificationItem {
  id: string;
  label: string;
  pathOrKey: string;
  ok: boolean;
  detail: string;
}

export interface CleanupServerExecutionReport {
  executedAt: string;
  scope: 'production' | 'isolated-test';
  success: boolean;
  deletedItems: string[];
  remainingItems: string[];
  errors: string[];
  freedServerBytes: number;
  protectedVerification: CleanupVerificationItem[];
  deletionVerification: CleanupVerificationItem[];
}
