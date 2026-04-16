/**
 * View 模块扫描脚本（e2e 用）
 *
 * 从 Registry 解析所有 View 相关模块地址，逐合约调用 getVersionInfo() 校验 api/schema 与预期一致，
 * 可选做轻量健全性调用（如 HealthView.getUserHealthFactorWithMeta、ViewCache.getSystemStatus）。
 * 供 e2e（如 attack-suite 收尾的 ViewScan）复用；strict 模式下任一失败即抛错。
 */
import hardhat from "hardhat";

const { ethers } = hardhat;

/** View 合约 getVersionInfo() 返回结构 */
type VersionInfo = {
  apiVersion: bigint;
  schemaVersion: bigint;
  implementation: string;
};

/** 扫描时的可选参数：资产地址/样本用户用于健全性调用，strict 控制失败是否抛错 */
export type ViewScanOptions = {
  assetAddr?: string;
  sampleUser?: string;
  strict?: boolean;
};

/** 将字符串转为 Registry 的 keccak256 模块 key */
function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

/** 从环境变量解析布尔值，支持 1/0、true/false、yes/no、y/n */
function envBool(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "y") return true;
  if (v === "0" || v === "false" || v === "no" || v === "n") return false;
  return defaultValue;
}

/** 执行异步调用，失败时打印 label；strict 为 true 时重新抛出，否则返回 undefined */
async function safeCall<T>(label: string, fn: () => Promise<T>, strict: boolean): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e: any) {
    const msg = e?.shortMessage ?? e?.message ?? String(e);
    console.log(`  ⚠️ [ViewScan] ${label} failed: ${msg}`);
    if (strict) throw e;
    return undefined;
  }
}

/** 从 View 合约读取 getVersionInfo() 并转为 VersionInfo */
async function getVersionInfo(view: any): Promise<VersionInfo> {
  const [apiVersion, schemaVersion, implementation] = (await view.getVersionInfo()) as [bigint, bigint, string];
  return { apiVersion, schemaVersion, implementation };
}

/**
 * 按 Registry 中绑定的 View 模块 key 解析地址，校验 VersionInfo（api/schema），可选执行健全性调用。
 * strict 可由 opts.strict 或环境变量 E2E_VIEW_STRICT 控制。
 */
export async function scanViewModules(registryAddr: string, opts?: ViewScanOptions) {
  const strict = opts?.strict ?? envBool("E2E_VIEW_STRICT", envBool("E2E_STRICT_VIEWS", true));
  const registry = await ethers.getContractAt("Registry", registryAddr);

  console.log("=== ViewScan (Registry-driven) ===");
  console.log(`  strict=${strict}`);

  // deploylocal 部署的 View 模块列表，key 与 Registry 中绑定一致（UPPER_SNAKE_CASE）
  const modules: Array<{
    key: string;
    name: string;
    expectedApi?: bigint;
    expectedSchema: bigint;
    sanityCalls?: Array<(addr: string) => Promise<void>>;
  }> = [
    { key: "HEALTH_VIEW", name: "HealthView", expectedApi: 1n, expectedSchema: 1n },
    { key: "SYSTEM_VIEW", name: "SystemView", expectedApi: 1n, expectedSchema: 1n },
    { key: "REGISTRY_VIEW", name: "RegistryView", expectedApi: 1n, expectedSchema: 1n },
    // Canonical Registry key for StatisticsView (ModuleKeys.KEY_STATS)
    { key: "VAULT_STATISTICS", name: "StatisticsView", expectedApi: 1n, expectedSchema: 1n },
    { key: "POSITION_VIEW", name: "PositionView", expectedApi: 1n, expectedSchema: 2n },
    { key: "PREVIEW_VIEW", name: "PreviewView", expectedApi: 1n, expectedSchema: 1n },
    // DashboardView schema bumped to 2 after view-alignment / Scheme U updates.
    { key: "DASHBOARD_VIEW", name: "DashboardView", expectedApi: 1n, expectedSchema: 2n },
    { key: "USER_VIEW", name: "UserView", expectedApi: 1n, expectedSchema: 1n },
    { key: "ACCESS_CONTROL_VIEW", name: "AccessControlView", expectedApi: 1n, expectedSchema: 1n },
    // CacheOptimizedView schema bumped to 2 after view-alignment / Scheme U updates.
    { key: "CACHE_OPTIMIZED_VIEW", name: "CacheOptimizedView", expectedApi: 1n, expectedSchema: 2n },
    // LendingEngineView apiVersion bumped to 2 after view surface extension.
    { key: "LENDING_ENGINE_VIEW", name: "LendingEngineView", expectedApi: 2n, expectedSchema: 1n },
    { key: "FEE_ROUTER_VIEW", name: "FeeRouterView", expectedApi: 1n, expectedSchema: 1n },
    { key: "RISK_VIEW", name: "RiskView", expectedApi: 1n, expectedSchema: 1n },
    { key: "SYSTEM_RISK_VIEW", name: "SystemRiskView", expectedApi: 1n, expectedSchema: 1n },
    { key: "VIEW_CACHE", name: "ViewCache", expectedApi: 1n, expectedSchema: 1n },
    { key: "EVENT_HISTORY_MANAGER", name: "EventHistoryManager", expectedApi: 1n, expectedSchema: 1n },
    { key: "VALUATION_ORACLE_VIEW", name: "ValuationOracleView", expectedApi: 1n, expectedSchema: 1n },
    // ModuleHealthView bumped apiVersion to 2 after expanding module health surface.
    { key: "MODULE_HEALTH_VIEW", name: "ModuleHealthView", expectedApi: 2n, expectedSchema: 1n },
    { key: "BATCH_VIEW", name: "BatchView", expectedApi: 1n, expectedSchema: 1n },
    { key: "LIQUIDATION_VIEW", name: "LiquidatorView", expectedApi: 1n, expectedSchema: 1n },
    { key: "LIQUIDATION_RISK_VIEW", name: "LiquidationRiskView", expectedApi: 1n, expectedSchema: 1n },
    // RewardView bumped to api=3/schema=2 after removing legacy totalEarned from the public summary ABI
    // and splitting earn-side state into a dedicated getter.
    { key: "REWARD_VIEW", name: "RewardView", expectedApi: 3n, expectedSchema: 2n },
  ];

  // 第一步：从 Registry 解析所有模块地址（解析失败在 strict 下会抛错）
  const resolved: Array<{ key: string; name: string; addr: string; expectedApi: bigint; expectedSchema: bigint }> = [];
  for (const m of modules) {
    const addr = await safeCall(
      `resolve ${m.key}`,
      async () => (await registry.getModuleOrRevert(key(m.key))) as string,
      strict
    );
    if (!addr) continue;
    resolved.push({ key: m.key, name: m.name, addr, expectedApi: m.expectedApi ?? 1n, expectedSchema: m.expectedSchema });
  }

  // 第二步：逐模块调用 getVersionInfo，校验 api/schema 与预期一致
  for (const r of resolved) {
    const view = await ethers.getContractAt(r.name, r.addr);
    const vi = await safeCall(`getVersionInfo ${r.key}`, async () => getVersionInfo(view), strict);
    if (!vi) continue;
    console.log(
      `  [VersionInfo] ${r.key}(${r.name}) @ ${r.addr}: api=${vi.apiVersion} schema=${vi.schemaVersion} implementation=${vi.implementation}`
    );
    if (vi.apiVersion !== r.expectedApi) {
      const msg = `[ViewScan] ${r.key}: apiVersion expected ${r.expectedApi} got ${vi.apiVersion}`;
      if (strict) throw new Error(msg);
      console.log(`  ⚠️ ${msg}`);
    }
    if (vi.schemaVersion !== r.expectedSchema) {
      const msg = `[ViewScan] ${r.key}: schemaVersion expected ${r.expectedSchema} got ${vi.schemaVersion}`;
      if (strict) throw new Error(msg);
      console.log(`  ⚠️ ${msg}`);
    }
  }

  // 第三步（可选）：轻量健全性调用，strict 下失败会抛错
  const assetAddr = opts?.assetAddr;
  const sampleUser = opts?.sampleUser;
  if (sampleUser) {
    const hvAddr = resolved.find((x) => x.key === "HEALTH_VIEW")?.addr;
    if (hvAddr) {
      const hv = await ethers.getContractAt("HealthView", hvAddr);
      await safeCall(
        "HealthView.getUserHealthFactorWithMeta(sampleUser)",
        async () => {
          const [hf, isValid, blockNumber] = (await hv.getUserHealthFactorWithMeta(sampleUser)) as [
            bigint,
            boolean,
            bigint
          ];
          console.log(
            `  [Sanity] HealthView.getUserHealthFactorWithMeta: hf=${hf.toString()} isValid=${isValid} block=${blockNumber.toString()}`
          );
        },
        strict
      );
    }
  }

  if (assetAddr) {
    const vcAddr = resolved.find((x) => x.key === "VIEW_CACHE")?.addr;
    if (vcAddr) {
      const vc = await ethers.getContractAt("ViewCache", vcAddr);
      await safeCall(
        "ViewCache.getSystemStatus(asset)",
        async () => {
          const [status, isValid] = await vc.getSystemStatus(assetAddr);
          console.log(
            `  [Sanity] ViewCache.getSystemStatus: isValid=${isValid} block=${status.updateBlock?.toString?.() ?? "?"}`
          );
        },
        strict
      );
    }
  }

  console.log("=== ViewScan done ===\n");
}


