import { Btn } from "@/components/samiksha/ui";
import { ACTION_LIBRARY, STATE_CODES, filterByRoleScope, type OfficerRole } from "@/lib/samiksha/engine";
import { buildDistrictBlocksSummary } from "@/lib/samiksha/core/districtView";
import { useCycle, type TabId } from "@/lib/samiksha/store";
import { useView } from "@/lib/samiksha/view";

type Copy = { en: string; hi: string };
type Mission = { title: Copy; line: Copy; actions: { tab: TabId; label: Copy }[] };

/**
 * The one next step for the officer level being previewed. Every number on it
 * comes from the loaded cycle (its clusters, its tasks, the district summary),
 * so the strip changes with the data rather than repeating a script.
 */
export function RoleMissionStrip() {
  const lang = useCycle((s) => s.lang);
  const en = lang === "en";
  const role = useCycle((s) => s.role);
  const setTab = useCycle((s) => s.setTab);
  const sessionCluster = useCycle((s) => s.sessionCluster);
  const activeCluster = useCycle((s) => s.activeCluster);
  const { cycle, tasks, scorecard } = useView();
  if (!cycle) return null;

  const cluster = sessionCluster ?? activeCluster;
  const mission = missionFor(role, {
    cluster,
    clusterSchools: cycle.schools.filter((s) => s.cluster === cluster).length,
    myTasks: filterByRoleScope(role, cycle, tasks, { cluster }).tasks.filter((t) => !["draft", "rejected", "cancelled"].includes(t.status)).length,
    drafts: tasks.filter((t) => t.status === "draft").length,
    vacancyTask: tasks.find((t) => t.actionId === "vacancy")?.id ?? null,
    district: buildDistrictBlocksSummary(cycle, { closurePct: scorecard?.closurePct ?? null, boxTicks: scorecard?.boxTicks?.length ?? 0 }),
  });

  return (
    <div className="no-print border-b border-rule bg-seal-soft/40">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 lg:px-8">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{mission.title[lang]}</p>
          <p className="text-sm text-muted">{mission.line[lang]}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {mission.actions.map((a, i) => (
            <Btn key={a.tab + i} kind={i === 0 ? "primary" : "soft"} onClick={() => setTab(a.tab)}>
              {en ? a.label.en : a.label.hi}
            </Btn>
          ))}
        </div>
      </div>
    </div>
  );
}

type Facts = {
  cluster: string;
  clusterSchools: number;
  myTasks: number;
  drafts: number;
  vacancyTask: number | null;
  district: ReturnType<typeof buildDistrictBlocksSummary>;
};

function missionFor(role: OfficerRole, f: Facts): Mission {
  if (role === "HM") {
    return {
      title: { en: "Headmaster · your school's action", hi: "प्रधानाध्यापक · आपके विद्यालय का कार्य" },
      line: {
        en: `${f.myTasks} task(s) sent to your level. Run the activity from the action library, then reply "done" with a wide group photo; the server checks the photo before it is kept.`,
        hi: `आपके स्तर पर ${f.myTasks} कार्य भेजे गए। कार्य सूची से गतिविधि चलाएँ, फिर समूह फोटो के साथ "हो गया" लिखें; रखने से पहले सर्वर फोटो जाँचता है।`,
      },
      actions: [{ tab: "follow", label: { en: "My task and photo proof →", hi: "मेरा कार्य व फोटो प्रमाण →" } }],
    };
  }
  if (role === "CRCC") {
    return {
      title: { en: `CRCC · Cluster ${f.cluster}: ${f.clusterSchools}-school visit beat`, hi: `CRCC · क्लस्टर ${f.cluster}: ${f.clusterSchools} विद्यालयों का भ्रमण` },
      line: {
        en: `${f.myTasks} open task(s) in this cluster. Log what you saw, then nudge the cluster's schools from the CRCC desk.`,
        hi: `इस क्लस्टर में ${f.myTasks} खुले कार्य। जो देखा वह दर्ज करें, फिर CRCC डेस्क से क्लस्टर के विद्यालयों को याद दिलाएँ।`,
      },
      actions: [{ tab: "follow", label: { en: "Open the CRCC desk →", hi: "CRCC डेस्क खोलें →" } }],
    };
  }
  if (role === "BEO") {
    return {
      title: { en: "BEO · the block review in three steps", hi: "BEO · तीन कदमों में विकासखंड समीक्षा" },
      line: {
        en: `Read the one-page brief, approve the ${f.drafts} draft(s) once owner and date are set, then send the cards. Nothing goes out before your approval.`,
        hi: `एक पृष्ठ का एजेंडा पढ़ें, जिम्मेदार व तिथि तय होने पर ${f.drafts} ड्राफ्ट अनुमोदित करें, फिर कार्ड भेजें। आपके अनुमोदन से पहले कुछ नहीं जाता।`,
      },
      actions: [
        { tab: "brief", label: { en: "1 · Brief", hi: "1 · एजेंडा" } },
        { tab: "approve", label: { en: "2 · Approve", hi: "2 · अनुमोदन" } },
        { tab: "follow", label: { en: "3 · Send", hi: "3 · भेजें" } },
      ],
    };
  }
  if (role === "DEO") {
    return {
      title: { en: `DEO · Sagar district, ${f.district.blocks.length} blocks side by side`, hi: `DEO · सागर जिला, ${f.district.blocks.length} ब्लॉक साथ-साथ` },
      line: {
        en: `${f.district.needsAttention ? `${f.district.needsAttention} fell furthest from R2 to R3. ` : ""}${f.vacancyTask !== null ? `Vacancy task #${f.vacancyTask} (${ACTION_LIBRARY.vacancy.name_en}) waits with you on the Follow tab.` : "No vacancy task is open."} Only Kesli is measured; the other blocks are a declared baseline.`,
        hi: `${f.district.needsAttention ? `R2 से R3 में सबसे बड़ी गिरावट ${f.district.needsAttention} में। ` : ""}${f.vacancyTask !== null ? `रिक्ति कार्य #${f.vacancyTask} (${ACTION_LIBRARY.vacancy.name_hi}) फॉलो-अप टैब पर आपके पास है।` : "कोई रिक्ति कार्य खुला नहीं।"} केवल केसली मापा गया है; बाकी ब्लॉक घोषित आधार हैं।`,
      },
      actions: [{ tab: "follow", label: { en: "Escalations and vacancies →", hi: "एस्केलेशन व रिक्तियाँ →" } }],
    };
  }
  return {
    title: { en: "SPD · state thresholds and state formats", hi: "SPD · राज्य सीमाएँ व राज्य प्रारूप" },
    line: {
      en: `Change a flag threshold for the next cycle build; the reader takes ${STATE_CODES.length} state VSK formats (${STATE_CODES.join(", ")}). You also hold the photo vault key rotation.`,
      hi: `अगले चक्र के लिए कोई सीमा बदलें; रीडर ${STATE_CODES.length} राज्य VSK प्रारूप (${STATE_CODES.join(", ")}) पढ़ता है। फोटो वॉल्ट कुंजी परिवर्तन भी आपके पास है।`,
    },
    actions: [
      { tab: "upload", label: { en: "Thresholds (Stage 1) →", hi: "सीमाएँ (चरण 1) →" } },
      { tab: "follow", label: { en: "Vault key →", hi: "वॉल्ट कुंजी →" } },
    ],
  };
}
