#!/usr/bin/env node
/**
 * Renders every docs/*.template.md into its .md (the architecture report and
 * the deck evidence pack), so every citation is the line the code is on today.
 * A citation is written in a template as {{path#text}} and becomes
 * `path:line`, the first line of `path` that contains `text`. A citation whose
 * text is no longer in the file stops the render, so a stale reference cannot
 * slip into a report.
 *
 *   node scripts/render-architecture-report.mjs          write the reports
 *   node scripts/render-architecture-report.mjs --check  exit 1 if any is out of date
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const docs = join(root, "docs");
const templates = readdirSync(docs).filter((f) => f.endsWith(".template.md"));
const check = process.argv.includes("--check");

const files = new Map();
const linesOf = (path) => {
  if (!files.has(path)) files.set(path, readFileSync(join(root, path), "utf8").split(/\r?\n/));
  return files.get(path);
};

let stale = 0;
for (const name of templates) {
  const target = join(docs, name.replace(/\.template\.md$/, ".md"));
  const missing = [];
  const rendered = readFileSync(join(docs, name), "utf8").replace(/\{\{([^#}]+)#([^}]+)\}\}/g, (_, path, text) => {
    const at = linesOf(path.trim()).findIndex((line) => line.includes(text));
    if (at < 0) {
      missing.push(`${path}: "${text}"`);
      return `${path.trim()}:?`;
    }
    return `${path.trim()}:${at + 1}`;
  });
  if (missing.length) {
    console.error(`${name}: citations not found:\n  ${missing.join("\n  ")}`);
    process.exit(1);
  }
  if (check) {
    let current = "";
    try {
      current = readFileSync(target, "utf8");
    } catch {
      // Not rendered yet.
    }
    if (current !== rendered) {
      console.error(`${target} is out of date: run node scripts/render-architecture-report.mjs`);
      stale += 1;
    }
  } else {
    writeFileSync(target, rendered);
    console.log(`Wrote ${target} (${rendered.match(/\.(?:ts|tsx|mjs|sql):\d+/g)?.length ?? 0} citations).`);
  }
}
if (check) {
  if (stale) process.exit(1);
  console.log("Report citations are current.");
}
