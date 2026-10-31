import { useSyncExternalStore, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useCycle } from "@/lib/samiksha/store";

// Nothing to subscribe to: the value only differs between server and client.
const subscribe = () => () => undefined;

/** False during SSR and hydration, true after; charts render only then. */
export function useMounted(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}

export function TableHead({ cols, className = "py-3.5" }: { cols: string[]; className?: string }) {
  return (
    <thead className="bg-paper text-xs font-semibold tracking-wider text-muted uppercase">
      <tr>
        {cols.map((h) => (
          <th key={h} className={`px-4 font-semibold ${className}`}>{h}</th>
        ))}
      </tr>
    </thead>
  );
}

export function Seal() {
  return (
    <svg viewBox="0 0 32 32" className="h-9 w-9 text-seal" aria-hidden>
      <rect width="32" height="32" rx="7" fill="currentColor" />
      <path d="M8 11h16M8 16h16M8 21h10" stroke="var(--color-sheet)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function Chip({
  tone = "plain",
  children,
}: {
  tone?: "plain" | "seal" | "flag" | "ok";
  children: ReactNode;
}) {
  const toneClass =
    tone === "seal" ? "bg-seal-soft text-seal" : tone === "flag" ? "bg-flag-soft text-flag" : tone === "ok" ? "bg-ok-soft text-ok" : "bg-sheet-2 text-muted";
  return <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${toneClass}`}>{children}</span>;
}

export function Btn({
  kind = "ghost",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: "primary" | "ghost" | "danger" | "soft" }) {
  const kindClass =
    kind === "primary"
      ? "bg-seal text-seal-fg hover:opacity-90"
      : kind === "danger"
        ? "bg-flag text-seal-fg hover:opacity-90"
        : kind === "soft"
          ? "bg-seal-soft text-seal hover:bg-sheet-2"
          : "border border-rule bg-sheet text-ink hover:bg-sheet-2";
  return (
    <button
      className={`inline-flex h-auto min-h-11 max-w-full items-center justify-center gap-2 whitespace-normal rounded-lg px-4 py-2.5 text-center text-sm font-semibold shadow-xs transition-all disabled:cursor-not-allowed disabled:opacity-40 ${kindClass} ${className}`}
      {...props}
    />
  );
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-rule bg-sheet p-5 shadow-[0_1px_3px_rgba(15,31,51,0.04)] sm:p-6 ${className}`}>{children}</section>;
}

export function Label({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}

export function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (n: number) => void }) {
  const lang = useCycle((s) => s.lang);
  if (pages <= 1) return null;
  const en = lang === "en";
  return (
    <div className="mt-3 flex items-center justify-between gap-3 text-sm">
      <Btn kind="ghost" disabled={page === 0} onClick={() => onPage(page - 1)}>
        {en ? "Previous" : "पिछला"}
      </Btn>
      <span className="tabular text-muted">
        {page + 1} / {pages}
      </span>
      <Btn kind="ghost" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
        {en ? "Next" : "अगला"}
      </Btn>
    </div>
  );
}

export const fieldClass =
  "h-11 w-full rounded-lg border border-rule bg-sheet px-3 text-sm text-ink outline-none";
