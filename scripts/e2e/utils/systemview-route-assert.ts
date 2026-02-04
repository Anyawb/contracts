/**
 * SystemView 路由断言工具（e2e 用）
 *
 * 校验 SystemView 各 route* 返回的模块地址与 Registry 中绑定一致，
 * 并校验 routePrice 的 primary/fallback 与 ValuationOracleView/PriceOracle 价格一致性。
 * 供 e2e 脚本（如 systemview-routing、attack-suite）复用。
 */
import { ethers } from "hardhat";

/** 将字符串转为 Registry 使用的 keccak256 模块 key */
function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

/** 断言为真，否则抛错（用于类型收窄） */
function assertOk(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** 路由信息：支持具名 (moduleKey/moduleAddr) 或元组 [0]/[1] 两种 ABI 解码结果 */
type RouteInfoLike = { moduleKey?: string; moduleAddr?: string; 0?: string; 1?: string };
/** 主/备路由：routePrice() 返回 primaryRoute + fallbackRoute */
type RouteHintLike = { primaryRoute?: RouteInfoLike; fallbackRoute?: RouteInfoLike; 0?: RouteInfoLike; 1?: RouteInfoLike };

/** 从 RouteInfoLike 解码出 moduleKey、moduleAddr */
function readRouteInfo(x: RouteInfoLike): { moduleKey: string; moduleAddr: string } {
  const moduleKey = (x.moduleKey ?? x[0]) as string | undefined;
  const moduleAddr = (x.moduleAddr ?? x[1]) as string | undefined;
  assertOk(moduleKey && moduleAddr, "RouteInfo decode failed");
  return { moduleKey, moduleAddr };
}

/** 从 RouteHintLike 解码出 primary、fallback 两条路由 */
function readRouteHint(x: RouteHintLike): { primary: RouteInfoLike; fallback: RouteInfoLike } {
  const primary = (x.primaryRoute ?? x[0]) as RouteInfoLike | undefined;
  const fallback = (x.fallbackRoute ?? x[1]) as RouteInfoLike | undefined;
  assertOk(primary && fallback, "RouteHint decode failed");
  return { primary, fallback };
}

/** 若 who 没有 roleKey，则用 adminSigner 授予（便于本地 e2e 自举） */
async function ensureRole(acm: any, adminSigner: any, roleKey: string, who: string) {
  if (!(await acm.hasRole(roleKey, who))) {
    await acm.connect(adminSigner).grantRole(roleKey, who);
  }
}

/** 断言 routeInfo 的 moduleKey/moduleAddr 与 Registry 中 expectedKeyString 对应模块一致 */
async function assertRouteEqualsRegistry(registry: any, label: string, expectedKeyString: string, routeInfo: RouteInfoLike) {
  const expectedKey = key(expectedKeyString);
  const expectedAddr = (await registry.getModuleOrRevert(expectedKey)) as string;
  const r = readRouteInfo(routeInfo);
  assertOk(r.moduleKey.toLowerCase() === expectedKey.toLowerCase(), `${label}: moduleKey mismatch`);
  assertOk(r.moduleAddr.toLowerCase() === expectedAddr.toLowerCase(), `${label}: moduleAddr mismatch`);
  assertOk(r.moduleAddr !== ethers.ZeroAddress, `${label}: moduleAddr is zero`);
}

/**
 * 校验 SystemView.routePrice 的主/备路由与 Registry 一致，并校验价格回源一致性。
 * Ensure SystemView route addresses align with Registry, and validate PRICE_ORACLE fallback consistency.
 *
 * - Requires caller (adminSigner) can grant roles if missing.
 * - Uses deployer role VIEW_SYSTEM_DATA to call SystemView.route*.
 * - Validates: routePrice.primary == VALUATION_ORACLE_VIEW; routePrice.fallback == PRICE_ORACLE.
 * - Validates: PriceOracle.getPrice(asset) matches ValuationOracleView.getAssetPrice(asset) (price + blockNumber).
 */
export async function assertPriceRoutesAndFallbackConsistency(params: {
  registryAddr: string;
  systemViewAddr: string;
  acmAddr: string;
  adminSigner: any; // deployer
  assetForCheck: string;
}) {
  const { registryAddr, systemViewAddr, acmAddr, adminSigner, assetForCheck } = params;
  const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;
  const systemView = (await ethers.getContractAt("SystemView", systemViewAddr)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", acmAddr)) as any;

  // Ensure VIEW_SYSTEM_DATA so we can call route*.
  await ensureRole(acm, adminSigner, key("VIEW_SYSTEM_DATA"), adminSigner.address);

  const hint = (await systemView.connect(adminSigner).routePrice()) as RouteHintLike;
  const { primary, fallback } = readRouteHint(hint);

  await assertRouteEqualsRegistry(registry, "routePrice.primaryRoute", "VALUATION_ORACLE_VIEW", primary);
  await assertRouteEqualsRegistry(registry, "routePrice.fallbackRoute", "PRICE_ORACLE", fallback);

  const primaryAddr = readRouteInfo(primary).moduleAddr;
  const fallbackAddr = readRouteInfo(fallback).moduleAddr;

  // Ensure VIEW_PRICE_DATA for price read on ValuationOracleView.
  await ensureRole(acm, adminSigner, key("VIEW_PRICE_DATA"), adminSigner.address);

  const vov = (await ethers.getContractAt("ValuationOracleView", primaryAddr)) as any;
  const oracle = (await ethers.getContractAt("PriceOracle", fallbackAddr)) as any;

  // Best-effort consistency: ValuationOracleView wraps oracle calls and returns (0,0,false) on failure.
  const [vp, vBlock] = (await vov.connect(adminSigner).getAssetPrice(assetForCheck)) as [bigint, bigint, boolean];

  let op: bigint = 0n;
  let oBlock: bigint = 0n;
  try {
    const r = (await oracle.getPrice(assetForCheck)) as [bigint, bigint, bigint];
    op = r[0];
    oBlock = r[1];
  } catch {
    // PriceOracle may revert for unsupported asset; treat as (0,0) to match ValuationOracleView's best-effort semantics.
    op = 0n;
    oBlock = 0n;
  }

  assertOk(vp === op, "PRICE_ORACLE fallback inconsistency: price mismatch between ValuationOracleView and PriceOracle");
  assertOk(vBlock === oBlock, "PRICE_ORACLE fallback inconsistency: blockNumber mismatch between ValuationOracleView and PriceOracle");
}

/**
 * Assert a specific SystemView.routeX equals Registry for the expected module key string.
 * Example: routePosition -> POSITION_VIEW, routeUser -> USER_VIEW, etc.
 */
export async function assertSystemViewRoute(params: {
  registryAddr: string;
  systemViewAddr: string;
  acmAddr: string;
  adminSigner: any;
  routeFn:
    | "routeStatistics"
    | "routeReward"
    | "routeLiquidation"
    | "routeRisk"
    | "routeUser"
    | "routePosition"
    | "routeBatch"
    | "routeDashboard"
    | "routePreview";
  expectedKeyString: string;
}) {
  const { registryAddr, systemViewAddr, acmAddr, adminSigner, routeFn, expectedKeyString } = params;
  const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;
  const systemView = (await ethers.getContractAt("SystemView", systemViewAddr)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", acmAddr)) as any;

  await ensureRole(acm, adminSigner, key("VIEW_SYSTEM_DATA"), adminSigner.address);

  const routeInfo = (await systemView.connect(adminSigner)[routeFn]()) as RouteInfoLike;
  await assertRouteEqualsRegistry(registry, routeFn, expectedKeyString, routeInfo);
}

/**
 * 断言 SystemView.viewCacheAddrVar() 与 Registry 中 VIEW_CACHE 模块地址一致。
 */
export async function assertViewCacheAddrAligned(params: {
  registryAddr: string;
  systemViewAddr: string;
  acmAddr: string;
  adminSigner: any;
}) {
  const { registryAddr, systemViewAddr, acmAddr, adminSigner } = params;
  const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;
  const systemView = (await ethers.getContractAt("SystemView", systemViewAddr)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", acmAddr)) as any;

  await ensureRole(acm, adminSigner, key("VIEW_SYSTEM_DATA"), adminSigner.address);
  const expected = (await registry.getModuleOrRevert(key("VIEW_CACHE"))) as string;
  const got = (await systemView.connect(adminSigner).viewCacheAddrVar()) as string;
  assertOk(got.toLowerCase() === expected.toLowerCase(), "SystemView.viewCacheAddrVar mismatch with Registry VIEW_CACHE");
}

/**
 * 断言 SystemView.getModuleOptional(key) 与 Registry.getModuleOrRevert(key) 一致。
 * 用于没有单独 route* 方法的模块。
 * Assert SystemView.getModuleOptional(key) aligns with Registry.getModuleOrRevert(key).
 */
export async function assertSystemViewGetModuleOptionalAligned(params: {
  registryAddr: string;
  systemViewAddr: string;
  acmAddr: string;
  adminSigner: any;
  moduleKeyString: string;
}) {
  const { registryAddr, systemViewAddr, acmAddr, adminSigner, moduleKeyString } = params;
  const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;
  const systemView = (await ethers.getContractAt("SystemView", systemViewAddr)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", acmAddr)) as any;

  await ensureRole(acm, adminSigner, key("VIEW_SYSTEM_DATA"), adminSigner.address);

  const k = key(moduleKeyString);
  const expected = (await registry.getModuleOrRevert(k)) as string;
  const got = (await systemView.connect(adminSigner).getModuleOptional(k)) as string;
  assertOk(got.toLowerCase() === expected.toLowerCase(), `SystemView.getModuleOptional mismatch for ${moduleKeyString}`);
}

