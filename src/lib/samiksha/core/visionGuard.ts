/**
 * Visual proof for closing a classroom task: a group-activity photo, checked for
 * quality, for child privacy, for blurred faces and for a three-signature consent
 * chain before anyone above the block can see it. Everything runs on pixels in
 * the browser; the photo is never uploaded or stored.
 *
 * Faces are found by a skin-colour heuristic (YCbCr range plus 8-connected
 * blobs), not by a trained face detector. It misses faces in poor light, can
 * split or merge children who sit close, and can count a brown wall as skin, so
 * the count is an estimate that the uploader confirms.
 *
 * Basis: Section 9 of the DPDP Act 2023 requires verifiable parental consent
 * before a child's personal data is processed; a face in a photo is personal data.
 */
import { ROLE_LEVEL, type OfficerRole } from "./rbac";

type Copy = { en: string; hi: string };

export type ConsentChain = {
  /** Tier 1: the CRCC or HM certifies a genuine group activity and an SMC/parent consent register entry. */
  hmOrCrccAttested: boolean;
  /** Tier 2: the BEO counter-signs before the photo can close a task or be seen above the block. */
  beoVerified: boolean;
  /** Tier 3: the DEO signs the audit before the photo can enter the state archive. */
  deoAuditSigned: boolean;
  /**
   * Who signed each tier. Powers are cumulative, so one senior officer could
   * otherwise sign every tier alone: a tier counts only when its signer is a
   * higher level than the signer of the tier below.
   */
  signedBy?: { tier1?: OfficerRole; tier2?: OfficerRole; tier3?: OfficerRole };
};

export type PhotoInput = {
  width: number;
  height: number;
  /** 0–100: twice the square root of the Laplacian variance of the grey image. */
  sharpnessScore: number;
  /** 0–255: mean grey level. */
  brightnessScore: number;
  detectedPersonCount: number;
  /** Largest single face as a share of the frame, 0–1. */
  maxFaceAreaRatio: number;
  facesBlurred: boolean;
  consent: ConsentChain;
};

export type PhotoCode = "PASS" | "REJECTED_BLUR_OR_DARK" | "BLOCKED_SINGLE_CHILD_PII" | "BLOCKED_FACES_NOT_BLURRED" | "PENDING_CONSENT";

export type PhotoVerdict = {
  code: PhotoCode;
  /** Kept as evidence: passes the quality, privacy and blur checks and has tier-1 consent. */
  accepted: boolean;
  /** May close an outcome task: accepted and counter-signed by the BEO. */
  canCloseTask: boolean;
  /** The DEO may view it to audit once both lower tiers signed. */
  deoAuditAllowed: boolean;
  /** State officers may view it, and it may be archived, only after the DEO's tier-3 signature. */
  stateArchiveAllowed: boolean;
  consentTierCount: 0 | 1 | 2 | 3;
  reason: Copy;
  checks: { id: string; pass: boolean; label: Copy }[];
};

export const PHOTO_RULES = { minSharpness: 35, minBrightness: 35, maxBrightness: 235, minGroup: 3, maxFaceShare: 0.2, minWidth: 320, minHeight: 240 } as const;

const MSG: Record<PhotoCode, Copy> = {
  PASS: {
    en: "Accepted: clear group-activity photo, faces blurred, signed at school and block. It can close the task.",
    hi: "स्वीकृत: स्पष्ट समूह गतिविधि फोटो, चेहरे धुंधले, विद्यालय व विकासखंड पर हस्ताक्षरित। यह कार्य बंद कर सकती है।",
  },
  REJECTED_BLUR_OR_DARK: {
    en: `Image is too blurry, dark or small (sharpness < ${PHOTO_RULES.minSharpness}). Please upload a clear classroom activity photo.`,
    hi: `फोटो धुंधली, अंधेरी या छोटी है (स्पष्टता < ${PHOTO_RULES.minSharpness})। कृपया कक्षा गतिविधि की स्पष्ट फोटो अपलोड करें।`,
  },
  BLOCKED_SINGLE_CHILD_PII: {
    en: "Blocked: a single child or a close-up face. Only wide group-activity photos (3 or more students, faces blurred) are allowed, to protect children's privacy under the DPDP Act 2023.",
    hi: "रोका गया: एकल बच्चा या चेहरे का क्लोज़-अप। बच्चों की गोपनीयता (DPDP अधिनियम 2023) के लिए केवल समूह गतिविधि (3 या अधिक विद्यार्थी, चेहरे धुंधले) की फोटो अनुमत है।",
  },
  BLOCKED_FACES_NOT_BLURRED: { en: "Blocked: faces are not blurred yet. Apply the privacy blur before saving.", hi: "रोका गया: चेहरे अभी धुंधले नहीं हैं। सहेजने से पहले गोपनीयता धुंध लगाएँ।" },
  PENDING_CONSENT: { en: "Held: the consent chain is incomplete, so the photo stays at the block.", hi: "रोका गया: सहमति शृंखला अधूरी है, फोटो विकासखंड स्तर पर ही रहेगी।" },
};

export function inspectClassroomPhoto(input: PhotoInput): PhotoVerdict {
  const r = PHOTO_RULES;
  const quality =
    input.width >= r.minWidth && input.height >= r.minHeight && input.sharpnessScore >= r.minSharpness &&
    input.brightnessScore >= r.minBrightness && input.brightnessScore <= r.maxBrightness;
  const group = input.detectedPersonCount >= r.minGroup && input.maxFaceAreaRatio <= r.maxFaceShare;
  const blurred = input.facesBlurred;
  // Each tier counts only on top of the one below it.
  const tier1 = input.consent.hmOrCrccAttested;
  const by = input.consent.signedBy ?? {};
  const above = (upper?: OfficerRole, lower?: OfficerRole) => !upper || !lower || ROLE_LEVEL[upper] > ROLE_LEVEL[lower];
  const tier2 = tier1 && input.consent.beoVerified && above(by.tier2, by.tier1);
  const tier3 = tier2 && input.consent.deoAuditSigned && above(by.tier3, by.tier2);
  const checks = [
    { id: "quality", pass: quality, label: { en: `Sharpness ${Math.round(input.sharpnessScore)}, brightness ${Math.round(input.brightnessScore)}`, hi: `स्पष्टता ${Math.round(input.sharpnessScore)}, चमक ${Math.round(input.brightnessScore)}` } },
    { id: "group", pass: group, label: { en: `${input.detectedPersonCount} students, largest face ${Math.round(input.maxFaceAreaRatio * 100)}% of frame`, hi: `${input.detectedPersonCount} विद्यार्थी, सबसे बड़ा चेहरा फ्रेम का ${Math.round(input.maxFaceAreaRatio * 100)}%` } },
    { id: "blur", pass: blurred, label: { en: blurred ? "Privacy blur applied" : "Privacy blur not applied", hi: blurred ? "गोपनीयता धुंध लगी" : "गोपनीयता धुंध नहीं लगी" } },
    { id: "tier1", pass: tier1, label: { en: "Tier 1 · CRCC / HM consent attestation", hi: "स्तर 1 · CRCC / प्रधानाध्यापक सहमति" } },
    { id: "tier2", pass: tier2, label: { en: "Tier 2 · BEO counter-signature", hi: "स्तर 2 · BEO प्रति-हस्ताक्षर" } },
    { id: "tier3", pass: tier3, label: { en: "Tier 3 · DEO audit sign-off (needed for the state archive only)", hi: "स्तर 3 · DEO ऑडिट हस्ताक्षर (केवल राज्य संग्रह हेतु)" } },
  ];
  const code: PhotoCode = !quality ? "REJECTED_BLUR_OR_DARK" : !group ? "BLOCKED_SINGLE_CHILD_PII" : !blurred ? "BLOCKED_FACES_NOT_BLURRED" : !tier2 ? "PENDING_CONSENT" : "PASS";
  const accepted = quality && group && blurred && tier1;
  return {
    code,
    accepted,
    canCloseTask: accepted && tier2,
    deoAuditAllowed: accepted && tier2,
    stateArchiveAllowed: accepted && tier3,
    consentTierCount: tier3 ? 3 : tier2 ? 2 : tier1 ? 1 : 0,
    reason: MSG[code],
    checks,
  };
}

/** Sharpness and brightness of an RGBA image, sampled on a grid of at most ~320 px across. */
export function measurePhoto(data: Uint8ClampedArray, width: number, height: number): { sharpnessScore: number; brightnessScore: number } {
  const step = Math.max(1, Math.floor(width / 320));
  const w = Math.floor(width / step);
  const h = Math.floor(height / step);
  const grey = new Float32Array(w * h);
  let sum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * step * width + x * step) * 4;
      const g = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
      grey[y * w + x] = g;
      sum += g;
    }
  }
  let n = 0;
  let mean = 0;
  let m2 = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const c = y * w + x;
      const lap = grey[c - w]! + grey[c + w]! + grey[c - 1]! + grey[c + 1]! - 4 * grey[c]!;
      n += 1;
      const d = lap - mean;
      mean += d / n;
      m2 += d * (lap - mean);
    }
  }
  const variance = n > 1 ? m2 / (n - 1) : 0;
  return { sharpnessScore: Math.min(100, Math.round(2 * Math.sqrt(variance))), brightnessScore: Math.round(sum / Math.max(1, w * h)) };
}

/** Pixelate the rectangle [x0, x1) × [y0, y1) of an RGBA image in place, in square blocks. */
export function pixelateRect(data: Uint8ClampedArray, width: number, height: number, x0: number, y0: number, x1: number, y1: number, block = 14): void {
  const left = Math.max(0, Math.floor(x0));
  const right = Math.min(width, Math.ceil(x1));
  const top = Math.max(0, Math.floor(y0));
  const bottom = Math.min(height, Math.ceil(y1));
  for (let by = top; by < bottom; by += block) {
    for (let bx = left; bx < right; bx += block) {
      const ey = Math.min(bottom, by + block);
      const ex = Math.min(right, bx + block);
      const acc = [0, 0, 0];
      let count = 0;
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          const i = (y * width + x) * 4;
          acc[0]! += data[i]!;
          acc[1]! += data[i + 1]!;
          acc[2]! += data[i + 2]!;
          count += 1;
        }
      }
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          const i = (y * width + x) * 4;
          data[i] = acc[0]! / count;
          data[i + 1] = acc[1]! / count;
          data[i + 2] = acc[2]! / count;
        }
      }
    }
  }
}

/** Pixelate rows y0..y1 across the full width (the fallback band where seated children's faces usually are). */
export function pixelateBand(data: Uint8ClampedArray, width: number, height: number, y0: number, y1: number, block = 14): void {
  pixelateRect(data, width, height, 0, y0, width, y1, block);
}

export type FaceBox = { x: number; y: number; w: number; h: number };
export type FaceScan = { detectedPersonCount: number; maxFaceAreaRatio: number; faceBoxes: FaceBox[] };

/** Skin chrominance range (YCbCr, 0–255) and the blob filters that keep face-sized, face-shaped regions. */
export const SKIN_RULES = { cbMin: 77, cbMax: 127, crMin: 133, crMax: 173, minLuma: 40, gridWidth: 160, minBlobShare: 0.002, minFill: 0.4, minAspect: 0.5, maxAspect: 2 } as const;

/**
 * Estimate faces from pixels: mark skin-coloured cells on a grid about 160 cells
 * across, join them into 8-connected blobs, and keep blobs that are big enough
 * (hands drop out), roughly as wide as tall, and mostly filled. A heuristic, not
 * a face detector: see the note at the top of this file.
 */
export function detectFacesAndPersonsFromPixels(data: Uint8ClampedArray, width: number, height: number): FaceScan {
  const r = SKIN_RULES;
  const step = Math.max(1, Math.ceil(width / r.gridWidth));
  const w = Math.floor(width / step);
  const h = Math.floor(height / step);
  const skin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * step * width + x * step) * 4;
      const R = data[i]!;
      const G = data[i + 1]!;
      const B = data[i + 2]!;
      const luma = 0.299 * R + 0.587 * G + 0.114 * B;
      const cb = 128 - 0.168736 * R - 0.331264 * G + 0.5 * B;
      const cr = 128 + 0.5 * R - 0.418688 * G - 0.081312 * B;
      skin[y * w + x] = luma >= r.minLuma && cb >= r.cbMin && cb <= r.cbMax && cr >= r.crMin && cr <= r.crMax ? 1 : 0;
    }
  }
  const seen = new Uint8Array(w * h);
  const boxes: FaceBox[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!skin[start] || seen[start]) continue;
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    let count = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % w;
      const cy = (c - cx) / w;
      count += 1;
      minX = Math.min(minX, cx);
      maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy);
      maxY = Math.max(maxY, cy);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (skin[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const aspect = bw / bh;
    if (count / (w * h) < r.minBlobShare || aspect < r.minAspect || aspect > r.maxAspect || count / (bw * bh) < r.minFill) continue;
    boxes.push({ x: minX * step, y: minY * step, w: bw * step, h: bh * step });
  }
  boxes.sort((a, b) => a.y - b.y || a.x - b.x);
  const largest = boxes.reduce((m, b) => Math.max(m, b.w * b.h), 0);
  return { detectedPersonCount: boxes.length, maxFaceAreaRatio: largest / (width * height), faceBoxes: boxes };
}

/** Share of the frame, from the top, pixelated when no face was found. */
export const FALLBACK_BLUR_BAND = 0.6;

/**
 * Pixelate each face box, padded 20% on every side, leaving the activity (the
 * mat, the slates) sharp. With no boxes, pixelate the upper band instead.
 */
export function pixelateFaceZones(data: Uint8ClampedArray, width: number, height: number, faceBoxes: FaceBox[]): { mode: "faces" | "band"; zones: number } {
  if (!faceBoxes.length) {
    pixelateBand(data, width, height, 0, height * FALLBACK_BLUR_BAND);
    return { mode: "band", zones: 1 };
  }
  for (const b of faceBoxes) {
    const px = b.w * 0.2;
    const py = b.h * 0.2;
    pixelateRect(data, width, height, b.x - px, b.y - py, b.x + b.w + px, b.y + b.h + py, Math.max(6, Math.round(b.w / 5)));
  }
  return { mode: "faces", zones: faceBoxes.length };
}

export type SceneKind = "group" | "single" | "blurry";
type Rgb = readonly [number, number, number];

/**
 * A drawn classroom for the demo buttons: wall, blackboard with chalk marks, a
 * TaRL number mat, and seated children (skin-tone face, dark hair, uniform). The
 * same pixels go through the same measures and detector as an uploaded photo.
 */
export function renderSyntheticClassroom(kind: SceneKind, width = 640, height = 480): Uint8ClampedArray {
  const d = new Uint8ClampedArray(width * height * 4);
  let seed = kind === "single" ? 7 : 3;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff - 0.5) * 14;
  };
  const put = (x: number, y: number, c: Rgb) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (Math.floor(y) * width + Math.floor(x)) * 4;
    d[i] = c[0];
    d[i + 1] = c[1];
    d[i + 2] = c[2];
  };
  const rect = (x0: number, y0: number, x1: number, y1: number, c: Rgb) => {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(height, y1); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(width, x1); x++) put(x, y, c);
    }
  };
  /** A filled ellipse; `top` < 1 keeps only that upper share of it (hair). */
  const disc = (cx: number, cy: number, rx: number, ry: number, c: Rgb, top = 1) => {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
      if ((y - (cy - ry)) / (2 * ry) > top) continue;
      for (let x = Math.floor(cx - rx); x <= cx + rx; x++) if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) put(x, y, c);
    }
  };
  const SKIN: Rgb[] = [[224, 172, 138], [198, 134, 100], [170, 110, 80], [141, 85, 57]];
  const child = (cx: number, cy: number, r: number, tone: number) => {
    rect(cx - r * 1.3, cy + r * 0.9, cx + r * 1.3, cy + r * 3.2, [140, 170, 210]);
    disc(cx, cy, r * 0.82, r, SKIN[tone % SKIN.length]!);
    disc(cx, cy - r * 0.05, r * 0.86, r * 1.02, [32, 26, 24], 0.32);
  };
  rect(0, 0, width, height * 0.62, [196, 214, 188]);
  rect(0, height * 0.62, width, height, [128, 132, 142]);
  if (kind === "single") {
    child(width * 0.5, height * 0.45, Math.min(width, height) * 0.36, 1);
  } else {
    rect(width * 0.08, height * 0.06, width * 0.62, height * 0.3, [40, 70, 52]);
    for (let k = 0; k < 9; k++) rect(width * (0.11 + k * 0.055), height * 0.12, width * (0.11 + k * 0.055) + 14, height * 0.12 + 4, [236, 236, 228]);
    rect(width * 0.2, height * 0.74, width * 0.8, height * 0.97, [60, 90, 170]);
    for (let gx = 0; gx <= 10; gx++) rect(width * (0.2 + gx * 0.06), height * 0.74, width * (0.2 + gx * 0.06) + 2, height * 0.97, [240, 240, 240]);
    for (let gy = 0; gy <= 4; gy++) rect(width * 0.2, height * (0.74 + gy * 0.0575), width * 0.8, height * (0.74 + gy * 0.0575) + 2, [240, 240, 240]);
    const r = width * 0.042;
    [0.14, 0.3, 0.46, 0.62, 0.78, 0.92].forEach((fx, k) => child(width * fx, height * (k % 2 ? 0.44 : 0.5), r, k));
  }
  for (let i = 0; i < d.length; i += 4) {
    const n = noise();
    d[i] = d[i]! + n;
    d[i + 1] = d[i + 1]! + n;
    d[i + 2] = d[i + 2]! + n;
    d[i + 3] = 255;
  }
  if (kind === "blurry") {
    for (let pass = 0; pass < 3; pass++) boxBlur(d, width, height, 4);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i]! * 0.3;
      d[i + 1] = d[i + 1]! * 0.3;
      d[i + 2] = d[i + 2]! * 0.3;
    }
  }
  return d;
}

function boxBlur(d: Uint8ClampedArray, width: number, height: number, radius: number) {
  const src = Uint8ClampedArray.from(d);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = -radius; dy <= radius; dy += 2) {
        for (let dx = -radius; dx <= radius; dx += 2) {
          const i = (Math.min(height - 1, Math.max(0, y + dy)) * width + Math.min(width - 1, Math.max(0, x + dx))) * 4;
          r += src[i]!;
          g += src[i + 1]!;
          b += src[i + 2]!;
          n += 1;
        }
      }
      const o = (y * width + x) * 4;
      d[o] = r / n;
      d[o + 1] = g / n;
      d[o + 2] = b / n;
    }
  }
}

export type PhotoAnalysis = Omit<PhotoInput, "consent"> & { faceBoxes: FaceBox[]; blur: { mode: "faces" | "band"; zones: number } };

/** The whole photo path on one RGBA image: measure, estimate faces, then pixelate them in place. */
export function analysePhotoPixels(data: Uint8ClampedArray, width: number, height: number): PhotoAnalysis {
  const measured = measurePhoto(data, width, height);
  const scan = detectFacesAndPersonsFromPixels(data, width, height);
  const blur = pixelateFaceZones(data, width, height, scan.faceBoxes);
  return { width, height, ...measured, ...scan, facesBlurred: true, blur };
}

/** The three one-click scenarios: drawn scenes, measured and scanned exactly like an upload. */
export const PHOTO_SIMULATIONS: { id: SceneKind; label: Copy }[] = [
  { id: "group", label: { en: "Valid group activity (6 students + TaRL mat)", hi: "मान्य समूह गतिविधि (6 विद्यार्थी + TaRL चटाई)" } },
  { id: "single", label: { en: "Single-child close-up", hi: "एकल बच्चे का क्लोज़-अप" } },
  { id: "blurry", label: { en: "Blurry, dark forwarded photo", hi: "धुंधली, अंधेरी फॉरवर्ड फोटो" } },
];

/** A drawn scene run through analysePhotoPixels; `pixels` comes back with the faces pixelated. */
export function simulatePhoto(kind: SceneKind, width = 640, height = 480): PhotoAnalysis & { pixels: Uint8ClampedArray } {
  const pixels = renderSyntheticClassroom(kind, width, height);
  return { ...analysePhotoPixels(pixels, width, height), pixels };
}
