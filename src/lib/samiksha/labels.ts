import type { Copy, Lang } from "./types";

/** Bilingual labels for the machine keys the UI shows (statuses, issue types, missing fields). */
export const STATUS_LABEL: Record<string, Copy> = {
  draft: { en: "draft", hi: "ड्राफ्ट" },
  approved: { en: "approved", hi: "अनुमोदित" },
  rejected: { en: "rejected", hi: "अस्वीकृत" },
  sent: { en: "sent", hi: "भेजा गया" },
  reminded: { en: "reminded", hi: "याद दिलाया" },
  done: { en: "done", hi: "पूर्ण" },
  partial: { en: "partial", hi: "आंशिक" },
  blocked: { en: "blocked", hi: "रुका" },
  overdue: { en: "overdue", hi: "समय-सीमा पार" },
  escalated: { en: "escalated", hi: "अग्रेषित" },
  outcome_checked: { en: "outcome checked", hi: "परिणाम जाँचा" },
  cancelled: { en: "cancelled", hi: "रद्द" },
  unknown: { en: "unknown", hi: "अस्पष्ट" },
};

export const ISSUE_TYPE_LABEL: Record<string, Copy> = {
  duplicate: { en: "duplicate", hi: "दोहरी पंक्ति" },
  unknown_code: { en: "unknown_code", hi: "अज्ञात कोड" },
  missing_value: { en: "missing_value", hi: "खाली मान" },
  impossible_value: { en: "impossible_value", hi: "असंभव मान" },
  suspicious_100: { en: "suspicious_100", hi: "संदिग्ध 100%" },
  format_autofix: { en: "format_autofix", hi: "प्रारूप सुधार" },
  state_scale_normalized: { en: "state_scale_normalized", hi: "राज्य पैमाना सुधार" },
};

export const MISSING_FIELD_LABEL: Record<string, Copy> = {
  owner_id: { en: "owner_id", hi: "जिम्मेदार" },
  due_date: { en: "due_date", hi: "अंतिम तिथि" },
  due_date_after_review: { en: "due_date_after_review", hi: "समीक्षा के बाद की तिथि" },
  what: { en: "what", hi: "कार्य विवरण" },
  success_metric: { en: "success_metric", hi: "सफलता मापदंड" },
  action_id: { en: "action_id", hi: "कार्य" },
  action_not_in_library_for_gap: { en: "action_not_in_library_for_gap", hi: "इस अंतर के लिए कार्य नहीं" },
  tone: { en: "tone (punitive or abusive words)", hi: "भाषा (दंडात्मक या अपमानजनक शब्द)" },
};

export const label = (map: Record<string, Copy>, key: string, lang: Lang) => map[key]?.[lang] ?? key;
export const fieldList = (keys: string[], lang: Lang) => keys.map((k) => label(MISSING_FIELD_LABEL, k, lang)).join(", ");

/** The peer-block rule ("election_duty_2024 == Yes AND rural_share_pct >= 80") in words. */
export function peerRuleText(rule: string, lang: "en" | "hi"): string {
  const m = rule.match(/election_duty_2024 == (\w+) AND rural_share_pct >= (\d+(?:\.\d+)?)/);
  if (!m) return rule;
  const yes = /^yes$/i.test(m[1]!);
  return lang === "hi"
    ? `चुनाव ड्यूटी 2024 = ${yes ? "हाँ" : "नहीं"} तथा ग्रामीण हिस्सा ≥ ${m[2]}%`
    : `Election duty in 2024 = ${yes ? "Yes" : "No"} and rural share ≥ ${m[2]}%`;
}
