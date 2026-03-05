/**
 * View 预检脚本（e2e 用）
 *
 * 在跑 View 相关 e2e 前执行：校验 admin 具备 VIEW_SYSTEM_DATA/VIEW_PRICE_DATA/VIEW_RISK_DATA/VIEW_USER_DATA，
 * 可选为链上“写 View 缓存”的模块（VaultLendingEngine、VaultRouter 等）授予 ACTION_VIEW_PUSH 与 VIEW_RISK_DATA，
 * 校验 SystemView 各 route* 与 Registry 一致、routePrice 主/备与价格回源一致，并打印各 View 的 VersionInfo。
 */
import hardhat from "hardhat";

const { ethers } = hardhat;

/** 将字符串转为 Registry 使用的 keccak256 模块 key */
function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

/** 断言为真，否则抛错 */
function assertOk(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** 路由信息：支持具名或元组 ABI 解码结果 */
type RouteInfoLike = { moduleKey?: string; moduleAddr?: string; 0?: string; 1?: string };
/** 主/备路由（routePrice 返回结构） */
type RouteHintLike = { primaryRoute?: RouteInfoLike; fallbackRoute?: RouteInfoLike; 0?: RouteInfoLike; 1?: RouteInfoLike };

/** 从 RouteInfoLike 解码 moduleKey、moduleAddr */
function readRouteInfo(x: RouteInfoLike): { moduleKey: string; moduleAddr: string } {
  const moduleKey = (x.moduleKey ?? x[0]) as string | undefined;
  const moduleAddr = (x.moduleAddr ?? x[1]) as string | undefined;
  assertOk(moduleKey && moduleAddr, "RouteInfo decode failed");
  return { moduleKey, moduleAddr };
}

/** 从 RouteHintLike 解码 primary、fallback */
function readRouteHint(x: RouteHintLike): { primary: RouteInfoLike; fallback: RouteInfoLike } {
  const primary = (x.primaryRoute ?? x[0]) as RouteInfoLike | undefined;
  const fallback = (x.fallbackRoute ?? x[1]) as RouteInfoLike | undefined;
  assertOk(primary && fallback, "RouteHint decode failed");
  return { primary, fallback };
}

/** 尝试读取 View 合约的 getVersionInfo()，失败返回空对象 */
async function tryGetVersionInfo(addr: string): Promise<{ api?: bigint; schema?: bigint; impl?: string }> {
  const c = await ethers.getContractAt("ViewVersioned", addr);
  try {
    const [api, schema, impl] = (await (c as any).getVersionInfo()) as [bigint, bigint, string];
    return { api, schema, impl };
  } catch {
    return {};
  }
}

/** 尝试读取 PriceOracle.getPrice(asset)，不支持则返回 (0,0) */
async function tryGetPriceOraclePrice(oracleAddr: string, asset: string): Promise<{ price: bigint; blockNumber: bigint }> {
  const oracle = await ethers.getContractAt("PriceOracle", oracleAddr);
  try {
    const [p, blockNumber] = (await (oracle as any).getPrice(asset)) as [bigint, bigint, bigint];
    return { price: p, blockNumber };
  } catch {
    // Unsupported asset may revert; treat as best-effort (0,0)
    return { price: 0n, blockNumber: 0n };
  }
}

/**
 * 执行 View 预检：角色校验、可选授 ACTION_VIEW_PUSH/VIEW_RISK_DATA、SystemView 路由表与 routePrice 主/备一致性、VersionInfo 打印。
 */
export async function runViewPreflight(params: {
  registryAddr: string;
  acmAddr: string;
  adminSigner: any;
  assetForPriceCheck: string;
  print?: boolean;
  /**
   * Ensure core on-chain writers have ACTION_VIEW_PUSH.
   * This eliminates best-effort CacheUpdateFailed/HealthPushFailed caused by MissingRole().
   */
  ensureViewPushRole?: boolean;
  /** Extra addresses (EOA/contract) that must have ACTION_VIEW_PUSH. */
  extraViewPushers?: string[];
  /**
   * Ensure health-push dependencies do not revert due to MissingRole().
   * In particular, LendingEngineCore reads PositionView valuations (risk-gated).
   */
  ensureHealthPushDeps?: boolean;
}) {
  const { registryAddr, acmAddr, adminSigner, assetForPriceCheck } = params;
  const print = params.print ?? true;
  const ensureViewPushRole = params.ensureViewPushRole ?? true;
  const extraViewPushers = params.extraViewPushers ?? [];
  const ensureHealthPushDeps = params.ensureHealthPushDeps ?? true;

  const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", acmAddr)) as any;

  // Roles required to call SystemView.route* and ValuationOracleView.getAssetPrice
  const ROLE_VIEW_SYSTEM_DATA = key("VIEW_SYSTEM_DATA");
  const ROLE_VIEW_PRICE_DATA = key("VIEW_PRICE_DATA");
  const ROLE_VIEW_RISK_DATA = key("VIEW_RISK_DATA");
  const ROLE_VIEW_USER_DATA = key("VIEW_USER_DATA");
  const ROLE_VIEW_PUSH = key("ACTION_VIEW_PUSH");

  assertOk(await acm.hasRole(ROLE_VIEW_SYSTEM_DATA, adminSigner.address), "preflight: missing VIEW_SYSTEM_DATA role");
  assertOk(await acm.hasRole(ROLE_VIEW_PRICE_DATA, adminSigner.address), "preflight: missing VIEW_PRICE_DATA role");
  assertOk(await acm.hasRole(ROLE_VIEW_RISK_DATA, adminSigner.address), "preflight: missing VIEW_RISK_DATA role");
  assertOk(await acm.hasRole(ROLE_VIEW_USER_DATA, adminSigner.address), "preflight: missing VIEW_USER_DATA role");

  if (ensureViewPushRole) {
    // Core pushers that perform best-effort view cache updates during ledger operations.
    // NOTE: use getModule (not OrRevert) so the preflight remains usable across deployments.
    const pusherKeys = ["VAULT_LENDING_ENGINE", "VAULT_ROUTER", "VAULT_CORE", "LIQUIDATION_MANAGER", "SETTLEMENT_MANAGER"];
    const pushers: string[] = [];
    for (const k of pusherKeys) {
      try {
        const addr = (await registry.getModule(key(k))) as string;
        if (addr && addr !== ethers.ZeroAddress) pushers.push(addr);
      } catch {
        // ignore (older deployments may not register this key)
      }
    }
    for (const addr of extraViewPushers) {
      if (addr && addr !== ethers.ZeroAddress) pushers.push(addr);
    }

    const isRoleAlreadyGranted = (err: any) => {
      const msg = String(err?.message ?? err ?? "");
      return msg.includes("RoleAlreadyGranted") || msg.includes("AccessControlManager__RoleAlreadyGranted");
    };

    for (const pusher of pushers) {
      const ok = (await acm.hasRole(ROLE_VIEW_PUSH, pusher)) as boolean;
      if (!ok) {
        // grantRole is owner-gated; on localhost the deployer should be the owner.
        try {
          await (await acm.connect(adminSigner).grantRole(ROLE_VIEW_PUSH, pusher)).wait();
          if (print) console.log(`  [preflight] granted ACTION_VIEW_PUSH to ${pusher}`);
        } catch (e: any) {
          if (isRoleAlreadyGranted(e)) {
            if (print) console.log(`  [preflight] ACTION_VIEW_PUSH already granted to ${pusher}`);
          } else {
          throw new Error(
            `preflight: missing ACTION_VIEW_PUSH for ${pusher} and failed to grantRole (are you ACM owner?): ${e?.message ?? String(e)}`
          );
          }
        }
      }

      // Health push dependency: LendingEngineCore reads risk-gated valuation data from PositionView.
      // If the caller (e.g., VaultLendingEngine) lacks VIEW_RISK_DATA, the read reverts MissingRole()
      // and LendingEngineCore emits CacheUpdateFailed/HealthPushFailed. For strict localhost e2e,
      // ensure the pusher has VIEW_RISK_DATA.
      if (ensureHealthPushDeps) {
        const hasRisk = (await acm.hasRole(ROLE_VIEW_RISK_DATA, pusher)) as boolean;
        if (!hasRisk) {
          try {
            await (await acm.connect(adminSigner).grantRole(ROLE_VIEW_RISK_DATA, pusher)).wait();
            if (print) console.log(`  [preflight] granted VIEW_RISK_DATA to ${pusher}`);
          } catch (e: any) {
            if (isRoleAlreadyGranted(e)) {
              if (print) console.log(`  [preflight] VIEW_RISK_DATA already granted to ${pusher}`);
            } else {
            throw new Error(
              `preflight: missing VIEW_RISK_DATA for ${pusher} and failed to grantRole (are you ACM owner?): ${e?.message ?? String(e)}`
            );
            }
          }
        }
      }
    }
  }

  // 解析 SystemView 地址并绑定合约
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
    { fn: "routeSystemRisk", expected: "SYSTEM_RISK_VIEW" },
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

  // Fallback consistency (best-effort): ValuationOracleView wraps oracle calls and returns (0,0,false) on failure.
  const vov = (await ethers.getContractAt("ValuationOracleView", primaryInfo.moduleAddr)) as any;
  const [vp, vBlock] = (await vov.connect(adminSigner).getAssetPrice(assetForPriceCheck)) as [
    bigint,
    bigint,
    boolean,
  ];
  const o = await tryGetPriceOraclePrice(fallbackInfo.moduleAddr, assetForPriceCheck);
  assertOk(vp === o.price, "preflight: PRICE_ORACLE fallback inconsistency (price mismatch)");
  assertOk(vBlock === o.blockNumber, "preflight: PRICE_ORACLE fallback inconsistency (blockNumber mismatch)");

  if (print) {
    const viP = await tryGetVersionInfo(primaryInfo.moduleAddr);
    const verP = viP.api !== undefined ? `api=${viP.api} schema=${viP.schema} impl=${viP.impl}` : "versionInfo=n/a";
    console.log(`  [route] routePrice.primary -> VALUATION_ORACLE_VIEW @ ${primaryInfo.moduleAddr} (${verP})`);
    console.log(`  [route] routePrice.fallback -> PRICE_ORACLE @ ${fallbackInfo.moduleAddr} (versionInfo=n/a)`);
    console.log(`  [check] price fallback asset=${assetForPriceCheck} price=${vp.toString()} block=${vBlock.toString()}`);
    console.log("=== View Preflight done ===\n");
  }

  return {
    systemViewAddr,
    valuationOracleViewAddr: primaryInfo.moduleAddr,
    priceOracleAddr: fallbackInfo.moduleAddr,
  };
}

