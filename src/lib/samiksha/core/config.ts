/** Review dates, the open CONFIG, the curated action library, digit helpers. */

export const REVIEW_DATE = "2025-11-30";
export const R4_REVIEW_DATE = "2026-01-15";

type ModelPrice = { provider: "anthropic" | "xai" | "ollama"; input_usd_per_mtok: number | null; output_usd_per_mtok: number | null; note: string };

/**
 * Every model the app can call, with its price per million tokens. llm.server.ts
 * picks from here and the cost ledger prices from here, so the two cannot drift.
 * null = not priced in this file; those calls would show ₹0 in the ledger.
 */
export const MODEL_REGISTRY = {
  "claude-sonnet-5": { provider: "anthropic", input_usd_per_mtok: 2, output_usd_per_mtok: 10, note: "Default model. Anthropic price card, as cited in the submission (27 Sep 2026)." },
  "claude-sonnet-4-20250514": { provider: "anthropic", input_usd_per_mtok: 3, output_usd_per_mtok: 15, note: "Deprecated; kept so older ledger rows still price." },
  "grok-4.5": { provider: "xai", input_usd_per_mtok: 2, output_usd_per_mtok: 10, note: "xAI fallback. Priced as set by the team on 28 Oct 2026; check against xAI's current price card before quoting it." },
  ollama: { provider: "ollama", input_usd_per_mtok: 0, output_usd_per_mtok: 0, note: "Local model; no token cost." },
} satisfies Record<string, ModelPrice>;

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5";
export const DEFAULT_XAI_MODEL = "grok-4.5";

/** Price card for a model id; "ollama:<name>" is the local entry, anything unknown prices as the default model. */
export function modelPrice(model: string): ModelPrice {
  if (model.startsWith("ollama:")) return MODEL_REGISTRY.ollama;
  return (MODEL_REGISTRY as Record<string, ModelPrice>)[model] ?? MODEL_REGISTRY[DEFAULT_CLAUDE_MODEL];
}

export const CONFIG = {
  block_id: "MP-PILOT-BLK01",
  block_name_en: "Kesli (Synthetic Pilot Block)",
  block_name_hi: "केसली (सिंथेटिक पायलट विकासखंड)",
  is_synthetic: true,
  review_date: REVIEW_DATE,
  r4_review_date: R4_REVIEW_DATE,
  rural_share_pct: 87,
  election_duty_2024: "Yes",
  thresholds: {
    drop_flag_r3_max: 40,
    drop_flag_delta_max: -8,
    no_visit_days_min: 30,
    single_teacher_oct_nov_att_max: 70,
    suspicious_perfect_score: 100,
    suspicious_rounds_min: 3,
    /**
     * The Grade 3 denominator below which a percentage is reported as low
     * confidence rather than as a finding. With ten children one absent child
     * moves the score by ten points, so a smaller school is noise, not a problem.
     */
    min_g3_students_for_flag: 5,
  },
  peer_rule: {
    election_duty_2024: "Yes",
    rural_share_pct_min: 80,
    min_peer_blocks: 2,
  },
  top_gaps_limit: 5,
  /**
   * Ranks 6-15 for Top 10 / Top 15: unflagged schools by an urgency score. It adds
   * the R2-to-R3 drop, the distance under the national Grade 3 average, the
   * Oct-Nov attendance shortfall and the days past a visit grace period, each weighted.
   */
  watchlist: {
    size: 10,
    attendance_target_pct: 75,
    visit_grace_days: 25,
    weights: { r3_drop: 2.2, below_national: 1.1, attendance_shortfall: 0.9, visit_overdue: 0.4 },
    attendance_action_below_pct: 72,
    visit_action_days_min: 35,
  },
  pricing: {
    model: DEFAULT_CLAUDE_MODEL,
    input_usd_per_mtok: MODEL_REGISTRY[DEFAULT_CLAUDE_MODEL].input_usd_per_mtok,
    output_usd_per_mtok: MODEL_REGISTRY[DEFAULT_CLAUDE_MODEL].output_usd_per_mtok,
    usd_to_inr: 95.8,
    sarvam_stt_inr_per_hour: 30,
    // projectMonthCost().inr for one block: 320k in + 43k out tokens on the default model, before the 2x buffer and speech-to-text.
    monthly_budget_estimate_inr: 102.51,
  },
  pilot_targets: {
    action_closure_rate_pct: 80,
    review_prep_time_max_minutes: 60,
    gaps_with_owner_pct: 100,
  },
  context_stats: {
    parakh_g3_c84_avg_pct: 55,
    competency: "C-8.4",
    arranges_numbers_up_to: 99,
    aser_g3_read_g2_pct: 27.1,
    single_teacher_schools_udise: 104125,
    single_teacher_schools_display: "1,04,125",
    jpal_mp_schools: 5435,
    jpal_assessment_completion_pct: 93,
  },
} as const;

/** How many priority gaps the brief lists: the 5 core gaps, or those plus 5 or 10 watchlist schools. */
export type TopGapsLimit = 5 | 10 | 15;
export const TOP_GAPS_OPTIONS: readonly TopGapsLimit[] = [5, 10, 15];
export const DEFAULT_TOP_GAPS_LIMIT: TopGapsLimit = CONFIG.top_gaps_limit;

export type Thresholds = { -readonly [K in keyof typeof CONFIG.thresholds]: number };

/** The thresholds the SPD may change for one block (block_settings). The rest stay as CONFIG has them. */
export const EDITABLE_THRESHOLDS = ["drop_flag_r3_max", "drop_flag_delta_max", "no_visit_days_min", "single_teacher_oct_nov_att_max", "min_g3_students_for_flag"] as const;
export type EditableThreshold = (typeof EDITABLE_THRESHOLDS)[number];

/** CONFIG.thresholds with a block's stored overrides on top. Unknown keys and values that are not numbers are ignored. */
export function effectiveThresholds(overrides?: Record<string, unknown> | null): Thresholds {
  const t: Thresholds = { ...CONFIG.thresholds };
  for (const k of EDITABLE_THRESHOLDS) {
    const v = overrides?.[k];
    if (typeof v === "number" && Number.isFinite(v)) t[k] = v;
  }
  return t;
}

export const ACTION_LIBRARY = {
  vacancy: {
    id: "vacancy",
    name_en: "Vacancy fill / redeployment request (DEO)",
    name_hi: "रिक्ति पूर्ति / शिक्षक पुनर्नियोजन प्रस्ताव (DEO)",
    default_owner_role: "DEO" as const,
    default_duration_days: 21,
    success_en: "Depute 1 maths teacher or a temporary cluster arrangement before the next round",
    success_hi: "अगले चक्र से पहले 1 गणित शिक्षक की प्रतिनियुक्ति या अस्थायी क्लस्टर व्यवस्था",
    evidence_ref: "UDISE+ 2024-25 via NITI Aayog (2026), Table 4.2 (1,04,125 single-teacher schools)",
    classroomPlaybookEn: "Hold the mathematics period with the single teacher present, split the class into two groups of 15 minutes: place-value reading to 99 on a bundle-stick mat, then 10s and 1s bundles sorted into tens and ones. Record which group could not yet read the number.",
    classroomPlaybookHi: "एकल शिक्षक के साथ गणित की कक्षा लें, कक्षा को 15-15 मिनट के दो समूहों में बाँटें: बंडल-स्टिक मैट पर 99 तक स्थानमान पठन, फिर 10 और 1 के बंडल को दस-एक में छाँटना। यह लिखें कि कौन-सा समूह अभी संख्या नहीं पढ़ सका।",
  },
  tarl: {
    id: "tarl",
    name_en: "TaRL-style maths camp, Grade 3 (CRCC + HM)",
    name_hi: "TaRL स्तर-आधारित गणित शिविर, कक्षा 3 (CRCC + प्रधानाध्यापक)",
    default_owner_role: "CRCC" as const,
    default_duration_days: 20,
    success_en: "Run a 3-week daily grouped numeracy camp; raise the Grade 3 average by at least 8 points in R4",
    success_hi: "3 सप्ताह का दैनिक समूह शिविर; R4 में कक्षा 3 औसत कम से कम 8 अंक ऊपर",
    evidence_ref: "J-PAL Teaching at the Right Level (learning camps across several states)",
    classroomPlaybookEn: "Daily 45-min Grade-3 C-8.4 bundle-stick and 10s/1s place-value mat activity, grouping students into Beginner (1-20), 2-Digit (21-99) and Operations bands. Each group gets its own mat and a different question type; the Beginner group does not wait for the others.",
    classroomPlaybookHi: "प्रतिदिन 45 मिनट कक्षा 3 C-8.4 बंडल-स्टिक तथा 10/1 स्थानमान मैट गतिविधि, विद्यार्थियों को शुरुआती (1-20), दो-अंकीय (21-99) और गणित क्रिया समूहों में बाँटें। हर समूह को अपना मैट और अलग प्रकार का प्रश्न मिले; शुरुआती समूह बाकी का इंतज़ार नहीं करता।",
  },
  no_visit: {
    id: "no_visit",
    name_en: "CRCC classroom observation, 3 weeks",
    name_hi: "CRCC कक्षा अवलोकन एवं शैक्षणिक सहयोग, 3 सप्ताह",
    default_owner_role: "CRCC" as const,
    default_duration_days: 21,
    success_en: "Complete at least 1 structured numeracy observation per school in the cluster within 21 days",
    success_hi: "21 दिनों में क्लस्टर के हर स्कूल में कम से कम 1 संरचित अवलोकन",
    evidence_ref: "Samagra Shiksha supportive supervision norms",
    classroomPlaybookEn: "Three weeks, one 40-minute numeracy period a week in each cluster school, observed by the CRCC with a fixed three-question routine: read a number, count out bundles, write the number. The CRCC notes the question where the class broke, not a general impression.",
    classroomPlaybookHi: "तीन सप्ताह, क्लस्टर के हर विद्यालय में सप्ताह में एक 40-मिनट की संख्या ज्ञान कक्षा, जिसका अवलोकन CRCC तीन निश्चित प्रश्नों के साथ करता है: संख्या पढ़ें, बंडल गिनें, संख्या लिखें। CRCC यह लिखता है कि कक्षा कहाँ टूटी, सामान्य प्रभाव नहीं।",
  },
  attendance: {
    id: "attendance",
    name_en: "Attendance drive + parent/SMC meeting",
    name_hi: "उपस्थिति अभियान एवं अभिभावक/SMC बैठक",
    default_owner_role: "HM" as const,
    default_duration_days: 15,
    success_en: "Hold an SMC and harvest-season parent contact drive; restore attendance to at least 75% in December",
    success_hi: "SMC और अभिभावक संपर्क; दिसम्बर में उपस्थिति कम से कम 75%",
    evidence_ref: "State FLN community mobilisation guidance",
    classroomPlaybookEn: "Start the mathematics period with a roll call the children answer with a number card, so absence is visible in the first two minutes. In the SMC, ask for a daily attendance board with one line per child and a parent contact for every absent day.",
    classroomPlaybookHi: "गणित की कक्षा की शुरुआत उपस्थिति से करें: बच्चे संख्या-कार्ड दिखाकर उत्तर दें, जिससे दो मिनट में ही अनुपस्थिति दिखे। SMC में रोज़ की उपस्थिति बोर्ड माँगें, हर बच्चे की एक पंक्ति और हर अनुपस्थित दिन के लिए अभिभावक से संपर्क।",
  },
  data_check: {
    id: "data_check",
    name_en: "Re-verify assessment (spot check by BRC)",
    name_hi: "मूल्यांकन पुनः सत्यापन (BRC द्वारा औचक जांच)",
    default_owner_role: "CRCC" as const,
    default_duration_days: 10,
    success_en: "Re-administer a 10-student sample on PARAKH C-8.4 and upload the verified sheet",
    success_hi: "PARAKH C-8.4 पर 10 विद्यार्थियों का नमूना दोबारा लें और सत्यापित शीट अपलोड करें",
    evidence_ref: "PARAKH / VSK data-integrity practice",
    classroomPlaybookEn: "Re-administer the ten-item C-8.4 sheet to ten children chosen at random, seated separately, with the teacher out of the room. Compare the two scores item by item: a gap on one item is a teaching gap, a gap on every item is a data problem.",
    classroomPlaybookHi: "दस-वस्तु वाली C-8.4 शीट यादृच्छिक रूप से चुने गए दस बच्चों से दोबारा लें, अलग-अलग बैठाकर, शिक्षक के कमरे से बाहर रहते हुए। दोनों अंक वस्तु-दर-वस्तु की तुलना करें: एक वस्तु पर अंतर शिक्षण का अंतर है, हर वस्तु पर अंतर डेटा की समस्या है।",
  },
} as const;

export type ActionId = keyof typeof ACTION_LIBRARY;

const DEV = "०१२३४५६७८९";

export function devToAscii(s: string): string {
  return s.replace(/[०-९]/g, (d) => String(DEV.indexOf(d)));
}

export function asciiToDev(s: string): string {
  return s.replace(/\d/g, (d) => DEV[Number(d)] ?? d);
}
