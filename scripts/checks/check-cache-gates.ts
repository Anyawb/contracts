/**
 * Static audit: cache write entrypoints & gating (Architecture-Guide alignment).
 *
 * What this checks (heuristic, but high-signal):
 * 1) All `refreshModuleCache()` implementations must be callable ONLY by
 *    `Registry.KEY_CACHE_MAINTENANCE_MANAGER` (CacheMaintenanceManager).
 * 2) All `ModuleCache.set/batchSet/remove` callsites are listed (these are write operations).
 *
 * Usage:
 * - pnpm -s run checks:cache-gates
 */
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

type Finding = {
  file: string;
  line: number;
  message: string;
};

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir)) {
    const p = path.join(dir, ent);
    const st = statSync(p);
    if (st.isDirectory()) {
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

function linesOf(s: string): string[] {
  return s.split(/\r?\n/);
}

function findLine(haystackLines: string[], needleIdx: number): number {
  // needleIdx is a character index in the full string; convert to 1-based line number
  let acc = 0;
  for (let i = 0; i < haystackLines.length; i++) {
    acc += haystackLines[i].length + 1; // + '\n'
    if (acc > needleIdx) return i + 1;
  }
  return haystackLines.length;
}

function includesAny(s: string, needles: string[]): boolean {
  return needles.some((n) => s.includes(n));
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("*/");
}

function main() {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const srcRoot = path.join(repoRoot, "src");
  const files = walk(srcRoot).filter((f) => f.endsWith(".sol"));

  const errors: Finding[] = [];
  const infos: Finding[] = [];

  // 1) refreshModuleCache implementations
  for (const f of files) {
    const rel = path.relative(repoRoot, f);
    const raw = readFileSync(f, "utf8");
    if (!raw.includes("refreshModuleCache")) continue;
    // Only treat actual implementations as "entrypoints":
    // interface functions end with ';' and do not have a body.
    if (!raw.match(/function\s+refreshModuleCache\s*\([^;{]*\)\s*external[^;{]*\{/)) continue;

    const lns = linesOf(raw);
    const idx = raw.search(/function\s+refreshModuleCache\s*\([^;{]*\)\s*external[^;{]*\{/);
    const line = findLine(lns, idx);

    // Architecture-Guide expectation: only CacheMaintenanceManager can call refreshModuleCache.
    const hasKeyCheck = includesAny(raw, [
      "KEY_CACHE_MAINTENANCE_MANAGER",
      "CACHE_MAINTENANCE_MANAGER",
    ]);

    // Allow patterns:
    // - inline check: maint = Registry(...).getModuleOrRevert(KEY_CACHE_MAINTENANCE_MANAGER); if (msg.sender != maint) revert ...
    // - helper: _requireCacheMaintainer() does the same
    const hasSenderGate =
      includesAny(raw, [
        "msg.sender != maint",
        "msg.sender==maint",
        "msg.sender == maint",
        "_requireCacheMaintainer(",
        "_requireCacheMaintainer();",
        "Only CacheMaintenanceManager can refresh",
      ]) && hasKeyCheck;

    if (!hasSenderGate) {
      errors.push({
        file: rel,
        line,
        message:
          "refreshModuleCache() found but could not prove it is gated by KEY_CACHE_MAINTENANCE_MANAGER (only CacheMaintenanceManager).",
      });
    } else {
      infos.push({
        file: rel,
        line,
        message: "refreshModuleCache() appears to be gated by CacheMaintenanceManager.",
      });
    }
  }

  // 2) ModuleCache write callsites (set/batchSet/remove)
  const moduleCacheWriteRe = /\bModuleCache\.(set|batchSet|remove)\s*\(/g;
  for (const f of files) {
    const rel = path.relative(repoRoot, f);
    const raw = readFileSync(f, "utf8");
    if (!raw.includes("ModuleCache.")) continue;
    const lns = linesOf(raw);

    let m: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((m = moduleCacheWriteRe.exec(raw))) {
      const line = findLine(lns, m.index);
      // Best-effort filter: ignore matches in comments/docstrings.
      const lineText = lns[line - 1] ?? "";
      if (isCommentLine(lineText)) continue;
      infos.push({
        file: rel,
        line,
        message: `ModuleCache.${m[1]}(...) callsite (write)`,
      });
    }
  }

  // Print report
  const pad = (n: number) => String(n).padStart(4, " ");
  console.log("\n=== Cache Gate Audit (static) ===\n");

  console.log("## refreshModuleCache() implementations\n");
  const refreshInfos = infos.filter((x) => x.message.startsWith("refreshModuleCache"));
  if (refreshInfos.length === 0) {
    console.log("(none found)\n");
  } else {
    for (const it of refreshInfos) {
      console.log(`- ${it.file}:${pad(it.line)}  ${it.message}`);
    }
    console.log("");
  }

  console.log("## ModuleCache write callsites (set/batchSet/remove)\n");
  const mcInfos = infos.filter((x) => x.message.startsWith("ModuleCache."));
  if (mcInfos.length === 0) {
    console.log("(none found)\n");
  } else {
    for (const it of mcInfos) {
      console.log(`- ${it.file}:${pad(it.line)}  ${it.message}`);
    }
    console.log("");
  }

  if (errors.length) {
    console.log("## FAILURES\n");
    for (const e of errors) {
      console.log(`- ${e.file}:${pad(e.line)}  ${e.message}`);
    }
    console.log("");
    process.exitCode = 1;
  } else {
    console.log("## RESULT\n");
    console.log("PASS: No obvious violations found for refreshModuleCache gating.\n");
  }
}

main();

