/**
 * A small .xlsx reader with no dependency: the first worksheet as CSV text.
 * ZIP entries come from the central directory and are inflated with the
 * platform's DecompressionStream (browser and Node). Handles shared and inline
 * strings, merged cells (filled from their top-left cell), and numbers in date
 * formats (written as YYYY-MM-DD). Old binary .xls files are not supported.
 */
type Entry = { method: number; size: number; offset: number };

function zipEntries(buf: Uint8Array): Map<string, Entry> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not an .xlsx workbook (no ZIP directory found).");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const names = new TextDecoder();
  const entries = new Map<string, Entry>();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("The .xlsx directory is damaged.");
    const nameLen = view.getUint16(p + 28, true);
    const name = names.decode(buf.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method: view.getUint16(p + 10, true), size: view.getUint32(p + 20, true), offset: view.getUint32(p + 42, true) });
    p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return entries;
}

async function entryText(buf: Uint8Array, e: Entry | undefined): Promise<string | null> {
  if (!e) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const start = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true);
  const raw = buf.slice(start, start + e.size);
  if (e.method === 0) return new TextDecoder().decode(raw);
  if (e.method !== 8) throw new Error(`Unsupported .xlsx compression method ${e.method}.`);
  return new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] !== "#") return XML_ENTITIES[e.toLowerCase()]!;
    return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  });
}

const textRuns = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]!)).join("");

function sharedStrings(xml: string | null): string[] {
  return xml ? [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textRuns(m[1]!)) : [];
}

/** Indexes of cell styles whose number format is a date (built-in 14–22, 45–47, or a custom code with d or y). */
function dateStyles(xml: string | null): Set<number> {
  const styles = new Set<number>();
  if (!xml) return styles;
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) custom.set(Number(m[1]), decodeXml(m[2]!));
  const isDate = (id: number) => (id >= 14 && id <= 22) || (id >= 45 && id <= 47) || /[dy]/i.test((custom.get(id) ?? "").replace(/\[[^\]]*\]|"[^"]*"/g, ""));
  const xfs = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  [...xfs.matchAll(/<xf\b([^>]*)>/g)].forEach((m, i) => {
    if (isDate(Number(m[1]!.match(/numFmtId="(\d+)"/)?.[1] ?? 0))) styles.add(i);
  });
  return styles;
}

function serialDate(serial: number, date1904: boolean): string {
  const epoch = Date.UTC(1899, 11, 30) + (date1904 ? 1462 : 0) * 86_400_000;
  return new Date(epoch + Math.round(serial * 86_400_000)).toISOString().slice(0, 10);
}

const colIndex = (ref: string) => [...ref.replace(/[^A-Z]/gi, "").toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const rowIndex = (ref: string) => Number(ref.replace(/\D+/g, "")) - 1;

type Sheet = { shared: string[]; dates: Set<number>; date1904: boolean };

function cellValue(attrs: string, body: string, ctx: Sheet): string {
  const type = attrs.match(/\bt="([^"]+)"/)?.[1];
  const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
  if (type === "inlineStr") return textRuns(body);
  if (type === "s") return ctx.shared[Number(v)] ?? "";
  if (type === "b") return v === "1" ? "TRUE" : "FALSE";
  if (type === "e" || v === undefined) return "";
  const text = decodeXml(v);
  const style = Number(attrs.match(/\bs="(\d+)"/)?.[1] ?? -1);
  return !type && ctx.dates.has(style) && /^-?\d+(\.\d+)?$/.test(text) ? serialDate(Number(text), ctx.date1904) : text;
}

function sheetGrid(xml: string, ctx: Sheet): string[][] {
  const grid: string[][] = [];
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = m[1]!.match(/\br="([A-Z]+\d+)"/i)?.[1];
    if (!ref) continue;
    (grid[rowIndex(ref)] ??= [])[colIndex(ref)] = cellValue(m[1]!, m[2] ?? "", ctx);
  }
  for (const m of xml.matchAll(/<mergeCell\b[^>]*ref="([A-Z]+\d+):([A-Z]+\d+)"/gi)) {
    const [r0, c0, r1, c1] = [rowIndex(m[1]!), colIndex(m[1]!), rowIndex(m[2]!), colIndex(m[2]!)];
    const value = grid[r0]?.[c0] ?? "";
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) (grid[r] ??= [])[c] = value;
  }
  return grid;
}

const csvCell = (v: string | undefined) => (v === undefined ? "" : /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

async function firstSheetPath(buf: Uint8Array, entries: Map<string, Entry>): Promise<string> {
  const workbook = (await entryText(buf, entries.get("xl/workbook.xml"))) ?? "";
  const rels = (await entryText(buf, entries.get("xl/_rels/workbook.xml.rels"))) ?? "";
  const rid = workbook.match(/<sheet\b[^>]*r:id="([^"]+)"/)?.[1];
  const target = rid ? rels.match(new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`))?.[1] : undefined;
  if (target) return target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  const sheets = [...entries.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
  if (!sheets[0]) throw new Error("The workbook has no worksheet.");
  return sheets[0];
}

/** The workbook's first worksheet as CSV text. */
export async function parseXlsxToCsv(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const entries = zipEntries(buf);
  const workbook = (await entryText(buf, entries.get("xl/workbook.xml"))) ?? "";
  const ctx: Sheet = {
    shared: sharedStrings(await entryText(buf, entries.get("xl/sharedStrings.xml"))),
    dates: dateStyles(await entryText(buf, entries.get("xl/styles.xml"))),
    date1904: /date1904="(1|true)"/.test(workbook),
  };
  const sheet = await entryText(buf, entries.get(await firstSheetPath(buf, entries)));
  if (!sheet) throw new Error("The first worksheet could not be read.");
  const grid = sheetGrid(sheet, ctx);
  const width = Math.max(0, ...grid.map((r) => (r ? r.length : 0)));
  const lines = [...grid].map((r) => Array.from({ length: width }, (_, i) => csvCell(r?.[i])).join(","));
  return lines.filter((l) => l.replace(/,/g, "")).join("\n") + "\n";
}
