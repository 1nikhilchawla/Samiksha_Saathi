import { ACTION_LIBRARY, CONFIG, modelPrice, type ActionId } from "./config";
import { cleanSchoolCode, fileKind, numOrNull, readTable } from "./ingest";
import type { Cycle, Person, RawFile, SchoolRow, Task, TaskStatus } from "./model";
import { DEMO_TRANSCRIPT, extractTasks } from "./tasks";

export function mergeR4(schools: SchoolRow[], files: RawFile[]): SchoolRow[] {
  const next = schools.map((s) => ({ ...s }));
  const byCode = new Map(next.map((s) => [s.code, s]));
  for (const f of files) {
    const kind = fileKind(f.name);
    const table = readTable(f.csv);
    for (const rec of table.data) {
      const school = byCode.get(cleanSchoolCode(rec.cells.school_code ?? "").code);
      if (!school) continue;
      if (kind === "r4") {
        const score = numOrNull(rec.cells.g3_math_pct ?? "");
        if (score !== null) school.r4 = score;
      }
      if (kind === "dec") {
        const score = numOrNull(rec.cells.attendance_pct ?? "");
        if (score !== null) school.decAtt = score;
      }
    }
  }
  return next;
}

/**
 * Comparison schools for a flagged school: the ones already tagged as controls,
 * else unflagged schools within ±bandPts of its R3 score that did not drop past
 * the drop threshold. Same baseline band, no action: an association, not proof.
 */
export function matchControlSchools(schools: SchoolRow[], targetSchool: SchoolRow, bandPts = 4.0, deltaMax: number = CONFIG.thresholds.drop_flag_delta_max): SchoolRow[] {
  const tagged = schools.filter((s) => s.kind === "control");
  if (tagged.length) return tagged;
  const t3 = targetSchool.r3;
  if (t3 === null) return [];
  return schools.filter(
    (s) =>
      s.code !== targetSchool.code &&
      s.kind === "plain" &&
      s.r3 !== null &&
      s.r2 !== null &&
      Math.abs(s.r3 - t3) <= bandPts &&
      s.r3 - s.r2 > deltaMax,
  );
}

export type Scorecard = {
  approved: number;
  closedOnTime: number;
  closurePct: number;
  byAction: { actionId: ActionId; approved: number; closed: number }[];
  byOwner: { name: string; nameHi: string; role: string; approved: number; closed: number }[];
  gapsOwned: number;
  gapsTotal: number;
  gapsOwnedPct: number;
  prepSeconds: number;
  prepMinutes: number;
  khedi: { r3: number; r4: number; delta: number };
  matchedMean: number;
  association: number;
  controls: { name: string; r3: number; r4: number; delta: number }[];
  singles: { name: string; nameHi: string; r3: number; r4: number; delta: number; attFrom: number; attTo: number; boxTick: boolean }[];
  c6: { schools: number; observedOnTime: number; delta: number };
  harangaon: { from: number; to: number };
  boxTicks: { school: string; detailEn: string; detailHi: string }[];
};

function r1n(n: number): number {
  return Math.round(n * 10) / 10;
}

export function isClosedOnTime(task: Task): boolean {
  if (!task.completedAt || !task.dueDate) return false;
  if (task.status !== "done" && task.status !== "outcome_checked") return false;
  return task.completedAt <= task.dueDate;
}

function countsAsApproved(t: Task): boolean {
  return Boolean(t.approvedAt) && t.status !== "rejected" && t.status !== "cancelled" && t.status !== "draft";
}

/** Statuses in which a task is waiting for a field reply. */
export const REPLY_OPEN_STATUSES: TaskStatus[] = ["sent", "reminded", "partial", "overdue", "blocked"];

export type SimulateResult = {
  ok: boolean;
  unitsTotal: number;
  balance: number;
  closurePct: number;
  reasonEn: string;
  reasonHi: string;
};

/**
 * Re-run the cycle with a proposed task state and check the minimum-balance
 * constraint: open target schools never drop below zero, a task closes only
 * when its balance reaches zero, it must be waiting for a reply, and the
 * Action Closure Rate stays inside 0..100.
 */
export function simulate(
  tasks: Task[],
  taskId: number,
  proposed: { status: TaskStatus; unitsDone: number; completedAt: string | null },
): SimulateResult {
  const task = tasks.find((t) => t.id === taskId);
  const fail = (unitsTotal: number, balance: number, reasonEn: string, reasonHi: string): SimulateResult => ({
    ok: false, unitsTotal, balance, closurePct: 0, reasonEn, reasonHi,
  });
  if (!task) return fail(0, 0, `Task #${taskId} is not in this cycle.`, `कार्य #${taskId} इस चक्र में नहीं है।`);
  const unitsTotal = Math.max(1, task.targetCodes.length);
  const balance = unitsTotal - proposed.unitsDone;
  if (!REPLY_OPEN_STATUSES.includes(task.status)) {
    return fail(unitsTotal, balance, `Task #${task.id} is ${task.status}; it is not waiting for a field reply.`, `कार्य #${task.id} की स्थिति ${task.status} है; यह उत्तर की प्रतीक्षा में नहीं है।`);
  }
  if (balance < 0) {
    return fail(unitsTotal, balance, `The reply reports ${proposed.unitsDone} schools, but Task #${task.id} covers only ${unitsTotal}.`, `उत्तर में ${proposed.unitsDone} स्कूल बताए गए, पर कार्य #${task.id} में केवल ${unitsTotal} हैं।`);
  }
  if (proposed.status === "done" && balance > 0) {
    return fail(unitsTotal, balance, `Task #${task.id} cannot close: ${balance} of ${unitsTotal} schools are still open.`, `कार्य #${task.id} बंद नहीं हो सकता: ${unitsTotal} में से ${balance} स्कूल अभी बाकी हैं।`);
  }
  const next = tasks.map((t) => (t.id === taskId ? { ...t, ...proposed } : t));
  const approved = next.filter(countsAsApproved);
  const closed = approved.filter(isClosedOnTime);
  const closurePct = approved.length ? (closed.length / approved.length) * 100 : 0;
  if (closed.length > approved.length || closurePct < 0 || closurePct > 100) {
    return fail(unitsTotal, balance, "Closure rate would leave 0 to 100.", "समापन दर 0 से 100 के बाहर जाएगी।");
  }
  return { ok: true, unitsTotal, balance, closurePct, reasonEn: "", reasonHi: "" };
}

/** Actions whose outcome is a learning or attendance number; a verified re-test or a posting is judged on its own. */
const OUTCOME_ACTIONS: ActionId[] = ["tarl", "no_visit", "attendance"];

/**
 * "Done" with nothing to show: a closed task whose linked metric moved at most
 * 1 point from R3 to R4 (attendance for attendance drives, Grade 3 numeracy otherwise).
 */
function findBoxTicks(schools: SchoolRow[], closed: Task[]) {
  const byCode = new Map(schools.map((s) => [s.code, s]));
  const rows: { code: string; school: string; detailEn: string; detailHi: string }[] = [];
  for (const t of closed.filter((x) => OUTCOME_ACTIONS.includes(x.actionId))) {
    for (const s of t.targetCodes.map((c) => byCode.get(c)).filter((x): x is SchoolRow => Boolean(x))) {
      if (s.r3 === null || s.r4 === null) continue;
      const delta = s.r4 - s.r3;
      const from = s.octNov ?? 0;
      const to = s.decAtt ?? 0;
      const attendance = t.actionId === "attendance";
      if (Math.abs(attendance ? to - from : delta) > 1) continue;
      rows.push({
        code: s.code,
        school: s.nameEn,
        detailEn: attendance
          ? `Task reported done, but attendance moved from ${from.toFixed(0)}% to ${to.toFixed(0)}% and numeracy changed ${delta.toFixed(1)} pts.`
          : `Task #${t.id} reported done, but Grade 3 numeracy moved only ${delta.toFixed(1)} pts (${s.r3}% to ${s.r4}%).`,
        detailHi: attendance
          ? `कार्य पूर्ण बताया गया, पर उपस्थिति ${from.toFixed(0)}% से ${to.toFixed(0)}% और संख्या ज्ञान ${delta.toFixed(1)} अंक।`
          : `कार्य #${t.id} पूर्ण बताया गया, पर कक्षा 3 संख्या ज्ञान केवल ${delta.toFixed(1)} अंक बदला (${s.r3}% से ${s.r4}%)।`,
      });
    }
  }
  return rows;
}

function ownerRows(approvedTasks: Task[], people: Person[]) {
  const ownerMap = new Map<string, { name: string; nameHi: string; role: string; approved: number; closed: number }>();
  for (const t of approvedTasks) {
    const p = people.find((x) => x.id === t.ownerId);
    const key = p?.id ?? "none";
    const row = ownerMap.get(key) ?? { name: p ? p.nameEn : "Unassigned", nameHi: p ? p.nameHi : "अनिर्दिष्ट", role: p?.role ?? "—", approved: 0, closed: 0 };
    row.approved += 1;
    if (isClosedOnTime(t)) row.closed += 1;
    ownerMap.set(key, row);
  }
  return [...ownerMap.values()];
}

/** The next-round scorecard. `gaps` is the cycle's flagged gaps: the denominator for "gaps with an owner". */
export function buildScorecard(schools: SchoolRow[], tasks: Task[], people: Person[], prepSeconds: number, gaps: { id: string }[]): Scorecard {
  const approvedTasks = tasks.filter(countsAsApproved);
  const closed = approvedTasks.filter(isClosedOnTime);
  const khedi = schools.find((s) => s.kind === "khedi");
  const controls = (khedi ? matchControlSchools(schools, khedi) : []).filter((s) => s.r3 !== null && s.r4 !== null);
  const c6 = schools.filter((s) => s.kind === "c6" && s.r3 !== null && s.r4 !== null);
  const har = schools.find((s) => s.kind === "harangaon");
  const matchedMean = controls.length ? r1n(controls.reduce((a, s) => a + (s.r4! - s.r3!), 0) / controls.length) : 0;
  const khediDelta = khedi && khedi.r4 !== null && khedi.r3 !== null ? r1n(khedi.r4 - khedi.r3) : 0;
  const c6Delta = c6.length ? r1n(c6.reduce((a, s) => a + (s.r4! - s.r3!), 0) / c6.length) : 0;
  const boxTicks = findBoxTicks(schools, closed);
  const flagged = new Set(boxTicks.map((b) => b.code));
  const singleRows = schools.filter((s) => s.kind === "single" && s.r3 !== null && s.r4 !== null).map((s) => ({
    name: s.nameEn, nameHi: s.nameHi, r3: s.r3!, r4: s.r4!, delta: s.r4! - s.r3!, attFrom: s.octNov ?? 0, attTo: s.decAtt ?? 0, boxTick: flagged.has(s.code),
  }));
  const byAction = (Object.keys(ACTION_LIBRARY) as ActionId[]).map((actionId) => {
    const rows = approvedTasks.filter((t) => t.actionId === actionId);
    return { actionId, approved: rows.length, closed: rows.filter(isClosedOnTime).length };
  }).filter((r) => r.approved > 0);
  const gapsOwned = gaps.filter((g) => approvedTasks.some((t) => t.gapId === g.id)).length;
  const c6Task = approvedTasks.find((t) => t.gapId === "c6-visit");
  const observedOnTime = !c6Task ? 0 : isClosedOnTime(c6Task) ? c6Task.targetCodes.length : Math.min(c6Task.unitsDone, c6Task.targetCodes.length);
  return {
    approved: approvedTasks.length,
    closedOnTime: closed.length,
    closurePct: approvedTasks.length ? (closed.length / approvedTasks.length) * 100 : 0,
    byAction,
    byOwner: ownerRows(approvedTasks, people),
    gapsOwned,
    gapsTotal: gaps.length,
    gapsOwnedPct: gaps.length ? (gapsOwned / gaps.length) * 100 : 0,
    prepSeconds,
    prepMinutes: prepSeconds / 60,
    khedi: { r3: khedi?.r3 ?? 0, r4: khedi?.r4 ?? 0, delta: khediDelta },
    matchedMean,
    association: khediDelta - matchedMean,
    controls: controls.map((s) => ({ name: s.nameEn, r3: s.r3!, r4: s.r4!, delta: s.r4! - s.r3! })),
    singles: singleRows,
    c6: { schools: c6.length, observedOnTime, delta: c6Delta },
    harangaon: { from: har?.r3 ?? 100, to: har?.r4 ?? 0 },
    boxTicks: boxTicks.map(({ school, detailEn, detailHi }) => ({ school, detailEn, detailHi })),
  };
}

export function canonicalFieldTasks(cycle: Pick<Cycle, "gaps" | "people" | "schools">): Task[] {
  const drafts = extractTasks(DEMO_TRANSCRIPT, cycle);
  const sitapur = cycle.schools.find((s) => s.nameEn.includes("Sitapur"));
  const hm = cycle.people.find((p) => p.role === "HM" && p.scope.includes("Sitapur")) ?? cycle.people.find((p) => p.id === `hm-${sitapur?.code}`);
  return drafts.map((t) => {
    let ownerId = t.ownerId;
    let dueDate = t.dueDate;
    let missing = [...t.missingFields];
    if (t.actionId === "attendance") {
      ownerId = hm?.id ?? ownerId;
      dueDate = "2025-12-28";
      missing = [];
    }
    const base: Task = {
      ...t,
      ownerId,
      dueDate,
      missingFields: missing,
      status: "approved",
      approvedBy: "beo",
      approvedAt: "2025-11-30T16:10:00.000Z",
    };
    const all = t.targetCodes.length;
    if (t.actionId === "tarl") return { ...base, status: "done", completedAt: "2025-12-18", unitsDone: all };
    if (t.actionId === "vacancy") return { ...base, status: "escalated", completedAt: null, note: "Request is with the DEO. Temporary arrangement not closed.", noteHi: "प्रस्ताव DEO के पास है। अस्थायी व्यवस्था अभी बंद नहीं हुई।" };
    if (t.actionId === "no_visit") return { ...base, status: "partial", completedAt: null, unitsDone: 10, note: "Observations done in 10 of 14 schools. 4 are overdue.", noteHi: "14 में से 10 स्कूलों में अवलोकन हुआ। 4 अतिदेय हैं।" };
    if (t.actionId === "data_check") return { ...base, status: "done", completedAt: "2025-12-14", unitsDone: all };
    if (t.actionId === "attendance") return { ...base, status: "done", completedAt: "2025-12-16", unitsDone: all, note: "HM replied done. December attendance and R4 still have to be checked.", noteHi: "प्रधानाध्यापक ने पूर्ण कहा। दिसम्बर उपस्थिति और R4 अभी जाँचनी है।" };
    return base;
  });
}

/** Token cost of one call at the model's price card (default: the configured model). */
export function estimateCallCost(tokensIn: number, tokensOut: number, model: string = CONFIG.pricing.model) {
  const price = modelPrice(model);
  const usd = (tokensIn / 1_000_000) * (price.input_usd_per_mtok ?? 0) + (tokensOut / 1_000_000) * (price.output_usd_per_mtok ?? 0);
  return { usd, inr: usd * CONFIG.pricing.usd_to_inr };
}

/** Voice notes a block records per month, in hours (about 40 to 110 minutes). */
const STT_HOURS_PER_MONTH = { low: 0.67, high: 1.83 };

/**
 * A block-month: 2 brief runs (40k in / 4k out), 30 task extractions (3k / 0.5k) and
 * 100 reply parses (1.5k / 0.2k) = 320k in + 43k out tokens, plus speech-to-text.
 * The 2x buffer covers Hindi tokenisation and retries.
 */
export function projectMonthCost() {
  const tokensIn = 320_000;
  const tokensOut = 43_000;
  const { usd, inr } = estimateCallCost(tokensIn, tokensOut);
  const rate = CONFIG.pricing.sarvam_stt_inr_per_hour;
  return {
    tokensIn,
    tokensOut,
    usd,
    inr,
    bufferedInr: inr * 2,
    sttLow: Math.round(STT_HOURS_PER_MONTH.low * rate),
    sttHigh: Math.round(STT_HOURS_PER_MONTH.high * rate),
  };
}
