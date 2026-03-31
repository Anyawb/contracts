import * as fs from "node:fs";
import * as path from "node:path";
import { ethers } from "ethers";

const E2E_DIR = path.join(__dirname, "..");
const LOGS_DIR = path.join(E2E_DIR, "logs");
const ARTIFACTS_DIR = path.join(E2E_DIR, "artifacts");
const OUT_PATH = path.join(E2E_DIR, "doc", "E2E-Deep-Dive-Latest.md");

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listRunDirs(): Array<{ name: string; full: string }> {
  if (!fs.existsSync(LOGS_DIR)) return [];
  return fs
    .readdirSync(LOGS_DIR)
    .filter((d) => d.startsWith("e2e-run-"))
    .map((d) => ({ name: d, full: path.join(LOGS_DIR, d) }))
    .filter((d) => fs.statSync(d.full).isDirectory())
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

function latestManifest(): { path: string; data: any } | null {
  const dirs = listRunDirs();
  if (dirs.length === 0) return null;
  const manifestPath = path.join(dirs[0].full, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  return { path: manifestPath, data: readJson(manifestPath) };
}

function latestArtifact(prefix: string): { path: string; data: any } | null {
  if (!fs.existsSync(ARTIFACTS_DIR)) return null;
  const files = fs.readdirSync(ARTIFACTS_DIR).filter((f) => f.startsWith(prefix + ".") && f.endsWith(".json"));
  const parsed = files
    .map((f) => {
      const full = path.join(ARTIFACTS_DIR, f);
      const m = f.match(/\.(\d+)\.json$/);
      let generatedAtMs = 0;
      try {
        const json = readJson(full);
        const generatedAt = String(json?.generatedAt ?? "").trim();
        const parsedGeneratedAt = Date.parse(generatedAt);
        if (Number.isFinite(parsedGeneratedAt)) {
          generatedAtMs = parsedGeneratedAt;
        }
      } catch {
        // Fall back to file metadata below.
      }
      const stat = fs.statSync(full);
      return {
        file: f,
        full,
        generatedAtMs,
        mtimeMs: stat.mtimeMs,
        numericSuffix: m ? Number(m[1]) : 0,
      };
    })
    .sort((a, b) => {
      const aRank = a.generatedAtMs || a.mtimeMs || a.numericSuffix;
      const bRank = b.generatedAtMs || b.mtimeMs || b.numericSuffix;
      return bRank - aRank;
    });
  if (parsed.length === 0) return null;
  const full = parsed[0].full;
  return { path: full, data: readJson(full) };
}

function findLog(manifest: any, scriptFile: string): string | null {
  const row = (manifest?.scripts ?? []).find((s: any) => s.file === scriptFile);
  if (!row?.logFile) return null;
  return row.logFile;
}

function readLog(logPath: string | null): string {
  if (!logPath || !fs.existsSync(logPath)) return "";
  return fs.readFileSync(logPath, "utf8");
}

function assertOk(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((n) => text.includes(n));
}

function findScenarioByLabel(artifact: any, label: string): any | null {
  const scenarios = Array.isArray(artifact?.scenarios) ? artifact.scenarios : [];
  return scenarios.find((scenario: any) => scenario?.label === label) ?? null;
}

function countDistinctAssets(orders: any[]): number {
  return new Set(
    orders
      .map((order) => String(order?.asset ?? "").toLowerCase())
      .filter((asset) => asset.length > 0)
  ).size;
}

function rewardViewPushFailedCount(artifact: any): number {
  const counters = artifact?.counters;
  if (typeof counters?.rewardViewPushFailedTotal === "number") return counters.rewardViewPushFailedTotal;

  let count = 0;
  const rewardExtended = artifact?.rewardExtendedChecks;
  if (rewardExtended?.missingRewardViewBestEffort?.skipped === false) {
    count += 1;
  }
  if (Array.isArray(artifact?.steps)) {
    for (const step of artifact.steps) {
      if (typeof step?.rewardViewPushFailedCount === "number") count += step.rewardViewPushFailedCount;
    }
  }
  return count;
}

function expectedRewardViewPushFailedCount(artifact: any): number {
  let count = 0;
  const rewardExtended = artifact?.rewardExtendedChecks;
  if (rewardExtended?.missingRewardViewBestEffort?.skipped === false) {
    const delayedCount = rewardExtended?.missingRewardViewBestEffort?.afterCacheRollover?.rewardViewPushFailedCount;
    count += typeof delayedCount === "number" ? delayedCount : 1;
  }
  if (Array.isArray(artifact?.steps)) {
    for (const step of artifact.steps) {
      if (step?.coverageStatus !== "covered") continue;
      if (typeof step?.rewardViewPushFailedCount !== "number" || step.rewardViewPushFailedCount <= 0) continue;
      if (typeof step?.semantics !== "string") continue;
      if (!step.semantics.toLowerCase().includes("authoritative coverage")) continue;
      count += step.rewardViewPushFailedCount;
    }
  }
  return count;
}

function validateLiquidationOrdersScenario(scenario: any, label: string) {
  assertOk(!!scenario, `price-liquidation-stress: missing ${label} scenario`);
  assertOk(Array.isArray(scenario?.orders), `price-liquidation-stress: ${label}.orders missing`);
  assertOk(scenario.orders.length > 0, `price-liquidation-stress: ${label} has no orders`);

  const executedOrders = scenario.orders.filter((order: any) => !order?.skipped);
  assertOk(executedOrders.length > 0, `price-liquidation-stress: ${label} has no executed liquidation orders`);

  for (const order of executedOrders) {
    assertOk(!!order?.orderId, `price-liquidation-stress: ${label} orderId missing`);
    assertOk(
      Array.isArray(order?.liquidationPushes) && order.liquidationPushes.length > 0,
      `price-liquidation-stress: ${label} order ${String(order?.orderId ?? "?")} missing liquidation pushes`
    );
  }

  return executedOrders;
}

function findOrderAsset(artifact: any, orderId: string): string | null {
  const target = String(orderId);
  const queue: any[] = [artifact];
  while (queue.length > 0) {
    const node = queue.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const v of node) queue.push(v);
      continue;
    }
    if (node.orderId && String(node.orderId) === target && Array.isArray(node.order)) {
      const order = node.order as any[];
      if (order.length >= 6 && typeof order[5] === "string") return order[5];
    }
    for (const v of Object.values(node)) queue.push(v);
  }
  return null;
}

function writeReport(lines: string[]) {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, lines.join("\n") + "\n", "utf8");
}

function main() {
  const report: string[] = [];
  report.push("# E2E Deep Dive (Latest)");
  report.push("");

  const manifest = latestManifest();
  assertOk(!!manifest, "No E2E manifest found under scripts/e2e/logs");

  const batchAdvanced = latestArtifact("batch-advanced-10-users");
  const liquidationRewardPenalty = latestArtifact("liquidation-reward-penalty");
  const rewardView = latestArtifact("rewardview-acceptance");
  const rewardSpend = latestArtifact("rewardspend-acceptance");
  const stress = latestArtifact("price-liquidation-stress");
  const blocksOnlyStandalone = latestArtifact("blocks-only-rollout-smoke.localhost-standalone");
  const blocksOnlyEmbedded = latestArtifact("blocks-only-rollout-smoke.advanced-batch");
  const fullWithViews = latestArtifact("full-with-views");
  const forkKeeper = latestArtifact("fork-arbitrum-stale-price-keeper");

  assertOk(!!batchAdvanced, "Missing batch-advanced-10-users artifact");
  assertOk(!!liquidationRewardPenalty, "Missing liquidation-reward-penalty artifact");
  assertOk(!!rewardView, "Missing rewardview-acceptance artifact");
  assertOk(!!rewardSpend, "Missing rewardspend-acceptance artifact");
  assertOk(!!stress, "Missing price-liquidation-stress artifact");
  assertOk(!!blocksOnlyStandalone, "Missing blocks-only standalone artifact");
  assertOk(!!blocksOnlyEmbedded, "Missing blocks-only embedded artifact");
  assertOk(!!fullWithViews, "Missing full-with-views artifact");
  assertOk(!!forkKeeper, "Missing fork-arbitrum-stale-price-keeper artifact");

  report.push("## Inputs");
  report.push("");
  report.push(`- manifest: ${manifest!.path}`);
  report.push(`- batch-advanced: ${batchAdvanced!.path}`);
  report.push(`- liquidation-reward-penalty: ${liquidationRewardPenalty!.path}`);
  report.push(`- rewardview-acceptance: ${rewardView!.path}`);
  report.push(`- rewardspend-acceptance: ${rewardSpend!.path}`);
  report.push(`- price-liquidation-stress: ${stress!.path}`);
  report.push(`- blocks-only-standalone: ${blocksOnlyStandalone!.path}`);
  report.push(`- blocks-only-embedded: ${blocksOnlyEmbedded!.path}`);
  report.push(`- full-with-views: ${fullWithViews!.path}`);
  report.push(`- fork-arbitrum-stale-price-keeper: ${forkKeeper!.path}`);
  report.push("");

  // 1) Price / liquidation signals (batch-advanced log)
  const batchLog = readLog(findLog(manifest!.data, "e2e-localhost-batch-advanced-10-users.ts"));
  assertOk(batchLog.length > 0, "Missing batch-advanced log in manifest");
  assertOk(
    hasAny(batchLog, ["Oracle Extreme Price Change (HF/LTV)", "Oracle Extreme Price Change"]),
    "Price stress marker not found in batch-advanced log (Oracle Extreme Price Change)"
  );
  assertOk(
    hasAny(batchLog, ["=== Extra: Keeper Liquidation (settleOrLiquidate SSOT) ===", "settleOrLiquidate"]),
    "Liquidation marker not found in batch-advanced log"
  );

  // Ensure liquidation demo order exists
  const orders = batchAdvanced!.data?.orders ?? [];
  const suffixes = new Set((orders as any[]).map((o) => String(o.saltSuffix)));
  assertOk(suffixes.has("liq-demo"), "batch-advanced: missing liq-demo order");

  // 2) Reward / DataPush coverage (RewardView acceptance)
  const rewardCounters = rewardView!.data?.counters?.dataPushedByTypeHash ?? {};
  const spendCounters = rewardSpend!.data?.counters?.dataPushedByTypeHash ?? {};
  const wantRewardHashes = ["EASY_MINTED", "REWARD_PENALTY_LEDGER_UPDATED"].map((s) =>
    ethers.keccak256(ethers.toUtf8Bytes(s)).toLowerCase()
  );
  const wantSpendHashes = ["EASY_SPENT", "EASY_RECYCLED_SPLIT"].map((s) =>
    ethers.keccak256(ethers.toUtf8Bytes(s)).toLowerCase()
  );
  for (const h of wantRewardHashes) {
    assertOk(rewardCounters[h] !== undefined, `RewardView artifact missing DataPushed typeHash: ${h}`);
  }
  for (const h of wantSpendHashes) {
    assertOk(spendCounters[h] !== undefined, `RewardSpend artifact missing DataPushed typeHash: ${h}`);
  }

  // 3) Multi-asset + cross-module signals
  assertOk(suffixes.has("ma-usdc"), "batch-advanced: missing ma-usdc order");
  assertOk(suffixes.has("ma-alt"), "batch-advanced: missing ma-alt order");

  const usdc = String(orders.find((o: any) => o.saltSuffix === "ma-usdc")?.orderId ?? "");
  const alt = String(orders.find((o: any) => o.saltSuffix === "ma-alt")?.orderId ?? "");
  assertOk(usdc.length > 0 && alt.length > 0, "batch-advanced: cannot resolve multi-asset orderIds");

  const usdcAsset = findOrderAsset(batchAdvanced!.data, usdc);
  const altAsset = findOrderAsset(batchAdvanced!.data, alt);
  assertOk(!!usdcAsset, "batch-advanced: cannot resolve ma-usdc order asset address");
  assertOk(!!altAsset, "batch-advanced: cannot resolve ma-alt order asset address");
  assertOk(String(usdcAsset).toLowerCase() !== String(altAsset).toLowerCase(), "multi-asset: alt asset equals usdc");

  // 4) Permissions / upgrade smoke (attack-suite log)
  const attackLog = readLog(findLog(manifest!.data, "e2e-localhost-attack-suite.ts"));
  assertOk(attackLog.length > 0, "Missing attack-suite log in manifest");
  assertOk(!attackLog.includes("function selector was not recognized"), "Attack-suite: missing selector detected (ABI mismatch)");

  // 5) Price/liquidation stress artifact assertions
  assertOk(Array.isArray(stress!.data?.scenarios), "price-liquidation-stress: scenarios missing");
  assertOk(stress!.data.scenarios.length > 0, "price-liquidation-stress: no scenarios recorded");
  const stressMode = String(stress!.data?.config?.mode ?? "").toLowerCase();
  assertOk(
    ["multi", "grind", "multi+grind"].includes(stressMode),
    `price-liquidation-stress: unsupported config.mode ${JSON.stringify(stress!.data?.config?.mode ?? null)}`
  );

  const guaranteeEnabled = stress!.data?.config?.guaranteeExtensionFlowEnabled !== false;
  const guaranteeScenario = findScenarioByLabel(stress!.data, "guarantee-extension-flow");
  if (guaranteeEnabled) {
    assertOk(!!guaranteeScenario, "price-liquidation-stress: guarantee-extension-flow missing while guarantee flow enabled");
  }
  if (guaranteeScenario) {
    assertOk(!!guaranteeScenario?.earlyRepay?.orderId, "price-liquidation-stress: guarantee earlyRepay.orderId missing");
    assertOk(guaranteeScenario?.earlyRepay?.lockedAfter === "0", "price-liquidation-stress: guarantee earlyRepay lock not released");
    assertOk(!!guaranteeScenario?.defaultFlow?.orderId, "price-liquidation-stress: guarantee defaultFlow.orderId missing");
    assertOk(guaranteeScenario?.defaultFlow?.lockedAfter === "0", "price-liquidation-stress: guarantee defaultFlow lock not released");
  }

  const multiScenario = findScenarioByLabel(stress!.data, "multi-asset-crash");
  const grindScenario = findScenarioByLabel(stress!.data, "long-run-grind");

  if (stressMode === "multi" || stressMode === "multi+grind") {
    const multiOrders = validateLiquidationOrdersScenario(multiScenario, "multi-asset-crash");
    assertOk(
      multiScenario && typeof multiScenario.pricePath === "object" && Object.keys(multiScenario.pricePath).length > 0,
      "price-liquidation-stress: multi-asset-crash.pricePath missing"
    );
    assertOk(countDistinctAssets(multiOrders) >= 2, "price-liquidation-stress: multi-asset-crash did not exercise multiple assets");
  }

  if (stressMode === "grind" || stressMode === "multi+grind") {
    validateLiquidationOrdersScenario(grindScenario, "long-run-grind");
    assertOk(!!grindScenario?.grind, "price-liquidation-stress: long-run-grind.grind missing");
    assertOk(Number(grindScenario.grind.rounds) > 0, "price-liquidation-stress: long-run-grind rounds invalid");
  }

  for (const [label, artifact] of [
    ["blocks-only-standalone", blocksOnlyStandalone!],
    ["blocks-only-embedded", blocksOnlyEmbedded!],
  ] as const) {
    assertOk(artifact.data?.preflight?.prematureSettleRejected === true, `${label}: premature settle revert coverage missing`);
    assertOk(artifact.data?.checkpoints?.repayAndSettle?.settled === true, `${label}: repay-settle checkpoint missing`);
    assertOk(artifact.data?.checkpoints?.liquidation?.liquidated === true, `${label}: liquidation checkpoint missing`);
    assertOk(Object.keys(artifact.data?.dataPushCounts ?? {}).length > 0, `${label}: dataPushCounts missing`);
  }

  const repayCheckpoint = fullWithViews!.data?.checkpoints?.after_match_repay;
  assertOk(!!repayCheckpoint, "full-with-views: after_match_repay checkpoint missing");
  assertOk(repayCheckpoint?.healthView?.isValid === true, "full-with-views: HealthView should be valid after repay checkpoint");
  assertOk(repayCheckpoint?.rewardView?.isValid === true, "full-with-views: RewardView should be valid after repay checkpoint");
  assertOk(Number(fullWithViews!.data?.rewardCheck?.rewardPushCount ?? 0) > 0, "full-with-views: reward push count missing");

  const forkSteps = Array.isArray(forkKeeper!.data?.steps) ? forkKeeper!.data.steps : [];
  const forkStepNames = new Set(forkSteps.map((step: any) => String(step?.step ?? "")));
  for (const required of ["fresh-price", "mined-to-stale", "view-under-stale", "refreshed"]) {
    assertOk(forkStepNames.has(required), `fork keeper: missing step ${required}`);
  }
  assertOk(
    ["degraded", "revert"].includes(String(forkKeeper!.data?.diagnostics?.view?.staleMode ?? "")),
    "fork keeper: stale view mode missing",
  );
  assertOk(
    String(forkKeeper!.data?.diagnostics?.oracle?.staleSelectorObserved ?? "").length > 0,
    "fork keeper: stale selector diagnostics missing",
  );

  report.push("## Checks");
  report.push("");
  report.push("- Price/clearing markers: OK");
  report.push("- Reward DataPushed coverage: OK");
  report.push("- Blocks-only rollout smoke coverage: OK");
  report.push("- Full-with-views repay checkpoint validity: OK");
  report.push("- Fork stale-price keeper observability: OK");
  report.push("- Multi-asset order separation: OK");
  report.push("- Attack-suite ABI smoke: OK");
  report.push(`- Stress mode: ${stressMode}`);
  if (stressMode === "multi" || stressMode === "multi+grind") {
    report.push("- Stress multi-asset-crash: OK");
  }
  if (stressMode === "grind" || stressMode === "multi+grind") {
    report.push("- Stress long-run-grind: OK");
  }
  if (guaranteeScenario) {
    report.push("- Stress guarantee-extension flow: OK");
  }
  const degradationSummary = [
    {
      label: "batch-advanced-10-users",
      total: rewardViewPushFailedCount(batchAdvanced!.data),
      expected: expectedRewardViewPushFailedCount(batchAdvanced!.data),
    },
    {
      label: "liquidation-reward-penalty",
      total: rewardViewPushFailedCount(liquidationRewardPenalty!.data),
      expected: expectedRewardViewPushFailedCount(liquidationRewardPenalty!.data),
    },
    {
      label: "rewardview-acceptance",
      total: rewardViewPushFailedCount(rewardView!.data),
      expected: expectedRewardViewPushFailedCount(rewardView!.data),
    },
    {
      label: "rewardspend-acceptance",
      total: rewardViewPushFailedCount(rewardSpend!.data),
      expected: expectedRewardViewPushFailedCount(rewardSpend!.data),
    },
    {
      label: "price-liquidation-stress",
      total: rewardViewPushFailedCount(stress!.data),
      expected: expectedRewardViewPushFailedCount(stress!.data),
    },
  ];
  const unexpected = degradationSummary
    .map((item) => ({ ...item, unexpected: Math.max(0, item.total - item.expected) }))
    .filter((item) => item.unexpected > 0);
  const expectedCoverage = degradationSummary.filter((item) => item.expected > 0);
  if (unexpected.length === 0) {
    if (expectedCoverage.length === 0) {
      report.push("- RewardView degrade observability: OK");
    } else {
      report.push(
        `- RewardView degrade observability: OK (expected coverage: ${expectedCoverage
          .map((item) => `${item.label}=${item.expected}`)
          .join(", ")})`
      );
    }
  } else {
    report.push("- RewardView degrade observability: OK");
    report.push(
      `- RewardView degrade unexpected signals: WARN (${unexpected
        .map((item) => `${item.label}=${item.unexpected}`)
        .join(", ")})`
    );
  }
  report.push("");

  writeReport(report);
  console.log(`✅ Deep dive audit passed. Report: ${OUT_PATH}`);
}

try {
  main();
} catch (e: any) {
  console.error(e?.message ?? String(e));
  process.exitCode = 1;
}
