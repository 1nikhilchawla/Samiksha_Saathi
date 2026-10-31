/**
 * Small-sample noise.
 *
 * A Grade 3 percentage from a three-child school is not a finding: one absent
 * child moves it by more than thirty points, and the engine has no way to tell
 * that from a real collapse. The denominator travels with the school row from
 * the UDISE export, and every gap built from a school below the threshold is
 * reported as low confidence instead of as a flagged problem.
 */
import { CONFIG } from "./config";

export const MIN_STUDENTS_FOR_FLAG: number = CONFIG.thresholds.min_g3_students_for_flag;

export type LowSample = {
  /** The Grade 3 denominator of the school behind the gap. */
  n: number;
  /** The threshold below which the sample is too small to act on. */
  minimum: number;
};

/**
 * True when the denominator is known and too small for the percentage to mean
 * much. A count of 0 (or none) means the column was not in the file: the size is
 * unknown, so the school is not badged as small-sample noise.
 */
export function isSmallSample(nStudents: number | null | undefined, minimum = MIN_STUDENTS_FOR_FLAG): boolean {
  if (nStudents === null || nStudents === undefined || !Number.isFinite(nStudents)) return false;
  return nStudents > 0 && nStudents < minimum;
}

/**
 * The note shown beside a low-confidence gap. It says what the number is and
 * what to do about it, so the officer is not left guessing.
 */
export function smallSampleNote(n: number, minimum = MIN_STUDENTS_FOR_FLAG): { en: string; hi: string } {
  return {
    en: `Low confidence: only ${n} Grade 3 children (under ${minimum}). One absence moves this score by about ${Math.round(100 / Math.max(1, n))} points, so this is noise to re-check, not a finding to act on.`,
    hi: `कम विश्वसनीयता: कक्षा 3 में केवल ${n} विद्यार्थी (${minimum} से कम)। एक उपस्थिति लगभग ${Math.round(100 / Math.max(1, n))} अंक हिलाती है, इसलिए यह जाँचने योग्य शोर है, कार्य का आधार नहीं।`,
  };
}

/** The short label the UI puts on a low-confidence chip. */
export function smallSampleChip(n: number, minimum = MIN_STUDENTS_FOR_FLAG): { en: string; hi: string } {
  return { en: `Low confidence · N=${n}`, hi: `कम विश्वसनीयता · N=${n}` };
}

/** The low-sample marker for a school, or null when its sample is big enough to act on. */
export function lowSampleFor(nStudents: number | null | undefined, minimum = MIN_STUDENTS_FOR_FLAG): LowSample | null {
  if (!isSmallSample(nStudents, minimum)) return null;
  return { n: Number(nStudents), minimum };
}
