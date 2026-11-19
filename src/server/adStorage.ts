import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  deleteCloudObject,
  restoreFileFromCloud,
  uploadFileToCloud,
} from './persistentStorage.ts';
import type {
  AdAssetInfo,
  AdAudioAssetInfo,
  AdAudioFormat,
  AdFormat,
  AdOverlayLayer,
  AdPreset,
} from '../types.ts';

const execFileAsync = promisify(execFile);

export interface PersistedAdWorkspaceState {
  assets: AdAssetInfo[];
  audioAssets: AdAudioAssetInfo[];
  layers: AdOverlayLayer[];
}

export function detectAdFormat(fileName: string, mimeType?: string): AdFormat | null {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.png' || mimeType === 'image/png') return 'png';
  if (ext === '.jpg' || ext === '.jpeg' || mimeType === 'image/jpeg') return 'jpg';
  if (ext === '.webp' || mimeType === 'image/webp') return 'webp';
  if (ext === '.gif' || mimeType === 'image/gif') return 'gif';
  return null;
}

export function detectAdAudioFormat(fileName: string, mimeType?: string): AdAudioFormat | null {
  const ext = path.extname(fileName).toLowerCase();
  const mime = (mimeType || '').toLowerCase();
  if (ext === '.mp3' || mime === 'audio/mpeg' || mime === 'audio/mp3') return 'mp3';
  if (ext === '.wav' || mime === 'audio/wav' || mime === 'audio/x-wav' || mime === 'audio/wave') return 'wav';
  if (ext === '.aac' || mime === 'audio/aac' || mime === 'audio/x-aac') return 'aac';
  if (ext === '.m4a' || mime === 'audio/mp4' || mime === 'audio/m4a' || mime === 'audio/x-m4a') return 'm4a';
  if (ext === '.ogg' || ext === '.oga' || mime === 'audio/ogg' || mime === 'application/ogg') return 'ogg';
  return null;
}

export async function probeAdAsset(params: {
  id: string;
  filePath: string;
  fileName: string;
  originalName: string;
  mimeType: string;
  format: AdFormat;
  url: string;
}): Promise<AdAssetInfo> {
  const stat = fs.statSync(params.filePath);
  const args = [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
  ];
  if (params.format === 'gif') {
    args.push('-count_frames');
  }
  args.push(params.filePath);

  const { stdout } = await execFileAsync('ffprobe', args, {
    maxBuffer: 10 * 1024 * 1024,
  });

  const parsed = JSON.parse(stdout);
  const streams: Array<Record<string, unknown>> = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  if (!videoStream) {
    throw new Error('В рекламном файле не найден видео/графический поток.');
  }

  const width = Number(videoStream.width ?? 0);
  const height = Number(videoStream.height ?? 0);
  if (width <= 0 || height <= 0) {
    throw new Error('Не удалось определить размеры рекламного изображения.');
  }

  const pixFmt = String(videoStream.pix_fmt ?? '').toLowerCase();
  const frameCountRaw = Number(videoStream.nb_read_frames ?? videoStream.nb_frames ?? 1);
  const frameCount = Number.isFinite(frameCountRaw) && frameCountRaw > 0 ? frameCountRaw : 1;
  const durationSecRaw = Number(parsed.format?.duration ?? videoStream.duration ?? 0);
  const durationSec = Number.isFinite(durationSecRaw) && durationSecRaw > 0 ? Number(durationSecRaw.toFixed(3)) : 0;

  const hasAlpha =
    params.format === 'png' ||
    params.format === 'webp' ||
    params.format === 'gif' ||
    pixFmt.includes('rgba') ||
    pixFmt.includes('bgra') ||
    pixFmt.includes('argb') ||
    pixFmt.includes('yuva') ||
    pixFmt.includes('pal8');

  return {
    id: params.id,
    fileName: params.fileName,
    originalName: params.originalName,
    mimeType: params.mimeType,
    format: params.format,
    url: params.url,
    filePath: params.filePath,
    width,
    height,
    durationSec,
    isAnimatedGif: params.format === 'gif' && frameCount > 1,
    frameCount,
    hasAlpha,
    sizeBytes: stat.size,
    uploadedAt: new Date().toISOString(),
  };
}

export async function probeAdAudioAsset(params: {
  id: string;
  filePath: string;
  fileName: string;
  originalName: string;
  mimeType: string;
  format: AdAudioFormat;
  url: string;
}): Promise<AdAudioAssetInfo> {
  const stat = fs.statSync(params.filePath);
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', params.filePath],
    { maxBuffer: 10 * 1024 * 1024 },
  );

  const parsed = JSON.parse(stdout);
  const streams: Array<Record<string, unknown>> = parsed.streams ?? [];
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  if (!audioStream) {
    throw new Error('В рекламном аудиофайле не найден аудиопоток.');
  }

  const durationSecRaw = Number(parsed.format?.duration ?? audioStream.duration ?? 0);
  const durationSec =
    Number.isFinite(durationSecRaw) && durationSecRaw > 0 ? Number(durationSecRaw.toFixed(3)) : 0;
  if (durationSec <= 0) {
    throw new Error('Не удалось определить длительность рекламного аудиофайла.');
  }

  const sampleRateRaw = Number(audioStream.sample_rate ?? 48000);
  const channelsRaw = Number(audioStream.channels ?? 2);

  return {
    id: params.id,
    fileName: params.fileName,
    originalName: params.originalName,
    mimeType: params.mimeType,
    format: params.format,
    url: params.url,
    filePath: params.filePath,
    durationSec,
    sampleRate: Number.isFinite(sampleRateRaw) && sampleRateRaw > 0 ? sampleRateRaw : 48000,
    channels: Number.isFinite(channelsRaw) && channelsRaw > 0 ? channelsRaw : 2,
    audioCodec: typeof audioStream.codec_name === 'string' ? audioStream.codec_name : null,
    sizeBytes: stat.size,
    uploadedAt: new Date().toISOString(),
  };
}

function normalizeAdPreset(raw: unknown): AdPreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : null;
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : null;
  if (!id || !name || !obj.layerConfig || typeof obj.layerConfig !== 'object') {
    return null;
  }
  const lc = obj.layerConfig as Record<string, unknown>;
  const legacyAudio =
    lc.audio && typeof lc.audio === 'object'
      ? (lc.audio as Record<string, unknown>)
      : lc.audioConfig && typeof lc.audioConfig === 'object'
        ? (lc.audioConfig as Record<string, unknown>)
        : null;

  const audioConfig = legacyAudio
    ? {
        enabled: Boolean(legacyAudio.enabled),
        startSec: Number.isFinite(Number(legacyAudio.startSec)) ? Number(legacyAudio.startSec) : Number(lc.startSec ?? 0),
        durationSec:
          legacyAudio.durationSec === null || legacyAudio.durationSec === undefined
            ? null
            : Number(legacyAudio.durationSec),
        trimStartSec: Number.isFinite(Number(legacyAudio.trimStartSec))
          ? Math.max(0, Number(legacyAudio.trimStartSec))
          : 0,
        trimEndSec:
          legacyAudio.trimEndSec === null || legacyAudio.trimEndSec === undefined
            ? null
            : Number(legacyAudio.trimEndSec),
        volumeDb: Number.isFinite(Number(legacyAudio.volumeDb)) ? Number(legacyAudio.volumeDb) : -8,
        fadeInSec: Number.isFinite(Number(legacyAudio.fadeInSec))
          ? Math.max(0, Number(legacyAudio.fadeInSec))
          : 0.25,
        fadeOutSec: Number.isFinite(Number(legacyAudio.fadeOutSec))
          ? Math.max(0, Number(legacyAudio.fadeOutSec))
          : 0.3,
      }
    : null;

  const { audio: _ignoredAudio, ...restLayerConfig } = lc;
  return {
    id,
    name,
    advertiserName: typeof obj.advertiserName === 'string' ? obj.advertiserName : undefined,
    requirementsTemplate:
      typeof obj.requirementsTemplate === 'string'
        ? obj.requirementsTemplate
        : typeof lc.promptText === 'string' && lc.promptText.trim()
          ? lc.promptText
          : undefined,
    notes: typeof obj.notes === 'string' ? obj.notes : undefined,
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : new Date().toISOString(),
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
    adAssetId: typeof obj.adAssetId === 'string' ? obj.adAssetId : null,
    assetSnapshot: (obj.assetSnapshot as AdAssetInfo | null | undefined) ?? null,
    layerConfig: {
      ...(restLayerConfig as unknown as AdPreset['layerConfig']),
      audioConfig,
    },
  };
}

export class AdStorageManager {
  private readonly adsDir: string;
  private readonly persistentDir: string;
  private readonly statePath: string;
  private readonly persistentPresetsPath: string;
  private readonly legacyPresetsPath: string;
  private state: PersistedAdWorkspaceState = { assets: [], audioAssets: [], layers: [] };
  private presets: AdPreset[] = [];
  private migrationSummary: { migratedCount: number; sourceDeleted: boolean } = {
    migratedCount: 0,
    sourceDeleted: false,
  };

  constructor(storageDir: string) {
    this.adsDir = path.join(storageDir, 'ads');
    this.persistentDir = path.join(storageDir, 'persistent');
    this.statePath = path.join(storageDir, 'ad_state.json');
    this.persistentPresetsPath = path.join(this.persistentDir, 'ad_presets.json');
    this.legacyPresetsPath = path.join(storageDir, 'ad_presets.json');
    fs.mkdirSync(this.adsDir, { recursive: true });
    fs.mkdirSync(this.persistentDir, { recursive: true });
    this.loadFromDisk();
  }

  getAdsDir(): string {
    return this.adsDir;
  }

  getPersistentPresetsPath(): string {
    return this.persistentPresetsPath;
  }

  getMigrationSummary() {
    return this.migrationSummary;
  }

  private readPresetsFile(filePath: string): AdPreset[] {
    if (!fs.existsSync(filePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeAdPreset).filter((p): p is AdPreset => Boolean(p));
    } catch {
      return [];
    }
  }

  private writePersistentPresetsAtomic(presets: AdPreset[]): boolean {
    try {
      fs.mkdirSync(this.persistentDir, { recursive: true });
      const tmpPath = `${this.persistentPresetsPath}.tmp_${Date.now()}`;
      fs.writeFileSync(tmpPath, JSON.stringify(presets, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.persistentPresetsPath);
      return true;
    } catch {
      return false;
    }
  }

  private loadFromDisk() {
    if (fs.existsSync(this.statePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf-8')) as Partial<PersistedAdWorkspaceState>;
        this.state = {
          assets: Array.isArray(parsed.assets) ? parsed.assets : [],
          audioAssets: Array.isArray(parsed.audioAssets) ? parsed.audioAssets : [],
          layers: Array.isArray(parsed.layers) ? parsed.layers : [],
        };
      } catch {
        this.state = { assets: [], audioAssets: [], layers: [] };
      }
    }

    const persistentPresets = this.readPresetsFile(this.persistentPresetsPath);
    const legacyPresets = this.readPresetsFile(this.legacyPresetsPath);

    if (legacyPresets.length > 0) {
      // Merge legacy presets into persistent store without losing any existing records
      const mergedMap = new Map<string, AdPreset>();
      for (const lp of legacyPresets) {
        mergedMap.set(lp.id, lp);
      }
      for (const pp of persistentPresets) {
        mergedMap.set(pp.id, pp);
      }
      const merged = Array.from(mergedMap.values());
      const written = this.writePersistentPresetsAtomic(merged);
      if (written) {
        // Verify persistent file parsed cleanly with all migrated IDs before removing legacy file
        const verified = this.readPresetsFile(this.persistentPresetsPath);
        const verifiedIds = new Set(verified.map((v) => v.id));
        const allPresent = merged.every((m) => verifiedIds.has(m.id));
        let sourceDeleted = false;
        if (allPresent && fs.existsSync(this.legacyPresetsPath)) {
          try {
            fs.unlinkSync(this.legacyPresetsPath);
            sourceDeleted = true;
          } catch {
            // keep legacy file if unlink fails
          }
        }
        this.presets = verified;
        this.migrationSummary = {
          migratedCount: legacyPresets.length,
          sourceDeleted,
        };
        return;
      }
      this.presets = merged;
      return;
    }

    this.presets = persistentPresets;
  }

  private saveStateToDisk() {
    try {
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch {
      // ignore disk failure
    }
  }

  private savePresetsToDisk() {
    this.writePersistentPresetsAtomic(this.presets);
  }

  async syncAndGetAll(): Promise<{
    assets: AdAssetInfo[];
    audioAssets: AdAudioAssetInfo[];
    missingAssetIds: string[];
    missingAudioAssetIds: string[];
    layers: AdOverlayLayer[];
    presets: AdPreset[];
  }> {
    const availableAssets: AdAssetInfo[] = [];
    const missingAssetIds: string[] = [];

    for (const asset of this.state.assets) {
      let exists = fs.existsSync(asset.filePath) && fs.statSync(asset.filePath).size > 0;
      if (!exists && asset.fileName && asset.filePath) {
        const restored = await restoreFileFromCloud(`ads/${asset.fileName}`, asset.filePath);
        if (restored) {
          exists = fs.existsSync(asset.filePath) && fs.statSync(asset.filePath).size > 0;
        }
      }
      if (exists) {
        availableAssets.push(asset);
      } else {
        missingAssetIds.push(asset.id);
      }
    }

    const availableAudioAssets: AdAudioAssetInfo[] = [];
    const missingAudioAssetIds: string[] = [];

    for (const audio of this.state.audioAssets) {
      let exists = fs.existsSync(audio.filePath) && fs.statSync(audio.filePath).size > 0;
      if (!exists && audio.fileName && audio.filePath) {
        const restored = await restoreFileFromCloud(`ads/${audio.fileName}`, audio.filePath);
        if (restored) {
          exists = fs.existsSync(audio.filePath) && fs.statSync(audio.filePath).size > 0;
        }
      }
      if (exists) {
        availableAudioAssets.push(audio);
      } else {
        missingAudioAssetIds.push(audio.id);
      }
    }

    if (this.presets.length === 0 && !fs.existsSync(this.persistentPresetsPath)) {
      const restoredPresets = await restoreFileFromCloud(
        'persistent/ad_presets.json',
        this.persistentPresetsPath,
      );
      if (restoredPresets) {
        this.presets = this.readPresetsFile(this.persistentPresetsPath);
      }
    }

    return {
      assets: availableAssets,
      audioAssets: availableAudioAssets,
      missingAssetIds,
      missingAudioAssetIds,
      layers: this.state.layers,
      presets: this.presets,
    };
  }

  getAssetById(assetId: string): AdAssetInfo | undefined {
    const found = this.state.assets.find((a) => a.id === assetId);
    if (found && fs.existsSync(found.filePath)) return found;
    return undefined;
  }

  getAssetPathMap(): Record<string, AdAssetInfo> {
    const map: Record<string, AdAssetInfo> = {};
    for (const asset of this.state.assets) {
      if (fs.existsSync(asset.filePath) && fs.statSync(asset.filePath).size > 0) {
        map[asset.id] = asset;
      }
    }
    return map;
  }

  getAudioAssetPathMap(): Record<string, AdAudioAssetInfo> {
    const map: Record<string, AdAudioAssetInfo> = {};
    for (const audio of this.state.audioAssets) {
      if (fs.existsSync(audio.filePath) && fs.statSync(audio.filePath).size > 0) {
        map[audio.id] = audio;
      }
    }
    return map;
  }

  async registerUploadedAsset(asset: AdAssetInfo): Promise<void> {
    this.state.assets = [asset, ...this.state.assets.filter((a) => a.id !== asset.id)];
    this.saveStateToDisk();
    await uploadFileToCloud(asset.filePath, `ads/${asset.fileName}`, asset.mimeType);
  }

  async registerUploadedAudioAsset(asset: AdAudioAssetInfo): Promise<void> {
    this.state.audioAssets = [asset, ...this.state.audioAssets.filter((a) => a.id !== asset.id)];
    this.saveStateToDisk();
    await uploadFileToCloud(asset.filePath, `ads/${asset.fileName}`, asset.mimeType);
  }

  deleteAsset(assetId: string): boolean {
    const existing = this.state.assets.find((a) => a.id === assetId);
    if (existing) {
      if (existing.filePath && fs.existsSync(existing.filePath)) {
        try {
          fs.unlinkSync(existing.filePath);
        } catch {
          // ignore unlink error
        }
      }
      if (existing.fileName) {
        void deleteCloudObject(`ads/${existing.fileName}`);
      }
    }
    this.state.assets = this.state.assets.filter((a) => a.id !== assetId);
    this.saveStateToDisk();
    return Boolean(existing);
  }

  deleteAudioAsset(audioId: string): boolean {
    const existing = this.state.audioAssets.find((a) => a.id === audioId);
    if (existing) {
      if (existing.filePath && fs.existsSync(existing.filePath)) {
        try {
          fs.unlinkSync(existing.filePath);
        } catch {
          // ignore unlink error
        }
      }
      if (existing.fileName) {
        void deleteCloudObject(`ads/${existing.fileName}`);
      }
    }
    this.state.audioAssets = this.state.audioAssets.filter((a) => a.id !== audioId);
    this.state.layers = this.state.layers.map((layer) =>
      layer.audio?.audioAssetId === audioId
        ? {
            ...layer,
            audio: {
              ...layer.audio,
              enabled: false,
              audioAssetId: null,
            },
          }
        : layer,
    );
    this.saveStateToDisk();
    return Boolean(existing);
  }

  updateLayers(layers: AdOverlayLayer[]): AdOverlayLayer[] {
    this.state.layers = layers;
    this.saveStateToDisk();
    return this.state.layers;
  }

  getPresets(): AdPreset[] {
    return this.presets;
  }

  savePreset(preset: AdPreset): AdPreset[] {
    const normalized = normalizeAdPreset(preset) ?? preset;
    const idx = this.presets.findIndex((p) => p.id === normalized.id);
    if (idx >= 0) {
      this.presets[idx] = normalized;
    } else {
      this.presets = [normalized, ...this.presets];
    }
    this.savePresetsToDisk();
    void uploadFileToCloud(
      this.persistentPresetsPath,
      'persistent/ad_presets.json',
      'application/json',
    );
    return this.presets;
  }

  deletePreset(presetId: string): AdPreset[] {
    this.presets = this.presets.filter((p) => p.id !== presetId);
    this.savePresetsToDisk();
    void uploadFileToCloud(
      this.persistentPresetsPath,
      'persistent/ad_presets.json',
      'application/json',
    );
    return this.presets;
  }

  resetInMemory(options?: { clearPresets?: boolean }): void {
    this.state = { assets: [], audioAssets: [], layers: [] };
    if (options?.clearPresets) {
      this.presets = [];
    }
  }
}
