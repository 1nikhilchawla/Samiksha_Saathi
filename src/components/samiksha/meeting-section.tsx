import type { ReactNode } from "react";
import { useCycle } from "@/lib/samiksha/store";

/**
 * A secondary diagnostic panel.
 *
 * In normal mode the panel shows exactly as it always has. In meeting mode —
 * the 10:00 AM stand-up, when three people are around one screen — the
 * diagnostics fold away into an accordion, so what is on screen is the agenda
 * and the decisions, not the machinery behind them. The panel is one tap away
 * when someone asks for the number.
 */
export function MeetingSection({
  titleEn,
  titleHi,
  children,
  open = false,
}: {
  titleEn: string;
  titleHi: string;
  children: ReactNode;
  open?: boolean;
}) {
  const lang = useCycle((s) => s.lang);
  const meetingMode = useCycle((s) => s.meetingMode);
  const en = lang === "en";
  if (!meetingMode) return <>{children}</>;
  return (
    <details className="no-print rounded-xl border border-rule bg-sheet" open={open}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-ink">
        <span>{en ? titleEn : titleHi}</span>
        <span className="shrink-0 rounded-full bg-sheet-2 px-3 py-1 text-xs font-normal text-muted">
          {en ? "Diagnostic · tap to open" : "निदान · खोलने के लिए टैप करें"}
        </span>
      </summary>
      <div className="px-4 pb-4 [&>section]:border-0 [&>section]:bg-transparent [&>section]:p-0 [&>section]:shadow-none">
        {children}
      </div>
    </details>
  );
}
