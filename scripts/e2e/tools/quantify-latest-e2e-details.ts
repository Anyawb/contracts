import * as fs from "node:fs";
import * as path from "node:path";

const E2E_DIR = path.join(__dirname, "..");
const ARTIFACTS_DIR = path.join(E2E_DIR, "artifacts");
const LOGS_DIR = path.join(E2E_DIR, "logs");
const OUT_PATH = path.join(E2E_DIR, "doc", "E2E-Details-Latest.md");
const RUN_WINDOW_SKEW_MS = 5 * 60 * 1000;

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function latestRunManifest(): { path: string; data: any } | null {
  if (!fs.existsSync(LOGS_DIR)) return null;
  const dirs = fs
    .readdirSync(LOGS_DIR)
    .filter((d) => d.startsWith("e2e-run-"))
    .map((d) => ({ name: d, full: path.join(LOGS_DIR, d) }))
    .filter((d) => fs.statSync(d.full).isDirectory())
    .sort((a, b) => (a.name < b.name ? 1 : -1));

  if (dirs.length === 0) return null;
  const manifestPath = path.join(dirs[0].full, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  return { path: manifestPath, data: readJson(manifestPath) };
}

function latestArtifacts(): Array<{ prefix: string; filePath: string; data: any }> {
  if (!fs.existsSync(ARTIFACTS_DIR)) return [];
  const files = fs.readdirSync(ARTIFACTS_DIR).filter((f) => f.endsWith(".json"));
  const latest = new Map<string, { file: string; ts: number }>();

  for (const f of files) {
    const m = f.match(/^(.*)\.(\d+)\.json$/);
    if (!m) continue;
    const prefix = m[1];
    const ts = Number(m[2]);
    if (!Number.isFinite(ts)) continue;
    const existing = latest.get(prefix);
    if (!existing || ts > existing.ts) {
      latest.set(prefix, { file: f, ts });
    }
  }

  const out: Array<{ prefix: string; filePath: string; data: any }> = [];
  for (const [prefix, info] of [...latest.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const filePath = path.join(ARTIFACTS_DIR, info.file);
    out.push({ prefix, filePath, data: readJson(filePath) });
  }
  return out;
}

function filterArtifactsToRunWindow(
  artifacts: Array<{ prefix: string; filePath: string; data: any }>,
  manifest: { data: any } | null
): { filtered: Array<{ prefix: string; filePath: string; data: any }>; note: string | null } {
  if (!manifest) return { filtered: artifacts, note: null };
  if (process.env.E2E_REPORT_INCLUDE_ALL === "1") return { filtered: artifacts, note: null };

  const startTs = parseTime(manifest.data.startedAt);
  const endTs = parseTime(manifest.data.finishedAt) ?? Date.now();
  if (startTs === null) return { filtered: artifacts, note: null };

  const inWindow = (ts: number) => ts >= startTs - RUN_WINDOW_SKEW_MS && ts <= endTs + RUN_WINDOW_SKEW_MS;
  const filtered = artifacts.filter((a) => {
    const genTs = parseTime(a.data?.generatedAt);
    if (genTs !== null) return inWindow(genTs);
    try {
      const stat = fs.statSync(a.filePath);
      return inWindow(stat.mtimeMs);
    } catch {
      return false;
    }
  });

  if (filtered.length === 0) {
    return { filtered: artifacts, note: "No artifacts matched the run window; fell back to latest-per-prefix." };
  }

  return {
    filtered,
    note: `Artifacts filtered to latest run window (${manifest.data.startedAt ?? "?"} → ${manifest.data.finishedAt ?? "?"}).`,
  };
}

function countOrderIds(orderIds: any): number {
  if (!orderIds || typeof orderIds !== "object") return 0;
  if (Array.isArray(orderIds)) return orderIds.length;
  let total = 0;
  for (const v of Object.values(orderIds)) {
    if (Array.isArray(v)) total += v.length;
    else if (typeof v === "string" || typeof v === "number") total += 1;
  }
  return total;
}

function safeCount(obj: any): number {
  if (!obj || typeof obj !== "object") return 0;
  return Object.keys(obj).length;
}

function summarizeArtifact(prefix: string, data: any) {
  const orders = Array.isArray(data.orders) ? data.orders.length : 0;
  const orderIds = countOrderIds(data.orderIds);
  const checkpoints = safeCount(data.checkpoints);
  const modules = Math.max(safeCount(data.modules), safeCount(data.deployment));
  const dataPushTypes = Math.max(
    safeCount(data?.counters?.dataPushedByTypeHash),
    safeCount(data?.dataPushCounts),
  );
  const expectedReverts = safeCount(data?.counters?.expectedReverts);
  const blockNumber = data.blockNumber ?? data.block ?? "";
  const rpcUrl = data.rpcUrl ?? data.rpc ?? "";

  return {
    prefix,
    name: data.name ?? "",
    generatedAt: data.generatedAt ?? "",
    chainId: data.chainId ?? "",
    rpcUrl,
    blockNumber,
    strictViews: data.strictViews ?? "",
    orders: orders || orderIds,
    orderIds,
    checkpoints,
    modules,
    dataPushTypes,
    expectedReverts,
  };
}

function toTableRow(cols: Array<string | number>): string {
  return `| ${cols.map((c) => String(c)).join(" | ")} |`;
}

function extractFailReason(logFile: string): string {
  if (!logFile || !fs.existsSync(logFile)) return "-";
  const lines = fs.readFileSync(logFile, "utf8").split(/\r?\n/);
  const patterns = [/^Error:/i, /revert/i, /fail/i, /missing/i, /Cannot find module/i];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (patterns.some((p) => p.test(line))) {
      return line.length > 200 ? `${line.slice(0, 200)}…` : line;
    }
  }
  return "-";
}

function main() {
  const manifest = latestRunManifest();
  const artifacts = latestArtifacts();
  const filtered = filterArtifactsToRunWindow(artifacts, manifest);
  const summaries = filtered.filtered.map((a) => summarizeArtifact(a.prefix, a.data));

  const lines: string[] = [];
  lines.push("# E2E Details (Latest)");
  lines.push("");

  if (manifest) {
    lines.push("## Latest Run Manifest");
    lines.push("");
    lines.push(`- path: ${manifest.path}`);
    lines.push(`- startedAt: ${manifest.data.startedAt ?? ""}`);
    lines.push(`- finishedAt: ${manifest.data.finishedAt ?? ""}`);
    lines.push(`- network: ${manifest.data.network ?? ""}`);
    lines.push(`- rpcUrl: ${manifest.data.rpcUrl ?? ""}`);
    lines.push("");

    lines.push("### Script Results");
    lines.push("");
    lines.push(toTableRow(["script", "exitCode", "durationMs", "failReason", "logFile"]));
    lines.push(toTableRow(["---", "---", "---", "---", "---"]));
    for (const s of manifest.data.scripts ?? []) {
      const reason = s.exitCode === 0 ? "-" : extractFailReason(s.logFile);
      lines.push(toTableRow([s.file, s.exitCode, s.durationMs, reason, s.logFile]));
    }
    lines.push("");
  }

  lines.push("## Latest Artifacts Summary (per prefix)");
  lines.push("");
  lines.push(
    toTableRow([
      "prefix",
      "name",
      "generatedAt",
      "chainId",
      "rpcUrl",
      "block",
      "orders",
      "orderIds",
      "checkpoints",
      "modules",
      "dataPushTypes",
      "expectedReverts",
      "strictViews",
    ])
  );
  lines.push(
    toTableRow([
      "---",
      "---",
      "---",
      "---",
      "---",
      "---",
      "---",
      "---",
      "---",
      "---",
      "---",
      "---",
      "---",
    ])
  );

  for (const s of summaries) {
    lines.push(
      toTableRow([
        s.prefix,
        s.name,
        s.generatedAt,
        s.chainId,
        s.rpcUrl,
        s.blockNumber,
        s.orders,
        s.orderIds,
        s.checkpoints,
        s.modules,
        s.dataPushTypes,
        s.expectedReverts,
        s.strictViews,
      ])
    );
  }

  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("- This report is aggregation-only; it does not compare two runs.");
  if (filtered.note) lines.push(`- ${filtered.note}`);
  lines.push("- Use the log file paths (if present) to inspect detailed step output.");
  lines.push("- Use the artifacts JSON files for deep inspection of checkpoints, counters, and modules.");

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, lines.join("\n") + "\n", "utf8");

  console.log(`✅ Wrote ${OUT_PATH}`);
}

main();
