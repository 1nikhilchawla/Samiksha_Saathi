import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Bar, BarChart, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Btn, Chip, Panel, TableHead, useMounted } from "@/components/samiksha/ui";
import { TrustPanel } from "@/components/samiksha/insight-panels";
import { MeetingSection } from "@/components/samiksha/meeting-section";
import {
  ACTION_LIBRARY,
  DEFAULT_TOP_GAPS_LIMIT,
  TOP_GAPS_OPTIONS,
  availableTopLimits,
  buildAllowedSet,
  checkWatchlistDraft,
  getGapsForLimit,
  isWatchlistGap,
  validateNumbers,
  type Gap,
  type Person,
  type Task,
  type TopGapsLimit,
} from "@/lib/samiksha/engine";
import { STATUS_LABEL, label, peerRuleText } from "@/lib/samiksha/labels";
import { narrateGaps } from "@/lib/samiksha/narrate";
import { isOffline } from "@/lib/samiksha/offlineSync";
import { tx, useCan, useCycle, type Copy, type Lang } from "@/lib/samiksha/store";
import { useActions, useView } from "@/lib/samiksha/view";

type CycleView = NonNullable<ReturnType<typeof useView>["cycle"]>;

const topLabel = (n: TopGapsLimit, en: boolean) =>
  n === DEFAULT_TOP_GAPS_LIMIT ? (en ? "Top 5 (Default)" : "शीर्ष 5 (डिफ़ॉल्ट)") : en ? `Top ${n}` : `शीर्ष ${n}`;

export function BriefTab() {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const { cycle, allRankedGaps, tasks } = useView();
  const banner = useCycle((s) => s.banner);
  const briefMode = useCycle((s) => s.briefMode);
  const rankedLimit = useCycle((s) => s.rankedLimit);
  const picked = useCycle((s) => s.topGapsLimit);
  const setTopGapsLimit = useCycle((s) => s.setTopGapsLimit);
  const clearBanner = useCycle((s) => s.clearBanner);
  const gateMessage = useCycle((s) => s.gateMessage);

  const pool = { gaps: cycle?.gaps ?? [], allRankedGaps };
  const options = availableTopLimits(pool);
  // A cycle built before the watchlist has only the core gaps, so it shows Top 5 whatever was picked.
  const limit = options.includes(picked) ? picked : DEFAULT_TOP_GAPS_LIMIT;

  // The button and the store must never disagree. When the cycle changes under
  // a choice the cycle can no longer fill, the stored choice follows what is
  // actually on screen.
  useEffect(() => {
    if (picked !== limit) setTopGapsLimit(limit);
  }, [picked, limit, setTopGapsLimit]);

  if (!cycle) return <Panel>{en ? "Load the seeded files first." : "पहले सीडेड फाइलें लोड करें।"}</Panel>;

  const gaps = getGapsForLimit(pool, limit);
  const allowed = buildAllowedSet(cycle.briefInput);
  const numbersBad = validateNumbers(cycle.briefEn, allowed).length > 0 || validateNumbers(cycle.briefHi, allowed).length > 0;
  const actionsOk = gaps.every((g) => g.allowedActions.includes(g.actionId) && ACTION_LIBRARY[g.actionId]);
  const citesOk = gaps.every((g) => g.sourceRefs.length > 0 && g.sourceRefs.every((c) => c.file && c.row && c.verbatim));
  const modeChip = briefMode === "claude"
    ? (en ? `AI Co-Pilot Reorder (Laya 5-Check Verified) · Top ${rankedLimit ?? DEFAULT_TOP_GAPS_LIMIT}` : `AI सह-पायलट क्रम (लाया 5-जाँच सत्यापित) · शीर्ष ${rankedLimit ?? DEFAULT_TOP_GAPS_LIMIT}`)
    : briefMode === "fallback"
      ? (en ? "Standard Rule Ranking Active · 100% Deterministic Gap Numbers" : "मानक नियम क्रम सक्रिय · सभी अंतर-आँकड़े 100% कोड से")
      : (en ? "Verified Code Ranking" : "सत्यापित कोड क्रम");
  const confidence = useCycle((s) => s.layaConfidence);
  const confidenceChip =
    confidence === null
      ? null
      : en
        ? `Second check ${confidence.toFixed(2)} · ${confidence >= 0.9 ? "high" : confidence >= 0.6 ? "medium" : "low"} confidence`
        : `द्वितीय जाँच ${confidence.toFixed(2)} · ${confidence >= 0.9 ? "उच्च" : confidence >= 0.6 ? "मध्यम" : "निम्न"} विश्वसनीयता`;
  const stateCode = useCycle((s) => s.stateCode);
  const detected = cycle?.detectedStateCode ?? stateCode;
  const stateChip = en
    ? `State profile: ${detected} (${detected === "MP" ? "Madhya Pradesh" : detected === "UP" ? "Uttar Pradesh" : detected === "PB" ? "Punjab" : "Haryana"})`
    : `राज्य प्रोफ़ाइल: ${detected}`;
  const headerLine = en
    ? "Block Education Review · Kesli (MP) · 30 Nov 2025 · MP-PILOT-BLK01 · demo data"
    : "विकासखंड शिक्षा समीक्षा · केसली (म.प्र.) · 30 नवम्बर 2025 · MP-PILOT-BLK01 · डेमो डेटा";

  return (
    <div className="rise space-y-8">
      <div className="no-print flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl">{en ? "One-Page Review Brief" : "समीक्षा एजेंडा (एक-पृष्ठ ब्रीफ)"}</h1>
          <p className="mt-1 text-muted">
            {en
              ? "Every figure is computed by code and verified by the Number-Check guardrail."
              : "प्रत्येक आँकड़ा कोड द्वारा गणना और नंबर-चेक गार्डरेल द्वारा सत्यापित है।"}
          </p>
        </div>
        <Btn kind="primary" onClick={() => window.print()}>
          {en ? "Print A4 PDF" : "A4 प्रिंट करें"}
        </Btn>
      </div>

      <div className="no-print flex flex-wrap gap-3">
        <Chip tone={numbersBad ? "flag" : "seal"}>{numbersBad ? (en ? "Number check failed" : "नंबर-चेक फेल") : (en ? "Number check passed" : "नंबर-चेक पास")}</Chip>
        <Chip tone={actionsOk ? "seal" : "flag"}>{actionsOk ? (en ? "Action library verified" : "कार्य सूची सत्यापित") : (en ? "Action outside library" : "कार्य सूची से बाहर")}</Chip>
        <Chip tone={citesOk ? "seal" : "flag"}>{citesOk ? (en ? "Source citations linked" : "स्रोत उद्धरण जुड़े") : (en ? "Citation missing" : "उद्धरण अधूरा")}</Chip>
        <Chip tone="seal">{en ? "Zero student PII" : "शून्य विद्यार्थी PII"}</Chip>
        <Chip>{modeChip}</Chip>
        {confidenceChip ? <Chip tone={confidence !== null && confidence < 0.6 ? "flag" : "seal"}>{confidenceChip}</Chip> : null}
        <Chip>{stateChip}</Chip>
      </div>

      {banner ? (
        <Panel className="no-print border-flag bg-flag-soft">
          <p className="font-medium text-flag">{tx(banner, lang)}</p>
          {gateMessage ? <p className="mt-1 text-sm">{tx(gateMessage, lang)}</p> : null}
          <Btn kind="ghost" className="mt-3" onClick={clearBanner}>
            {en ? "Restore Verified Code Brief" : "सत्यापित कोड ब्रीफ रखें"}
          </Btn>
        </Panel>
      ) : null}

      <GuardrailToolbar en={en} limit={limit} options={options} />
      <MeetingSection titleEn="Trust, workload and the live checks behind the numbers" titleHi="विश्वास, कार्यभार व आँकड़ों के पीछे की जीवित जाँच">
        <TrustPanel />
      </MeetingSection>

      <article id="brief-sheet" className="rounded-xl border border-rule bg-sheet p-5 shadow-[0_1px_3px_rgba(15,31,51,0.04)] sm:p-8">
        <header className="border-b border-rule pb-4">
          <h2 className="font-display text-2xl leading-snug sm:text-3xl">{headerLine}</h2>
        </header>

        <section className="mt-5 grid gap-4 sm:grid-cols-3">
          <Stat k={en ? "Files read" : "फाइलें पढ़ी गईं"} v={String(cycle.summary.files_read)} />
          <Stat k={en ? "Schools joined" : "स्कूल जुड़े"} v={String(cycle.summary.schools)} />
          <Stat
            k={en ? "Data problems" : "डेटा समस्याएँ"}
            v={String(cycle.summary.data_problems)}
            d={en ? `${cycle.summary.auto_fixed} codes auto-fixed` : `${cycle.summary.auto_fixed} कोड स्वतः सुधारे`}
          />
        </section>

        <p className="mt-5 text-sm">
          {en
            ? 'The lead metric is Grade 3 numeracy on PARAKH 2024 competency C-8.4 ("arranges numbers up to 99"), where Grade 3 averaged 55% nationally.'
            : "इस एजेंडा का माप PARAKH C-8.4 पर कक्षा 3 है। 99 तक संख्या सजाने पर कक्षा 3 का राष्ट्रीय औसत 55% था। यह ब्लॉक औसत नहीं है।"}
        </p>

        <GapList gaps={gaps} en={en} limit={limit} options={options} />
        <PeerSection cycle={cycle} en={en} />
        {tasks.length ? <LoopStatus tasks={tasks} people={cycle.people} lang={lang} /> : null}
        <p className="mt-6 text-xs text-muted">
          {en
            ? "No closed task from the previous cycle is in this file. Round 4 will close the loop. Thresholds are in the upload ledger."
            : "पिछले चक्र का कोई बंद कार्य इस फाइल में नहीं है। राउंड 4 लूप बंद करेगा। सीमाएँ अपलोड खाते में छपी हैं।"}
        </p>
      </article>
    </div>
  );
}

/** Top 5 (Default) | Top 10 | Top 15. An option this cycle cannot fill is disabled. */
function TopGapsToggle({ en, limit, options }: { en: boolean; limit: TopGapsLimit; options: TopGapsLimit[] }) {
  const setLimit = useCycle((s) => s.setTopGapsLimit);
  return (
    <div role="group" aria-label={en ? "How many priority gaps to list" : "कितने प्राथमिकता अंतर दिखाएँ"} className="no-print inline-flex overflow-hidden rounded-full border border-rule">
      {TOP_GAPS_OPTIONS.map((n, i) => {
        const active = n === limit;
        const open = options.includes(n);
        return (
          <button
            key={n}
            type="button"
            aria-pressed={active}
            disabled={!open}
            title={open ? undefined : en ? "This cycle has no watchlist yet. Run the cycle again in Stage 1." : "इस चक्र में निगरानी सूची नहीं है। चरण 1 में चक्र फिर चलाएँ।"}
            onClick={() => setLimit(n)}
            className={`h-11 px-4 text-sm ${i ? "border-l border-rule" : ""} ${active ? "bg-seal font-semibold text-seal-fg shadow-xs" : "bg-sheet text-ink hover:bg-sheet-2"} disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {topLabel(n, en)}
          </button>
        );
      })}
    </div>
  );
}

/** The three buttons that prove the guardrails: two injected figures and the Claude reorder of the listed gaps. */
function GuardrailToolbar({ en, limit, options }: { en: boolean; limit: TopGapsLimit; options: TopGapsLimit[] }) {
  const { cycleId, blockId, allRankedGaps, reorders } = useView();
  const { poisonBrief: poison, refresh } = useActions();
  const grokBusy = useCycle((s) => s.grokBusy);
  const setGrokBusy = useCycle((s) => s.setGrokBusy);
  const [grokError, setGrokError] = useState("");
  const [lastCallsLeft, setLastCallsLeft] = useState<number | null>(null);
  // The server's own count after an ask; before the first ask, this month's ledger.
  const callsLeft = lastCallsLeft ?? (reorders ? Math.max(0, reorders.cap - reorders.used) : null);
  const cap = reorders?.cap ?? 40;
  const extra = limit - DEFAULT_TOP_GAPS_LIMIT;
  const watchCount = allRankedGaps.filter(isWatchlistGap).length;

  const ask = async () => {
    setGrokError("");
    // Claude's reorder is the one step of the brief that needs the network; offline, the code order simply stays.
    if (isOffline()) {
      setGrokError(en ? "Offline: Claude's reorder needs the connection. The code order stays, and every number on this page still holds." : "ऑफ़लाइन: Claude के क्रम के लिए कनेक्शन चाहिए। कोड क्रम वही रहता है, इस पृष्ठ का हर अंक सही है।");
      return;
    }
    setGrokBusy(true);
    try {
      const res = await narrateGaps({ data: { blockId: blockId!, cycleId: cycleId!, limit } });
      if (res.callsLeft !== undefined) setLastCallsLeft(res.callsLeft);
      if (!res.ok) {
        setGrokError(aiError(res.error, en));
        return;
      }
      useCycle.setState({ briefMode: "claude", banner: null, rankedLimit: res.limit, layaConfidence: res.layaConfidence ?? null });
    } catch {
      setGrokError(en ? "The reorder did not complete. The code order is unchanged." : "क्रम नहीं बदला। कोड क्रम वही है।");
    } finally {
      setGrokBusy(false);
      await refresh();
    }
  };

  return (
    <div className="no-print rounded-xl border border-rule bg-sheet p-4 shadow-[0_1px_3px_rgba(15,31,51,0.04)] sm:p-5">
      <p className="text-sm font-semibold">{en ? "Verify AI Guardrails & Ranking:" : "AI गार्डरेल व क्रम जाँचें:"}</p>
      <div className="mt-3 flex flex-wrap gap-3">
        <Btn kind="ghost" onClick={() => poison(false)}>
          {en ? 'Test Guardrail: Inject "42%"' : "42% डालकर जाँचें"}
        </Btn>
        <Btn kind="ghost" onClick={() => poison(true)}>
          {en ? 'Test Guardrail: Inject "४२%"' : "४२% डालकर जाँचें"}
        </Btn>
        <TopGapsToggle en={en} limit={limit} options={options} />
        <Btn kind="primary" disabled={grokBusy} onClick={ask}>
          {grokBusy ? (en ? "Ordering..." : "लिख रहा है…") : en ? `Order Top ${limit} with Claude AI` : `Claude AI से शीर्ष ${limit} का क्रम लिखवाएँ`}
        </Btn>
      </div>
      <p className="mt-3 text-xs text-muted">
        {extra
          ? en
            ? `Showing Top ${limit} Priority Gaps: 5 core gaps + ${extra} watchlist schools. Code picks the list; Claude only reorders it.`
            : `शीर्ष ${limit} प्राथमिकता अंतर: 5 मुख्य अंतर + ${extra} निगरानी विद्यालय। सूची कोड चुनता है; Claude केवल क्रम बदलता है।`
          : en
            ? "Showing Top 5 Priority Gaps (default core shortlist)."
            : "शीर्ष 5 प्राथमिकता अंतर (डिफ़ॉल्ट मुख्य सूची)।"}
        {options.length === TOP_GAPS_OPTIONS.length
          ? ""
          : !watchCount
            ? en
              ? " This cycle has no watchlist: it was built before the watchlist, or no unflagged school scores above 0. Run the cycle again in Stage 1."
              : " इस चक्र में निगरानी सूची नहीं: यह उससे पहले बना, या कोई अचिह्नित विद्यालय 0 से ऊपर नहीं। चरण 1 में चक्र फिर चलाएँ।"
            : en
              ? ` Only ${watchCount} unflagged schools score above 0, so ${watchCount < 5 ? "Top 10 and Top 15 are" : "Top 15 is"} off.`
              : ` केवल ${watchCount} अचिह्नित विद्यालय 0 से ऊपर हैं, इसलिए ${watchCount < 5 ? "शीर्ष 10 और 15" : "शीर्ष 15"} बंद है।`}
      </p>
      {callsLeft !== null ? (
        <p className="mt-2 text-xs">
          <Chip tone={callsLeft > 5 ? "plain" : "flag"}>
            {en ? `${callsLeft}/${cap} AI reorders remaining this month` : `इस माह ${cap} में से ${callsLeft} AI क्रम शेष`}
          </Chip>
          <span className="ml-2 text-muted">
            {en ? "Asking for the same list again is served from the stored order and costs nothing." : "वही सूची दोबारा माँगने पर सहेजा क्रम मिलता है, कोई लागत नहीं।"}
          </span>
        </p>
      ) : null}
      {/* An unset or unreachable model is not an error: the verified code ranking simply stays, so the note is calm. */}
      {grokError ? <p className="mt-3 inline-flex rounded-full bg-seal-soft px-3 py-1 text-sm text-seal" role="status">{grokError}</p> : null}
    </div>
  );
}

function GapList({ gaps, en, limit, options }: { gaps: Gap[]; en: boolean; limit: TopGapsLimit; options: TopGapsLimit[] }) {
  const extra = limit - DEFAULT_TOP_GAPS_LIMIT;
  const heading = en
    ? `Top ${limit} Priority Gaps ${extra ? `(5 Core Gaps + ${extra} Extended Watchlist)` : "(Default Shortlist)"}`
    : `शीर्ष ${limit} प्राथमिकता अंतर ${extra ? `(5 मुख्य अंतर + ${extra} विस्तारित निगरानी)` : "(डिफ़ॉल्ट सूची)"}`;
  return (
    <>
      <div className="mt-8 flex flex-wrap items-end justify-between gap-3">
        <h3 className="font-display text-xl">{heading}</h3>
        <TopGapsToggle en={en} limit={limit} options={options} />
      </div>
      <ol className="mt-4 space-y-4">
        {gaps.map((g, i) => {
          const watch = isWatchlistGap(g);
          return (
            <li key={g.id} className={`rounded-xl border border-rule border-l-4 bg-paper/40 p-4 sm:p-5 ${watch ? "border-l-rule-strong" : "border-l-seal"}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="text-base font-bold text-ink">
                  <span className="tabular mr-2 text-seal">{i + 1}.</span>
                  {en ? g.targetLabel : g.targetLabelHi}
                </p>
                <div className="flex flex-wrap gap-2">
                  {watch ? (
                    <Chip>
                      {g.tier === "extended_top_15"
                        ? (en ? "Extended watchlist · Top 15" : "विस्तारित निगरानी · शीर्ष 15")
                        : (en ? "Extended watchlist · Top 10" : "विस्तारित निगरानी · शीर्ष 10")}
                    </Chip>
                  ) : null}
                  {g.gapKind === "watchlist_control" ? <Chip tone="flag">{en ? "Round 4 comparison school" : "राउंड 4 तुलना विद्यालय"}</Chip> : null}
                  {g.lowSample ? (
                    <Chip tone="flag">
                      {en
                        ? `Low confidence · N=${g.lowSample.n} (under ${g.lowSample.minimum}) · verify before acting`
                        : `कम विश्वसनीयता · N=${g.lowSample.n} (${g.lowSample.minimum} से कम) · कार्य से पहले जाँचें`}
                    </Chip>
                  ) : null}
                  <span className="inline-flex items-center rounded-full border border-rule bg-sheet px-3 py-1 text-xs font-semibold text-muted">
                    {en ? `Code rank ${g.codeRank} · Claude rank ${g.claudeRank}` : `कोड क्रम ${g.codeRank} · Claude क्रम ${g.claudeRank}`}
                  </span>
                </div>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-rule bg-sheet p-3">
                  <p className="text-xs font-semibold tracking-wide text-muted uppercase">{en ? "Deterministic fact (from code)" : "कोड से प्राप्त तथ्य"}</p>
                  <p className="mt-2 text-sm">{en ? g.factEn : g.factHi}</p>
                </div>
                <div className="rounded-lg border border-rule bg-sheet p-3">
                  <p className="text-xs font-semibold tracking-wide text-muted uppercase">{en ? "Root cause & visit log synthesis" : "मूल कारण व भ्रमण टिप्पणी"}</p>
                  <p className="mt-2 text-sm">{en ? g.reasonEn : g.reasonHi}</p>
                </div>
              </div>
              <p className="mt-3 text-xs text-muted">
                <span className="font-semibold">{en ? "Ordering rationale: " : "क्रम का कारण: "}</span>
                {en ? g.rankJustificationEn : g.rankJustificationHi}
              </p>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-3">
                <Chip tone="seal">{en ? ACTION_LIBRARY[g.actionId].name_en : ACTION_LIBRARY[g.actionId].name_hi}</Chip>
                <div className="flex flex-wrap gap-2">
                  {g.sourceRefs.map((c) => (
                    <Popover.Root key={`${c.file}-${c.row}-${c.verbatim}`}>
                      <Popover.Trigger className="inline-flex h-11 items-center rounded-full border border-rule bg-sheet px-3 text-xs font-semibold text-seal">
                        {en ? `${c.file} · row ${c.row}` : `${c.file} · पंक्ति ${c.row}`}
                      </Popover.Trigger>
                      <Popover.Portal>
                        <Popover.Content className="z-30 w-72 rounded-xl border border-rule bg-sheet p-4 text-sm shadow-sm" sideOffset={6}>
                          <p className="font-semibold">{c.schoolOrCluster}</p>
                          <p className="mt-1 text-muted">{c.file}, {en ? "row" : "पंक्ति"} {c.row}</p>
                          <p className="mt-2">{c.verbatim}</p>
                        </Popover.Content>
                      </Popover.Portal>
                    </Popover.Root>
                  ))}
                </div>
              </div>
              {/* The classroom playbook: what the officer actually does in the room on the next visit. */}
              <div className="mt-3 rounded-lg border border-seal/40 bg-seal-soft/50 p-3">
                <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                  {en ? "Classroom playbook — what to do in the room" : "कक्षा प्लेबुक — कक्षा में क्या करें"}
                </p>
                <p className="mt-2 text-sm">
                  {en ? ACTION_LIBRARY[g.actionId].classroomPlaybookEn : ACTION_LIBRARY[g.actionId].classroomPlaybookHi}
                </p>
              </div>
              {watch ? <WatchDraft gap={g} en={en} /> : null}
            </li>
          );
        })}
      </ol>
    </>
  );
}

/** "+ Add draft task" on a watchlist card. The draft starts without owner or date, so approval stays locked. */
function WatchDraft({ gap, en }: { gap: Gap; en: boolean }) {
  const { tasks, r4Loaded } = useView();
  const { draftWatchlist } = useActions();
  const right = useCan()("record_note");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Copy | null>(null);
  const lang: Lang = en ? "en" : "hi";
  const check = checkWatchlistDraft(gap, tasks, r4Loaded);
  const blocked = !right.allowed ? (en ? right.reasonEn : right.reasonHi) : check.ok ? null : check.reason[lang];
  const add = async () => {
    setBusy(true);
    const r = await draftWatchlist(gap.id);
    setResult(r.gate);
    setBusy(false);
  };
  return (
    <div className="no-print mt-3 flex flex-wrap items-center gap-3">
      <Btn kind="soft" disabled={busy || Boolean(blocked)} onClick={add}>
        {busy ? (en ? "Adding..." : "जोड़ रहे हैं…") : en ? "+ Add draft task for this gap" : "+ इस अंतर का ड्राफ्ट कार्य जोड़ें"}
      </Btn>
      {result ? <p className="text-xs">{tx(result, lang)}</p> : blocked ? <p className="text-xs text-muted">{blocked}</p> : null}
    </div>
  );
}

function PeerSection({ cycle, en }: { cycle: CycleView; en: boolean }) {
  const mounted = useMounted();
  const { peer } = cycle;
  const deltas = peer.matchedDeltas.map((d) => d.toFixed(1)).join(", ");
  const chart = [
    { name: "Kesli", delta: peer.pilotDelta },
    ...cycle.peers.filter((p) => p.matched).map((p) => ({ name: p.name.replace("Peer ", ""), delta: p.delta })),
  ];
  return (
    <>
      <h3 className="font-display mt-8 text-xl">{en ? "Excuse Check (Peer Block Benchmark)" : "बहाना जाँच (समकक्ष विकासखंड तुलना)"}</h3>
      <p className="mt-2 text-sm">{en ? "Rule" : "नियम"}: {peerRuleText(peer.rule, en ? "en" : "hi")}</p>
      <p className="mt-1 text-sm">
        {en
          ? `Kesli changed ${peer.pilotDelta.toFixed(1)} pts (${peer.y1.toFixed(1)}% to ${peer.y2.toFixed(1)}%) vs comparable election-year rural blocks: ${deltas} pts.`
          : `केसली में ${peer.pilotDelta.toFixed(1)} अंक का परिवर्तन (${peer.y1.toFixed(1)}% से ${peer.y2.toFixed(1)}%), जबकि समकक्ष चुनाव-वर्ष ग्रामीण विकासखंडों में: ${deltas} अंक।`}
      </p>
      <p className="mt-2 font-medium">{en ? peer.conclusionEn : peer.conclusionHi}</p>
      <div className="mt-4 h-56">
        {mounted ? (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chart} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
              <XAxis dataKey="name" tick={{ fill: "var(--color-muted)", fontSize: 12 }} axisLine={false} tickLine={false} />
              {/* Headroom both ways so value labels clear the bar ends and the axis text. */}
              <YAxis
                domain={[(min: number) => Math.min(0, Math.floor(min)) - 3, (max: number) => Math.max(0, Math.ceil(max)) + 2]}
                allowDecimals={false}
                tick={{ fill: "var(--color-muted)", fontSize: 12 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip cursor={{ fill: "var(--color-sheet-2)" }} />
              <ReferenceLine y={0} stroke="var(--color-rule-strong)" />
              <Bar dataKey="delta" radius={[4, 4, 0, 0]}>
                {chart.map((row) => (
                  <Cell key={row.name} fill={row.name === "Kesli" ? "var(--color-flag)" : "var(--color-seal)"} />
                ))}
                <LabelList dataKey="delta" position="top" formatter={(v: unknown) => Number(v).toFixed(1)} fontSize={12} fill="var(--color-ink)" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : null}
      </div>
    </>
  );
}

function LoopStatus({ tasks, people, lang }: { tasks: Task[]; people: Person[]; lang: Lang }) {
  const en = lang === "en";
  return (
    <>
      <h3 className="font-display mt-8 text-xl">{en ? "Cycle Actions & Loop Status" : "चक्र कार्य व लूप स्थिति"}</h3>
      <div className="mt-3 overflow-x-auto rounded-lg border border-rule">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <TableHead className="py-3" cols={en ? ["Task", "Target", "Owner", "Due", "Status"] : ["कार्य", "लक्ष्य", "जिम्मेदार", "अंतिम तिथि", "स्थिति"]} />
          <tbody>
            {tasks.map((t) => {
              const owner = people.find((p) => p.id === t.ownerId);
              const tone = t.status === "overdue" || t.status === "blocked" || t.status === "rejected" ? "flag" : t.status === "draft" ? "plain" : "seal";
              return (
                <tr key={t.id} className="border-t border-rule">
                  <td className="tabular px-4 py-3">#{t.id}</td>
                  <td className="px-4 py-3">{en ? t.targetLabel : t.targetLabelHi || t.targetLabel}</td>
                  <td className="px-4 py-3">{owner ? (en ? owner.nameEn : owner.nameHi) : "—"}</td>
                  <td className="tabular px-4 py-3">{t.dueDate ?? "—"}</td>
                  <td className="px-4 py-3">
                    <Chip tone={tone}>{label(STATUS_LABEL, t.status, lang)}</Chip>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Stat({ k, v, d }: { k: string; v: string; d?: string }) {
  return (
    <div className="rounded-xl border border-rule bg-paper/60 p-4">
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">{k}</p>
      <p className="tabular mt-2 font-display text-3xl font-bold">{v}</p>
      {d ? <p className="mt-1.5 text-xs text-muted">{d}</p> : null}
    </div>
  );
}

function aiError(raw: string, en: boolean): string {
  if (raw.startsWith("AI co-pilot unavailable")) {
    return en
      ? "Standard Rule Ranking Active · 100% Deterministic Gap Numbers"
      : "मानक नियम क्रम सक्रिय · सभी अंतर-आँकड़े 100% कोड से";
  }
  if (raw === "Nothing to reorder.") return en ? raw : "क्रम बदलने के लिए कुछ नहीं है।";
  return en ? raw : "क्रम नहीं बदला। कोड क्रम वही है।";
}
