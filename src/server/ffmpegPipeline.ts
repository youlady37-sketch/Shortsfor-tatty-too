import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { computeAdOverlayBox } from '../utils/adGeometry.ts';
import type {
  AdAssetInfo,
  AdAudioAssetInfo,
  AdOverlayLayer,
  CutSegment,
  ExportJobResult,
  MediaProbeInfo,
  OverlayPlacementMode,
  SubtitleCue,
  UploadedAsset,
} from '../types.ts';

const execFileAsync = promisify(execFile);

async function runCommand(bin: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(bin, args, {
      cwd,
      maxBuffer: 25 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const tail = (e.stderr ?? '').trim().split('\n').slice(-6).join(' | ');
    throw new Error(tail ? `Ошибка ${bin}: ${tail}` : e.message || `Ошибка запуска ${bin}`);
  }
}

function parseFps(rateStr: string | undefined): number {
  if (!rateStr || !rateStr.includes('/')) return 25;
  const [numStr, denStr] = rateStr.split('/');
  const num = Number(numStr);
  const den = Number(denStr);
  if (!num || !den) return 25;
  return Number((num / den).toFixed(3));
}

export async function probeMedia(filePath: string): Promise<MediaProbeInfo> {
  const stat = fs.statSync(filePath);
  const { stdout } = await runCommand('ffprobe', [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);

  const parsed = JSON.parse(stdout);
  const streams: Array<Record<string, unknown>> = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const formatDuration = Number(parsed.format?.duration ?? 0);
  const streamDuration = Number(videoStream?.duration ?? audioStream?.duration ?? 0);

  return {
    durationSec: Number((formatDuration || streamDuration || 0).toFixed(3)),
    width: Number(videoStream?.width ?? 0),
    height: Number(videoStream?.height ?? 0),
    fps: parseFps(String(videoStream?.r_frame_rate ?? videoStream?.avg_frame_rate ?? '25/1')),
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
    videoCodec: videoStream ? String(videoStream.codec_name ?? '') : null,
    audioCodec: audioStream ? String(audioStream.codec_name ?? '') : null,
    sampleRate: audioStream?.sample_rate ? Number(audioStream.sample_rate) : null,
    sizeBytes: stat.size,
  };
}

function formatAssTime(sec: number): string {
  const clamped = Math.max(0, sec);
  const hours = Math.floor(clamped / 3600);
  const mins = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const cs = Math.floor((clamped - Math.floor(clamped)) * 100);
  return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').trim();
}

export function buildAssSubtitles(cues: SubtitleCue[]): string {
  const header = [
    '[Script Info]',
    'Title: ДЕЛО В КАДРЕ — Subtitles',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: ShortsSafe,Noto Sans,56,&H00FFFFFF,&H000000FF,&H000B0F17,&H99000000,-1,0,0,0,100,100,0,0,1,4,2,2,72,72,330,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events = cues
    .filter((c) => c.endSec > c.startSec && (c.line1.trim() || c.line2.trim()))
    .map((c) => {
      const l1 = escapeAssText(c.line1);
      const l2 = escapeAssText(c.line2);
      const body = l1 && l2 ? `${l1}\\N${l2}` : l1 || l2;
      return `Dialogue: 0,${formatAssTime(c.startSec)},${formatAssTime(c.endSec)},ShortsSafe,,0,0,0,,${body}`;
    });

  return [...header, ...events].join('\n') + '\n';
}

export async function extractTimelineAudioForTranscription(params: {
  segments: CutSegment[];
  assets: Partial<Record<'fragment8' | 'fragment9', UploadedAsset>>;
  workDir: string;
}): Promise<string> {
  const { segments, assets, workDir } = params;
  fs.mkdirSync(workDir, { recursive: true });

  const audioParts: string[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const asset = assets[seg.sourceRole];
    if (!asset) {
      throw new Error(`Не загружен видеофайл для источника: ${seg.sourceRole}`);
    }
    const dur = Math.max(0.1, seg.endSec - seg.startSec);
    const outPart = path.join(workDir, `part_${i}.mp3`);
    await runCommand('ffmpeg', [
      '-y',
      '-ss',
      String(seg.startSec),
      '-t',
      String(dur),
      '-i',
      asset.filePath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '64k',
      outPart,
    ]);
    audioParts.push(outPart);
  }

  const listFile = path.join(workDir, 'audio_list.txt');
  fs.writeFileSync(
    listFile,
    audioParts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'),
    'utf-8',
  );

  const mergedOut = path.join(workDir, 'timeline_speech.mp3');
  await runCommand('ffmpeg', [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listFile,
    '-c',
    'copy',
    mergedOut,
  ]);
  return mergedOut;
}

export async function applyAdOverlaysToVideo(params: {
  inputVideoPath: string;
  outputVideoPath: string;
  stageDurationSec: number;
  targetFps: number;
  layers: AdOverlayLayer[];
  adAssetsMap: Record<string, AdAssetInfo>;
  crf?: number;
}): Promise<boolean> {
  const {
    inputVideoPath,
    outputVideoPath,
    stageDurationSec,
    targetFps,
    layers,
    adAssetsMap,
    crf = 14,
  } = params;

  const validLayers = layers.filter((layer) => {
    if (!layer.enabled || !layer.confirmed) return false;
    const asset = adAssetsMap[layer.adAssetId];
    if (!asset || !fs.existsSync(asset.filePath)) return false;
    const clampedStart = Math.max(0, layer.startSec);
    const clampedEnd = Math.min(stageDurationSec, layer.endSec);
    return clampedEnd - clampedStart >= 0.05;
  });

  if (validLayers.length === 0) {
    return false;
  }

  const inputArgs: string[] = ['-y', '-i', inputVideoPath];
  const filterParts: string[] = ['[0:v]format=yuv420p[vbase]'];
  let currentVideoLabel = 'vbase';

  for (let i = 0; i < validLayers.length; i += 1) {
    const layer = validLayers[i];
    const asset = adAssetsMap[layer.adAssetId];
    const box = computeAdOverlayBox(layer, asset);
    const startSec = Math.max(0, Math.min(stageDurationSec - 0.05, layer.startSec));
    const endSec = Math.max(startSec + 0.05, Math.min(stageDurationSec, layer.endSec));
    const layerDur = endSec - startSec;
    const inputIdx = i + 1;

    if (asset.format === 'gif' && asset.isAnimatedGif) {
      inputArgs.push(
        '-ignore_loop',
        layer.gifBehavior === 'loop' ? '0' : '1',
        '-itsoffset',
        startSec.toFixed(3),
        '-i',
        asset.filePath,
      );
    } else {
      inputArgs.push('-loop', '1', '-t', stageDurationSec.toFixed(3), '-i', asset.filePath);
    }

    const adChain: string[] = [];
    if (asset.format === 'gif' && asset.isAnimatedGif) {
      adChain.push(`fps=${targetFps}`);
    }
    adChain.push(`scale=${box.widthPx}:${box.heightPx}:flags=lanczos`, 'format=rgba');

    if (asset.format === 'gif' && asset.isAnimatedGif && layer.gifBehavior === 'freeze') {
      adChain.push(`tpad=stop_mode=clone:stop_duration=${stageDurationSec.toFixed(2)}`);
    }

    const opacity = Math.min(1, Math.max(0.05, Number(layer.opacity) || 1));
    if (opacity < 0.999) {
      adChain.push(`colorchannelmixer=aa=${opacity.toFixed(3)}`);
    }

    const fadeIn = Math.min(Math.max(0, Number(layer.fadeInSec) || 0), layerDur * 0.45);
    const fadeOut = Math.min(Math.max(0, Number(layer.fadeOutSec) || 0), layerDur * 0.45);
    if (fadeIn >= 0.02) {
      adChain.push(`fade=t=in:st=${startSec.toFixed(3)}:d=${fadeIn.toFixed(3)}:alpha=1`);
    }
    if (fadeOut >= 0.02) {
      adChain.push(`fade=t=out:st=${(endSec - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}:alpha=1`);
    }

    const adLabel = `ad_${i}`;
    filterParts.push(`[${inputIdx}:v]${adChain.join(',')}[${adLabel}]`);

    const nextVideoLabel = i === validLayers.length - 1 ? 'vads_out' : `vstage_${i}`;
    const eofAction =
      asset.format === 'gif' && asset.isAnimatedGif && layer.gifBehavior === 'freeze'
        ? 'repeat'
        : 'pass';

    filterParts.push(
      `[${currentVideoLabel}][${adLabel}]overlay=x=${box.xPx}:y=${box.yPx}:enable='between(t,${startSec.toFixed(3)},${endSec.toFixed(3)})':eof_action=${eofAction}:shortest=0[${nextVideoLabel}]`,
    );
    currentVideoLabel = nextVideoLabel;
  }

  filterParts.push(`[${currentVideoLabel}]format=yuv420p[vfinal]`);

  await runCommand('ffmpeg', [
    ...inputArgs,
    '-filter_complex',
    filterParts.join(';'),
    '-map',
    '[vfinal]',
    '-map',
    '0:a?',
    '-t',
    stageDurationSec.toFixed(3),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    String(crf),
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'copy',
    outputVideoPath,
  ]);

  return true;
}

export async function buildAdAudioMasterWav(params: {
  jobDir: string;
  mainDurationSec: number;
  endplateDurationSec: number;
  layers: AdOverlayLayer[];
  adAudioAssetsMap: Record<string, AdAudioAssetInfo>;
}): Promise<string | null> {
  const { jobDir, mainDurationSec, endplateDurationSec, layers, adAudioAssetsMap } = params;
  const totalDurationSec = Number((mainDurationSec + endplateDurationSec).toFixed(3));
  if (totalDurationSec <= 0) return null;

  interface PreparedTrack {
    filePath: string;
    adStartSec: number;
    trimStartSec: number;
    effectiveDurSec: number;
    volumeDb: number;
    fadeInSec: number;
    fadeOutSec: number;
  }

  const tracks: PreparedTrack[] = [];

  for (const layer of layers) {
    if (!layer.enabled || !layer.confirmed) continue;
    const audio = layer.audio;
    if (!audio || !audio.enabled || !audio.audioAssetId) continue;
    const asset = adAudioAssetsMap[audio.audioAssetId];
    if (!asset || !fs.existsSync(asset.filePath) || asset.durationSec <= 0) continue;

    const maxTimelineEnd = layer.allowOnEndplate ? totalDurationSec : mainDurationSec;
    if (maxTimelineEnd <= 0.05) continue;

    const adStartSec = Math.max(0, Math.min(maxTimelineEnd - 0.05, Number(audio.startSec) || 0));
    const trimStartSec = Math.max(
      0,
      Math.min(Math.max(0, asset.durationSec - 0.05), Number(audio.trimStartSec) || 0),
    );
    const rawTrimEnd =
      audio.trimEndSec !== null && audio.trimEndSec !== undefined && Number.isFinite(Number(audio.trimEndSec))
        ? Number(audio.trimEndSec)
        : asset.durationSec;
    const trimEndSec = Math.min(asset.durationSec, Math.max(trimStartSec + 0.05, rawTrimEnd));
    const availClipDur = Math.max(0, trimEndSec - trimStartSec);

    const requestedDur =
      audio.durationSec !== null &&
      audio.durationSec !== undefined &&
      Number.isFinite(Number(audio.durationSec)) &&
      Number(audio.durationSec) > 0
        ? Number(audio.durationSec)
        : availClipDur;

    const effectiveDurSec = Math.min(availClipDur, requestedDur, Math.max(0, maxTimelineEnd - adStartSec));
    if (effectiveDurSec < 0.05) continue;

    const volumeDb = Math.min(
      6,
      Math.max(-36, Number.isFinite(Number(audio.volumeDb)) ? Number(audio.volumeDb) : -8),
    );
    const fadeInSec = Math.min(Math.max(0, Number(audio.fadeInSec) || 0), effectiveDurSec * 0.45);
    const fadeOutSec = Math.min(Math.max(0, Number(audio.fadeOutSec) || 0), effectiveDurSec * 0.45);

    tracks.push({
      filePath: asset.filePath,
      adStartSec,
      trimStartSec,
      effectiveDurSec,
      volumeDb,
      fadeInSec,
      fadeOutSec,
    });
  }

  if (tracks.length === 0) {
    return null;
  }

  const adAudioMasterPath = path.join(jobDir, 'ad_audio_master.wav');
  const inputArgs: string[] = [
    '-y',
    '-f',
    'lavfi',
    '-t',
    totalDurationSec.toFixed(3),
    '-i',
    'anullsrc=channel_layout=stereo:sample_rate=48000',
  ];

  const filterParts: string[] = [
    `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${totalDurationSec.toFixed(3)},asetpts=PTS-STARTPTS[abase0]`,
  ];
  const mixInputs: string[] = ['[abase0]'];

  tracks.forEach((tr, i) => {
    const inputIdx = i + 1;
    inputArgs.push(
      '-ss',
      tr.trimStartSec.toFixed(3),
      '-t',
      tr.effectiveDurSec.toFixed(3),
      '-i',
      tr.filePath,
    );

    const chain: string[] = [
      'aresample=48000:async=1',
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
      `volume=${tr.volumeDb.toFixed(2)}dB`,
    ];
    if (tr.fadeInSec >= 0.02) {
      chain.push(`afade=t=in:st=0:d=${tr.fadeInSec.toFixed(3)}:curve=qsin`);
    }
    if (tr.fadeOutSec >= 0.02) {
      const outStart = Math.max(0, tr.effectiveDurSec - tr.fadeOutSec);
      chain.push(`afade=t=out:st=${outStart.toFixed(3)}:d=${tr.fadeOutSec.toFixed(3)}:curve=qsin`);
    }
    if (tr.adStartSec >= 0.005) {
      const delayMs = Math.round(tr.adStartSec * 1000);
      chain.push(`adelay=${delayMs}|${delayMs}`);
    }
    chain.push(`apad=whole_dur=${totalDurationSec.toFixed(3)}`);
    chain.push(`atrim=0:${totalDurationSec.toFixed(3)}`);
    chain.push('asetpts=PTS-STARTPTS');

    const label = `ada_${i}`;
    filterParts.push(`[${inputIdx}:a]${chain.join(',')}[${label}]`);
    mixInputs.push(`[${label}]`);
  });

  filterParts.push(
    `${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0:normalize=0,alimiter=level_in=1:level_out=1:limit=0.95:attack=5:release=50[aout]`,
  );

  await runCommand('ffmpeg', [
    ...inputArgs,
    '-filter_complex',
    filterParts.join(';'),
    '-map',
    '[aout]',
    '-t',
    totalDurationSec.toFixed(3),
    '-c:a',
    'pcm_s16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    adAudioMasterPath,
  ]);

  return adAudioMasterPath;
}

export async function renderDualShortsExport(params: {
  jobId: string;
  jobDir: string;
  exportBaseUrl: string;
  segments: CutSegment[];
  subtitles: SubtitleCue[];
  assets: Partial<Record<'fragment8' | 'fragment9' | 'music' | 'endplate' | 'audioLogo', UploadedAsset>>;
  overlayPathMap: Record<string, string>;
  overlayPlacementMap?: Record<string, OverlayPlacementMode>;
  endplatePath: string;
  endplateIsVideo: boolean;
  endplateDurationSec: number;
  audioLogoPath: string;
  useUploadedMusic: boolean;
  musicGainDb: number;
  adLayers?: AdOverlayLayer[];
  adAssetsMap?: Record<string, AdAssetInfo>;
  adAudioAssetsMap?: Record<string, AdAudioAssetInfo>;
  onProgress?: (stageIndex: number, totalStages: number, stageLabel: string, detail: string) => void;
}): Promise<ExportJobResult> {
  const {
    jobId,
    jobDir,
    exportBaseUrl,
    segments,
    subtitles,
    assets,
    overlayPathMap,
    overlayPlacementMap = {},
    endplatePath,
    endplateIsVideo,
    endplateDurationSec,
    audioLogoPath,
    useUploadedMusic,
    musicGainDb,
    adLayers = [],
    adAssetsMap = {},
    adAudioAssetsMap = {},
    onProgress,
  } = params;

  const totalStages = 6;
  const report = (stageIndex: number, stageLabel: string, detail: string) => {
    onProgress?.(stageIndex, totalStages, stageLabel, detail);
  };

  const resolvedEndplatePath = path.resolve(endplatePath);
  const resolvedAudioLogoPath = path.resolve(audioLogoPath);

  fs.mkdirSync(jobDir, { recursive: true });

  if (segments.length === 0) {
    throw new Error('Добавьте хотя бы один монтажный сегмент на таймлайн.');
  }

  // Determine target FPS from first available source video
  const firstAsset = assets[segments[0].sourceRole];
  if (!firstAsset) {
    throw new Error('Отсутствует исходный видеофайл для первого сегмента.');
  }
  const targetFps = Math.max(24, Math.min(60, firstAsset.probe.fps || 25));

  // Step 1: Normalize each cut segment into 1080x1920 vertical frame + clean audio
  const segmentFiles: string[] = [];
  let mainDurationSec = 0;

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    report(
      1,
      'Нарезка и вертикальное кадрирование 9:16',
      `Сегмент ${i + 1} из ${segments.length}: ${seg.beatTitle}`,
    );
    const asset = assets[seg.sourceRole];
    if (!asset) {
      throw new Error(`Отсутствует загруженный файл для роли ${seg.sourceRole}.`);
    }
    const segDur = Number((seg.endSec - seg.startSec).toFixed(3));
    if (segDur <= 0.1) {
      throw new Error(`Сегмент "${seg.beatTitle}" имеет некорректную длительность.`);
    }
    if (seg.endSec > asset.probe.durationSec + 0.05) {
      throw new Error(
        `Таймкод сегмента "${seg.beatTitle}" (${seg.endSec.toFixed(1)} с) выходит за пределы загруженного файла (${asset.probe.durationSec.toFixed(1)} с).`,
      );
    }

    mainDurationSec += segDur;

    const srcW = asset.probe.width || 1920;
    const srcH = asset.probe.height || 1080;
    let cropW: number;
    let cropH: number;
    let cropX: number;
    let cropY: number;

    if (srcW / srcH > 9 / 16) {
      cropH = Math.floor(srcH / 2) * 2;
      cropW = Math.floor(((cropH * 9) / 16) / 2) * 2;
      const maxX = Math.max(0, srcW - cropW);
      cropX = Math.min(maxX, Math.max(0, Math.round(((seg.cropOffsetX + 100) / 200) * maxX)));
      cropY = 0;
    } else {
      cropW = Math.floor(srcW / 2) * 2;
      cropH = Math.min(srcH, Math.floor(((cropW * 16) / 9) / 2) * 2);
      cropX = 0;
      cropY = Math.max(0, Math.round((srcH - cropH) / 2));
    }

    const segOut = path.join(jobDir, `seg_${i}.mkv`);
    const overlayPath = seg.overlayId ? overlayPathMap[seg.overlayId] : undefined;

    const inputArgs: string[] = [
      '-y',
      '-ss',
      String(seg.startSec),
      '-t',
      String(segDur),
      '-i',
      asset.filePath,
    ];

    if (!asset.probe.hasAudio) {
      inputArgs.push('-f', 'lavfi', '-t', String(segDur), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    }

    if (overlayPath && fs.existsSync(overlayPath)) {
      inputArgs.push('-loop', '1', '-t', String(segDur), '-i', overlayPath);
    }

    const filterParts: string[] = [
      `[0:v]crop=${cropW}:${cropH}:${cropX}:${cropY},scale=1080:1920:flags=lanczos,fps=${targetFps},setsar=1,format=yuv420p[vbase]`,
    ];

    let videoMap = '[vbase]';
    if (overlayPath && fs.existsSync(overlayPath)) {
      const ovIdx = asset.probe.hasAudio ? 1 : 2;
      const placement: OverlayPlacementMode =
        (seg.overlayId ? overlayPlacementMap[seg.overlayId] : undefined) ?? 'full-frame';

      if (placement === 'top-left-badge') {
        filterParts.push(`[${ovIdx}:v]scale=360:-1:flags=lanczos,format=rgba[vov]`);
        filterParts.push(`[vbase][vov]overlay=64:240:shortest=1,format=yuv420p[vout]`);
      } else if (placement === 'top-center-logo') {
        filterParts.push(`[${ovIdx}:v]scale=560:-1:flags=lanczos,format=rgba[vov]`);
        filterParts.push(`[vbase][vov]overlay=(W-w)/2:240:shortest=1,format=yuv420p[vout]`);
      } else if (placement === 'bottom-center-subtitle') {
        filterParts.push(`[${ovIdx}:v]scale=760:-1:flags=lanczos,format=rgba[vov]`);
        filterParts.push(`[vbase][vov]overlay=(W-w)/2:1420:shortest=1,format=yuv420p[vout]`);
      } else {
        filterParts.push(
          `[${ovIdx}:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=#00000000,format=rgba[vov]`,
        );
        filterParts.push(`[vbase][vov]overlay=0:0:shortest=1,format=yuv420p[vout]`);
      }
      videoMap = '[vout]';
    }

    if (asset.probe.hasAudio) {
      filterParts.push(`[0:a]aresample=48000:async=1,aformat=sample_fmts=s16:channel_layouts=stereo[aout]`);
    } else {
      filterParts.push(`[1:a]aformat=sample_fmts=s16:channel_layouts=stereo[aout]`);
    }

    await runCommand('ffmpeg', [
      ...inputArgs,
      '-filter_complex',
      filterParts.join(';'),
      '-map',
      videoMap,
      '-map',
      '[aout]',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '14',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'pcm_s16le',
      segOut,
    ]);

    segmentFiles.push(segOut);
  }

  // Step 2: Concat main segments
  report(2, 'Склейка основного таймлайна', `Объединение ${segmentFiles.length} сегментов`);
  const concatListPath = path.join(jobDir, 'concat_main.txt');
  fs.writeFileSync(
    concatListPath,
    segmentFiles.map((f) => `file '${path.basename(f)}'`).join('\n'),
    'utf-8',
  );

  const mainConcatPath = path.join(jobDir, 'main_concat.mkv');
  await runCommand(
    'ffmpeg',
    ['-y', '-f', 'concat', '-safe', '0', '-i', 'concat_main.txt', '-c', 'copy', 'main_concat.mkv'],
    jobDir,
  );

  // Step 3: Burn Russian ASS subtitles into main video
  report(3, 'Наложение русских субтитров (.ASS)', `Реплик: ${subtitles.length}`);
  const assContent = buildAssSubtitles(subtitles);
  fs.writeFileSync(path.join(jobDir, 'subtitles.ass'), assContent, 'utf-8');

  const mainSubtitledPath = path.join(jobDir, 'main_subtitled.mkv');
  if (subtitles.length > 0) {
    await runCommand(
      'ffmpeg',
      [
        '-y',
        '-i',
        'main_concat.mkv',
        '-vf',
        'ass=subtitles.ass',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '14',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'copy',
        'main_subtitled.mkv',
      ],
      jobDir,
    );
  } else {
    fs.copyFileSync(mainConcatPath, mainSubtitledPath);
  }

  // Step 4: Render visual Endplate (1.5 - 2.0 sec) at exact 1080x1920 & targetFps
  report(4, 'Подготовка финальной заставки', `Длительность заставки: ${endplateDurationSec.toFixed(1)} с`);
  const endplateVideoPath = path.join(jobDir, 'endplate_video.mkv');
  if (endplateIsVideo) {
    await runCommand('ffmpeg', [
      '-y',
      '-t',
      String(endplateDurationSec),
      '-i',
      resolvedEndplatePath,
      '-vf',
      `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=#111318,fps=${targetFps},setsar=1,format=yuv420p`,
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '14',
      '-pix_fmt',
      'yuv420p',
      endplateVideoPath,
    ]);
  } else {
    await runCommand('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=#111318:s=1080x1920:r=${targetFps}:d=${endplateDurationSec}`,
      '-loop',
      '1',
      '-t',
      String(endplateDurationSec),
      '-i',
      resolvedEndplatePath,
      '-filter_complex',
      '[1:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=#00000000,format=rgba[ov];[0:v][ov]overlay=0:0:shortest=1,format=yuv420p[vout]',
      '-map',
      '[vout]',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '14',
      '-pix_fmt',
      'yuv420p',
      endplateVideoPath,
    ]);
  }

  // Step 3.5: Composite main-timeline ad overlays (allowOnEndplate === false)
  const mainOnlyAds = adLayers.filter((l) => !l.allowOnEndplate);
  const mainWithAdsPath = path.join(jobDir, 'main_with_ads.mkv');
  const appliedMainAds = await applyAdOverlaysToVideo({
    inputVideoPath: mainSubtitledPath,
    outputVideoPath: mainWithAdsPath,
    stageDurationSec: mainDurationSec,
    targetFps,
    layers: mainOnlyAds,
    adAssetsMap,
    crf: 14,
  });
  const finalMainVideoName = appliedMainAds ? 'main_with_ads.mkv' : 'main_subtitled.mkv';

  // Combine main video + endplate video (video-only master)
  const videoListPath = path.join(jobDir, 'video_master_list.txt');
  fs.writeFileSync(
    videoListPath,
    `file '${finalMainVideoName}'\nfile 'endplate_video.mkv'\n`,
    'utf-8',
  );
  await runCommand(
    'ffmpeg',
    ['-y', '-f', 'concat', '-safe', '0', '-i', 'video_master_list.txt', '-an', '-c:v', 'copy', 'video_master.mkv'],
    jobDir,
  );

  // Step 4.5: Composite endplate-allowed ad overlays onto combined master (Identical for Version A & B)
  const endplateAllowedAds = adLayers.filter((l) => l.allowOnEndplate);
  const masterWithAdsPath = path.join(jobDir, 'video_master_ads.mkv');
  const appliedEndplateAds = await applyAdOverlaysToVideo({
    inputVideoPath: path.join(jobDir, 'video_master.mkv'),
    outputVideoPath: masterWithAdsPath,
    stageDurationSec: mainDurationSec + endplateDurationSec,
    targetFps,
    layers: endplateAllowedAds,
    adAssetsMap,
    crf: 14,
  });
  const masterVideoFileName = appliedEndplateAds ? 'video_master_ads.mkv' : 'video_master.mkv';

  // Extract main original audio
  await runCommand(
    'ffmpeg',
    ['-y', '-i', 'main_subtitled.mkv', '-vn', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', 'main_audio.wav'],
    jobDir,
  );

  // Optional Ad Audio Master Track (identical for Version A & B when enabled)
  const adAudioMasterPath = await buildAdAudioMasterWav({
    jobDir,
    mainDurationSec,
    endplateDurationSec,
    layers: adLayers,
    adAudioAssetsMap,
  });
  const totalDurationExactSec = Number((mainDurationSec + endplateDurationSec).toFixed(3));

  // Step 5: Build Version B (Без музыки, без звукового логотипа + опциональное рекламное аудио)
  report(5, 'Кодирование Версии Б (MP4 H.264/AAC)', 'Без музыки и без звукового логотипа');
  if (adAudioMasterPath) {
    await runCommand(
      'ffmpeg',
      [
        '-y',
        '-i',
        masterVideoFileName,
        '-i',
        'main_audio.wav',
        '-f',
        'lavfi',
        '-t',
        String(endplateDurationSec),
        '-i',
        'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-i',
        path.basename(adAudioMasterPath),
        '-filter_complex',
        '[1:a][2:a]concat=n=2:v=0:a=1[bbase];[bbase][3:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=level_in=1:level_out=1:limit=0.95:attack=5:release=50[aout]',
        '-map',
        '0:v',
        '-map',
        '[aout]',
        '-t',
        totalDurationExactSec.toFixed(3),
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '18',
        '-profile:v',
        'high',
        '-level',
        '4.2',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ar',
        '48000',
        '-movflags',
        '+faststart',
        'version_b.mp4',
      ],
      jobDir,
    );
  } else {
    await runCommand(
      'ffmpeg',
      [
        '-y',
        '-i',
        masterVideoFileName,
        '-i',
        'main_audio.wav',
        '-f',
        'lavfi',
        '-t',
        String(endplateDurationSec),
        '-i',
        'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-filter_complex',
        '[1:a][2:a]concat=n=2:v=0:a=1[aout]',
        '-map',
        '0:v',
        '-map',
        '[aout]',
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '18',
        '-profile:v',
        'high',
        '-level',
        '4.2',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ar',
        '48000',
        '-movflags',
        '+faststart',
        'version_b.mp4',
      ],
      jobDir,
    );
  }

  // Step 6: Build Version A (копируем уже закодированный видеопоток из version_b.mp4 + микс аудио/логотипа + то же рекламное аудио)
  report(6, 'Сборка Версии А (MP4 H.264/AAC)', 'Оригинальная речь + музыка + звуковой логотип');
  const musicAsset = useUploadedMusic ? assets.music : undefined;
  const fadeOutStart = Math.max(0, endplateDurationSec - 0.25);

  if (musicAsset && fs.existsSync(musicAsset.filePath)) {
    const musicFadeOut = Math.max(0, mainDurationSec - 0.6);
    const verAInputs = [
      '-y',
      '-i',
      'version_b.mp4',
      '-i',
      'main_audio.wav',
      '-stream_loop',
      '-1',
      '-t',
      String(mainDurationSec),
      '-i',
      path.resolve(musicAsset.filePath),
      '-t',
      String(endplateDurationSec),
      '-i',
      resolvedAudioLogoPath,
    ];
    const verAFilters = [
      `[2:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${musicGainDb}dB,afade=t=in:st=0:d=0.4,afade=t=out:st=${musicFadeOut}:d=0.6[m1]`,
      `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a1]`,
      `[a1][m1]amix=inputs=2:duration=first:dropout_transition=0,volume=2.0[mainmix]`,
      `[3:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,afade=t=in:st=0:d=0.05,afade=t=out:st=${fadeOutStart}:d=0.25[logo]`,
    ];

    if (adAudioMasterPath) {
      verAInputs.push('-i', path.basename(adAudioMasterPath));
      verAFilters.push(
        `[mainmix][logo]concat=n=2:v=0:a=1[abase]`,
        `[abase][4:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=level_in=1:level_out=1:limit=0.95:attack=5:release=50[aout]`,
      );
    } else {
      verAFilters.push(`[mainmix][logo]concat=n=2:v=0:a=1[aout]`);
    }

    await runCommand(
      'ffmpeg',
      [
        ...verAInputs,
        '-filter_complex',
        verAFilters.join(';'),
        '-map',
        '0:v',
        '-map',
        '[aout]',
        ...(adAudioMasterPath ? ['-t', totalDurationExactSec.toFixed(3)] : []),
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ar',
        '48000',
        '-movflags',
        '+faststart',
        'version_a.mp4',
      ],
      jobDir,
    );
  } else {
    const verAInputs = [
      '-y',
      '-i',
      'version_b.mp4',
      '-i',
      'main_audio.wav',
      '-t',
      String(endplateDurationSec),
      '-i',
      resolvedAudioLogoPath,
    ];
    const verAFilters = [
      `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a1]`,
      `[2:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,afade=t=in:st=0:d=0.05,afade=t=out:st=${fadeOutStart}:d=0.25[logo]`,
    ];

    if (adAudioMasterPath) {
      verAInputs.push('-i', path.basename(adAudioMasterPath));
      verAFilters.push(
        `[a1][logo]concat=n=2:v=0:a=1[abase]`,
        `[abase][3:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=level_in=1:level_out=1:limit=0.95:attack=5:release=50[aout]`,
      );
    } else {
      verAFilters.push(`[a1][logo]concat=n=2:v=0:a=1[aout]`);
    }

    await runCommand(
      'ffmpeg',
      [
        ...verAInputs,
        '-filter_complex',
        verAFilters.join(';'),
        '-map',
        '0:v',
        '-map',
        '[aout]',
        ...(adAudioMasterPath ? ['-t', totalDurationExactSec.toFixed(3)] : []),
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ar',
        '48000',
        '-movflags',
        '+faststart',
        'version_a.mp4',
      ],
      jobDir,
    );
  }

  const versionAPath = path.join(jobDir, 'version_a.mp4');
  const versionBPath = path.join(jobDir, 'version_b.mp4');

  const [probeA, probeB] = await Promise.all([probeMedia(versionAPath), probeMedia(versionBPath)]);

  return {
    jobId,
    createdAt: new Date().toISOString(),
    mainDurationSec: Number(mainDurationSec.toFixed(2)),
    endplateDurationSec: Number(endplateDurationSec.toFixed(2)),
    totalDurationSec: Number((mainDurationSec + endplateDurationSec).toFixed(2)),
    versionA: {
      version: 'A',
      title: 'Версия А — основная (MP4, H.264/AAC, речь + музыка + звуковой логотип)',
      url: `${exportBaseUrl}/${jobId}/version_a.mp4`,
      fileName: `delo_v_kadre_short_01_version_A.mp4`,
      probe: probeA,
    },
    versionB: {
      version: 'B',
      title: 'Версия Б — без музыки (MP4, H.264/AAC, речь + тишина на заставке)',
      url: `${exportBaseUrl}/${jobId}/version_b.mp4`,
      fileName: `delo_v_kadre_short_01_version_B.mp4`,
      probe: probeB,
    },
  };
}
