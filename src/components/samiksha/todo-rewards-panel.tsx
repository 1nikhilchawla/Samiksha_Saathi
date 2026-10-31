import { useMemo, useState } from "react";
import { Btn, Chip, Panel, fieldClass } from "@/components/samiksha/ui";
import { BADGES, KARMA, buildOfficerTodoList, coachingHolds, computeHingePoints, computeWorkerRewards, formatCoachingCard } from "@/lib/samiksha/engine";
import { useCan, useCycle } from "@/lib/samiksha/store";
import { useActions, useTodos, useView } from "@/lib/samiksha/view";

/** This week's list for the current officer level, with their own items added. */
export function TodoPanel() {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const role = useCycle((s) => s.role);
  const { cycle, tasks, scorecard, simToday, r4Loaded } = useView();
  const { todos, add, toggle, remove } = useTodos();
  const [text, setText] = useState("");
  const items = useMemo(
    () => (cycle ? buildOfficerTodoList(role, cycle, tasks, computeHingePoints(cycle, tasks, scorecard, simToday), r4Loaded, simToday) : []),
    [cycle, tasks, scorecard, simToday, r4Loaded, role],
  );
  const total = items.length + todos.length;
  const done = items.filter((i) => i.done).length + todos.filter((t) => t.done).length;
  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl">{en ? `This week's list · ${role}` : `इस सप्ताह की कार्य-सूची · ${role}`}</h2>
          <p className="mt-1 text-sm text-muted">
            {en ? "Built from the tasks and hinge points this level can see; ticks on those follow the task itself." : "इस स्तर को दिखने वाले कार्यों व निर्णायक मोड़ों से बनी; उनके टिक कार्य की स्थिति से चलते हैं।"}
          </p>
        </div>
        <Chip tone={done === total && total ? "ok" : "plain"}>{en ? `${done} of ${total} done` : `${total} में से ${done} पूरे`}</Chip>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-sheet-2" aria-hidden>
        <div className="h-full bg-seal" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </div>
      <ul className="mt-4 space-y-2 text-sm">
        {items.map((i) => (
          <li key={i.id} className="flex items-start gap-2">
            <input type="checkbox" checked={i.done} readOnly disabled aria-label={i.text[lang]} className="mt-1" />
            <span className={i.done ? "text-muted line-through" : ""}>{i.text[lang]}</span>
            {i.source === "hinge" ? <Chip tone="flag">{en ? "Hinge" : "मोड़"}</Chip> : null}
          </li>
        ))}
        {todos.map((t) => (
          <li key={`own-${t.id}`} className="flex items-start gap-2">
            <input type="checkbox" checked={t.done} onChange={(e) => void toggle(t.id, e.target.checked)} aria-label={t.text} className="mt-1" />
            <span className={t.done ? "text-muted line-through" : ""}>{t.text}</span>
            <button type="button" className="ml-auto text-xs text-muted underline" onClick={() => void remove(t.id)}>{en ? "Remove" : "हटाएँ"}</button>
          </li>
        ))}
      </ul>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          void add(text);
          setText("");
        }}
      >
        <input className={fieldClass} value={text} maxLength={200} onChange={(e) => setText(e.target.value)} placeholder={en ? "Add your own item…" : "अपना काम जोड़ें…"} aria-label={en ? "New to-do item" : "नया काम"} />
        <Btn kind="soft" type="submit">{en ? "Add" : "जोड़ें"}</Btn>
      </form>
    </Panel>
  );
}

/** Recognition for field staff from verified outcomes; a flat "done" earns a coaching note, not points. */
export function RewardsPanel() {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const can = useCan();
  const { cycle, tasks, scorecard, appreciations, bot } = useView();
  const { sendAppreciation } = useActions();
  const rows = useMemo(() => (cycle ? computeWorkerRewards(cycle, tasks, scorecard) : []), [cycle, tasks, scorecard]);
  const right = can("award_appreciation");
  if (!cycle) return null;
  return (
    <Panel>
      <h2 className="font-display text-xl">{en ? "Recognition for field staff" : "मैदानी कर्मियों का सम्मान"}</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        {en
          ? `Points only from this cycle's records: +${KARMA.onTimeClosure} for a task closed on time (camps and drives only once Round 4 shows the change), +${KARMA.learningGain} Shiksha Setu Star when the camp school meets the +8-point target, +${KARMA.dataGuardian} Satya Data Guardian for a spot check that corrected an inflated score. A flat "done" earns nothing.`
          : `अंक केवल इस चक्र के रिकॉर्ड से: समय पर बंद कार्य +${KARMA.onTimeClosure} (शिविर व अभियान केवल राउंड 4 में बदलाव दिखने पर), शिविर विद्यालय +8 अंक लक्ष्य पूरा करे तो शिक्षा सेतु स्टार +${KARMA.learningGain}, बढ़ा-चढ़ा अंक सुधारने वाली जाँच पर सत्य डेटा रक्षक +${KARMA.dataGuardian}। सपाट "पूर्ण" पर कुछ नहीं।`}
      </p>
      {rows.length === 0 ? <p className="mt-3 text-sm text-muted">{en ? "No closed tasks yet." : "अभी कोई कार्य बंद नहीं।"}</p> : null}
      <ul className="mt-4 grid gap-3 md:grid-cols-2">
        {rows.map((w) => {
          const sent = appreciations.find((a) => a.personId === w.person.id);
          // No points, but a "done" Round 4 did not bear out: the coaching note is what goes.
          const coaching = w.points <= 0 && coachingHolds(w).length > 0;
          return (
            <li key={w.person.id} className="rounded-xl border border-rule p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">{en ? w.person.nameEn : w.person.nameHi}</span>
                <Chip tone={w.points ? "seal" : "plain"}>{en ? `${w.points} points` : `${w.points} अंक`}</Chip>
              </div>
              <p className="text-xs text-muted">{`${w.person.role} · ${w.person.scope}${w.streak ? (en ? ` · ${w.streak} on time in a row` : ` · लगातार ${w.streak} समय पर`) : ""}`}</p>
              {w.badges.length ? (
                <div className="mt-2 flex flex-wrap gap-1">{w.badges.map((b) => <Chip key={b} tone="ok">{BADGES[b][lang]}</Chip>)}</div>
              ) : null}
              <ul className="mt-2 space-y-1">
                {w.entries.map((e, i) => <li key={`${e.taskNo}-${i}`}>{`+${e.points} · ${e.reason[lang]}`}</li>)}
                {w.held.filter((h) => h.kind === "awaiting_r4").map((h) => <li key={`held-${h.taskNo}`} className="text-muted">{en ? "Waiting: " : "प्रतीक्षा: "}{h.reason[lang]}</li>)}
              </ul>
              {coachingHolds(w).length ? (
                <div className="mt-3 rounded-lg border border-flag/40 bg-flag-soft/60 p-3">
                  <Chip tone="flag">{en ? "⚠️ Reward held — coaching note ready" : "⚠️ पुरस्कार रोका गया — मार्गदर्शन नोट तैयार"}</Chip>
                  <p className="mt-2 text-xs whitespace-pre-line">{formatCoachingCard(w, { role: "BEO", name: en ? "the BEO" : "BEO" }, lang)}</p>
                </div>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Btn
                  kind="soft"
                  disabled={!right.allowed || (w.points <= 0 && !coaching)}
                  title={!right.allowed ? (en ? right.reasonEn : right.reasonHi) : undefined}
                  onClick={() => {
                    const what = coaching ? (en ? "a coaching note" : "मार्गदर्शन नोट") : en ? "an appreciation card" : "प्रशंसा पत्र";
                    const ok = window.confirm(
                      en
                        ? `This sends ${what} to ${w.person.nameEn} on Telegram${bot.live ? "" : " (the bot is off here, so it is only recorded)"}. Continue?`
                        : `यह ${w.person.nameHi} को टेलीग्राम पर ${what} भेजता है। जारी रखें?`,
                    );
                    if (ok) void sendAppreciation(w.person.id);
                  }}
                >
                  {coaching ? (en ? "Send coaching note" : "मार्गदर्शन नोट भेजें") : en ? "Send appreciation card" : "प्रशंसा पत्र भेजें"}
                </Btn>
                {sent ? <span className="text-xs text-muted">{en ? `Sent by ${sent.role} · ${sent.at.slice(0, 10)}` : `${sent.role} ने भेजा · ${sent.at.slice(0, 10)}`}</span> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
