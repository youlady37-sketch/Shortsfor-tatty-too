import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AutoFrameKeyframe, SegmentAutoFrameResult } from '../types.ts';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const YUNET_MODEL_PATH = path.join(__dirname, 'models', 'face_detection_yunet_2023mar.onnx');

export interface DetectedFace {
  x: number; // normalized 0..1
  y: number; // normalized 0..1
  w: number; // normalized 0..1
  h: number; // normalized 0..1
  score: number;
  rightEyeX: number;
  leftEyeX: number;
  noseX: number;
}

interface RawFrameSample {
  t: number; // local seconds inside segment [0..segDur]
  bgr: Uint8Array;
  width: number;
  height: number;
}

interface OpenCvRuntime {
  cv: any;
  detector: any;
}

let cvRuntimePromise: Promise<OpenCvRuntime> | null = null;
let detectorMutex: Promise<void> = Promise.resolve();

async function withDetectorLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = detectorMutex;
  let release!: () => void;
  detectorMutex = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function getOpenCvRuntime(): Promise<OpenCvRuntime> {
  if (!cvRuntimePromise) {
    cvRuntimePromise = (async () => {
      if (!fs.existsSync(YUNET_MODEL_PATH)) {
        throw new Error(`Не найдена модель детекции лиц: ${YUNET_MODEL_PATH}`);
      }
      const mod = require('@techstark/opencv-js');
      const cv = mod && typeof mod.Mat === 'function' ? mod : await mod;
      const modelBytes = fs.readFileSync(YUNET_MODEL_PATH);
      try {
        cv.FS_createDataFile('/', 'yunet_face.onnx', modelBytes, true, false, false);
      } catch {
        // file already exists in WASM virtual FS
      }
      const detector = new cv.FaceDetectorYN(
        'yunet_face.onnx',
        '',
        new cv.Size(320, 240),
        0.42,
        0.3,
        5000,
      );
      return { cv, detector };
    })();
  }
  return cvRuntimePromise;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function centerXNormToCropOffsetX(centerXNorm: number, cropWidthNorm: number): number {
  const halfCrop = cropWidthNorm / 2;
  const clampedCenter = clamp(centerXNorm, halfCrop, 1 - halfCrop);
  const availSpan = 1 - cropWidthNorm;
  if (availSpan <= 1e-5) return 0;
  const leftRatio = clamp((clampedCenter - halfCrop) / availSpan, 0, 1);
  return Math.round(clamp(leftRatio * 200 - 100, -100, 100));
}

export function cropOffsetXToCenterXNorm(cropOffsetX: number, cropWidthNorm: number): number {
  const halfCrop = cropWidthNorm / 2;
  const availSpan = Math.max(0, 1 - cropWidthNorm);
  const ratio = clamp((cropOffsetX + 100) / 200, 0, 1);
  return halfCrop + ratio * availSpan;
}

function extractBgrFramesWithFfmpeg(params: {
  filePath: string;
  startSec: number;
  durationSec: number;
  sampleFps: number;
  analysisW: number;
  analysisH: number;
}): Promise<RawFrameSample[]> {
  const { filePath, startSec, durationSec, sampleFps, analysisW, analysisH } = params;

  return new Promise((resolve, reject) => {
    const vf = `fps=${sampleFps.toFixed(4)},scale=${analysisW}:${analysisH}:flags=bilinear`;
    const args = [
      '-v',
      'error',
      '-ss',
      startSec.toFixed(3),
      '-t',
      durationSec.toFixed(3),
      '-i',
      filePath,
      '-vf',
      vf,
      '-an',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'bgr24',
      'pipe:1',
    ];

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0 && chunks.length === 0) {
        reject(new Error(`Ошибка извлечения кадров ffmpeg: ${stderr.trim()}`));
        return;
      }
      const combined = Buffer.concat(chunks);
      const frameBytes = analysisW * analysisH * 3;
      const frameCount = Math.floor(combined.length / frameBytes);
      const samples: RawFrameSample[] = [];
      for (let i = 0; i < frameCount; i += 1) {
        const offset = i * frameBytes;
        const bgr = new Uint8Array(combined.buffer, combined.byteOffset + offset, frameBytes);
        const t = Number((i / sampleFps).toFixed(3));
        if (t <= durationSec + 0.05) {
          samples.push({
            t: Math.min(durationSec, t),
            bgr,
            width: analysisW,
            height: analysisH,
          });
        }
      }
      resolve(samples);
    });
  });
}

function computeFrameMad(prev: Uint8Array, curr: Uint8Array): number {
  const len = Math.min(prev.length, curr.length);
  if (len === 0) return 0;
  let diffSum = 0;
  let count = 0;
  // Subsample every 12th byte (4th pixel across BGR) for fast O(N) shot-cut estimation
  for (let i = 0; i < len; i += 12) {
    diffSum += Math.abs(curr[i] - prev[i]);
    if (i + 1 < len) diffSum += Math.abs(curr[i + 1] - prev[i + 1]);
    if (i + 2 < len) diffSum += Math.abs(curr[i + 2] - prev[i + 2]);
    count += 3;
  }
  return count > 0 ? diffSum / (count * 255) : 0;
}

/**
 * Estimates torso/upper-body horizontal center directly below a detected face,
 * rejecting uniform background and clamping strictly so the head is never clipped.
 */
function computePersonCenterFromFace(
  face: DetectedFace,
  bgr: Uint8Array,
  w: number,
  h: number,
  cropWidthNorm: number,
): { centerXNorm: number; centerYNorm: number } {
  const faceCenterX = face.x + face.w / 2;
  const faceCenterY = face.y + face.h / 2;
  const halfCrop = cropWidthNorm / 2;

  // 1. Subtle gaze / yaw room: when speaker looks slightly left or right,
  // torso usually sits slightly behind the nose direction while keeping gaze room.
  const eyeMidX = (face.rightEyeX + face.leftEyeX) / 2;
  const eyeSpan = Math.max(face.w * 0.25, Math.abs(face.leftEyeX - face.rightEyeX));
  const yaw = clamp((face.noseX - eyeMidX) / eyeSpan, -0.65, 0.65);

  // 2. Analyze foreground torso mass in upper-body band below the chin
  const torsoTopPx = clamp(Math.round((face.y + face.h * 0.85) * h), 0, h - 1);
  const torsoBotPx = clamp(Math.round((face.y + face.h * 3.1) * h), torsoTopPx + 1, h);
  const roiLeftPx = clamp(Math.round((faceCenterX - face.w * 1.45) * w), 0, w - 1);
  const roiRightPx = clamp(Math.round((faceCenterX + face.w * 1.45) * w), roiLeftPx + 1, w);

  // Estimate outer background luminance from top corners
  let bgSum = 0;
  let bgCnt = 0;
  const cornerRows = Math.max(2, Math.floor(h * 0.12));
  const cornerCols = Math.max(2, Math.floor(w * 0.08));
  for (let y = 0; y < cornerRows; y += 2) {
    for (let x = 0; x < cornerCols; x += 2) {
      for (const cx of [x, w - 1 - x]) {
        const idx = (y * w + cx) * 3;
        bgSum += 0.114 * bgr[idx] + 0.587 * bgr[idx + 1] + 0.299 * bgr[idx + 2];
        bgCnt += 1;
      }
    }
  }
  const bgLuma = bgCnt > 0 ? bgSum / bgCnt : 30;

  let weightedX = 0;
  let weightTotal = 0;
  for (let y = torsoTopPx; y < torsoBotPx; y += 2) {
    for (let x = roiLeftPx; x < roiRightPx; x += 2) {
      const idx = (y * w + x) * 3;
      const b = bgr[idx];
      const g = bgr[idx + 1];
      const r = bgr[idx + 2];
      const luma = 0.114 * b + 0.587 * g + 0.299 * r;
      const dx = x > 0 ? Math.abs(luma - (0.114 * bgr[idx - 3] + 0.587 * bgr[idx - 2] + 0.299 * bgr[idx - 1])) : 0;
      // Weight pixels near faceCenterX smoothly (Gaussian prior) to reject far-side bookshelves
      const xNorm = (x + 0.5) / w;
      const distNorm = (xNorm - faceCenterX) / Math.max(0.08, face.w * 1.15);
      const spatialPrior = Math.exp(-0.5 * distNorm * distNorm);
      const contrast = Math.min(80, Math.abs(luma - bgLuma) * 0.6 + dx * 0.9);
      const weight = contrast * spatialPrior;
      weightedX += xNorm * weight;
      weightTotal += weight;
    }
  }

  const torsoEstX = weightTotal > 50 ? weightedX / weightTotal : faceCenterX;

  // Blend: 78% face anchor + 17% upper-body torso balance + 5% subtle lead room
  const rawCenter = faceCenterX * 0.78 + torsoEstX * 0.17 + yaw * face.w * 0.08;

  // Hard face-containment clamp: face + head safety margin must stay inside [cropLeft..cropRight]
  const safeFacePad = Math.min(face.w * 0.24, Math.max(0.02, (cropWidthNorm - face.w) * 0.35));
  const minAllowedCenter = Math.max(halfCrop, face.x + face.w + safeFacePad - halfCrop);
  const maxAllowedCenter = Math.min(1 - halfCrop, face.x - safeFacePad + halfCrop);

  let finalCenter: number;
  if (minAllowedCenter <= maxAllowedCenter) {
    finalCenter = clamp(rawCenter, minAllowedCenter, maxAllowedCenter);
  } else {
    // Face wider than crop (ultra extreme closeup): center strictly on face
    finalCenter = clamp(faceCenterX, halfCrop, 1 - halfCrop);
  }

  const centerYNorm = clamp(faceCenterY + face.h * 0.45, 0.2, 0.8);
  return { centerXNorm: finalCenter, centerYNorm };
}

/**
 * Fallback foreground/person saliency when an entire continuous shot has zero detected faces
 * (e.g. heavy shadow silhouette or back of head). Rejects bottom lower-thirds (y > 0.78).
 */
function estimateForegroundFallbackCenter(
  bgr: Uint8Array,
  prevBgr: Uint8Array | null,
  w: number,
  h: number,
  cropWidthNorm: number,
): { centerXNorm: number; confidence: number } {
  const halfCrop = cropWidthNorm / 2;
  const colScore = new Float64Array(w);

  // Estimate border background luma (top & side edges)
  let bgSum = 0;
  let bgCount = 0;
  for (let y = 0; y < Math.floor(h * 0.12); y += 2) {
    for (let x = 0; x < w; x += 4) {
      const idx = (y * w + x) * 3;
      bgSum += 0.114 * bgr[idx] + 0.587 * bgr[idx + 1] + 0.299 * bgr[idx + 2];
      bgCount += 1;
    }
  }
  const bgLuma = bgCount > 0 ? bgSum / bgCount : 40;

  const yStart = Math.floor(h * 0.1);
  const yEnd = Math.floor(h * 0.76); // skip lower-third banners

  for (let y = yStart; y < yEnd; y += 2) {
    // Prefer upper-body portrait band (y ~ 0.25..0.55)
    const yNorm = y / h;
    const yWeight = yNorm < 0.6 ? 1.15 : 0.75;
    for (let x = 1; x < w - 1; x += 2) {
      const idx = (y * w + x) * 3;
      const b = bgr[idx];
      const g = bgr[idx + 1];
      const r = bgr[idx + 2];
      const luma = 0.114 * b + 0.587 * g + 0.299 * r;

      // Skin-warmth heuristic (R > G > B in YCbCr-like space)
      const isWarmSkin = r > 55 && r > g + 8 && g > b + 4 && r - b > 18 ? 1.8 : 0;

      // Vertical edge contrast
      const idxPrev = idx - 3;
      const prevLuma = 0.114 * bgr[idxPrev] + 0.587 * bgr[idxPrev + 1] + 0.299 * bgr[idxPrev + 2];
      const edge = Math.abs(luma - prevLuma);

      // Motion relative to previous frame
      let motion = 0;
      if (prevBgr) {
        motion =
          (Math.abs(b - prevBgr[idx]) +
            Math.abs(g - prevBgr[idx + 1]) +
            Math.abs(r - prevBgr[idx + 2])) /
          3;
      }

      const bgDiff = Math.abs(luma - bgLuma);
      const s = (bgDiff * 0.35 + edge * 0.55 + motion * 1.1 + isWarmSkin * 18) * yWeight;
      colScore[x] += s;
    }
  }

  // Sliding window integral over cropWidthPx to find best vertical crop window
  const cropPx = Math.max(8, Math.round(cropWidthNorm * w));
  let bestWindowSum = -1;
  let bestCenterPx = w / 2;
  let totalEnergy = 0;
  for (let x = 0; x < w; x += 1) totalEnergy += colScore[x];

  if (totalEnergy <= 1e-3) {
    return { centerXNorm: 0.5, confidence: 0 };
  }

  let running = 0;
  for (let x = 0; x < cropPx && x < w; x += 1) running += colScore[x];
  bestWindowSum = running;
  bestCenterPx = cropPx / 2;

  for (let left = 1; left + cropPx <= w; left += 1) {
    running += colScore[left + cropPx - 1] - colScore[left - 1];
    // Gentle center tie-breaker (5%) so symmetric backgrounds don't drift arbitrarily
    const candidateCenter = left + cropPx / 2;
    const centerBias = 1 - 0.06 * Math.abs(candidateCenter / w - 0.5);
    if (running * centerBias > bestWindowSum) {
      bestWindowSum = running * centerBias;
      bestCenterPx = candidateCenter;
    }
  }

  const ratio = bestWindowSum / Math.max(1, totalEnergy);
  return {
    centerXNorm: clamp(bestCenterPx / w, halfCrop, 1 - halfCrop),
    confidence: clamp(ratio, 0, 1),
  };
}

/**
 * Computes optimal horizontal target for single or multiple faces in a frame.
 * Pure exported helper for deterministic testing as well as runtime analysis.
 */
export function selectTargetCenterForFaces(params: {
  faces: DetectedFace[];
  bgr: Uint8Array;
  width: number;
  height: number;
  cropWidthNorm: number;
  prevTrackedX: number | null;
}): {
  centerXNorm: number;
  centerYNorm: number;
  mode: 'single' | 'multi-fit' | 'multi-primary';
} {
  const { faces, bgr, width, height, cropWidthNorm, prevTrackedX } = params;
  const halfCrop = cropWidthNorm / 2;

  if (faces.length === 1) {
    const res = computePersonCenterFromFace(faces[0], bgr, width, height, cropWidthNorm);
    return { ...res, mode: 'single' };
  }

  // Filter out tiny background faces (< 42% height of largest face)
  const maxH = Math.max(...faces.map((f) => f.h));
  const primaryFaces = faces
    .filter((f) => f.h >= maxH * 0.42 && f.score >= 0.42)
    .sort((a, b) => b.w * b.h * b.score - a.w * a.h * a.score);

  const candidates = primaryFaces.length > 0 ? primaryFaces : faces;
  if (candidates.length === 1) {
    const res = computePersonCenterFromFace(candidates[0], bgr, width, height, cropWidthNorm);
    return { ...res, mode: 'single' };
  }

  // Check if all main participants fit comfortably inside the 9:16 crop width
  const spanLeft = Math.min(...candidates.map((f) => f.x - f.w * 0.16));
  const spanRight = Math.max(...candidates.map((f) => f.x + f.w * 1.16));
  const facesSpan = spanRight - spanLeft;

  if (facesSpan <= cropWidthNorm * 0.96) {
    const groupCenter = clamp((spanLeft + spanRight) / 2, halfCrop, 1 - halfCrop);
    // Clamp so neither outer face edge is clipped
    const minC = Math.max(halfCrop, spanRight - halfCrop);
    const maxC = Math.min(1 - halfCrop, spanLeft + halfCrop);
    const finalX = minC <= maxC ? clamp(groupCenter, minC, maxC) : groupCenter;
    const avgY =
      candidates.reduce((acc, f) => acc + f.y + f.h * 0.5, 0) / candidates.length;
    return {
      centerXNorm: finalX,
      centerYNorm: clamp(avgY + 0.1, 0.2, 0.8),
      mode: 'multi-fit',
    };
  }

  // If >2 people and top-2 fit together, try top-2
  if (candidates.length > 2) {
    const topTwo = candidates.slice(0, 2);
    const twoLeft = Math.min(...topTwo.map((f) => f.x - f.w * 0.14));
    const twoRight = Math.max(...topTwo.map((f) => f.x + f.w * 1.14));
    if (twoRight - twoLeft <= cropWidthNorm * 0.96) {
      const twoCenter = clamp((twoLeft + twoRight) / 2, halfCrop, 1 - halfCrop);
      const minC = Math.max(halfCrop, twoRight - halfCrop);
      const maxC = Math.min(1 - halfCrop, twoLeft + halfCrop);
      const finalX = minC <= maxC ? clamp(twoCenter, minC, maxC) : twoCenter;
      const avgY = topTwo.reduce((acc, f) => acc + f.y + f.h * 0.5, 0) / 2;
      return {
        centerXNorm: finalX,
        centerYNorm: clamp(avgY + 0.1, 0.2, 0.8),
        mode: 'multi-fit',
      };
    }
  }

  // Participants are too wide apart for simultaneous 9:16 framing:
  // lock onto the dominant person with stability hysteresis so camera never ping-pongs
  let chosen = candidates[0];
  const bestProm = chosen.w * chosen.h * chosen.score;
  if (prevTrackedX !== null) {
    const nearPrev = candidates
      .filter((f) => f.w * f.h * f.score >= bestProm * 0.72)
      .sort(
        (a, b) =>
          Math.abs(a.x + a.w / 2 - prevTrackedX) - Math.abs(b.x + b.w / 2 - prevTrackedX),
      )[0];
    if (nearPrev && Math.abs(nearPrev.x + nearPrev.w / 2 - prevTrackedX) < cropWidthNorm * 0.45) {
      chosen = nearPrev;
    }
  }

  const res = computePersonCenterFromFace(chosen, bgr, width, height, cropWidthNorm);
  return { ...res, mode: 'multi-primary' };
}

export interface FrameObservation {
  t: number;
  hasFace: boolean;
  maxFaceScore?: number;
  targetX: number | null;
  targetY: number;
  faceCount: number;
  fitBounds?: { left: number; right: number } | null;
  fallbackX: number;
  fallbackConfidence: number;
  shotCut: boolean;
  mode: 'single' | 'multi-fit' | 'multi-primary' | 'none';
}

/**
 * Shot-aware temporal smoother:
 * - Splits at hard shot cuts so camera snaps cleanly at scene cuts without sliding across unrelated shots.
 * - Backward-fills leading frames before first detection inside a shot.
 * - Holds last reliable face position during temporary occlusion instead of snapping to 0.5 center.
 * - Applies deadzone + zero-phase forward/backward EMA + velocity clamp + face containment guard.
 */
export function buildSmoothedCameraTrack(
  observations: FrameObservation[],
  cropWidthNorm: number,
): AutoFrameKeyframe[] {
  if (observations.length === 0) return [];
  const halfCrop = cropWidthNorm / 2;

  // Partition into continuous shots
  const shots: FrameObservation[][] = [];
  let currentShot: FrameObservation[] = [];
  for (const obs of observations) {
    if (obs.shotCut && currentShot.length > 0) {
      shots.push(currentShot);
      currentShot = [obs];
    } else {
      currentShot.push(obs);
    }
  }
  if (currentShot.length > 0) shots.push(currentShot);

  const output: AutoFrameKeyframe[] = [];

  for (const shot of shots) {
    const n = shot.length;
    const rawX = new Array<number>(n);
    const rawY = new Array<number>(n);

    const faceIndices: number[] = [];
    for (let i = 0; i < n; i += 1) {
      if (shot[i].hasFace && shot[i].targetX !== null) {
        faceIndices.push(i);
      }
    }
    const isIsolatedWeakOutlier =
      n >= 5 &&
      faceIndices.length === 1 &&
      (shot[faceIndices[0]].maxFaceScore ?? 0.7) < 0.65;

    const firstFaceIdx = isIsolatedWeakOutlier ? -1 : (faceIndices[0] ?? -1);
    if (firstFaceIdx !== -1) {
      // Backward-fill leading occluded frames with first face position in this shot
      let lastReliableX = shot[firstFaceIdx].targetX!;
      let lastReliableY = shot[firstFaceIdx].targetY;
      for (let i = 0; i < n; i += 1) {
        if (shot[i].hasFace && shot[i].targetX !== null) {
          lastReliableX = shot[i].targetX!;
          lastReliableY = shot[i].targetY;
        }
        // If face temporarily disappears, hold lastReliableX instead of snapping to center!
        rawX[i] = lastReliableX;
        rawY[i] = lastReliableY;
      }
    } else {
      // Zero faces in entire shot -> use smoothed foreground saliency if confident, else 0.5
      let weightSum = 0;
      let weightedX = 0;
      for (const o of shot) {
        const w = o.fallbackConfidence > 0.25 ? o.fallbackConfidence : 0;
        weightedX += o.fallbackX * w;
        weightSum += w;
      }
      const fallbackCenter =
        weightSum > 0.25 ? clamp(weightedX / weightSum, halfCrop, 1 - halfCrop) : 0.5;
      for (let i = 0; i < n; i += 1) {
        rawX[i] = shot[i].fallbackConfidence > 0.45 ? shot[i].fallbackX : fallbackCenter;
        rawY[i] = 0.45;
      }
    }

    // 1. Deadzone stabilization (suppress micro-jitter < 2% of crop width)
    const deadzone = Math.max(0.008, cropWidthNorm * 0.025);
    const dzX = new Array<number>(n);
    dzX[0] = rawX[0];
    for (let i = 1; i < n; i += 1) {
      dzX[i] = Math.abs(rawX[i] - dzX[i - 1]) < deadzone ? dzX[i - 1] : rawX[i];
    }

    // 2. Forward-backward zero-phase EMA smoothing
    const alpha = 0.3;
    const fwd = new Array<number>(n);
    fwd[0] = dzX[0];
    for (let i = 1; i < n; i += 1) {
      fwd[i] = fwd[i - 1] + alpha * (dzX[i] - fwd[i - 1]);
    }
    const bwd = new Array<number>(n);
    bwd[n - 1] = fwd[n - 1];
    for (let i = n - 2; i >= 0; i -= 1) {
      bwd[i] = bwd[i + 1] + alpha * (fwd[i] - bwd[i + 1]);
    }

    // 3. Velocity clamp (max horizontal pan speed = 0.22 frame width / sec) + head-protection clamp
    const smoothedX = new Array<number>(n);
    smoothedX[0] = clamp(bwd[0], halfCrop, 1 - halfCrop);
    for (let i = 1; i < n; i += 1) {
      const dt = Math.max(0.1, shot[i].t - shot[i - 1].t);
      const maxDelta = 0.22 * dt;
      const desired = bwd[i];
      const stepped =
        smoothedX[i - 1] + clamp(desired - smoothedX[i - 1], -maxDelta, maxDelta);
      let safeCenter = clamp(stepped, halfCrop, 1 - halfCrop);

      // Strict head-safety guarantee: if smoothing lagged and would clip a detected face, pull minimally
      const bounds = shot[i].fitBounds;
      if (bounds) {
        const minC = Math.max(halfCrop, bounds.right - halfCrop);
        const maxC = Math.min(1 - halfCrop, bounds.left + halfCrop);
        if (minC <= maxC) {
          safeCenter = clamp(safeCenter, minC, maxC);
        }
      }
      smoothedX[i] = safeCenter;
    }

    for (let i = 0; i < n; i += 1) {
      const cx = Number(smoothedX[i].toFixed(4));
      const cy = Number(rawY[i].toFixed(4));
      output.push({
        t: shot[i].t,
        centerXNorm: cx,
        centerYNorm: cy,
        cropOffsetX: centerXNormToCropOffsetX(cx, cropWidthNorm),
        faceCount: shot[i].faceCount,
        shotCut: i === 0 ? shot[i].shotCut : false,
      });
    }
  }

  return output;
}

/**
 * Builds an FFmpeg crop `x` expression from AutoFrameKeyframes.
 * Uses depth-1 sum of `gte(t,...)*lt(t,...)` linear interpolations (no deep nesting),
 * holding cleanly across hard shot cuts without sliding over cut frames.
 */
export function buildDynamicCropXExpr(params: {
  keyframes: AutoFrameKeyframe[];
  srcW: number;
  cropW: number;
}): { isDynamic: boolean; staticX: number; xExpr: string } {
  const { keyframes, srcW, cropW } = params;
  const maxX = Math.max(0, srcW - cropW);
  if (maxX <= 0 || keyframes.length === 0) {
    return { isDynamic: false, staticX: Math.round(maxX / 2), xExpr: String(Math.round(maxX / 2)) };
  }

  const pts = keyframes.map((kf) => ({
    t: kf.t,
    x: clamp(Math.round((kf.centerXNorm - cropW / (2 * srcW)) * srcW), 0, maxX),
    shotCut: Boolean(kf.shotCut),
  }));

  const xs = pts.map((p) => p.x);
  const minXVal = Math.min(...xs);
  const maxXVal = Math.max(...xs);
  if (maxXVal - minXVal <= 4) {
    const avgX = clamp(Math.round(xs.reduce((a, b) => a + b, 0) / xs.length), 0, maxX);
    return { isDynamic: false, staticX: avgX, xExpr: String(avgX) };
  }

  // Simplify consecutive points with identical X (keeping transitions & shotCuts)
  const simplified: typeof pts = [pts[0]];
  for (let i = 1; i < pts.length - 1; i += 1) {
    const prev = simplified[simplified.length - 1];
    const curr = pts[i];
    const next = pts[i + 1];
    if (!curr.shotCut && !next.shotCut && curr.x === prev.x && curr.x === next.x) {
      continue;
    }
    simplified.push(curr);
  }
  if (pts.length > 1) {
    simplified.push(pts[pts.length - 1]);
  }

  // Cap keyframes at 40 while preserving start, end, and any hard shotCut frames
  const capped =
    simplified.length <= 40
      ? simplified
      : simplified.filter(
          (pt, idx) =>
            idx === 0 || idx === simplified.length - 1 || pt.shotCut || idx % 2 === 0,
        );

  const terms: string[] = [];
  for (let i = 0; i < capped.length - 1; i += 1) {
    const a = capped[i];
    const b = capped[i + 1];
    const dt = Math.max(0.05, b.t - a.t);
    const t0 = a.t.toFixed(3);
    const t1 = b.t.toFixed(3);
    if (b.shotCut || a.x === b.x) {
      // Hold position up to cut or when stationary
      terms.push(`gte(t,${t0})*lt(t,${t1})*${a.x}`);
    } else {
      const dx = b.x - a.x;
      terms.push(`gte(t,${t0})*lt(t,${t1})*(${a.x}+(${dx})*(t-${t0})/${dt.toFixed(3)})`);
    }
  }
  const last = capped[capped.length - 1];
  terms.push(`gte(t,${last.t.toFixed(3)})*${last.x}`);

  const expr = `clip(${terms.join('+')},0,${maxX})`;
  return {
    isDynamic: true,
    staticX: capped[0].x,
    xExpr: expr,
  };
}

const analysisCache = new Map<string, SegmentAutoFrameResult>();
const MAX_CACHE_ENTRIES = 64;

export async function analyzeSegmentAutoFraming(params: {
  filePath: string;
  sizeBytes?: number;
  srcWidth: number;
  srcHeight: number;
  startSec: number;
  endSec: number;
  segmentId?: string;
}): Promise<SegmentAutoFrameResult> {
  const { filePath, sizeBytes = 0, srcWidth, srcHeight, startSec, endSec, segmentId } = params;
  const dur = Math.max(0.2, endSec - startSec);
  const srcW = srcWidth || 1920;
  const srcH = srcHeight || 1080;

  // Compute exact 9:16 crop width ratio
  const cropH = Math.floor(srcH / 2) * 2;
  const cropW = srcW / srcH > 9 / 16 ? Math.floor(((cropH * 9) / 16) / 2) * 2 : srcW;
  const cropWidthNorm = clamp(cropW / srcW, 0.1, 1.0);

  if (cropWidthNorm >= 0.995) {
    return {
      segmentId,
      strategy: 'center-fallback',
      facesDetectedFrames: 0,
      totalSampledFrames: 1,
      maxFacesInFrame: 0,
      recommendedCropOffsetX: 0,
      keyframes: [
        {
          t: 0,
          centerXNorm: 0.5,
          centerYNorm: 0.5,
          cropOffsetX: 0,
          faceCount: 0,
        },
      ],
    };
  }

  const cacheKey = `${path.resolve(filePath)}|${sizeBytes}|${startSec.toFixed(2)}|${endSec.toFixed(2)}|${srcW}x${srcH}`;
  const cached = analysisCache.get(cacheKey);
  if (cached) {
    return segmentId ? { ...cached, segmentId } : cached;
  }

  const analysisW = 320;
  const analysisH = Math.max(90, Math.round((analysisW * srcH) / srcW / 2) * 2);

  // Adaptive sampling rate: ~2.5 fps for typical Shorts segments (6..45 frames)
  let sampleFps = dur <= 16 ? 2.5 : dur <= 35 ? 1.8 : 48 / dur;
  sampleFps = clamp(sampleFps, 0.5, 4);
  if (dur * sampleFps < 4) {
    sampleFps = clamp(4 / dur, 1, 8);
  }

  const frames = await extractBgrFramesWithFfmpeg({
    filePath,
    startSec,
    durationSec: dur,
    sampleFps,
    analysisW,
    analysisH,
  });

  if (frames.length === 0) {
    return {
      segmentId,
      strategy: 'center-fallback',
      facesDetectedFrames: 0,
      totalSampledFrames: 0,
      maxFacesInFrame: 0,
      recommendedCropOffsetX: 0,
      keyframes: [
        {
          t: 0,
          centerXNorm: 0.5,
          centerYNorm: 0.5,
          cropOffsetX: 0,
          faceCount: 0,
        },
      ],
    };
  }

  const runtime = await getOpenCvRuntime();
  const observations: FrameObservation[] = [];

  let facesDetectedFrames = 0;
  let maxFacesInFrame = 0;
  let usedMultiFaceFit = false;
  let prevBgr: Uint8Array | null = null;
  let prevTrackedX: number | null = null;

  await withDetectorLock(() => {
    const { cv, detector } = runtime;
    detector.setInputSize(new cv.Size(analysisW, analysisH));

    for (let i = 0; i < frames.length; i += 1) {
      const frame = frames[i];
      const mad = prevBgr ? computeFrameMad(prevBgr, frame.bgr) : 0;
      const shotCut = mad > 0.22;
      if (shotCut) {
        prevTrackedX = null;
      }

      const mat = new cv.Mat(analysisH, analysisW, cv.CV_8UC3);
      const facesMat = new cv.Mat();
      let detected: DetectedFace[] = [];

      try {
        mat.data.set(frame.bgr);
        detector.detect(mat, facesMat);

        for (let r = 0; r < facesMat.rows; r += 1) {
          const fx = facesMat.floatAt(r, 0);
          const fy = facesMat.floatAt(r, 1);
          const fw = facesMat.floatAt(r, 2);
          const fh = facesMat.floatAt(r, 3);
          const score = facesMat.floatAt(r, 14);
          if (fw < 8 || fh < 10 || score < 0.42) continue;

          detected.push({
            x: clamp(fx / analysisW, 0, 1),
            y: clamp(fy / analysisH, 0, 1),
            w: clamp(fw / analysisW, 0, 1),
            h: clamp(fh / analysisH, 0, 1),
            score,
            rightEyeX: clamp(facesMat.floatAt(r, 4) / analysisW, 0, 1),
            leftEyeX: clamp(facesMat.floatAt(r, 6) / analysisW, 0, 1),
            noseX: clamp(facesMat.floatAt(r, 8) / analysisW, 0, 1),
          });
        }
      } finally {
        mat.delete();
        facesMat.delete();
      }

      const fallback = estimateForegroundFallbackCenter(
        frame.bgr,
        prevBgr,
        analysisW,
        analysisH,
        cropWidthNorm,
      );

      if (detected.length > 0) {
        facesDetectedFrames += 1;
        maxFacesInFrame = Math.max(maxFacesInFrame, detected.length);
        const target = selectTargetCenterForFaces({
          faces: detected,
          bgr: frame.bgr,
          width: analysisW,
          height: analysisH,
          cropWidthNorm,
          prevTrackedX,
        });
        prevTrackedX = target.centerXNorm;
        if (target.mode === 'multi-fit') usedMultiFaceFit = true;

        // Compute strict face-head protection bounds for post-smoothing verification
        let fitBounds: { left: number; right: number } | null = null;
        if (detected.length === 1) {
          const f = detected[0];
          const pad = Math.min(f.w * 0.16, Math.max(0.015, (cropWidthNorm - f.w) * 0.25));
          fitBounds = { left: f.x - pad, right: f.x + f.w + pad };
        } else if (target.mode === 'multi-fit') {
          const maxH = Math.max(...detected.map((f) => f.h));
          const active = detected.filter((f) => f.h >= maxH * 0.42);
          fitBounds = {
            left: Math.min(...active.map((f) => f.x - f.w * 0.1)),
            right: Math.max(...active.map((f) => f.x + f.w * 1.1)),
          };
        }

        const maxFaceScore = Math.max(...detected.map((f) => f.score));
        observations.push({
          t: frame.t,
          hasFace: true,
          maxFaceScore,
          targetX: target.centerXNorm,
          targetY: target.centerYNorm,
          faceCount: detected.length,
          fitBounds,
          fallbackX: fallback.centerXNorm,
          fallbackConfidence: fallback.confidence,
          shotCut,
          mode: target.mode,
        });
      } else {
        observations.push({
          t: frame.t,
          hasFace: false,
          targetX: null,
          targetY: 0.45,
          faceCount: 0,
          fitBounds: null,
          fallbackX: fallback.centerXNorm,
          fallbackConfidence: fallback.confidence,
          shotCut,
          mode: 'none',
        });
      }

      prevBgr = frame.bgr;
    }
  });

  const keyframes = buildSmoothedCameraTrack(observations, cropWidthNorm);
  const avgOffset =
    keyframes.length > 0
      ? Math.round(
          keyframes.reduce((acc, k) => acc + k.cropOffsetX, 0) / keyframes.length,
        )
      : 0;

  let strategy: SegmentAutoFrameResult['strategy'] = 'center-fallback';
  if (facesDetectedFrames > 0) {
    strategy = usedMultiFaceFit ? 'multi-face' : 'face-track';
  } else if (
    observations.some((o) => o.fallbackConfidence > 0.35) &&
    Math.abs(avgOffset) >= 5
  ) {
    strategy = 'foreground-fallback';
  }

  const result: SegmentAutoFrameResult = {
    segmentId,
    strategy,
    facesDetectedFrames,
    totalSampledFrames: frames.length,
    maxFacesInFrame,
    recommendedCropOffsetX: avgOffset,
    keyframes,
  };

  if (analysisCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = analysisCache.keys().next().value;
    if (firstKey) analysisCache.delete(firstKey);
  }
  analysisCache.set(cacheKey, result);

  return result;
}
