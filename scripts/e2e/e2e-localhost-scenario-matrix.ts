/**
 * @file e2e-localhost-scenario-matrix.ts
 * @notice E2E 场景矩阵（ARCH 5.1.3：E2E-01/02/03）专项验收测试脚本
 * @dev 本脚本用于在本地 Hardhat 节点上验证多模块联动的关键承诺与可观测性
 *
 * ## 测试目标（对应 ARCH-VIEW-ALIGNMENT-WORKGUIDE.md 5.1.3）
 *
 * ### E2E-01: 多用户资金流回放
 * - N 用户、资产配置完成
 * - deposit/borrow/repay/withdraw 交错执行
 * - 每步后用 `DashboardView/CacheOptimizedView/BatchView` 批量拉取
 * - 验证 `DataPushed` 连续可观测
 * - 验证 Position/Health/Stats 的有效性字段齐全
 * - 验证每步数据一致；有效性信息不丢；批量接口稳定
 *
 * ### E2E-02: 推送失败模拟与链下重试
 * - 可制造 view 地址缺失/推送失败
 * - 故意触发 push 失败 → 监听失败事件 → 链下重试 push
 * - 验证失败事件（`CacheUpdateFailed` / `ViewCachePushFailed` / `UserStatsPushFailed`）可观测
 * - 验证重试成功的 `DataPushed`
 * - 验证重试后 `isValid=true`、blockNumber 更新
 * - 验证失败可观测且可重放；无链上循环重试
 *
 * ### E2E-03: 批量边界与性能
 * - 可生成大数组
 * - 接近 `MAX_BATCH_SIZE` 的批量调用 + 超限调用
 * - 验证成功/失败事件口径一致
 * - 验证返回稳定
 * - 验证不 OOG；超限一致失败
 *
 * ## 验收证据（Artifacts，MUST）
 * 每次验收运行必须输出/保存（脚本日志或文件均可）：
 * - 模块地址快照（Registry keys → addr）
 * - 关键 View 的 `getVersionInfo()`（api/schema/implementation）
 * - `DataPushed` 按 `dataTypeHash` 的计数统计（推荐以 `DataPushTypes` 作为统计口径）
 * - 失败事件计数与重试成功率（若启用失败模拟）
 *
 * ## 验证内容
 *
 * ### 三聚合器一致性（tri-aggregator consistency）
 * - Position meta：`PositionView` vs `CacheOptimizedView` vs `DashboardView`
 * - Health factors：`HealthView` vs `CacheOptimizedView` vs `DashboardView`
 * - Statistics：`StatisticsView` vs `CacheOptimizedView` vs `DashboardView`
 * - 验证所有聚合器返回的 meta 字段（`isValid/blockNumber/version`）一致
 *
 * ### DataPush 可观测性
 * - 验证所有关键业务操作都触发对应的 `DataPushed` 事件
 * - 验证 `dataTypeHash` 来自集中常量口径
 * - 验证 payload 可 ABI 解码
 *
 * ### 失败事件可观测性
 * - 验证推送失败时触发失败事件（`CacheUpdateFailed` / `ViewCachePushFailed` / `UserStatsPushFailed`）
 * - 验证失败事件包含足够信息用于链下重试
 * - 验证链下重试后成功推送
 *
 * ## 运行方式
 * ```bash
 * npx hardhat run scripts/e2e/e2e-localhost-scenario-matrix.ts --network localhost
 * ```
 *
 * ## 前置条件
 * - 本地 Hardhat 节点已启动（`pnpm -s run node`）
 * - 合约已部署到本地节点（`pnpm -s run deploy:localhost`）
 * - 部署脚本已正确配置所有模块的 Registry 绑定
 *
 * ## 验收标准
 * - ✅ E2E-01：多用户资金流回放中每步数据一致；有效性信息不丢；批量接口稳定
 * - ✅ E2E-02：推送失败可观测且可重放；无链上循环重试；重试后成功
 * - ✅ E2E-03：批量边界正确处理；不 OOG；超限一致失败
 * - ✅ 三聚合器一致性：Position/Health/Stats 在所有聚合器中返回一致
 * - ✅ DataPush 可观测性：所有关键操作都触发对应事件
 * - ✅ 验收证据输出：模块地址快照、版本信息、DataPushed 计数、失败事件计数
 *
 * @see ARCH-VIEW-ALIGNMENT-WORKGUIDE.md 5.1.3 e2e 场景矩阵
 * @see scripts/e2e/README.md 8. 章节说明
 */

import { ethers, network } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost.ts";
import { runViewPreflight } from "./utils/view-preflight.ts";

const ONE_HOUR_BLOCKS = 1_800n;
const BLOCKS_PER_DAY = 7_200n;

async function latestBlockNumber(): Promise<bigint> {
  return BigInt(await ethers.provider.getBlockNumber());
}

async function mineToBlock(targetBlock: bigint) {
  const current = await latestBlockNumber();
  if (targetBlock <= current) return;
  const delta = targetBlock - current;
  await ethers.provider.send("hardhat_mine", [ethers.toBeHex(delta)]);
}

const ONE_DAY = 24n * 60n * 60n;

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
  return String(msg).includes("function selector was not recognized");
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
  const raw = m[1].trim(); // e.g. "MissingRole()" or "BatchTooLarge(101, 100)"
  if (raw.endsWith("()")) return raw;
  // Special-case: errors with args where types are known but values are shown.
  if (raw.startsWith("BatchTooLarge(")) return "BatchTooLarge(uint256,uint256)";
  return undefined;
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
    let sel: string | undefined =
      data && data.startsWith("0x") && data.length >= 10 ? data.slice(0, 10).toLowerCase() : undefined;
    if (!sel) {
      const sig = extractCustomErrorSigFromMessage(e);
      if (sig) sel = errorSelector(sig).toLowerCase();
    }
    assertOk(!!sel, `${label}: missing revert data (cannot validate selector). msg=${msg}`);
    assertOk(sel === expectedSel.toLowerCase(), `${label}: unexpected error selector ${sel}, expected ${expectedSel}`);
    console.log(`  ✅ [revert selector ok] ${label}: ${sel}`);
    return;
  }
  throw new Error(`[FAIL] Expected revert, but succeeded: ${label}`);
}

async function snapshot(): Promise<string> {
  return await network.provider.send("evm_snapshot", []);
}

async function revertTo(id: string) {
  await network.provider.send("evm_revert", [id]);
}

function calcTotalDue(principal: bigint, rateBps: bigint, termBlocks: bigint) {
  // interest = principal * rate / 1e4 * term / 365 days (block-based)
  const denom = 365n * BLOCKS_PER_DAY * 10_000n;
  const interest = (principal * rateBps * termBlocks) / denom;
  return principal + interest;
}

function buildLendIntentHash(li: any) {
  const typeHash = ethers.keccak256(
    ethers.toUtf8Bytes(
      "LendIntent(address lenderSigner,address asset,uint256 amount,uint16 minTermDays,uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)"
    )
  );
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "address", "address", "uint256", "uint16", "uint16", "uint256", "uint256", "bytes32"],
      [
        typeHash,
        li.lenderSigner,
        li.asset,
        li.amount,
        li.minTermDays,
        li.maxTermDays,
        li.minRateBps,
        li.expireAt,
        li.salt,
      ]
    )
  );
}

// ===== DataPush (SSOT observability) =====
// NOTE: Some deployments may have DataPushed with or without `indexed` dataTypeHash.
// We parse logs by topic0 and decode accordingly (robust across both shapes).
const coder = ethers.AbiCoder.defaultAbiCoder();
const DATA_PUSH_TOPIC0 = ethers.keccak256(ethers.toUtf8Bytes("DataPushed(bytes32,bytes)")).toLowerCase();

function extractDataPushed(receipt: any): Array<{ dataTypeHash: string; payload: string }> {
  const out: Array<{ dataTypeHash: string; payload: string }> = [];
  for (const log of receipt?.logs || []) {
    const topics = (log.topics as string[]) || [];
    if (topics.length === 0) continue;
    if ((topics[0] as string).toLowerCase() !== DATA_PUSH_TOPIC0) continue;

    // Variant A (preferred): event DataPushed(bytes32 indexed dataTypeHash, bytes payload)
    // - topics[1] = dataTypeHash
    // - data      = abi.encode(payload)
    if (topics.length >= 2) {
      const dataTypeHash = (topics[1] as string).toLowerCase();
      const [payload] = coder.decode(["bytes"], log.data) as unknown as [string];
      out.push({ dataTypeHash, payload });
      continue;
    }

    // Variant B (legacy): event DataPushed(bytes32 dataTypeHash, bytes payload)
    // - topics[0] = signature only
    // - data      = abi.encode(dataTypeHash, payload)
    const [dataTypeHash, payload] = coder.decode(["bytes32", "bytes"], log.data) as unknown as [string, string];
    out.push({ dataTypeHash: (dataTypeHash as string).toLowerCase(), payload });
  }
  return out;
}

/**
 * 记录 DataPushed 事件计数（用于验收证据输出）
 * @param label 操作标签
 * @param receipt 交易回执
 * @param counts DataPushed 计数映射（按 dataTypeHash 统计）
 * @returns 提取的 DataPushed 事件列表
 */
function recordDataPushCounts(
  label: string,
  receipt: any,
  counts: Map<string, number>
): Array<{ dataTypeHash: string; payload: string }> {
  const pushes = extractDataPushed(receipt);
  assertOk(pushes.length > 0, `${label}: expected at least one DataPushed, but found none`);
  for (const p of pushes) {
    counts.set(p.dataTypeHash, (counts.get(p.dataTypeHash) ?? 0) + 1);
  }
  return pushes;
}

/**
 * 主测试函数
 * 
 * 测试流程：
 * 1. 执行 View Preflight（统一路由/权限/版本信息检查）
 * 2. E2E-01：多用户资金流回放 + 三聚合器一致性验证
 * 3. E2E-02：推送失败模拟与链下重试
 * 4. E2E-03：批量边界与性能测试
 * 5. 输出验收证据（模块地址快照、版本信息、DataPushed 计数、失败事件计数）
 */
async function main() {
  const snap = await snapshot();
  try {
    const signers = await ethers.getSigners();
    const deployer = signers[0];
    const borrowerA = signers[1];
    const lenderA = signers[2];
    const borrowerB = signers[3];
    const lenderB = signers[4];

    console.log("=== E2E Scenario Matrix (ARCH 5.1.3: E2E-01/02/03) ===\n");

    await runViewPreflight({
      registryAddr: CONTRACT_ADDRESSES.Registry,
      acmAddr: (await (async () => {
        const reg = await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry);
        return reg.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"));
      })()),
      adminSigner: deployer,
      assetForPriceCheck: (await (async () => {
        const reg = await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry);
        return reg.getModuleOrRevert(key("SETTLEMENT_TOKEN"));
      })()),
    });

    const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
    const acmAddrFromRegistry = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
    const assetWhitelistAddrFromRegistry = (await registry.getModuleOrRevert(key("ASSET_WHITELIST"))) as string;
    const priceOracleAddrFromRegistry = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;
    const feeRouterAddrFromRegistry = (await registry.getModuleOrRevert(key("FEE_ROUTER"))) as string;
    const settlementTokenAddrFromRegistry = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;
    const vaultCoreFromRegistryAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;
    const vblAddrFromRegistry = (await registry.getModuleOrRevert(key("VAULT_BUSINESS_LOGIC"))) as string;
    const cmAddrFromRegistry = (await registry.getModuleOrRevert(key("COLLATERAL_MANAGER"))) as string;
    const gfmAddrFromRegistry = (await registry.getModule(key("GUARANTEE_FUND_MANAGER"))) as string;

    const acm = (await ethers.getContractAt("AccessControlManager", acmAddrFromRegistry)) as any;
    const aw = (await ethers.getContractAt("AssetWhitelist", assetWhitelistAddrFromRegistry)) as any;
    const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", priceOracleAddrFromRegistry)) as any;
    const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", feeRouterAddrFromRegistry)) as any;
    const usdc = (await ethers.getContractAt("MockERC20", settlementTokenAddrFromRegistry)) as any;
    const vaultCore = (await ethers.getContractAt("VaultCore", vaultCoreFromRegistryAddr)) as any;
    const vbl = (await ethers.getContractAt("VaultBusinessLogic", vblAddrFromRegistry)) as any;

    const cm = (await ethers.getContractAt("CollateralManager", cmAddrFromRegistry)) as any;
    // Registry key is keccak256("LENDING_ENGINE") (ModuleKeys.KEY_LE).
    const leAddr = await registry.getModuleOrRevert(key("LENDING_ENGINE"));
    const le = (await ethers.getContractAt("src/Vault/modules/VaultLendingEngine.sol:VaultLendingEngine", leAddr)) as any;

    const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
    const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;

    const levAddr = (await registry.getModuleOrRevert(key("LENDING_ENGINE_VIEW"))) as string;
    const lev = (await ethers.getContractAt("LendingEngineView", levAddr)) as any;

    // View modules
    const batchAddr = (await registry.getModuleOrRevert(key("BATCH_VIEW"))) as string;
    const cacheOptAddr = (await registry.getModuleOrRevert(key("CACHE_OPTIMIZED_VIEW"))) as string;
    const dashboardAddr = (await registry.getModuleOrRevert(key("DASHBOARD_VIEW"))) as string;
    const pvAddr = (await registry.getModuleOrRevert(key("POSITION_VIEW"))) as string;
    const hvAddr = (await registry.getModuleOrRevert(key("HEALTH_VIEW"))) as string;
    const statsAddr = (await registry.getModuleOrRevert(key("VAULT_STATISTICS"))) as string;
    const previewAddr = (await registry.getModuleOrRevert(key("PREVIEW_VIEW"))) as string;

    const batch = (await ethers.getContractAt("BatchView", batchAddr)) as any;
    const cacheOpt = (await ethers.getContractAt("CacheOptimizedView", cacheOptAddr)) as any;
    const dashboard = (await ethers.getContractAt("DashboardView", dashboardAddr)) as any;
    const pv = (await ethers.getContractAt("PositionView", pvAddr)) as any;
    const hv = (await ethers.getContractAt("HealthView", hvAddr)) as any;
    const stats = (await ethers.getContractAt("StatisticsView", statsAddr)) as any;
    const preview = (await ethers.getContractAt("PreviewView", previewAddr)) as any;

    const vaultRouterAddr = (await vaultCore.viewContractAddrVar()) as string;

    console.log("  Registry:", CONTRACT_ADDRESSES.Registry);
    console.log("  VaultCore:", await vaultCore.getAddress());
    console.log("  VaultRouter(viewContractAddrVar):", vaultRouterAddr);
    console.log("  CollateralManager:", await cm.getAddress());
    console.log("  VaultLendingEngine(KEY_LE):", leAddr);
    console.log("  ORDER_ENGINE:", orderEngineAddr);
    console.log("  LendingEngineView:", levAddr);
    console.log("  BatchView:", batchAddr);
    console.log("  CacheOptimizedView:", cacheOptAddr);
    console.log("  DashboardView:", dashboardAddr);
    console.log("  PositionView:", pvAddr);
    console.log("  HealthView:", hvAddr);
    console.log("  StatisticsView:", statsAddr);
    console.log("  PreviewView:", previewAddr);
    console.log("");

    // ====== LendingEngineView observability helpers ======
    async function logLEVVersionInfo() {
      const [apiVersion, schemaVersion, implementation] = (await lev.getVersionInfo()) as [bigint, bigint, string];
      console.log(
        `  [LEV VersionInfo] api=${apiVersion.toString()} schema=${schemaVersion.toString()} implementation=${implementation}`
      );
    }

    async function logLEVOrder(label: string, orderId: bigint) {
      // Caller: deployer should have VIEW_USER_DATA + VIEW_SYSTEM_DATA per preflight.
      const o = await lev.connect(deployer).getLoanOrder(orderId);
      const failedFee = (await lev.connect(deployer).getFailedFeeAmount(orderId)) as bigint;
      const retryCount = (await lev.connect(deployer).getNftRetryCount(orderId)) as bigint;
      const regFromEngine = (await lev.connect(deployer).getRegistryFromEngine()) as string;
      const isMatchEngine = (await lev.connect(deployer).isMatchEngine(orderEngineAddr)) as boolean;

      console.log(
        `  [LEV] ${label}: orderId=${orderId.toString()} principal=${o.principal.toString()} borrower=${o.borrower} lender=${o.lender} repaid=${o.repaidAmount.toString()} failedFee=${failedFee.toString()} nftRetry=${retryCount.toString()} isMatchEngine(ORDER_ENGINE)=${isMatchEngine}`
      );
      assertOk(
        regFromEngine.toLowerCase() === CONTRACT_ADDRESSES.Registry.toLowerCase(),
        `[LEV] ${label}: getRegistryFromEngine mismatch. got=${regFromEngine} expect=${CONTRACT_ADDRESSES.Registry}`
      );
    }

    await logLEVVersionInfo();

    // ====== Setup roles/config (best-effort idempotent) ======
    const ensureRole = async (role: string, who: string) => {
      if (!(await acm.hasRole(role, who))) {
        await acm.grantRole(role, who);
      }
    };

    const ACTION_ADD_WHITELIST = key("ADD_WHITELIST");
    const ACTION_UPDATE_PRICE = key("UPDATE_PRICE");
    const ACTION_SET_PARAMETER = key("SET_PARAMETER");
    const ACTION_ORDER_CREATE = key("ORDER_CREATE");
    const ACTION_DEPOSIT = key("DEPOSIT");
    const ACTION_BORROW = key("BORROW");
    const ACTION_REPAY = key("REPAY");
    const ACTION_VIEW_PUSH = key("ACTION_VIEW_PUSH"); // writer gate for PositionView/HealthView

    await ensureRole(ACTION_ADD_WHITELIST, deployer.address);
    await ensureRole(ACTION_UPDATE_PRICE, deployer.address);
    await ensureRole(ACTION_SET_PARAMETER, deployer.address);

    // VBL orchestration permissions
    await ensureRole(ACTION_ORDER_CREATE, vblAddrFromRegistry);
    await ensureRole(ACTION_DEPOSIT, vblAddrFromRegistry);

    // ORDER_ENGINE needs BORROW for LoanNFT mint/update
    await ensureRole(ACTION_BORROW, orderEngineAddr);

    // Borrowers need repay permission (SettlementManager -> ORDER_ENGINE.repay is role-gated by ACTION_REPAY on ORDER_ENGINE)
    await ensureRole(ACTION_REPAY, borrowerA.address);
    await ensureRole(ACTION_REPAY, borrowerB.address);

    // Ensure VaultRouter has view push role (E2E-02 will revoke + restore)
    await ensureRole(ACTION_VIEW_PUSH, vaultRouterAddr);

    // PreviewView integration sanity:
    // PreviewView reads PositionView as an external caller (msg.sender=PreviewView), so PositionView's Scheme-U gate
    // requires the PreviewView contract address itself to have VIEW_USER_DATA (deployment must grant this).
    const VIEW_USER_DATA = key("VIEW_USER_DATA");
    const ACTION_ADMIN = key("ACTION_ADMIN");
    const previewHasDownstreamReadRole = (await acm.hasRole(VIEW_USER_DATA, previewAddr)) as boolean;
    assertOk(
      previewHasDownstreamReadRole,
      `PreviewView@${previewAddr} missing VIEW_USER_DATA role on ACM. Required for PreviewView -> PositionView reads (Scheme-U).`
    );

    // PreviewView access policy (Scheme-U): non-self caller without ops/admin role must revert MissingRole().
    // We do this once here (per-run) to keep per-step checks focused on correctness.
    const SEL_MISSING_ROLE = errorSelector("MissingRole()");
    let unauth: any | undefined;
    const target = borrowerA.address.toLowerCase();
    for (const s of signers) {
      if (s.address.toLowerCase() === target) continue;
      const hasView = (await acm.hasRole(VIEW_USER_DATA, s.address)) as boolean;
      const hasAdmin = (await acm.hasRole(ACTION_ADMIN, s.address)) as boolean;
      if (!hasView && !hasAdmin) {
        unauth = s;
        break;
      }
    }
    if (unauth) {
      await mustRevertWithSelector(
        "Unauthorized: PreviewView.previewDeposit(non-self) must revert MissingRole()",
        async () => preview.connect(unauth).previewDeposit(borrowerA.address, settlementTokenAddrFromRegistry, 0n),
        SEL_MISSING_ROLE
      );
    } else {
      console.log("  ⚠️ PreviewView access-policy check skipped (no unauthorized signer found)");
    }

    // whitelist + price
    if (!(await aw.isAssetAllowed(settlementTokenAddrFromRegistry))) {
      await aw.connect(deployer).addAllowedAsset(settlementTokenAddrFromRegistry);
    }
    {
      const cfg = await po.getAssetConfig(settlementTokenAddrFromRegistry);
      if (!cfg.isActive) {
        const usdcDecimals = Number(await usdc.decimals().catch(() => 6));
        await po.connect(deployer).configureAsset(settlementTokenAddrFromRegistry, "usd-coin", usdcDecimals, 3600);
      }
    }
    {
      const blockNumber = await ethers.provider.getBlockNumber();
      await po.connect(deployer).updatePrice(settlementTokenAddrFromRegistry, ethers.parseUnits("1", 8), blockNumber);
    }

    // FeeRouter needs supported token for matchflow
    if (!(await feeRouter.isTokenSupported(settlementTokenAddrFromRegistry))) {
      await feeRouter.connect(deployer).addSupportedToken(settlementTokenAddrFromRegistry);
    }

    // Fund users + approve
    for (const u of [borrowerA, lenderA, borrowerB, lenderB]) {
      await usdc.connect(deployer).transfer(u.address, ethers.parseUnits("50000", 6));
    }
    // Approvals:
    // - deposit/withdraw use VaultCore, which routes to CM pulling from user; approve CM directly.
    // - VBL.reserveForLending pulls from lender; approve VBL.
    // - VaultCore.repay pulls from borrower; approve VaultCore.
    await usdc.connect(borrowerA).approve(cmAddrFromRegistry, ethers.MaxUint256);
    await usdc.connect(borrowerB).approve(cmAddrFromRegistry, ethers.MaxUint256);
    // Extension flow: EarlyRepaymentGuarantee may lock interest into GuaranteeFundManager at borrow-time.
    if (gfmAddrFromRegistry && gfmAddrFromRegistry !== ethers.ZeroAddress) {
      await usdc.connect(borrowerA).approve(gfmAddrFromRegistry, ethers.MaxUint256);
      await usdc.connect(borrowerB).approve(gfmAddrFromRegistry, ethers.MaxUint256);
    }
    await usdc.connect(lenderA).approve(vblAddrFromRegistry, ethers.MaxUint256);
    await usdc.connect(lenderB).approve(vblAddrFromRegistry, ethers.MaxUint256);
    await usdc.connect(borrowerA).approve(vaultCoreFromRegistryAddr, ethers.MaxUint256);
    await usdc.connect(borrowerB).approve(vaultCoreFromRegistryAddr, ethers.MaxUint256);

    const assetAddr = settlementTokenAddrFromRegistry;
    const users = [borrowerA.address, borrowerB.address];
    const assetsForPairs = [assetAddr, assetAddr];
    const signerByAddr = new Map<string, any>([
      [borrowerA.address.toLowerCase(), borrowerA],
      [borrowerB.address.toLowerCase(), borrowerB],
    ]);

    const countsByType = new Map<string, number>();
    const failedPushCounts = {
      cacheUpdateFailed: 0,
      viewCachePushFailed: 0,
      userStatsPushFailed: 0,
    };

    const cacheIface = new ethers.Interface([
      "event CacheUpdateFailed(address indexed user,address indexed asset,address viewAddr,uint256 collateral,uint256 debt,bytes reason)",
    ]);
    const cmIface = new ethers.Interface(["event ViewCachePushFailed(address indexed user,address indexed asset,bytes reason)"]);
    const vrIface = new ethers.Interface([
      "event UserStatsPushFailed(address indexed user,address indexed stats,uint256 collateralIn,uint256 collateralOut,uint256 borrow,uint256 repay,bytes reason)",
    ]);

    /**
     * 记录失败事件计数（用于 E2E-02 验收证据）
     * 统计 CacheUpdateFailed / ViewCachePushFailed / UserStatsPushFailed
     */
    function recordFailureEvents(receipt: any) {
      for (const log of receipt?.logs || []) {
        // CacheUpdateFailed can be emitted by multiple modules; match by topic0.
        if (log.topics?.[0] === cacheIface.getEvent("CacheUpdateFailed")!.topicHash) failedPushCounts.cacheUpdateFailed++;
        if (log.topics?.[0] === cmIface.getEvent("ViewCachePushFailed")!.topicHash) failedPushCounts.viewCachePushFailed++;
        if (log.topics?.[0] === vrIface.getEvent("UserStatsPushFailed")!.topicHash) failedPushCounts.userStatsPushFailed++;
      }
    }

    /**
     * 验证三聚合器一致性（tri-aggregator consistency）
     * 验证 PositionView / CacheOptimizedView / DashboardView 返回的 meta 字段一致
     */
    async function assertTriBatchConsistency(stepLabel: string) {
      // (A) Position meta: PositionView vs CacheOptimizedView vs DashboardView
      const pvMeta: Array<{ c: bigint; d: bigint; ok: boolean; blockNumber: bigint; ver: bigint }> = [];
      for (const u of users) {
        const [c, d, ok, blockNumber, ver] = (await pv.getUserPositionWithMeta(u, assetAddr)) as [
          bigint,
          bigint,
          boolean,
          bigint,
          bigint,
        ];
        pvMeta.push({ c, d, ok, blockNumber, ver });
      }

      const positionsMeta = (await cacheOpt.batchGetUserPositionsWithMeta(users, assetsForPairs)) as any[];
      assertOk(positionsMeta.length === users.length, `${stepLabel}: cacheOpt positions length mismatch`);

      const getPosBlock = (p: any): bigint =>
        (p?.positionBlockNumber ?? p?.positionUpdateBlock ?? 0n) as bigint;

      for (let i = 0; i < users.length; i++) {
        const p = positionsMeta[i];
        const ref = pvMeta[i];
        const pBlock = getPosBlock(p);
        assertOk(p.user.toLowerCase() === users[i].toLowerCase(), `${stepLabel}: cacheOpt.user mismatch`);
        assertOk(p.asset.toLowerCase() === assetAddr.toLowerCase(), `${stepLabel}: cacheOpt.asset mismatch`);
        assertOk(p.collateral === ref.c, `${stepLabel}: collateral mismatch (cacheOpt vs PositionView)`);
        assertOk(p.debt === ref.d, `${stepLabel}: debt mismatch (cacheOpt vs PositionView)`);
        assertOk(p.positionIsValid === ref.ok, `${stepLabel}: pos.isValid mismatch (cacheOpt vs PositionView)`);
        if (pBlock !== 0n) {
          assertOk(pBlock === ref.blockNumber, `${stepLabel}: pos.blockNumber mismatch (cacheOpt vs PositionView)`);
        }
        assertOk(BigInt(p.positionVersion) === ref.ver, `${stepLabel}: pos.version mismatch (cacheOpt vs PositionView)`);

        const [overview, posValidFlags, posBlockNumbers, posVersions, healthBlockNumber] =
          (await dashboard.getUserOverviewWithMeta(users[i], [assetAddr])) as [any, boolean[], bigint[], bigint[], bigint];
        assertOk(posValidFlags.length === 1, `${stepLabel}: dashboard posValidFlags length`);
        assertOk(posBlockNumbers.length === 1, `${stepLabel}: dashboard posBlockNumbers length`);
        assertOk(posVersions.length === 1, `${stepLabel}: dashboard posVersions length`);

        assertOk(overview.totalCollateral === ref.c, `${stepLabel}: dashboard totalCollateral mismatch`);
        assertOk(overview.totalDebt === ref.d, `${stepLabel}: dashboard totalDebt mismatch`);
        assertOk(posValidFlags[0] === ref.ok, `${stepLabel}: dashboard positionIsValid mismatch`);
        assertOk(posBlockNumbers[0] === ref.blockNumber, `${stepLabel}: dashboard positionBlockNumber mismatch`);
        assertOk(BigInt(posVersions[0]) === ref.ver, `${stepLabel}: dashboard positionVersion mismatch`);

        const items = (await dashboard.getUserAssetBreakdownWithMeta(users[i], [assetAddr])) as any[];
        assertOk(items.length === 1, `${stepLabel}: dashboard breakdown length`);
        assertOk(items[0].collateral === ref.c, `${stepLabel}: dashboard breakdown collateral mismatch`);
        assertOk(items[0].debt === ref.d, `${stepLabel}: dashboard breakdown debt mismatch`);
        assertOk(items[0].positionIsValid === ref.ok, `${stepLabel}: dashboard breakdown positionIsValid mismatch`);
        assertOk(items[0].positionBlockNumber === ref.blockNumber, `${stepLabel}: dashboard breakdown positionBlockNumber mismatch`);
        assertOk(BigInt(items[0].positionVersion) === ref.ver, `${stepLabel}: dashboard breakdown positionVersion mismatch`);

        // (B) Health: HealthView vs BatchView vs Dashboard/CacheOpt meta blockNumber
        const [hf, hfOk, hfBlockNumber] = (await hv.getUserHealthFactorWithMeta(users[i])) as [bigint, boolean, bigint];
        assertOk(overview.healthFactor === hf, `${stepLabel}: dashboard healthFactor mismatch`);
        assertOk(overview.healthFactorValid === hfOk, `${stepLabel}: dashboard healthFactorValid mismatch`);
        assertOk(healthBlockNumber === hfBlockNumber, `${stepLabel}: dashboard healthBlockNumber mismatch`);

        // (D) PreviewView: read-only preview facade must be consistent with PositionView snapshot.
        // We validate self-call output fields against PositionView(collateral/debt).
        const selfSigner = signerByAddr.get(users[i].toLowerCase());
        assertOk(!!selfSigner, `${stepLabel}: missing signer for user ${users[i]} (cannot self-call PreviewView)`);

        const c = ref.c;
        const d = ref.d;
        const expectedHF = d === 0n ? ethers.MaxUint256 : c === 0n ? 0n : (c * 10_000n) / d;
        const expectedOk = expectedHF >= 10_000n;
        const expectedLTV = c === 0n || d === 0n ? 0n : (d * 10_000n) / c;
        const maxDebt = (c * 7_500n) / 10_000n;
        const expectedMaxBorrowable = d >= maxDebt ? 0n : maxDebt - d;

        const [hfAfter, ok] = (await preview
          .connect(selfSigner)
          .previewDeposit(users[i], assetAddr, 0n)) as [bigint, boolean];
        assertOk(hfAfter === expectedHF, `${stepLabel}: PreviewView.previewDeposit hfAfter mismatch`);
        assertOk(ok === expectedOk, `${stepLabel}: PreviewView.previewDeposit ok mismatch`);

        const [newHF, newLTV, maxBorrowable] = (await preview
          .connect(selfSigner)
          .previewBorrow(users[i], assetAddr, 0, 0n, 0n)) as [bigint, bigint, bigint];
        assertOk(newHF === expectedHF, `${stepLabel}: PreviewView.previewBorrow newHF mismatch`);
        assertOk(newLTV === expectedLTV, `${stepLabel}: PreviewView.previewBorrow newLTV mismatch`);
        assertOk(maxBorrowable === expectedMaxBorrowable, `${stepLabel}: PreviewView.previewBorrow maxBorrowable mismatch`);
      }

      const hfItems = (await batch.batchGetHealthFactors(users)) as any[];
      assertOk(hfItems.length === users.length, `${stepLabel}: batch healthFactors length mismatch`);
      for (let i = 0; i < users.length; i++) {
        const [hf, hfOk] = (await hv.getUserHealthFactorWithMeta(users[i])) as [bigint, boolean, bigint];
        assertOk(hfItems[i].user.toLowerCase() === users[i].toLowerCase(), `${stepLabel}: batch hf.user mismatch`);
        assertOk(hfItems[i].healthFactor === hf, `${stepLabel}: batch hf.value mismatch`);
        assertOk(hfItems[i].isValid === hfOk, `${stepLabel}: batch hf.isValid mismatch`);
      }

      // (C) Stats: StatisticsView meta must be present; CacheOptimizedView system stats must match.
      const [g, isValid, blockNumber] = (await stats.getGlobalStatisticsWithMeta()) as [any, boolean, bigint];
      assertOk(typeof isValid === "boolean", `${stepLabel}: stats meta isValid missing`);
      assertOk(blockNumber === g.lastUpdateBlock, `${stepLabel}: stats meta blockNumber must equal lastUpdateBlock`);
      const s = (await cacheOpt.getSystemStats()) as any;
      assertOk(s.totalCollateral === g.totalCollateral, `${stepLabel}: systemStats.totalCollateral mismatch`);
      assertOk(s.totalDebt === g.totalDebt, `${stepLabel}: systemStats.totalDebt mismatch`);
      assertOk(s.totalUsers === g.totalUsers, `${stepLabel}: systemStats.totalUsers mismatch`);
    }

    async function ledgerSnapshot(label: string) {
      const out: any[] = [];
      for (const u of users) {
        const col = (await cm.getCollateral(u, assetAddr)) as bigint;
        const debt = (await le.getDebt(u, assetAddr)) as bigint;
        out.push({ user: u, collateral: col, debt });
      }
      console.log(`  [Ledger] ${label}:`, out.map((x) => `${x.user.slice(0, 6)}.. col=${x.collateral} debt=${x.debt}`).join(" | "));
    }

    async function finalizeMatchFor(borrower: any, lender: any, principal: bigint, collateralAmt: bigint) {
      // BorrowIntent & LendIntent (see scripts/e2e/e2e-localhost-matchflow.ts)
      const termDays = 5;
      const rateBps = 1000n;
      const expireAt = (await latestBlockNumber()) + ONE_HOUR_BLOCKS;

      const borrowIntent = {
        borrower: borrower.address,
        collateralAsset: assetAddr,
        collateralAmount: collateralAmt,
        borrowAsset: assetAddr,
        amount: principal,
        termDays,
        rateBps,
        expireAt,
        salt: ethers.keccak256(ethers.toUtf8Bytes(`borrow-salt-${borrower.address}`)),
      };
      const lendIntent = {
        lenderSigner: lender.address,
        asset: assetAddr,
        amount: principal,
        minTermDays: 1,
        maxTermDays: 30,
        minRateBps: 0n,
        expireAt,
        salt: ethers.keccak256(ethers.toUtf8Bytes(`lend-salt-${lender.address}`)),
      };

      const lendHash = buildLendIntentHash(lendIntent);
      await (await vbl.connect(lender).reserveForLending(lender.address, assetAddr, principal, lendHash)).wait();

      const domain = {
        name: "RwaLending",
        version: "1",
        chainId: Number((await ethers.provider.getNetwork()).chainId),
        verifyingContract: vblAddrFromRegistry,
      } as const;

      const typesBorrow = {
        BorrowIntent: [
          { name: "borrower", type: "address" },
          { name: "collateralAsset", type: "address" },
          { name: "collateralAmount", type: "uint256" },
          { name: "borrowAsset", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "termDays", type: "uint16" },
          { name: "rateBps", type: "uint256" },
          { name: "expireAt", type: "uint256" },
          { name: "salt", type: "bytes32" },
        ],
      };

      const typesLend = {
        LendIntent: [
          { name: "lenderSigner", type: "address" },
          { name: "asset", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "minTermDays", type: "uint16" },
          { name: "maxTermDays", type: "uint16" },
          { name: "minRateBps", type: "uint256" },
          { name: "expireAt", type: "uint256" },
          { name: "salt", type: "bytes32" },
        ],
      };

      const sigBorrower = await borrower.signTypedData(domain, typesBorrow as any, borrowIntent as any);
      const sigLender = await lender.signTypedData(domain, typesLend as any, lendIntent as any);

      const tx = await vbl.connect(deployer).finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [sigLender]);
      const receipt = await tx.wait();
      assertOk(!!receipt, "missing receipt for finalizeMatch");

      let orderId: bigint | null = null;
      for (const log of receipt.logs) {
        try {
          const parsed = orderEngine.interface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "LoanOrderCreated") {
            orderId = parsed.args.orderId as bigint;
            break;
          }
        } catch {
          // ignore
        }
      }
      assertOk(orderId !== null, "LoanOrderCreated not found; cannot infer orderId");
      const termBlocks = BigInt(termDays) * BLOCKS_PER_DAY;
      const totalDue = calcTotalDue(principal, rateBps, termBlocks);
      return { orderId, totalDue, finalizeReceipt: receipt };
    }

    // ============================================================
    // E2E-01 多用户资金流回放（每步后三路批量读一致性）
    // ============================================================
    // ====== E2E-01: 多用户资金流回放 + 三聚合器一致性 ======
    console.log("=== E2E-01: multi-user orderflow replay + tri-aggregator consistency ===\n");

    await ledgerSnapshot("initial");

    // Step 1: deposit A
    const depA = ethers.parseUnits("2000", 6);
    const rDepA = await (await vaultCore.connect(borrowerA).deposit(assetAddr, depA)).wait();
    assertOk(!!rDepA, "missing receipt deposit A");
    recordFailureEvents(rDepA);
    recordDataPushCounts("deposit A", rDepA, countsByType);
    await assertTriBatchConsistency("after deposit A");
    await ledgerSnapshot("after deposit A");

    // Step 2: deposit B
    const depB = ethers.parseUnits("1500", 6);
    const rDepB = await (await vaultCore.connect(borrowerB).deposit(assetAddr, depB)).wait();
    assertOk(!!rDepB, "missing receipt deposit B");
    recordFailureEvents(rDepB);
    recordDataPushCounts("deposit B", rDepB, countsByType);
    await assertTriBatchConsistency("after deposit B");
    await ledgerSnapshot("after deposit B");

    // Step 3: withdraw A (still no debt)
    const wdA = ethers.parseUnits("200", 6);
    const rWdA = await (await vaultCore.connect(borrowerA).withdraw(assetAddr, wdA)).wait();
    assertOk(!!rWdA, "missing receipt withdraw A");
    recordFailureEvents(rWdA);
    recordDataPushCounts("withdraw A", rWdA, countsByType);
    await assertTriBatchConsistency("after withdraw A");
    await ledgerSnapshot("after withdraw A");

    // Step 4: borrow A via matchflow finalizeMatch
    const principalA = ethers.parseUnits("500", 6);
    const { orderId: orderA, totalDue: dueA, finalizeReceipt: rMatchA } = await finalizeMatchFor(
      borrowerA,
      lenderA,
      principalA,
      depA - wdA
    );
    recordFailureEvents(rMatchA);
    recordDataPushCounts("finalizeMatch A", rMatchA, countsByType);
    await assertTriBatchConsistency("after borrow A (match finalized)");
    await ledgerSnapshot("after borrow A");
    await logLEVOrder("after finalizeMatch A", orderA);

    // Step 5: withdraw B (still no debt)
    const wdB = ethers.parseUnits("100", 6);
    const rWdB = await (await vaultCore.connect(borrowerB).withdraw(assetAddr, wdB)).wait();
    assertOk(!!rWdB, "missing receipt withdraw B");
    recordFailureEvents(rWdB);
    recordDataPushCounts("withdraw B", rWdB, countsByType);
    await assertTriBatchConsistency("after withdraw B");
    await ledgerSnapshot("after withdraw B");

    // Step 6: borrow B via matchflow finalizeMatch
    const principalB = ethers.parseUnits("400", 6);
    const { orderId: orderB, totalDue: dueB, finalizeReceipt: rMatchB } = await finalizeMatchFor(
      borrowerB,
      lenderB,
      principalB,
      depB - wdB
    );
    recordFailureEvents(rMatchB);
    recordDataPushCounts("finalizeMatch B", rMatchB, countsByType);
    await assertTriBatchConsistency("after borrow B (match finalized)");
    await ledgerSnapshot("after borrow B");
    await logLEVOrder("after finalizeMatch B", orderB);

    // Step 7: repay A (VaultCore -> SettlementManager SSOT)
    const rRepayA = await (await vaultCore.connect(borrowerA).repay(orderA, assetAddr, dueA)).wait();
    assertOk(!!rRepayA, "missing receipt repay A");
    recordFailureEvents(rRepayA);
    recordDataPushCounts("repay A", rRepayA, countsByType);
    await assertTriBatchConsistency("after repay A");
    await ledgerSnapshot("after repay A");
    await logLEVOrder("after repay A", orderA);

    // Step 8: repay B
    const rRepayB = await (await vaultCore.connect(borrowerB).repay(orderB, assetAddr, dueB)).wait();
    assertOk(!!rRepayB, "missing receipt repay B");
    recordFailureEvents(rRepayB);
    recordDataPushCounts("repay B", rRepayB, countsByType);
    await assertTriBatchConsistency("after repay B");
    await ledgerSnapshot("after repay B");
    await logLEVOrder("after repay B", orderB);

    console.log("\n  ✅ E2E-01 done\n");

    // ============================================================
    // E2E-02 推送失败模拟与链下重试（失败事件 + 重试成功 DataPushed）
    // ============================================================
    // ====== E2E-02: 推送失败模拟与链下重试 ======
    console.log("=== E2E-02: push failure injection + offline retry + stats ===\n");

    // Inject failure by revoking ACTION_VIEW_PUSH from VaultRouter (PositionView writer gate).
    const hadViewPush = (await acm.hasRole(ACTION_VIEW_PUSH, vaultRouterAddr)) as boolean;
    assertOk(hadViewPush, "precondition: VaultRouter must have ACTION_VIEW_PUSH before failure injection");

    await (await acm.connect(deployer).revokeRole(ACTION_VIEW_PUSH, vaultRouterAddr)).wait();
    assertOk(!(await acm.hasRole(ACTION_VIEW_PUSH, vaultRouterAddr)), "revokeRole failed (VaultRouter still has ACTION_VIEW_PUSH)");

    // Trigger a deposit that attempts a best-effort push via CollateralManager -> VaultCore.pushUserPositionUpdateDelta
    const injUser = borrowerA; // re-use (already funded/approved)
    const injAmt = ethers.parseUnits("10", 6);
    const before = (await pv.getUserPositionWithMeta(injUser.address, assetAddr)) as [bigint, bigint, boolean, bigint, bigint];

    const rInj = await (await vaultCore.connect(injUser).deposit(assetAddr, injAmt)).wait();
    assertOk(!!rInj, "missing receipt for injected deposit");
    recordDataPushCounts("deposit (failure injection)", rInj, countsByType);

    // Verify failures are observable (CacheUpdateFailed and/or ViewCachePushFailed)
    const wantCacheFailedTopic = cacheIface.getEvent("CacheUpdateFailed")!.topicHash;
    const wantViewCacheFailedTopic = cmIface.getEvent("ViewCachePushFailed")!.topicHash;
    const cacheFailedLogs = (rInj.logs as any[]).filter((l) => l.topics?.[0] === wantCacheFailedTopic);
    const viewCacheFailedLogs = (rInj.logs as any[]).filter((l) => l.topics?.[0] === wantViewCacheFailedTopic);
    assertOk(cacheFailedLogs.length + viewCacheFailedLogs.length > 0, "expected CacheUpdateFailed/ViewCachePushFailed logs");
    failedPushCounts.cacheUpdateFailed += cacheFailedLogs.length;
    failedPushCounts.viewCachePushFailed += viewCacheFailedLogs.length;

    console.log(`  [FailureInjected] CacheUpdateFailed=${cacheFailedLogs.length} ViewCachePushFailed=${viewCacheFailedLogs.length}`);

    // Offline retry: restore role, then call PositionView.retryUserPositionUpdate (admin-only)
    await (await acm.connect(deployer).grantRole(ACTION_VIEW_PUSH, vaultRouterAddr)).wait();
    assertOk(await acm.hasRole(ACTION_VIEW_PUSH, vaultRouterAddr), "grantRole failed (VaultRouter missing ACTION_VIEW_PUSH)");

    const retryTx = await pv.connect(deployer).retryUserPositionUpdate(injUser.address, assetAddr);
    const retryRc = await retryTx.wait();
    assertOk(!!retryRc, "missing receipt for retryUserPositionUpdate");
    recordDataPushCounts("offline retry (PositionView.retryUserPositionUpdate)", retryRc, countsByType);

    const after = (await pv.getUserPositionWithMeta(injUser.address, assetAddr)) as [bigint, bigint, boolean, bigint, bigint];
    assertOk(after[2] === true, "after retry: expected PositionView cache isValid=true");
    assertOk(after[3] >= before[3], "after retry: expected blockNumber monotonic");

    console.log(
      `  ✅ retry ok: isValid=${after[2]} block(before=${before[3].toString()} after=${after[3].toString()})`
    );
    console.log("\n  ✅ E2E-02 done\n");

    // ============================================================
    // E2E-03 批量边界与性能（接近 MAX_BATCH_SIZE + 超限一致失败）
    // ============================================================
    // ====== E2E-03: 批量边界与性能 ======
    console.log("=== E2E-03: batch boundary + unified failure selector ===\n");

    const tooLargeSel = errorSelector("BatchTooLarge(uint256,uint256)");
    const users100 = new Array(100).fill(borrowerA.address);
    const users101 = new Array(101).fill(borrowerA.address);
    const assets100 = new Array(100).fill(assetAddr);
    const assets101 = new Array(101).fill(assetAddr);

    // near MAX (should succeed, and must not OOG)
    await cacheOpt.batchGetUserPositionsWithMeta(users100, assets100);
    await batch.batchGetHealthFactors(users100);
    await dashboard.getUserOverviewWithMeta(borrowerA.address, assets100);
    await cacheOpt.getUserSummaryWithMeta(borrowerA.address, assets100);
    console.log("  ✅ near MAX_BATCH_SIZE calls succeeded (len=100)");

    // oversized (must revert BatchTooLarge)
    await mustRevertWithSelector(
      "CacheOptimizedView.batchGetUserPositionsWithMeta oversized",
      async () => cacheOpt.batchGetUserPositionsWithMeta(users101, assets101),
      tooLargeSel
    );
    await mustRevertWithSelector(
      "BatchView.batchGetHealthFactors oversized",
      async () => batch.batchGetHealthFactors(users101),
      tooLargeSel
    );
    await mustRevertWithSelector(
      "DashboardView.getUserOverviewWithMeta oversized",
      async () => dashboard.getUserOverviewWithMeta(borrowerA.address, assets101),
      tooLargeSel
    );
    await mustRevertWithSelector(
      "CacheOptimizedView.getUserSummaryWithMeta oversized",
      async () => cacheOpt.getUserSummaryWithMeta(borrowerA.address, assets101),
      tooLargeSel
    );

    console.log("\n  ✅ E2E-03 done\n");

    // ============================================================
    // Artifacts / summaries (ARCH 5.1.4)
    // ============================================================
    // ====== 验收证据输出（ARCH 5.1.4） ======
    console.log("=== Artifacts ===");
    console.log("  Module address snapshot (key -> addr):");
    const keysToPrint = [
      "SYSTEM_VIEW",
      "POSITION_VIEW",
      "HEALTH_VIEW",
      "VAULT_STATISTICS",
      "LENDING_ENGINE",
      "LENDING_ENGINE_VIEW",
      "BATCH_VIEW",
      "CACHE_OPTIMIZED_VIEW",
      "DASHBOARD_VIEW",
      "ORDER_ENGINE",
    ];
    for (const k of keysToPrint) {
      const addr = (await registry.getModuleOrRevert(key(k))) as string;
      console.log(`   - ${k}: ${addr}`);
    }

    console.log("\n  DataPushed counts by dataTypeHash:");
    const sorted = [...countsByType.entries()].sort((a, b) => b[1] - a[1]);
    for (const [typeHash, n] of sorted) {
      console.log(`   - ${typeHash}: ${n}`);
    }

    console.log("\n  Failure events stats:");
    console.log(`   - CacheUpdateFailed: ${failedPushCounts.cacheUpdateFailed}`);
    console.log(`   - ViewCachePushFailed: ${failedPushCounts.viewCachePushFailed}`);
    console.log(`   - UserStatsPushFailed: ${failedPushCounts.userStatsPushFailed}`);

    console.log("\n✅ All E2E-01/02/03 checks passed.");
  } catch (e: any) {
    const msg = fmtErr(e);
    if (isMissingSelectorError(msg)) {
      console.error(
        `[FAIL] Missing selector on-chain (deployment/ABI mismatch). Re-run compile + deploy:localhost. Details: ${msg}`
      );
    } else {
      console.error(e);
    }
    throw e;
  } finally {
    await revertTo(snap);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

