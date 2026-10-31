/** The Slide 3 contract: the seeded files must reproduce these exact counts. */
import { buildAllowedSet, validateNumbers } from "./guards";
import type { Cycle, Gap, SchoolRow } from "./model";

export function checkContract(x: {
  summary: Cycle["summary"];
  pilotDelta: number;
  matched: number[];
  khedi: SchoolRow | undefined;
  c6n: number;
  c6Days: number;
  c6Delta: number;
  singles: SchoolRow[];
  singleOct: number;
  singleJul: number;
  singleDrop: number;
  harangaon: SchoolRow | undefined;
  gaps: Gap[];
  flags: { id: string }[];
  briefEn: string;
  briefHi: string;
  briefInput: Record<string, unknown>;
  peerConclusion: string;
}): string[] {
  const err: string[] = [];
  const eq = (label: string, got: number, want: number) => {
    if (got !== want) err.push(`${label}: got ${got}, want ${want}`);
  };
  eq("files_read", x.summary.files_read, 7);
  eq("schools", x.summary.schools, 110);
  eq("years_joined", x.summary.years_joined, 3);
  eq("assessment_rows", x.summary.assessment_rows, 548);
  eq("data_problems", x.summary.data_problems, 9);
  eq("auto_fixed", x.summary.auto_fixed, 110);
  eq("flags", x.summary.flags, 4);
  if (!(x.summary.runtime_s < 0.1)) err.push(`runtime ${x.summary.runtime_s}`);
  if (Math.abs(x.pilotDelta + 9) > 1e-9) err.push(`pilot delta ${x.pilotDelta}`);
  const wantPeers = [-1.5, -0.8, 0.5, 1.4];
  if (x.matched.join(",") !== wantPeers.join(",")) err.push(`peers ${x.matched.join(",")}`);
  if (!x.khedi || x.khedi.r3 !== 34 || x.khedi.r2 !== 46) err.push("khedi scores");
  if (x.c6n !== 14 || x.c6Days < 75 || Math.abs(x.c6Delta - 0.2) > 1e-9) err.push(`c6 ${x.c6n} ${x.c6Days} ${x.c6Delta}`);
  if (x.singles.length !== 3 || Math.abs(x.singleOct - 61) > 1e-9 || Math.abs(x.singleJul - 81) > 1e-9 || Math.abs(x.singleDrop + 9) > 1e-9) {
    err.push(`singles n=${x.singles.length} oct=${x.singleOct} jul=${x.singleJul} drop=${x.singleDrop}`);
  }
  if (!x.harangaon || x.harangaon.r1 !== 100 || x.harangaon.r2 !== 100 || x.harangaon.r3 !== 100) err.push("harangaon");
  if (x.gaps.length !== 5 || x.flags.length !== 4) err.push(`gaps ${x.gaps.length}`);
  const allowed = buildAllowedSet(x.briefInput);
  const badEn = validateNumbers(x.briefEn, allowed);
  const badHi = validateNumbers(x.briefHi, allowed);
  if (badEn.length) err.push(`brief en numbers: ${badEn.join(", ")}`);
  if (badHi.length) err.push(`brief hi numbers: ${badHi.join(", ")}`);
  if (validateNumbers("average is 42%", allowed).length === 0) err.push("42 was not rejected");
  if (validateNumbers("स्कोर ४२% है", allowed).length === 0) err.push("devanagari 42 was not rejected");
  if (!x.peerConclusion.includes("9.0")) err.push("conclusion");
  for (const g of x.gaps) {
    if (!g.allowedActions.includes(g.actionId)) err.push(`action ${g.id}`);
    if (!g.sourceRefs.length || g.sourceRefs.some((c) => !c.file || !c.row)) err.push(`citation ${g.id}`);
  }
  return err;
}
