import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost.ts";
import { runViewPreflight } from "./utils/view-preflight.ts";

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function assertOk(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

type RouteInfoLike = {
  moduleKey?: string;
  moduleAddr?: string;
  0?: string;
  1?: string;
};

function readRouteInfo(x: RouteInfoLike): { moduleKey: string; moduleAddr: string } {
  const moduleKey = (x.moduleKey ?? x[0]) as string | undefined;
  const moduleAddr = (x.moduleAddr ?? x[1]) as string | undefined;
  assertOk(moduleKey && moduleAddr, "RouteInfo decode failed");
  return { moduleKey, moduleAddr };
}

function fmtErr(e: any) {
  return e?.shortMessage ?? e?.message ?? String(e);
}

function isMissingSelectorError(msg: string): boolean {
  return String(msg).includes("function selector was not recognized");
}

async function mustRevertMissingRole(label: string, fn: () => Promise<unknown>) {
  const missingRoleSel = ethers.id("MissingRole()").slice(0, 10); // 4-byte selector
  try {
    await fn();
  } catch (e: any) {
    const msg = fmtErr(e);
    if (isMissingSelectorError(msg)) {
      throw new Error(
        `[FAIL] ${label}: missing function selector on-chain (deployment/ABI mismatch). Re-run compile + deploy:localhost.`
      );
    }
    const hay = `${msg} ${e?.data ?? ""} ${e?.info?.error?.data ?? ""}`;
    assertOk(
      hay.includes("MissingRole") || hay.toLowerCase().includes(missingRoleSel.toLowerCase()),
      `[FAIL] ${label}: expected MissingRole(), got: ${hay}`
    );
    console.log(`  ✅ [revert MissingRole as expected] ${label}`);
    return;
  }
  throw new Error(`[FAIL] Expected MissingRole() revert, but succeeded: ${label}`);
}

async function mustSucceed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    const msg = e?.shortMessage ?? e?.message ?? String(e);
    if (String(msg).includes("function selector was not recognized")) {
      throw new Error(
        `${label}: missing function selector on-chain (likely you need to re-run compile + deploy:localhost with current contracts).`
      );
    }
    throw e;
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("=== E2E SystemView Routing Acceptance ===\n");

  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;

  await runViewPreflight({
    registryAddr: CONTRACT_ADDRESSES.Registry,
    acmAddr: CONTRACT_ADDRESSES.AccessControlManager,
    adminSigner: deployer,
    assetForPriceCheck: CONTRACT_ADDRESSES.MockUSDC,
  });

  // Resolve SystemView via Registry (SSOT), not via contracts-localhost.ts.
  const systemViewKey = key("SYSTEM_VIEW");
  const systemViewAddr = (await registry.getModuleOrRevert(systemViewKey)) as string;
  const systemView = (await ethers.getContractAt("SystemView", systemViewAddr)) as any;

  console.log("  Registry:", CONTRACT_ADDRESSES.Registry);
  console.log("  SystemView:", systemViewAddr);

  // ====== Permission: VIEW_SYSTEM_DATA ======
  // NOTE: Do not mutate roles in acceptance scripts; deploy script must have granted these already.
  const ACTION_VIEW_SYSTEM_DATA = key("VIEW_SYSTEM_DATA");
  assertOk(await acm.hasRole(ACTION_VIEW_SYSTEM_DATA, deployer.address), "missing VIEW_SYSTEM_DATA for deployer/admin");
  const unauthorized = ethers.Wallet.createRandom().connect(ethers.provider);
  assertOk(!(await acm.hasRole(ACTION_VIEW_SYSTEM_DATA, unauthorized.address)), "unexpected VIEW_SYSTEM_DATA for unauthorized");

  // ====== Basic metadata: MUST be consumable for next-hop ======
  assertOk((await systemView.registryAddr()) === CONTRACT_ADDRESSES.Registry, "SystemView.registryAddr mismatch");

  const [apiV, schemaV, impl] = (await systemView.getVersionInfo()) as [bigint, bigint, string];
  console.log(`  VersionInfo: api=${apiV} schema=${schemaV} impl=${impl}`);
  assertOk(apiV > 0n && schemaV > 0n, "SystemView VersionInfo invalid");

  // ====== MUST: system-level read uses unified role gating ======
  // First ensure these functions exist and work for an authorized caller.
  await mustSucceed("Authorized: getModuleOptional", async () => systemView.connect(deployer).getModuleOptional(systemViewKey));
  await mustSucceed("Authorized: routeStatistics", async () => systemView.connect(deployer).routeStatistics());

  // Then ensure they revert MissingRole() for callers missing VIEW_SYSTEM_DATA (no revert-string dependency).
  await mustRevertMissingRole("Unauthorized: getModuleOptional", async () =>
    systemView.connect(unauthorized).getModuleOptional(systemViewKey)
  );
  await mustRevertMissingRole("Unauthorized: routeStatistics", async () =>
    systemView.connect(unauthorized).routeStatistics()
  );

  // ====== MUST: route hints must be available WITHOUT relying on revert strings ======
  // For each capability route, assert:
  // - returned moduleKey matches expected Registry key (keccak256 of UPPER_SNAKE_CASE string)
  // - returned moduleAddr equals Registry resolution
  // - returned moduleAddr != 0 (for localhost acceptance)
  async function assertRouteInfo(label: string, expectedKeyString: string, routeInfo: RouteInfoLike) {
    const expectedKey = key(expectedKeyString);
    const expectedAddr = (await registry.getModuleOrRevert(expectedKey)) as string;
    const r = readRouteInfo(routeInfo);
    assertOk(r.moduleKey.toLowerCase() === expectedKey.toLowerCase(), `${label}: moduleKey mismatch`);
    assertOk(r.moduleAddr.toLowerCase() === expectedAddr.toLowerCase(), `${label}: moduleAddr mismatch`);
    assertOk(r.moduleAddr !== ethers.ZeroAddress, `${label}: moduleAddr is zero`);
    console.log(`  ✅ ${label}: ${expectedKeyString} @ ${r.moduleAddr}`);
  }

  // Price: primary ValuationOracleView, fallback PriceOracle.
  const priceHint = await mustSucceed("routePrice", async () => systemView.routePrice());
  const primary = (priceHint.primaryRoute ?? priceHint[0]) as RouteInfoLike;
  const fallback = (priceHint.fallbackRoute ?? priceHint[1]) as RouteInfoLike;
  await assertRouteInfo("routePrice.primaryRoute", "VALUATION_ORACLE_VIEW", primary);
  await assertRouteInfo("routePrice.fallbackRoute", "PRICE_ORACLE", fallback);

  await assertRouteInfo("routeStatistics", "VAULT_STATISTICS", await systemView.routeStatistics());
  await assertRouteInfo("routeReward", "REWARD_VIEW", await systemView.routeReward());
  await assertRouteInfo("routeLiquidation", "LIQUIDATION_VIEW", await systemView.routeLiquidation());
  await assertRouteInfo("routeRisk", "RISK_VIEW", await systemView.routeRisk());
  await assertRouteInfo("routeSystemRisk", "SYSTEM_RISK_VIEW", await systemView.routeSystemRisk());
  await assertRouteInfo("routeUser", "USER_VIEW", await systemView.routeUser());
  await assertRouteInfo("routePosition", "POSITION_VIEW", await systemView.routePosition());
  await assertRouteInfo("routeBatch", "BATCH_VIEW", await systemView.routeBatch());
  await assertRouteInfo("routeDashboard", "DASHBOARD_VIEW", await systemView.routeDashboard());
  await assertRouteInfo("routePreview", "PREVIEW_VIEW", await systemView.routePreview());

  console.log("\n✅ SystemView routing acceptance PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

