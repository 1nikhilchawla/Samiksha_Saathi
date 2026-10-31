/** Gap detectors: each turns joined school rows into one cited, library-bound gap. */
import { CONFIG, DEFAULT_TOP_GAPS_LIMIT, TOP_GAPS_OPTIONS, type ActionId, type Thresholds, type TopGapsLimit } from "./config";
import { cleanSchoolCode, type Table } from "./ingest";
import type { Citation, Cycle, Gap, GapTier, JoinedSchool, SchoolRow } from "./model";
import { MIN_STUDENTS_FOR_FLAG, lowSampleFor, smallSampleNote, type LowSample } from "./smallSample";

type Flag = { id: string; label: string };
type Dropped = JoinedSchool & { r2: number; r3: number };

/**
 * Small-sample noise: a school with fewer Grade 3 children than the threshold
 * cannot carry a finding. The gap stays in the list (the count does not change)
 * but it is marked low confidence instead of being treated as a flagged problem.
 */
export function smallSampleNoise(s: Pick<JoinedSchool, "nStudents">, minimum = MIN_STUDENTS_FOR_FLAG): LowSample | null {
  return lowSampleFor(s.nStudents, minimum);
}

const roundRow = (s: JoinedSchool, r: string) => s.roundRows?.[r] ?? 0;
const visitRow = (s: JoinedSchool) => s.visitRow ?? 0;
// Source files for citations: the uploaded names, or the seed names when a row has none.
const roundFile = (s: JoinedSchool, r: string) => s.roundSrc?.[r] || "assess_2025-26_rounds.csv";
const visitFile = (s: JoinedSchool) => s.visitSrc || "crcc_visits.csv";
const avg = (rows: JoinedSchool[], f: (s: JoinedSchool) => number) => (rows.length ? rows.reduce((a, s) => a + f(s), 0) / rows.length : 0);

function isDropFlag(s: JoinedSchool | undefined, t: Thresholds = CONFIG.thresholds): s is Dropped {
  return Boolean(s && s.r3 !== null && s.r2 !== null && s.r3 <= t.drop_flag_r3_max && s.r3 - s.r2 <= t.drop_flag_delta_max);
}

/** The numeracy drop and the vacancy behind it: two gaps on one school. */
function vacancyDropGaps(khedi: Dropped, udise: Table): Gap[] {
  const drop = khedi.r2 - khedi.r3;
  const target = {
    targetLabel: `${khedi.nameEn} (Cluster ${khedi.cluster})`,
    targetLabelHi: `${khedi.nameHi} (क्लस्टर ${khedi.cluster})`,
    targetType: "school" as const,
    targetCodes: [khedi.code],
  };
  const citeAssess: Citation[] = [
    { file: roundFile(khedi, "R2"), row: roundRow(khedi, "R2"), schoolOrCluster: khedi.nameEn, verbatim: `R2 ${khedi.r2}%` },
    { file: roundFile(khedi, "R3"), row: roundRow(khedi, "R3"), schoolOrCluster: khedi.nameEn, verbatim: `R3 ${khedi.r3}%` },
  ];
  const udiseRow = udise.data.find((r) => cleanSchoolCode(r.cells.school_code ?? "").code === khedi.code);
  const citeUdise: Citation = {
    file: udiseRow?.file || "udise_2025-26.csv",
    row: udiseRow?.row ?? 0,
    schoolOrCluster: khedi.nameEn,
    verbatim: `Vacant Since = ${khedi.vacantSince}`,
  };
  return [
    {
      id: "khedi-numeracy",
      codeRank: 1,
      claudeRank: 1,
      codeScore: 100,
      rankJustificationEn: "Only school under both the level and the drop thresholds, and the vacancy sits on the same campus.",
      rankJustificationHi: "स्तर और गिरावट दोनों सीमा के नीचे यही एक स्कूल है, और रिक्ति उसी परिसर में है।",
      ...target,
      gapKind: "numeracy_drop",
      factEn: `Gr-3 numeracy ${khedi.r3}% in R3, down ${drop} pts since R2 (${khedi.r2}% to ${khedi.r3}%). Maths teacher post vacant since ${khedi.vacantSince}.`,
      factHi: `कक्षा 3 संख्या ज्ञान R3 में ${khedi.r3}% है, R2 के ${khedi.r2}% से ${drop} अंक नीचे। गणित शिक्षक पद ${khedi.vacantSince} से रिक्त है।`,
      reasonEn: "The score fell and the maths post is empty, so a camp without a teacher will not hold.",
      reasonHi: "अंक गिरा है और गणित का पद खाली है। शिक्षक के बिना शिविर टिकेगा नहीं।",
      actionId: "tarl",
      allowedActions: ["tarl", "vacancy"],
      sourceRefs: citeAssess,
    },
    {
      id: "khedi-vacancy",
      codeRank: 2,
      claudeRank: 2,
      codeScore: 92,
      rankJustificationEn: "The camp needs a maths teacher. The post has been vacant since July 2025, which only the DEO can move.",
      rankJustificationHi: "शिविर को गणित शिक्षक चाहिए। पद जुलाई 2025 से खाली है। इसे केवल DEO हिला सकते हैं।",
      ...target,
      gapKind: "vacancy",
      factEn: `Maths teacher post vacant since ${khedi.vacantSince} at ${khedi.nameEn}, alongside the ${drop}-point numeracy drop.`,
      factHi: `${khedi.nameHi} में गणित पद ${khedi.vacantSince} से खाली है, और संख्या ज्ञान ${drop} अंक गिरा है।`,
      reasonEn: "A redeployment request has to travel with the camp, or the camp has no one to run it.",
      reasonHi: "पुनर्नियोजन प्रस्ताव शिविर के साथ जाना चाहिए, वरना शिविर चलाने वाला कोई नहीं।",
      actionId: "vacancy",
      allowedActions: ["vacancy", "tarl"],
      sourceRefs: [citeUdise, ...citeAssess],
    },
  ];
}

function noVisitGap(c6: JoinedSchool[], days: number, delta: number): Gap {
  const sample = c6[0];
  const quote = sample?.lastNote ?? "";
  const sign = delta >= 0 ? "+" : "";
  return {
    id: "c6-visit",
    codeRank: 3,
    claudeRank: 3,
    codeScore: 80,
    rankJustificationEn: `${c6.length} schools have gone ${days} days without a CRCC visit and the cluster moved only ${delta.toFixed(1)} pts.`,
    rankJustificationHi: `${c6.length} स्कूलों में ${days} दिनों से CRCC नहीं गए, और क्लस्टर केवल ${delta.toFixed(1)} अंक हिला।`,
    targetLabel: `Cluster C6 (${c6.length} schools)`,
    targetLabelHi: `क्लस्टर C6 (${c6.length} विद्यालय)`,
    targetType: "cluster",
    targetCodes: c6.map((s) => s.code),
    gapKind: "no_visit",
    factEn: `No CRCC visit in ${days} days; cluster numeracy changed ${sign}${delta.toFixed(1)} pts across ${c6.length} schools.`,
    factHi: `${days} दिनों से कोई CRCC भ्रमण नहीं; ${c6.length} स्कूलों में संख्या ज्ञान ${sign}${delta.toFixed(1)} अंक।`,
    reasonEn: `The visit log says “${quote}”. A duty note explains the absence. It does not replace the observation.`,
    reasonHi: `भ्रमण टिप्पणी: “${quote}”। ड्यूटी अनुपस्थिति बताती है, अवलोकन की जगह नहीं लेती।`,
    actionId: "no_visit",
    allowedActions: ["no_visit"],
    sourceRefs: sample ? [{ file: visitFile(sample), row: visitRow(sample), schoolOrCluster: "Cluster C6", verbatim: quote }] : [],
  };
}

function attendanceGap(flagged: JoinedSchool[], from: number, to: number, drop: number): Gap {
  const n = flagged.length;
  const names = flagged.map((s) => s.nameEn).join(", ");
  const namesHi = flagged.map((s) => s.nameHi).join(", ");
  const quote = flagged[0]?.lastNote ?? "";
  const fell = Math.abs(drop).toFixed(0);
  return {
    id: "singles-attendance",
    codeRank: 4,
    claudeRank: 4,
    codeScore: 74,
    rankJustificationEn: `${n} single-teacher schools fell ${fell} numeracy points while attendance went from ${from.toFixed(0)}% to ${to.toFixed(0)}%.`,
    rankJustificationHi: `${n} एकल-शिक्षक स्कूलों में संख्या ज्ञान ${fell} अंक गिरा और उपस्थिति ${from.toFixed(0)}% से ${to.toFixed(0)}% हो गई।`,
    targetLabel: `${n} Single-Teacher Schools`,
    targetLabelHi: `${n} एकल-शिक्षक विद्यालय`,
    targetType: "school_group",
    targetCodes: flagged.map((s) => s.code),
    gapKind: "seasonal_attendance_drop",
    factEn: `Attendance dropped to ${to.toFixed(0)}% (Oct–Nov) vs ${from.toFixed(0)}% (Jul–Aug); Gr-3 numeracy fell ${fell} pts. Schools: ${names}.`,
    factHi: `उपस्थिति अक्टूबर-नवम्बर में ${to.toFixed(0)}% रह गई, जुलाई-अगस्त में ${from.toFixed(0)}% थी। कक्षा 3 में ${fell} अंक की गिरावट। ${namesHi}।`,
    reasonEn: `The log says “${quote}”. Harvest explains part of the absence. With one teacher, the class still needs an SMC drive.`,
    reasonHi: `टिप्पणी: “${quote}”। फसल कटाई अनुपस्थिति का एक कारण है। एक शिक्षक होने पर SMC अभियान फिर भी जरूरी है।`,
    actionId: "attendance",
    allowedActions: ["attendance"],
    sourceRefs: flagged.slice(0, 1).map((s) => ({ file: visitFile(s), row: visitRow(s), schoolOrCluster: s.nameEn, verbatim: s.lastNote })),
  };
}

function perfectScoreGap(h: JoinedSchool): Gap {
  return {
    id: "harangaon-score",
    codeRank: 5,
    claudeRank: 5,
    codeScore: 60,
    rankJustificationEn: "A perfect 100 in every round is a data-integrity risk, not a learning victory.",
    rankJustificationHi: "हर चक्र में 100 डेटा की विश्वसनीयता का प्रश्न है, सीखने की जीत नहीं।",
    targetLabel: `${h.nameEn} (Cluster ${h.cluster})`,
    targetLabelHi: `${h.nameHi} (क्लस्टर ${h.cluster})`,
    targetType: "school",
    targetCodes: [h.code],
    gapKind: "suspicious_score",
    factEn: `Gr-3 numeracy 100% in R1, R2 and R3 at ${h.nameEn}.`,
    factHi: `${h.nameHi} में R1, R2 और R3 तीनों में कक्षा 3 अंक 100% है।`,
    reasonEn: "Three perfect rounds in a row should be spot-checked before the score enters any block average.",
    reasonHi: "लगातार तीन पूर्ण अंक ब्लॉक औसत में जाने से पहले औचक जांच चाहते हैं।",
    actionId: "data_check",
    allowedActions: ["data_check"],
    sourceRefs: (["R1", "R2", "R3"] as const).map((r) => ({ file: roundFile(h, r), row: roundRow(h, r), schoolOrCluster: h.nameEn, verbatim: `${r}=100` })),
  };
}

/**
 * Gaps in code rank order, the flags behind them, and the figures the Slide 3
 * contract checks. `t` is CONFIG.thresholds with the block's SPD overrides on top.
 */
export function detectGaps(schools: Map<string, JoinedSchool>, udise: Table, t: Thresholds = CONFIG.thresholds) {
  const all = [...schools.values()];
  const khedi = all.find((s) => s.kind === "khedi");
  const harangaon = all.find((s) => s.kind === "harangaon");
  const singles = all.filter((s) => s.kind === "single");
  const c6 = all.filter((s) => s.cluster === "C6");
  const c6Delta = avg(c6, (s) => (s.r3 ?? 0) - (s.r2 ?? 0));
  const singleOct = avg(singles, (s) => s.octNov ?? 0);
  const singleJul = avg(singles, (s) => s.julAug ?? 0);
  const singleDrop = avg(singles, (s) => (s.r3 ?? 0) - (s.r2 ?? 0));
  const flags: Flag[] = [];
  const gaps: Gap[] = [];

  const minN = t.min_g3_students_for_flag;
  if (isDropFlag(khedi, t)) {
    // A school with three Grade 3 children cannot carry a numeracy finding; the
    // gap stays (the count does not change) but it is marked low confidence.
    const low = smallSampleNoise(khedi, minN);
    flags.push({ id: "khedi", label: low ? `${khedi.nameEn} (${khedi.cluster}) · low confidence` : `${khedi.nameEn} (${khedi.cluster})` });
    gaps.push(...vacancyDropGaps(khedi, udise).map((g) => (low ? { ...g, lowSample: low } : g)));
  }

  // Days since the latest visit in each cluster; C6 schools all share one old visit.
  const clusterLatest = new Map<string, number>();
  for (const s of all) {
    const d = s.daysSinceVisit ?? 999;
    const prev = clusterLatest.get(s.cluster);
    if (prev === undefined || d < prev) clusterLatest.set(s.cluster, d);
  }
  const c6Days = clusterLatest.get("C6") ?? Math.max(...c6.map((s) => s.daysSinceVisit ?? 0));
  if (c6Days >= t.no_visit_days_min) {
    flags.push({ id: "c6", label: `Cluster C6 (${c6.length} schools)` });
    gaps.push(noVisitGap(c6, c6Days, c6Delta));
  }

  const flaggedSingles = singles.filter((s) => (s.octNov ?? 100) <= t.single_teacher_oct_nov_att_max);
  if (flaggedSingles.length >= 1) {
    // The smallest school in the group sets the confidence of the whole gap.
    const smallest = flaggedSingles.reduce((a, s) => ((a.nStudents ?? Infinity) <= (s.nStudents ?? Infinity) ? a : s));
    const low = smallSampleNoise(smallest, minN);
    flags.push({ id: "singles", label: low ? `${flaggedSingles.length} Single-Teacher Schools · low confidence` : `${flaggedSingles.length} Single-Teacher Schools` });
    gaps.push(attendanceGap(flaggedSingles, singleJul, singleOct, singleDrop));
    if (low) gaps[gaps.length - 1]!.lowSample = low;
  }

  if (harangaon) {
    const low = smallSampleNoise(harangaon, minN);
    flags.push({ id: "harangaon", label: low ? `${harangaon.nameEn} · low confidence` : harangaon.nameEn });
    gaps.push(perfectScoreGap(harangaon));
    if (low) gaps[gaps.length - 1]!.lowSample = low;
  }

  return {
    flags,
    gaps,
    metrics: { khedi, harangaon, singles: flaggedSingles, c6n: c6.length, c6Days, c6Delta, singleOct, singleJul, singleDrop },
  };
}

export const WATCHLIST_GAP_PREFIX = "watchlist-";

export const isWatchlistGap = (g: Pick<Gap, "id">) => g.id.startsWith(WATCHLIST_GAP_PREFIX);

/** Ranks 1-5 are core; the watchlist fills 6-10, then 11-15. */
export function gapTier(codeRank: number): GapTier {
  if (codeRank <= DEFAULT_TOP_GAPS_LIMIT) return "core_top_5";
  return codeRank <= 10 ? "extended_top_10" : "extended_top_15";
}

type GapPool = Pick<Cycle, "gaps"> & Partial<Pick<Cycle, "allRankedGaps">>;

/**
 * The gaps a Top N list shows. Code decides which gaps are in it (code rank N or
 * better); a Claude order only reorders inside that set, so Top 5 is always the
 * five core gaps.
 */
export function getGapsForLimit(cycle: GapPool, limit: TopGapsLimit = DEFAULT_TOP_GAPS_LIMIT): Gap[] {
  const pool = cycle.allRankedGaps?.length ? cycle.allRankedGaps : cycle.gaps;
  return pool.filter((g) => g.codeRank <= limit).sort((a, b) => a.claudeRank - b.claudeRank || a.codeRank - b.codeRank);
}

/** The Top N options this cycle can fill. A cycle built before the watchlist, or a thin upload, has fewer. */
export function availableTopLimits(cycle: GapPool): TopGapsLimit[] {
  const ranks = new Set((cycle.allRankedGaps?.length ? cycle.allRankedGaps : cycle.gaps).map((g) => g.codeRank));
  return TOP_GAPS_OPTIONS.filter((n) => n === DEFAULT_TOP_GAPS_LIMIT || ranks.has(n));
}

type Scorable = JoinedSchool & { r2: number; r3: number; octNov: number };
type Urgency = { s: Scorable; score: number; parts: { drop: number; below: number; short: number; overdue: number }; low: LowSample | null; rank: number };

/** One decimal at most, and no ".0": 48 stays 48, 85.5 stays 85.5. */
const fmt = (n: number) => {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

/** How much a small sample discounts a school's urgency. It halves it, not erases it. */
const SMALL_SAMPLE_DISCOUNT = 0.5;

function urgencyOf(s: Scorable, minN = MIN_STUDENTS_FOR_FLAG): Urgency {
  const w = CONFIG.watchlist;
  const parts = {
    drop: Math.max(0, s.r2 - s.r3),
    below: Math.max(0, CONFIG.context_stats.parakh_g3_c84_avg_pct - s.r3),
    short: Math.max(0, w.attendance_target_pct - s.octNov),
    // No visit on record has no day count, so it adds nothing here; the action still asks for a visit.
    overdue: Math.max(0, (s.daysSinceVisit ?? 0) - w.visit_grace_days),
  };
  const raw = parts.drop * w.weights.r3_drop + parts.below * w.weights.below_national + parts.short * w.weights.attendance_shortfall + parts.overdue * w.weights.visit_overdue;
  const score = Number(raw.toFixed(1));
  const low = smallSampleNoise(s, minN);
  // A percentage from a handful of children is noise, so it does not earn the
  // same place in the list as a signal with a real denominator behind it.
  const rank = low ? Number((score * SMALL_SAMPLE_DISCOUNT).toFixed(1)) : score;
  return { s, parts, score, low, rank };
}

function watchAction(s: Scorable): { actionId: ActionId; allowed: ActionId[] } {
  const w = CONFIG.watchlist;
  if (s.mathsPost === "Vacant") return { actionId: "vacancy", allowed: ["vacancy", "tarl"] };
  if (s.octNov < w.attendance_action_below_pct) return { actionId: "attendance", allowed: ["attendance", "tarl"] };
  if (s.daysSinceVisit === null || s.daysSinceVisit >= w.visit_action_days_min) return { actionId: "no_visit", allowed: ["no_visit", "tarl"] };
  return { actionId: "tarl", allowed: ["tarl", "no_visit"] };
}

function watchCitations(s: Scorable): Citation[] {
  const rounds = (["R2", "R3"] as const).map((r) => ({ file: roundFile(s, r), row: roundRow(s, r), schoolOrCluster: s.nameEn, verbatim: `${r} ${r === "R2" ? s.r2 : s.r3}%` }));
  const att = ["Oct", "Nov"].flatMap((m) => {
    const a = s.attRefs?.[m];
    return a ? [{ file: a.file || "attendance_2025-26.csv", row: a.row, schoolOrCluster: s.nameEn, verbatim: `${m} ${a.pct}%` }] : [];
  });
  const visit = s.visitRow ? [{ file: visitFile(s), row: visitRow(s), schoolOrCluster: s.nameEn, verbatim: [s.lastVisit, s.lastNote].filter(Boolean).join(" · ") }] : [];
  return [...rounds, ...att, ...visit];
}

function watchGap({ s, parts: p, score, low }: Urgency, rank: number, ties: number): Gap {
  const w = CONFIG.watchlist;
  const nat = CONFIG.context_stats.parakh_g3_c84_avg_pct;
  const control = s.kind === "control";
  const d = s.r3 - s.r2;
  const moveEn = d < 0 ? `down ${fmt(-d)} pts from R2 (${fmt(s.r2)}%)` : d > 0 ? `up ${fmt(d)} pts from R2 (${fmt(s.r2)}%)` : `same as R2 (${fmt(s.r2)}%)`;
  const moveHi = d < 0 ? `R2 (${fmt(s.r2)}%) से ${fmt(-d)} अंक नीचे` : d > 0 ? `R2 (${fmt(s.r2)}%) से ${fmt(d)} अंक ऊपर` : `R2 (${fmt(s.r2)}%) के बराबर`;
  const visitEn = s.daysSinceVisit === null ? "no CRCC visit on record" : `${s.daysSinceVisit} days since the last CRCC visit`;
  const visitHi = s.daysSinceVisit === null ? "CRCC भ्रमण का कोई रिकॉर्ड नहीं" : `पिछले CRCC भ्रमण से ${s.daysSinceVisit} दिन`;
  const termsEn = [
    p.drop ? `R3 fell ${fmt(p.drop)} pts (×${w.weights.r3_drop})` : "",
    p.below ? `${fmt(p.below)} pts under the national ${nat}% (×${w.weights.below_national})` : "",
    p.short ? `attendance ${fmt(p.short)} pts short of ${w.attendance_target_pct}% (×${w.weights.attendance_shortfall})` : "",
    p.overdue ? `${p.overdue} days past the ${w.visit_grace_days}-day visit window (×${w.weights.visit_overdue})` : "",
  ].filter(Boolean);
  const termsHi = [
    p.drop ? `R3 में ${fmt(p.drop)} अंक गिरावट (×${w.weights.r3_drop})` : "",
    p.below ? `${nat}% राष्ट्रीय औसत से ${fmt(p.below)} अंक नीचे (×${w.weights.below_national})` : "",
    p.short ? `उपस्थिति ${w.attendance_target_pct}% से ${fmt(p.short)} अंक कम (×${w.weights.attendance_shortfall})` : "",
    p.overdue ? `${w.visit_grace_days} दिन की भ्रमण अवधि से ${p.overdue} दिन अधिक (×${w.weights.visit_overdue})` : "",
  ].filter(Boolean);
  const tieEn = ties ? ` Tied with ${ties} other school${ties === 1 ? "" : "s"} at ${score}; ties go to the lower R3, then the school code.` : "";
  const tieHi = ties ? ` ${ties} अन्य विद्यालय भी ${score} पर; बराबरी में कम R3, फिर विद्यालय कोड पहले।` : "";
  const trendEn = d < 0 ? `Numeracy slipped ${fmt(-d)} pts between R2 and R3` : d > 0 ? `Numeracy rose ${fmt(d)} pts between R2 and R3` : "Numeracy did not move between R2 and R3";
  const trendHi = d < 0 ? `R2 से R3 के बीच संख्या ज्ञान ${fmt(-d)} अंक गिरा` : d > 0 ? `R2 से R3 के बीच संख्या ज्ञान ${fmt(d)} अंक बढ़ा` : "R2 से R3 के बीच संख्या ज्ञान नहीं बदला";
  const act = watchAction(s);
  return {
    id: `${WATCHLIST_GAP_PREFIX}${s.code}`,
    tier: gapTier(rank),
    codeRank: rank,
    claudeRank: rank,
    codeScore: Math.round(score),
    ...(low ? { lowSample: low } : {}),
    rankJustificationEn: `Watchlist rank ${rank}, urgency ${score}: ${termsEn.join(", ")}.${tieEn}`,
    rankJustificationHi: `निगरानी क्रम ${rank}, तात्कालिकता ${score}: ${termsHi.join(", ")}।${tieHi}`,
    targetLabel: `${s.nameEn} (Cluster ${s.cluster})`,
    targetLabelHi: `${s.nameHi} (क्लस्टर ${s.cluster})`,
    targetType: "school",
    targetCodes: [s.code],
    gapKind: control ? "watchlist_control" : "watchlist",
    factEn: `Gr-3 numeracy ${fmt(s.r3)}% in R3, ${moveEn}; Oct–Nov attendance ${fmt(s.octNov)}% (${visitEn}).`,
    factHi: `कक्षा 3 संख्या ज्ञान R3 में ${fmt(s.r3)}%, ${moveHi}; अक्टूबर–नवम्बर उपस्थिति ${fmt(s.octNov)}% (${visitHi})।`,
    reasonEn: [
      `${trendEn}${s.r3 < nat ? `, and R3 sits ${fmt(nat - s.r3)} pts under the national Grade 3 average of ${nat}%.` : "."}`,
      s.julAug !== null ? `Attendance went from ${fmt(s.julAug)}% in Jul–Aug to ${fmt(s.octNov)}% in Oct–Nov.` : "",
      s.lastNote ? `Last visit note: “${s.lastNote}”.` : "No visit note on record.",
      control ? "It is a matched comparison school for the Round 4 scorecard, so a camp here before Round 4 would blur that comparison." : "",
      low ? smallSampleNote(low.n, low.minimum).en : "",
    ].filter(Boolean).join(" "),
    reasonHi: [
      `${trendHi}${s.r3 < nat ? `, और R3 कक्षा 3 के ${nat}% राष्ट्रीय औसत से ${fmt(nat - s.r3)} अंक नीचे है।` : "।"}`,
      s.julAug !== null ? `उपस्थिति जुलाई-अगस्त में ${fmt(s.julAug)}% से अक्टूबर-नवम्बर में ${fmt(s.octNov)}% हुई।` : "",
      s.lastNote ? `पिछली भ्रमण टिप्पणी: “${s.lastNote}”।` : "कोई भ्रमण टिप्पणी नहीं।",
      control ? "यह राउंड 4 स्कोरकार्ड का मिलान वाला तुलना विद्यालय है; राउंड 4 से पहले यहाँ शिविर उस तुलना को धुंधला करेगा।" : "",
      low ? smallSampleNote(low.n, low.minimum).hi : "",
    ].filter(Boolean).join(" "),
    actionId: act.actionId,
    allowedActions: act.allowed,
    sourceRefs: watchCitations(s),
  };
}

/**
 * Ranks 6-15: schools no core gap targets, by urgency score (highest first), then
 * lower R3, then school code. Schools without R2, R3 or Oct-Nov attendance cannot
 * be scored and stay off; a score of 0 is not a gap.
 */
export function watchlistGaps(schools: Map<string, JoinedSchool>, core: Gap[], t: Thresholds = CONFIG.thresholds): Gap[] {
  const taken = new Set(core.flatMap((g) => g.targetCodes));
  const scored = [...schools.values()]
    .filter((s): s is Scorable => !taken.has(s.code) && s.r2 !== null && s.r3 !== null && s.octNov !== null)
    .map((s) => urgencyOf(s, t.min_g3_students_for_flag))
    .filter((u) => u.score > 0)
    .sort((a, b) => b.rank - a.rank || a.s.r3 - b.s.r3 || a.s.code.localeCompare(b.s.code));
  return scored
    .slice(0, CONFIG.watchlist.size)
    .map((u, i) => watchGap(u, DEFAULT_TOP_GAPS_LIMIT + 1 + i, scored.filter((x) => x.score === u.score).length - 1));
}
