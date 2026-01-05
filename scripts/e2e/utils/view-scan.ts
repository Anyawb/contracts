import { ethers } from "hardhat";

type VersionInfo = {
  apiVersion: bigint;
  schemaVersion: bigint;
  implementation: string;
};

export type ViewScanOptions = {
  assetAddr?: string;
  sampleUser?: string;
  strict?: boolean;
};

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function envBool(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "y") return true;
  if (v === "0" || v === "false" || v === "no" || v === "n") return false;
  return defaultValue;
}

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

async function getVersionInfo(view: any): Promise<VersionInfo> {
  const [apiVersion, schemaVersion, implementation] = (await view.getVersionInfo()) as [bigint, bigint, string];
  return { apiVersion, schemaVersion, implementation };
}

export async function scanViewModules(registryAddr: string, opts?: ViewScanOptions) {
  const strict = opts?.strict ?? envBool("E2E_VIEW_STRICT", false);
  const registry = await ethers.getContractAt("Registry", registryAddr);

  console.log("=== ViewScan (Registry-driven) ===");
  console.log(`  strict=${strict}`);

  // 21 view modules deployed by deploylocal.ts (keys are UPPER_SNAKE_CASE strings)
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
    { key: "STATISTICS_VIEW", name: "StatisticsView", expectedApi: 1n, expectedSchema: 1n },
    { key: "POSITION_VIEW", name: "PositionView", expectedApi: 1n, expectedSchema: 2n },
    { key: "PREVIEW_VIEW", name: "PreviewView", expectedApi: 1n, expectedSchema: 1n },
    { key: "DASHBOARD_VIEW", name: "DashboardView", expectedApi: 1n, expectedSchema: 1n },
    { key: "USER_VIEW", name: "UserView", expectedApi: 1n, expectedSchema: 1n },
    { key: "ACCESS_CONTROL_VIEW", name: "AccessControlView", expectedApi: 1n, expectedSchema: 1n },
    { key: "CACHE_OPTIMIZED_VIEW", name: "CacheOptimizedView", expectedApi: 1n, expectedSchema: 1n },
    { key: "LENDING_ENGINE_VIEW", name: "LendingEngineView", expectedApi: 1n, expectedSchema: 1n },
    { key: "FEE_ROUTER_VIEW", name: "FeeRouterView", expectedApi: 1n, expectedSchema: 1n },
    { key: "RISK_VIEW", name: "RiskView", expectedApi: 1n, expectedSchema: 1n },
    { key: "VIEW_CACHE", name: "ViewCache", expectedApi: 1n, expectedSchema: 1n },
    { key: "EVENT_HISTORY_MANAGER", name: "EventHistoryManager", expectedApi: 1n, expectedSchema: 1n },
    { key: "VALUATION_ORACLE_VIEW", name: "ValuationOracleView", expectedApi: 1n, expectedSchema: 1n },
    { key: "MODULE_HEALTH_VIEW", name: "ModuleHealthView", expectedApi: 1n, expectedSchema: 1n },
    { key: "BATCH_VIEW", name: "BatchView", expectedApi: 1n, expectedSchema: 1n },
    { key: "LIQUIDATION_VIEW", name: "LiquidatorView", expectedApi: 1n, expectedSchema: 1n },
    { key: "LIQUIDATION_RISK_VIEW", name: "LiquidationRiskView", expectedApi: 1n, expectedSchema: 1n },
    // RewardView bumped apiVersion to 2 after introducing a dedicated penalty-ledger DataPush type
    { key: "REWARD_VIEW", name: "RewardView", expectedApi: 2n, expectedSchema: 1n },
  ];

  // Resolve all module addresses first.
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

  // VersionInfo scan (C baseline).
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

  // Lightweight sanity calls (best-effort; strict mode will fail fast).
  const assetAddr = opts?.assetAddr;
  const sampleUser = opts?.sampleUser;
  if (sampleUser) {
    const hvAddr = resolved.find((x) => x.key === "HEALTH_VIEW")?.addr;
    if (hvAddr) {
      const hv = await ethers.getContractAt("HealthView", hvAddr);
      await safeCall(
        "HealthView.getUserHealthFactor(sampleUser)",
        async () => {
          const [hf, isValid] = (await hv.getUserHealthFactor(sampleUser)) as [bigint, boolean];
          console.log(`  [Sanity] HealthView.getUserHealthFactor: hf=${hf.toString()} isValid=${isValid}`);
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
          console.log(`  [Sanity] ViewCache.getSystemStatus: isValid=${isValid} ts=${status.timestamp?.toString?.() ?? "?"}`);
        },
        strict
      );
    }
  }

  console.log("=== ViewScan done ===\n");
}


