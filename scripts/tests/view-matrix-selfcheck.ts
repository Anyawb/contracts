import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

type Section = {
  id: string; // e.g. "4.10"
  titleLine: string;
  startIdx: number;
  endIdx: number;
  scripts: string[];
};

function repoRoot(): string {
  // scripts/tests/view-matrix-selfcheck.ts -> repo root
  return resolve(__dirname, "..", "..");
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function extractSections(doc: string): Section[] {
  const lines = doc.split("\n");
  const headings: { id: string; titleLine: string; lineIdx: number }[] = [];
  const headingRe = /^#####\s+(4\.\d+)\s+(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (m) headings.push({ id: m[1], titleLine: lines[i], lineIdx: i });
  }

  const sections: Section[] = [];
  for (let i = 0; i < headings.length; i++) {
    const startIdx = headings[i].lineIdx;
    const endIdx = i + 1 < headings.length ? headings[i + 1].lineIdx : lines.length;
    const slice = lines.slice(startIdx, endIdx).join("\n");
    const scripts = uniq(
      Array.from(slice.matchAll(/scripts\/(?:e2e|tests)\/[A-Za-z0-9_.\-\/]+\.ts/g)).map((m) => m[0])
    );
    sections.push({
      id: headings[i].id,
      titleLine: headings[i].titleLine,
      startIdx,
      endIdx,
      scripts,
    });
  }
  return sections;
}

function main() {
  const root = repoRoot();
  const workguidePath = resolve(root, "docs/Usage-Guide/ARCH-VIEW-ALIGNMENT-WORKGUIDE.md");
  const e2eReadmePath = resolve(root, "scripts/e2e/README.md");
  const testsReadmePath = resolve(root, "scripts/tests/README.md");

  const workguide = readFileSync(workguidePath, "utf8");
  const e2eReadme = readFileSync(e2eReadmePath, "utf8");
  const testsReadme = readFileSync(testsReadmePath, "utf8");

  const strict = (process.env.STRICT ?? "1").trim() !== "0";
  const sections = extractSections(workguide);

  if (sections.length === 0) {
    throw new Error(`[view-matrix-selfcheck] No matrix sections found (expected headings like "##### 4.x ...")`);
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  // 1) Every section must reference at least one script path.
  for (const s of sections) {
    if (s.scripts.length === 0) {
      errors.push(`[matrix] ${s.id}: no script path referenced under section heading: ${s.titleLine}`);
    }
  }

  // 2) All referenced scripts must exist.
  const allScripts = uniq(sections.flatMap((s) => s.scripts));
  for (const p of allScripts) {
    const abs = resolve(root, p);
    if (!existsSync(abs)) {
      errors.push(`[matrix] missing script file: ${p}`);
    }
  }

  // 3) Each referenced script should be mentioned in either scripts/e2e/README.md or scripts/tests/README.md.
  for (const p of allScripts) {
    const base = p.split("/").pop()!;
    if (!e2eReadme.includes(base) && !testsReadme.includes(base)) {
      const msg = `[matrix] script not mentioned in scripts/*/README: ${p}`;
      if (strict) errors.push(msg);
      else warnings.push(msg);
    }
  }

  // Report
  console.log("=== View Matrix Selfcheck ===");
  console.log(`  strict=${strict ? "1" : "0"}`);
  console.log(`  sections=${sections.length}`);
  console.log(`  referencedScripts=${allScripts.length}`);

  if (warnings.length) {
    console.log("\n⚠️  Warnings:");
    for (const w of warnings) console.log(`- ${w}`);
  }

  if (errors.length) {
    console.log("\n❌ Errors:");
    for (const e of errors) console.log(`- ${e}`);
    process.exit(1);
  }

  console.log("\n✅ OK: matrix coverage looks consistent.\n");
}

main();

