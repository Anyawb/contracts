/**
 * @file e2e-localhost-batch-aggregators-acceptance.ts
 * @notice BatchView / CacheOptimizedView / DashboardView（ARCH 4.11）专项验收 E2E 测试脚本
 * @dev 本脚本用于在本地 Hardhat 节点上验证聚合器 View 模块的对齐验收标准
 *
 * ## 测试目标（对应 ARCH-VIEW-ALIGNMENT-WORKGUIDE.md 4.11）
 *
 * ### BV-01: 职责边界（无写入）
 * - 断言三者 ABI 中不存在任何 `push*` 写入口
 * - 断言除 UUPS/initializer 必要入口外，ABI 中不存在其他非 `view/pure` 的外部函数
 * - 防止"偷偷写状态"的回归
 *
 * ### BV-02: 批量上限一致（统一错误类型）
 * - 对 101 长度数组/limit 触发超限，必须统一 `revert BatchTooLarge(101, 100)`
 * - 验证所有批量入口（`batchGetAssetPrices`、`batchGetHealthFactors`、`batchGetRiskAssessments`、
 *   `getUserAssetBreakdown`、`getUserOverview`、`getDegradationHistory` 等）都遵循统一限制
 *
 * ### BV-03: 权限一致性（不得绕过下游）
 * - 对 price 数据：`BatchView.batchGetAssetPrices` 与 `ValuationOracleView.getAssetPrices` 对无权限 caller 均 `revert MissingRole()`
 * - 对 risk 数据：`BatchView.batchGetHealthFactors/batchGetRiskAssessments` 需 `VIEW_USER_DATA/ADMIN`（Scheme U batch 规则，无 self-bypass）
 * - 对 user positions：聚合器入口与专属 View 入口的权限行为完全一致（Scheme U：self 允许；non-self 需 `VIEW_USER_DATA/ADMIN`）
 * - 验证 `HealthView` 默认公开只读（不强制 role gate）
 * - 验证 `RiskView` Scheme U：self read 允许；non-self 需 `VIEW_USER_DATA/ADMIN`
 *
 * ### 返回一致性验证
 * - `BatchView.batchGetAssetPrices([asset])` 与 `ValuationOracleView.getAssetPrices([asset])` 返回价格一致
 * - `DashboardView.getUserAssetBreakdownWithMeta` 的 PositionView meta 字段与 `PositionView.getUserPositionWithMeta` 一致
 * - 验证 meta 透传不丢失信息（`isValid/blockNumber/version`）
 *
 * ## 运行方式
 * ```bash
 * npx hardhat run scripts/e2e/e2e-localhost-batch-aggregators-acceptance.ts --network localhost
 * ```
 *
 * ## 前置条件
 * - 本地 Hardhat 节点已启动（`pnpm -s run node`）
 * - 合约已部署到本地节点（`pnpm -s run deploy:localhost`）
 * - 部署脚本已正确配置所有 View 模块注册到 Registry
 *
 * ## 验收标准
 * - ✅ 聚合器 View 不存在 `push*` 写入口和非业务状态写入
 * - ✅ 所有批量入口超限统一 `revert BatchTooLarge(len,max)`（selector 验证）
 * - ✅ 聚合器入口与专属 View 入口的权限行为完全一致（同类数据 → 同一 ActionKey）
 * - ✅ 聚合器返回数据与专属 View 返回数据一致（价格、仓位 meta 等）
 * - ✅ Scheme U 规则正确应用：self read 允许；batch 无 self-bypass；non-self 需 `VIEW_USER_DATA/ADMIN`
 *
 * @see ARCH-VIEW-ALIGNMENT-WORKGUIDE.md 4.11 BatchView / CacheOptimizedView / DashboardView 测试矩阵
 * @see scripts/e2e/README.md 4.11 章节说明
 */

import { ethers, network } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost.ts";
import { runViewPreflight } from "./utils/view-preflight.ts";

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
  // ethers v6 sometimes sets `e.data` to *call data* (tx.data), not revert data.
  // Prefer nested hardhat/ethers fields that usually contain revert data.
  const txData: string | undefined = typeof e?.transaction?.data === "string" ? e.transaction.data : undefined;
  const roots: Array<unknown> = [
    e?.info?.error?.data,
    e?.info?.error?.error?.data,
    e?.error?.data,
    e?.error?.error?.data,
    e?.data,
    e?.receipt?.revertReason,
  ];

  const seen = new Set<unknown>();
  const hexes: string[] = [];
  const stack: Array<{ v: unknown; depth: number }> = roots.map((v) => ({ v, depth: 0 }));

  while (stack.length) {
    const cur = stack.pop()!;
    const v = cur.v;
    if (!v || seen.has(v) || cur.depth > 4) continue;
    seen.add(v);

    if (typeof v === "string") {
      if (v.startsWith("0x") && v.length >= 10) {
        if (txData && v.toLowerCase() === txData.toLowerCase()) continue;
        hexes.push(v);
      }
      continue;
    }
    if (typeof v === "object") {
      const obj: any = v;
      for (const k of ["data", "result", "returnData", "reason", "error", "value"]) {
        if (obj && Object.prototype.hasOwnProperty.call(obj, k)) {
          stack.push({ v: obj[k], depth: cur.depth + 1 });
        }
      }
      continue;
    }
  }

  // Prefer the shortest plausible revert payload (calldata for large arrays is typically much longer).
  hexes.sort((a, b) => a.length - b.length);
  if (hexes[0]) return hexes[0];

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

/**
 * 断言合约不存在 push* 写入口（职责边界验证）
 * @param c 合约实例
 * @param label 合约标签（用于错误消息）
 */
function assertNoPushEntryPoints(c: any, label: string) {
  const fns = c.interface.fragments.filter((x: any) => x.type === "function").map((x: any) => x.name);
  const pushes = fns.filter((n: string) => n.startsWith("push"));
  assertOk(pushes.length === 0, `${label}: must not expose push* entrypoints: ${pushes.join(", ")}`);
}

/**
 * 断言合约不存在业务状态写入函数（除 UUPS/initializer 外）
 * @param c 合约实例
 * @param label 合约标签（用于错误消息）
 */
function assertNoBusinessStateWriters(c: any, label: string) {
  const allowed = new Set(["initialize", "upgradeTo", "upgradeToAndCall", "proxiableUUID"]);
  const bad = c.interface.fragments
    .filter((x: any) => x.type === "function")
    .filter((f: any) => !["view", "pure"].includes(f.stateMutability))
    .map((f: any) => `${f.name}(${f.stateMutability})`)
    .filter((s: string) => !allowed.has(s.split("(")[0]));
  assertOk(bad.length === 0, `${label}: must not expose non-view writers (except UUPS/init): ${bad.join(", ")}`);
}

/**
 * 主测试函数
 * 
 * 测试流程：
 * 1. 执行 View Preflight（统一路由/权限/版本信息检查）
 * 2. 验证职责边界（BV-01：无 push* 写入口、无业务状态写入）
 * 3. 验证批量限制（BV-02：统一错误类型 BatchTooLarge）
 * 4. 验证权限一致性（BV-03：聚合器不得绕过下游权限）
 * 5. 验证返回一致性（聚合器与专属 View 返回一致）
 */
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

    // ====== BV-01: 职责边界（无写入） ======
    // 验证聚合器 View 不存在 push* 写入口和业务状态写入
    assertNoPushEntryPoints(batch, "BatchView");
    assertNoPushEntryPoints(cacheOpt, "CacheOptimizedView");
    assertNoPushEntryPoints(dashboard, "DashboardView");

    assertNoBusinessStateWriters(batch, "BatchView");
    assertNoBusinessStateWriters(cacheOpt, "CacheOptimizedView");
    assertNoBusinessStateWriters(dashboard, "DashboardView");

    // ====== BV-02: 批量上限一致（统一错误类型） ======
    // 验证所有批量入口超限统一 revert BatchTooLarge(len,max)
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

    // ====== BV-03: 权限一致性（不得绕过下游）- Price 数据 ======
    // 验证聚合器入口与专属 View 入口的权限行为完全一致
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

    // ====== BV-03: 权限一致性（不得绕过下游）- Risk 数据（Scheme U） ======
    const hvAddr = (await registry.getModuleOrRevert(key("HEALTH_VIEW"))) as string;
    const rvAddr = (await registry.getModuleOrRevert(key("RISK_VIEW"))) as string;
    const hv = (await ethers.getContractAt("HealthView", hvAddr)) as any;
    const rv = (await ethers.getContractAt("RiskView", rvAddr)) as any;

    // HealthView HF reads follow Scheme U:
    // - self read allowed
    // - non-self requires VIEW_USER_DATA/ADMIN
    await mustSucceed("Scheme U self-read: HealthView.getUserHealthFactorWithMeta", async () =>
      hv.connect(unauth).getUserHealthFactorWithMeta(unauth.address)
    );
    await mustRevertWithSelector(
      "Scheme U non-self: HealthView.getUserHealthFactorWithMeta requires VIEW_USER_DATA/ADMIN",
      async () => hv.connect(unauth).getUserHealthFactorWithMeta(deployer.address),
      missingRoleSel
    );

    // BatchView users[] batch follows Scheme U batch (no self-bypass) -> requires VIEW_USER_DATA/ADMIN
    await mustRevertWithSelector(
      "Unauthorized: BatchView.batchGetHealthFactors requires VIEW_USER_DATA/ADMIN",
      async () => batch.connect(unauth).batchGetHealthFactors([unauth.address]),
      missingRoleSel
    );

    // HealthView meta passthrough: BatchView must include isValid/blockNumber.
    const [hvHf, hvOk, hvBlockNumber] = (await mustSucceed("HealthView.getUserHealthFactorWithMeta", async () =>
      hv.connect(deployer).getUserHealthFactorWithMeta(deployer.address)
    )) as [bigint, boolean, bigint];
    const hvBatch = (await mustSucceed("BatchView.batchGetHealthFactors", async () =>
      batch.connect(deployer).batchGetHealthFactors([deployer.address])
    )) as Array<{ user: string; healthFactor: bigint; isValid: boolean; blockNumber: bigint }>;
    assertOk(hvBatch.length === 1, "BatchView batchGetHealthFactors length mismatch");
    assertOk(hvBatch[0].healthFactor === hvHf, "BatchView healthFactor mismatch vs HealthView");
    assertOk(hvBatch[0].isValid === hvOk, "BatchView isValid mismatch vs HealthView");
    assertOk(hvBatch[0].blockNumber === hvBlockNumber, "BatchView blockNumber mismatch vs HealthView");

    // RiskView Scheme U: self-read allowed; non-self requires VIEW_USER_DATA/ADMIN
    await mustSucceed("Scheme U self-read: RiskView.getUserRiskAssessment", async () =>
      rv.connect(unauth).getUserRiskAssessment(unauth.address)
    );
    await mustRevertWithSelector(
      "Scheme U non-self: RiskView.getUserRiskAssessment requires VIEW_USER_DATA/ADMIN",
      async () => rv.connect(unauth).getUserRiskAssessment(deployer.address),
      missingRoleSel
    );
    await mustRevertWithSelector(
      "Unauthorized: BatchView.batchGetRiskAssessments requires VIEW_USER_DATA/ADMIN",
      async () => batch.connect(unauth).batchGetRiskAssessments([unauth.address]),
      missingRoleSel
    );

    const directRisk = (await mustSucceed("RiskView.getUserRiskAssessment (meta)", async () =>
      rv.connect(deployer).getUserRiskAssessment(deployer.address)
    )) as { liquidatable: boolean; healthFactor: bigint; warningLevel: bigint; isValid: boolean; blockNumber: bigint };
    const riskBatch = (await mustSucceed("BatchView.batchGetRiskAssessments (meta)", async () =>
      batch.connect(deployer).batchGetRiskAssessments([deployer.address])
    )) as Array<{ healthFactor: bigint; liquidatable: boolean; warningLevel: bigint; isValid: boolean; blockNumber: bigint }>;
    assertOk(riskBatch.length === 1, "BatchView batchGetRiskAssessments length mismatch");
    assertOk(riskBatch[0].healthFactor === directRisk.healthFactor, "BatchView risk healthFactor mismatch");
    assertOk(riskBatch[0].liquidatable === directRisk.liquidatable, "BatchView risk liquidatable mismatch");
    assertOk(riskBatch[0].warningLevel === directRisk.warningLevel, "BatchView risk warningLevel mismatch");
    assertOk(riskBatch[0].isValid === directRisk.isValid, "BatchView risk isValid mismatch");
    assertOk(riskBatch[0].blockNumber === directRisk.blockNumber, "BatchView risk blockNumber mismatch");

    // ====== BV-03: 权限一致性（不得绕过下游）- User Positions（Scheme U） ======
    // Scheme U: self-read should be allowed without VIEW_USER_DATA/ADMIN.
    await mustSucceed("Scheme U self-read: PositionView.getUserPositionWithMeta (no roles)", async () =>
      pv.connect(unauth).getUserPositionWithMeta(unauth.address, CONTRACT_ADDRESSES.MockUSDC)
    );
    // Non-self should revert MissingRole() when caller lacks VIEW_USER_DATA/ADMIN.
    await mustRevertWithSelector(
      "Scheme U non-self: PositionView.getUserPositionWithMeta must revert MissingRole()",
      async () => pv.connect(unauth).getUserPositionWithMeta(deployer.address, CONTRACT_ADDRESSES.MockUSDC),
      missingRoleSel
    );
    await mustRevertWithSelector(
      "Scheme U non-self: DashboardView.getUserAssetBreakdownWithMeta must revert MissingRole()",
      async () =>
        dashboard.connect(unauth).getUserAssetBreakdownWithMeta(deployer.address, [CONTRACT_ADDRESSES.MockUSDC]),
      missingRoleSel
    );
    await mustRevertWithSelector(
      "Price gate: DashboardView.getUserAssetBreakdownWithMeta requires VIEW_PRICE_DATA",
      async () => dashboard.connect(unauth).getUserAssetBreakdownWithMeta(unauth.address, [CONTRACT_ADDRESSES.MockUSDC]),
      missingRoleSel
    );
    const ROLE_VIEW_PRICE_DATA = key("VIEW_PRICE_DATA");
    await mustSucceed("grant VIEW_PRICE_DATA to unauth", async () =>
      acm.connect(deployer).grantRole(ROLE_VIEW_PRICE_DATA, unauth.address)
    );
    await mustSucceed("Scheme U self-read: DashboardView.getUserAssetBreakdownWithMeta (with VIEW_PRICE_DATA)", async () =>
      dashboard.connect(unauth).getUserAssetBreakdownWithMeta(unauth.address, [CONTRACT_ADDRESSES.MockUSDC])
    );
    await mustSucceed("Scheme U self-read: DashboardView.getUserOverview (no roles)", async () =>
      dashboard.connect(unauth).getUserOverview(unauth.address, [CONTRACT_ADDRESSES.MockUSDC])
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

    // CacheOptimizedView Scheme U checks (self-read allowed; non-self requires VIEW_USER_DATA/ADMIN; batch has no self-bypass)
    const [coHf, coOk, coBlockNumber] = (await mustSucceed(
      "Scheme U self-read: CacheOptimizedView.getUserHealthFactor (no roles)",
      async () => cacheOpt.connect(unauth).getUserHealthFactor(unauth.address)
    )) as [bigint, boolean, bigint];
    assertOk(typeof coBlockNumber === "bigint", "CacheOptimizedView.getUserHealthFactor must return blockNumber");
    await mustRevertWithSelector(
      "Scheme U non-self: CacheOptimizedView.getUserHealthFactor must revert MissingRole()",
      async () => cacheOpt.connect(unauth).getUserHealthFactor(deployer.address),
      missingRoleSel
    );
    await mustRevertWithSelector(
      "Scheme U batch no self-bypass: CacheOptimizedView.batchGetUserHealthFactors([self]) must revert MissingRole()",
      async () => cacheOpt.connect(unauth).batchGetUserHealthFactors([unauth.address]),
      missingRoleSel
    );
    await mustRevertWithSelector(
      "Scheme U batch no self-bypass: mixed users (includes self) must still revert MissingRole()",
      async () => cacheOpt.connect(unauth).batchGetUserHealthFactors([unauth.address, deployer.address]),
      missingRoleSel
    );

    // Positive path: ops with VIEW_USER_DATA can read non-self and batch
    const ROLE_VIEW_USER_DATA = key("VIEW_USER_DATA");
    const ops = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: ops.address, value: ethers.parseEther("1") });
    await mustSucceed("grant VIEW_USER_DATA to ops (Scheme U)", async () => acm.connect(deployer).grantRole(ROLE_VIEW_USER_DATA, ops.address));
    await mustSucceed("Scheme U ops read: DashboardView.getUserOverview", async () =>
      dashboard.connect(ops).getUserOverview(deployer.address, [CONTRACT_ADDRESSES.MockUSDC])
    );
    await mustSucceed("Scheme U ops read: CacheOptimizedView.getUserHealthFactor", async () =>
      cacheOpt.connect(ops).getUserHealthFactor(deployer.address)
    );
    const [opsFactors, opsFlags, opsBlockNumbers] = (await mustSucceed(
      "Scheme U ops batch: CacheOptimizedView.batchGetUserHealthFactors",
      async () => cacheOpt.connect(ops).batchGetUserHealthFactors([deployer.address])
    )) as [bigint[], boolean[], bigint[]];
    assertOk(
      opsFactors.length === 1 && opsFlags.length === 1 && opsBlockNumbers.length === 1,
      "CacheOptimizedView batch meta lengths mismatch"
    );
    assertOk(opsBlockNumbers[0] >= 0n, "CacheOptimizedView batch blockNumber must be present");
    await mustSucceed("Scheme U ops read: CacheOptimizedView.getUserSummary", async () =>
      cacheOpt.connect(ops).getUserSummary(deployer.address, [])
    );
    await mustSucceed("Scheme U ops batch: CacheOptimizedView.batchGetUserHealthFactors (mixed)", async () =>
      cacheOpt.connect(ops).batchGetUserHealthFactors([deployer.address, ops.address])
    );

    // Admin bypass (ACTION_ADMIN) should allow non-self reads on Scheme U facades.
    const ROLE_ADMIN = key("ACTION_ADMIN");
    const adminOnly = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: adminOnly.address, value: ethers.parseEther("1") });
    await mustSucceed("grant ACTION_ADMIN to adminOnly (Scheme U)", async () => acm.connect(deployer).grantRole(ROLE_ADMIN, adminOnly.address));
    await mustSucceed("Scheme U admin bypass: DashboardView.getUserOverview", async () =>
      dashboard.connect(adminOnly).getUserOverview(deployer.address, [CONTRACT_ADDRESSES.MockUSDC])
    );
    await mustSucceed("Scheme U admin bypass: CacheOptimizedView.getUserHealthFactor", async () =>
      cacheOpt.connect(adminOnly).getUserHealthFactor(deployer.address)
    );
    await mustSucceed("Scheme U admin bypass: CacheOptimizedView.getUserSummary", async () =>
      cacheOpt.connect(adminOnly).getUserSummary(deployer.address, [])
    );

    // CacheOptimizedView meta consistency vs HealthView
    const [hvHf2, hvOk2, hvBlockNumber2] = (await mustSucceed("HealthView.getUserHealthFactorWithMeta (direct)", async () =>
      hv.connect(deployer).getUserHealthFactorWithMeta(deployer.address)
    )) as [bigint, boolean, bigint];
    assertOk(coHf === hvHf2, "CacheOptimizedView healthFactor mismatch vs HealthView");
    assertOk(coOk === hvOk2, "CacheOptimizedView isValid mismatch vs HealthView");
    assertOk(coBlockNumber === hvBlockNumber2, "CacheOptimizedView blockNumber mismatch vs HealthView");

    // ====== 返回一致性验证：聚合器与专属 View 返回一致 ======
    const [prices] = (await mustSucceed("VOV.getAssetPrices([USDC])", async () =>
      vov.connect(deployer).getAssetPrices([CONTRACT_ADDRESSES.MockUSDC])
    )) as [bigint[], bigint[], boolean[]];
    const items = (await mustSucceed("BatchView.batchGetAssetPrices([USDC])", async () =>
      batch.connect(deployer).batchGetAssetPrices([CONTRACT_ADDRESSES.MockUSDC])
    )) as Array<{ asset: string; price: bigint }>;
    assertOk(items.length === 1, "BatchView batchGetAssetPrices length mismatch");
    assertOk(items[0].asset.toLowerCase() === CONTRACT_ADDRESSES.MockUSDC.toLowerCase(), "BatchView asset mismatch");
    assertOk(items[0].price === prices[0], "price mismatch between BatchView and ValuationOracleView");

    // Position meta passthrough consistency: DashboardView meta matches PositionView meta
    const [c1, d1, v1, posBlockNumber, ver1] = (await mustSucceed("PositionView.getUserPositionWithMeta", async () =>
      pv.connect(deployer).getUserPositionWithMeta(deployer.address, CONTRACT_ADDRESSES.MockUSDC)
    )) as [bigint, bigint, boolean, bigint, bigint];
    const itemsMeta = (await mustSucceed("DashboardView.getUserAssetBreakdownWithMeta", async () =>
      dashboard.connect(deployer).getUserAssetBreakdownWithMeta(deployer.address, [CONTRACT_ADDRESSES.MockUSDC])
    )) as Array<{
      asset: string;
      collateral: bigint;
      debt: bigint;
      positionIsValid: boolean;
      positionBlockNumber: bigint;
      positionVersion: bigint;
      price: bigint;
    }>;
    assertOk(itemsMeta.length === 1, "DashboardView meta breakdown length mismatch");
    assertOk(itemsMeta[0].asset.toLowerCase() === CONTRACT_ADDRESSES.MockUSDC.toLowerCase(), "DashboardView meta asset mismatch");
    assertOk(itemsMeta[0].collateral === c1 && itemsMeta[0].debt === d1, "DashboardView meta collateral/debt mismatch vs PositionView");
    assertOk(itemsMeta[0].positionIsValid === v1, "DashboardView meta isValid mismatch vs PositionView");
    assertOk(itemsMeta[0].positionBlockNumber === posBlockNumber, "DashboardView meta blockNumber mismatch vs PositionView");
    assertOk(itemsMeta[0].positionVersion === ver1, "DashboardView meta version mismatch vs PositionView");
    assertOk(typeof itemsMeta[0].price === "bigint", "DashboardView price must be bigint");

    // System stats meta passthrough: DashboardView.getSystemOverviewWithMeta matches StatisticsView
    const statsAddr = (await registry.getModuleOrRevert(key("VAULT_STATISTICS"))) as string;
    const statsView = (await ethers.getContractAt("StatisticsView", statsAddr)) as any;
    const [sys, sysOk, sysBlockNumber] = (await mustSucceed("DashboardView.getSystemOverviewWithMeta", async () =>
      dashboard.connect(deployer).getSystemOverviewWithMeta()
    )) as [{ totalUsers: bigint; activeUsers: bigint; totalCollateral: bigint; totalDebt: bigint; lastUpdateBlock: bigint }, boolean, bigint];
    const [g, gOk, gBlockNumber] = (await mustSucceed("StatisticsView.getGlobalStatisticsWithMeta", async () =>
      statsView.connect(deployer).getGlobalStatisticsWithMeta()
    )) as [{ totalUsers: bigint; activeUsers: bigint; totalCollateral: bigint; totalDebt: bigint; lastUpdateBlock: bigint }, boolean, bigint];
    assertOk(sys.totalUsers === g.totalUsers, "DashboardView system stats.totalUsers mismatch");
    assertOk(sys.activeUsers === g.activeUsers, "DashboardView system stats.activeUsers mismatch");
    assertOk(sys.totalCollateral === g.totalCollateral, "DashboardView system stats.totalCollateral mismatch");
    assertOk(sys.totalDebt === g.totalDebt, "DashboardView system stats.totalDebt mismatch");
    assertOk(sys.lastUpdateBlock === g.lastUpdateBlock, "DashboardView system stats.lastUpdateBlock mismatch");
    assertOk(sysOk === gOk, "DashboardView system meta isValid mismatch");
    assertOk(sysBlockNumber === gBlockNumber, "DashboardView system meta blockNumber mismatch");

    // Module health meta passthrough: BatchView includes isValid/blockNumber from HealthView
    const [mh, mhOk, mhBlockNumber] = (await mustSucceed("HealthView.getModuleHealthWithMeta", async () =>
      hv.connect(deployer).getModuleHealthWithMeta(batchAddr)
    )) as [{ isHealthy: boolean; lastCheckTime: bigint; consecutiveFailures: bigint; detailsHash: string }, boolean, bigint];
    const mhBatch = (await mustSucceed("BatchView.batchGetModuleHealth", async () =>
      batch.connect(deployer).batchGetModuleHealth([batchAddr])
    )) as Array<{
      module: string;
      isHealthy: boolean;
      lastCheckTime: bigint;
      consecutiveFailures: bigint;
      detailsHash: string;
      isValid: boolean;
      blockNumber: bigint;
    }>;
    assertOk(mhBatch.length === 1, "BatchView batchGetModuleHealth length mismatch");
    assertOk(mhBatch[0].module.toLowerCase() === batchAddr.toLowerCase(), "BatchView module health module mismatch");
    assertOk(mhBatch[0].isHealthy === mh.isHealthy, "BatchView module health isHealthy mismatch");
    assertOk(mhBatch[0].lastCheckTime === mh.lastCheckTime, "BatchView module health lastCheckTime mismatch");
    assertOk(mhBatch[0].consecutiveFailures === mh.consecutiveFailures, "BatchView module health failures mismatch");
    assertOk(mhBatch[0].detailsHash === mh.detailsHash, "BatchView module health detailsHash mismatch");
    assertOk(mhBatch[0].isValid === mhOk, "BatchView module health isValid mismatch");
    assertOk(mhBatch[0].blockNumber === mhBlockNumber, "BatchView module health blockNumber mismatch");

    console.log("\n✅ Batch aggregators acceptance PASSED");
  } finally {
    await revertTo(snap);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

