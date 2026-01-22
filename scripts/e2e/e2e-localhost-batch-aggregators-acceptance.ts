import { ethers, network } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";
import { runViewPreflight } from "./utils/view-preflight";

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function assertOk(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function fmtErr(e: any) {
  return e?.shortMessage ?? e?.message ?? String(e);
}

function isMissingSelectorError(msg: string): boolean {
  return msg.includes("function selector was not recognized");
}

function errorSelector(sig: string): string {
  return ethers.id(sig).slice(0, 10);
}

function extractRevertData(e: any): string | undefined {
  const candidates: Array<unknown> = [
    e?.data,
    e?.error?.data,
    e?.error?.error?.data,
    e?.info?.error?.data,
    e?.info?.error?.error?.data,
    e?.receipt?.revertReason,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("0x")) return c;
  }
  const msg = fmtErr(e);
  const m = String(msg).match(/return data:\s*(0x[0-9a-fA-F]+)/);
  if (m?.[1]) return m[1];
  return undefined;
}

function extractCustomErrorSigFromMessage(e: any): string | undefined {
  const msg = fmtErr(e);
  const m = String(msg).match(/custom error\s+'([^']+)'/);
  if (!m?.[1]) return undefined;
  const raw = m[1].trim();
  return raw.includes("(") ? raw : `${raw}()`;
}

async function mustRevertWithSelector(label: string, fn: () => Promise<unknown>, expectedSel: string) {
  try {
    await fn();
  } catch (e: any) {
    const msg = fmtErr(e);
    if (isMissingSelectorError(String(msg))) {
      throw new Error(
        `[FAIL] ${label}: call reverted due to missing function selector (deployment/ABI mismatch). Re-run compile + deploy:localhost.`
      );
    }
    const data = extractRevertData(e);
    let sel: string | undefined;
    if (data && data.startsWith("0x") && data.length >= 10) {
      sel = data.slice(0, 10).toLowerCase();
    } else {
      const sig = extractCustomErrorSigFromMessage(e);
      if (sig) sel = errorSelector(sig).toLowerCase();
    }
    assertOk(!!sel, `${label}: missing revert data (cannot validate selector)`);
    assertOk(sel === expectedSel.toLowerCase(), `${label}: unexpected error selector ${sel}, expected ${expectedSel}`);
    console.log(`  ✅ [revert selector ok] ${label}: ${sel}`);
    return;
  }
  throw new Error(`[FAIL] Expected revert, but succeeded: ${label}`);
}

async function mustSucceed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    const msg = fmtErr(e);
    if (isMissingSelectorError(String(msg))) {
      throw new Error(
        `[FAIL] ${label}: missing function selector on-chain (deployment/ABI mismatch). Re-run compile + deploy:localhost.`
      );
    }
    throw e;
  }
}

async function snapshot(): Promise<string> {
  return await network.provider.send("evm_snapshot", []);
}

async function revertTo(id: string) {
  await network.provider.send("evm_revert", [id]);
}

function assertNoPushEntryPoints(c: any, label: string) {
  const fns = c.interface.fragments.filter((x: any) => x.type === "function").map((x: any) => x.name);
  const pushes = fns.filter((n: string) => n.startsWith("push"));
  assertOk(pushes.length === 0, `${label}: must not expose push* entrypoints: ${pushes.join(", ")}`);
}

function assertNoBusinessStateWriters(c: any, label: string) {
  const allowed = new Set(["initialize", "upgradeTo", "upgradeToAndCall", "proxiableUUID"]);
  const bad = c.interface.fragments
    .filter((x: any) => x.type === "function")
    .filter((f: any) => !["view", "pure"].includes(f.stateMutability))
    .map((f: any) => `${f.name}(${f.stateMutability})`)
    .filter((s: string) => !allowed.has(s.split("(")[0]));
  assertOk(bad.length === 0, `${label}: must not expose non-view writers (except UUPS/init): ${bad.join(", ")}`);
}

async function main() {
  const snap = await snapshot();
  try {
    const [deployer] = await ethers.getSigners();
    console.log("=== E2E Batch Aggregators Acceptance (ARCH 4.11) ===\n");

    await runViewPreflight({
      registryAddr: CONTRACT_ADDRESSES.Registry,
      acmAddr: CONTRACT_ADDRESSES.AccessControlManager,
      adminSigner: deployer,
      assetForPriceCheck: CONTRACT_ADDRESSES.MockUSDC,
    });

    const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
    const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
    const batchAddr = (await registry.getModuleOrRevert(key("BATCH_VIEW"))) as string;
    const cacheOptAddr = (await registry.getModuleOrRevert(key("CACHE_OPTIMIZED_VIEW"))) as string;
    const dashboardAddr = (await registry.getModuleOrRevert(key("DASHBOARD_VIEW"))) as string;
    const vovAddr = (await registry.getModuleOrRevert(key("VALUATION_ORACLE_VIEW"))) as string;
    const pvAddr = (await registry.getModuleOrRevert(key("POSITION_VIEW"))) as string;

    const batch = (await ethers.getContractAt("BatchView", batchAddr)) as any;
    const cacheOpt = (await ethers.getContractAt("CacheOptimizedView", cacheOptAddr)) as any;
    const dashboard = (await ethers.getContractAt("DashboardView", dashboardAddr)) as any;
    const vov = (await ethers.getContractAt("ValuationOracleView", vovAddr)) as any;
    const pv = (await ethers.getContractAt("PositionView", pvAddr)) as any;

    console.log("  Registry:", CONTRACT_ADDRESSES.Registry);
    console.log("  BatchView:", batchAddr);
    console.log("  CacheOptimizedView:", cacheOptAddr);
    console.log("  DashboardView:", dashboardAddr);

    // ====== MUST: no push* + no business writers ======
    assertNoPushEntryPoints(batch, "BatchView");
    assertNoPushEntryPoints(cacheOpt, "CacheOptimizedView");
    assertNoPushEntryPoints(dashboard, "DashboardView");

    assertNoBusinessStateWriters(batch, "BatchView");
    assertNoBusinessStateWriters(cacheOpt, "CacheOptimizedView");
    assertNoBusinessStateWriters(dashboard, "DashboardView");

    // ====== MUST: batch limits enforced + unified error type ======
    const tooLargeSel = errorSelector("BatchTooLarge(uint256,uint256)");

    const oversizedAssets = new Array(101).fill(CONTRACT_ADDRESSES.MockUSDC);
    await mustRevertWithSelector("BatchView.batchGetAssetPrices oversized", async () => batch.connect(deployer).batchGetAssetPrices(oversizedAssets), tooLargeSel);
    await mustRevertWithSelector("DashboardView.getUserAssetBreakdown oversized", async () => dashboard.connect(deployer).getUserAssetBreakdown(deployer.address, oversizedAssets), tooLargeSel);
    await mustRevertWithSelector("DashboardView.getUserOverview oversized", async () => dashboard.connect(deployer).getUserOverview(deployer.address, oversizedAssets), tooLargeSel);

    const oversizedUsers = new Array(101).fill(deployer.address);
    await mustRevertWithSelector("BatchView.batchGetHealthFactors oversized", async () => batch.connect(deployer).batchGetHealthFactors(oversizedUsers), tooLargeSel);
    await mustRevertWithSelector("BatchView.batchGetRiskAssessments oversized", async () => batch.connect(deployer).batchGetRiskAssessments(oversizedUsers), tooLargeSel);
    await mustRevertWithSelector("CacheOptimizedView.batchGetUserHealthFactors oversized", async () => cacheOpt.connect(deployer).batchGetUserHealthFactors(oversizedUsers), tooLargeSel);

    // limit-based entrypoint should share the same too-large selector
    const ROLE_VIEW_SYSTEM_STATUS = key("ACTION_VIEW_SYSTEM_STATUS");
    const hasSysStatus = (await acm.hasRole(ROLE_VIEW_SYSTEM_STATUS, deployer.address)) as boolean;
    if (!hasSysStatus) {
      await mustSucceed("grant VIEW_SYSTEM_STATUS to deployer (for limit check)", async () =>
        acm.grantRole(ROLE_VIEW_SYSTEM_STATUS, deployer.address)
      );
    }
    await mustRevertWithSelector(
      "BatchView.getDegradationHistory oversized limit",
      async () => batch.connect(deployer).getDegradationHistory(101n),
      tooLargeSel
    );

    // ====== MUST: permissions not bypassed (price) ======
    const missingRoleSel = errorSelector("MissingRole()");
    const unauth = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: unauth.address, value: ethers.parseEther("1") });
    await mustRevertWithSelector(
      "Unauthorized: BatchView.batchGetAssetPrices requires VIEW_PRICE_DATA",
      async () => batch.connect(unauth).batchGetAssetPrices([CONTRACT_ADDRESSES.MockUSDC]),
      missingRoleSel
    );
    await mustRevertWithSelector(
      "Unauthorized: ValuationOracleView.getAssetPrices requires VIEW_PRICE_DATA",
      async () => vov.connect(unauth).getAssetPrices([CONTRACT_ADDRESSES.MockUSDC]),
      missingRoleSel
    );

    // ====== STRICT MUST: aggregator ↔ dedicated permission behavior matches (risk) ======
    const hvAddr = (await registry.getModuleOrRevert(key("HEALTH_VIEW"))) as string;
    const rvAddr = (await registry.getModuleOrRevert(key("RISK_VIEW"))) as string;
    const hv = (await ethers.getContractAt("HealthView", hvAddr)) as any;
    const rv = (await ethers.getContractAt("RiskView", rvAddr)) as any;

    await mustRevertWithSelector(
      "Unauthorized: HealthView.getUserHealthFactor requires VIEW_RISK_DATA",
      async () => hv.connect(unauth).getUserHealthFactor(unauth.address),
      missingRoleSel
    );
    await mustRevertWithSelector(
      "Unauthorized: BatchView.batchGetHealthFactors requires VIEW_RISK_DATA",
      async () => batch.connect(unauth).batchGetHealthFactors([unauth.address]),
      missingRoleSel
    );

    await mustRevertWithSelector(
      "Unauthorized: RiskView.getUserRiskAssessment requires VIEW_RISK_DATA",
      async () => rv.connect(unauth).getUserRiskAssessment(unauth.address),
      missingRoleSel
    );
    await mustRevertWithSelector(
      "Unauthorized: BatchView.batchGetRiskAssessments requires VIEW_RISK_DATA",
      async () => batch.connect(unauth).batchGetRiskAssessments([unauth.address]),
      missingRoleSel
    );

    // ====== STRICT MUST: aggregator ↔ dedicated permission behavior matches (user positions) ======
    await mustRevertWithSelector(
      "Unauthorized: PositionView.getUserPositionWithMeta requires VIEW_USER_DATA",
      async () => pv.connect(unauth).getUserPositionWithMeta(unauth.address, CONTRACT_ADDRESSES.MockUSDC),
      missingRoleSel
    );
    await mustRevertWithSelector(
      "Unauthorized: DashboardView.getUserAssetBreakdownWithMeta requires VIEW_USER_DATA (+ VIEW_PRICE_DATA)",
      async () => dashboard.connect(unauth).getUserAssetBreakdownWithMeta(unauth.address, [CONTRACT_ADDRESSES.MockUSDC]),
      missingRoleSel
    );
    await mustRevertWithSelector(
      "Unauthorized: PreviewView.previewDeposit requires VIEW_USER_DATA (or self/admin)",
      async () => {
        const previewAddr = (await registry.getModuleOrRevert(key("PREVIEW_VIEW"))) as string;
        const preview = (await ethers.getContractAt("PreviewView", previewAddr)) as any;
        return preview.connect(unauth).previewDeposit(deployer.address, CONTRACT_ADDRESSES.MockUSDC, 1n);
      },
      missingRoleSel
    );

    // ====== MUST: same data, aggregator result matches dedicated view ======
    const [prices] = (await mustSucceed("VOV.getAssetPrices([USDC])", async () =>
      vov.connect(deployer).getAssetPrices([CONTRACT_ADDRESSES.MockUSDC])
    )) as [bigint[], bigint[]];
    const items = (await mustSucceed("BatchView.batchGetAssetPrices([USDC])", async () =>
      batch.connect(deployer).batchGetAssetPrices([CONTRACT_ADDRESSES.MockUSDC])
    )) as Array<{ asset: string; price: bigint }>;
    assertOk(items.length === 1, "BatchView batchGetAssetPrices length mismatch");
    assertOk(items[0].asset.toLowerCase() === CONTRACT_ADDRESSES.MockUSDC.toLowerCase(), "BatchView asset mismatch");
    assertOk(items[0].price === prices[0], "price mismatch between BatchView and ValuationOracleView");

    // Position meta passthrough consistency: DashboardView meta matches PositionView meta
    const [c1, d1, v1, ts1, ver1] = (await mustSucceed("PositionView.getUserPositionWithMeta", async () =>
      pv.connect(deployer).getUserPositionWithMeta(deployer.address, CONTRACT_ADDRESSES.MockUSDC)
    )) as [bigint, bigint, boolean, bigint, bigint];
    const itemsMeta = (await mustSucceed("DashboardView.getUserAssetBreakdownWithMeta", async () =>
      dashboard.connect(deployer).getUserAssetBreakdownWithMeta(deployer.address, [CONTRACT_ADDRESSES.MockUSDC])
    )) as Array<{
      asset: string;
      collateral: bigint;
      debt: bigint;
      positionIsValid: boolean;
      positionTimestamp: bigint;
      positionVersion: bigint;
      price: bigint;
    }>;
    assertOk(itemsMeta.length === 1, "DashboardView meta breakdown length mismatch");
    assertOk(itemsMeta[0].asset.toLowerCase() === CONTRACT_ADDRESSES.MockUSDC.toLowerCase(), "DashboardView meta asset mismatch");
    assertOk(itemsMeta[0].collateral === c1 && itemsMeta[0].debt === d1, "DashboardView meta collateral/debt mismatch vs PositionView");
    assertOk(itemsMeta[0].positionIsValid === v1, "DashboardView meta isValid mismatch vs PositionView");
    assertOk(itemsMeta[0].positionTimestamp === ts1, "DashboardView meta timestamp mismatch vs PositionView");
    assertOk(itemsMeta[0].positionVersion === ver1, "DashboardView meta version mismatch vs PositionView");
    assertOk(typeof itemsMeta[0].price === "bigint", "DashboardView price must be bigint");

    console.log("\n✅ Batch aggregators acceptance PASSED");
  } finally {
    await revertTo(snap);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

