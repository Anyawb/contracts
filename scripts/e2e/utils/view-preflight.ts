import { ethers } from "hardhat";

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function assertOk(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

type RouteInfoLike = { moduleKey?: string; moduleAddr?: string; 0?: string; 1?: string };
type RouteHintLike = { primaryRoute?: RouteInfoLike; fallbackRoute?: RouteInfoLike; 0?: RouteInfoLike; 1?: RouteInfoLike };

function readRouteInfo(x: RouteInfoLike): { moduleKey: string; moduleAddr: string } {
  const moduleKey = (x.moduleKey ?? x[0]) as string | undefined;
  const moduleAddr = (x.moduleAddr ?? x[1]) as string | undefined;
  assertOk(moduleKey && moduleAddr, "RouteInfo decode failed");
  return { moduleKey, moduleAddr };
}

function readRouteHint(x: RouteHintLike): { primary: RouteInfoLike; fallback: RouteInfoLike } {
  const primary = (x.primaryRoute ?? x[0]) as RouteInfoLike | undefined;
  const fallback = (x.fallbackRoute ?? x[1]) as RouteInfoLike | undefined;
  assertOk(primary && fallback, "RouteHint decode failed");
  return { primary, fallback };
}

async function tryGetVersionInfo(addr: string): Promise<{ api?: bigint; schema?: bigint; impl?: string }> {
  const c = await ethers.getContractAt("ViewVersioned", addr);
  try {
    const [api, schema, impl] = (await (c as any).getVersionInfo()) as [bigint, bigint, string];
    return { api, schema, impl };
  } catch {
    return {};
  }
}

async function tryGetPriceOraclePrice(oracleAddr: string, asset: string): Promise<{ price: bigint; ts: bigint }> {
  const oracle = await ethers.getContractAt("PriceOracle", oracleAddr);
  try {
    const [p, ts] = (await (oracle as any).getPrice(asset)) as [bigint, bigint, bigint];
    return { price: p, ts };
  } catch {
    // Unsupported asset may revert; treat as best-effort (0,0)
    return { price: 0n, ts: 0n };
  }
}

export async function runViewPreflight(params: {
  registryAddr: string;
  acmAddr: string;
  adminSigner: any;
  assetForPriceCheck: string;
  print?: boolean;
}) {
  const { registryAddr, acmAddr, adminSigner, assetForPriceCheck } = params;
  const print = params.print ?? true;

  const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", acmAddr)) as any;

  // Roles required to call SystemView.route* and ValuationOracleView.getAssetPrice
  const ROLE_VIEW_SYSTEM_DATA = key("VIEW_SYSTEM_DATA");
  const ROLE_VIEW_PRICE_DATA = key("VIEW_PRICE_DATA");
  const ROLE_VIEW_RISK_DATA = key("VIEW_RISK_DATA");
  const ROLE_VIEW_USER_DATA = key("VIEW_USER_DATA");

  assertOk(await acm.hasRole(ROLE_VIEW_SYSTEM_DATA, adminSigner.address), "preflight: missing VIEW_SYSTEM_DATA role");
  assertOk(await acm.hasRole(ROLE_VIEW_PRICE_DATA, adminSigner.address), "preflight: missing VIEW_PRICE_DATA role");
  assertOk(await acm.hasRole(ROLE_VIEW_RISK_DATA, adminSigner.address), "preflight: missing VIEW_RISK_DATA role");
  assertOk(await acm.hasRole(ROLE_VIEW_USER_DATA, adminSigner.address), "preflight: missing VIEW_USER_DATA role");

  const systemViewAddr = (await registry.getModuleOrRevert(key("SYSTEM_VIEW"))) as string;
  const systemView = (await ethers.getContractAt("SystemView", systemViewAddr)) as any;

  if (print) {
    console.log("=== View Preflight (SystemView routes ↔ Registry + VersionInfo) ===");
    console.log("  Registry:", registryAddr);
    console.log("  SystemView:", systemViewAddr);
  }

  // Route table: routeFn -> expected key string (Registry key)
  const routes: Array<{ fn: string; expected: string }> = [
    { fn: "routeStatistics", expected: "VAULT_STATISTICS" },
    { fn: "routeReward", expected: "REWARD_VIEW" },
    { fn: "routeLiquidation", expected: "LIQUIDATION_VIEW" },
    { fn: "routeRisk", expected: "RISK_VIEW" },
    { fn: "routeUser", expected: "USER_VIEW" },
    { fn: "routePosition", expected: "POSITION_VIEW" },
    { fn: "routeBatch", expected: "BATCH_VIEW" },
    { fn: "routeDashboard", expected: "DASHBOARD_VIEW" },
    { fn: "routePreview", expected: "PREVIEW_VIEW" },
  ];

  // Print/verify each route
  for (const r of routes) {
    const routeInfo = (await systemView.connect(adminSigner)[r.fn]()) as RouteInfoLike;
    const decoded = readRouteInfo(routeInfo);
    const expectedKey = key(r.expected);
    const expectedAddr = (await registry.getModuleOrRevert(expectedKey)) as string;
    assertOk(decoded.moduleKey.toLowerCase() === expectedKey.toLowerCase(), `preflight: ${r.fn} moduleKey mismatch`);
    assertOk(decoded.moduleAddr.toLowerCase() === expectedAddr.toLowerCase(), `preflight: ${r.fn} moduleAddr mismatch`);
    if (print) {
      const vi = await tryGetVersionInfo(decoded.moduleAddr);
      const ver = vi.api !== undefined ? `api=${vi.api} schema=${vi.schema} impl=${vi.impl}` : "versionInfo=n/a";
      console.log(`  [route] ${r.fn} -> ${r.expected} @ ${decoded.moduleAddr} (${ver})`);
    }
  }

  // routePrice: primary (ValuationOracleView) + fallback (PriceOracle)
  const hint = (await systemView.connect(adminSigner).routePrice()) as RouteHintLike;
  const { primary, fallback } = readRouteHint(hint);
  const primaryInfo = readRouteInfo(primary);
  const fallbackInfo = readRouteInfo(fallback);

  // Align with Registry
  const expectedPrimaryKey = key("VALUATION_ORACLE_VIEW");
  const expectedPrimaryAddr = (await registry.getModuleOrRevert(expectedPrimaryKey)) as string;
  assertOk(primaryInfo.moduleKey.toLowerCase() === expectedPrimaryKey.toLowerCase(), "preflight: routePrice.primary moduleKey mismatch");
  assertOk(primaryInfo.moduleAddr.toLowerCase() === expectedPrimaryAddr.toLowerCase(), "preflight: routePrice.primary moduleAddr mismatch");

  const expectedFallbackKey = key("PRICE_ORACLE");
  const expectedFallbackAddr = (await registry.getModuleOrRevert(expectedFallbackKey)) as string;
  assertOk(fallbackInfo.moduleKey.toLowerCase() === expectedFallbackKey.toLowerCase(), "preflight: routePrice.fallback moduleKey mismatch");
  assertOk(fallbackInfo.moduleAddr.toLowerCase() === expectedFallbackAddr.toLowerCase(), "preflight: routePrice.fallback moduleAddr mismatch");

  // Fallback consistency (best-effort): ValuationOracleView wraps oracle calls and returns (0,0) on failure.
  const vov = (await ethers.getContractAt("ValuationOracleView", primaryInfo.moduleAddr)) as any;
  const [vp, vts] = (await vov.connect(adminSigner).getAssetPrice(assetForPriceCheck)) as [bigint, bigint];
  const o = await tryGetPriceOraclePrice(fallbackInfo.moduleAddr, assetForPriceCheck);
  assertOk(vp === o.price, "preflight: PRICE_ORACLE fallback inconsistency (price mismatch)");
  assertOk(vts === o.ts, "preflight: PRICE_ORACLE fallback inconsistency (timestamp mismatch)");

  if (print) {
    const viP = await tryGetVersionInfo(primaryInfo.moduleAddr);
    const verP = viP.api !== undefined ? `api=${viP.api} schema=${viP.schema} impl=${viP.impl}` : "versionInfo=n/a";
    console.log(`  [route] routePrice.primary -> VALUATION_ORACLE_VIEW @ ${primaryInfo.moduleAddr} (${verP})`);
    console.log(`  [route] routePrice.fallback -> PRICE_ORACLE @ ${fallbackInfo.moduleAddr} (versionInfo=n/a)`);
    console.log(`  [check] price fallback asset=${assetForPriceCheck} price=${vp.toString()} ts=${vts.toString()}`);
    console.log("=== View Preflight done ===\n");
  }

  return { systemViewAddr, valuationOracleViewAddr: primaryInfo.moduleAddr, priceOracleAddr: fallbackInfo.moduleAddr };
}

