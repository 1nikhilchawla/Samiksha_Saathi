import { useEffect, useRef, useState } from "react";
import { FailureWhy } from "@/components/samiksha/failure-why";
import { Btn, Chip, Panel } from "@/components/samiksha/ui";
import {
  MAX_STORED_PROOF_BYTES,
  PHOTO_RULES,
  PHOTO_SIMULATIONS,
  ROLE_LEVEL,
  analysePhotoPixels,
  canOpenProof,
  compressImageForSupabase,
  computeCvLightingAndScene,
  diagnoseFailure,
  inspectClassroomPhoto,
  layaClassifyImage,
  simulatePhoto,
  toBase64,
  validateFileSize,
  type FaceBox,
  type ImageEncoder,
  type OfficerRole,
  type PhotoInput,
} from "@/lib/samiksha/engine";
import { useCan, useCycle } from "@/lib/samiksha/store";
import { useActions, useView } from "@/lib/samiksha/view";

type Shot = Omit<PhotoInput, "consent"> & {
  source: "upload" | "simulated";
  preview: string | null;
  faceBoxes: FaceBox[];
  blur: { mode: "faces" | "band"; zones: number };
  /** The blurred pixels: the only version that may be compressed and stored. */
  pixels: Uint8ClampedArray;
  sceneComplexityScore: number;
  originalBytes: number;
  name: string;
};

/** Share of the frame, from the top, that the privacy band pixelates. */
const BLUR_BAND = 0.6;

/** Draw the face boxes on the canvas so the officer can see what was detected and blurred. */
function drawFaceBoxes(ctx: CanvasRenderingContext2D, boxes: FaceBox[], width: number) {
  ctx.save();
  ctx.lineWidth = Math.max(2, Math.round(width / 200));
  ctx.strokeStyle = "#b4231f";
  for (const b of boxes) ctx.strokeRect(b.x, b.y, b.w, b.h);
  ctx.restore();
}

/** Blurred pixels to a preview with the face boxes drawn on top. */
function previewOf(pixels: Uint8ClampedArray, width: number, height: number, boxes: FaceBox[]): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  drawFaceBoxes(ctx, boxes, width);
  return canvas.toDataURL("image/jpeg", 0.7);
}

/** Read a photo into a canvas (max 1280 px wide), measure it, find the faces and blur each face box. */
async function readPhoto(file: File): Promise<Omit<Shot, "source">> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / bitmap.width);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(bitmap, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const scene = computeCvLightingAndScene(pixels, width, height);
  const a = analysePhotoPixels(pixels, width, height);
  return { ...a, pixels, sceneComplexityScore: scene.sceneComplexityScore, originalBytes: file.size, name: file.name, preview: previewOf(pixels, width, height, a.faceBoxes) };
}

/** A drawn scene run through the same path an upload takes: measured, faces found, faces blurred. */
function simulatedShot(kind: "group" | "single" | "blurry"): Omit<Shot, "source"> {
  const r = simulatePhoto(kind);
  const scene = computeCvLightingAndScene(r.pixels, r.width, r.height);
  return {
    width: r.width, height: r.height, sharpnessScore: r.sharpnessScore, brightnessScore: r.brightnessScore,
    detectedPersonCount: r.detectedPersonCount, maxFaceAreaRatio: r.maxFaceAreaRatio, facesBlurred: r.facesBlurred,
    faceBoxes: r.faceBoxes, blur: r.blur, pixels: r.pixels, sceneComplexityScore: scene.sceneComplexityScore,
    originalBytes: r.width * r.height * 4, name: `simulated-${kind}.png`, preview: previewOf(r.pixels, r.width, r.height, r.faceBoxes),
  };
}

/** The browser's canvas as the encoder. Always JPEG: the server decodes the stored photo and checks it again. */
const canvasEncoder: ImageEncoder = async (rgba, width, height, quality) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  const b = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", quality));
  if (!b) throw new Error("The photo could not be encoded.");
  return { bytes: new Uint8Array(await b.arrayBuffer()), mime: b.type };
};

type Signers = { tier1: OfficerRole | null; tier2: OfficerRole | null; tier3: OfficerRole | null };

/** Visual proof for a classroom task: quality, child privacy, a three-tier consent chain, and encrypted storage. */
export function ProofGate() {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const role = useCycle((s) => s.role);
  const layaConfidence = useCycle((s) => s.layaConfidence);
  const can = useCan();
  const { proofs, services } = useView();
  const { logClientFailure, storeProof, signProof, openProof, rotateMediaKeys } = useActions();
  const [shot, setShot] = useState<Shot | null>(null);
  const [error, setError] = useState("");
  const [signers, setSigners] = useState<Signers>({ tier1: null, tier2: null, tier3: null });
  const [opened, setOpened] = useState<{ id: number; url: string | null; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const logged = useRef<string | null>(null);

  const decision = shot ? layaClassifyImage(shot, { sizeBytes: shot.source === "upload" ? shot.originalBytes : undefined }) : null;
  const verdict = shot
    ? inspectClassroomPhoto({
        ...shot,
        consent: {
          hmOrCrccAttested: Boolean(signers.tier1), beoVerified: Boolean(signers.tier2), deoAuditSigned: Boolean(signers.tier3),
          signedBy: { tier1: signers.tier1 ?? undefined, tier2: signers.tier2 ?? undefined, tier3: signers.tier3 ?? undefined },
        },
      })
    : null;
  const above = (lower: OfficerRole | null) => !lower || ROLE_LEVEL[role] > ROLE_LEVEL[lower];
  const t1 = can("sign_consent_tier1");
  const t2 = can("sign_consent_tier2");
  const t3 = can("sign_consent_tier3");

  // A refused photo is logged once, so /why can explain it.
  useEffect(() => {
    if (!shot || !decision || decision.ok || logged.current === shot.name + shot.width) return;
    logged.current = shot.name + shot.width;
    const r = PHOTO_RULES;
    const code = decision.code === "BLURRY_OR_DARK" ? "PHOTO_BLURRY_OR_DARK" : decision.code === "IRRELEVANT_NON_CLASSROOM" ? "PHOTO_NOT_CLASSROOM" : decision.code === "OVERSIZED_FILE" ? "FILE_SIZE_LIMIT_EXCEEDED" : "PHOTO_SINGLE_CHILD";
    logClientFailure(diagnoseFailure("classroom_image", code, {
      sharpness: shot.sharpnessScore, minSharpness: r.minSharpness, brightness: shot.brightnessScore, minBrightness: r.minBrightness, maxBrightness: r.maxBrightness,
      persons: shot.detectedPersonCount, faceSharePct: Math.round(shot.maxFaceAreaRatio * 100), minGroup: r.minGroup, maxFacePct: Math.round(r.maxFaceShare * 100),
      scene: shot.sceneComplexityScore, name: shot.name, kind: "image",
    }, { confidence: decision.confidence }));
  }, [shot, decision, logClientFailure]);

  const start = (next: Shot) => {
    setShot(next);
    setSigners({ tier1: null, tier2: null, tier3: null });
    setError("");
  };

  const store = async () => {
    if (!shot || !decision?.ok || !signers.tier1) return;
    setBusy(true);
    try {
      const c = await compressImageForSupabase(shot.pixels, shot.width, shot.height, canvasEncoder, { originalBytes: shot.originalBytes });
      if (!c.withinLimit) {
        setError(en ? `Even compressed, the photo is ${Math.round(c.compressedBytes / 1024)} KB (limit ${MAX_STORED_PROOF_BYTES / 1024} KB).` : `संपीड़ित फोटो भी ${Math.round(c.compressedBytes / 1024)} KB है (सीमा ${MAX_STORED_PROOF_BYTES / 1024} KB)।`);
        return;
      }
      // Only the photo goes up. The server decodes it and decides for itself; the result shows in the message bar.
      await storeProof({ taskNo: null, schoolCode: null, mime: c.mime, imageBase64: toBase64(c.bytes), originalBytes: c.originalBytes });
      setError(en ? `Compressed ${Math.round(c.originalBytes / 1024)} KB → ${Math.round(c.compressedBytes / 1024)} KB (${c.compressionRatioPct}% smaller, ${c.mime}, ${c.width}×${c.height}), then checked again on the server.` : `संपीड़न ${Math.round(c.originalBytes / 1024)} KB → ${Math.round(c.compressedBytes / 1024)} KB (${c.compressionRatioPct}% छोटा), फिर सर्वर पर दोबारा जाँचा गया।`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl">{en ? "Visual classroom proof and consent gate" : "दृश्य प्रमाण व सरकारी सहमति गेट"}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            {en
              ? "A camp, observation or SMC task closes on a wide group-activity photo. The checks run in this browser with no model: sharpness, light, scene detail, faces. Each face box is blurred; only that blurred copy, compressed to 45 KB or less, can be stored, encrypted on the server."
              : "शिविर, अवलोकन या SMC कार्य समूह गतिविधि की फोटो से बंद होता है। जाँच इसी ब्राउज़र में, बिना मॉडल: स्पष्टता, रोशनी, दृश्य, चेहरे। हर चेहरा धुंधला; केवल वही धुंधली प्रति, 45 KB तक संपीड़ित, सर्वर पर एन्क्रिप्ट होकर संग्रहीत हो सकती है।"}
          </p>
        </div>
        <Chip tone={services.mediaKey ? "seal" : "plain"}>
          {services.mediaKey ? (en ? "AES-256-GCM Encrypted Proof Vault · on" : "AES-256-GCM एन्क्रिप्टेड प्रमाण वॉल्ट · चालू") : en ? "Proof vault not switched on for this block: photos are checked but not stored" : "इस विकासखंड के लिए प्रमाण वॉल्ट चालू नहीं: फोटो जाँची जाती है, संग्रहीत नहीं"}
        </Chip>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <label className={`inline-flex min-h-11 items-center rounded-lg border border-rule bg-sheet px-4 text-sm font-semibold ${can("upload_group_photo").allowed ? "cursor-pointer" : "cursor-not-allowed opacity-40"}`}>
          {en ? "Upload a classroom photo (up to 2 MB)" : "कक्षा की फोटो चुनें (2 MB तक)"}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            disabled={!can("upload_group_photo").allowed}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              const size = validateFileSize({ name: file.name, sizeBytes: file.size, kind: "image" });
              if (!size.ok) {
                logClientFailure(size.diagnostic);
                setShot(null);
                setError(size.diagnostic.explanation.whyFailed[lang]);
                return;
              }
              try {
                start({ ...(await readPhoto(file)), source: "upload" });
              } catch {
                setError(en ? "The photo could not be read." : "फोटो पढ़ी नहीं जा सकी।");
              }
            }}
          />
        </label>
        {PHOTO_SIMULATIONS.map((s) => (
          <Btn key={s.id} kind="ghost" onClick={() => start({ ...simulatedShot(s.id), source: "simulated" })}>
            {en ? `Simulate: ${s.label.en}` : `नमूना: ${s.label.hi}`}
          </Btn>
        ))}
      </div>
      {error ? <p className="mt-2 text-sm">{error}</p> : null}
      {/* The CV gate confidence banner: how much the browser's own checks trust this photo, and how much the Laya second check trusts the brief behind it. */}
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-rule bg-paper/60 px-3 py-2">
        <Chip tone={decision ? (decision.confidence >= 0.9 ? "seal" : decision.confidence >= 0.6 ? "plain" : "flag") : "plain"}>
          {decision
            ? en
              ? `CV gate confidence ${Math.round(decision.confidence * 100)}%`
              : `सीवी गेट विश्वसनीयता ${Math.round(decision.confidence * 100)}%`
            : en
              ? "CV gate confidence — no photo loaded"
              : "सीवी गेट विश्वसनीयता — कोई फोटो लोड नहीं"}
        </Chip>
        {layaConfidence !== null ? (
          <Chip tone={layaConfidence >= 0.9 ? "seal" : layaConfidence >= 0.6 ? "plain" : "flag"}>
            {en ? `Laya second check ${Math.round(layaConfidence * 100)}%` : `लाया दूसरी जाँच ${Math.round(layaConfidence * 100)}%`}
          </Chip>
        ) : null}
        <span className="text-xs text-muted">
          {en
            ? "The CV checks run in this browser with no model: sharpness, light, scene detail, faces."
            : "सीवी जाँच इसी ब्राउज़र में बिना मॉडल चलती है: स्पष्टता, रोशनी, दृश्य, चेहरे।"}
        </span>
      </div>
      <div className="mt-3">
        <FailureWhy surfaces={["classroom_image"]} />
      </div>

      {shot && verdict && decision ? (
        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-3">
            {shot.preview ? (
              <img src={shot.preview} alt={en ? "Classroom photo with the detected face boxes blurred and outlined" : "पहचाने गए चेहरे धुंधले व चिह्नित की गई कक्षा फोटो"} className="max-h-72 rounded-lg border border-rule" />
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={decision.ok ? "seal" : "flag"}>{decision.code}</Chip>
              <span className="text-sm">
                {en
                  ? `Laya rule decision ${Math.round(decision.confidence * 100)}% · quality ${Math.round(decision.subScores.quality * 100)}, privacy ${Math.round(decision.subScores.privacy * 100)}, relevance ${Math.round(decision.subScores.relevance * 100)} (rule scores, not calibrated)`
                  : `Laya नियम निर्णय ${Math.round(decision.confidence * 100)}% · गुणवत्ता ${Math.round(decision.subScores.quality * 100)}, गोपनीयता ${Math.round(decision.subScores.privacy * 100)}, प्रासंगिकता ${Math.round(decision.subScores.relevance * 100)}`}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={verdict.code === "PASS" ? "seal" : "flag"}>{verdict.code}</Chip>
              <span className="text-sm">{verdict.reason[lang]}</span>
            </div>
            <ul className="space-y-1 text-sm">
              {verdict.checks.map((c) => <li key={c.id} className={c.pass ? "" : "text-flag"}>{c.pass ? "✓" : "✗"} {c.label[lang]}</li>)}
              <li>{`${en ? "Scene detail" : "दृश्य विवरण"} ${shot.sceneComplexityScore}/100`}</li>
            </ul>
            <label className="block text-sm">
              <span className="mb-1 block text-muted">{en ? "Students visible (estimated from the pixels; the server counts again from the stored photo)" : "दिख रहे विद्यार्थी (पिक्सल से अनुमान; सर्वर संग्रहीत फोटो से फिर गिनता है)"}</span>
              <input
                type="number"
                min={0}
                className="h-11 w-32 rounded-lg border border-rule bg-sheet px-3 text-sm"
                value={shot.detectedPersonCount}
                onChange={(e) => setShot({ ...shot, detectedPersonCount: Math.max(0, Number(e.target.value) || 0) })}
              />
            </label>
            <p className="text-xs text-muted">
              {en
                ? `${shot.faceBoxes.length} face box${shot.faceBoxes.length === 1 ? "" : "es"} found · ${shot.blur.mode === "faces" ? `${shot.blur.zones} pixelated` : `the top ${BLUR_BAND * 100}% band pixelated`} · largest face ${Math.round(shot.maxFaceAreaRatio * 100)}% of the frame. The count comes from skin-tone blobs, not a face-detection model.`
                : `${shot.faceBoxes.length} चेहरे मिले · ${shot.blur.mode === "faces" ? `${shot.blur.zones} धुंधले` : `ऊपरी ${BLUR_BAND * 100}% भाग धुंधला`} · सबसे बड़ा चेहरा फ्रेम का ${Math.round(shot.maxFaceAreaRatio * 100)}%। गिनती त्वचा-रंग धब्बों से है, चेहरा-पहचान मॉडल से नहीं।`}
            </p>
          </div>
          <div className="space-y-3 rounded-lg border border-rule bg-paper/60 p-4 text-sm">
            <p className="font-semibold">{en ? "Consent chain (each tier by a higher level)" : "सहमति शृंखला (हर स्तर ऊँचे अधिकारी से)"}</p>
            {([
              ["tier1", t1, null, en ? "Tier 1 · genuine group activity; SMC / parent consent entry made" : "स्तर 1 · वास्तविक समूह गतिविधि; SMC / अभिभावक सहमति दर्ज"],
              ["tier2", t2, signers.tier1, en ? "Tier 2 · BEO counter-signature" : "स्तर 2 · BEO प्रति-हस्ताक्षर"],
              ["tier3", t3, signers.tier2, en ? "Tier 3 · DEO audit sign-off (state archive)" : "स्तर 3 · DEO ऑडिट हस्ताक्षर (राज्य संग्रह)"],
            ] as const).map(([tier, right, lower, text], i) => {
              const signed = signers[tier];
              const prevOk = i === 0 || Boolean(lower);
              const ok = right.allowed && prevOk && above(lower);
              return (
                <label key={tier} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={Boolean(signed)}
                    disabled={!signed && !ok}
                    onChange={(e) =>
                      setSigners((s) => ({
                        ...s,
                        [tier]: e.target.checked ? role : null,
                        ...(e.target.checked ? {} : tier === "tier1" ? { tier2: null, tier3: null } : tier === "tier2" ? { tier3: null } : {}),
                      }))
                    }
                  />
                  <span>
                    {text}
                    {signed ? <span className="block text-xs text-muted">{en ? `Signed by ${signed}` : `${signed} के हस्ताक्षर`}</span> : null}
                    {!signed && !right.allowed ? <span className="block text-xs text-muted">{en ? right.reasonEn : right.reasonHi}</span> : null}
                    {!signed && right.allowed && prevOk && !above(lower) ? <span className="block text-xs text-muted">{en ? `Needs a higher level than ${lower}` : `${lower} से ऊँचा स्तर चाहिए`}</span> : null}
                  </span>
                </label>
              );
            })}
            <ol className="space-y-1 border-t border-rule pt-3">
              <li>{verdict.canCloseTask ? "🔓" : "🔒"} {en ? "Can close the task" : "कार्य बंद कर सकती है"}</li>
              <li>{verdict.deoAuditAllowed ? "🔓" : "🔒"} {en ? "Open to BEO and DEO" : "BEO व DEO के लिए खुली"}</li>
              <li>{verdict.stateArchiveAllowed ? "🔓" : "🔒"} {en ? "May enter the state archive" : "राज्य संग्रह में जा सकती है"}</li>
            </ol>
            <Btn kind="primary" disabled={busy || !decision.ok || !signers.tier1 || !services.mediaKey || !can("upload_group_photo").allowed} onClick={() => void store()}>
              {busy ? (en ? "Compressing…" : "संपीड़न…") : en ? "Compress and store encrypted" : "संपीड़ित कर एन्क्रिप्टेड संग्रहीत करें"}
            </Btn>
            <p className="text-xs text-muted">
              {en
                ? "Section 9 of the DPDP Act 2023: a child's data needs verifiable parental consent. Without sign-in, the role that opens a proof is the one this screen declares."
                : "DPDP अधिनियम 2023 धारा 9: बच्चे के डेटा हेतु सत्यापन योग्य अभिभावक सहमति। लॉगिन के बिना, प्रमाण खोलने वाला स्तर वही है जो यह स्क्रीन बताती है।"}
            </p>
          </div>
        </div>
      ) : null}

      {proofs.length ? (
        <div className="mt-6">
          <p className="font-semibold">{en ? "Stored proofs (encrypted)" : "संग्रहीत प्रमाण (एन्क्रिप्टेड)"}</p>
          <ul className="mt-2 space-y-2 text-sm">
            {proofs.map((p) => {
              const gate = canOpenProof(role, p);
              return (
                <li key={p.id} className="rounded-lg border border-rule p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip tone="seal">{`#${p.id} · ${Math.round(p.compressedBytes / 1024)} KB ${p.mime.replace("image/", "")}`}</Chip>
                    <span className="text-xs text-muted">{`${Math.round((1 - p.compressedBytes / Math.max(1, p.originalBytes)) * 100)}% ${en ? "smaller" : "छोटा"} · ${p.personCount} ${en ? "children" : "बच्चे"} · ${en ? "tiers" : "स्तर"}: ${[p.tier1By, p.tier2By, p.tier3By].map((x) => x ?? "—").join(" / ")}`}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {!p.tier2By ? <Btn kind="ghost" disabled={!t2.allowed || !p.tier1By || ROLE_LEVEL[role] <= ROLE_LEVEL[p.tier1By]} onClick={() => void signProof(p.id, 2)}>{en ? "Sign tier 2" : "स्तर 2 हस्ताक्षर"}</Btn> : null}
                    {p.tier2By && !p.tier3By ? <Btn kind="ghost" disabled={!t3.allowed || ROLE_LEVEL[role] <= ROLE_LEVEL[p.tier2By]} onClick={() => void signProof(p.id, 3)}>{en ? "Sign tier 3" : "स्तर 3 हस्ताक्षर"}</Btn> : null}
                    <Btn
                      kind="soft"
                      disabled={!gate.allowed}
                      title={gate.allowed ? undefined : gate.reason[lang]}
                      onClick={async () => {
                        const r = await openProof(p.id);
                        setOpened({ id: p.id, url: r.dataUrl, note: r.gate?.[lang] ?? "" });
                      }}
                    >
                      {en ? "Decrypt and open" : "खोलें"}
                    </Btn>
                    {!gate.allowed ? <span className="self-center text-xs text-muted">{gate.reason[lang]}</span> : null}
                  </div>
                  {opened?.id === p.id ? (
                    opened.url ? <img src={opened.url} alt={en ? "Decrypted, blurred classroom proof" : "खोला गया धुंधला कक्षा प्रमाण"} className="mt-2 max-h-56 rounded border border-rule" /> : <p className="mt-2 text-xs text-flag">{opened.note}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {can("rotate_media_key").allowed ? (
        <div className="mt-6 rounded-lg border border-rule bg-paper/60 p-4">
          <p className="text-sm font-semibold">{en ? "Photo vault key (level 5)" : "फोटो वॉल्ट कुंजी (स्तर 5)"}</p>
          <p className="mt-1 text-xs text-muted">
            {en
              ? "Once the state IT cell has issued a new vault key, this re-encrypts every stored proof of the block under it, so the old key can be retired."
              : "राज्य IT प्रकोष्ठ नई वॉल्ट कुंजी जारी कर दे, तो यह विकासखंड के हर संग्रहीत प्रमाण को उससे दोबारा एन्क्रिप्ट करता है, ताकि पुरानी कुंजी हटाई जा सके।"}
          </p>
          <Btn kind="soft" className="mt-3" disabled={busy || !services.mediaKey} onClick={async () => {
            setBusy(true);
            try {
              await rotateMediaKeys();
            } finally {
              setBusy(false);
            }
          }}>
            {en ? "🔑 Rotate the AES-256-GCM vault key (v1 → v2)" : "🔑 AES-256-GCM वॉल्ट कुंजी बदलें (v1 → v2)"}
          </Btn>
        </div>
      ) : null}
    </Panel>
  );
}
