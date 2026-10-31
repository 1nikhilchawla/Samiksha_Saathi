/**
 * The DEO's district view, from the server.
 *
 * A DEO sees more than one block. This reads every block in the district that
 * has a cycle, puts each on the same axes, and writes the comparison into
 * `district_blocks_summary` so the view is a table, not a paragraph.
 */
import { getSql } from "@/lib/db";
import { canPerform, RoleForbiddenError, type ActingOfficer } from "@/lib/samiksha/core/rbac";
import { compareBlocks, districtOf, summariseBlock, type BlockSummary } from "@/lib/samiksha/core/districtView";

export type DistrictView = {
  districtId: string;
  blocks: BlockSummary[];
  comparison: ReturnType<typeof compareBlocks>;
};

export async function loadDistrictView(blockId: string, officer: ActingOfficer): Promise<DistrictView> {
  const role = officer.role;
  const right = canPerform(role, "view_all_blocks");
  if (!right.allowed) throw new RoleForbiddenError({ en: `${role}: ${right.reasonEn}`, hi: `${role}: ${right.reasonHi}` });

  const districtId = districtOf(blockId);
  const sql = await getSql();
  const rows = await sql`
    select distinct on (block_id) block_id, id, summary, flags, peer
    from cycles
    where block_id = ${districtId} or block_id like ${districtId + "-%"} or block_id = ${blockId}
    order by block_id, id desc`;

  const blocks: BlockSummary[] = [];
  for (const r of rows) {
    const bid = String(r.block_id);
    const cycleId = Number(r.id);
    const schools = await sql`select code, cluster, working_teachers, maths_post, vacant_since, r3, n_students from schools where cycle_id = ${cycleId}`;
    const gaps = await sql`select code_rank, code_score, target_codes, low_sample from gaps where cycle_id = ${cycleId} order by code_rank`;
    const tasks = await sql`select status, action_id from tasks where cycle_id = ${cycleId}`;
    const summary = summariseBlock({
      blockId: bid,
      blockName: bid,
      schools: schools.map((s) => ({
        code: String(s.code),
        cluster: String(s.cluster ?? ""),
        workingTeachers: Number(s.working_teachers ?? 0),
        mathsPost: String(s.maths_post ?? "Filled"),
        vacantSince: String(s.vacant_since ?? ""),
        r3: s.r3 === null || s.r3 === undefined ? null : Number(s.r3),
        nStudents: s.n_students === null || s.n_students === undefined ? null : Number(s.n_students),
      })),
      gaps: gaps.map((g) => ({
        codeRank: Number(g.code_rank),
        codeScore: Number(g.code_score),
        targetCodes: (g.target_codes as string[]) ?? [],
        ...(g.low_sample ? { lowSample: { n: Number((g.low_sample as { n: number }).n), minimum: Number((g.low_sample as { minimum: number }).minimum) } } : {}),
      })),
      flags: (r.flags as { id: string; label: string }[]) ?? [],
      tasks: tasks.map((t) => ({ status: String(t.status), actionId: String(t.action_id) })),
    });
    blocks.push(summary);
    // Keep the summary table in step, so the DEO view is a table and not a paragraph.
    try {
      await sql`
        insert into district_blocks_summary (district_id, block_id, block_name, cycle_id, schools, gaps_total, box_ticks, closure_pct,
          single_teacher_schools, vacancy_aged, avg_r3, detail)
        values (${districtId}, ${bid}, ${bid}, ${cycleId}, ${summary.schools}, ${summary.gapsTotal}, ${summary.boxTicks}, ${summary.closurePct},
          ${summary.singleTeacherSchools}, ${summary.vacancyAged}, ${summary.avgR3}, ${JSON.stringify(summary)}::jsonb)
        on conflict (district_id, block_id, cycle_id) do update set computed_at = now(), schools = ${summary.schools},
          gaps_total = ${summary.gapsTotal}, box_ticks = ${summary.boxTicks}, closure_pct = ${summary.closurePct},
          single_teacher_schools = ${summary.singleTeacherSchools}, vacancy_aged = ${summary.vacancyAged},
          avg_r3 = ${summary.avgR3}, detail = ${JSON.stringify(summary)}::jsonb`;
    } catch {
      /* the district table is not there yet; the view still works */
    }
  }

  blocks.sort((a, b) => a.blockName.localeCompare(b.blockName));
  return { districtId, blocks, comparison: compareBlocks(districtId, blocks) };
}
