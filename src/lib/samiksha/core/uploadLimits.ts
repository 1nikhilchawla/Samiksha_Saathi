/**
 * File size limits, checked before anything is parsed: in the browser on pick,
 * and again on the server for whatever arrives. A refusal is a stage-1 failure
 * (certain, a fixed rule) with its stage-2 explanation, so /why can answer it.
 */
import { diagnoseFailure, type FailureDiagnosticEntry } from "./failureDiagnostics";

/** One CSV or Excel file: 5 MiB (5,242,880 bytes), in the browser and on the server alike. */
export const MAX_CSV_XLSX_SIZE_BYTES = 5 * 1024 * 1024;
/** One upload of several files together: 25 MiB. */
export const MAX_UPLOAD_BATCH_BYTES = 25 * 1024 * 1024;
/** Data rows in one file. A block export has a few hundred; this stops a giant file from filling the server's memory. */
export const MAX_ROWS_PER_FILE = 10_000;
export const MAX_IMAGE_RAW_SIZE_BYTES = 2 * 1024 * 1024;
export const MAX_AUDIO_SIZE_BYTES = 3 * 1024 * 1024;
/** A stored classroom proof after blurring and compression. */
export const MAX_STORED_PROOF_BYTES = 45 * 1024;

export type UploadKind = "spreadsheet" | "image" | "audio";

export const UPLOAD_LIMITS: Record<UploadKind, number> = {
  spreadsheet: MAX_CSV_XLSX_SIZE_BYTES,
  image: MAX_IMAGE_RAW_SIZE_BYTES,
  audio: MAX_AUDIO_SIZE_BYTES,
};

export const mb = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

/** Bytes carried by a base64 string (what the server receives for audio and photos). */
export const base64Bytes = (b64: string) => Math.floor((b64.replace(/=+$/, "").length * 3) / 4);

export type SizeCheck = { ok: true } | { ok: false; diagnostic: FailureDiagnosticEntry };

export function validateFileSize(file: { name: string; sizeBytes: number; kind: UploadKind }): SizeCheck {
  const limit = UPLOAD_LIMITS[file.kind];
  if (file.sizeBytes <= limit) return { ok: true };
  return {
    ok: false,
    diagnostic: diagnoseFailure("upload_file", "FILE_SIZE_LIMIT_EXCEEDED", {
      name: file.name, kind: file.kind, sizeBytes: file.sizeBytes, sizeMb: mb(file.sizeBytes), limitMb: mb(limit),
    }),
  };
}
