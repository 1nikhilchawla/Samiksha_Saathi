import { useMemo, useState } from "react";
import { Btn, Chip, Panel } from "@/components/samiksha/ui";
import { QUEUE_LIMITS, buildWeeklyHingeDigest, computeHingePoints, simulateBurstLoad, type BurstReport, type QueueStatus } from "@/lib/samiksha/engine";
import { useCan, useCycle } from "@/lib/samiksha/store";
import { useActions, useView } from "@/lib/samiksha/view";

const STATUS_TEXT: Record<QueueStatus, { en: string; hi: string }> = {
  queued: { en: "Queued", hi: "कतार में" },
  processing: { en: "Sending", hi: "भेज रहे" },
  delivered: { en: "Delivered", hi: "पहुँचे" },
  retry_scheduled: { en: "Retrying", hi: "फिर कोशिश" },
  blocked_fact_check: { en: "Stopped by fact-check", hi: "तथ्य-जाँच ने रोका" },
  dead_letter: { en: "Failed (5 tries)", hi: "विफल (5 प्रयास)" },
};

/** The outbound queue, the weekly digest, and the burst simulator. */
export function QueuePanel() {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const can = useCan();
  const { cycle, tasks, scorecard, simToday, queue, bot } = useView();
  const { sendDigest } = useActions();
  const [burst, setBurst] = useState<BurstReport | null>(null);
  const [showDigest, setShowDigest] = useState(false);
  const digest = useMemo(
    () => (cycle ? buildWeeklyHingeDigest(cycle, tasks, computeHingePoints(cycle, tasks, scorecard, simToday), simToday, lang) : ""),
    [cycle, tasks, scorecard, simToday, lang],
  );
  const right = can("send_weekly_digest");
  const L = QUEUE_LIMITS;
  // The fact-check confidence the server recorded for each queued message: how
  // many of its checks passed. The panel shows the weakest of the recent rows,
  // because one unchecked number is what a reviewer needs to see.
  const recentConfidence = queue?.recent.filter((r) => r.factCheckConfidence > 0) ?? [];
  const weakestConfidence = recentConfidence.length ? Math.min(...recentConfidence.map((r) => r.factCheckConfidence)) : null;
  const averageConfidence = recentConfidence.length
    ? recentConfidence.reduce((a, r) => a + r.factCheckConfidence, 0) / recentConfidence.length
    : null;
  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl">{en ? "Message queue and weekly digest" : "संदेश कतार व साप्ताहिक सारांश"}</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            {en
              ? `Every card, reminder, escalation, digest and appreciation is fact-checked against the cycle, queued once (a repeat is never sent twice), and sent within Telegram's limits: ${L.globalPerSecond} a second overall, 1 a second per chat, ${L.batchSize} per batch, retried with backoff, never dropped silently.`
              : `हर कार्ड, याद, अग्रेषण, सारांश व प्रशंसा चक्र से तथ्य-जाँची जाती है, एक कुंजी से कतार में रखी जाती है, और टेलीग्राम सीमा में भेजी जाती है: कुल ${L.globalPerSecond} प्रति सेकंड, हर चैट को 1 प्रति सेकंड, बैच ${L.batchSize}; विफल होने पर फिर कोशिश।`}
          </p>
        </div>
        <Chip tone={bot.live ? "seal" : "plain"}>{bot.live ? (en ? "Telegram live" : "टेलीग्राम चालू") : en ? "In-app channel · Telegram delivery off" : "इन-ऐप चैनल · टेलीग्राम भेजना बंद"}</Chip>
      </div>

      <ul className="mt-4 flex flex-wrap gap-2 text-sm">
        {(Object.keys(STATUS_TEXT) as QueueStatus[]).map((s) => (
          <li key={s}>
            <Chip tone={s === "dead_letter" || s === "blocked_fact_check" ? (queue?.counts[s] ? "flag" : "plain") : s === "delivered" ? "ok" : "plain"}>
              {`${STATUS_TEXT[s][lang]} ${queue?.counts[s] ?? 0}`}
            </Chip>
          </li>
        ))}
      </ul>
      {queue?.recent.length ? (
        <ul className="mt-3 space-y-1 text-xs text-muted">
          {queue.recent.slice(0, 6).map((r) => (
            <li key={r.id}>
              {`#${r.id} · ${r.kind}${r.taskNo ? ` · Task #${r.taskNo}` : ""} · ${STATUS_TEXT[r.status][lang]} · ${r.factCheckPassed ? (en ? "fact-check passed" : "तथ्य-जाँच सही") : en ? "fact-check failed" : "तथ्य-जाँच विफल"} · ${en ? "fact-check confidence" : "तथ्य-जाँच विश्वसनीयता"} ${Math.round(r.factCheckConfidence * 100)}%${r.error ? ` · ${r.error}` : ""}`}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-muted">{en ? "Nothing has been queued in this cycle yet." : "इस चक्र में अभी कुछ कतार में नहीं।"}</p>
      )}

      {weakestConfidence !== null ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-rule bg-paper/60 px-3 py-2">
          <Chip tone={weakestConfidence >= 0.99 ? "seal" : weakestConfidence >= 0.8 ? "plain" : "flag"}>
            {en
              ? `Queue fact-check confidence: ${Math.round(averageConfidence! * 100)}% average, ${Math.round(weakestConfidence * 100)}% weakest`
              : `कतार तथ्य-जाँच विश्वसनीयता: ${Math.round(averageConfidence! * 100)}% औसत, ${Math.round(weakestConfidence * 100)}% सबसे कम`}
          </Chip>
          <span className="text-xs text-muted">
            {en
              ? `Measured from ${recentConfidence.length} queued message${recentConfidence.length === 1 ? "" : "s"}: the share of each message's fact checks that passed.`
              : `${recentConfidence.length} कतार संदेशों से मापा: हर संदेश के तथ्य-जाँच जो पास हुए।`}
          </span>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-2">
        <Btn kind="ghost" onClick={() => setShowDigest((v) => !v)}>{showDigest ? (en ? "Hide digest preview" : "सारांश छिपाएँ") : en ? "Preview weekly digest" : "साप्ताहिक सारांश देखें"}</Btn>
        <Btn
          kind="soft"
          disabled={!right.allowed}
          title={right.allowed ? undefined : en ? right.reasonEn : right.reasonHi}
          onClick={() => {
            const ok = window.confirm(
              en
                ? `This queues the weekly digest for the BEO and every linked owner with open work${bot.live ? ", and sends it on Telegram" : ""}. Continue?`
                : `यह BEO और खुले काम वाले हर जुड़े जिम्मेदार के लिए साप्ताहिक सारांश कतार में रखता है${bot.live ? " और टेलीग्राम पर भेजता है" : ""}। जारी रखें?`,
            );
            if (ok) void sendDigest();
          }}
        >
          {en ? "Send weekly pending-task digest" : "साप्ताहिक लंबित कार्य सारांश भेजें"}
        </Btn>
        <Btn kind="ghost" onClick={() => setBurst(simulateBurstLoad(150))}>
          {en ? "Simulate a 150-message burst (nothing is sent)" : "150 संदेशों का बोझ आज़माएँ (कुछ नहीं भेजा जाता)"}
        </Btn>
      </div>
      <p className="mt-2 text-xs text-muted">
        {en ? "Runs every Monday at 09:00 IST on its own; /weekly and /pending give it on demand in Telegram." : "हर सोमवार 09:00 IST पर अपने आप; टेलीग्राम में /weekly और /pending से कभी भी।"}
      </p>
      {showDigest ? <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-rule bg-sheet-2 p-3 text-xs">{digest}</pre> : null}
      {burst ? (
        <div className="mt-4 rounded-lg border border-rule bg-paper/60 p-4 text-sm">
          <p className="font-semibold">{en ? "Burst simulation (virtual clock, the same limiter the server uses)" : "बोझ परीक्षण (आभासी घड़ी, वही सीमक जो सर्वर पर)"}</p>
          <ul className="mt-2 grid gap-1 sm:grid-cols-2">
            <li>{en ? `Submitted ${burst.submitted}, accepted ${burst.accepted}` : `भेजे ${burst.submitted}, स्वीकार ${burst.accepted}`}</li>
            <li>{en ? `Duplicates blocked ${burst.duplicatesBlocked}` : `दोहराव रोके ${burst.duplicatesBlocked}`}</li>
            <li>{en ? `Delivered ${burst.delivered} of ${burst.accepted}` : `${burst.accepted} में से ${burst.delivered} पहुँचे`}</li>
            <li>{en ? `Retried after a 429: ${burst.retried}` : `429 के बाद फिर: ${burst.retried}`}</li>
            <li>{en ? `Dropped ${burst.dropped} · dead-lettered ${burst.deadLettered}` : `छूटे ${burst.dropped} · विफल ${burst.deadLettered}`}</li>
            <li>{en ? `Peak ${burst.maxPerSecond}/s overall, ${burst.maxPerChatPerSecond}/s per chat, ${burst.virtualSeconds} s in all` : `अधिकतम ${burst.maxPerSecond}/से कुल, ${burst.maxPerChatPerSecond}/से प्रति चैट, कुल ${burst.virtualSeconds} से`}</li>
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}
