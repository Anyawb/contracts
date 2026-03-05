import fs from "node:fs";
import path from "node:path";

type AnyJson = Record<string, any>;

type QuantRow = {
  label: string;
  file: string;
  rpcUrl?: string;
  chainId?: number;
  blockNumber?: number;
  registry?: string;
  vaultCore?: string;
  orderCount?: number;
  orderIds?: string;
  orderIdSource?: string;
  orderIdMin?: number;
  orderIdMax?: number;
  orderIdUniqueCount?: number;
  orderIdMissingCount?: number;
  orderIdMissing?: string;
  orderIdDuplicateCount?: number;
  orderIdDuplicates?: string;
  orderIdNonNumericCount?: number;
  orderListing?: string;
  checkpoints?: string;
  dataPushedTotal?: number;
  dataPushedByTypeHash?: number;
  dataPushedTopTypeHash?: string;
  dataPushedAllTypeHashLines?: string[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readJson(filePath: string): AnyJson {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function listArtifactFilesSortedNewestFirst(artifactsDir: string): string[] {
  const names = fs.readdirSync(artifactsDir);
  const files = names
    .filter((n) => n.endsWith(".json"))
    .map((n) => path.join(artifactsDir, n));

  files.sort((a, b) => {
    const am = fs.statSync(a).mtimeMs;
    const bm = fs.statSync(b).mtimeMs;
    return bm - am;
  });

  return files;
}

function fmt(value: unknown): string {
  if (value === undefined || value === null) return "-";
  if (typeof value === "number") return String(value);
  if (typeof value === "string" && value.length === 0) return "-";
  return String(value);
}

function countObjectKeys(obj: unknown): number {
  if (!isObject(obj)) return 0;
  return Object.keys(obj).length;
}

function sumObjectNumericValues(obj: unknown): number {
  if (!isObject(obj)) return 0;
  let sum = 0;
  for (const v of Object.values(obj)) {
    if (typeof v === "number" && Number.isFinite(v)) sum += v;
  }
  return sum;
}

function loadDataPushTypeMap(repoRoot: string): Map<string, string> {
  const map = new Map<string, string>();
  const filePath = path.join(repoRoot, "src", "constants", "DataPushTypes.sol");
  if (!fs.existsSync(filePath)) return map;

  const src = fs.readFileSync(filePath, "utf8");
  const re = /keccak256\("([A-Z0-9_]+)"\)/g;
  for (const m of src.matchAll(re)) {
    const name = m[1];
    const hash = "0x" + Buffer.from(name).toString("hex");
    // Use ethers-like keccak by deferring to the library if available in runtime.
    // If not available, mapping is best-effort and only used for display.
    try {
      const { keccak256, toUtf8Bytes } = require("ethers");
      const h = keccak256(toUtf8Bytes(name)).toLowerCase();
      map.set(h, name);
    } catch {
      map.set(hash.toLowerCase(), name);
    }
  }
  return map;
}

function buildNameToHash(map: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [hash, name] of map.entries()) {
    out.set(name, hash);
  }
  return out;
}

function formatTypeHash(hash: string, map: Map<string, string>): string {
  const name = map.get(hash.toLowerCase());
  return name ? `${hash}(${name})` : hash;
}

function topTypeHashBreakdown(pushedByTypeHash: unknown, topN: number, map: Map<string, string>): string {
  if (!isObject(pushedByTypeHash)) return "-";
  const entries = Object.entries(pushedByTypeHash)
    .map(([k, v]) => [k, typeof v === "number" ? v : Number(v)] as const)
    .filter(([, v]) => Number.isFinite(v))
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "-";
  return entries
    .slice(0, Math.max(1, topN))
    .map(([k, v]) => `${formatTypeHash(k, map)}:${v}`)
    .join(", ");
}

function allTypeHashBreakdownLines(pushedByTypeHash: unknown, map: Map<string, string>): string[] {
  if (!isObject(pushedByTypeHash)) return [];
  return Object.entries(pushedByTypeHash)
    .map(([k, v]) => [k, typeof v === "number" ? v : Number(v)] as const)
    .filter(([, v]) => Number.isFinite(v))
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${formatTypeHash(k, map)}: ${v}`);
}

function typeHashSet(pushedByTypeHash: unknown): Set<string> {
  if (!isObject(pushedByTypeHash)) return new Set();
  return new Set(Object.keys(pushedByTypeHash));
}

function buildOrderListingFromOrders(orders: unknown): string {
  if (!Array.isArray(orders) || orders.length === 0) return "-";
  const items = orders
    .map((o: any) => {
      const idRaw = o?.orderId;
      const idNum = typeof idRaw === "string" || typeof idRaw === "number" ? Number(idRaw) : NaN;
      return {
        idNum: Number.isFinite(idNum) ? idNum : Number.POSITIVE_INFINITY,
        idRaw: idRaw === undefined ? "-" : String(idRaw),
        saltSuffix: o?.saltSuffix === undefined ? "-" : String(o.saltSuffix),
        withGuarantee: typeof o?.withGuarantee === "boolean" ? String(o.withGuarantee) : "-",
        principalRaw: o?.principalRaw === undefined ? "-" : String(o.principalRaw),
      };
    })
    .sort((a, b) => a.idNum - b.idNum);

  // Keep deterministic, concise lines.
  return items
    .slice(0, 100)
    .map((it) => `orderId=${it.idRaw} suffix=${it.saltSuffix} guarantee=${it.withGuarantee} principalRaw=${it.principalRaw}`)
    .join("\n");
}

function summarizeCheckpoints(checkpoints: unknown): string {
  if (!isObject(checkpoints)) return "-";
  const keys = Object.keys(checkpoints).sort();
  if (keys.length === 0) return "-";
  // keep it compact; show only names
  return keys.join(", ");
}

function summarizeOrderIdsMainPairs(orderIds: unknown): string {
  if (!isObject(orderIds)) return "-";
  const mainPairs = (orderIds as any).mainPairs;
  if (!Array.isArray(mainPairs)) return "-";
  if (mainPairs.length === 0) return "-";
  const nums = mainPairs
    .map((v: any) => (typeof v === "string" || typeof v === "number" ? Number(v) : NaN))
    .filter((n: number) => Number.isFinite(n));
  if (nums.length > 0) {
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    return `${min}..${max} (n=${mainPairs.length})`;
  }
  return `n=${mainPairs.length}`;
}

function summarizeOrderIdsFromOrders(orders: unknown): string {
  if (!Array.isArray(orders)) return "-";
  const ids = orders
    .map((o: any) => o?.orderId)
    .filter((v: any) => typeof v === "string" || typeof v === "number")
    .map((v: any) => Number(v))
    .filter((n: number) => Number.isFinite(n));
  if (ids.length === 0) return "-";
  const unique = Array.from(new Set(ids));
  const min = Math.min(...unique);
  const max = Math.max(...unique);
  return `${min}..${max} (n=${unique.length})`;
}

type OrderIdCheck = {
  source: string;
  min?: number;
  max?: number;
  uniqueCount: number;
  nonNumericCount: number;
  missing: number[];
  duplicates: Array<{ id: string; count: number }>;
};

function computeOrderIdCheckFromNumericIds(source: string, idsNumeric: number[], idsRaw: unknown[]): OrderIdCheck {
  const nonNumericCount = idsRaw.length - idsNumeric.length;

  const counts = new Map<number, number>();
  for (const id of idsNumeric) counts.set(id, (counts.get(id) ?? 0) + 1);
  const unique = Array.from(counts.keys()).sort((a, b) => a - b);

  const duplicates = Array.from(counts.entries())
    .filter(([, c]) => c > 1)
    .sort(([a], [b]) => a - b)
    .map(([id, count]) => ({ id: String(id), count }));

  const min = unique.length ? unique[0] : undefined;
  const max = unique.length ? unique[unique.length - 1] : undefined;

  const missing: number[] = [];
  if (min !== undefined && max !== undefined && max - min <= 10_000) {
    const set = new Set(unique);
    for (let n = min; n <= max; n++) {
      if (!set.has(n)) missing.push(n);
      if (missing.length >= 200) break; // safety cap for display
    }
  }

  return {
    source,
    min,
    max,
    uniqueCount: unique.length,
    nonNumericCount,
    missing,
    duplicates,
  };
}

function computeOrderIdCheck(json: AnyJson): { summary: string; check: OrderIdCheck } {
  // Prefer advanced `orders[].orderId` if present.
  const ordersArray = Array.isArray(json.orders) ? (json.orders as any[]) : undefined;
  if (ordersArray && ordersArray.length > 0) {
    const raw = ordersArray.map((o) => o?.orderId);
    const nums = raw
      .filter((v) => typeof v === "string" || typeof v === "number")
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n));
    const check = computeOrderIdCheckFromNumericIds("orders[].orderId", nums, raw);
    const summary = check.min !== undefined && check.max !== undefined ? `${check.min}..${check.max} (n=${check.uniqueCount})` : "-";
    return { summary, check };
  }

  // Fallback to basic `orderIds.mainPairs`.
  const mainPairs = isObject(json.orderIds) ? (json.orderIds as any).mainPairs : undefined;
  if (Array.isArray(mainPairs) && mainPairs.length > 0) {
    const raw = mainPairs;
    const nums = raw
      .filter((v: any) => typeof v === "string" || typeof v === "number")
      .map((v: any) => Number(v))
      .filter((n: number) => Number.isFinite(n));
    const check = computeOrderIdCheckFromNumericIds("orderIds.mainPairs", nums, raw);
    const summary = check.min !== undefined && check.max !== undefined ? `${check.min}..${check.max} (n=${check.uniqueCount})` : `n=${mainPairs.length}`;
    return { summary, check };
  }

  const empty: OrderIdCheck = {
    source: "-",
    uniqueCount: 0,
    nonNumericCount: 0,
    missing: [],
    duplicates: [],
  };
  return { summary: "-", check: empty };
}

function toNumberMaybe(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function buildRow(label: string, filePath: string, json: AnyJson, map: Map<string, string>): QuantRow {
  const addresses = isObject(json.addresses) ? (json.addresses as AnyJson) : undefined;
  const modules = isObject(json.modules) ? (json.modules as AnyJson) : undefined;

  const counters = isObject(json.counters) ? (json.counters as AnyJson) : undefined;
  const pushedByTypeHash = counters?.dataPushedByTypeHash;

  const ordersArray = Array.isArray(json.orders) ? (json.orders as any[]) : undefined;
  const mainPairs =
    isObject(json.orderIds) && Array.isArray((json.orderIds as any).mainPairs)
      ? (((json.orderIds as any).mainPairs as any[]) ?? undefined)
      : undefined;

  const { summary: orderIdsSummary, check: orderIdCheck } = computeOrderIdCheck(json);

  return {
    label,
    file: path.basename(filePath),
    rpcUrl: typeof json.rpcUrl === "string" ? json.rpcUrl : undefined,
    chainId: toNumberMaybe(json.chainId),
    blockNumber: typeof json.blockNumber === "number" ? json.blockNumber : undefined,
    registry:
      typeof addresses?.Registry === "string"
        ? addresses.Registry
        : typeof modules?.Registry === "string"
          ? modules.Registry
          : undefined,
    vaultCore:
      typeof addresses?.VaultCore === "string"
        ? addresses.VaultCore
        : typeof modules?.VaultCore === "string"
          ? modules.VaultCore
          : undefined,
    orderCount:
      typeof json.orderCount === "number"
        ? json.orderCount
        : typeof json.totalOrders === "number"
          ? json.totalOrders
          : ordersArray
            ? ordersArray.length
            : mainPairs
              ? mainPairs.length
            : undefined,
    orderIds: orderIdsSummary !== "-" ? orderIdsSummary : ordersArray && ordersArray.length > 0 ? summarizeOrderIdsFromOrders(ordersArray) : summarizeOrderIdsMainPairs(json.orderIds),
    orderIdSource: orderIdCheck.source,
    orderIdMin: orderIdCheck.min,
    orderIdMax: orderIdCheck.max,
    orderIdUniqueCount: orderIdCheck.uniqueCount,
    orderIdMissingCount: orderIdCheck.missing.length,
    orderIdMissing:
      orderIdCheck.missing.length === 0
        ? "-"
        : orderIdCheck.missing.length <= 30
          ? orderIdCheck.missing.join(",")
          : `${orderIdCheck.missing.slice(0, 20).join(",")}…(+${orderIdCheck.missing.length - 20})`,
    orderIdDuplicateCount: orderIdCheck.duplicates.length,
    orderIdDuplicates:
      orderIdCheck.duplicates.length === 0
        ? "-"
        : orderIdCheck.duplicates.length <= 20
          ? orderIdCheck.duplicates.map((d) => `${d.id}x${d.count}`).join(",")
          : `${orderIdCheck.duplicates.slice(0, 10).map((d) => `${d.id}x${d.count}`).join(",")}…(+${orderIdCheck.duplicates.length - 10})`,
    orderIdNonNumericCount: orderIdCheck.nonNumericCount,
    orderListing: ordersArray ? buildOrderListingFromOrders(ordersArray) : "-",
    checkpoints: summarizeCheckpoints(json.checkpoints),
    dataPushedTotal: typeof counters?.dataPushedTotal === "number" ? counters.dataPushedTotal : sumObjectNumericValues(pushedByTypeHash),
    dataPushedByTypeHash: countObjectKeys(pushedByTypeHash),
    dataPushedTopTypeHash: topTypeHashBreakdown(pushedByTypeHash, 5, map),
    dataPushedAllTypeHashLines: allTypeHashBreakdownLines(pushedByTypeHash, map),
  };
}

function renderMarkdownTable(rows: QuantRow[]): string {
  const header =
    "| Suite | Artifact | rpcUrl | chainId | block | Registry | VaultCore | orders | orderIds | orderIdSource | missingOrderIds | duplicateOrderIds | nonNumericOrderIds | checkpoints | DataPushed(total) | DataPushed(typeHash count) |\n" +
    "|---|---|---|---:|---:|---|---|---:|---|---|---|---|---:|---|---:|---:|";

  const lines = rows.map((r) =>
    [
      r.label,
      r.file,
      fmt(r.rpcUrl),
      fmt(r.chainId),
      fmt(r.blockNumber),
      fmt(r.registry),
      fmt(r.vaultCore),
      fmt(r.orderCount),
      fmt(r.orderIds),
      fmt(r.orderIdSource),
      fmt(r.orderIdMissing),
      fmt(r.orderIdDuplicates),
      fmt(r.orderIdNonNumericCount),
      fmt(r.checkpoints),
      fmt(r.dataPushedTotal),
      fmt(r.dataPushedByTypeHash),
    ]
      .map((cell) => String(cell).replaceAll("\n", " "))
      .join(" | ")
  );

  return [header, ...lines.map((l) => `| ${l} |`)].join("\n");
}

function renderBusinessChecks(rows: QuantRow[]): string {
  const lines: string[] = [];
  lines.push("## Business Checks");
  lines.push("");
  for (const r of rows) {
    const suite = `- ${r.label}:`;
    const orderBase = `orders=${fmt(r.orderCount)}, orderIds=${fmt(r.orderIds)} (source=${fmt(r.orderIdSource)})`;

    const issues: string[] = [];
    if ((r.orderIdNonNumericCount ?? 0) > 0) issues.push(`nonNumeric=${r.orderIdNonNumericCount}`);
    if ((r.orderIdMissingCount ?? 0) > 0) issues.push(`missingIds=${r.orderIdMissingCount}`);
    if ((r.orderIdDuplicateCount ?? 0) > 0) issues.push(`duplicateIds=${r.orderIdDuplicateCount}`);

    if (issues.length === 0) {
      lines.push(`${suite} OK — ${orderBase}`);
    } else {
      lines.push(`${suite} WARN — ${orderBase}; issues: ${issues.join(", ")}`);
      if (r.orderIdMissing && r.orderIdMissing !== "-") lines.push(`  - missingOrderIds: ${r.orderIdMissing}`);
      if (r.orderIdDuplicates && r.orderIdDuplicates !== "-") lines.push(`  - duplicateOrderIds: ${r.orderIdDuplicates}`);
    }
  }
  lines.push("");
  lines.push(
    "Interpretation notes: missing/duplicate/non-numeric orderIds often indicate skipped scenario branches, failed order creation with continued flow, or non-monotonic/conditional ID allocation." 
  );
  return lines.join("\n");
}

function renderOrderListings(rows: QuantRow[]): string {
  const lines: string[] = [];
  lines.push("## Orders (from artifact)");
  lines.push("");
  for (const r of rows) {
    lines.push(`### ${r.label}`);
    lines.push("");
    if (!r.orderListing || r.orderListing === "-") {
      lines.push("No `orders[]` array in this artifact.");
      lines.push("");
      continue;
    }
    lines.push("```text");
    lines.push(r.orderListing);
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

function renderDataPushedBreakdown(rows: QuantRow[]): string {
  const lines: string[] = [];
  lines.push("## DataPushed breakdown (top 5 typeHash)");
  lines.push("");
  for (const r of rows) {
    lines.push(`- ${r.label}: ${fmt(r.dataPushedTopTypeHash)}`);
  }
  return lines.join("\n");
}

function renderTypeHashDiff(json10: AnyJson, jsonAdv: AnyJson, map: Map<string, string>): string {
  const a = typeHashSet(json10.counters?.dataPushedByTypeHash);
  const b = typeHashSet(jsonAdv.counters?.dataPushedByTypeHash);
  const added = Array.from(b).filter((x) => !a.has(x)).sort();
  const removed = Array.from(a).filter((x) => !b.has(x)).sort();

  const lines: string[] = [];
  lines.push("## DataPushed typeHash diff (advanced vs basic)");
  lines.push("");
  lines.push(`- addedInAdvanced: ${added.length}`);
  if (added.length) {
    lines.push("```text");
    lines.push(added.map((h) => formatTypeHash(h, map)).join("\n"));
    lines.push("```");
  }
  lines.push(`- missingInAdvanced: ${removed.length}`);
  if (removed.length) {
    lines.push("```text");
    lines.push(removed.map((h) => formatTypeHash(h, map)).join("\n"));
    lines.push("```");
  }
  return lines.join("\n");
}

function renderDataPushedAll(rows: QuantRow[]): string {
  const lines: string[] = [];
  lines.push("## DataPushed breakdown (all typeHash)");
  lines.push("");
  for (const r of rows) {
    lines.push(`### ${r.label}`);
    lines.push("");
    const all = r.dataPushedAllTypeHashLines ?? [];
    if (all.length === 0) {
      lines.push("No `counters.dataPushedByTypeHash` in this artifact.");
      lines.push("");
      continue;
    }
    lines.push("```text");
    lines.push(all.join("\n"));
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

function renderKeyEventWarnings(j10: AnyJson, jAdv: AnyJson, map: Map<string, string>): string {
  const nameToHash = buildNameToHash(map);
  const requiredBasic = [
    "USER_POSITION_UPDATE",
    "USER_STATS_UPDATE",
    "LOAN_CREATED",
    "LOAN_NFT_MINTED",
    "RESERVE_CONSUMED",
  ];
  const requiredAdvanced = [
    "USER_POSITION_UPDATE",
    "USER_STATS_UPDATE",
    "LOAN_CREATED",
    "LOAN_NFT_MINTED",
    "RESERVE_CONSUMED",
    "GUARANTEE_LOCKED",
    "RISK_STATUS_UPDATE",
    "LOAN_REPAID",
    "REPAY_AND_SETTLE",
    "COLLATERAL_RELEASED",
  ];

  const warnFor = (label: string, json: AnyJson, required: string[]) => {
    const present = typeHashSet(json.counters?.dataPushedByTypeHash);
    const missing = required
      .map((name) => ({ name, hash: nameToHash.get(name) }))
      .filter((it) => !!it.hash && !present.has(it.hash as string))
      .map((it) => `${it.name} (${it.hash})`);
    return { label, missing };
  };

  const basic = warnFor("batch-10-users", j10, requiredBasic);
  const adv = warnFor("batch-advanced-10-users", jAdv, requiredAdvanced);

  const lines: string[] = [];
  lines.push("## Key event missing warnings");
  lines.push("");
  for (const item of [basic, adv]) {
    if (item.missing.length === 0) {
      lines.push(`- ${item.label}: OK`);
    } else {
      lines.push(`- ${item.label}: WARN missing ${item.missing.length}`);
      lines.push("```text");
      lines.push(item.missing.join("\n"));
      lines.push("```");
    }
  }
  lines.push("");
  lines.push("Notes:");
  lines.push("- These are guard-rail checks; missing events can indicate skipped branches or missing push paths.");
  lines.push("- Adjust required events if the suite's business scope changes.");
  return lines.join("\n");
}

function renderTypeHashLegend(rows: QuantRow[], map: Map<string, string>): string {
  const hashes = new Set<string>();
  for (const r of rows) {
    const lines = r.dataPushedAllTypeHashLines ?? [];
    for (const line of lines) {
      const first = line.split(" ")[0] ?? "";
      const raw = first.includes("(") ? first.split("(")[0] : first;
      const hash = raw.replace(/:$/, "");
      if (hash && hash.startsWith("0x")) hashes.add(hash.toLowerCase());
    }
  }
  const items = Array.from(hashes)
    .map((h) => `${h} ${map.get(h) ?? "UNKNOWN"}`)
    .sort();

  const lines: string[] = [];
  lines.push("## DataPushed typeHash legend");
  lines.push("");
  lines.push("```text");
  lines.push(items.join("\n"));
  lines.push("```");
  return lines.join("\n");
}

function main() {
  const repoRoot = process.cwd();
  const artifactsDir = path.join(repoRoot, "scripts", "e2e", "artifacts");

  const newest = listArtifactFilesSortedNewestFirst(artifactsDir);

  const latestBatch10 = newest.find((p) => path.basename(p).startsWith("batch-10-users."));
  const latestBatchAdv = newest.find((p) => path.basename(p).startsWith("batch-advanced-10-users."));

  if (!latestBatch10 || !latestBatchAdv) {
    throw new Error(
      `Missing artifacts. Found batch-10-users: ${String(latestBatch10)}, batch-advanced-10-users: ${String(latestBatchAdv)} in ${artifactsDir}`
    );
  }

  const j10 = readJson(latestBatch10);
  const jAdv = readJson(latestBatchAdv);

  const typeMap = loadDataPushTypeMap(repoRoot);
  const rows = [
    buildRow("batch-10-users", latestBatch10, j10, typeMap),
    buildRow("batch-advanced-10-users", latestBatchAdv, jAdv, typeMap),
  ];

  const md =
    "# Latest batch E2E artifacts (quantified)\n\n" +
    renderMarkdownTable(rows) +
    "\n\n" +
    renderBusinessChecks(rows) +
    "\n\n" +
    renderDataPushedBreakdown(rows) +
    "\n\n" +
    renderTypeHashDiff(j10, jAdv, typeMap) +
    "\n\n" +
    renderDataPushedAll(rows) +
    "\n\n" +
    renderKeyEventWarnings(j10, jAdv, typeMap) +
    "\n\n" +
    renderTypeHashLegend(rows, typeMap) +
    "\n\n" +
    renderOrderListings(rows) +
    "\n\n" +
    `Generated at: ${new Date().toISOString()}\n`;

  const outPath = path.join(repoRoot, "scripts", "e2e", "doc", "E2E-Quantification-Latest.md");
  fs.writeFileSync(outPath, md, "utf8");

  // Also print to stdout for CI / quick view.
  process.stdout.write(md + "\n");
}

main();
