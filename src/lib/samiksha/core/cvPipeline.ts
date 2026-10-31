/**
 * Classroom-photo computer vision on raw RGBA pixels: no model, no tokens.
 * Sharpness is the Laplacian variance, lighting and scene detail come from the
 * luminance histogram (mean, 5th–95th percentile spread, entropy), faces from
 * the skin-colour blob detector in visionGuard.ts, and blurring is a mosaic over
 * each face box. Before anything is stored the image is downscaled to at most
 * 640×480 and encoded as a JPEG of 45 KB at most; the encoder is passed in, so
 * the browser uses its canvas and tests use a stand-in. JPEG rather than WebP,
 * because the server decodes the bytes it stores and checks them again
 * (recheckStoredPhoto).
 */
import { layaClassifyImage, type ImageDecision } from "./layaEngine";
import { MAX_STORED_PROOF_BYTES } from "./uploadLimits";
import {
  detectFacesAndPersonsFromPixels,
  inspectClassroomPhoto,
  measurePhoto,
  pixelateFaceZones,
  PHOTO_RULES,
  type FaceBox,
  type FaceScan,
  type PhotoVerdict,
} from "./visionGuard";

export function computeCvSharpness(rgba: Uint8ClampedArray, width: number, height: number): number {
  return measurePhoto(rgba, width, height).sharpnessScore;
}

export type LightingScene = { brightnessScore: number; contrastScore: number; entropyBits: number; sceneComplexityScore: number };

/** Mean brightness, contrast (5th–95th percentile spread of luminance) and scene detail (histogram entropy, 0–8 bits). */
export function computeCvLightingAndScene(rgba: Uint8ClampedArray, width: number, height: number): LightingScene {
  const hist = new Uint32Array(256);
  const step = Math.max(1, Math.floor(Math.max(width, height) / 320));
  let n = 0;
  let sum = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const l = Math.round(0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!);
      hist[l] = hist[l]! + 1;
      sum += l;
      n += 1;
    }
  }
  const at = (q: number) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v]!;
      if (acc >= q * n) return v;
    }
    return 255;
  };
  let entropy = 0;
  for (const c of hist) {
    if (!c) continue;
    const p = c / n;
    entropy -= p * Math.log2(p);
  }
  return {
    brightnessScore: Math.round(sum / Math.max(1, n)),
    contrastScore: at(0.95) - at(0.05),
    entropyBits: Math.round(entropy * 100) / 100,
    sceneComplexityScore: Math.round((entropy / 8) * 100),
  };
}

export type PersonScan = FaceScan & { isGroupActivity: boolean };

export function detectPersonsAndFacesCV(rgba: Uint8ClampedArray, width: number, height: number): PersonScan {
  const scan = detectFacesAndPersonsFromPixels(rgba, width, height);
  return { ...scan, isGroupActivity: scan.detectedPersonCount >= PHOTO_RULES.minGroup && scan.maxFaceAreaRatio <= PHOTO_RULES.maxFaceShare };
}

/** Mosaic over each face box (20% margin), or the upper band when none was found; the activity below stays sharp. */
export function applyCvFaceBlur(rgba: Uint8ClampedArray, width: number, height: number, faceBoxes: FaceBox[]) {
  return pixelateFaceZones(rgba, width, height, faceBoxes);
}

/** Box-average downscale to fit within maxWidth × maxHeight (never upscales). */
export function downscaleRgba(rgba: Uint8ClampedArray, width: number, height: number, maxWidth = 640, maxHeight = 480): { data: Uint8ClampedArray; width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  if (scale === 1) return { data: rgba, width, height };
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y / scale);
    const y1 = Math.max(y0 + 1, Math.min(height, Math.floor((y + 1) / scale)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x / scale);
      const x1 = Math.max(x0 + 1, Math.min(width, Math.floor((x + 1) / scale)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let c = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * width + xx) * 4;
          r += rgba[i]!;
          g += rgba[i + 1]!;
          b += rgba[i + 2]!;
          a += rgba[i + 3]!;
          c += 1;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / c;
      out[o + 1] = g / c;
      out[o + 2] = b / c;
      out[o + 3] = a / c;
    }
  }
  return { data: out, width: w, height: h };
}

export type StoredPhotoCheck = {
  ok: boolean;
  decision: ImageDecision;
  verdict: PhotoVerdict;
  measures: { width: number; height: number; sharpnessScore: number; brightnessScore: number; detectedPersonCount: number; maxFaceAreaRatio: number; sceneComplexityScore: number };
};

/**
 * The server's own check of the photo it is about to store, run on the decoded
 * bytes rather than on anything the browser says about them. A forged
 * "accepted" label cannot get a single-child close-up or a dark, blurry photo
 * into the vault, because the label is never read. The faces in a stored photo
 * are already pixelated, so the blur itself cannot be re-measured here; the
 * person count, the face share, the sharpness and the light can.
 */
export function recheckStoredPhoto(rgba: Uint8ClampedArray, width: number, height: number): StoredPhotoCheck {
  const quality = measurePhoto(rgba, width, height);
  const scan = detectFacesAndPersonsFromPixels(rgba, width, height);
  const scene = computeCvLightingAndScene(rgba, width, height);
  const measures = {
    width, height, ...quality, detectedPersonCount: scan.detectedPersonCount, maxFaceAreaRatio: scan.maxFaceAreaRatio, sceneComplexityScore: scene.sceneComplexityScore,
  };
  const decision = layaClassifyImage(measures);
  // Tier 1 is the uploader's own signature, which the store records; the
  // higher tiers are signed later and do not decide whether the photo is kept.
  const verdict = inspectClassroomPhoto({ ...measures, facesBlurred: true, consent: { hmOrCrccAttested: true, beoVerified: false, deoAuditSigned: false } });
  return { ok: decision.ok && verdict.accepted, decision, verdict, measures };
}

export type ImageEncoder = (rgba: Uint8ClampedArray, width: number, height: number, quality: number) => Promise<{ bytes: Uint8Array; mime: string }>;

export type CompressedProof = {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  quality: number;
  originalBytes: number;
  compressedBytes: number;
  compressionRatioPct: number;
  withinLimit: boolean;
};

/**
 * Downscale to 640×480, encode at quality 0.65, and step quality (then size)
 * down until the file is at most 45 KB. `originalBytes` is the size picked by
 * the user (or the raw RGBA size when unknown).
 */
export async function compressImageForSupabase(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  encode: ImageEncoder,
  opts: { originalBytes?: number; maxBytes?: number } = {},
): Promise<CompressedProof> {
  const maxBytes = opts.maxBytes ?? MAX_STORED_PROOF_BYTES;
  const originalBytes = opts.originalBytes ?? rgba.length;
  let img = { data: rgba, width, height };
  let last: CompressedProof | null = null;
  for (const [maxW, maxH] of [[640, 480], [480, 360], [320, 240]] as const) {
    img = downscaleRgba(img.data, img.width, img.height, maxW, maxH);
    for (const quality of [0.65, 0.5, 0.4, 0.3]) {
      const { bytes, mime } = await encode(img.data, img.width, img.height, quality);
      last = {
        bytes, mime, width: img.width, height: img.height, quality, originalBytes, compressedBytes: bytes.length,
        compressionRatioPct: Math.round((1 - bytes.length / Math.max(1, originalBytes)) * 1000) / 10,
        withinLimit: bytes.length <= maxBytes,
      };
      if (last.withinLimit) return last;
    }
  }
  return last!;
}
