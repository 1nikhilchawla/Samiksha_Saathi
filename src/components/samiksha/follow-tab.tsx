import { useState } from "react";
import { Btn, Chip, Panel } from "@/components/samiksha/ui";
import { FailureWhy } from "@/components/samiksha/failure-why";
import { ProofGate } from "@/components/samiksha/proof-gate";
import { QueuePanel } from "@/components/samiksha/queue-panel";
import { TodoPanel } from "@/components/samiksha/todo-rewards-panel";
import { ClusterCommandPanel } from "@/components/samiksha/district-command";
import { MeetingSection } from "@/components/samiksha/meeting-section";
import { filterByRoleScope, formatTaskCard, type Task } from "@/lib/samiksha/engine";
import { WHATSAPP_TEMPLATES } from "@/lib/samiksha/whatsapp";
import { tx, useCan, useCycle } from "@/lib/samiksha/store";
import { useActions, useView } from "@/lib/samiksha/view";
import { STATUS_LABEL, label } from "@/lib/samiksha/labels";

export function FollowTab() {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const { tasks, cycle, messages, simToday, bot } = useView();
  const { escalate, jumpOverdue: jump, resolveVacancy } = useActions();
  const selected = useCycle((s) => s.selectedTask);
  const select = useCycle((s) => s.selectTask);
  const gate = useCycle((s) => s.gateMessage);
  const visible = selected ? messages.filter((m) => m.taskId === selected || m.taskId === null) : messages;
  // Only decided work reaches the DEO: drafts and rejected tasks never leak into the queue.
  const deo = tasks.filter((t) => Boolean(t.approvedAt) && !["draft", "rejected", "cancelled"].includes(t.status) && (t.status === "escalated" || t.actionId === "vacancy"));
  const role = useCycle((s) => s.role);
  const escalateRight = useCan()("escalate_to_deo");
  const closeRight = useCan()("resolve_vacancy");
  const scoped = cycle ? filterByRoleScope(role, cycle, tasks).tasks : tasks;
  const sent = scoped.filter((t) => !["draft", "rejected"].includes(t.status));
  const deoName = cycle?.people.find((p) => p.role === "DEO");

  return (
    <div className="rise space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl">{en ? "Field Follow-Up on Telegram" : "मैदानी फॉलो-अप (टेलीग्राम)"}</h1>
          <p className="mt-1 text-muted">
            {en
              ? "Telegram-format task cards for CRCCs and Headteachers (no login required). Overdue and vacancy tasks escalate to the DEO."
              : "CRCC व प्रधानाध्यापकों के लिए टेलीग्राम कार्य कार्ड (बिना लॉगिन)। समय-सीमा पार व रिक्ति कार्य DEO को अग्रेषित होते हैं।"}
          </p>
        </div>
        <Chip>{en ? `Review date · ${simToday}` : `समीक्षा तिथि · ${simToday}`}</Chip>
      </div>
      {gate ? <p className="text-sm">{tx(gate, lang)}</p> : null}
      <FailureWhy surfaces={["task_dispatch", "telegram_fact_check"]} />
      <div className="flex flex-wrap gap-2">
        <Btn kind="soft" onClick={jump}>
          {en ? "Fast-Forward Clock to 23 Dec 2025 (Trigger Overdue)" : "23 दिसम्बर 2025 तक घड़ी बढ़ाएँ (समय-सीमा पार जाँचें)"}
        </Btn>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_25rem]">
        <div className="space-y-3">
          {sent.length === 0 ? (
            <Panel>
              <p className="text-sm text-muted">
                {en
                  ? "No card has been sent. Drafts never appear here. Approve a task, then send it."
                  : "कोई कार्ड नहीं भेजा गया। ड्राफ्ट यहाँ नहीं आते। कार्य अनुमोदित करें, फिर भेजें।"}
              </p>
            </Panel>
          ) : null}
          {sent.map((t) => (
            <div key={t.id} className={`rounded-xl border ${selected === t.id ? "border-seal bg-seal-soft" : "border-rule bg-sheet"}`}>
              <button type="button" aria-pressed={selected === t.id} onClick={() => select(t.id)} className="block w-full p-5 text-left">
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">{en ? `Task #${t.id}` : `कार्य #${t.id}`}</span>
                  <Chip tone={t.status === "overdue" || t.status === "blocked" ? "flag" : "seal"}>{label(STATUS_LABEL, t.status, lang)}</Chip>
                </span>
                <span className="mt-1 block text-sm">{en ? t.whatEn : t.whatHi}</span>
                <span className="mt-1 block text-xs text-muted">
                  {en ? "Due" : "तिथि"} {t.dueDate ?? "—"} · {en ? t.targetLabel : t.targetLabelHi || t.targetLabel}
                </span>
              </button>
              {t.status === "overdue" || t.status === "blocked" || t.actionId === "vacancy" ? (
                <button
                  type="button"
                  className="-mt-2 mb-2 inline-flex min-h-11 max-w-full items-center px-5 text-left text-sm font-medium text-seal disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={!escalateRight.allowed}
                  title={escalateRight.allowed ? undefined : en ? escalateRight.reasonEn : escalateRight.reasonHi}
                  onClick={() => escalate(t.id)}
                >
                  {en ? `Escalate to DEO (${deoName?.nameEn ?? "DEO"})` : "DEO को अग्रेषित करें"}
                </button>
              ) : null}
            </div>
          ))}

          <Panel>
            <h2 className="font-display text-xl">{en ? "DEO Escalation & Vacancy Queue" : "DEO एस्केलेशन व रिक्ति कतार"}</h2>
            <p className="mt-1 text-sm text-muted">
              {en
                ? `Vacancy and overdue tasks land with ${deoName?.nameEn ?? "the DEO"}. The DEO's district view, above the stages, compares the blocks.`
                : `रिक्ति और अतिदेय कार्य ${deoName?.nameHi ?? "DEO"} के पास जाते हैं। चरणों के ऊपर DEO का जिला दृश्य ब्लॉकों की तुलना करता है।`}
            </p>
            <ul className="mt-3 space-y-2 text-sm">
              {deo.length === 0 ? <li className="text-muted">{en ? "Empty for now." : "अभी खाली।"}</li> : null}
              {deo.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {en ? `Task #${t.id}` : `कार्य #${t.id}`} · {label(STATUS_LABEL, t.status, lang)} · {en ? t.targetLabel : t.targetLabelHi || t.targetLabel}
                  </span>
                  {t.actionId === "vacancy" && t.status !== "done" ? (
                    <Btn
                      kind="soft"
                      disabled={!closeRight.allowed}
                      title={closeRight.allowed ? undefined : en ? closeRight.reasonEn : closeRight.reasonHi}
                      onClick={() => resolveVacancy(t.id)}
                    >
                      {en ? "Close vacancy (DEO)" : "रिक्ति बंद करें (DEO)"}
                    </Btn>
                  ) : null}
                </li>
              ))}
            </ul>
          </Panel>

          <WhatsAppCardPanel tasks={sent} />
        </div>

        <Panel className="flex min-h-[28rem] flex-col">
          <p className="text-sm font-medium">{en ? "Samiksha Saathi Bot" : "समीक्षा साथी बॉट"}</p>
          <p className="text-xs text-muted">
            {bot.live
              ? en
                ? `Dispatched via Telegram Bot & Recorded in Action Register (@${bot.username})`
                : `टेलीग्राम बॉट से भेजा गया व कार्य रजिस्टर में दर्ज (@${bot.username})`
              : en
                ? "Recorded in Block Action Register · Ready for In-App Field Reply"
                : "ब्लॉक कार्य रजिस्टर में दर्ज · इन-ऐप फ़ील्ड उत्तर के लिए तैयार"}
          </p>
          <div className="mt-3 flex-1 space-y-3 overflow-y-auto">
            {visible.length === 0 ? (
              <p className="text-sm text-muted">{en ? "The thread opens after a card is sent." : "कार्ड भेजने के बाद बातचीत यहाँ खुलेगी।"}</p>
            ) : null}
            {visible.map((m) => {
              const task = m.taskId !== null ? tasks.find((t) => t.id === m.taskId) : undefined;
              const owner = cycle?.people.find((p) => p.id === task?.ownerId);
              const body = m.direction === "out" && task ? formatTaskCard(task, owner, lang) : m.textCopy ? tx(m.textCopy, lang) : m.text;
              return (
              <div key={m.id} className={`max-w-[95%] whitespace-pre-wrap rounded-xl px-3 py-2.5 text-sm ${m.direction === "in" ? "ml-auto bg-seal text-seal-fg" : m.direction === "sys" ? "bg-flag-soft text-flag" : "bg-sheet-2"}`}>
                {body}
                {m.parsed ? (
                  <span className={`mt-1 block text-xs ${m.direction === "in" ? "text-seal-fg" : "text-muted"}`}>
                    {label(STATUS_LABEL, m.parsed.parsed_status, lang)} · {en ? "Laya parse confidence" : "लाया पार्स विश्वसनीयता"} {Math.round(m.parsed.confidence * 100)}%
                  </span>
                ) : null}
              </div>
              );
            })}
          </div>
        </Panel>
      </div>

      <ClusterCommandPanel />

      <MeetingSection titleEn="Outbound queue, digest and burst limiter" titleHi="बाहरी कतार, सारांश व बोझ सीमक">
        <QueuePanel />
      </MeetingSection>
      <MeetingSection titleEn="Officer to-dos and rewards" titleHi="अधिकारी कार्य-सूची व पुरस्कार">
        <TodoPanel />
      </MeetingSection>
      <MeetingSection titleEn="Visual proof and consent gate" titleHi="दृश्य प्रमाण व सहमति गेट">
        <ProofGate />
      </MeetingSection>
    </div>
  );
}

/**
 * The same approved card, by WhatsApp. Sending links the number to the task's
 * owner, so replies from it come back to this task through /api/whatsapp/webhook.
 */
function WhatsAppCardPanel({ tasks }: { tasks: Task[] }) {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const right = useCan()("dispatch_tasks");
  const { sendWhatsAppCard } = useActions();
  const { services, bot, cycle } = useView();
  const ready = tasks.filter((t) => ["approved", "sent", "reminded", "partial"].includes(t.status));
  const [taskNo, setTaskNo] = useState<number | null>(null);
  const [phone, setPhone] = useState("");
  const chosen = taskNo ?? ready[0]?.id ?? null;
  // Without WhatsApp credentials there is no send button to fail: a read-only preview of the template instead.
  if (!services.whatsapp) {
    const sample = ready[0];
    const owner = cycle?.people.find((p) => p.id === sample?.ownerId);
    return (
      <Panel>
        <details>
          <summary className="cursor-pointer font-display text-xl">
            {en ? "Phase 2 Multi-Channel · WhatsApp Template Preview & NIC Sandes Plan" : "चरण 2 बहु-चैनल · WhatsApp टेम्पलेट पूर्वावलोकन व NIC संदेश योजना"}
          </summary>
          <div className="mt-3">
            <Chip tone="seal">
              {bot.live
                ? (en ? "Active Channel: Telegram Bot & In-App Register" : "सक्रिय चैनल: टेलीग्राम बॉट व इन-ऐप रजिस्टर")
                : (en ? "Active Channel: In-App Block Action Register" : "सक्रिय चैनल: इन-ऐप ब्लॉक कार्य रजिस्टर")}
              {en ? " · WhatsApp route built, sends once Meta approves the templates · NIC Sandes planned for state rollout" : " · WhatsApp मार्ग तैयार, Meta टेम्पलेट स्वीकृति के बाद भेजेगा · राज्य विस्तार हेतु NIC संदेश नियोजित"}
            </Chip>
          </div>
          <p className="mt-3 text-sm text-muted">
            {en
              ? `Templates ${WHATSAPP_TEMPLATES.en} and ${WHATSAPP_TEMPLATES.hi}: the same approved card, with the same fact-check as Telegram.`
              : `टेम्पलेट ${WHATSAPP_TEMPLATES.en} व ${WHATSAPP_TEMPLATES.hi}: वही अनुमोदित कार्ड, टेलीग्राम जैसी ही तथ्य-जाँच के साथ।`}
          </p>
          {sample ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {(["en", "hi"] as const).map((l) => (
                <pre key={l} className="whitespace-pre-wrap rounded-xl bg-sheet-2 p-3 font-sans text-sm">{formatTaskCard(sample, owner, l)}</pre>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">{en ? "The preview appears once a task is approved." : "कार्य अनुमोदित होने पर पूर्वावलोकन दिखेगा।"}</p>
          )}
        </details>
      </Panel>
    );
  }
  return (
    <Panel>
      <h2 className="font-display text-xl">{en ? "Send a card by WhatsApp" : "WhatsApp से कार्ड भेजें"}</h2>
      <p className="mt-1 text-sm text-muted">
        {en
          ? "The same approved card, on WhatsApp, in English or Hindi. It passes the same fact-check as Telegram and goes out once the block's WhatsApp channel is approved; if a card cannot go, the reason shows here."
          : "वही अनुमोदित कार्ड, WhatsApp पर, अंग्रेज़ी या हिन्दी में। यह टेलीग्राम जैसी ही तथ्य-जाँच पार करता है और विकासखंड का WhatsApp चैनल स्वीकृत होने पर जाता है; कार्ड न जा सके तो कारण यहाँ दिखता है।"}
      </p>
      {ready.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{en ? "No approved or sent task yet." : "अभी कोई अनुमोदित या भेजा गया कार्य नहीं।"}</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted">{en ? "Task" : "कार्य"}</span>
            <select className="h-10 rounded-lg border border-rule bg-sheet px-2 text-sm" value={chosen ?? ""} onChange={(e) => setTaskNo(Number(e.target.value))}>
              {ready.map((t) => (
                <option key={t.id} value={t.id}>{`#${t.id} · ${en ? t.targetLabel : t.targetLabelHi || t.targetLabel}`}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted">{en ? "Owner's number, with country code" : "जिम्मेदार का नंबर, देश कोड सहित"}</span>
            <input
              className="h-10 w-48 rounded-lg border border-rule bg-sheet px-2 text-sm"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="919800000000"
            />
          </label>
          <Btn
            kind="soft"
            disabled={!right.allowed || chosen === null || !phone.trim()}
            title={right.allowed ? undefined : en ? right.reasonEn : right.reasonHi}
            onClick={() => {
              if (chosen === null) return;
              const ok = window.confirm(en ? `This sends Task #${chosen} to ${phone} on WhatsApp and links that number to the task's owner. Continue?` : `यह कार्य #${chosen} को ${phone} पर WhatsApp से भेजता है और नंबर को जिम्मेदार से जोड़ता है। जारी रखें?`);
              if (ok) void sendWhatsAppCard(chosen, phone, lang);
            }}
          >
            {en ? "Send by WhatsApp" : "WhatsApp से भेजें"}
          </Btn>
        </div>
      )}
    </Panel>
  );
}
