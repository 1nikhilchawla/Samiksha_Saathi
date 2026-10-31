/**
 * The third tier of the cleaning studio: a bounded model call that compiles an
 * officer's rule into the same AST the fixed patterns produce.
 *
 * The model never touches the table. It may only answer with the AST fields
 * below; sanitizeCleaningAst drops anything else, and the AST is applied on the
 * device by applyCleaningAst. Two rules hold:
 *   1. The call only happens when the officer asks for it (the "use the model"
 *      button) and only after the two on-device tiers have failed.
 *   2. It is capped per month, and the cap is read from the same llm_calls
 *      ledger the other model calls write to, so the cost story stays one story.
 */
import { layaSecondCheckOnClaude, sanitizeCleaningAst, scanPromptInjection, type CleaningAst, type SecondCheck } from "@/lib/samiksha/engine";
import { complete, llmModel, parseJsonObject } from "@/lib/samiksha/llm.server";

/** Cleaning-rule compilations per month, per block. Small: the local tiers do the rest. */
export const CLEANING_MODEL_MONTHLY_LIMIT = 20;

const SYSTEM = [
  "You compile a data-cleaning rule written by an education officer into one JSON object. Reply with JSON only:",
  '{"attendanceBelow":null,"dropOver":null,"vacantMaths":null,"r3Below":null,"scoreAt100":null,',
  '"fillMissingAttendanceWithClusterMean":null,"capAt100":null,"trimNames":null,"highPriority":null}',
  "Use only these fields, and only when the rule clearly asks for them:",
  "attendanceBelow: a number 0-100. Flag schools whose attendance percentage is below it.",
  "dropOver: a number. Flag schools whose score fell by more than this many points between the two rounds.",
  "vacantMaths: true. Flag schools with a vacant maths teacher post.",
  "r3Below: a number 0-100. Flag schools whose latest round score is below it.",
  "scoreAt100: true. Flag schools that reported a flat 100 percent.",
  "fillMissingAttendanceWithClusterMean: true. Fill a missing attendance with the cluster mean.",
  "capAt100: true. Cap any score above 100 at 100.",
  "trimNames: true. Remove extra spaces from school names.",
  "highPriority: true. Mark the matched schools as high priority.",
  "Every other field stays null. If the rule asks for nothing in this list, return all nulls.",
  "Never invent a threshold that the rule does not state.",
].join("\n");

export type CleaningModelResult = {
  /** The sanitised AST, or an empty one when the model said nothing usable. */
  ast: CleaningAst;
  /** False when the model returned no usable rule. */
  understood: boolean;
  model: string;
  tokensIn: number;
  tokensOut: number;
  billable: boolean;
  note: string;
  /** The rule check after the model call; absent when no model answered. */
  secondCheck?: SecondCheck;
};

const empty = (model: string, note: string, extra?: Partial<CleaningModelResult>): CleaningModelResult => ({
  ast: {},
  understood: false,
  model,
  tokensIn: 0,
  tokensOut: 0,
  billable: false,
  note,
  ...extra,
});

/**
 * Compile one rule with the model. `budgetLeft` is what the caller read from
 * the ledger; the server refuses rather than overspend.
 */
export async function compileCleaningRuleWithModel(
  instruction: string,
  budgetLeft: number,
): Promise<CleaningModelResult> {
  const model = llmModel();
  if (!model) return empty("none", "The AI rule helper is not available right now, so this rule was not compiled. On-device cleaning still works.");
  if (budgetLeft <= 0) {
    return empty(model, `Monthly limit of ${CLEANING_MODEL_MONTHLY_LIMIT} cleaning-rule compilations reached; model call refused.`);
  }
  // The rule is the officer's own words, but it is still untrusted text on its way to a prompt.
  const text = scanPromptInjection(instruction.trim().slice(0, 600)).sanitized;
  if (!text) return empty(model, "The rule is empty.");

  let res: Awaited<ReturnType<typeof complete>>;
  try {
    res = await complete(SYSTEM, [{ role: "user", content: text }], { temperature: 0, maxTokens: 400 });
  } catch (err) {
    return empty(model, err instanceof Error ? err.message : "Model call failed.");
  }

  let raw: unknown = null;
  try {
    raw = parseJsonObject(res.text);
  } catch {
    return empty(res.model, "The model's reply was not usable JSON.", { tokensIn: res.tokensIn, tokensOut: res.tokensOut, billable: res.billable });
  }
  const ast = sanitizeCleaningAst(raw);
  const offered = raw && typeof raw === "object" ? Object.entries(raw as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined).map(([k]) => k) : [];
  // Second check: every threshold must be one the officer wrote; fields outside the rule shape were dropped.
  const secondCheck = layaSecondCheckOnClaude(
    "cleaning_rule_ast",
    { numbers: [ast.attendanceBelow, ast.dropOver, ast.r3Below].filter((n): n is number => typeof n === "number") },
    { sourceText: text, corrections: offered.filter((k) => !(k in ast)) },
  );
  const understood = Object.keys(ast).length > 0 && secondCheck.verified;
  return {
    ast: secondCheck.verified ? ast : {},
    understood,
    model: res.model,
    tokensIn: res.tokensIn,
    tokensOut: res.tokensOut,
    billable: res.billable,
    secondCheck,
    note: !secondCheck.verified
      ? `Not applied. ${secondCheck.badge.en}`
      : understood
        ? `Compiled by the model into ${Object.keys(ast).join(", ")}. ${secondCheck.badge.en}. The rule is applied to a working copy only.`
        : "The model did not find a rule in this list. Try the fixed pattern or the shorthand tier.",
  };
}
