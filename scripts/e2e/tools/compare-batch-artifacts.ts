import * as fs from "node:fs";
import * as path from "node:path";
import { ethers } from "ethers";

type BatchArtifact = {
  name?: string;
  generatedAt?: string;
  chainId?: string;
  rpcUrl?: string;
  blockNumber?: number;
  modules?: Record<string, string>;
  orderIds?: Record<string, string[]>; // basic
  orders?: Array<{ saltSuffix: string; borrower: string; lender: string; orderId: string; principalRaw: string; withGuarantee: boolean }>; // advanced
  checkpoints?: Record<string, any>;
  counters?: { dataPushedByTypeHash?: Record<string, number> };
};

function pickLatestArtifacts(dir: string, prefix: string): string {
  const re = new RegExp(`^${prefix}\\.(\\d+)\\.json$`);
  let bestTs = -1;
  let best: string | null = null;
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(re);
    if (!m) continue;
    const ts = Number(m[1]);
    if (!Number.isFinite(ts)) continue;
    if (ts > bestTs) {
      bestTs = ts;
      best = name;
    }
  }
  if (!best) throw new Error(`No artifacts found for prefix=${prefix} in ${dir}`);
  return path.join(dir, best);
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sumCounts(m: Record<string, number> | undefined): number {
  if (!m) return 0;
  let s = 0;
  for (const v of Object.values(m)) s += v;
  return s;
}

function fmtType(hash: string, known: Record<string, string>): string {
  const h = hash.toLowerCase();
  const label = known[h];
  return label ? `${label} (${h.slice(0, 10)}…)` : `${h.slice(0, 10)}…`;
}

function buildKnownTypeMap(): Record<string, string> {
  const names = [
    "RISK_STATUS_UPDATE",
    "USER_POSITION_UPDATE",
    "LOAN_CREATED",
    "LOAN_REPAID",
    "COLLATERAL_RELEASED",
    "REPAY_AND_SETTLE",
    "LIQUIDATION_UPDATE",
    "USER_STATS_UPDATE",
    "GLOBAL_STATS_UPDATE",
    "EASY_MINTED",
    "CACHE_UPDATE_FAILED",
  ];
  const out: Record<string, string> = {};
  for (const n of names) out[ethers.id(n).toLowerCase()] = n;
  return out;
}

function fmtUnitsSafe(raw: unknown, decimals: number): string {
  try {
    if (raw === null || raw === undefined) return "n/a";
    const b = BigInt(String(raw));
    return ethers.formatUnits(b, decimals);
  } catch {
    return "n/a";
  }
}

function printCheckpoint(label: string, cp: any) {
  const expectedCol = fmtUnitsSafe(cp?.expected?.collateralDeltaRaw ?? cp?.expected?.ledgerCollateralDeltaRaw, 6);
  const expectedDebt = fmtUnitsSafe(cp?.expected?.debtDeltaRaw ?? cp?.expected?.ledgerDebtDeltaRaw, 6);
  const ledgerCol = fmtUnitsSafe(cp?.ledger?.collateralDeltaRaw ?? cp?.ledger?.deltaCollateralRaw, 6);
  const ledgerDebt = fmtUnitsSafe(cp?.ledger?.debtDeltaRaw ?? cp?.ledger?.deltaDebtRaw, 6);

  const statsCol = fmtUnitsSafe(
    cp?.statisticsView?.collateralDeltaUsd8Raw ?? cp?.statisticsView?.deltaCollateralUsd8Raw,
    8
  );
  const statsDebt = fmtUnitsSafe(cp?.statisticsView?.debtDeltaUsd8Raw ?? cp?.statisticsView?.deltaDebtUsd8Raw, 8);

  console.log(`- ${label}: expected(col=${expectedCol}, debt=${expectedDebt}) ledger(col=${ledgerCol}, debt=${ledgerDebt}) stats(usd8 col=${statsCol}, debt=${statsDebt})`);
}

function main() {
  const artifactsDir = path.join(__dirname, "..", "artifacts");
  const basicPath = pickLatestArtifacts(artifactsDir, "batch-10-users");
  const advPath = pickLatestArtifacts(artifactsDir, "batch-advanced-10-users");

  const basic = readJson(basicPath) as BatchArtifact;
  const adv = readJson(advPath) as BatchArtifact;

  const knownTypes = buildKnownTypeMap();

  const basicCounts = basic.counters?.dataPushedByTypeHash ?? {};
  const advCounts = adv.counters?.dataPushedByTypeHash ?? {};

  const basicTotal = sumCounts(basicCounts);
  const advTotal = sumCounts(advCounts);

  const basicOrderIds = Object.entries(basic.orderIds ?? {}).flatMap(([group, ids]) => ids.map((id) => `${group}:${id}`));
  const advOrderIds = (adv.orders ?? []).map((o) => `${o.saltSuffix}:${o.orderId}`);

  console.log("# Batch Artifacts Comparison\n");
  console.log(`- Basic: ${path.basename(basicPath)} (${basic.generatedAt ?? ""}) chainId=${basic.chainId ?? ""} block=${basic.blockNumber ?? ""}`);
  console.log(`- Advanced: ${path.basename(advPath)} (${adv.generatedAt ?? ""}) chainId=${adv.chainId ?? ""} block=${adv.blockNumber ?? ""}`);
  console.log("");

  console.log("## High-level\n");
  console.log(`- DataPushed total: basic=${basicTotal} advanced=${advTotal}`);
  console.log(`- Orders recorded: basic=${basicOrderIds.length} advanced=${advOrderIds.length}`);
  if (basic.rpcUrl || adv.rpcUrl) {
    console.log(`- RPC URL: basic=${basic.rpcUrl ?? ""} advanced=${adv.rpcUrl ?? ""}`);
  }
  console.log("");

  console.log("## Checkpoints\n");
  if (basic.checkpoints) {
    const cp1 = basic.checkpoints["checkpoint1_after_matches"];
    const cp2 = basic.checkpoints["checkpoint2_after_all_repaid"];
    if (cp1) printCheckpoint("Basic checkpoint1_after_matches", cp1);
    if (cp2) printCheckpoint("Basic checkpoint2_after_all_repaid", cp2);
  } else {
    console.log("- Basic: n/a");
  }
  if (adv.checkpoints) {
    const cpa = adv.checkpoints["checkpointA_after_matches"];
    const cpf = adv.checkpoints["final_after_all_repaid"];
    if (cpa) printCheckpoint("Advanced checkpointA_after_matches", cpa);
    if (cpf) printCheckpoint("Advanced final_after_all_repaid", cpf);
  } else {
    console.log("- Advanced: n/a");
  }
  console.log("");

  console.log("## DataPushed Diff (top 12 by |Δ|)\n");
  const keys = new Set([...Object.keys(basicCounts), ...Object.keys(advCounts)].map((k) => k.toLowerCase()));
  const diffs = [...keys].map((k) => {
    const a = advCounts[k] ?? 0;
    const b = basicCounts[k] ?? 0;
    return { k, a, b, d: a - b };
  });
  diffs.sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
  for (const it of diffs.slice(0, 12)) {
    const label = fmtType(it.k, knownTypes);
    console.log(`- ${label}: advanced=${it.a} basic=${it.b} Δ=${it.d}`);
  }
  console.log("");

  console.log("## Orders (sample)\n");
  if (basic.orderIds) {
    const groups = Object.entries(basic.orderIds);
    for (const [g, ids] of groups) {
      console.log(`- Basic ${g}: count=${ids.length} ids=${ids.join(",")}`);
    }
  }
  if (adv.orders) {
    const head = adv.orders.slice(0, 12);
    for (const o of head) {
      console.log(
        `- Advanced ${o.saltSuffix}: orderId=${o.orderId} principal=${ethers.formatUnits(BigInt(o.principalRaw), 6)} guarantee=${o.withGuarantee}`
      );
    }
    if (adv.orders.length > head.length) console.log(`- Advanced ... (${adv.orders.length - head.length} more)`);
  }

  console.log("");
  console.log("(Tip) Re-run with pinned RPC: LOCALHOST_RPC_URL=http://127.0.0.1:18545");
}

main();
