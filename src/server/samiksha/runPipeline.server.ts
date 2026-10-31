/**
 * Server adapter around the deterministic engine: run the pipeline on the
 * seeded CSVs (or uploaded ones), time it here, and write the cycle to the DB
 * in one transaction. Idempotent on (block_id, client_request_id).
 */
import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import {
  MAX_CSV_XLSX_SIZE_BYTES,
  MAX_UPLOAD_BATCH_BYTES,
  REVIEW_DATE,
  findHeaderRow,
  mb,
  parseCsv,
  renderSeedFiles,
  runPipeline,
  scanPii,
  type RawFile,
} from "@/lib/samiksha/engine";
import { assertBlockId, insertLlmCall, istToday, simulatedCall, stableUuid } from "./repo.server";

export type RunCycleInput = {
  blockId: string;
  /** Uploaded CSVs; omitted = the seeded pilot files. */
  files?: RawFile[];
  clientRequestId?: string;
};

export type RunCycleResult = {
  cycleId: number;
  created: boolean;
  prepSeconds: number;
  runtimeS: number;
  summary: Record<string, number>;
  contractErrors: string[];
};

/** The SPD's threshold overrides for this block. A database without block_settings (before 0009) has none. */
async function blockThresholds(blockId: string): Promise<Record<string, unknown> | null> {
  try {
    const sql = await getSql();
    const [row] = await sql`select thresholds from block_settings where block_id = ${blockId}`;
    return (row?.thresholds as Record<string, unknown> | undefined) ?? null;
  } catch {
    return null;
  }
}

const UUID_RE =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runCycle(input: RunCycleInput): Promise<RunCycleResult> {
  const blockId = assertBlockId(input.blockId);
  const requestId = input.clientRequestId ?? randomUUID();
  if (!UUID_RE.test(requestId)) throw new Error("client_request_id must be a UUID.");
  const upload = input.files?.length ? input.files : null;
  // The same limits the browser checks on pick: 5 MiB a file, 25 MiB an upload.
  const bytes = (f: RawFile) => Buffer.byteLength(f.csv, "utf8");
  const oversize = upload?.find((f) => bytes(f) > MAX_CSV_XLSX_SIZE_BYTES);
  if (oversize) throw new Error(`Upload too large: ${oversize.name} is ${mb(bytes(oversize))} MB; the limit is ${mb(MAX_CSV_XLSX_SIZE_BYTES)} MB a file.`);
  if (upload && upload.reduce((n, f) => n + bytes(f), 0) > MAX_UPLOAD_BATCH_BYTES) {
    throw new Error(`Upload too large: the files come to more than ${mb(MAX_UPLOAD_BATCH_BYTES)} MB together.`);
  }
  // The privacy guard runs here too, so a REST or bot upload cannot skip the browser check.
  for (const f of upload ?? []) {
    const grid = parseCsv(f.csv);
    const h = findHeaderRow(grid);
    const pii = scanPii(grid[h] ?? [], grid.slice(h + 1));
    if (pii.hit) throw new Error(`Privacy guard: ${f.name} was refused (“${pii.match}”). School-level data only; nothing was stored.`);
  }
  // Seeded cycles run on the review date; uploads run on today's date so reminders fire for real.
  const reviewDate = upload ? istToday() : REVIEW_DATE;
  const simToday = upload ? null : REVIEW_DATE;

  const seed = renderSeedFiles();
  const t0 = performance.now();
  const overrides = await blockThresholds(blockId);
  const parsed = runPipeline(upload ?? seed.cycle, { thresholds: overrides, reviewDate });
  const prepSeconds = (performance.now() - t0) / 1000;

  return withTransaction(async (sql) => {
    const inserted = await sql<{ id: number }>`
      insert into cycles (block_id, client_request_id, source, review_date, sim_today, prep_seconds, runtime_s,
        summary, peer, peers, flags, header_maps, files, r4_files, people, brief_input, brief_en, brief_hi, contract_errors, detected_state_code, thresholds)
      values (${blockId}, ${requestId}, ${upload ? "upload" : "seed"}, ${reviewDate}, ${simToday}, ${prepSeconds}, ${parsed.summary.runtime_s},
        ${JSON.stringify(parsed.summary)}::jsonb, ${JSON.stringify(parsed.peer)}::jsonb, ${JSON.stringify(parsed.peers)}::jsonb,
        ${JSON.stringify(parsed.flags)}::jsonb, ${JSON.stringify(parsed.headerMaps)}::jsonb, ${JSON.stringify(parsed.files)}::jsonb,
        ${JSON.stringify(seed.r4)}::jsonb, ${JSON.stringify(parsed.people)}::jsonb, ${JSON.stringify(parsed.briefInput)}::jsonb,
        ${parsed.briefEn}, ${parsed.briefHi}, ${JSON.stringify(parsed.contractErrors)}::jsonb, ${parsed.detectedStateCode},
        ${JSON.stringify(parsed.thresholds)}::jsonb)
      on conflict (block_id, client_request_id) do nothing
      returning id`;

    if (!inserted[0]) {
      // A retry of a request that already landed: hand back the original cycle.
      const [prior] = await sql<{ id: number; prep_seconds: number; runtime_s: number; summary: Record<string, number>; contract_errors: string[] }>`
        select id, prep_seconds, runtime_s, summary, contract_errors from cycles
        where block_id = ${blockId} and client_request_id = ${requestId}`;
      return {
        cycleId: Number(prior!.id),
        created: false,
        prepSeconds: Number(prior!.prep_seconds),
        runtimeS: Number(prior!.runtime_s),
        summary: prior!.summary,
        contractErrors: prior!.contract_errors,
      };
    }
    const cycleId = Number(inserted[0].id);

    await sql`
      insert into schools (block_id, client_request_id, cycle_id, code, name_en, name_hi, cluster, working_teachers, n_students, maths_post,
        vacant_since, y1, y2, r1, r2, r3, r4, jul_aug, oct_nov, dec_att, days_since_visit, last_visit, last_note, kind)
      select ${blockId}, x.crid, ${cycleId}, x.code, x."nameEn", x."nameHi", x.cluster, x."workingTeachers", x."nStudents", x."mathsPost",
        x."vacantSince", x.y1, x.y2, x.r1, x.r2, x.r3, x.r4, x."julAug", x."octNov", x."decAtt", x."daysSinceVisit",
        x."lastVisit", x."lastNote", x.kind
      from jsonb_to_recordset(${JSON.stringify(parsed.schools.map((s) => ({ ...s, crid: stableUuid(requestId, "school", s.code) })))}::jsonb)
        as x(crid uuid, code text, "nameEn" text, "nameHi" text, cluster text, "workingTeachers" int, "nStudents" int, "mathsPost" text,
             "vacantSince" text, y1 float8, y2 float8, r1 float8, r2 float8, r3 float8, r4 float8, "julAug" float8,
             "octNov" float8, "decAtt" float8, "daysSinceVisit" int, "lastVisit" text, "lastNote" text, kind text)`;

    const issues = [...parsed.problems, ...parsed.fixes].map((i, seq) => ({ ...i, seq, crid: stableUuid(requestId, "issue", seq) }));
    await sql`
      insert into issues (block_id, client_request_id, cycle_id, seq, category, severity, issue_type, school_code, raw_value,
        fixed_value, source_file, source_row, description_en, description_hi)
      select ${blockId}, x.crid, ${cycleId}, x.seq, x.category, x.severity, x."issueType", x."schoolCode", x."rawValue",
        x."fixedValue", x."sourceFile", x."sourceRow", x."descriptionEn", x."descriptionHi"
      from jsonb_to_recordset(${JSON.stringify(issues)}::jsonb)
        as x(crid uuid, seq int, category text, severity text, "issueType" text, "schoolCode" text, "rawValue" text,
             "fixedValue" text, "sourceFile" text, "sourceRow" int, "descriptionEn" text, "descriptionHi" text)`;

    await sql`
      insert into gaps (block_id, client_request_id, cycle_id, gap_id, code_rank, claude_rank, rank_justification_en,
        rank_justification_hi, target_label, target_label_hi, target_type, target_codes, gap_kind, fact_en, fact_hi,
        reason_en, reason_hi, action_id, allowed_actions, source_refs, code_score, low_sample)
      select ${blockId}, x.crid, ${cycleId}, x.id, x."codeRank", x."claudeRank", x."rankJustificationEn",
        x."rankJustificationHi", x."targetLabel", x."targetLabelHi", x."targetType", x."targetCodes", x."gapKind",
        x."factEn", x."factHi", x."reasonEn", x."reasonHi", x."actionId", x."allowedActions", x."sourceRefs", x."codeScore",
        case when x."lowSample" is null then null else jsonb_build_object('n', x."lowSample"->>'n', 'minimum', x."lowSample"->>'minimum') end
      from jsonb_to_recordset(${JSON.stringify(parsed.allRankedGaps.map((g) => ({ ...g, crid: stableUuid(requestId, "gap", g.id) })))}::jsonb)
        as x(crid uuid, id text, "codeRank" int, "claudeRank" int, "rankJustificationEn" text, "rankJustificationHi" text,
             "targetLabel" text, "targetLabelHi" text, "targetType" text, "targetCodes" jsonb, "gapKind" text,
             "factEn" text, "factHi" text, "reasonEn" text, "reasonHi" text, "actionId" text, "allowedActions" jsonb,
             "sourceRefs" jsonb, "codeScore" int, "lowSample" jsonb)`;

    await insertLlmCall(sql, {
      blockId,
      requestId: stableUuid(requestId, "llm", "brief_generation"),
      cycleId,
      purpose: "brief_generation",
      passed: parsed.contractErrors.length === 0,
      ...simulatedCall(parsed.briefEn + parsed.briefHi),
    });

    return {
      cycleId,
      created: true,
      prepSeconds,
      runtimeS: parsed.summary.runtime_s,
      summary: parsed.summary,
      contractErrors: parsed.contractErrors,
    };
  });
}
