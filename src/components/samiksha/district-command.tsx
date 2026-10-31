import { useState } from "react";
import { Btn, Chip, Panel } from "@/components/samiksha/ui";
import { EDITABLE_THRESHOLDS } from "@/lib/samiksha/core/config";
import { buildDistrictBlocksSummary, type DistrictBlocksSummary } from "@/lib/samiksha/core/districtView";
import { useCycle, useCan } from "@/lib/samiksha/store";
import { useActions, useView } from "@/lib/samiksha/view";

/**
 * The district command panel.
 *
 * A DEO does not manage one block; they compare several. Every block is put on
 * the same axes, so "Kesli is the worst" is a comparison and not an impression.
 * Level 4 and above only. The SPD's threshold editor sits once, beside the
 * threshold values on Stage 1; the CRCC's cluster desk is on the Follow tab.
 */
export function DistrictCommandPanel() {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const role = useCycle((s) => s.role);
  const can = useCan();
  const { cycle, scorecard, tasks } = useView();

  if (!can("view_all_blocks").allowed) return null;

  const summary: DistrictBlocksSummary = buildDistrictBlocksSummary(cycle, {
    closurePct: scorecard?.closurePct ?? null,
    boxTicks: scorecard?.boxTicks?.length ?? 0,
  });

  return (
    <Panel className="no-print">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-xl">{en ? "Sagar District · Command Summary" : "सागर जिला · कमांड सारांश"}</h2>
        <Chip tone="seal">{en ? `${summary.blocks.length} blocks · ${summary.totalSchools} schools` : `${summary.blocks.length} ब्लॉक · ${summary.totalSchools} विद्यालय`}</Chip>
      </div>
      <p className="mt-2 text-sm text-muted">{en ? summary.note.en : summary.note.hi}</p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[46rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-rule text-left">
              <th className="py-2 pr-3 font-semibold">{en ? "Block" : "ब्लॉक"}</th>
              <th className="py-2 pr-3 font-semibold">{en ? "Schools" : "विद्यालय"}</th>
              <th className="py-2 pr-3 font-semibold">{en ? "G3 Numeracy R3 (%)" : "कक्षा 3 संख्या ज्ञान R3 (%)"}</th>
              <th className="py-2 pr-3 font-semibold">{en ? "R2→R3 Delta" : "R2→R3 अंतर"}</th>
              <th className="py-2 pr-3 font-semibold">{en ? "Open vacancies" : "खुली रिक्तियाँ"}</th>
              <th className="py-2 pr-3 font-semibold">{en ? "Closure rate (%)" : "बंद होने दर (%)"}</th>
              <th className="py-2 pr-3 font-semibold">{en ? "Box-ticks" : "बॉक्स-टिक"}</th>
            </tr>
          </thead>
          <tbody>
            {summary.blocks.map((b) => (
              <tr key={b.blockId} className="border-b border-rule/60">
                <td className="py-2 pr-3 font-medium">
                  {b.blockName}
                  {b.measured ? null : <span className="ml-2 text-xs text-muted">({en ? "baseline" : "आधार"})</span>}
                </td>
                <td className="tabular py-2 pr-3">{b.schools}</td>
                <td className="tabular py-2 pr-3">{b.g3NumeracyR3 ?? "—"}</td>
                <td className="tabular py-2 pr-3">{b.r2ToR3Delta ?? "—"}</td>
                <td className="tabular py-2 pr-3">{b.openVacancies}</td>
                <td className="tabular py-2 pr-3">{b.closureRatePct ?? "—"}</td>
                <td className="tabular py-2 pr-3">{b.boxTickFlags}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {summary.needsAttention ? (
        <p className="mt-3 text-sm">
          <span className="font-semibold">{en ? "Needs attention:" : "ध्यान देने योग्य:"}</span>{" "}
          {summary.needsAttention}
        </p>
      ) : null}
    </Panel>
  );
}

/** The SPD's exclusive power: one threshold of this block, changed at runtime. */
export function ThresholdEditor() {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const can = useCan();
  const { updateThreshold } = useActions();
  const [key, setKey] = useState("min_g3_students_for_flag");
  const [value, setValue] = useState("5");
  if (!can("edit_thresholds").allowed) return null;
  return (
    <div className="mt-5 rounded-xl border border-rule bg-paper/60 p-4">
      <p className="text-sm font-semibold">{en ? "Live thresholds for this block" : "इस ब्लॉक की सीमाएँ"}</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-muted">{en ? "Threshold" : "सीमा"}</span>
          <select className="h-10 rounded-lg border border-rule bg-sheet px-2 text-sm" value={key} onChange={(e) => setKey(e.target.value)}>
            {EDITABLE_THRESHOLDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-muted">{en ? "New value" : "नया मान"}</span>
          <input
            className="h-10 w-28 rounded-lg border border-rule bg-sheet px-2 text-sm"
            type="number"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={en ? "New threshold value" : "सीमा का नया मान"}
          />
        </label>
        <Btn kind="primary" onClick={() => void updateThreshold(key, Number(value))}>
          {en ? "Save threshold" : "सीमा सहेजें"}
        </Btn>
      </div>
      <p className="mt-2 text-xs text-muted">{en ? "Level 5 only. The change is written to block_settings and kept in the audit trail." : "केवल स्तर 5। परिवर्तन block_settings में लिखा जाता है और ऑडिट में रहता है।"}</p>
    </div>
  );
}

/**
 * The CRCC's cluster controls, and the BEO's mid-month transfer.
 *
 * The cluster is the officer's own, taken from the signed session. The transfer
 * moves every open task of that cluster to a new owner in one step, and mints
 * the acting officer if they are not on the roster yet.
 */
export function ClusterCommandPanel() {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const role = useCycle((s) => s.role);
  const cluster = useCycle((s) => s.sessionCluster);
  const can = useCan();
  const { clusterObservation, clusterNudge, bulkReassign } = useActions();
  const { cycle } = useView();
  const [note, setNote] = useState("");
  const [actingName, setActingName] = useState("");
  const [reason, setReason] = useState("");
  const [actingScope, setActingScope] = useState(cluster ?? "C6");

  const isCrcc = role === "CRCC";
  const canCluster = isCrcc && (can("record_cluster_observation").allowed || can("send_cluster_nudge").allowed);
  const canTransfer = can("edit_task").allowed && role !== "HM" && role !== "CRCC";
  if (!canCluster && !canTransfer) return null;

  const clusters = cycle ? [...new Set(cycle.schools.map((s) => s.cluster))].sort() : [];

  return (
    <Panel className="no-print">
      <h2 className="font-display text-xl">{isCrcc ? (en ? `Cluster ${cluster ?? "—"} · CRCC desk` : `क्लस्टर ${cluster ?? "—"} · CRCC डेस्क`) : en ? "Mid-month transfer" : "मध्य-माह स्थानांतरण"}</h2>

      {canCluster ? (
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-muted">{en ? "Three-week classroom observation for this cluster" : "इस क्लस्टर की तीन-सप्ताह कक्षा अवलोकन"}</span>
            <textarea
              className="min-h-24 w-full rounded-lg border border-rule bg-sheet p-3 text-sm"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={en ? "What did you see in the cluster schools this week?" : "इस सप्ताह क्लस्टर के विद्यालयों में क्या देखा?"}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Btn kind="primary" disabled={!note.trim()} onClick={() => void clusterObservation(note)}>
              {en ? "Log cluster observation" : "क्लस्टर अवलोकन दर्ज करें"}
            </Btn>
            <Btn kind="soft" onClick={() => void clusterNudge(cluster)}>
              {en ? "Nudge the cluster's schools" : "क्लस्टर के विद्यालयों को नुस्का दें"}
            </Btn>
          </div>
        </div>
      ) : null}

      {canTransfer ? (
        <div className="mt-5 rounded-xl border border-rule bg-paper/60 p-4">
          <p className="text-sm font-semibold">{en ? "🔄 Mid-month transfer · bulk-reassign cluster tasks" : "🔄 मध्य-माह स्थानांतरण · क्लस्टर कार्यों का सामूहिक पुनर्गठन"}</p>
          <p className="mt-1 text-xs text-muted">
            {en
              ? "Moves every open task of one cluster to a new owner in one step. The acting officer is added to the roster, so their tasks can be owned from that moment."
              : "एक क्लस्टर के सभी खुले कार्य एक ही कदम में नए जिम्मेदार को सौंपे जाते हैं। कार्यरत अधिकारी रोस्टर में जोड़ा जाता है, ताकि उसके कार्यों का जिम्मेदारी तुरंत तय हो सके।"}
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-xs text-muted">{en ? "Cluster" : "क्लस्टर"}</span>
              <select className="h-10 rounded-lg border border-rule bg-sheet px-2 text-sm" value={actingScope} onChange={(e) => setActingScope(e.target.value)}>
                {clusters.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs text-muted">{en ? "Acting officer" : "कार्यरत अधिकारी"}</span>
              <input
                className="h-10 w-56 rounded-lg border border-rule bg-sheet px-2 text-sm"
                value={actingName}
                onChange={(e) => setActingName(e.target.value)}
                placeholder={en ? "Smt. Rekha Jain · Acting CRCC" : "स्मि. रेखा जैन · कार्यरत CRCC"}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs text-muted">{en ? "Reason (kept in the audit trail)" : "कारण (ऑडिट ट्रेल में सहेजा जाता है)"}</span>
              <input
                className="h-10 w-64 rounded-lg border border-rule bg-sheet px-2 text-sm"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={en ? "Original CRCC posted elsewhere" : "मूल CRCC अन्यत्र पदस्थापित"}
              />
            </label>
            <Btn
              kind="primary"
              disabled={!actingName.trim()}
              onClick={() => void bulkReassign(actingScope, `crcc-${actingScope.replace(/^C/i, "")}`, actingName.trim(), reason.trim())}
            >
              {en ? "Reassign the cluster's open tasks" : "क्लस्टर के खुले कार्य सौंपें"}
            </Btn>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
