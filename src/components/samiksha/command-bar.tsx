import { Bell } from "lucide-react";
import { useEffect, useRef } from "react";
import { Btn, Chip } from "@/components/samiksha/ui";
import {
  OFFICER_ROLES,
  ROLE_LEVEL,
  STATE_VSK_PROFILES,
  computeHingePoints,
  filterByRoleScope,
  powerLadder,
  type OfficerRole,
} from "@/lib/samiksha/engine";
import { useCycle } from "@/lib/samiksha/store";
import { useActions, useView } from "@/lib/samiksha/view";

const ROLE_SHORT: Record<OfficerRole, { en: string; hi: string }> = {
  SPD: { en: "State", hi: "राज्य" },
  DEO: { en: "District", hi: "जिला" },
  BEO: { en: "Block", hi: "विकासखंड" },
  CRCC: { en: "Cluster", hi: "क्लस्टर" },
  HM: { en: "School", hi: "विद्यालय" },
};

/**
 * The officer's signed session.
 *
 * The dropdown chooses which view is previewed; the server then issues a signed
 * session for that role, and every call carries the token rather than a role
 * string. There is no sign-in yet, so the label names the roster person the
 * session was issued for and says it is a preview.
 */
function useOfficerSession() {
  const role = useCycle((s) => s.role);
  const sessionToken = useCycle((s) => s.sessionToken);
  const personId = useCycle((s) => s.sessionPersonId);
  const cluster = useCycle((s) => s.sessionCluster);
  const activeCluster = useCycle((s) => s.activeCluster);
  const { cycle } = useView();
  const { issueSession } = useActions();
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (!cycle) return;
    // A CRCC's session is bound to one cluster, so a different cluster needs a different session.
    const key = role === "CRCC" ? `${role}:${activeCluster}` : role;
    if (lastKey.current === key && sessionToken) return;
    lastKey.current = key;
    void issueSession(role, role === "CRCC" ? activeCluster : null);
  }, [cycle, role, activeCluster, sessionToken, issueSession]);

  return { sessionToken, personId, cluster };
}

/** Officer-role preview: who is looking, what they see, and what they may do. */
export function RoleBar() {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const role = useCycle((s) => s.role);
  const setRole = useCycle((s) => s.setRole);
  const stateCode = useCycle((s) => s.stateCode);
  const activeCluster = useCycle((s) => s.activeCluster);
  const setActiveCluster = useCycle((s) => s.setActiveCluster);
  const setSession = useCycle((s) => s.setSession);
  const { cycle, tasks } = useView();
  const { sessionToken, personId, cluster } = useOfficerSession();
  const titles = STATE_VSK_PROFILES[stateCode].roles;
  // The cluster comes from the signed session, or from the cluster picker when
  // the officer has not signed in yet.
  const scopeCluster = cluster ?? activeCluster;
  const clusterOptions = cycle ? [...new Set(cycle.schools.map((s) => s.cluster))].sort() : [activeCluster];
  // The cluster comes from the signed session, so a CRCC sees their own cluster.
  const scope = cycle ? filterByRoleScope(role, cycle, tasks, { cluster: scopeCluster }) : null;
  const ladder = powerLadder(role);
  return (
    <div className="no-print border-b border-rule bg-paper">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3 lg:px-8">
        <label className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold">{en ? "Officer view" : "अधिकारी स्तर"}</span>
          <select
            // The option text is long, so the box is capped: it must never push
            // the page wider than the phone.
            className="h-10 min-w-0 max-w-[12rem] flex-1 rounded-lg border border-rule bg-sheet px-2 text-sm sm:max-w-none"
            value={role}
            onChange={(e) => setRole(e.target.value as OfficerRole)}
            aria-label={en ? "Officer role to preview" : "देखने हेतु अधिकारी स्तर"}
          >
            {OFFICER_ROLES.map((r) => (
              <option key={r} value={r}>
                {`${r} · ${ROLE_SHORT[r][lang]} (${en ? "level" : "स्तर"} ${ROLE_LEVEL[r]}) · ${titles[r][lang]}`}
              </option>
            ))}
          </select>
        </label>
        {scope ? <Chip tone="seal">{en ? `Scope: ${scope.scope.en}` : `दायरा: ${scope.scope.hi}`}</Chip> : null}
        {role === "CRCC" ? (
          <label className="flex items-center gap-2 text-sm">
            <span className="font-semibold">{en ? "Cluster" : "क्लस्टर"}</span>
            <select
              className="h-10 rounded-lg border border-rule bg-sheet px-2 text-sm"
              value={activeCluster}
              onChange={(e) => {
                // Drop the old cluster's session at once, so no call goes out under it while the new one is issued.
                setActiveCluster(e.target.value);
                setSession(null);
              }}
              aria-label={en ? "Which cluster this CRCC works in" : "यह CRCC किस क्लस्टर में काम करता है"}
            >
              {clusterOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <Chip tone="plain">{en ? `Level ${ladder.level}/5 · holds ${ladder.holds} of ${ladder.total} powers` : `स्तर ${ladder.level}/5 · ${ladder.total} में से ${ladder.holds} अधिकार`}</Chip>
        <Chip tone="plain">
          {sessionToken
            ? en
              ? `Role view: ${personId ?? role}`
              : `भूमिका दृश्य: ${personId ?? role}`
            : en
              ? "Opening your role view…"
              : "आपका भूमिका दृश्य खुल रहा है…"}
        </Chip>
        {ROLE_LEVEL[role] < ROLE_LEVEL.BEO ? (
          <p className="flex w-full flex-wrap items-center gap-2 text-sm text-flag" role="status">
            {en
              ? `${role} view: you can reply on tasks and add photo proof. Uploading block files, turning a note into tasks and approving or sending them need level 3 (BEO).`
              : `${role} दृश्य: आप कार्य पर उत्तर व फोटो प्रमाण दे सकते हैं। विकासखंड फाइलें अपलोड करना, नोट से कार्य बनाना और उन्हें अनुमोदित या भेजना स्तर 3 (BEO) करता है।`}
            <Btn kind="soft" onClick={() => setRole("BEO")}>
              {en ? "Switch to BEO view" : "BEO दृश्य पर जाएँ"}
            </Btn>
          </p>
        ) : null}
      </div>
    </div>
  );
}

function useHingePoints() {
  const { cycle, tasks, scorecard, simToday } = useView();
  return cycle ? computeHingePoints(cycle, tasks, scorecard, simToday) : [];
}

/** Header bell: count of open hinge points, pulsing when any is critical. */
export function HingeButton() {
  const lang = useCycle((s) => s.lang);
  const toggle = useCycle((s) => s.toggleHinge);
  const open = useCycle((s) => s.hingeOpen);
  const points = useHingePoints();
  const critical = points.filter((p) => p.severity === "CRITICAL").length;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={open}
      className="relative inline-flex h-11 items-center gap-2 rounded-lg border border-rule bg-sheet px-3 text-sm font-semibold"
    >
      <Bell className="h-4 w-4" aria-hidden />
      {lang === "en" ? `Hinge Points (${points.length})` : `निर्णायक मोड़ (${points.length})`}
      {critical ? (
        <span className="absolute -top-1.5 -right-1.5 inline-flex h-5 min-w-5 animate-pulse items-center justify-center rounded-full bg-flag px-1 text-[11px] font-bold text-seal-fg">
          {critical}
        </span>
      ) : null}
    </button>
  );
}

/** The expanded list: each hinge point with its cause, owner and a jump to the stage that resolves it. */
export function HingeBar() {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const open = useCycle((s) => s.hingeOpen);
  const setTab = useCycle((s) => s.setTab);
  const selectTask = useCycle((s) => s.selectTask);
  const openStudio = useCycle((s) => s.openHingeStudio);
  const points = useHingePoints();
  if (!open) return null;
  return (
    <div className="no-print border-b border-rule bg-flag-soft/40">
      <div className="mx-auto max-w-7xl space-y-3 px-4 py-4 lg:px-8">
        <p className="text-sm font-semibold">
          {en ? "Hinge points: where waiting costs the most this cycle" : "निर्णायक मोड़: इस चक्र में जहाँ देर सबसे महँगी है"}
        </p>
        {points.length === 0 ? <p className="text-sm text-muted">{en ? "Nothing needs urgent action right now." : "अभी कुछ भी तुरंत कार्रवाई नहीं माँगता।"}</p> : null}
        <Btn kind="soft" onClick={openStudio}>
          {en ? "Open the hinge studio →" : "निर्णायक मोड़ स्टूडियो खोलें →"}
        </Btn>
        <ul className="grid gap-3 md:grid-cols-2">
          {points.map((p) => (
            <li key={p.id} className={`rounded-xl border bg-sheet p-4 ${p.severity === "CRITICAL" ? "border-flag" : "border-rule-strong"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={p.severity === "CRITICAL" ? "flag" : "plain"}>{`${p.code} · ${p.severity === "CRITICAL" ? (en ? "Critical" : "गंभीर") : (en ? "High" : "उच्च")}`}</Chip>
                <span className="text-xs text-muted">{en ? `For the ${p.ownerRole}` : `${p.ownerRole} के लिए`}</span>
              </div>
              <p className="mt-2 font-semibold">{p.title[lang]}</p>
              <p className="mt-1 text-sm">{p.cause[lang]}</p>
              <Btn
                kind="soft"
                className="mt-3"
                onClick={() => {
                  setTab(p.tab);
                  if (p.taskNos.length) selectTask(p.taskNos[0]!);
                }}
              >
                {en ? "Resolve now →" : "अभी सुलझाएँ →"}
              </Btn>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
