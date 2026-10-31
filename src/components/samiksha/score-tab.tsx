import { Bar, BarChart, LabelList, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Btn, Chip, Panel, TableHead, useMounted } from "@/components/samiksha/ui";
import { LoopHealthPanel, TrustPanel } from "@/components/samiksha/insight-panels";
import { MeetingSection } from "@/components/samiksha/meeting-section";
import { RewardsPanel } from "@/components/samiksha/todo-rewards-panel";
import { RoadmapPanel } from "@/components/samiksha/roadmap-panel";
import { ACTION_LIBRARY, CONFIG, projectMonthCost, runSelfChecks, type ActionId, type Scorecard } from "@/lib/samiksha/engine";
import { tx, useCycle, type Lang, type LlmCall } from "@/lib/samiksha/store";
import { useActions, useView } from "@/lib/samiksha/view";

const PURPOSE: Record<string, { en: string; hi: string }> = {
  brief_generation: { en: "Brief generation", hi: "ब्रीफ निर्माण" },
  voice_to_tasks: { en: "Voice to tasks", hi: "वॉइस से कार्य" },
  reply_parse: { en: "Reply parse", hi: "उत्तर जाँच" },
  reply_parse_retry: { en: "Reply parse (retry)", hi: "उत्तर जाँच (दोबारा)" },
  reply_simulate: { en: "Reply balance check", hi: "उत्तर संतुलन जाँच" },
  speech_to_text: { en: "Speech to text", hi: "बोलकर-लिखना" },
};

const sign = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;

export function ScoreTab() {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const { cycle, scorecard: score, prepSeconds: prep, llmCalls: calls, r4Loaded: r4 } = useView();
  const { closeLoop: close } = useActions();
  const gate = useCycle((s) => s.gateMessage);

  if (!cycle) return <Panel>{en ? "Load the seeded files first." : "पहले सीडेड फाइलें लोड करें।"}</Panel>;

  return (
    <div className="rise space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl">{en ? "Next-Round Scorecard & Cost Proof" : "अगले चक्र का स्कोरकार्ड व लागत प्रमाण"}</h1>
          <p className="mt-1 max-w-xl text-muted">
            {en
              ? "Marking a task \"done\" is not final success. Round 4 checks whether the learning gap actually narrowed."
              : "केवल 'हो गया' कहना सफलता नहीं है। राउंड 4 जाँचता है कि सीखने का अंतर वास्तव में कम हुआ या नहीं।"}
          </p>
        </div>
        <Btn kind="primary" onClick={close}>
          {r4 ? (en ? "Reload Round 4 (R4)" : "R4 फिर जोड़ें") : (en ? "Load Round 4 (R4) & Close Loop" : "राउंड 4 जोड़ें व लूप बंद करें")}
        </Btn>
      </div>
      {gate ? <p className="text-sm">{tx(gate, lang)}</p> : null}

      {score ? (
        <ScoreDetails score={score} en={en} />
      ) : (
        <Panel>
          <p className="text-sm">
            {en
              ? "Round 4 files are still outside the cycle. Loading them brings in Kesli’s field cycle: the Khedi camp, unfinished Cluster C6 visits, and one box-tick school."
              : "राउंड 4 की फाइलें अभी चक्र से बाहर हैं। जोड़ने पर केसली का फील्ड चक्र जुड़ेगा: खेड़ी का शिविर, अधूरी C6 विज़िट, और एक बॉक्स-टिक स्कूल।"}
          </p>
          <p className="mt-2 text-sm text-muted">
            {en
              ? `Prep so far ${prep.toFixed(2)} s. Target is under ${CONFIG.pilot_targets.review_prep_time_max_minutes} minutes.`
              : `अब तक तैयारी ${prep.toFixed(2)} सेकंड। लक्ष्य ${CONFIG.pilot_targets.review_prep_time_max_minutes} मिनट से कम है।`}
          </p>
        </Panel>
      )}

      <MeetingSection titleEn="Feedback loop resilience monitor" titleHi="फीडबैक लूप सुरक्षा व टूटन निवारण">
        <LoopHealthPanel />
      </MeetingSection>
      <RewardsPanel />
      <MeetingSection titleEn="Trust pillars and the officer workload split" titleHi="विश्वास स्तंभ व अधिकारी कार्यभार विभाजन">
        <TrustPanel compact />
      </MeetingSection>
      <CostLedger calls={calls} lang={lang} />
      <RoadmapPanel />
      <SelfChecks cycle={cycle} en={en} />
    </div>
  );
}

function ScoreDetails({ score, en }: { score: Scorecard; en: boolean }) {
  const target = CONFIG.pilot_targets.action_closure_rate_pct;
  const missed = score.approved - score.closedOnTime;
  const ticked = score.boxTicks.map((b) => b.school);
  // Below target, the card says so, and says what the loop caught, from this cycle's own counts.
  const below = score.closurePct < target
    ? en
      ? `${score.closurePct.toFixed(0)}% (below the ${target}% target) — the loop caught ${missed} task(s) not closed on time${ticked.length ? ` and ${ticked.length} box-ticked "done" (${ticked.join(", ")})` : ""}`
      : `${score.closurePct.toFixed(0)}% (${target}% लक्ष्य से कम) — लूप ने ${missed} कार्य समय पर बंद न होते पकड़े${ticked.length ? ` और ${ticked.length} केवल कागज़ी "पूर्ण" (${ticked.join(", ")})` : ""}`
    : undefined;
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          title={en ? "Action Closure Rate" : "कार्य समापन दर"}
          value={`${score.closurePct.toFixed(0)}%`}
          note={en
            ? `${score.closedOnTime} of ${score.approved} on time · target ${target}%`
            : `${score.closedOnTime}/${score.approved} समय पर · लक्ष्य ${target}%`}
          tone={score.closurePct >= target ? "seal" : "flag"}
          badge={below}
        />
        <Metric
          title={en ? "Review Prep Time" : "समीक्षा तैयारी समय"}
          value={`${score.prepMinutes.toFixed(2)} min`}
          note={en ? `${score.prepSeconds.toFixed(2)} s · target under 60 min` : `${score.prepSeconds.toFixed(2)} सेकंड · लक्ष्य 60 मिनट से कम`}
          tone="seal"
        />
        <Metric
          title={en ? "Gaps with an Owner" : "मालिक वाला अंतर"}
          value={`${score.gapsOwnedPct.toFixed(0)}%`}
          note={en ? `${score.gapsOwned} of ${score.gapsTotal} gaps` : `${score.gapsOwned}/${score.gapsTotal} अंतर`}
          tone="seal"
        />
        <Metric
          title={en ? "Learning Change (R3 → R4)" : "सीखने में बदलाव (R3 → R4)"}
          value={`${sign(score.association)} pts`}
          note={en ? "PS Khedi versus matched controls · association, not causal proof" : "प्रा.शा. खेड़ी बनाम मैच नियंत्रण · संबंध, कारण-सिद्ध नहीं"}
          tone="seal"
        />
      </div>

      <AssociationPanel score={score} en={en} />
      <BoxTickPanel score={score} en={en} />

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel>
          <h2 className="font-display text-xl">{en ? "Cluster C6" : "क्लस्टर C6"}</h2>
          <p className="mt-2 text-sm">
            {en
              ? `Observations closed on time in ${score.c6.observedOnTime} of ${score.c6.schools} schools. Cluster numeracy ${sign(score.c6.delta)} pts. Four schools stayed overdue.`
              : `${score.c6.schools} में से ${score.c6.observedOnTime} स्कूलों में अवलोकन समय पर बंद। क्लस्टर संख्या ज्ञान ${sign(score.c6.delta)} अंक। चार स्कूल अतिदेय रहे।`}
          </p>
        </Panel>
        <Panel>
          <h2 className="font-display text-xl">{en ? "PS Harangaon" : "हरनगाँव"}</h2>
          <p className="mt-2 text-sm">
            {en
              ? `Spot check replaced the 100% streak with a verified ${score.harangaon.to}%. The old ${score.harangaon.from}% does not stay in the average.`
              : `औचक जांच ने 100% की लकीर की जगह सत्यापित ${score.harangaon.to}% रखा। पुराना ${score.harangaon.from}% औसत में नहीं रहता।`}
          </p>
        </Panel>
      </div>

      <Panel>
        <h2 className="font-display text-xl">{en ? "Closure by owner" : "समापन, मालिक के हिसाब से"}</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {score.byAction.map((a) => (
            <li key={a.actionId} className="flex justify-between gap-3 border-b border-rule py-2">
              <span>{en ? ACTION_LIBRARY[a.actionId as ActionId].name_en : ACTION_LIBRARY[a.actionId as ActionId].name_hi}</span>
              <span className="tabular">{a.closed}/{a.approved} {en ? "on time" : "समय पर"}</span>
            </li>
          ))}
          {score.byOwner.map((o) => (
            <li key={o.name} className="flex justify-between gap-3 border-b border-rule py-2">
              <span>{en ? o.name : o.nameHi} · {o.role}</span>
              <span className="tabular">{o.closed}/{o.approved}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}

function AssociationPanel({ score, en }: { score: Scorecard; en: boolean }) {
  const mounted = useMounted();
  const data = [
    { name: en ? "PS Khedi" : "प्रा.शा. खेड़ी", R3: score.khedi.r3, R4: score.khedi.r4 },
    { name: en ? "Matched mean" : "मैच औसत", R3: mean(score.controls, "r3"), R4: mean(score.controls, "r4") },
  ];
  return (
    <Panel className="border-flag">
      <Chip tone="flag">{en ? "Association, not causal proof" : "संबंध, कारण-सिद्ध नहीं"}</Chip>
      <p className="mt-3 text-sm">
        {en
          ? `PS Khedi moved from ${score.khedi.r3}% to ${score.khedi.r4}% (${sign(score.khedi.delta)}). Matched schools that were low in R3 but not actioned moved ${sign(score.matchedMean)} on average. The gap between those two numbers is ${score.association.toFixed(1)} points. Same baseline band. Not a trial.`
          : `प्रा.शा. खेड़ी ${score.khedi.r3}% से ${score.khedi.r4}% हुई (${sign(score.khedi.delta)})। R3 में कम, पर जिन पर कार्य नहीं हुआ, वे स्कूल औसत ${sign(score.matchedMean)} हिले। दोनों का अंतर ${score.association.toFixed(1)} अंक है। एक ही आधार पट्टी। यह परीक्षण नहीं है।`}
      </p>
      <div className="mt-4 h-56">
        {mounted ? (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 20, right: 8, left: 0, bottom: 0 }}>
              <XAxis dataKey="name" tick={{ fill: "var(--color-muted)", fontSize: 12 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "var(--color-muted)", fontSize: 12 }} axisLine={false} tickLine={false} />
              <Tooltip />
              <Legend />
              <Bar dataKey="R3" fill="var(--color-rule-strong)" radius={[4, 4, 0, 0]}>
                <LabelList dataKey="R3" position="top" fontSize={12} fill="var(--color-ink)" />
              </Bar>
              <Bar dataKey="R4" fill="var(--color-seal)" radius={[4, 4, 0, 0]}>
                <LabelList dataKey="R4" position="top" fontSize={12} fill="var(--color-ink)" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : null}
      </div>
    </Panel>
  );
}

function BoxTickPanel({ score, en }: { score: Scorecard; en: boolean }) {
  return (
    <Panel>
      <h2 className="font-display text-xl">{en ? "Box-ticking guardrail" : "बॉक्स-टिक जाँच"}</h2>
      <div className="mt-3 overflow-x-auto rounded-lg border border-rule">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <TableHead cols={en ? ["School", "R3", "R4", "Numeracy", "Oct–Nov", "Dec"] : ["विद्यालय", "R3", "R4", "संख्या ज्ञान", "अक्टू–नव", "दिस"]} />
          <tbody>
            {score.singles.map((s) => (
              <tr key={s.name} className={`border-t border-rule hover:bg-paper/50 ${s.boxTick ? "bg-flag-soft" : ""}`}>
                <td className="px-4 py-3.5">
                  {en ? s.name : s.nameHi}
                  {s.boxTick ? <span className="mt-1 block text-flag">{en ? "Task marked done, outcome flat" : "कार्य पूर्ण चिह्नित, परिणाम सपाट"}</span> : null}
                </td>
                <td className="tabular px-4 py-3.5">{s.r3}%</td>
                <td className="tabular px-4 py-3.5">{s.r4}%</td>
                <td className="tabular px-4 py-3.5">{s.delta.toFixed(1)}</td>
                <td className="tabular px-4 py-3.5">{s.attFrom.toFixed(0)}%</td>
                <td className="tabular px-4 py-3.5">{s.attTo.toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {score.boxTicks.map((b) => (
        <p key={b.school} className="mt-3 text-sm text-flag">{en ? b.detailEn : b.detailHi}</p>
      ))}
    </Panel>
  );
}

function CostLedger({ calls, lang }: { calls: LlmCall[]; lang: Lang }) {
  const en = lang === "en";
  const projection = projectMonthCost();
  return (
    <Panel>
      <h2 className="font-display text-xl">{en ? "Cost ledger" : "लागत का हिसाब"}</h2>
      <p className="mt-1 text-sm text-muted">
        {en
          ? `A full block-month at the brief’s Claude price: ${projection.tokensIn.toLocaleString("en-IN")} input tokens and ${projection.tokensOut.toLocaleString("en-IN")} output tokens ≈ ₹${projection.inr.toFixed(2)} (₹${projection.bufferedInr.toFixed(2)} with a 2× buffer for Hindi tokens and retries), plus ₹${projection.sttLow}–${projection.sttHigh} speech. This session’s rows are a simulated ledger unless you asked Claude AI to reorder the brief.`
          : `ब्रीफ की Claude कीमत पर पूरा विकासखंड-माह: ${projection.tokensIn.toLocaleString("en-IN")} इनपुट टोकन और ${projection.tokensOut.toLocaleString("en-IN")} आउटपुट टोकन ≈ ₹${projection.inr.toFixed(2)} (हिन्दी टोकन व दोबारा प्रयास हेतु 2× बफ़र सहित ₹${projection.bufferedInr.toFixed(2)}), साथ में ₹${projection.sttLow}–${projection.sttHigh} वाक्। इस सत्र की पंक्तियाँ नकली खाता हैं, जब तक आप Claude AI से क्रम न लिखवाएँ।`}
      </p>
      <div className="mt-4 overflow-x-auto rounded-lg border border-rule">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <TableHead cols={en ? ["Purpose", "Model", "In", "Out", "₹", "Check"] : ["उद्देश्य", "मॉडल", "इन", "आउट", "₹", "जाँच"]} />
          <tbody>
            {calls.map((c) => (
              <tr key={c.id} className="border-t border-rule hover:bg-paper/50">
                <td className="px-4 py-3.5">
                  {PURPOSE[c.purpose]?.[lang] ?? c.purpose}
                  {c.simulated ? (en ? " · simulated" : " · नकली") : ""}
                </td>
                <td className="px-4 py-3.5">{c.model === "code-template" ? (en ? "Code template" : "कोड टेम्पलेट") : c.model}</td>
                <td className="tabular px-4 py-3.5">{c.tokensIn}</td>
                <td className="tabular px-4 py-3.5">{c.tokensOut}</td>
                <td className="tabular px-4 py-3.5">{c.inr.toFixed(3)}</td>
                <td className="px-4 py-3.5">{c.passed ? (en ? "passed" : "पास") : (en ? "rejected" : "अस्वीकृत")}</td>
              </tr>
            ))}
            <tr className="border-t border-rule font-medium">
              <td className="px-4 py-3.5">{en ? "Month projection" : "मासिक अनुमान"}</td>
              <td className="px-4 py-3.5">{en ? "Claude Sonnet card" : "Claude Sonnet कार्ड"}</td>
              <td className="tabular px-4 py-3.5">{projection.tokensIn}</td>
              <td className="tabular px-4 py-3.5">{projection.tokensOut}</td>
              <td className="tabular px-4 py-3.5">{projection.inr.toFixed(2)}</td>
              <td className="px-4 py-3.5">{en ? "estimate" : "अनुमान"}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function SelfChecks({ cycle, en }: { cycle: Parameters<typeof runSelfChecks>[0]; en: boolean }) {
  const checks = runSelfChecks(cycle);
  const passing = checks.filter((c) => c.pass).length;
  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-xl">{en ? "Automated self-checks" : "स्वचालित स्व-जाँच"}</h2>
        <Chip tone={passing === checks.length ? "seal" : "flag"}>
          {en ? `${passing} of ${checks.length} passing` : `${checks.length} में से ${passing} पास`}
        </Chip>
      </div>
      <p className="mt-1 text-sm text-muted">
        {en
          ? "Re-run in your browser on this cycle with the engine's own functions. They show the guardrails hold on this data. They are not a score."
          : "इस चक्र पर इंजन के अपने फ़ंक्शन से आपके ब्राउज़र में दोबारा चलती हैं। ये दिखाती हैं कि गार्डरेल इस डेटा पर टिकते हैं। यह अंक नहीं है।"}
      </p>
      <div className="mt-4 overflow-x-auto rounded-lg border border-rule">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <TableHead cols={en ? ["#", "Check", "Measured", "Result"] : ["#", "जाँच", "मापा गया", "परिणाम"]} />
          <tbody>
            {checks.map((c) => (
              <tr key={c.id} className={`border-t border-rule ${c.pass ? "" : "bg-flag-soft"}`}>
                <td className="tabular px-4 py-3.5">{c.id}</td>
                <td className="px-4 py-3.5">{en ? c.en : c.hi}</td>
                <td className="px-4 py-3.5 text-muted">{en ? c.value : c.valueHi}</td>
                <td className="px-4 py-3.5">
                  <Chip tone={c.pass ? "seal" : "flag"}>{c.pass ? (en ? "pass" : "पास") : (en ? "fail" : "फेल")}</Chip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted">
        {en
          ? "The 12 Hinglish field-reply fixtures through Laya and Claude run on the server: npm run eval:replies."
          : "Laya और Claude से 12 हिंग्लिश मैदानी-उत्तर फिक्स्चर सर्वर पर चलते हैं: npm run eval:replies।"}
      </p>
    </Panel>
  );
}

function Metric({ title, value, note, tone, badge }: { title: string; value: string; note: string; tone: "seal" | "flag"; badge?: string }) {
  return (
    <Panel className={tone === "flag" ? "border-t-4 border-t-flag" : "border-t-4 border-t-seal"}>
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</p>
      <p className="tabular mt-2 font-display text-4xl font-bold">{value}</p>
      <p className="mt-2 text-sm text-muted">{note}</p>
      {badge ? <p className="mt-2 rounded-lg bg-flag-soft px-2.5 py-1.5 text-xs font-semibold text-flag">{badge}</p> : null}
    </Panel>
  );
}

function mean(rows: { r3: number; r4: number }[], key: "r3" | "r4") {
  if (!rows.length) return 0;
  return Math.round((rows.reduce((a, r) => a + r[key], 0) / rows.length) * 10) / 10;
}
