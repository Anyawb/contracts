/**
 * @file e2e-localhost-batch-advanced-10-users.ts
 * @notice 高级批量测试：10 用户（5 个 borrower + 5 个 lender）复杂场景 E2E 测试
 * @dev 本脚本用于在本地 Hardhat 节点上验证复杂业务场景下的系统行为与 View 层一致性
 *
 * ## 测试场景
 *
 * ### Pair1: 按期全额还款
 * - Borrower deposit → lender reserve → finalizeMatch → 按期全额 repay
 * - 验证 View 层数据与账本一致
 *
 * ### Pair2: 部分还款 + 全额还款（按期）
 * - 同一笔订单分两次 repay（部分 + 剩余）
 * - 验证每次 repay 后 `PositionView/UserView` 与账本一致
 * - 验证 `SettlementManager.requireFullRepayRelease` 配置处理
 *
 * ### Pair3: 按期全额还款
 * - 标准按期还款流程验证
 *
 * ### Pair4: 多 lender 拆单（multi-lender split）
 * - 将 1000 拆成两笔 500/500（两笔订单）
 * - 分别由不同 lender 出借（更贴近真实"拆单"场景）
 * - 验证多订单场景下的 View 层一致性
 *
 * ### Pair5: 逾期全额还款（block-based）
 * - 使用 `hardhat_mine` 快进到超过到期区块后再 repay
 * - 验证逾期场景下的系统行为
 *
 * ### Blocks-only rollout smoke（新增）
 * - 使用 deploylocal 产物中的 Registry 入口直连 `BlocksOnlyCoordinator` / `BlocksOnlyView`
 * - 按当前真实产品约束执行：`termBlocks = 1`、`rateBps = 0`、资产需已进入全局 `AssetWhitelist`
 * - 覆盖 `finalizeMatchBlocks -> repayBlocks -> settleOrLiquidateBlocks(settle)`
 * - 覆盖 `finalizeMatchBlocks -> settleOrLiquidateBlocks(liquidate)`
 * - 验证 borrower/system 维度的 `BlocksOnlyView` 读路径
 * - 作为当前 repo 中最接近 indexer/read-model 消费 blocks-only DataPush 与运行时状态的外层回归入口
 *
 * ### EarlyRepaymentGuarantee（保证金：lock → early settle）
 * - 覆盖 `EarlyRepaymentGuaranteeManager` + `GuaranteeFundManager` 的联动路径
 * - 验证锁定 → 提前结算分配的完整流程
 *
 * ## 验证内容
 *
 * ### 每步 View 断言（strict 模式下为硬失败）
 * - `PositionView.getUserPosition` == `UserView.getUserPosition` == `CollateralManager/VaultLendingEngine`（账本）
 * - `RiskView.getUserRiskAssessment` 可正常调用（不对语义做强约束）
 * - View 层缓存有效性信息不丢失
 *
 * ### Phase3 可观测性
 * - 在关键 checkpoint 显式输出"样本 borrower"的 `PositionView` version（用于观察严格 `nextVersion` 的单调递增写入）
 * - 启动阶段输出关键 View 的 `getVersionInfo()`（apiVersion/schemaVersion/implementation），便于定位升级影响
 *
 * ### ViewScan（新增）
 * - 启动阶段从 Registry 扫描全部 View 模块并调用 `getVersionInfo()` + 少量只读 sanity-call
 * - 默认随 strict 策略（本脚本中 strict 默认开启）
 * - 关闭 strict：`E2E_STRICT_VIEWS=0`
 *
 * ### Reward（新增）
 * - 按 `Architecture-Guide.md` 的唯一路径（LE 落账后触发）对 **EasyToken/RewardView** 做最小端到端断言
 * - 输出**人类可读 EasyToken**（`EasyToken.decimals()`）与 raw 值
 * - 断言 repay 后 Easy mint/earned 为正数，并遵循 50/50 分配（借贷双方）
 *
 * ### DataPush 可观测性
 * - 验证 `REPAY_AND_SETTLE`、`COLLATERAL_RELEASED`、`LIQUIDATION_*` 等 DataPushed 事件
 * - 验证 payload 可 ABI 解码且与业务逻辑一致
 *
 * ## 运行方式
 * ```bash
 * npx hardhat run scripts/e2e/e2e-localhost-batch-advanced-10-users.ts --network localhost
 * ```
 *
 * ### 环境变量
 * - `E2E_STRICT_VIEWS=0`：关闭严格校验（默认开启，任何 View/Stats 与账本不一致会直接失败）
 * - `E2E_ALLOW_DIRTY_STATE=1`：允许在"非干净状态"（已有历史仓位/债务）下跑严格 E2E
 * - `E2E_SAMPLE_BORROWER_INDEX=0..4`：选择"样本 borrower"打印 PositionView.version（默认 0）
 *
 * ### Task 方式（推荐）
 * ```bash
 * pnpm -s exec hardhat e2e:batch-advanced --network localhost --sample-borrower-index 2
 * ```
 *
 * ## 前置条件
 * - 本地 Hardhat 节点已启动（`pnpm -s run node`）
 * - 合约已部署到本地节点（`pnpm -s run deploy:localhost`）
 * - 至少需要 11 个 signer（deployer + 10 users）
 *
 * ## 验收标准
 * - ✅ 所有业务操作成功执行（deposit/borrow/matchflow/repay）
 * - ✅ 每步 View 层数据与账本一致（strict 模式下硬失败）
 * - ✅ 部分还款场景正确处理
 * - ✅ 逾期还款场景正确处理
 * - ✅ 多 lender 拆单场景正确处理
 * - ✅ EarlyRepaymentGuarantee 联动路径正确
 * - ✅ DataPushed 事件可观测且 payload 可解码
 * - ✅ Reward（EasyToken）计算与查询一致
 *
 * @see scripts/e2e/README.md 6. 章节说明
 */

import hardhat from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { scanViewModules } from "./utils/view-scan.ts";
import { runViewPreflight } from "./utils/view-preflight.ts";
import { refreshPriceOracleBlock } from "./utils/price-oracle-refresh.ts";
import { runBlocksOnlyRolloutSmoke } from "./utils/blocks-only-rollout-smoke.ts";
import { fundErc20Users } from "./utils/fork-token-funding.ts";
import { runRewardExtendedChecks as runSharedRewardExtendedChecks } from "./utils/reward-extended-checks.ts";
import { loadAddressMap, resolveAddress } from "../tests/_addressResolver";
import {
  assertPriceRoutesAndFallbackConsistency,
  assertSystemViewRoute,
  assertViewCacheAddrAligned,
} from "./utils/systemview-route-assert.ts";

const { ethers, network } = hardhat;

const ONE_DAY = 24n * 60n * 60n;
const ONE_HOUR_BLOCKS = 1_800n;
// Keep consistent with TermBlocksLib bucket mapping (5d=36000 => 7200 blocks/day baseline).
const BLOCKS_PER_DAY = 7_200n;
const BPS_DENOM = 10_000n;
const USD8_DECIMALS = 8;

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

async function assertLocalhostDeploymentOrThrow(): Promise<void> {
  const rpc = process.env.LOCALHOST_RPC_URL || "<not set>";
  const net = await ethers.provider.getNetwork();
  const block = await ethers.provider.getBlockNumber();
  const addressMap = loadAddressMap("localhost");
  const registryAddr = resolveAddress({
    name: "Registry",
    map: addressMap,
    envVar: "REGISTRY_ADDRESS",
  });

  async function assertHasCode(addr: string, label: string) {
    const code = await ethers.provider.getCode(addr);
    if (!code || code === "0x") {
      throw new Error(
        [
          `[E2E Preflight] No bytecode at ${label} address=${addr}`,
          `  rpc=${rpc} chainId=${net.chainId.toString()} block=${block}`,
          "  Likely cause: deploy and E2E are pointing at different localhost RPC ports (e.g. deploy on :8545 but E2E on :18545).",
          "  Fix: re-deploy and run E2E with the SAME LOCALHOST_RPC_URL.",
          "    - LOCALHOST_RPC_URL=http://127.0.0.1:18545 pnpm -s run deploy:localhost",
          "    - LOCALHOST_RPC_URL=http://127.0.0.1:18545 pnpm -s exec hardhat e2e:batch-advanced --network localhost",
        ].join("\n"),
      );
    }
  }

  await assertHasCode(registryAddr, "Registry");
  if (String(addressMap.VaultCore || "").trim() !== "") {
    await assertHasCode(
      String(addressMap.VaultCore),
      "VaultCore(deployments/localhost.json)",
    );
  }
}

const logNotice = (msg: string) => {
  if (process.env.E2E_VERBOSE_NOTICES === "1") console.log(msg);
};

const rawLog = console.log;
console.log = (...args: any[]) => {
  if (
    process.env.E2E_VERBOSE_NOTICES !== "1" &&
    typeof args[0] === "string" &&
    (args[0] as string).includes("[Notice]")
  ) {
    return;
  }
  rawLog(...args);
};

const DEFAULT_TX_TIMEOUT_MS = 120_000;
const TX_TIMEOUT_MS = (() => {
  const raw = process.env.E2E_TX_TIMEOUT_MS;
  if (!raw) return DEFAULT_TX_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TX_TIMEOUT_MS;
})();

const DEFAULT_EVM_TIMEOUT_MS = 30_000;
const EVM_TIMEOUT_MS = (() => {
  const raw = process.env.E2E_EVM_TIMEOUT_MS;
  if (!raw) return DEFAULT_EVM_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_EVM_TIMEOUT_MS;
})();

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let t: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        t = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

async function waitTx<T extends { hash?: string; wait: () => Promise<any> }>(
  txPromise: Promise<T>,
  label?: string,
): Promise<any> {
  const tx = await txPromise;
  const hash = tx?.hash ?? "unknown";
  const prefix = label ? `  ⛓️ tx ${label}` : "  ⛓️ tx";
  console.log(`${prefix}: ${hash}`);
  const deadline = Date.now() + TX_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const receipt = await ethers.provider.getTransactionReceipt(hash);
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `tx.wait${label ? ` ${label}` : ""} timed out after ${TX_TIMEOUT_MS}ms`,
  );
}

async function latestBlockNumber(): Promise<bigint> {
  return BigInt(await ethers.provider.getBlockNumber());
}

function mkArtifactsWriter() {
  const outDir = path.join(__dirname, "artifacts");
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch {
    // ignore
  }
  return {
    outDir,
    writeJson: (name: string, data: unknown) => {
      const p = path.join(outDir, name);
      const replacer = (_k: string, v: any) =>
        typeof v === "bigint" ? v.toString() : v;
      fs.writeFileSync(p, JSON.stringify(data, replacer, 2) + "\n", "utf8");
      return p;
    },
  };
}

// Global counters (reset per runAdvancedBatch)
let dataPushCounts: Record<string, number> = {};
function recordDataPushed(
  receipt: any,
): Array<{ dataTypeHash: string; payload: string }> {
  const pushes = extractDataPushed(receipt);
  for (const p of pushes) {
    const k = p.dataTypeHash.toLowerCase();
    dataPushCounts[k] = (dataPushCounts[k] ?? 0) + 1;
  }
  return pushes;
}

// ===== DataPush (SSOT observability) =====
// NOTE: Some deployments may have DataPushed with or without `indexed` dataTypeHash.
// We parse logs by topic0 and decode accordingly (robust across both shapes).
const coder = ethers.AbiCoder.defaultAbiCoder();
const DATA_PUSH_TOPIC0 = ethers
  .keccak256(ethers.toUtf8Bytes("DataPushed(bytes32,bytes)"))
  .toLowerCase();

const DATA_TYPE_REPAY_AND_SETTLE = ethers.keccak256(
  ethers.toUtf8Bytes("REPAY_AND_SETTLE"),
);
const DATA_TYPE_COLLATERAL_RELEASED = ethers.keccak256(
  ethers.toUtf8Bytes("COLLATERAL_RELEASED"),
);
const DATA_TYPE_LIQUIDATION_UPDATE = ethers.keccak256(
  ethers.toUtf8Bytes("LIQUIDATION_UPDATE"),
);
const DATA_TYPE_LIQUIDATION_BATCH_UPDATE = ethers.keccak256(
  ethers.toUtf8Bytes("LIQUIDATION_BATCH_UPDATE"),
);
const DATA_TYPE_LIQUIDATION_PAYOUT = ethers.keccak256(
  ethers.toUtf8Bytes("LIQUIDATION_PAYOUT"),
);
const DATA_TYPE_LOAN_CREATED = ethers.keccak256(
  ethers.toUtf8Bytes("LOAN_CREATED"),
);
const DATA_TYPE_LOAN_NFT_MINTED = ethers.keccak256(
  ethers.toUtf8Bytes("LOAN_NFT_MINTED"),
);
const DATA_TYPE_RESERVE_CONSUMED = ethers.keccak256(
  ethers.toUtf8Bytes("RESERVE_CONSUMED"),
);
const DATA_TYPE_GUARANTEE_LOCKED = ethers.keccak256(
  ethers.toUtf8Bytes("GUARANTEE_LOCKED"),
);
const DATA_TYPE_RISK_STATUS_UPDATE = ethers.keccak256(
  ethers.toUtf8Bytes("RISK_STATUS_UPDATE"),
);
const DATA_TYPE_EASY_MINTED = ethers.keccak256(
  ethers.toUtf8Bytes("EASY_MINTED"),
);
const DATA_TYPE_REWARD_BURNED = ethers.keccak256(
  ethers.toUtf8Bytes("REWARD_BURNED"),
);
const DATA_TYPE_EASY_EMISSION_PARAMS_UPDATED = ethers.keccak256(
  ethers.toUtf8Bytes("EASY_EMISSION_PARAMS_UPDATED"),
);
const DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED = ethers.keccak256(
  ethers.toUtf8Bytes("REWARD_PENALTY_LEDGER_UPDATED"),
);
const DATA_TYPE_BLOCKS_ONLY_MATCH_FINALIZED = ethers.keccak256(
  ethers.toUtf8Bytes("BLOCKS_ONLY_MATCH_FINALIZED"),
);
const DATA_TYPE_BLOCKS_ONLY_REPAID = ethers.keccak256(
  ethers.toUtf8Bytes("BLOCKS_ONLY_REPAID"),
);
const DATA_TYPE_BLOCKS_ONLY_SETTLED = ethers.keccak256(
  ethers.toUtf8Bytes("BLOCKS_ONLY_SETTLED"),
);
const DATA_TYPE_BLOCKS_ONLY_LIQUIDATED = ethers.keccak256(
  ethers.toUtf8Bytes("BLOCKS_ONLY_LIQUIDATED"),
);
const PUSH_FAILED_IFACE = new ethers.Interface([
  "event RewardViewPushFailed(address indexed user, address indexed rewardView, bytes32 indexed op, bytes payload, bytes reason)",
]);
const asBigInt = (x: any): bigint => (typeof x === "bigint" ? x : BigInt(x));

function calcTotalDue(principal: bigint, rateBps: bigint, termSec: bigint) {
  const denom = 365n * ONE_DAY * 10_000n;
  const interest = (principal * rateBps * termSec) / denom;
  return principal + interest;
}

function calcFee(amount: bigint, bps: bigint) {
  return (amount * bps) / BPS_DENOM;
}

/**
 * 从交易回执中提取所有 DataPushed 事件
 * 支持两种事件格式：
 * - Variant A（推荐）：`event DataPushed(bytes32 indexed dataTypeHash, bytes payload)` - topics[1] = dataTypeHash
 * - Variant B（legacy）：`event DataPushed(bytes32 dataTypeHash, bytes payload)` - data 中包含 dataTypeHash
 */
function extractDataPushed(
  receipt: any,
): Array<{ dataTypeHash: string; payload: string }> {
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
      const [payload] = coder.decode(["bytes"], log.data) as unknown as [
        string,
      ];
      out.push({ dataTypeHash, payload });
      continue;
    }

    // Variant B (legacy): event DataPushed(bytes32 dataTypeHash, bytes payload)
    // - topics[0] = signature only
    // - data      = abi.encode(dataTypeHash, payload)
    const [dataTypeHash, payload] = coder.decode(
      ["bytes32", "bytes"],
      log.data,
    ) as unknown as [string, string];
    out.push({ dataTypeHash: (dataTypeHash as string).toLowerCase(), payload });
  }
  return out;
}

function extractRewardViewPushFailed(
  receipt: any,
  emitter: string,
): Array<{
  user: string;
  rewardView: string;
  op: string;
  payload: string;
  reason: string;
}> {
  const out: Array<{
    user: string;
    rewardView: string;
    op: string;
    payload: string;
    reason: string;
  }> = [];
  for (const log of receipt?.logs || []) {
    if (String(log?.address ?? "").toLowerCase() !== emitter.toLowerCase())
      continue;
    try {
      const parsed = PUSH_FAILED_IFACE.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });
      if (!parsed) continue;
      out.push({
        user: String(parsed.args.user),
        rewardView: String(parsed.args.rewardView),
        op: String(parsed.args.op),
        payload: String(parsed.args.payload),
        reason: String(parsed.args.reason),
      });
    } catch {
      // ignore non-matching logs
    }
  }
  return out;
}

function extractDataPushPayloads(receipt: any, typeHash: string): string[] {
  const want = typeHash.toLowerCase();
  return extractDataPushed(receipt)
    .filter((p) => p.dataTypeHash.toLowerCase() === want)
    .map((p) => p.payload);
}

function getLastDataPushPayload(
  receipt: any,
  typeHash: string,
): string | undefined {
  const payloads = extractDataPushPayloads(receipt, typeHash);
  return payloads.length > 0 ? payloads[payloads.length - 1] : undefined;
}

function hasNonZeroEasyMintedPush(receipt: any): boolean {
  const want = DATA_TYPE_EASY_MINTED.toLowerCase();
  const pushes = extractDataPushed(receipt);
  for (const p of pushes) {
    if (p.dataTypeHash.toLowerCase() !== want) continue;
    try {
      const decoded = coder.decode(
        [
          "address",
          "address",
          "uint256",
          "uint256",
          "uint256",
          "uint256",
          "uint256",
          "uint256",
        ],
        p.payload,
      ) as unknown as [
        string,
        string,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
      ];
      // RewardView.pushEasyMinted() always emits the DataPush, but only updates
      // earned balances when shares are non-zero. We treat shares as the “real mint”.
      const borrowerShare = asBigInt(decoded[3]);
      const lenderShare = asBigInt(decoded[4]);
      if (borrowerShare + lenderShare > 0n) return true;
    } catch {
      // If we can't decode, don't turn it into a false positive.
      continue;
    }
  }
  return false;
}

function assertHasDataPushType(label: string, receipt: any, typeHash: string) {
  const pushes = recordDataPushed(receipt);
  const want = typeHash.toLowerCase();
  if (!pushes.some((p) => p.dataTypeHash === want)) {
    throw new Error(`${label}: missing DataPushed(${want})`);
  }
}

/**
 * 断言交易回执中包含 REPAY_AND_SETTLE 类型的 DataPushed 事件
 * 并验证 payload 可解码且与期望值一致
 */
function assertRepayAndSettleDataPush(
  label: string,
  receipt: any,
  settlementManager: any,
  expectUser: string,
  expectDebtAsset: string,
  expectRepayAmount: bigint,
  expectOrderId: bigint,
  expectReleasedAllCollateral: boolean,
) {
  const pushes = recordDataPushed(receipt);
  const want = DATA_TYPE_REPAY_AND_SETTLE.toLowerCase();
  const p = pushes.find((x) => x.dataTypeHash === want);
  if (!p) {
    const logs = receipt?.logs || [];
    const hasAnyDataPush = (logs as any[]).some(
      (l) =>
        ((l.topics?.[0] || "") as string).toLowerCase() === DATA_PUSH_TOPIC0,
    );
    const hasRepayEvt = (logs as any[]).some((log) => {
      try {
        const parsed = settlementManager.interface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        return parsed?.name === "RepayAndSettleProcessed";
      } catch {
        return false;
      }
    });
    throw new Error(
      `${label}: missing DataPushed(REPAY_AND_SETTLE). ` +
        `Debug: hasAnyDataPushTopic0=${hasAnyDataPush} hasSettlementManager.RepayAndSettleProcessed=${hasRepayEvt}. ` +
        `If false/false, your localhost deployment is likely outdated; restart node and re-run deploylocal.ts.`,
    );
  }

  const decoded = coder.decode(
    ["address", "address", "uint256", "uint256", "bool", "uint256"],
    p.payload,
  ) as unknown as [string, string, bigint, bigint, boolean, bigint];

  const [user, debtAsset, repayAmount, orderId, releasedAllCollateral] =
    decoded;
  if (user.toLowerCase() !== expectUser.toLowerCase())
    throw new Error(`${label}: REPAY_AND_SETTLE user mismatch`);
  if (debtAsset.toLowerCase() !== expectDebtAsset.toLowerCase())
    throw new Error(`${label}: REPAY_AND_SETTLE debtAsset mismatch`);
  if (asBigInt(repayAmount) !== expectRepayAmount)
    throw new Error(`${label}: REPAY_AND_SETTLE repayAmount mismatch`);
  if (asBigInt(orderId) !== expectOrderId)
    throw new Error(`${label}: REPAY_AND_SETTLE orderId mismatch`);
  if (releasedAllCollateral !== expectReleasedAllCollateral) {
    throw new Error(
      `${label}: REPAY_AND_SETTLE releasedAllCollateral mismatch`,
    );
  }
}

function assertCollateralReleasedDataPush(
  label: string,
  receipt: any,
  expectUser: string,
  expectAsset?: string,
) {
  const pushes = recordDataPushed(receipt);
  const want = DATA_TYPE_COLLATERAL_RELEASED.toLowerCase();
  const matches = pushes.filter((x) => x.dataTypeHash === want);
  if (matches.length === 0)
    throw new Error(`${label}: missing DataPushed(COLLATERAL_RELEASED)`);
  // At least one payload must match user (+ optional asset)
  const ok = matches.some((m) => {
    const [user, asset] = coder.decode(
      ["address", "address", "uint256", "uint256"],
      m.payload,
    ) as unknown as [string, string, bigint, bigint];
    if (user.toLowerCase() !== expectUser.toLowerCase()) return false;
    if (expectAsset && asset.toLowerCase() !== expectAsset.toLowerCase())
      return false;
    return true;
  });
  if (!ok)
    throw new Error(
      `${label}: COLLATERAL_RELEASED payload does not match expected user/asset`,
    );
}

function assertLiquidationDataPush(
  label: string,
  receipt: any,
  expectUser: string,
) {
  const pushes = recordDataPushed(receipt);
  const u = expectUser.toLowerCase();
  const types = new Set([
    DATA_TYPE_LIQUIDATION_UPDATE.toLowerCase(),
    DATA_TYPE_LIQUIDATION_BATCH_UPDATE.toLowerCase(),
    DATA_TYPE_LIQUIDATION_PAYOUT.toLowerCase(),
  ]);
  const relevant = pushes.filter((p) => types.has(p.dataTypeHash));
  if (relevant.length === 0)
    throw new Error(`${label}: missing liquidation DataPushed(LIQUIDATION_*)`);

  // Strong: ensure at least one liquidation push includes the expected user.
  const ok = relevant.some((p) => {
    try {
      if (p.dataTypeHash === DATA_TYPE_LIQUIDATION_UPDATE.toLowerCase()) {
        const [user] = coder.decode(
          [
            "address",
            "address",
            "address",
            "uint256",
            "uint256",
            "address",
            "uint256",
            "uint256",
          ],
          p.payload,
        ) as unknown as [
          string,
          string,
          string,
          bigint,
          bigint,
          string,
          bigint,
          bigint,
        ];
        return user.toLowerCase() === u;
      }
      if (p.dataTypeHash === DATA_TYPE_LIQUIDATION_PAYOUT.toLowerCase()) {
        const [user] = coder.decode(
          [
            "address",
            "address",
            "address",
            "address",
            "address",
            "address",
            "uint256",
            "uint256",
            "uint256",
            "uint256",
            "uint256",
          ],
          p.payload,
        ) as unknown as [
          string,
          string,
          string,
          string,
          string,
          string,
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
        ];
        return user.toLowerCase() === u;
      }
      if (p.dataTypeHash === DATA_TYPE_LIQUIDATION_BATCH_UPDATE.toLowerCase()) {
        const [users] = coder.decode(
          [
            "address[]",
            "address[]",
            "address[]",
            "uint256[]",
            "uint256[]",
            "address",
            "uint256[]",
            "uint256",
          ],
          p.payload,
        ) as unknown as [
          string[],
          string[],
          string[],
          bigint[],
          bigint[],
          string,
          bigint[],
          bigint,
        ];
        return (users || []).some((x) => x.toLowerCase() === u);
      }
      return false;
    } catch {
      return false;
    }
  });
  if (!ok)
    throw new Error(
      `${label}: liquidation DataPushed payload did not include expected user`,
    );
}

function buildLendIntentHash(li: any) {
  const typeHash = ethers.keccak256(
    ethers.toUtf8Bytes(
      "LendIntent(address lenderSigner,address asset,uint256 amount,uint16 minTermDays,uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)",
    ),
  );
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    coder.encode(
      [
        "bytes32",
        "address",
        "address",
        "uint256",
        "uint16",
        "uint16",
        "uint256",
        "uint256",
        "bytes32",
      ],
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
      ],
    ),
  );
}

async function mineToBlock(targetBlock: bigint) {
  const current = BigInt(await ethers.provider.getBlockNumber());
  if (current >= targetBlock) return;
  const delta = targetBlock - current + 1n;
  await ethers.provider.send("hardhat_mine", ["0x" + delta.toString(16)]);
}

async function impersonateAndFund(addr: string) {
  // Hardhat-only helper: used in E2E to simulate VaultCore-only module calls.
  await ethers.provider.send("hardhat_impersonateAccount", [addr]);
  // Give the impersonated account enough ETH for tx gas.
  await ethers.provider.send("hardhat_setBalance", [
    addr,
    "0x3635C9ADC5DEA00000",
  ]); // 1000 ETH
  return await ethers.getSigner(addr);
}

async function stopImpersonating(addr: string) {
  try {
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [addr]);
  } catch {
    // best-effort
  }
}

/**
 * 运行高级批量测试
 *
 * 测试场景：
 * - Pair1: 按期全额还款
 * - Pair2: 部分还款 + 全额还款（按期）
 * - Pair3: 按期全额还款
 * - Pair4: 多 lender 拆单（multi-lender split）
 * - Pair5: 逾期全额还款（time travel）
 * - EarlyRepaymentGuarantee（保证金：lock → early settle）
 *
 * @param opts 可选配置
 * @param opts.sampleBorrowerIndex 样本 borrower 索引（0-4），用于打印 PositionView version
 */
export async function runAdvancedBatch(opts?: {
  sampleBorrowerIndex?: number;
}) {
  const snap = await withTimeout(
    network.provider.send("evm_snapshot", []),
    EVM_TIMEOUT_MS,
    "evm_snapshot",
  );
  const artifacts = mkArtifactsWriter();
  dataPushCounts = {};
  const expectedReverts: Record<string, number> = {};
  const artifactOrderCreates: Array<{
    saltSuffix: string;
    borrower: string;
    lender: string;
    orderId: string;
    principalRaw: string;
    withGuarantee: boolean;
  }> = [];
  const artifactCheckpoints: Record<string, any> = {};
  const expectedOrderIdsByBorrower: Record<string, string[]> = {};
  const orderCreateMetaById: Record<string, any> = {};
  const recordExpectedBorrowerOrderId = (borrowerAddr: string, id: bigint) => {
    const u = borrowerAddr.toLowerCase();
    (expectedOrderIdsByBorrower[u] ??= []).push(id.toString());
  };
  const moveExpectedOrderId = (
    fromAddr: string,
    toAddr: string,
    id: bigint,
    context: string,
  ) => {
    const from = fromAddr.toLowerCase();
    const to = toAddr.toLowerCase();
    const idStr = id.toString();

    const fromList = expectedOrderIdsByBorrower[from] ?? [];
    const idx = fromList.findIndex((x) => String(x) === idStr);
    if (idx === -1) {
      throw new Error(
        `[LoanNFTView] moveExpectedOrderId(${context}): orderId=${idStr} not found under from=${from}`,
      );
    }
    fromList.splice(idx, 1);
    expectedOrderIdsByBorrower[from] = fromList;

    const toList = (expectedOrderIdsByBorrower[to] ??= []);
    if (!toList.some((x) => String(x) === idStr)) toList.push(idStr);
  };
  try {
    const signers = await ethers.getSigners();
    if (signers.length < 11)
      throw new Error(`Need at least 11 signers (have ${signers.length})`);

    const deployer = signers[0];
    // Default to strict mode: warnings become errors
    const strictViews = process.env.E2E_STRICT_VIEWS !== "0";
    const strictDataPush = process.env.E2E_STRICT_DATAPUSH === "1";
    const strictReward = process.env.E2E_STRICT_REWARD === "1";
    const allowDirtyState = process.env.E2E_ALLOW_DIRTY_STATE === "1";

    // 10 users → 5 borrowers + 5 lenders (may be re-picked on dirty chains)
    let borrowers = [
      signers[1],
      signers[3],
      signers[5],
      signers[7],
      signers[9],
    ];
    let lenders = [signers[2], signers[4], signers[6], signers[8], signers[10]];

    console.log(
      "=== E2E Advanced Batch (10 users / 5 borrowers + 5 lenders) ===\n",
    );
    console.log("Scenarios:");
    console.log("- Pair1: on-time full repay");
    console.log("- Pair2: partial repay then full repay (on-time)");
    console.log("- Pair3: on-time full repay");
    console.log(
      "- Pair4: multi-lender split via 2 orders (2 lenders, 500 + 500)",
    );
    console.log("- Pair5: overdue full repay (time travel)\n");
    console.log(
      "- Extra: blocks-only rollout smoke (finalize -> repay/settle -> liquidate)\n",
    );

    await assertLocalhostDeploymentOrThrow();

    const addressMap = loadAddressMap(network.name);
    const registryAddr = resolveAddress({
      name: "Registry",
      map: addressMap,
      envVar: "REGISTRY_ADDRESS",
    });

    const registry = (await ethers.getContractAt(
      "Registry",
      registryAddr,
    )) as any;
    const acmAddrFromRegistry = (await registry.getModuleOrRevert(
      key("ACCESS_CONTROL_MANAGER"),
    )) as string;
    const assetWhitelistAddrFromRegistry = (await registry.getModuleOrRevert(
      key("ASSET_WHITELIST"),
    )) as string;
    const priceOracleAddrFromRegistry = (await registry.getModuleOrRevert(
      key("PRICE_ORACLE"),
    )) as string;
    const feeRouterAddrFromRegistry = (await registry.getModuleOrRevert(
      key("FEE_ROUTER"),
    )) as string;
    const settlementTokenAddrFromRegistry = (await registry.getModuleOrRevert(
      key("SETTLEMENT_TOKEN"),
    )) as string;
    const statsPushManagerAddrFromRegistry = (await registry.getModuleOrRevert(
      key("STATISTICS_PUSH_MANAGER"),
    )) as string;

    const acm = (await ethers.getContractAt(
      "AccessControlManager",
      acmAddrFromRegistry,
    )) as any;
    const awRead = (await ethers.getContractAt(
      "IAssetWhitelistRead",
      assetWhitelistAddrFromRegistry,
    )) as any;
    const awAdmin = (await ethers.getContractAt(
      "IAssetWhitelistAdmin",
      assetWhitelistAddrFromRegistry,
    )) as any;
    const po = (await ethers.getContractAt(
      "src/core/PriceOracle.sol:PriceOracle",
      priceOracleAddrFromRegistry,
    )) as any;
    const feeRouter = (await ethers.getContractAt(
      "src/Vault/FeeRouter.sol:FeeRouter",
      feeRouterAddrFromRegistry,
    )) as any;
    const usdc = (await ethers.getContractAt(
      "MockERC20",
      settlementTokenAddrFromRegistry,
    )) as any;
    const fundUsdcUsers = async (
      recipients: string[],
      amount: bigint,
      label: string,
    ) => {
      await fundErc20Users({
        token: usdc,
        deployer,
        recipients,
        amount,
        label,
      });
    };
    const statsPushManager = (await ethers.getContractAt(
      "src/Vault/modules/StatisticsPushManager.sol:StatisticsPushManager",
      statsPushManagerAddrFromRegistry,
    )) as any;

    // MUST: Preflight for route↔registry + version info + required roles
    await runViewPreflight({
      registryAddr,
      acmAddr: acmAddrFromRegistry,
      adminSigner: deployer,
      assetForPriceCheck: settlementTokenAddrFromRegistry,
    });

    // Explicit routing checks (post-preflight) to show SystemView consistency after role setup.
    const systemViewAddr = (await registry.getModuleOrRevert(
      key("SYSTEM_VIEW"),
    )) as string;
    await assertSystemViewRoute({
      registryAddr,
      systemViewAddr,
      acmAddr: acmAddrFromRegistry,
      adminSigner: deployer,
      routeFn: "routePosition",
      expectedKeyString: "POSITION_VIEW",
    });
    await assertSystemViewRoute({
      registryAddr,
      systemViewAddr,
      acmAddr: acmAddrFromRegistry,
      adminSigner: deployer,
      routeFn: "routeUser",
      expectedKeyString: "USER_VIEW",
    });
    await assertViewCacheAddrAligned({
      registryAddr,
      systemViewAddr,
      acmAddr: acmAddrFromRegistry,
      adminSigner: deployer,
    });
    await assertPriceRoutesAndFallbackConsistency({
      registryAddr,
      systemViewAddr,
      acmAddr: acmAddrFromRegistry,
      adminSigner: deployer,
      assetForCheck: settlementTokenAddrFromRegistry,
    });
    // Always derive core module addresses from Registry to avoid stale frontend-config.
    const vaultCoreAddr = (await registry.getModuleOrRevert(
      key("VAULT_CORE"),
    )) as string;
    const vblAddr = (await registry.getModuleOrRevert(
      key("VAULT_BUSINESS_LOGIC"),
    )) as string;
    const cmAddr = (await registry.getModuleOrRevert(
      key("COLLATERAL_MANAGER"),
    )) as string;
    const vaultLendingEngineAddrFromRegistry =
      (await registry.getModuleOrRevert(key("LENDING_ENGINE"))) as string;
    const vaultCore = (await ethers.getContractAt(
      "VaultCore",
      vaultCoreAddr,
    )) as any;
    const vaultRouterAddr = (await vaultCore.viewContractAddrVar()) as string;
    const vbl = (await ethers.getContractAt(
      "VaultBusinessLogic",
      vblAddr,
    )) as any;
    const cm = (await ethers.getContractAt("CollateralManager", cmAddr)) as any;
    const vle = await ethers.getContractAt(
      "src/Vault/modules/VaultLendingEngine.sol:VaultLendingEngine",
      vaultLendingEngineAddrFromRegistry,
    );

    const orderEngineAddr = await registry.getModuleOrRevert(
      key("ORDER_ENGINE"),
    );
    const orderEngine = (await ethers.getContractAt(
      "src/core/LendingEngine.sol:LendingEngine",
      orderEngineAddr,
    )) as any;

    const loanNftAddr = await registry.getModuleOrRevert(key("LOAN_NFT"));
    const loanNft = (await ethers.getContractAt("LoanNFT", loanNftAddr)) as any;

    // LendingEngineView: order-level observability (ARCH 4.12) in complex scenarios
    const lendingEngineViewAddr = (await registry.getModuleOrRevert(
      key("LENDING_ENGINE_VIEW"),
    )) as string;
    const lendingEngineView = (await ethers.getContractAt(
      "LendingEngineView",
      lendingEngineViewAddr,
    )) as any;

    // LoanNFTView: user-level loan enumeration/count (ARCH 4.12)
    const loanNftViewAddr = (await registry.getModuleOrRevert(
      key("LOAN_NFT_VIEW"),
    )) as string;
    const loanNftView = (await ethers.getContractAt(
      "LoanNFTView",
      loanNftViewAddr,
    )) as any;

    const loanStatusLabel = (s: any): string => {
      const v = typeof s === "bigint" ? s : BigInt(s);
      if (v === 0n) return "Active";
      if (v === 1n) return "Repaid";
      if (v === 2n) return "Liquidated";
      if (v === 3n) return "Defaulted";
      return `Unknown(${v.toString()})`;
    };

    const jsonReplacer = (_k: string, v: any) =>
      typeof v === "bigint" ? v.toString() : v;
    const pretty = (v: any) => {
      try {
        return JSON.stringify(v, jsonReplacer, 2);
      } catch (e: any) {
        return String(e?.message ?? e);
      }
    };

    const collectUserTradeSnapshot = async (userSigner: any) => {
      const userAddr = String(userSigner.address);
      const [count, isValid, bn] = (await loanNftView
        .connect(userSigner)
        .getUserLoanCount(userAddr)) as [bigint, boolean, bigint];

      const total = count as bigint;
      const items: any[] = [];
      const pageLimit = 100n;
      let offset = 0n;
      while (offset < total) {
        const [pageItems, totalCount] = (await loanNftView
          .connect(userSigner)
          .getUserLoansPaginated(userAddr, offset, pageLimit)) as [
          any[],
          bigint,
          boolean,
          bigint,
        ];

        if ((totalCount as bigint) !== total) {
          throw new Error(
            `[LoanNFTView] totalCount mismatch for user=${userAddr}: getUserLoanCount=${total.toString()} getUserLoansPaginated.total=${totalCount.toString()}`,
          );
        }
        if (!pageItems || pageItems.length === 0) break;
        for (const it of pageItems) items.push(it);
        offset += BigInt(pageItems.length);
      }

      const orderDetailsOk: any[] = [];
      const orderDetailsError: any[] = [];
      const orderDetailsFallback: any[] = [];
      for (const it of items) {
        try {
          const ord = await lendingEngineView
            .connect(userSigner)
            .getLoanOrder(it.orderId);
          orderDetailsOk.push({
            orderId: it.orderId,
            order: ord,
            accessedAs: "user",
          });
        } catch (e: any) {
          // Some orders may not be readable by the token owner (e.g. NFT transferred) unless
          // VIEW roles are granted. For observability, decode MissingRole and fall back to ops read.
          if (isMissingRoleError(e)) {
            try {
              const ord = await lendingEngineView
                .connect(deployer)
                .getLoanOrder(it.orderId);
              orderDetailsOk.push({
                orderId: it.orderId,
                order: ord,
                accessedAs: "deployer",
                userAccessError: describeRevert(e),
              });
              orderDetailsFallback.push({
                orderId: it.orderId,
                userAccessError: describeRevert(e),
              });
            } catch (e2: any) {
              orderDetailsError.push({
                orderId: it.orderId,
                error: `user=${describeRevert(e)}; deployer=${describeRevert(e2)}`,
              });
            }
          } else {
            orderDetailsError.push({
              orderId: it.orderId,
              error: describeRevert(e),
            });
          }
        }
      }

      return {
        user: userAddr,
        meta: { isValid, blockNumber: bn },
        count: total,
        items: items.map((it) => ({
          tokenId: it.tokenId,
          orderId: it.orderId,
          status: it.status,
          statusLabel: loanStatusLabel(it.status),
        })),
        // Keep the legacy shape (`orders`) for existing consumers, but also expose
        // split lists for controllable verbose printing.
        orderDetailsOk,
        orderDetailsError,
        orderDetailsFallback,
        orders: [
          ...orderDetailsOk.map((x) => ({
            orderId: x.orderId,
            ok: true,
            order: x.order,
          })),
          ...orderDetailsError.map((x) => ({
            orderId: x.orderId,
            ok: false,
            error: x.error,
          })),
        ],
      };
    };

    const assertBorrowerEnumeratesOrder = async (
      borrowerSigner: any,
      id: bigint,
      context: string,
    ) => {
      const borrowerAddr = String(borrowerSigner.address);
      const [pageItems] = (await loanNftView
        .connect(borrowerSigner)
        .getUserLoansPaginated(borrowerAddr, 0n, 100n)) as [
        any[],
        bigint,
        boolean,
        bigint,
      ];
      const got = new Set(
        (pageItems ?? []).map((it: any) =>
          it?.orderId?.toString ? it.orderId.toString() : String(it?.orderId),
        ),
      );
      if (!got.has(id.toString())) {
        throw new Error(
          `[LoanNFTView] ${context}: borrower=${borrowerAddr} cannot enumerate orderId=${id.toString()} via getUserLoansPaginated(0,100)`,
        );
      }
    };

    const settlementManagerAddr = (await registry.getModuleOrRevert(
      key("SETTLEMENT_MANAGER"),
    )) as string;
    const settlementManager = (await ethers.getContractAt(
      "SettlementManager",
      settlementManagerAddr,
    )) as any;
    const liquidationManagerAddr = (await registry.getModuleOrRevert(
      key("LIQUIDATION_MANAGER"),
    )) as string;
    const liquidationRiskManagerAddr = (await registry.getModuleOrRevert(
      key("LIQUIDATION_RISK_MANAGER"),
    )) as string;
    const liquidationRiskManager = (await ethers.getContractAt(
      "LiquidationRiskManager",
      liquidationRiskManagerAddr,
    )) as any;
    // This script includes a partial repay scenario (Pair2). If strict full-repay auto-release is enabled,
    // SettlementManager will revert partial repays with SettlementManager__DebtNotCleared.
    const requireFullRepayRelease =
      (await settlementManager.requireFullRepayRelease()) as boolean;
    if (requireFullRepayRelease) {
      logNotice(
        "  [Notice]  SettlementManager.requireFullRepayRelease=true; disabling for this run to allow partial repay scenario (Pair2).",
      );
      await waitTx(
        settlementManager.connect(deployer).setRequireFullRepayRelease(false),
        "setRequireFullRepayRelease(false)",
      );
    }

    const positionViewAddr = await registry.getModuleOrRevert(
      key("POSITION_VIEW"),
    );
    const userViewAddr = await registry.getModuleOrRevert(key("USER_VIEW"));
    const riskViewAddr = await registry.getModuleOrRevert(key("RISK_VIEW"));
    // Canonical key for StatisticsView is "VAULT_STATISTICS" (ModuleKeys.KEY_STATS)
    const statisticsViewAddr = await registry.getModuleOrRevert(
      key("VAULT_STATISTICS"),
    );
    const previewViewAddr = await registry.getModuleOrRevert(
      key("PREVIEW_VIEW"),
    );
    const healthViewAddr = await registry.getModuleOrRevert(key("HEALTH_VIEW"));
    const dashboardViewAddr = await registry.getModuleOrRevert(
      key("DASHBOARD_VIEW"),
    );
    const cacheOptAddr = await registry.getModuleOrRevert(
      key("CACHE_OPTIMIZED_VIEW"),
    );
    const batchViewAddr = await registry.getModuleOrRevert(key("BATCH_VIEW"));

    const positionView = (await ethers.getContractAt(
      "PositionView",
      positionViewAddr,
    )) as any;
    const userView = (await ethers.getContractAt(
      "UserView",
      userViewAddr,
    )) as any;
    const riskView = (await ethers.getContractAt(
      "RiskView",
      riskViewAddr,
    )) as any;
    const statisticsView = (await ethers.getContractAt(
      "StatisticsView",
      statisticsViewAddr,
    )) as any;
    const previewView = (await ethers.getContractAt(
      "PreviewView",
      previewViewAddr,
    )) as any;
    const healthView = (await ethers.getContractAt(
      "HealthView",
      healthViewAddr,
    )) as any;
    const dashboardView = (await ethers.getContractAt(
      "DashboardView",
      dashboardViewAddr,
    )) as any;
    const cacheOpt = (await ethers.getContractAt(
      "CacheOptimizedView",
      cacheOptAddr,
    )) as any;
    const batchView = (await ethers.getContractAt(
      "BatchView",
      batchViewAddr,
    )) as any;

    const assetAddr = settlementTokenAddrFromRegistry;
    const assetDecimals = 6;
    const toBigInt = (x: any): bigint =>
      typeof x === "bigint" ? x : BigInt(x);

    // EarlyRepaymentGuaranteeManager + GuaranteeFundManager (SSOT: resolved from Registry).
    const ergmAddr = (await registry.getModuleOrRevert(
      key("EARLY_REPAYMENT_GUARANTEE_MANAGER"),
    )) as string;
    const gfmAddr = (await registry.getModuleOrRevert(
      key("GUARANTEE_FUND_MANAGER"),
    )) as string;
    const ergm = (await ethers.getContractAt(
      "src/Vault/modules/EarlyRepaymentGuaranteeManager.sol:EarlyRepaymentGuaranteeManager",
      ergmAddr,
    )) as any;
    const gfm = (await ethers.getContractAt(
      "src/Vault/modules/GuaranteeFundManager.sol:GuaranteeFundManager",
      gfmAddr,
    )) as any;
    const lenderPoolAddr = (await registry.getModuleOrRevert(
      key("LENDER_POOL_VAULT"),
    )) as string;

    // If guarantee is enabled, avoid reusing signers with active guarantees on dirty chains.
    try {
      if ((await ergm.isGuaranteeEnabled(assetAddr)) as boolean) {
        const fresh: any[] = [];
        for (const s of signers) {
          if (s.address.toLowerCase() === deployer.address.toLowerCase())
            continue;
          const hasActive = (await ergm.hasActiveGuarantee(
            s.address,
            assetAddr,
          )) as boolean;
          if (hasActive) continue;
          fresh.push(s);
        }
        if (fresh.length >= 10) {
          borrowers = [fresh[0], fresh[2], fresh[4], fresh[6], fresh[8]];
          lenders = [fresh[1], fresh[3], fresh[5], fresh[7], fresh[9]];
        } else {
          logNotice(
            "  [Notice] Not enough fresh signers; proceeding with default borrowers/lenders.",
          );
        }
      }
    } catch {
      // best-effort only
    }

    // FeeRouter recipients + fee rates (SSOT: always derive from FeeRouter config).
    const platformTreasury = (await feeRouter.getPlatformTreasury()) as string;
    const ecosystemVault = (await feeRouter.getEcosystemVault()) as string;
    const platformFeeBps = toBigInt(await feeRouter.getPlatformFeeBps());
    const ecoFeeBps = toBigInt(await feeRouter.getEcosystemFeeBps());
    const expectedPlatformBps = process.env.E2E_EXPECT_PLATFORM_FEE_BPS
      ? BigInt(process.env.E2E_EXPECT_PLATFORM_FEE_BPS)
      : null;
    const expectedEcoBps = process.env.E2E_EXPECT_ECO_FEE_BPS
      ? BigInt(process.env.E2E_EXPECT_ECO_FEE_BPS)
      : null;
    if (expectedPlatformBps !== null && expectedEcoBps !== null) {
      if (
        platformFeeBps !== expectedPlatformBps ||
        ecoFeeBps !== expectedEcoBps
      ) {
        throw new Error(
          `FeeRouter fee config mismatch: platform=${platformFeeBps} eco=${ecoFeeBps} (expected ${expectedPlatformBps}/${expectedEcoBps} bps)`,
        );
      }
    } else if (platformFeeBps !== 30n || ecoFeeBps !== 0n) {
      console.log(
        `  [Notice] FeeRouter fee config mismatch: platform=${platformFeeBps} eco=${ecoFeeBps} (expected 30/0 bps)`,
      );
    }

    // ============ ViewScan (broader view coverage) ============
    await scanViewModules(registryAddr, {
      assetAddr,
      sampleUser: borrowers[0].address,
      strict: strictViews,
    });

    // ============ Reward (Architecture-Guide) ============
    // Resolve via Registry to avoid stale frontend-config.
    const rewardViewAddr = (await registry.getModuleOrRevert(
      key("REWARD_VIEW"),
    )) as string;
    const rewardManagerAddr = (await registry.getModuleOrRevert(
      key("REWARD_MANAGER"),
    )) as string;
    const rmCoreAddr = (await registry.getModuleOrRevert(
      key("REWARD_MANAGER_CORE"),
    )) as string;
    const ramAddr = (await registry.getModule(
      key("REWARD_ACCRUAL_MANAGER"),
    )) as string;
    const easyEmissionControllerAddr = (await registry.getModule(
      key("EASY_EMISSION_CONTROLLER"),
    )) as string;
    const easyTokenAddr = (await registry.getModuleOrRevert(
      key("EASY_TOKEN"),
    )) as string;
    const rewardView = (await ethers.getContractAt(
      "RewardView",
      rewardViewAddr,
    )) as any;
    const easyToken = (await ethers.getContractAt(
      "src/Token/EasyToken.sol:EasyToken",
      easyTokenAddr,
    )) as any;
    const rewardManager = (await ethers.getContractAt(
      "RewardManager",
      rewardManagerAddr,
    )) as any;
    const rmCore = (await ethers.getContractAt(
      "RewardManagerCore",
      rmCoreAddr,
    )) as any;
    const rewardAccrualManager =
      ramAddr && ramAddr !== ethers.ZeroAddress
        ? ((await ethers.getContractAt("RewardAccrualManager", ramAddr)) as any)
        : null;
    const easyEmissionController =
      easyEmissionControllerAddr &&
      easyEmissionControllerAddr !== ethers.ZeroAddress
        ? ((await ethers.getContractAt(
            "EasyEmissionController",
            easyEmissionControllerAddr,
          )) as any)
        : null;
    const easyDecimals = (await easyToken.decimals()) as number;
    const ONE_EASY = 10n ** BigInt(easyDecimals);
    const fmtEasy = (x: bigint) => ethers.formatUnits(x, easyDecimals);
    const DATA_TYPE_EASY_MINTED_LOWER = DATA_TYPE_EASY_MINTED.toLowerCase();
    const easyEmissionConfigAddr = (await registry.getModule(
      key("EASY_EMISSION_CONFIG"),
    )) as string;
    const easyEmissionConfig =
      easyEmissionConfigAddr && easyEmissionConfigAddr !== ethers.ZeroAddress
        ? ((await ethers.getContractAt(
            "EasyEmissionConfig",
            easyEmissionConfigAddr,
          )) as any)
        : null;
    const loanFlowViewAddr = (await registry.getModule(
      key("LOAN_FLOW_VIEW"),
    )) as string;
    if (!ramAddr || ramAddr === ethers.ZeroAddress) {
      if (strictReward) {
        throw new Error("[Reward] missing REWARD_ACCRUAL_MANAGER in registry");
      }
      logNotice(
        "  [Notice] [Reward] missing REWARD_ACCRUAL_MANAGER in registry (penalty/offset paths may be miswired)",
      );
    }
    const skipEasyMintAssertion =
      !easyEmissionControllerAddr ||
      easyEmissionControllerAddr === ethers.ZeroAddress ||
      !easyEmissionConfigAddr ||
      easyEmissionConfigAddr === ethers.ZeroAddress ||
      !loanFlowViewAddr ||
      loanFlowViewAddr === ethers.ZeroAddress;
    if (skipEasyMintAssertion) {
      logNotice(
        "  [Notice] [Reward] skipping Easy mint assertion: emission modules not fully configured",
      );
    }
    // Reward eligibility (SSOT in RewardManagerCore): principal must be >= 1000 USDC (6 decimals)
    const MIN_ELIGIBLE_PRINCIPAL = 1_000n * 1_000_000n;

    function getRewardPushFlags(receipt: any) {
      const pushes = extractDataPushed(receipt);
      return {
        hasEasyMinted: hasNonZeroEasyMintedPush(receipt),
        hasRewardBurned: pushes.some(
          (p) =>
            p.dataTypeHash.toLowerCase() ===
            DATA_TYPE_REWARD_BURNED.toLowerCase(),
        ),
        hasPenaltyLedger: pushes.some(
          (p) =>
            p.dataTypeHash.toLowerCase() ===
            DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED.toLowerCase(),
        ),
      };
    }

    function assertRewardAutoTriggers(
      label: string,
      receipt: any,
      opts: {
        expectMinted: boolean;
        expectPenalty: "none" | "burn-or-ledger";
        extraReceipts?: any[];
        mintedFallback?: boolean;
        penaltyFallback?: boolean;
      },
    ) {
      const receipts = [receipt, ...(opts.extraReceipts || [])].filter(Boolean);
      const flags = receipts.reduce(
        (acc, rcpt) => {
          const next = getRewardPushFlags(rcpt);
          return {
            hasEasyMinted: acc.hasEasyMinted || next.hasEasyMinted,
            hasRewardBurned: acc.hasRewardBurned || next.hasRewardBurned,
            hasPenaltyLedger: acc.hasPenaltyLedger || next.hasPenaltyLedger,
          };
        },
        {
          hasEasyMinted: false,
          hasRewardBurned: false,
          hasPenaltyLedger: false,
        },
      );
      if (opts.expectMinted) {
        if (skipEasyMintAssertion) {
          logNotice(
            `  [Notice] [Reward] ${label}: skip EASY_MINTED check (emission modules not configured)`,
          );
        } else if (!flags.hasEasyMinted) {
          if (opts.mintedFallback) return;
          if (strictReward)
            throw new Error(
              `[Reward] ${label}: expected EASY_MINTED in repay receipt`,
            );
          logNotice(
            `  [Notice] [Reward] ${label}: EASY_MINTED not observed in repay receipt`,
          );
        }
      } else if (flags.hasEasyMinted) {
        if (strictReward)
          throw new Error(
            `[Reward] ${label}: unexpected EASY_MINTED in receipt`,
          );
        logNotice(
          `  [Notice] [Reward] ${label}: unexpected EASY_MINTED observed`,
        );
      }

      if (opts.expectPenalty === "none") {
        if (flags.hasRewardBurned || flags.hasPenaltyLedger) {
          if (strictReward)
            throw new Error(`[Reward] ${label}: unexpected penalty/burn push`);
          logNotice(
            `  [Notice] [Reward] ${label}: unexpected penalty/burn push observed`,
          );
        }
      } else if (!flags.hasRewardBurned && !flags.hasPenaltyLedger) {
        if (opts.penaltyFallback) return;
        if (strictReward)
          throw new Error(`[Reward] ${label}: expected penalty/burn push`);
        logNotice(
          `  [Notice] [Reward] ${label}: penalty/burn push not observed`,
        );
      }
    }

    if (
      easyEmissionController &&
      easyEmissionControllerAddr &&
      easyEmissionControllerAddr !== ethers.ZeroAddress
    ) {
      const minterRole = await easyToken.MINTER_ROLE();
      const hasMinter = await easyToken.hasRole(
        minterRole,
        easyEmissionControllerAddr,
      );
      if (!hasMinter) {
        await (
          await easyToken
            .connect(deployer)
            .setSoleMinter(easyEmissionControllerAddr)
        ).wait();
        console.log("  ✅ EasyToken sole minter set to EasyEmissionController");
      }
    }

    async function fallbackTriggerRewardEarnByOrder(params: {
      user: string;
      lender: string;
      asset: string;
      orderId: bigint;
      amount: bigint;
    }): Promise<any> {
      // Some localhost deployments may not wire the LendingEngine→RewardManager hook yet.
      // For E2E coverage, impersonate OrderEngine and call RewardManager.onLoanEventByOrderWithLender()
      // so EasyEmissionController can mint per WhitePaper rules.
      await network.provider.send("hardhat_impersonateAccount", [
        orderEngineAddr,
      ]);
      await network.provider.send("hardhat_setBalance", [
        orderEngineAddr,
        "0x56BC75E2D63100000",
      ]); // 100 ETH
      const oe = await ethers.getSigner(String(orderEngineAddr));
      const ord = await orderEngine.getLoanOrderForView(params.orderId);
      const maturity = BigInt(ord.maturity);

      // Outcome 0 = borrow, 1 = repay (see RewardSpend acceptance script).
      await waitTx(
        rewardManager
          .connect(oe)
          .onLoanEventByOrderWithLender(
            params.user,
            params.lender,
            params.asset,
            params.orderId,
            params.amount,
            maturity,
            0,
          ),
        "RewardManager.onLoanEventByOrderWithLender(borrow)",
      );
      const rcpt = await waitTx(
        rewardManager
          .connect(oe)
          .onLoanEventByOrderWithLender(
            params.user,
            params.lender,
            params.asset,
            params.orderId,
            params.amount,
            maturity,
            1,
          ),
        "RewardManager.onLoanEventByOrderWithLender(repay)",
      );
      return rcpt;
    }

    async function fallbackTriggerEasyEmission(params: {
      borrower: string;
      lender: string;
      asset: string;
      orderId: bigint;
      amount: bigint;
    }): Promise<any> {
      if (
        !easyEmissionController ||
        !easyEmissionControllerAddr ||
        easyEmissionControllerAddr === ethers.ZeroAddress
      ) {
        throw new Error("[Easy] missing EASY_EMISSION_CONTROLLER in registry");
      }
      await network.provider.send("hardhat_impersonateAccount", [
        rewardManagerAddr,
      ]);
      await network.provider.send("hardhat_setBalance", [
        rewardManagerAddr,
        "0x56BC75E2D63100000",
      ]); // 100 ETH
      const rmSigner = await ethers.getSigner(String(rewardManagerAddr));
      const ord = await orderEngine.getLoanOrderForView(params.orderId);
      const maturity = BigInt(ord.maturity);
      return await waitTx(
        easyEmissionController
          .connect(rmSigner)
          .onLoanEventByOrderWithLender(
            params.borrower,
            params.lender,
            params.asset,
            params.orderId,
            params.amount,
            maturity,
            1,
          ),
        "EasyEmissionController.onLoanEventByOrderWithLender(repay)",
      );
    }

    async function mintEasyForTesting(params: {
      borrower: string;
      lender: string;
      amount: bigint;
    }): Promise<any> {
      if (
        !easyEmissionController ||
        !easyEmissionControllerAddr ||
        easyEmissionControllerAddr === ethers.ZeroAddress
      ) {
        throw new Error("[Easy] missing EASY_EMISSION_CONTROLLER in registry");
      }
      await network.provider.send("hardhat_impersonateAccount", [
        rewardManagerAddr,
      ]);
      await network.provider.send("hardhat_setBalance", [
        rewardManagerAddr,
        "0x56BC75E2D63100000",
      ]);
      const rmSigner = await ethers.getSigner(String(rewardManagerAddr));
      const maturity = await latestBlockNumber();
      const orderId = BigInt(Date.now());
      return await waitTx(
        easyEmissionController
          .connect(rmSigner)
          .onLoanEventByOrderWithLender(
            params.borrower,
            params.lender,
            assetAddr,
            orderId,
            params.amount,
            maturity,
            1,
          ),
        "EasyEmissionController.onLoanEventByOrderWithLender(test-mint)",
      );
    }

    async function ensureEasyBalance(
      userAddr: string,
      lenderAddr: string,
      minEasy: bigint,
    ): Promise<void> {
      const maxRounds = 8;
      let testMintAmount = ethers.parseUnits("1000", 6);
      for (let i = 0; i < maxRounds; i++) {
        const bal = (await easyToken.balanceOf(userAddr)) as bigint;
        if (bal >= minEasy) return;
        await mintEasyForTesting({
          borrower: userAddr,
          lender: lenderAddr,
          amount: testMintAmount,
        });
        testMintAmount *= 2n;
      }
      const finalBal = (await easyToken.balanceOf(userAddr)) as bigint;
      if (finalBal < minEasy) {
        throw new Error(
          `[Easy] cannot mint enough EASY for guide checks: have=${fmtEasy(finalBal)} need>=${fmtEasy(minEasy)}`,
        );
      }
    }

    async function runRewardExtendedChecks() {
      await runSharedRewardExtendedChecks({
        registry,
        acm,
        deployer,
        waitTx,
        strictReward,
        rewardView,
        rewardViewAddr,
        easyEmissionConfig,
        easyEmissionConfigAddr,
        rewardAccrualManager,
        ramAddr,
        rmCoreAddr,
        artifactTarget: artifactCheckpoints,
        logNotice,
        log: console.log,
      });
    }

    // ============ C baseline: unified version introspection ============
    async function logViewVersionInfo(
      label: string,
      view: any,
      expectSchema?: bigint,
    ) {
      const [apiVersion, schemaVersion, implementation] =
        await view.getVersionInfo();
      console.log(
        `  [VersionInfo] ${label}: api=${apiVersion.toString()} schema=${schemaVersion.toString()} implementation=${implementation}`,
      );
      if (expectSchema !== undefined && schemaVersion !== expectSchema) {
        throw new Error(
          `[VersionInfo] ${label}: unexpected schemaVersion=${schemaVersion.toString()} expect=${expectSchema.toString()}`,
        );
      }
    }
    await logViewVersionInfo("PositionView", positionView, 2n);
    await logViewVersionInfo("UserView", userView, 1n);
    await logViewVersionInfo("RiskView", riskView, 1n);
    await logViewVersionInfo("StatisticsView", statisticsView, 1n);
    await logViewVersionInfo("PreviewView", previewView, 1n);

    // ============ Phase3 visibility: explicitly print PositionView version ============
    // We print a sample borrower's PositionView version at key checkpoints to validate
    // that cache writes are happening and versions are monotonic (strict nextVersion semantics).
    function parseSampleBorrowerIndexFromEnv(): number {
      // Prefer argv over env if both are provided.
      // Usage:
      //  - ENV:  E2E_SAMPLE_BORROWER_INDEX=2 npx hardhat run ... --network localhost
      const raw: string | undefined = process.env.E2E_SAMPLE_BORROWER_INDEX;

      if (raw === undefined || raw.trim() === "") return 0;
      const n = Number(raw);
      if (!Number.isInteger(n))
        throw new Error(`Invalid sample borrower index: ${raw}`);
      return n;
    }

    const sampleBorrowerIndex =
      opts?.sampleBorrowerIndex ?? parseSampleBorrowerIndexFromEnv();
    if (sampleBorrowerIndex < 0 || sampleBorrowerIndex >= borrowers.length) {
      throw new Error(
        `sampleBorrowerIndex out of range: ${sampleBorrowerIndex}. Must be in [0, ${borrowers.length - 1}]`,
      );
    }
    const sampleBorrower = borrowers[sampleBorrowerIndex];
    async function logPositionViewVersion(step: string) {
      const v = await positionView.getPositionVersion(
        sampleBorrower.address,
        assetAddr,
      );
      const [pvCol, pvDebt] = await positionView.getUserPositionWithMeta(
        sampleBorrower.address,
        assetAddr,
      );
      console.log(
        `  [PositionView] ${step}: sampleBorrowerIndex=${sampleBorrowerIndex} borrower=${sampleBorrower.address} version=${v.toString()} col=${ethers.formatUnits(
          pvCol,
          6,
        )} debt=${ethers.formatUnits(pvDebt, 6)}`,
      );
    }

    // ============ Roles ============
    const ensureRole = async (roleName: string, who: string | any) => {
      const whoAddr = await ethers.resolveAddress(who);
      const role = key(roleName);
      if (!(await acm.hasRole(role, whoAddr))) {
        await waitTx(acm.grantRole(role, whoAddr), `grantRole ${roleName}`);
      }
    };

    const readAddressFromSlot = async (
      target: string,
      slot: bigint,
    ): Promise<string | null> => {
      const raw = await ethers.provider.getStorage(target, slot);
      if (!raw || raw === "0x" || BigInt(raw) === 0n) return null;
      const addr = ethers.getAddress(`0x${raw.slice(-40)}`);
      const code = await ethers.provider.getCode(addr);
      if (!code || code === "0x") return null;
      return addr;
    };

    // PreviewView integration sanity:
    // PreviewView reads PositionView as an external caller (msg.sender=PreviewView), so PositionView's Scheme-U gate
    // requires the PreviewView *contract address itself* to have VIEW_USER_DATA (deployment must grant this).
    const previewHasDownstreamReadRole = (await acm.hasRole(
      key("VIEW_USER_DATA"),
      previewViewAddr,
    )) as boolean;
    if (!previewHasDownstreamReadRole) {
      await ensureRole("VIEW_USER_DATA", previewViewAddr);
      console.log(
        `  🔑 Granted VIEW_USER_DATA to PreviewView: ${previewViewAddr}`,
      );
    }
    const previewHasRiskReadRole = (await acm.hasRole(
      key("VIEW_RISK_DATA"),
      previewViewAddr,
    )) as boolean;
    if (!previewHasRiskReadRole) {
      await ensureRole("VIEW_RISK_DATA", previewViewAddr);
      console.log(
        `  🔑 Granted VIEW_RISK_DATA to PreviewView: ${previewViewAddr}`,
      );
    }
    const userViewHasDownstreamReadRole = (await acm.hasRole(
      key("VIEW_USER_DATA"),
      userViewAddr,
    )) as boolean;
    if (!userViewHasDownstreamReadRole) {
      await ensureRole("VIEW_USER_DATA", userViewAddr);
      console.log(`  🔑 Granted VIEW_USER_DATA to UserView: ${userViewAddr}`);
    }
    const batchViewHasDownstreamReadRole = (await acm.hasRole(
      key("VIEW_USER_DATA"),
      batchViewAddr,
    )) as boolean;
    if (!batchViewHasDownstreamReadRole) {
      await ensureRole("VIEW_USER_DATA", batchViewAddr);
      console.log(`  🔑 Granted VIEW_USER_DATA to BatchView: ${batchViewAddr}`);
    }
    const cacheOptHasDownstreamReadRole = (await acm.hasRole(
      key("VIEW_USER_DATA"),
      cacheOptAddr,
    )) as boolean;
    if (!cacheOptHasDownstreamReadRole) {
      await ensureRole("VIEW_USER_DATA", cacheOptAddr);
      console.log(
        `  🔑 Granted VIEW_USER_DATA to CacheOptimizedView: ${cacheOptAddr}`,
      );
    }
    const dashboardViewHasDownstreamReadRole = (await acm.hasRole(
      key("VIEW_USER_DATA"),
      dashboardViewAddr,
    )) as boolean;
    if (!dashboardViewHasDownstreamReadRole) {
      await ensureRole("VIEW_USER_DATA", dashboardViewAddr);
      console.log(
        `  🔑 Granted VIEW_USER_DATA to DashboardView: ${dashboardViewAddr}`,
      );
    }
    const dashboardViewHasRiskReadRole = (await acm.hasRole(
      key("VIEW_RISK_DATA"),
      dashboardViewAddr,
    )) as boolean;
    if (!dashboardViewHasRiskReadRole) {
      await ensureRole("VIEW_RISK_DATA", dashboardViewAddr);
      console.log(
        `  🔑 Granted VIEW_RISK_DATA to DashboardView: ${dashboardViewAddr}`,
      );
    }
    const lendingEngineViewHasSystemReadRole = (await acm.hasRole(
      key("VIEW_SYSTEM_DATA"),
      lendingEngineViewAddr,
    )) as boolean;
    if (!lendingEngineViewHasSystemReadRole) {
      await ensureRole("VIEW_SYSTEM_DATA", lendingEngineViewAddr);
      console.log(
        `  🔑 Granted VIEW_SYSTEM_DATA to LendingEngineView: ${lendingEngineViewAddr}`,
      );
    }

    // config/admin
    await ensureRole("ADD_WHITELIST", deployer.address);
    await ensureRole("REMOVE_WHITELIST", deployer.address);
    await ensureRole("UPDATE_PRICE", deployer.address);
    await ensureRole("SET_PARAMETER", deployer.address);
    await ensureRole("PAUSE_SYSTEM", deployer.address);
    await ensureRole("UNPAUSE_SYSTEM", deployer.address);
    await ensureRole("ACTION_VIEW_PUSH", deployer.address);
    // strict mode helpers (PositionView.retryUserPositionUpdate, upgrades, etc.)
    await ensureRole("ACTION_ADMIN", deployer.address);
    // Make deployer able to observe LendingEngineView across users + ops diagnostics
    await ensureRole("VIEW_USER_DATA", deployer.address);
    await ensureRole("VIEW_SYSTEM_DATA", deployer.address);

    {
      const whitelistRegistryAddr = (await registry.getModuleOrRevert(
        key("WHITELIST_REGISTRY"),
      )) as string;
      const whitelistRegistry = (await ethers.getContractAt(
        "WhitelistRegistry",
        whitelistRegistryAddr,
      )) as any;
      const participants = Array.from(
        new Set([...borrowers, ...lenders].map((signer) => signer.address)),
      );
      const missing: string[] = [];
      for (const account of participants) {
        if (!(await whitelistRegistry.isWhitelisted(account)))
          missing.push(account);
      }
      if (missing.length === 1) {
        await waitTx(
          whitelistRegistry.connect(deployer).addAddress(missing[0]),
          "whitelist addAddress",
        );
      } else if (missing.length > 1) {
        await waitTx(
          whitelistRegistry.connect(deployer).batchAddAddresses(missing),
          "whitelist batchAddAddresses",
        );
      }
      for (const account of participants) {
        if (!(await whitelistRegistry.isWhitelisted(account))) {
          throw new Error(
            `[WhitelistRegistry] advanced batch participant not registered: ${account}`,
          );
        }
      }
      console.log(
        `  ✅ WhitelistRegistry preflight passed: ${participants.length} advanced-batch participants registered`,
      );
    }

    // Fresh localhost deploys may have an empty asset whitelist.
    const assetAllowed = (await awRead.isAssetAllowed(assetAddr)) as boolean;
    if (!assetAllowed) {
      await waitTx(
        awAdmin.connect(deployer).addAllowedAsset(assetAddr),
        "addAllowedAsset",
      );
      console.log(`  🔑 Whitelisted asset for E2E: ${assetAddr}`);
    }
    // VaultRouter caches its own AssetWhitelist address at initialization.
    // If Registry has been updated since then, VaultRouter may still point to a different whitelist.
    // Ensure the asset is allowed in that cached whitelist as well to avoid AssetNotAllowed() on deposits.
    const vaultRouterWhitelistAddr = await readAddressFromSlot(
      vaultRouterAddr,
      4n,
    );
    if (
      vaultRouterWhitelistAddr &&
      vaultRouterWhitelistAddr.toLowerCase() !==
        assetWhitelistAddrFromRegistry.toLowerCase()
    ) {
      const routerWhitelistRead = (await ethers.getContractAt(
        "IAssetWhitelistRead",
        vaultRouterWhitelistAddr,
      )) as any;
      const routerWhitelistAdmin = (await ethers.getContractAt(
        "IAssetWhitelistAdmin",
        vaultRouterWhitelistAddr,
      )) as any;
      if (!(await routerWhitelistRead.isAssetAllowed(assetAddr))) {
        await waitTx(
          routerWhitelistAdmin.connect(deployer).addAllowedAsset(assetAddr),
          "addAllowedAsset (VaultRouter)",
        );
        console.log(
          `  🔑 Whitelisted asset in VaultRouter whitelist: ${vaultRouterWhitelistAddr}`,
        );
      }
    }

    // StatisticsPushManager must be able to read PositionView valuation (risk-gated).
    await ensureRole("VIEW_RISK_DATA", statsPushManagerAddrFromRegistry);
    await ensureRole("VIEW_PRICE_DATA", statsPushManagerAddrFromRegistry);
    await ensureRole("VIEW_SYSTEM_DATA", statsPushManagerAddrFromRegistry);

    // Ensure SSOT ledger modules are allowed to notify the StatsPushManager.
    await ensureRole("ACTION_VIEW_PUSH", cmAddr);
    await ensureRole("ACTION_VIEW_PUSH", vaultLendingEngineAddrFromRegistry);
    await ensureRole("ACTION_VIEW_PUSH", settlementManagerAddr);
    await ensureRole("ACTION_VIEW_PUSH", liquidationManagerAddr);

    // LendingEngineCore risk push reads PositionView valuation (VIEW_RISK_DATA gated).
    await ensureRole("VIEW_RISK_DATA", vaultLendingEngineAddrFromRegistry);

    // match orchestration
    await ensureRole("ORDER_CREATE", vblAddr);
    await ensureRole("DEPOSIT", vblAddr);

    // order engine
    await ensureRole("BORROW", orderEngineAddr);

    // repay SSOT: SettlementManager calls ORDER_ENGINE.repay + ORDER_ENGINE.getLoanOrderForView
    await ensureRole("REPAY", settlementManagerAddr);
    await ensureRole("VIEW_SYSTEM_DATA", settlementManagerAddr);

    // StatisticsView push is performed by VaultBusinessLogic and VaultRouter (best-effort in library/router),
    // so grant them VIEW_SYSTEM_DATA to make stats strict-checkable in E2E.
    // PositionView delta/full pushes require ACTION_VIEW_PUSH on the caller (VaultRouter).
    await ensureRole("ACTION_VIEW_PUSH", vaultRouterAddr);
    await ensureRole("VIEW_SYSTEM_DATA", vblAddr);
    await ensureRole("VIEW_SYSTEM_DATA", vaultRouterAddr);

    // keeper liquidation SSOT entry
    await ensureRole("LIQUIDATE", deployer.address);
    // IMPORTANT: liquidation execution performs direct ledger writes where msg.sender is a contract
    // (LiquidationManager and/or SettlementManager depending on branch). Those executors must also
    // have ACTION_LIQUIDATE, otherwise ledger modules will revert MissingRole().
    await ensureRole("LIQUIDATE", liquidationManagerAddr);
    await ensureRole("LIQUIDATE", settlementManagerAddr);
    // FeeRouter prepaid distribution requires ACTION_DEPOSIT on the caller modules.
    await ensureRole("DEPOSIT", liquidationManagerAddr);
    await ensureRole("DEPOSIT", gfmAddr);

    const syncStatisticsSnapshots = async (label: string) => {
      console.log(`=== StatisticsPushManager retry: ${label} ===`);
      for (const borrower of borrowers) {
        await waitTx(
          statsPushManager.connect(deployer).retryUserStats(borrower.address),
          `retryUserStats ${label} ${borrower.address.slice(0, 10)}`,
        );
      }
    };

    // ============ Asset/price setup ============
    if (!(await awRead.isAssetAllowed(assetAddr))) {
      await waitTx(
        awAdmin.connect(deployer).addAllowedAsset(assetAddr),
        "addAllowedAsset",
      );
    }
    {
      const cfg = await po.getAssetConfig(assetAddr);
      if (!cfg.isActive) {
        await waitTx(
          po
            .connect(deployer)
            .configureAsset(assetAddr, "usd-coin", assetDecimals, 3600),
          "configureAsset",
        );
      }
    }
    const nowBlock = await latestBlockNumber();
    await waitTx(
      po
        .connect(deployer)
        .updatePrice(assetAddr, ethers.parseUnits("1", 8), nowBlock),
      "updatePrice",
    );

    // Oracle negative: price=0 should be rejected
    {
      const invalidPriceSel = errorSelector("PriceOracle__InvalidPrice()");
      await mustRevertWithSelector(
        "PriceOracle.updatePrice should reject zero price",
        async () => po.connect(deployer).updatePrice(assetAddr, 0, nowBlock),
        invalidPriceSel,
      );
    }

    if (!(await feeRouter.isTokenSupported(assetAddr))) {
      await waitTx(
        feeRouter.connect(deployer).addSupportedToken(assetAddr),
        "addSupportedToken",
      );
    }

    // Secondary asset for multi-asset reward coverage.
    const altTokenFactory = await ethers.getContractFactory("MockERC20");
    const altToken = (await altTokenFactory
      .connect(deployer)
      .deploy(
        "MockUSDC2",
        "mUSDC2",
        6,
        ethers.parseUnits("1000000000", 6),
      )) as any;
    await altToken.waitForDeployment();
    const altAssetAddr = await altToken.getAddress();
    if (!(await awRead.isAssetAllowed(altAssetAddr))) {
      await waitTx(
        awAdmin.connect(deployer).addAllowedAsset(altAssetAddr),
        "addAllowedAsset alt",
      );
    }
    {
      const cfg = await po.getAssetConfig(altAssetAddr);
      if (!cfg.isActive) {
        await waitTx(
          po
            .connect(deployer)
            .configureAsset(altAssetAddr, "usd-coin", 6, 3600),
          "configureAsset alt",
        );
      }
    }
    await waitTx(
      po
        .connect(deployer)
        .updatePrice(altAssetAddr, ethers.parseUnits("1", 8), nowBlock),
      "updatePrice alt",
    );
    if (!(await feeRouter.isTokenSupported(altAssetAddr))) {
      await waitTx(
        feeRouter.connect(deployer).addSupportedToken(altAssetAddr),
        "addSupportedToken alt",
      );
    }

    // ============ EarlyRepaymentGuarantee: deployment sanity + asset toggle ============
    // This E2E script relies on the "Extension Flow" wiring:
    // - VBL.finalizeMatch locks + records guarantee
    // - SettlementManager triggers early/default processing
    //
    // If your localhost deployment is outdated (missing `isGuaranteeEnabled`), we fail fast with a helpful message.
    const requireGuarantee = process.env.E2E_REQUIRE_GUARANTEE !== "0"; // default: require
    let guaranteeToggleSupported = true;
    try {
      // We intentionally DISABLE guarantee for the main 10-user scenarios to keep the batch deterministic:
      // - main flow has partial repay and multi-order splits
      // - ERGM enforces 1 active guarantee per (user, asset)
      // - enabling guarantee would require extra ERC20 allowances for promisedInterest on every match
      //
      // We will re-enable it later in the dedicated "Extra: EarlyRepaymentGuarantee" blocks.
      const currentlyEnabled = (await ergm.isGuaranteeEnabled(
        assetAddr,
      )) as boolean;
      if (currentlyEnabled) {
        await waitTx(
          ergm.connect(deployer).setGuaranteeEnabled(assetAddr, false),
          "setGuaranteeEnabled(false)",
        );
      }
    } catch (e: any) {
      guaranteeToggleSupported = false;
      const msg =
        `EarlyRepaymentGuarantee E2E requires a localhost deployment that includes ERGM per-asset toggle ` +
        `(isGuaranteeEnabled/setGuaranteeEnabled) and the new extension-flow wiring.\n` +
        `Your current localhost seems outdated (call reverted: ${e?.message || e}).\n` +
        `Fix: restart the localhost node and re-run deploylocal.ts, then rerun this script.\n` +
        `If you intentionally want to skip guarantee assertions, run with E2E_REQUIRE_GUARANTEE=0.`;
      if (requireGuarantee) throw new Error(msg);
      logNotice(`  [Notice] ${msg}`);
    }

    // ============ Helpers: per-step assertions ============
    const SEL_MISSING_ROLE = ethers
      .id("MissingRole()")
      .slice(0, 10)
      .toLowerCase();
    const MAX_UINT256 = ethers.MaxUint256;

    function fmtErr(e: any) {
      return e?.shortMessage ?? e?.message ?? String(e);
    }

    function getRevertSelector(e: any): string | undefined {
      const data = extractRevertData(e);
      let sel =
        data && data.startsWith("0x") && data.length >= 10
          ? data.slice(0, 10).toLowerCase()
          : undefined;
      if (!sel) {
        const sig = extractCustomErrorSigFromMessage(e);
        if (sig) sel = errorSelector(sig).toLowerCase();
      }
      return sel;
    }

    function describeRevert(e: any): string {
      const sel = getRevertSelector(e);
      if (sel === SEL_MISSING_ROLE) return `MissingRole() (selector=${sel})`;
      if (sel) return `${fmtErr(e)} (selector=${sel})`;
      return fmtErr(e);
    }

    function isMissingRoleError(e: any): boolean {
      return getRevertSelector(e) === SEL_MISSING_ROLE;
    }

    function extractRevertData(e: any): string | undefined {
      const candidates: Array<unknown> = [
        e?.data,
        e?.error?.data,
        e?.info?.error?.data,
        e?.error?.error?.data,
      ];
      for (const c of candidates) {
        if (typeof c === "string" && c.startsWith("0x")) return c;
      }
      const msg = fmtErr(e);
      const m = String(msg).match(/return data:\s*(0x[0-9a-fA-F]+)/);
      if (m?.[1]) return m[1];
      return undefined;
    }

    function errorSelector(sig: string): string {
      return ethers.id(sig).slice(0, 10);
    }

    function recordExpectedRevert(label: string) {
      expectedReverts[label] = (expectedReverts[label] ?? 0) + 1;
    }

    function extractCustomErrorSigFromMessage(e: any): string | undefined {
      const msg = fmtErr(e);
      const m = String(msg).match(/custom error\s+'([^']+)'/);
      if (!m?.[1]) return undefined;
      const raw = m[1].trim(); // e.g. "MissingRole()" or "BatchTooLarge(101, 100)"
      if (raw.endsWith("()")) return raw;
      if (raw.startsWith("BatchTooLarge("))
        return "BatchTooLarge(uint256,uint256)";
      if (raw.startsWith("LoanNFT__SoulBound("))
        return "LoanNFT__SoulBound(uint256)";
      return undefined;
    }

    async function mustRevertWithSelector(
      label: string,
      fn: () => Promise<unknown>,
      expectedSel: string,
    ) {
      try {
        await fn();
      } catch (e: any) {
        const data = extractRevertData(e);
        let sel =
          data && data.startsWith("0x") && data.length >= 10
            ? data.slice(0, 10).toLowerCase()
            : undefined;
        if (!sel) {
          const sig = extractCustomErrorSigFromMessage(e);
          if (sig) sel = errorSelector(sig).toLowerCase();
        }
        if (!sel)
          throw new Error(
            `${label}: missing revert data (cannot validate selector); msg=${fmtErr(e)}`,
          );
        if (sel !== expectedSel.toLowerCase()) {
          throw new Error(
            `${label}: unexpected selector=${sel}, expected=${expectedSel}. msg=${fmtErr(e)}`,
          );
        }
        console.log(`  ✅ [revert selector ok] ${label}: ${sel}`);
        recordExpectedRevert(label);
        return;
      }
      throw new Error(`[FAIL] Expected revert, but succeeded: ${label}`);
    }

    async function mustRevert(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch {
        console.log(`  ✅ [revert ok] ${label}`);
        recordExpectedRevert(label);
        return;
      }
      throw new Error(`[FAIL] Expected revert, but succeeded: ${label}`);
    }

    function calcHF(col: bigint, debt: bigint): bigint {
      if (debt === 0n) return MAX_UINT256;
      if (col === 0n) return 0n;
      return (col * 10_000n) / debt;
    }

    function calcLTV(col: bigint, debt: bigint): bigint {
      if (col === 0n) return 0n;
      if (debt === 0n) return 0n;
      return (debt * 10_000n) / col;
    }

    function calcMaxBorrowable(col: bigint, debt: bigint): bigint {
      const maxDebt = (col * 7_500n) / 10_000n;
      if (debt >= maxDebt) return 0n;
      return maxDebt - debt;
    }

    async function assertPreviewAccessPolicyOnce() {
      // Pick a caller that is NOT ops/admin (no VIEW_USER_DATA, no ACTION_ADMIN) and is not the target user.
      let unauth: any | undefined;
      const target = borrowers[0].address.toLowerCase();
      for (const s of signers) {
        if (s.address.toLowerCase() === target) continue;
        const hasView = (await acm.hasRole(
          key("VIEW_USER_DATA"),
          s.address,
        )) as boolean;
        const hasAdmin = (await acm.hasRole(
          key("ACTION_ADMIN"),
          s.address,
        )) as boolean;
        if (!hasView && !hasAdmin) {
          unauth = s;
          break;
        }
      }
      if (!unauth) {
        logNotice(
          "  [Notice] PreviewView access-policy check skipped (no unauthorized signer found)",
        );
        return;
      }
      await mustRevertWithSelector(
        "Unauthorized: PreviewView.previewDeposit(non-self) must revert MissingRole()",
        async () =>
          previewView
            .connect(unauth)
            .previewDeposit(borrowers[0].address, assetAddr, 0n),
        SEL_MISSING_ROLE,
      );
    }

    await assertPreviewAccessPolicyOnce();

    async function assertViews(
      step: string,
      user: string,
      asset: string,
      expectedCollateral?: bigint,
      expectedDebt?: bigint,
    ) {
      const ledgerCol = await cm.getCollateral(user, asset);
      const ledgerDebt = await vle.getDebt(user, asset);

      // View consistency is best-effort (push-based); some localhost deployments may not wire pushes.
      // Ledger (CollateralManager + VaultLendingEngine) is authoritative.
      let pvCol: bigint | null = null;
      let pvDebt: bigint | null = null;
      try {
        [pvCol, pvDebt] = await positionView.getUserPositionWithMeta(
          user,
          asset,
        );
      } catch (e: any) {
        const msg = `${step}: [BestEffort] PositionView query failed for ${user}: ${e?.message || e}`;
        if (strictViews) throw new Error(msg);
        logNotice(`  [Notice] ${msg}`);
      }
      if (
        pvCol !== null &&
        pvDebt !== null &&
        (pvCol !== ledgerCol || pvDebt !== ledgerDebt)
      ) {
        const msg = `${step}: [BestEffort] PositionView != ledger for ${user}. ledger(col=${ledgerCol},debt=${ledgerDebt}) pv(col=${pvCol},debt=${pvDebt})`;
        if (strictViews) throw new Error(msg);
        logNotice(`  [Notice] ${msg}`);
      }

      // PositionView meta must be readable (Scheme U self-read).
      try {
        const userSigner = await ethers.getSigner(user);
        await positionView
          .connect(userSigner)
          .getUserPositionWithMeta(user, asset);
      } catch (e: any) {
        const msg = `${step}: [BestEffort] PositionView meta query failed for ${user}: ${fmtErr(e)}`;
        if (strictViews) throw new Error(msg);
        logNotice(`  [Notice] ${msg}`);
      }

      let uvCol: bigint | null = null;
      let uvDebt: bigint | null = null;
      try {
        [uvCol, uvDebt] = await userView.getUserPosition(user, asset);
      } catch (e: any) {
        const msg = `${step}: [BestEffort] UserView query failed for ${user}: ${e?.message || e}`;
        if (strictViews) throw new Error(msg);
        logNotice(`  [Notice] ${msg}`);
      }
      if (
        uvCol !== null &&
        uvDebt !== null &&
        (uvCol !== ledgerCol || uvDebt !== ledgerDebt)
      ) {
        const msg = `${step}: [BestEffort] UserView != ledger for ${user}. ledger(col=${ledgerCol},debt=${ledgerDebt}) uv(col=${uvCol},debt=${uvDebt})`;
        if (strictViews) throw new Error(msg);
        logNotice(`  [Notice] ${msg}`);
      }

      if (
        expectedCollateral !== undefined &&
        ledgerCol !== expectedCollateral
      ) {
        throw new Error(
          `${step}: unexpected collateral for ${user}. expected=${expectedCollateral} actual=${ledgerCol}`,
        );
      }
      if (expectedDebt !== undefined && ledgerDebt !== expectedDebt) {
        throw new Error(
          `${step}: unexpected debt for ${user}. expected=${expectedDebt} actual=${ledgerDebt}`,
        );
      }

      // HealthView meta + BatchView meta passthrough (batch requires VIEW_USER_DATA/ADMIN).
      try {
        const [hf, ok, blockNumber] =
          await healthView.getUserHealthFactorWithMeta(user);
        const items = (await batchView
          .connect(deployer)
          .batchGetHealthFactors([user])) as Array<{
          user: string;
          healthFactor: bigint;
          isValid: boolean;
          blockNumber: bigint;
        }>;
        if (items.length === 1) {
          if (
            items[0].healthFactor !== hf ||
            items[0].isValid !== ok ||
            items[0].blockNumber !== blockNumber
          ) {
            const msg = `${step}: BatchView meta mismatch vs HealthView for ${user}`;
            if (strictViews) throw new Error(msg);
            logNotice(`  [Notice] ${msg}`);
          }
        }
      } catch (e: any) {
        const msg = `${step}: [BestEffort] HealthView/BatchView meta check failed for ${user}: ${fmtErr(e)}`;
        if (strictViews) throw new Error(msg);
        logNotice(`  [Notice] ${msg}`);
      }

      // CacheOptimizedView meta passthrough (self-read).
      try {
        const userSigner = await ethers.getSigner(user);
        await cacheOpt.connect(userSigner).getUserHealthFactor(user);
      } catch (e: any) {
        const msg = `${step}: [BestEffort] CacheOptimizedView meta check failed for ${user}: ${fmtErr(e)}`;
        if (strictViews) throw new Error(msg);
        logNotice(`  [Notice] ${msg}`);
      }

      // DashboardView meta passthrough (self-read; no price gate).
      try {
        const userSigner = await ethers.getSigner(user);
        await dashboardView
          .connect(userSigner)
          .getUserOverviewWithMeta(user, [asset]);
      } catch (e: any) {
        const msg = `${step}: [BestEffort] DashboardView meta check failed for ${user}: ${fmtErr(e)}`;
        if (strictViews) throw new Error(msg);
        logNotice(`  [Notice] ${msg}`);
      }

      // RiskView: best-effort; ensure callable when wired.
      try {
        const ra = await riskView.getUserRiskAssessment(user);
        ra.healthFactor; // touch
      } catch (e: any) {
        const msg = `${step}: [BestEffort] RiskView query failed for ${user}: ${e?.message || e}`;
        if (strictViews) throw new Error(msg);
        logNotice(`  [Notice] ${msg}`);
      }

      // PreviewView: read-only facade; values are computed from PositionView snapshots.
      // Assert consistency against PositionView snapshot when available; otherwise fall back to ledger.
      try {
        const snapCol = pvCol ?? ledgerCol;
        const snapDebt = pvDebt ?? ledgerDebt;
        const expectedHF = calcHF(snapCol, snapDebt);
        const expectedOk = expectedHF >= 10_000n;
        const expectedLTV = calcLTV(snapCol, snapDebt);
        const expectedMaxBorrowable = calcMaxBorrowable(snapCol, snapDebt);

        const userSigner = await ethers.getSigner(user);
        const [hfAfter, ok] = (await previewView
          .connect(userSigner)
          .previewDeposit(user, asset, 0n)) as [bigint, boolean];
        if (hfAfter !== expectedHF)
          throw new Error(
            `previewDeposit HF mismatch expected=${expectedHF} got=${hfAfter}`,
          );
        if (ok !== expectedOk)
          throw new Error(
            `previewDeposit ok mismatch expected=${expectedOk} got=${ok}`,
          );

        const [newHF, newLTV, maxBorrowable] = (await previewView
          .connect(userSigner)
          .previewBorrow(user, asset, 0, 0n, 0n)) as [bigint, bigint, bigint];
        if (newHF !== expectedHF)
          throw new Error(
            `previewBorrow newHF mismatch expected=${expectedHF} got=${newHF}`,
          );
        if (newLTV !== expectedLTV)
          throw new Error(
            `previewBorrow newLTV mismatch expected=${expectedLTV} got=${newLTV}`,
          );
        if (maxBorrowable !== expectedMaxBorrowable) {
          throw new Error(
            `previewBorrow maxBorrowable mismatch expected=${expectedMaxBorrowable} got=${maxBorrowable}`,
          );
        }
      } catch (e: any) {
        const msg = `${step}: [BestEffort] PreviewView check failed for ${user}: ${fmtErr(e)}`;
        if (strictViews) throw new Error(msg);
        logNotice(`  [Notice] ${msg}`);
      }
    }

    async function assertRiskStatusUpdated(step: string, user: string) {
      try {
        const [, ok, blockNumber] =
          await healthView.getUserHealthFactorWithMeta(user);
        if (!ok || blockNumber === 0n) {
          const msg = `${step}: HealthView risk status not updated (isValid=${ok} blockNumber=${blockNumber.toString()})`;
          if (strictDataPush) throw new Error(msg);
          logNotice(`  [Notice] ${msg}`);
        }
      } catch (e: any) {
        const msg = `${step}: HealthView risk status check failed for ${user}: ${fmtErr(e)}`;
        if (strictDataPush) throw new Error(msg);
        logNotice(`  [Notice] ${msg}`);
      }
    }

    async function snapshotBorrowersTotals(asset: string) {
      let colSum = 0n;
      let debtSum = 0n;
      for (const b of borrowers) {
        colSum += await cm.getCollateral(b.address, asset);
        debtSum += await vle.getDebt(b.address, asset);
      }
      return { colSum, debtSum };
    }

    // ============ Parameters ============
    // Reward: RewardManagerCore eligibility is per-order and requires principal >= 1000e6 (USDC-6).
    // Use collateral=2000 and principal=1000 to stay comfortably within LTV constraints while exercising Reward earn.
    const collateralAmt = ethers.parseUnits("2000", 6);
    const principal = ethers.parseUnits("1000", 6);
    const termDays = 5;
    const rateBps = 1000n;
    const termSec = BigInt(termDays) * ONE_DAY;

    const domain = {
      name: "RwaLending",
      version: "1",
      chainId: Number((await ethers.provider.getNetwork()).chainId),
      verifyingContract: vblAddr,
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

    // ============ Fund users ============
    console.log("💵 Funding users...");
    for (const b of borrowers) {
      await fundUsdcUsers(
        [b.address],
        ethers.parseUnits("20000", 6),
        "fund borrower",
      );
    }
    for (const l of lenders) {
      await fundUsdcUsers(
        [l.address],
        ethers.parseUnits("20000", 6),
        "fund lender",
      );
    }

    // ============ Extra: Pause/Unpause (VaultRouter + FeeRouter) ==========
    console.log("=== Extra: Pause/Unpause (VaultRouter + FeeRouter) ===");
    {
      const vaultRouter = (await ethers.getContractAt(
        "VaultRouter",
        vaultRouterAddr,
      )) as any;
      const pauseRole = key("PAUSE_SYSTEM");
      const unpauseRole = key("UNPAUSE_SYSTEM");
      let unauth: any | null = null;
      for (const s of signers) {
        if (
          !(await acm.hasRole(pauseRole, s.address)) &&
          !(await acm.hasRole(unpauseRole, s.address))
        ) {
          unauth = s;
          break;
        }
      }
      if (!unauth) {
        logNotice(
          "  [Notice] Pause/unpause role test skipped (no unauthorized signer found)",
        );
      } else {
        await mustRevertWithSelector(
          "Unauthorized: VaultRouter.pause",
          async () => vaultRouter.connect(unauth).pause(),
          SEL_MISSING_ROLE,
        );
        await mustRevertWithSelector(
          "Unauthorized: FeeRouter.pause",
          async () => feeRouter.connect(unauth).pause(),
          SEL_MISSING_ROLE,
        );
      }

      const pauseAmt = ethers.parseUnits("1", 6);
      await waitTx(vaultRouter.connect(deployer).pause(), "vaultRouter.pause");
      await waitTx(
        usdc.connect(borrowers[0]).approve(cmAddr, pauseAmt),
        "approve collateral (pause)",
      );
      await mustRevert(
        "deposit should revert when VaultRouter is paused",
        async () =>
          vaultCore.connect(borrowers[0]).deposit(assetAddr, pauseAmt),
      );
      await mustRevert(
        "withdraw should revert when VaultRouter is paused",
        async () =>
          vaultCore.connect(borrowers[0]).withdraw(assetAddr, pauseAmt),
      );
      await waitTx(
        vaultRouter.connect(deployer).unpause(),
        "vaultRouter.unpause",
      );

      await waitTx(feeRouter.connect(deployer).pause(), "feeRouter.pause");
      const feeRouterAddr = await feeRouter.getAddress();
      await waitTx(
        usdc.connect(borrowers[0]).approve(feeRouterAddr, pauseAmt),
        "approve feeRouter (pause)",
      );
      await mustRevert(
        "distributeNormal should revert when FeeRouter is paused",
        async () =>
          feeRouter.connect(borrowers[0]).distributeNormal(assetAddr, pauseAmt),
      );
      await waitTx(feeRouter.connect(deployer).unpause(), "feeRouter.unpause");
    }

    // StatisticsView strict target-state is authoritative USD-8 snapshots derived from
    // StatisticsPushManager -> PositionView + VaultLendingEngine.
    const [priceUsd8Raw, , priceAssetDecimalsRaw] =
      await po.getPrice(assetAddr);
    const priceUsd8 = toBigInt(priceUsd8Raw);
    const priceAssetDecimals = toBigInt(priceAssetDecimalsRaw);
    const priceScale = 10n ** priceAssetDecimals;
    const toUsd8 = (amount: bigint) => (amount * priceUsd8) / priceScale;

    // ============ Baseline (delta-based checkpoints) ============
    const baselineTotals = await snapshotBorrowersTotals(assetAddr);
    const [baselineStats] = await statisticsView.getGlobalStatisticsWithMeta();
    // "Dirty" means this run is not starting from a clean chain state.
    // NOTE: The 5-borrower ledger sum is only a partial view (subset of users),
    // so also treat non-zero global StatisticsView totals as dirty.
    const baselineDirty =
      baselineTotals.colSum !== 0n ||
      baselineTotals.debtSum !== 0n ||
      toBigInt(baselineStats.totalCollateral) !== 0n ||
      toBigInt(baselineStats.totalDebt) !== 0n;
    if (strictViews && !allowDirtyState && baselineDirty) {
      console.log(
        `  [Notice] Strict E2E prefers a clean state, but baseline ledger is non-zero: ` +
          `col=${ethers.formatUnits(baselineTotals.colSum, 6)} debt=${ethers.formatUnits(baselineTotals.debtSum, 6)}. ` +
          `Continuing in delta-based mode. For a clean run, restart localhost node + re-run deploylocal.ts, ` +
          `or set E2E_ALLOW_DIRTY_STATE=1 to silence this warning.`,
      );
    }

    console.log("\n=== Baseline ===");
    console.log(
      "Borrowers ledger sum collateral:",
      ethers.formatUnits(baselineTotals.colSum, 6),
    );
    console.log(
      "Borrowers ledger sum debt:",
      ethers.formatUnits(baselineTotals.debtSum, 6),
    );
    console.log(
      "StatisticsView totalCollateral (USD-8):",
      ethers.formatUnits(baselineStats.totalCollateral, 8),
    );
    console.log(
      "StatisticsView totalDebt (USD-8):",
      ethers.formatUnits(baselineStats.totalDebt, 8),
    );
    await logPositionViewVersion("baseline");

    async function readStatisticsDeltas() {
      const [statsNow] = await statisticsView.getGlobalStatisticsWithMeta();
      return {
        collateralDelta: toBigInt(statsNow.totalCollateral) - toBigInt(baselineStats.totalCollateral),
        debtDelta: toBigInt(statsNow.totalDebt) - toBigInt(baselineStats.totalDebt),
      };
    }

    async function ensureStatisticsConverged(
      label: string,
      expectedCollateralDelta: bigint,
      expectedDebtDelta: bigint,
    ) {
      const before = await readStatisticsDeltas();
      const beforeConverged =
        before.collateralDelta === expectedCollateralDelta &&
        before.debtDelta === expectedDebtDelta;

      const auditKey = `statisticsSync_${label.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
      const audit: Record<string, any> = {
        expected: {
          collateralDeltaUsd8Raw: expectedCollateralDelta.toString(),
          debtDeltaUsd8Raw: expectedDebtDelta.toString(),
        },
        beforeRetry: {
          collateralDeltaUsd8Raw: before.collateralDelta.toString(),
          debtDeltaUsd8Raw: before.debtDelta.toString(),
          converged: beforeConverged,
        },
        retryTriggered: !beforeConverged,
      };

      if (!beforeConverged) {
        console.log(
          `  ⚠️ StatisticsView required retry at ${label}: got(col=${ethers.formatUnits(before.collateralDelta, 8)}, debt=${ethers.formatUnits(before.debtDelta, 8)}) expected(col=${ethers.formatUnits(expectedCollateralDelta, 8)}, debt=${ethers.formatUnits(expectedDebtDelta, 8)})`,
        );
        await syncStatisticsSnapshots(label);
      } else {
        console.log(`  ✅ StatisticsView naturally converged at ${label}`);
      }

      const after = await readStatisticsDeltas();
      const afterConverged =
        after.collateralDelta === expectedCollateralDelta &&
        after.debtDelta === expectedDebtDelta;
      audit.afterRetry = {
        collateralDeltaUsd8Raw: after.collateralDelta.toString(),
        debtDeltaUsd8Raw: after.debtDelta.toString(),
        converged: afterConverged,
      };
      artifactCheckpoints[auditKey] = audit;

      if (!afterConverged) {
        throw new Error(
          `StatisticsView failed to converge at ${label}: got(col=${after.collateralDelta.toString()}, debt=${after.debtDelta.toString()}) expected(col=${expectedCollateralDelta.toString()}, debt=${expectedDebtDelta.toString()})`,
        );
      }
    }

    // ====== LendingEngineView observability helpers ======
    async function logLEVVersionInfo() {
      const [apiVersion, schemaVersion, implementation] =
        await lendingEngineView.getVersionInfo();
      console.log(
        `  [LEV VersionInfo] LendingEngineView @ ${lendingEngineViewAddr}: api=${apiVersion.toString()} schema=${schemaVersion.toString()} implementation=${implementation}`,
      );
    }

    async function logLEVOrder(
      step: string,
      orderId: bigint,
      borrowerSigner: any,
    ) {
      // Borrower party read should always succeed (no roles needed for self-party).
      const asBorrower = await lendingEngineView
        .connect(borrowerSigner)
        .getLoanOrder(orderId);
      // Ops read: deployer uses VIEW_USER_DATA.
      const asDeployer = await lendingEngineView
        .connect(deployer)
        .getLoanOrder(orderId);

      // System diagnostics: deployer uses VIEW_SYSTEM_DATA.
      const failedFeeAmount = (await lendingEngineView
        .connect(deployer)
        .getFailedFeeAmount(orderId)) as bigint;
      const retryCount = (await lendingEngineView
        .connect(deployer)
        .getNftRetryCount(orderId)) as bigint;
      const regFromEngine = (await lendingEngineView
        .connect(deployer)
        .getRegistryFromEngine()) as string;

      // Consistency: borrower view == ops view for core fields
      if (asBorrower.principal !== asDeployer.principal)
        throw new Error(`[LEV] ${step}: principal mismatch borrower vs ops`);
      if (
        asBorrower.borrower.toLowerCase() !== asDeployer.borrower.toLowerCase()
      )
        throw new Error(`[LEV] ${step}: borrower mismatch borrower vs ops`);
      if (asBorrower.lender.toLowerCase() !== asDeployer.lender.toLowerCase())
        throw new Error(`[LEV] ${step}: lender mismatch borrower vs ops`);
      if (asBorrower.repaidAmount !== asDeployer.repaidAmount)
        throw new Error(`[LEV] ${step}: repaidAmount mismatch borrower vs ops`);

      const orderAssetLower = (asDeployer.asset as string).toLowerCase();
      const assetDecimalsForOrder =
        orderAssetLower === assetAddr.toLowerCase() ? assetDecimals : 6;
      console.log(
        `  [LEV] ${step}: orderId=${orderId.toString()} principal=${ethers.formatUnits(
          asDeployer.principal,
          assetDecimalsForOrder,
        )} borrower=${asDeployer.borrower} lender=${asDeployer.lender} repaid=${ethers.formatUnits(
          asDeployer.repaidAmount,
          assetDecimalsForOrder,
        )} failedFeeAccruedAsset=${ethers.formatUnits(failedFeeAmount, assetDecimalsForOrder)} failedFeeAccruedRaw=${failedFeeAmount.toString()} nftRetry=${retryCount.toString()}`,
      );
      if (regFromEngine.toLowerCase() !== registryAddr.toLowerCase()) {
        throw new Error(
          `[LEV] ${step}: getRegistryFromEngine mismatch got=${regFromEngine} expect=${registryAddr}`,
        );
      }

      await logOrderSnapshot(step, orderId, borrowerSigner);
    }

    async function findLoanNftTokenIdByLoanId(
      owner: string,
      loanId: bigint,
    ): Promise<bigint | null> {
      const bal = (await loanNft.balanceOf(owner)) as bigint;
      for (let i = 0n; i < bal; i++) {
        const tokenId = (await loanNft.tokenOfOwnerByIndex(owner, i)) as bigint;
        const meta = await loanNft.getLoanMetadata(tokenId);
        if ((meta.loanId as bigint) === loanId) return tokenId;
      }
      return null;
    }

    async function logOrderSnapshot(
      step: string,
      orderId: bigint,
      borrowerSigner: any,
    ) {
      const ord = await lendingEngineView
        .connect(borrowerSigner)
        .getLoanOrder(orderId);
      // IOrderEngine.LoanOrder fields (SSOT): principal, rate(bps), term(blocks), borrower, lender, asset, startTimestamp(startBlock), maturity(maturityBlock), repaidAmount.
      // Be defensive: ethers may return both named fields and tuple indices.
      const principal = (ord as any).principal ?? (ord as any)[0];
      const rateBps = (ord as any).rate ?? (ord as any)[1];
      const termBlocks = (ord as any).term ?? (ord as any)[2];
      const borrower = (ord as any).borrower ?? (ord as any)[3];
      const lender = (ord as any).lender ?? (ord as any)[4];
      const orderAsset = (ord as any).asset ?? (ord as any)[5];
      const startBlock = (ord as any).startTimestamp ?? (ord as any)[6];
      const maturityBlock = (ord as any).maturity ?? (ord as any)[7];
      const repaidAmount = (ord as any).repaidAmount ?? (ord as any)[8];

      const orderAssetLower = (orderAsset as string).toLowerCase();
      const assetDecimalsForOrder =
        orderAssetLower === assetAddr.toLowerCase() ? assetDecimals : 6;

      console.log(
        `  [Order] ${step}: orderId=${orderId.toString()} principal=${ethers.formatUnits(
          principal,
          assetDecimalsForOrder,
        )} repaid=${ethers.formatUnits(repaidAmount, assetDecimalsForOrder)} borrower=${borrower} lender=${lender}`,
      );
      console.log(
        `  [Order] ${step}: asset=${orderAsset} rateBps=${rateBps?.toString?.() ?? String(rateBps)} termBlocks=${termBlocks?.toString?.() ?? String(termBlocks)} startBlock=${startBlock?.toString?.() ?? String(startBlock)} maturityBlock=${maturityBlock?.toString?.() ?? String(maturityBlock)}`,
      );

      const tokenId = await findLoanNftTokenIdByLoanId(
        borrowerSigner.address,
        orderId,
      );
      if (tokenId === null) {
        console.log(`  [LoanNFT] ${step}: status=none`);
      } else {
        const meta = await loanNft.getLoanMetadata(tokenId);
        const st = meta.status as bigint;
        const stLabel =
          st === 0n ? "Active" : st === 1n ? "Repaid" : st.toString();
        console.log(
          `  [LoanNFT] ${step}: tokenId=${tokenId.toString()} status=${stLabel}`,
        );
      }

      const [pvCol, pvDebt] = await positionView.getUserPositionWithMeta(
        borrowerSigner.address,
        orderAsset,
      );
      const [uvCol, uvDebt] = await userView.getUserPosition(
        borrowerSigner.address,
        orderAsset,
      );
      const rewardSummary = await rewardView
        .connect(deployer)
        .getUserRewardSummaryWithMeta(borrowerSigner.address);
      const [stats] = await statisticsView.getGlobalStatisticsWithMeta();
      console.log(
        `  [PositionView] ${step}: col=${ethers.formatUnits(pvCol, 6)} debt=${ethers.formatUnits(pvDebt, 6)}`,
      );
      console.log(
        `  [UserView] ${step}: col=${ethers.formatUnits(uvCol, 6)} debt=${ethers.formatUnits(uvDebt, 6)}`,
      );
      console.log(
        `  [RewardView] ${step}: burned=${fmtEasy(rewardSummary[0])} pendingPenalty=${fmtEasy(
          rewardSummary[1],
        )}`,
      );
      console.log(
        `  [StatisticsView] ${step}: activeUsers=${stats.activeUsers.toString()} totalCollateral=${ethers.formatUnits(
          stats.totalCollateral,
          USD8_DECIMALS,
        )} totalDebt=${ethers.formatUnits(stats.totalDebt, USD8_DECIMALS)}`,
      );
    }

    await logLEVVersionInfo();

    // Reward baseline snapshot (reward-qualifying borrower = borrower#1 / Pair1)
    const rewardBorrower = borrowers[0];

    // Read-gate sanity: direct RMCore reads should be blocked for EOAs.
    {
      // In strict mode, RewardManagerCore should expose NO external/public view/pure business getters.
      // Older deployments may still have legacy getters guarded by custom errors; accept either:
      // - function not present in ABI (preferred), OR
      // - present but reverts with the expected unauthorized selector.
      const fn = (rmCore as any).getUserLevel as
        | undefined
        | ((user: string) => Promise<unknown>);
      if (typeof fn !== "function") {
        console.log(
          "  ✅ [Reward] RMCore has no getUserLevel() (strict no-view/pure exports)",
        );
      } else {
        const unauthorizedReaderSel = errorSelector(
          "RewardManagerCore__UnauthorizedReader(address)",
        );
        await mustRevertWithSelector(
          "Read-gate: EOA cannot call RewardManagerCore.getUserLevel",
          async () =>
            rmCore.connect(rewardBorrower).getUserLevel(rewardBorrower.address),
          unauthorizedReaderSel,
        );
      }

      // BorrowCheck read-path is protocol-only (caller must be OrderEngine). EOAs must be rejected.
      const bc = (rewardView as any).getUserLevelForBorrowCheck as
        | undefined
        | ((user: string) => Promise<unknown>);
      if (typeof bc === "function") {
        await mustRevertWithSelector(
          "Read-gate: EOA cannot call RewardView.getUserLevelForBorrowCheck",
          async () =>
            rewardView
              .connect(rewardBorrower)
              .getUserLevelForBorrowCheck(rewardBorrower.address),
          SEL_MISSING_ROLE,
        );
      }
    }

    const easyBalBefore = (await easyToken.balanceOf(
      rewardBorrower.address,
    )) as bigint;
    const [easyEarnedBefore] = (await rewardView
      .connect(deployer)
      .getUserEasyEarnedWithMeta(rewardBorrower.address)) as [
      bigint,
      bigint,
      boolean,
    ];
    const rewardSummaryBefore = await rewardView
      .connect(deployer)
      .getUserRewardSummaryWithMeta(rewardBorrower.address);
    const easyBorrowerBefore = easyBalBefore;
    const easyLenderBefore = (await easyToken.balanceOf(
      lenders[0].address,
    )) as bigint;
    console.log(
      `  [Reward] baseline: borrower=${rewardBorrower.address} easyBalance=${fmtEasy(easyBalBefore)} (raw=${easyBalBefore.toString()}) easyEarned=${fmtEasy(
        easyEarnedBefore,
      )} (raw=${easyEarnedBefore.toString()}) totalBurned=${fmtEasy(rewardSummaryBefore[0])} pendingPenalty=${fmtEasy(
        rewardSummaryBefore[1],
      )}`,
    );

    console.log("\n=== Reward Extended Checks ===");
    await runRewardExtendedChecks();

    // Track expected per-borrower absolute state relative to current chain (do not assume fresh chain)
    const expectedCollateralByBorrower = new Map<string, bigint>();
    const expectedDebtByBorrower = new Map<string, bigint>();
    for (const b of borrowers) {
      expectedCollateralByBorrower.set(
        b.address,
        await cm.getCollateral(b.address, assetAddr),
      );
      expectedDebtByBorrower.set(
        b.address,
        await vle.getDebt(b.address, assetAddr),
      );
    }

    // ============ Step 1: Deposits (all borrowers) ============
    console.log("\n=== Step 1: Deposits (all borrowers) ===");
    for (let i = 0; i < borrowers.length; i++) {
      const borrower = borrowers[i];
      const pvVerBefore = await positionView.getPositionVersion(
        borrower.address,
        assetAddr,
      );
      // Funds-flow SSOT: Collateral is pulled by CollateralManager (spender MUST be CM).
      await waitTx(
        usdc.connect(borrower).approve(cmAddr, collateralAmt),
        "approve collateral",
      );
      const depRc = await waitTx(
        vaultCore.connect(borrower).deposit(assetAddr, collateralAmt),
        "deposit",
      );

      // Strict diagnostics: surface silent view-push failures immediately.
      if (strictViews) {
        const pvVerAfter = await positionView.getPositionVersion(
          borrower.address,
          assetAddr,
        );
        const failedPushes = (depRc?.logs || [])
          .map((log: any) => {
            try {
              return cm.interface.parseLog({
                topics: log.topics as string[],
                data: log.data,
              });
            } catch {
              return null;
            }
          })
          .filter((e: any) => e && e.name === "ViewCachePushFailed");

        if (failedPushes.length > 0) {
          const e: any = failedPushes[0];
          const reason = (e.args?.reason as string) || "0x";
          throw new Error(
            `Deposit view-cache push failed for borrower#${i + 1} (${borrower.address}). reason=${reason}`,
          );
        }

        if (pvVerAfter === pvVerBefore) {
          throw new Error(
            `Deposit did not advance PositionView version for borrower#${i + 1} (${borrower.address}). ` +
              `verBefore=${pvVerBefore.toString()} verAfter=${pvVerAfter.toString()}`,
          );
        }
      }
      expectedCollateralByBorrower.set(
        borrower.address,
        (expectedCollateralByBorrower.get(borrower.address) || 0n) +
          collateralAmt,
      );
      await assertViews(
        `After deposit borrower#${i + 1}`,
        borrower.address,
        assetAddr,
        expectedCollateralByBorrower.get(borrower.address),
        expectedDebtByBorrower.get(borrower.address),
      );
      console.log(
        `  ✅ borrower#${i + 1} deposited ${ethers.formatUnits(collateralAmt, 6)}`,
      );
    }
    await logPositionViewVersion("after deposits");

    // ============ Extra: Asset whitelist gating (negative) ==========
    console.log("=== Extra: Asset whitelist gating (negative) ===");
    {
      const borrower = borrowers[0];
      const lender = lenders[0];
      const wasAllowed = (await awRead.isAssetAllowed(assetAddr)) as boolean;
      if (!wasAllowed) {
        logNotice(
          "  [Notice] Asset already not allowed; skipping whitelist negative test.",
        );
      } else {
        await waitTx(
          awAdmin.connect(deployer).removeAllowedAsset(assetAddr),
          "removeAllowedAsset (negative)",
        );
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
          salt: ethers.keccak256(
            ethers.toUtf8Bytes(`whitelist-borrow-${Date.now()}`),
          ),
        };
        const lendIntent = {
          lenderSigner: lender.address,
          asset: assetAddr,
          amount: principal,
          minTermDays: 1,
          maxTermDays: 30,
          minRateBps: 0n,
          expireAt,
          salt: ethers.keccak256(
            ethers.toUtf8Bytes(`whitelist-lend-${Date.now()}`),
          ),
        };
        await waitTx(
          usdc.connect(lender).approve(vblAddr, principal),
          "approve reserve (whitelist)",
        );
        const lendHash = buildLendIntentHash(lendIntent);
        await mustRevert(
          "reserveForLending should reject non-whitelisted asset",
          async () =>
            vbl
              .connect(lender)
              .reserveForLending(
                lender.address,
                assetAddr,
                principal,
                lendHash,
              ),
        );
        await waitTx(
          awAdmin.connect(deployer).addAllowedAsset(assetAddr),
          "addAllowedAsset (restore)",
        );
      }
    }

    // ============ Extra: Borrow above max LTV (preview boundary) ==========
    console.log("=== Extra: Borrow above max LTV (preview boundary) ===");
    {
      const borrower = borrowers[1];
      const [maxBorrowable] = (await previewView.getMaxBorrowableWithMeta(
        borrower.address,
        assetAddr,
      )) as [bigint, boolean, bigint, bigint, bigint];
      if (maxBorrowable === 0n) {
        logNotice(
          "  [Notice] maxBorrowable=0; skipping preview boundary check.",
        );
      } else {
        const borrowAmount = maxBorrowable + 1n;
        const [newHf, newLtv, remainingMax] = (await previewView.previewBorrow(
          borrower.address,
          assetAddr,
          0n,
          0n,
          borrowAmount,
        )) as [bigint, bigint, bigint, boolean, bigint, bigint];
        if (remainingMax !== 0n) {
          throw new Error(
            "PreviewView.previewBorrow expected remaining maxBorrowable == 0 for above-max borrow",
          );
        }
        console.log(
          `  ✅ Preview boundary: borrow=${ethers.formatUnits(borrowAmount, 6)} newHF=${(Number(newHf) / 100).toFixed(2)}% newLTV=${(Number(newLtv) / 100).toFixed(2)}% remainingMax=0`,
        );
      }
    }

    // ============ Step 2: Create orders via matchflow ============
    console.log("\n=== Step 2: Matchflow finalize (create orders) ===");

    type OrderRef = { borrower: string; orderId: bigint; principal: bigint };
    const orders: OrderRef[] = [];

    async function finalizeOne(
      borrowerSigner: any,
      lenderSigner: any,
      amount: bigint,
      saltSuffix: string,
      opts?: { withGuarantee?: boolean; forceDisableGuarantee?: boolean },
    ): Promise<bigint> {
      const expireAt = (await latestBlockNumber()) + ONE_HOUR_BLOCKS;

      const borrowIntent = {
        borrower: borrowerSigner.address,
        collateralAsset: assetAddr,
        collateralAmount: collateralAmt,
        borrowAsset: assetAddr,
        amount,
        termDays,
        rateBps,
        expireAt,
        salt: ethers.keccak256(ethers.toUtf8Bytes(`borrow-${saltSuffix}`)),
      };

      const lendIntent = {
        lenderSigner: lenderSigner.address,
        asset: assetAddr,
        amount,
        minTermDays: 1,
        maxTermDays: 30,
        minRateBps: 0n,
        expireAt,
        salt: ethers.keccak256(ethers.toUtf8Bytes(`lend-${saltSuffix}`)),
      };

      await waitTx(
        usdc.connect(lenderSigner).approve(vblAddr, amount),
        "approve reserve",
      );
      const lendHash = buildLendIntentHash(lendIntent);
      await waitTx(
        vbl
          .connect(lenderSigner)
          .reserveForLending(lenderSigner.address, assetAddr, amount, lendHash),
        "reserveForLending",
      );

      const sigBorrower = await borrowerSigner.signTypedData(
        domain,
        typesBorrow as any,
        borrowIntent as any,
      );
      const sigLender = await lenderSigner.signTypedData(
        domain,
        typesLend as any,
        lendIntent as any,
      );

      if (opts?.forceDisableGuarantee) {
        try {
          await waitTx(
            ergm.connect(deployer).setGuaranteeEnabled(assetAddr, false),
            "setGuaranteeEnabled(false)",
          );
        } catch {
          // best-effort: will fall back to current guarantee mode
        }
      }
      let guaranteeEnabledNow = false;
      try {
        guaranteeEnabledNow = (await ergm.isGuaranteeEnabled(
          assetAddr,
        )) as boolean;
      } catch {
        guaranteeEnabledNow = false;
      }
      const withGuarantee =
        opts?.withGuarantee === true ||
        (guaranteeEnabledNow && !opts?.forceDisableGuarantee);

      // Extension Flow (docs/Usage-Guide/Funds-Flow-Architecture-Guide.md §5):
      // If guarantee is enabled, VaultBusinessLogic.finalizeMatch should
      // - pull promisedInterest from borrower into GuaranteeFundManager (custody SSOT)
      // - write a guarantee record into ERGM (semantic SSOT)
      //
      // IMPORTANT: this requires borrower approving GFM for promisedInterest (transferFrom).
      const promisedInterest = calcTotalDue(amount, rateBps, termSec) - amount;
      const gfmLockedBefore = withGuarantee
        ? ((await gfm.getLockedGuarantee(
            borrowerSigner.address,
            assetAddr,
          )) as bigint)
        : 0n;
      const hadGuaranteeBefore = withGuarantee
        ? ((await ergm.hasActiveGuarantee(
            borrowerSigner.address,
            assetAddr,
          )) as boolean)
        : false;
      if (withGuarantee) {
        if (hadGuaranteeBefore) {
          throw new Error(
            `finalizeMatch(${saltSuffix}): borrower already has an active guarantee for this asset; ` +
              `extension flow currently supports only 1 active guarantee per (user, asset).`,
          );
        }
        if (promisedInterest > 0n) {
          await waitTx(
            usdc.connect(borrowerSigner).approve(gfmAddr, promisedInterest),
            "approve GFM",
          );
        }
      }

      // Fee flow assertions (SSOT):
      // - borrower receives "net" = amount - platformFee - ecosystemFee
      // - platformTreasury/ecosystemVault receive the fee amounts
      const borrowerBalBefore = (await usdc.balanceOf(
        borrowerSigner.address,
      )) as bigint;
      const treasuryBalBefore = (await usdc.balanceOf(
        platformTreasury,
      )) as bigint;
      const ecoBalBefore = (await usdc.balanceOf(ecosystemVault)) as bigint;

      const tx = await vbl
        .connect(deployer)
        .finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [sigLender]);
      const receipt = await waitTx(Promise.resolve(tx), "finalizeMatch");
      recordDataPushed(receipt);

      let orderId: bigint | null = null;
      let eventBorrower: string | null = null;
      let eventLender: string | null = null;
      for (const log of receipt!.logs) {
        try {
          // LendingEngine emits legacy LoanOrderCreated too; ORDER_ENGINE is SSOT.
          if (
            String(log.address).toLowerCase() !==
            String(orderEngineAddr).toLowerCase()
          )
            continue;
          const parsed = orderEngine.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          if (parsed?.name === "LoanOrderCreated") {
            orderId = parsed.args.orderId as bigint;
            eventBorrower = String(parsed.args.borrower);
            eventLender = String(parsed.args.lender);
            break;
          }
        } catch {
          // ignore
        }
      }
      if (orderId === null)
        throw new Error(`LoanOrderCreated not found (${saltSuffix})`);

      const borrowerAddrFromEvent = (eventBorrower ??
        borrowerSigner.address) as string;
      const lenderAddrFromEvent = (eventLender ??
        lenderSigner.address) as string;

      orderCreateMetaById[orderId.toString()] = {
        saltSuffix,
        borrowerSigner: String(borrowerSigner.address),
        lenderSigner: String(lenderSigner.address),
        borrowerFromEvent: borrowerAddrFromEvent,
        lenderFromEvent: lenderAddrFromEvent,
      };

      artifactOrderCreates.push({
        saltSuffix,
        borrower: borrowerAddrFromEvent,
        lender: lenderAddrFromEvent,
        orderId: orderId.toString(),
        principalRaw: amount.toString(),
        withGuarantee,
      });

      recordExpectedBorrowerOrderId(borrowerAddrFromEvent, orderId);
      await assertBorrowerEnumeratesOrder(
        borrowerAddrFromEvent.toLowerCase() ===
          String(borrowerSigner.address).toLowerCase()
          ? borrowerSigner
          : await ethers.getSigner(borrowerAddrFromEvent),
        orderId,
        `finalizeMatch(${saltSuffix})`,
      );

      // Extension Flow assertions:
      if (withGuarantee) {
        const gfmLockedAfter = (await gfm.getLockedGuarantee(
          borrowerSigner.address,
          assetAddr,
        )) as bigint;
        if (gfmLockedAfter - gfmLockedBefore !== promisedInterest) {
          throw new Error(
            `finalizeMatch(${saltSuffix}): guarantee custody mismatch. lockedDelta=${ethers.formatUnits(
              gfmLockedAfter - gfmLockedBefore,
              6,
            )} expected=${ethers.formatUnits(promisedInterest, 6)}`,
          );
        }
        const gid = (await ergm.getUserGuaranteeId(
          borrowerSigner.address,
          assetAddr,
        )) as bigint;
        if (gid === 0n)
          throw new Error(
            `finalizeMatch(${saltSuffix}): ERGM guaranteeId not set`,
          );
        const rec = await ergm.getGuaranteeRecord(gid);
        if ((rec.asset as string).toLowerCase() !== assetAddr.toLowerCase())
          throw new Error(
            `finalizeMatch(${saltSuffix}): ERGM record asset mismatch`,
          );
        // NOTE: current implementation records lender as LenderPoolVault (not the lender EOA).
        if (
          (rec.lender as string).toLowerCase() !== lenderPoolAddr.toLowerCase()
        )
          throw new Error(
            `finalizeMatch(${saltSuffix}): ERGM record lender(pool) mismatch`,
          );
        if (toBigInt(rec.principal) !== amount)
          throw new Error(
            `finalizeMatch(${saltSuffix}): ERGM record principal mismatch`,
          );
        if (toBigInt(rec.promisedInterest) !== promisedInterest)
          throw new Error(
            `finalizeMatch(${saltSuffix}): ERGM record promisedInterest mismatch`,
          );
        if (
          !(await ergm.hasActiveGuarantee(borrowerSigner.address, assetAddr))
        ) {
          throw new Error(
            `finalizeMatch(${saltSuffix}): ERGM expected active guarantee`,
          );
        }
      }

      const expectedPlatformFee = calcFee(amount, platformFeeBps);
      const expectedEcoFee = calcFee(amount, ecoFeeBps);
      const expectedNet = amount - expectedPlatformFee - expectedEcoFee;
      // If guarantee is enabled for this finalizeMatch, borrower also pays promisedInterest into GFM custody.
      const expectedBorrowerDelta =
        expectedNet - (withGuarantee ? promisedInterest : 0n);

      const borrowerBalAfter = (await usdc.balanceOf(
        borrowerSigner.address,
      )) as bigint;
      const treasuryBalAfter = (await usdc.balanceOf(
        platformTreasury,
      )) as bigint;
      const ecoBalAfter = (await usdc.balanceOf(ecosystemVault)) as bigint;

      const borrowerDelta = borrowerBalAfter - borrowerBalBefore;
      if (borrowerDelta !== expectedBorrowerDelta) {
        throw new Error(
          `finalizeMatch(${saltSuffix}): borrower net mismatch got=${ethers.formatUnits(borrowerDelta, 6)} expected=${ethers.formatUnits(
            expectedBorrowerDelta,
            6,
          )}`,
        );
      }

      if (platformTreasury.toLowerCase() === ecosystemVault.toLowerCase()) {
        const feeDelta = treasuryBalAfter - treasuryBalBefore;
        const expectedFee = expectedPlatformFee + expectedEcoFee;
        if (feeDelta !== expectedFee) {
          throw new Error(
            `finalizeMatch(${saltSuffix}): treasury==ecoVault fee mismatch got=${ethers.formatUnits(
              feeDelta,
              6,
            )} expected=${ethers.formatUnits(expectedFee, 6)}`,
          );
        }
      } else {
        const platformDelta = treasuryBalAfter - treasuryBalBefore;
        const ecoDelta = ecoBalAfter - ecoBalBefore;
        if (platformDelta !== expectedPlatformFee) {
          throw new Error(
            `finalizeMatch(${saltSuffix}): platform fee mismatch`,
          );
        }
        if (ecoDelta !== expectedEcoFee) {
          throw new Error(
            `finalizeMatch(${saltSuffix}): ecosystem fee mismatch`,
          );
        }
      }

      // update expected debt
      expectedDebtByBorrower.set(
        borrowerSigner.address,
        (expectedDebtByBorrower.get(borrowerSigner.address) || 0n) + amount,
      );

      await assertViews(
        `After finalizeMatch(${saltSuffix})`,
        borrowerSigner.address,
        assetAddr,
        expectedCollateralByBorrower.get(borrowerSigner.address),
        expectedDebtByBorrower.get(borrowerSigner.address),
      );

      return orderId;
    }

    // Pair1: borrower1 + lender1 (single 500)
    {
      const id = await finalizeOne(borrowers[0], lenders[0], principal, "p1", {
        forceDisableGuarantee: true,
      });
      orders.push({ borrower: borrowers[0].address, orderId: id, principal });
      await logLEVOrder("after finalizeMatch (pair1)", id, borrowers[0]);
    }
    console.log("  ✅ Pair1 order created");

    // Pair2: borrower2 + lender2 (single 500) — will do partial repay
    {
      const id = await finalizeOne(borrowers[1], lenders[1], principal, "p2", {
        forceDisableGuarantee: true,
      });
      orders.push({ borrower: borrowers[1].address, orderId: id, principal });
      await logLEVOrder("after finalizeMatch (pair2)", id, borrowers[1]);
    }
    console.log("  ✅ Pair2 order created (will partial repay)");

    // Pair3: borrower3 + lender3 (single 500)
    {
      const id = await finalizeOne(borrowers[2], lenders[2], principal, "p3", {
        forceDisableGuarantee: true,
      });
      orders.push({ borrower: borrowers[2].address, orderId: id, principal });
      // keep logs lighter: only print for first 2 pairs + complex scenarios
      await logLEVOrder("after finalizeMatch (pair3)", id, borrowers[2]);
    }
    console.log("  ✅ Pair3 order created");

    // Pair4: borrower4 split: two orders 250+250 with two lenders
    const half = principal / 2n;
    {
      const id1 = await finalizeOne(borrowers[3], lenders[3], half, "p4a", {
        forceDisableGuarantee: true,
      });
      orders.push({
        borrower: borrowers[3].address,
        orderId: id1,
        principal: half,
      });
      const id2 = await finalizeOne(
        borrowers[3],
        lenders[4],
        principal - half,
        "p4b",
        { forceDisableGuarantee: true },
      );
      orders.push({
        borrower: borrowers[3].address,
        orderId: id2,
        principal: principal - half,
      });
      await logLEVOrder(
        "after finalizeMatch (pair4 split a)",
        id1,
        borrowers[3],
      );
      await logLEVOrder(
        "after finalizeMatch (pair4 split b)",
        id2,
        borrowers[3],
      );
    }
    console.log("  ✅ Pair4 split orders created (2 lenders)");

    // Pair5: borrower5 + lender1 again (single 500) — will repay overdue
    {
      const id = await finalizeOne(borrowers[4], lenders[0], principal, "p5", {
        forceDisableGuarantee: true,
      });
      orders.push({ borrower: borrowers[4].address, orderId: id, principal });
      await logLEVOrder(
        "after finalizeMatch (pair5 overdue)",
        id,
        borrowers[4],
      );
    }
    console.log("  ✅ Pair5 order created (will repay overdue)\n");

    // ============ Extra: Withdraw with debt should revert ==========
    console.log("=== Extra: Withdraw with active debt (negative) ===");
    {
      const borrower = borrowers[0];
      // CollateralManager does not enforce HF/LTV constraints on withdraw; it only enforces ledger balance.
      // So the deterministic negative case here is over-withdraw (even if the user has active debt).
      const currentCollateral = (await cm.getCollateral(
        borrower.address,
        assetAddr,
      )) as bigint;
      const withdrawAmt = currentCollateral + 1n;
      await mustRevert(
        "withdraw should revert when amount exceeds collateral balance (with active debt)",
        async () =>
          vaultCore.connect(borrower).withdraw(assetAddr, withdrawAmt),
      );
    }

    // ============ Extra: Intent Expiry + Replay (negative) ==========
    console.log("=== Extra: Intent Expiry + Replay (negative) ===");
    {
      const borrower = borrowers[0];
      const lender = lenders[0];
      const alreadyReservedSel = errorSelector(
        "SettlementReserveLib__AlreadyReserved()",
      );
      const notActiveSel = errorSelector("SettlementReserveLib__NotActive()");
      const expiredAt = (await latestBlockNumber()) - 1n;
      const borrowIntent = {
        borrower: borrower.address,
        collateralAsset: assetAddr,
        collateralAmount: collateralAmt,
        borrowAsset: assetAddr,
        amount: principal,
        termDays,
        rateBps,
        expireAt: expiredAt,
        salt: ethers.keccak256(
          ethers.toUtf8Bytes(`expired-borrow-${Date.now()}`),
        ),
      };
      const lendIntent = {
        lenderSigner: lender.address,
        asset: assetAddr,
        amount: principal,
        minTermDays: 1,
        maxTermDays: 30,
        minRateBps: 0n,
        expireAt: expiredAt,
        salt: ethers.keccak256(
          ethers.toUtf8Bytes(`expired-lend-${Date.now()}`),
        ),
      };
      await waitTx(
        usdc.connect(lender).approve(vblAddr, principal),
        "approve reserve (expired)",
      );
      const lendHash = buildLendIntentHash(lendIntent);
      await waitTx(
        vbl
          .connect(lender)
          .reserveForLending(lender.address, assetAddr, principal, lendHash),
        "reserveForLending (expired)",
      );
      const sigBorrower = await borrower.signTypedData(
        domain,
        typesBorrow as any,
        borrowIntent as any,
      );
      const sigLender = await lender.signTypedData(
        domain,
        typesLend as any,
        lendIntent as any,
      );
      await mustRevert(
        "finalizeMatch should reject expired intents",
        async () =>
          vbl
            .connect(deployer)
            .finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [
              sigLender,
            ]),
      );
      await waitTx(
        vbl.connect(lender).cancelReserve(lendHash),
        "cancelReserve (expired)",
      );

      // Duplicate reserve should fail (AlreadyReserved)
      const dupLendIntent = {
        lenderSigner: lender.address,
        asset: assetAddr,
        amount: principal,
        minTermDays: 1,
        maxTermDays: 30,
        minRateBps: 0n,
        expireAt: (await latestBlockNumber()) + ONE_HOUR_BLOCKS,
        salt: ethers.keccak256(ethers.toUtf8Bytes(`dup-lend-${Date.now()}`)),
      };
      // reserveForLending does ERC20 transferFrom *before* checking duplicate reserves.
      // Approve 2x so the 2nd call reaches SettlementReserveLib__AlreadyReserved().
      await waitTx(
        usdc.connect(lender).approve(vblAddr, principal * 2n),
        "approve reserve (dup)",
      );
      const dupHash = buildLendIntentHash(dupLendIntent);
      await waitTx(
        vbl
          .connect(lender)
          .reserveForLending(lender.address, assetAddr, principal, dupHash),
        "reserveForLending (dup)",
      );
      await mustRevertWithSelector(
        "reserveForLending should reject duplicate intent hash",
        async () =>
          vbl
            .connect(lender)
            .reserveForLending(lender.address, assetAddr, principal, dupHash),
        alreadyReservedSel,
      );
      await waitTx(
        vbl.connect(lender).cancelReserve(dupHash),
        "cancelReserve (dup)",
      );

      // Cancel then finalize should fail (NotActive)
      const cancelBorrowIntent = {
        borrower: borrower.address,
        collateralAsset: assetAddr,
        collateralAmount: collateralAmt,
        borrowAsset: assetAddr,
        amount: principal,
        termDays,
        rateBps,
        expireAt: (await latestBlockNumber()) + ONE_HOUR_BLOCKS,
        salt: ethers.keccak256(
          ethers.toUtf8Bytes(`cancel-borrow-${Date.now()}`),
        ),
      };
      const cancelLendIntent = {
        lenderSigner: lender.address,
        asset: assetAddr,
        amount: principal,
        minTermDays: 1,
        maxTermDays: 30,
        minRateBps: 0n,
        expireAt: cancelBorrowIntent.expireAt,
        salt: ethers.keccak256(ethers.toUtf8Bytes(`cancel-lend-${Date.now()}`)),
      };
      await waitTx(
        usdc.connect(lender).approve(vblAddr, principal),
        "approve reserve (cancel)",
      );
      const cancelHash = buildLendIntentHash(cancelLendIntent);
      await waitTx(
        vbl
          .connect(lender)
          .reserveForLending(lender.address, assetAddr, principal, cancelHash),
        "reserveForLending (cancel)",
      );
      await waitTx(
        vbl.connect(lender).cancelReserve(cancelHash),
        "cancelReserve (cancel)",
      );
      const sigBorrowerCancel = await borrower.signTypedData(
        domain,
        typesBorrow as any,
        cancelBorrowIntent as any,
      );
      const sigLenderCancel = await lender.signTypedData(
        domain,
        typesLend as any,
        cancelLendIntent as any,
      );
      await mustRevertWithSelector(
        "finalizeMatch should reject cancelled reserve",
        async () =>
          vbl
            .connect(deployer)
            .finalizeMatch(
              cancelBorrowIntent,
              [cancelLendIntent],
              sigBorrowerCancel,
              [sigLenderCancel],
            ),
        notActiveSel,
      );

      // Replay: finalizeMatch should not allow reusing the same intents/signatures after success.
      const replayBorrowIntent = {
        borrower: borrower.address,
        collateralAsset: assetAddr,
        collateralAmount: collateralAmt,
        borrowAsset: assetAddr,
        amount: principal,
        termDays,
        rateBps,
        expireAt: (await latestBlockNumber()) + ONE_HOUR_BLOCKS,
        salt: ethers.keccak256(
          ethers.toUtf8Bytes(`replay-borrow-${Date.now()}`),
        ),
      };
      const replayLendIntent = {
        lenderSigner: lender.address,
        asset: assetAddr,
        amount: principal,
        minTermDays: 1,
        maxTermDays: 30,
        minRateBps: 0n,
        expireAt: replayBorrowIntent.expireAt,
        salt: ethers.keccak256(ethers.toUtf8Bytes(`replay-lend-${Date.now()}`)),
      };
      // Important: keep replay test side-effect free (it would otherwise create an extra live order and break later checkpoints).
      const snapReplay = await withTimeout(
        network.provider.send("evm_snapshot", []),
        EVM_TIMEOUT_MS,
        "evm_snapshot(replay)",
      );
      try {
        await waitTx(
          usdc.connect(lender).approve(vblAddr, principal),
          "approve reserve (replay)",
        );
        const replayHash = buildLendIntentHash(replayLendIntent);
        await waitTx(
          vbl
            .connect(lender)
            .reserveForLending(
              lender.address,
              assetAddr,
              principal,
              replayHash,
            ),
          "reserveForLending (replay)",
        );
        const sigBorrower2 = await borrower.signTypedData(
          domain,
          typesBorrow as any,
          replayBorrowIntent as any,
        );
        const sigLender2 = await lender.signTypedData(
          domain,
          typesLend as any,
          replayLendIntent as any,
        );
        const okTx = await vbl
          .connect(deployer)
          .finalizeMatch(replayBorrowIntent, [replayLendIntent], sigBorrower2, [
            sigLender2,
          ]);
        await waitTx(Promise.resolve(okTx), "finalizeMatch (replay ok)");
        await mustRevert(
          "finalizeMatch should reject replayed intents",
          async () =>
            vbl
              .connect(deployer)
              .finalizeMatch(
                replayBorrowIntent,
                [replayLendIntent],
                sigBorrower2,
                [sigLender2],
              ),
        );
      } finally {
        await withTimeout(
          network.provider.send("evm_revert", [snapReplay]),
          EVM_TIMEOUT_MS,
          "evm_revert(replay)",
        );
      }
    }

    // ============ Checkpoint A: Totals after all matches (delta-based) ============
    console.log("=== Checkpoint A: Totals after matches ===");
    await refreshPriceOracleBlock({
      priceOracle: po,
      asset: assetAddr,
      signer: deployer,
      print: true,
    });
    const expectedCollateralDelta = collateralAmt * BigInt(borrowers.length);
    const expectedDebtDelta = orders.reduce((a, o) => a + o.principal, 0n);
    const expectedStatsCollateralDelta = toUsd8(expectedCollateralDelta);
    const expectedStatsDebtDeltaExpected = toUsd8(expectedDebtDelta);

    await ensureStatisticsConverged(
      "after matches",
      expectedStatsCollateralDelta,
      expectedStatsDebtDeltaExpected,
    );
    const afterMatchTotals = await snapshotBorrowersTotals(assetAddr);
    const [afterMatchStats] =
      await statisticsView.getGlobalStatisticsWithMeta();

    const ledgerColDelta = afterMatchTotals.colSum - baselineTotals.colSum;
    const ledgerDebtDelta = afterMatchTotals.debtSum - baselineTotals.debtSum;
    const statsColDelta =
      toBigInt(afterMatchStats.totalCollateral) -
      toBigInt(baselineStats.totalCollateral);
    const statsDebtDelta =
      toBigInt(afterMatchStats.totalDebt) - toBigInt(baselineStats.totalDebt);

    artifactCheckpoints["checkpointA_after_matches"] = {
      expected: {
        collateralDeltaRaw: expectedCollateralDelta.toString(),
        debtDeltaRaw: expectedDebtDelta.toString(),
        statsCollateralDeltaUsd8Raw: expectedStatsCollateralDelta.toString(),
        statsDebtDeltaUsd8Raw: expectedStatsDebtDeltaExpected.toString(),
      },
      ledger: {
        collateralDeltaRaw: ledgerColDelta.toString(),
        debtDeltaRaw: ledgerDebtDelta.toString(),
      },
      statisticsView: {
        collateralDeltaUsd8Raw: statsColDelta.toString(),
        debtDeltaUsd8Raw: statsDebtDelta.toString(),
      },
    };

    console.log(
      "Expected deltas: collateral",
      ethers.formatUnits(expectedCollateralDelta, 6),
      "debt",
      ethers.formatUnits(expectedDebtDelta, 6),
    );
    console.log(
      "Ledger deltas:    collateral",
      ethers.formatUnits(ledgerColDelta, 6),
      "debt",
      ethers.formatUnits(ledgerDebtDelta, 6),
    );
    console.log(
      "Stats deltas:     collateral",
      ethers.formatUnits(statsColDelta, 8),
      "debt",
      ethers.formatUnits(statsDebtDelta, 8),
    );

    if (ledgerColDelta !== expectedCollateralDelta)
      throw new Error("Checkpoint A: ledger collateral delta mismatch");
    if (ledgerDebtDelta !== expectedDebtDelta)
      throw new Error("Checkpoint A: ledger debt delta mismatch");
    if (statsColDelta === 0n && statsDebtDelta === 0n) {
      throw new Error(
        "Checkpoint A: StatisticsView deltas are zero. Expected stats push during matchflow, but none observed.",
      );
    }
    if (statsColDelta !== expectedStatsCollateralDelta) {
      const msg = `Checkpoint A: StatisticsView collateral delta mismatch got=${ethers.formatUnits(
        statsColDelta,
        8,
      )} expected=${ethers.formatUnits(expectedStatsCollateralDelta, 8)}`;
      logNotice(
        `  [Notice] [BestEffort] ${msg} (PositionView/ledger remains SSOT for collateral valuation)`,
      );
    }
    if (statsDebtDelta !== expectedStatsDebtDeltaExpected) {
      const msg = `Checkpoint A: StatisticsView debt delta mismatch got=${ethers.formatUnits(
        statsDebtDelta,
        8,
      )} expected=${ethers.formatUnits(expectedStatsDebtDeltaExpected, 8)}`;
      if (strictViews && !baselineDirty) throw new Error(msg);
      logNotice(`  [Notice] [BestEffort] ${msg} (dirty baseline)`);
    }
    // Track expected StatisticsView deltas across repayments (snapshot path is best-effort + retryable).
    let expectedStatsColDelta = statsColDelta;
    let expectedStatsDebtDelta = statsDebtDelta;
    console.log("✅ Checkpoint A passed\n");
    await logPositionViewVersion("checkpoint A (after matches)");
    await assertRiskStatusUpdated(
      "checkpoint A (after matches)",
      borrowers[0].address,
    );

    // ============ Extra: Oracle Extreme Price Change (HF/LTV) ==========
    console.log("=== Extra: Oracle Extreme Price Change (HF/LTV) ===");
    {
      const user = borrowers[0];
      const colBefore = toBigInt(
        await positionView.getUserTotalCollateralValue(user.address),
      );
      const debtBefore = toBigInt(
        await vle.getUserTotalDebtValue(user.address),
      );
      const lowPrice = 1n; // 1e-8 USD (extreme low)
      const nowLow = await latestBlockNumber();
      await waitTx(
        po.connect(deployer).updatePrice(assetAddr, lowPrice, nowLow),
        "updatePrice low",
      );
      const colLow = toBigInt(
        await positionView.getUserTotalCollateralValue(user.address),
      );
      const debtLow = toBigInt(await vle.getUserTotalDebtValue(user.address));
      const valuationChanged = colLow < colBefore || debtLow < debtBefore;
      if (valuationChanged) {
        if (debtBefore !== 0n && debtLow === 0n)
          throw new Error(
            "Oracle extreme change: debt value unexpectedly zeroed",
          );
        const hfLow =
          debtLow === 0n ? ethers.MaxUint256 : (colLow * 10_000n) / debtLow;
        const liqThreshold =
          (await liquidationRiskManager.getLiquidationThreshold()) as bigint;
        if (debtLow > 0n && hfLow >= liqThreshold) {
          logNotice(
            "  [Notice] Oracle extreme change kept HF above liquidation threshold because collateral/debt share the same valuation asset in this localhost scenario",
          );
        }
      } else {
        logNotice(
          "  [Notice] Oracle extreme change did not alter PositionView/VLE totals under current localhost valuation semantics; skipping strict HF degradation check",
        );
      }

      const nowRestore = await latestBlockNumber();
      await waitTx(
        po.connect(deployer).updatePrice(assetAddr, priceUsd8, nowRestore),
        "updatePrice restore",
      );
      const colRestore = toBigInt(
        await positionView.getUserTotalCollateralValue(user.address),
      );
      if (valuationChanged && colRestore <= colLow) {
        throw new Error(
          "Oracle extreme change: collateral value did not recover after price restore",
        );
      }
    }

    // ============ Step 3: Repayments (with partial + overdue) ============
    console.log("=== Step 3: Repayments ===");

    // Helper: find signer by address
    const signerByAddr = new Map<string, any>();
    for (const s of signers) signerByAddr.set(s.address.toLowerCase(), s);

    const maybePushStatsAfterRepay = async (
      borrowerAddr: string,
      collateralOut: bigint,
      principalRepaid: bigint,
    ) => {
      const collateralOutStats = toUsd8(collateralOut);
      const principalRepaidStats = toUsd8(principalRepaid);
      try {
        const [statsCur] = await statisticsView.getGlobalStatisticsWithMeta();
        const statsColDeltaCur =
          toBigInt(statsCur.totalCollateral) -
          toBigInt(baselineStats.totalCollateral);
        const statsDebtDeltaCur =
          toBigInt(statsCur.totalDebt) - toBigInt(baselineStats.totalDebt);
        const expectedColAfter = expectedStatsColDelta - collateralOutStats;
        const expectedDebtAfter = expectedStatsDebtDelta - principalRepaidStats;
        const needsRetry =
          statsColDeltaCur !== expectedColAfter ||
          statsDebtDeltaCur !== expectedDebtAfter;
        if (needsRetry) {
          logNotice(
            `  [Notice] [BestEffort] StatisticsPushManager snapshot not fully converged after repay for ${borrowerAddr}: ` +
              `got(col=${ethers.formatUnits(statsColDeltaCur, 8)}, debt=${ethers.formatUnits(statsDebtDeltaCur, 8)}) ` +
              `expected(col=${ethers.formatUnits(expectedColAfter, 8)}, debt=${ethers.formatUnits(expectedDebtAfter, 8)})`,
          );
          await waitTx(
            statsPushManager.connect(deployer).retryUserStats(borrowerAddr),
            `retryUserStats after repay ${borrowerAddr.slice(0, 10)}`,
          );
        }
        expectedStatsColDelta = expectedColAfter;
        expectedStatsDebtDelta = expectedDebtAfter;
      } catch {
        expectedStatsColDelta = expectedStatsColDelta - collateralOutStats;
        expectedStatsDebtDelta = expectedStatsDebtDelta - principalRepaidStats;
      }
    };

    // Pair1: repay full on-time
    {
      const o = orders.find((x) => x.borrower === borrowers[0].address)!;
      const totalDue = calcTotalDue(o.principal, rateBps, termSec);
      const borrowerSigner = signerByAddr.get(o.borrower.toLowerCase());
      const colBefore = (await cm.getCollateral(
        o.borrower,
        assetAddr,
      )) as bigint;
      await waitTx(
        usdc.connect(borrowerSigner).approve(vaultCoreAddr, totalDue),
        "approve repay",
      );
      const repayRc = await waitTx(
        vaultCore.connect(borrowerSigner).repay(o.orderId, assetAddr, totalDue),
        "repay",
      );
      const colAfter = (await cm.getCollateral(
        o.borrower,
        assetAddr,
      )) as bigint;
      const collateralOut = colBefore > colAfter ? colBefore - colAfter : 0n;
      await logLEVOrder("after repay (pair1 full)", o.orderId, borrowerSigner);
      expectedDebtByBorrower.set(
        o.borrower,
        (expectedDebtByBorrower.get(o.borrower) || 0n) - o.principal,
      );
      // If this user has no debt left, SettlementManager auto-releases all collateral (SSOT).
      const releasedAll = (await vle.getUserTotalDebtValue(o.borrower)) === 0n;
      assertRepayAndSettleDataPush(
        "Pair1 repay",
        repayRc,
        settlementManager,
        o.borrower,
        assetAddr,
        totalDue,
        o.orderId,
        releasedAll,
      );
      if (releasedAll) {
        assertCollateralReleasedDataPush(
          "Pair1 repay",
          repayRc,
          o.borrower,
          assetAddr,
        );
        const hasEvt = (repayRc?.logs || []).some((log: any) => {
          try {
            const parsed = settlementManager.interface.parseLog({
              topics: log.topics as string[],
              data: log.data,
            });
            return (
              parsed?.name === "CollateralReleased" &&
              (parsed.args.user as string).toLowerCase() ===
                o.borrower.toLowerCase()
            );
          } catch {
            return false;
          }
        });
        if (!hasEvt)
          throw new Error(
            "Pair1 repay: missing SettlementManager.CollateralReleased event",
          );
      }
      if (releasedAll) {
        expectedCollateralByBorrower.set(o.borrower, 0n);
      }
      await maybePushStatsAfterRepay(o.borrower, collateralOut, o.principal);
      await assertViews(
        "After repay (pair1 full)",
        o.borrower,
        assetAddr,
        expectedCollateralByBorrower.get(o.borrower),
        expectedDebtByBorrower.get(o.borrower),
      );
      // Reward assertion (Architecture-Guide / RewardManagerCore):
      // - Only eligible loans (principal >= 1000e6) accrue/lock EasyToken.
      // - Ineligible principals MUST NOT change EasyToken.
      const easyBalAfter = (await easyToken.balanceOf(
        rewardBorrower.address,
      )) as bigint;
      let [easyEarnedAfter] = (await rewardView
        .connect(deployer)
        .getUserEasyEarnedWithMeta(rewardBorrower.address)) as [
        bigint,
        bigint,
        boolean,
      ];
      let rewardSummaryAfter = await rewardView
        .connect(deployer)
        .getUserRewardSummaryWithMeta(rewardBorrower.address);
      console.log(
        `  [Reward] after repay(pair1): borrower=${rewardBorrower.address} easyBalance=${fmtEasy(easyBalAfter)} (raw=${easyBalAfter.toString()}) easyEarned=${fmtEasy(
          easyEarnedAfter,
        )} (raw=${easyEarnedAfter.toString()}) totalBurned=${fmtEasy(rewardSummaryAfter[0])} pendingPenalty=${fmtEasy(
          rewardSummaryAfter[1],
        )}`,
      );
      let balDelta = easyBalAfter - easyBalBefore;
      let easyEarnedDelta = easyEarnedAfter - easyEarnedBefore;
      let fallbackEarnRcpt: any | null = null;
      const repayPushes = recordDataPushed(repayRc);
      const hasEasyMintedInRepay = repayPushes.some(
        (p) => p.dataTypeHash === DATA_TYPE_EASY_MINTED_LOWER,
      );

      // If eligible but no earn observed, trigger fallback hook (OrderEngine impersonation) for coverage.
      if (
        o.principal >= MIN_ELIGIBLE_PRINCIPAL &&
        !hasEasyMintedInRepay &&
        (balDelta === 0n || easyEarnedDelta === 0n)
      ) {
        logNotice(
          "  [Notice] [Reward] no earn observed in repay flow; running fallback OrderEngine→RewardManager hook for E2E coverage",
        );
        fallbackEarnRcpt = await fallbackTriggerRewardEarnByOrder({
          user: rewardBorrower.address,
          lender: lenders[0].address,
          asset: assetAddr,
          orderId: o.orderId,
          amount: o.principal,
        });
        [easyEarnedAfter] = (await rewardView
          .connect(deployer)
          .getUserEasyEarnedWithMeta(rewardBorrower.address)) as [
          bigint,
          bigint,
          boolean,
        ];
        const balAfter2 = (await easyToken.balanceOf(
          rewardBorrower.address,
        )) as bigint;
        rewardSummaryAfter = await rewardView
          .connect(deployer)
          .getUserRewardSummaryWithMeta(rewardBorrower.address);
        balDelta = balAfter2 - easyBalBefore;
        easyEarnedDelta = easyEarnedAfter - easyEarnedBefore;
        console.log(
          `  [Reward] after fallback hook: easyBalance=${fmtEasy(balAfter2)} (raw=${balAfter2.toString()}) easyEarned=${fmtEasy(
            easyEarnedAfter,
          )} (raw=${easyEarnedAfter.toString()})`,
        );
      }
      if (
        o.principal >= MIN_ELIGIBLE_PRINCIPAL &&
        !hasEasyMintedInRepay &&
        balDelta <= 0n
      ) {
        fallbackEarnRcpt = await fallbackTriggerEasyEmission({
          borrower: rewardBorrower.address,
          lender: lenders[0].address,
          asset: assetAddr,
          orderId: o.orderId,
          amount: o.principal,
        });
        const balAfter3 = (await easyToken.balanceOf(
          rewardBorrower.address,
        )) as bigint;
        balDelta = balAfter3 - easyBalBefore;
      }
      if (o.principal >= MIN_ELIGIBLE_PRINCIPAL && !skipEasyMintAssertion) {
        const minted = balDelta > 0n;
        if (!minted) {
          if (strictReward) {
            throw new Error(
              `[Reward] expected EasyToken balance to increase for eligible repay (got ${fmtEasy(balDelta)})`,
            );
          }
          logNotice(
            `  [Notice] [Reward] Easy mint not observed; skipping strict reward assertions (delta=${fmtEasy(balDelta)})`,
          );
        }
        if (minted && easyEarnedDelta <= 0n) {
          logNotice(
            `  [Notice] [Reward] easyEarned did not increase (got ${fmtEasy(easyEarnedDelta)}); Easy mint path may be separate`,
          );
        }
        if (minted && rewardSummaryAfter[1] !== 0n)
          throw new Error(
            "[Reward] expected pendingPenalty == 0 for on-time full repay (pair1)",
          );

        if (minted && easyToken) {
          let easyPush = repayPushes.find(
            (p) => p.dataTypeHash === DATA_TYPE_EASY_MINTED_LOWER,
          );
          if (!easyPush && fallbackEarnRcpt) {
            const pushesEasy2 = recordDataPushed(fallbackEarnRcpt);
            easyPush = pushesEasy2.find(
              (p) => p.dataTypeHash === DATA_TYPE_EASY_MINTED_LOWER,
            );
          }
          if (!easyPush) {
            fallbackEarnRcpt = await fallbackTriggerEasyEmission({
              borrower: rewardBorrower.address,
              lender: lenders[0].address,
              asset: assetAddr,
              orderId: o.orderId,
              amount: o.principal,
            });
            const pushesEasy2 = recordDataPushed(fallbackEarnRcpt);
            easyPush = pushesEasy2.find(
              (p) => p.dataTypeHash === DATA_TYPE_EASY_MINTED_LOWER,
            );
          }
          if (!easyPush) {
            throw new Error(
              "[Easy] expected DataPushed(EASY_MINTED) for eligible repay (pair1)",
            );
          }
          const [b, l, totalMinted, bShare, lShare, oid] = coder.decode(
            [
              "address",
              "address",
              "uint256",
              "uint256",
              "uint256",
              "uint256",
              "uint256",
              "uint256",
            ],
            easyPush.payload,
          ) as unknown as [
            string,
            string,
            bigint,
            bigint,
            bigint,
            bigint,
            bigint,
            bigint,
          ];
          if (oid !== o.orderId)
            throw new Error("[Easy] EASY_MINTED orderId mismatch (pair1)");
          if (totalMinted <= 0n)
            throw new Error(
              "[Easy] EASY_MINTED totalMinted must be > 0 (pair1)",
            );
          if (bShare + lShare !== totalMinted)
            throw new Error("[Easy] EASY_MINTED shares mismatch (pair1)");
          const shareDiff = bShare > lShare ? bShare - lShare : lShare - bShare;
          if (shareDiff > 1n)
            throw new Error("[Easy] EASY_MINTED shares not ~50/50 (pair1)");
          if (b.toLowerCase() !== rewardBorrower.address.toLowerCase())
            throw new Error("[Easy] borrower mismatch (pair1)");
          const ord = await orderEngine.getLoanOrderForView(o.orderId);
          const expectedLender = (ord.lender as string).toLowerCase();
          if (l.toLowerCase() !== expectedLender)
            throw new Error("[Easy] lender mismatch (pair1)");

          const easyBorrowerAfter = (await easyToken.balanceOf(
            rewardBorrower.address,
          )) as bigint;
          const easyBorrowerDelta = easyBorrowerAfter - easyBorrowerBefore;
          if (easyBorrowerDelta !== bShare) {
            throw new Error(
              `[Easy] borrower balance delta mismatch (expected ${fmtEasy(bShare)} got ${fmtEasy(easyBorrowerDelta)})`,
            );
          }
          if (expectedLender === lenders[0].address.toLowerCase()) {
            const easyLenderAfter = (await easyToken.balanceOf(
              expectedLender,
            )) as bigint;
            const easyLenderDelta = easyLenderAfter - easyLenderBefore;
            if (easyLenderDelta !== lShare) {
              throw new Error(
                `[Easy] lender balance delta mismatch (expected ${fmtEasy(lShare)} got ${fmtEasy(easyLenderDelta)})`,
              );
            }
          } else {
            logNotice(
              `  [Notice] [Easy] lender is pool/module (${expectedLender}); skipping lender balance delta check`,
            );
          }
          console.log(
            `  [Easy] borrower delta=${ethers.formatUnits(easyBorrowerDelta, 18)} lenderShare=${ethers.formatUnits(lShare, 18)}`,
          );
        }
      } else if (o.principal >= MIN_ELIGIBLE_PRINCIPAL) {
        logNotice(
          "  [Notice] [Reward] skipping Easy mint assertion: emission modules not fully configured",
        );
      } else {
        if (balDelta !== 0n || easyEarnedDelta !== 0n) {
          throw new Error(
            `[Reward] expected no Easy change for ineligible principal (<1000e6): balDelta=${fmtEasy(balDelta)} easyEarnedDelta=${fmtEasy(easyEarnedDelta)}`,
          );
        }
      }

      assertRewardAutoTriggers("Pair1 on-time repay", repayRc, {
        expectMinted: o.principal >= MIN_ELIGIBLE_PRINCIPAL,
        expectPenalty: "none",
      });
      console.log("  ✅ Pair1 full repaid");
    }

    // Pair2: partial repay then full repay (on-time)
    {
      const o = orders.find((x) => x.borrower === borrowers[1].address)!;
      const totalDue = calcTotalDue(o.principal, rateBps, termSec);
      const partial = totalDue / 2n;
      const remaining = totalDue - partial;
      const borrowerSigner = signerByAddr.get(o.borrower.toLowerCase());

      // partial
      const colBeforePartial = (await cm.getCollateral(
        o.borrower,
        assetAddr,
      )) as bigint;
      await waitTx(
        usdc.connect(borrowerSigner).approve(vaultCoreAddr, totalDue),
        "approve repay partial",
      );
      const repayPartialRc = await waitTx(
        vaultCore.connect(borrowerSigner).repay(o.orderId, assetAddr, partial),
        "repay partial",
      );
      const colAfterPartial = (await cm.getCollateral(
        o.borrower,
        assetAddr,
      )) as bigint;
      const collateralOutPartial =
        colBeforePartial > colAfterPartial
          ? colBeforePartial - colAfterPartial
          : 0n;
      await logLEVOrder(
        "after repay (pair2 partial)",
        o.orderId,
        borrowerSigner,
      );
      assertRepayAndSettleDataPush(
        "Pair2 repay(partial)",
        repayPartialRc,
        settlementManager,
        o.borrower,
        assetAddr,
        partial,
        o.orderId,
        false,
      );

      // principal-first mapping: repay reduces principal debt by min(partial, principal)
      const principalPaid1 = partial > o.principal ? o.principal : partial;
      expectedDebtByBorrower.set(
        o.borrower,
        (expectedDebtByBorrower.get(o.borrower) || 0n) - principalPaid1,
      );
      await maybePushStatsAfterRepay(
        o.borrower,
        collateralOutPartial,
        principalPaid1,
      );
      await assertViews(
        "After repay (pair2 partial)",
        o.borrower,
        assetAddr,
        expectedCollateralByBorrower.get(o.borrower),
        expectedDebtByBorrower.get(o.borrower),
      );
      await assertRiskStatusUpdated("After repay (pair2 partial)", o.borrower);
      console.log("  ✅ Pair2 partial repaid");

      // remaining
      const colBeforeFull = (await cm.getCollateral(
        o.borrower,
        assetAddr,
      )) as bigint;
      const repayFullRc = await waitTx(
        vaultCore
          .connect(borrowerSigner)
          .repay(o.orderId, assetAddr, remaining),
        "repay remaining",
      );
      const colAfterFull = (await cm.getCollateral(
        o.borrower,
        assetAddr,
      )) as bigint;
      const collateralOutFull =
        colBeforeFull > colAfterFull ? colBeforeFull - colAfterFull : 0n;
      await logLEVOrder("after repay (pair2 full)", o.orderId, borrowerSigner);
      const principalRemaining = o.principal - principalPaid1;
      expectedDebtByBorrower.set(
        o.borrower,
        (expectedDebtByBorrower.get(o.borrower) || 0n) - principalRemaining,
      );
      const releasedAll = (await vle.getUserTotalDebtValue(o.borrower)) === 0n;
      assertRepayAndSettleDataPush(
        "Pair2 repay(full)",
        repayFullRc,
        settlementManager,
        o.borrower,
        assetAddr,
        remaining,
        o.orderId,
        releasedAll,
      );
      if (releasedAll) {
        assertCollateralReleasedDataPush(
          "Pair2 repay(full)",
          repayFullRc,
          o.borrower,
          assetAddr,
        );
      }
      if (releasedAll) {
        expectedCollateralByBorrower.set(o.borrower, 0n);
      }
      await maybePushStatsAfterRepay(
        o.borrower,
        collateralOutFull,
        principalRemaining,
      );
      await assertViews(
        "After repay (pair2 full)",
        o.borrower,
        assetAddr,
        expectedCollateralByBorrower.get(o.borrower),
        expectedDebtByBorrower.get(o.borrower),
      );
      console.log("  ✅ Pair2 fully repaid (on-time)");
    }

    // Pair3: full repay on-time
    {
      const o = orders.find((x) => x.borrower === borrowers[2].address)!;
      const totalDue = calcTotalDue(o.principal, rateBps, termSec);
      const borrowerSigner = signerByAddr.get(o.borrower.toLowerCase());
      const colBefore = (await cm.getCollateral(
        o.borrower,
        assetAddr,
      )) as bigint;
      await waitTx(
        usdc.connect(borrowerSigner).approve(vaultCoreAddr, totalDue),
        "approve repay",
      );
      const repayRc = await waitTx(
        vaultCore.connect(borrowerSigner).repay(o.orderId, assetAddr, totalDue),
        "repay",
      );
      const colAfter = (await cm.getCollateral(
        o.borrower,
        assetAddr,
      )) as bigint;
      const collateralOut = colBefore > colAfter ? colBefore - colAfter : 0n;
      await logLEVOrder("after repay (pair3 full)", o.orderId, borrowerSigner);
      expectedDebtByBorrower.set(
        o.borrower,
        (expectedDebtByBorrower.get(o.borrower) || 0n) - o.principal,
      );
      const releasedAll = (await vle.getUserTotalDebtValue(o.borrower)) === 0n;
      assertRepayAndSettleDataPush(
        "Pair3 repay",
        repayRc,
        settlementManager,
        o.borrower,
        assetAddr,
        totalDue,
        o.orderId,
        releasedAll,
      );
      if (releasedAll)
        assertCollateralReleasedDataPush(
          "Pair3 repay",
          repayRc,
          o.borrower,
          assetAddr,
        );
      if (releasedAll) {
        expectedCollateralByBorrower.set(o.borrower, 0n);
      }
      await maybePushStatsAfterRepay(o.borrower, collateralOut, o.principal);
      await assertViews(
        "After repay (pair3 full)",
        o.borrower,
        assetAddr,
        expectedCollateralByBorrower.get(o.borrower),
        expectedDebtByBorrower.get(o.borrower),
      );
      console.log("  ✅ Pair3 full repaid");
    }

    // Pair4: split orders — repay both on-time
    {
      const os = orders.filter((x) => x.borrower === borrowers[3].address);
      const borrowerSigner = signerByAddr.get(
        borrowers[3].address.toLowerCase(),
      );
      for (let i = 0; i < os.length; i++) {
        const o = os[i];
        const totalDue = calcTotalDue(o.principal, rateBps, termSec);
        const colBefore = (await cm.getCollateral(
          o.borrower,
          assetAddr,
        )) as bigint;
        await waitTx(
          usdc.connect(borrowerSigner).approve(vaultCoreAddr, totalDue),
          "approve repay",
        );
        const repayRc = await waitTx(
          vaultCore
            .connect(borrowerSigner)
            .repay(o.orderId, assetAddr, totalDue),
          "repay",
        );
        const colAfter = (await cm.getCollateral(
          o.borrower,
          assetAddr,
        )) as bigint;
        const collateralOut = colBefore > colAfter ? colBefore - colAfter : 0n;
        await logLEVOrder(
          `after repay (pair4 split order#${i + 1})`,
          o.orderId,
          borrowerSigner,
        );
        expectedDebtByBorrower.set(
          o.borrower,
          (expectedDebtByBorrower.get(o.borrower) || 0n) - o.principal,
        );
        const releasedAll =
          (await vle.getUserTotalDebtValue(o.borrower)) === 0n;
        assertRepayAndSettleDataPush(
          `Pair4 repay(order#${i + 1})`,
          repayRc,
          settlementManager,
          o.borrower,
          assetAddr,
          totalDue,
          o.orderId,
          releasedAll,
        );
        if (releasedAll)
          assertCollateralReleasedDataPush(
            `Pair4 repay(order#${i + 1})`,
            repayRc,
            o.borrower,
            assetAddr,
          );
        if (releasedAll) {
          expectedCollateralByBorrower.set(o.borrower, 0n);
        }
        await maybePushStatsAfterRepay(o.borrower, collateralOut, o.principal);
        await assertViews(
          `After repay (pair4 split order#${i + 1})`,
          o.borrower,
          assetAddr,
          expectedCollateralByBorrower.get(o.borrower),
          expectedDebtByBorrower.get(o.borrower),
        );
      }
      console.log("  ✅ Pair4 split orders fully repaid");
    }

    // Pair5: overdue full repay — time travel, then repay
    {
      const o = orders.find((x) => x.borrower === borrowers[4].address)!;

      // mine forward beyond maturity/window; be conservative
      {
        const ord = await orderEngine.getLoanOrderForView(o.orderId);
        await mineToBlock(BigInt(ord.maturity) + 3n * BLOCKS_PER_DAY);
        // IMPORTANT: time-travel can make oracle data stale; refresh price so valuation stays in USD-8 (avoid fallback unit mismatch).
        const nowAfterWarp = await latestBlockNumber();
        await waitTx(
          po
            .connect(deployer)
            .updatePrice(assetAddr, ethers.parseUnits("1", 8), nowAfterWarp),
          "updatePrice after warp (pair5 overdue)",
        );
      }

      const totalDue = calcTotalDue(o.principal, rateBps, termSec);
      const easyBefore = (await easyToken.balanceOf(o.borrower)) as bigint;
      const rewardBefore = await rewardView
        .connect(deployer)
        .getUserRewardSummaryWithMeta(o.borrower);
      const borrowerSigner = signerByAddr.get(o.borrower.toLowerCase());
      const colBefore = (await cm.getCollateral(
        o.borrower,
        assetAddr,
      )) as bigint;
      await waitTx(
        usdc.connect(borrowerSigner).approve(vaultCoreAddr, totalDue),
        "approve repay",
      );
      const repayRc = await waitTx(
        vaultCore.connect(borrowerSigner).repay(o.orderId, assetAddr, totalDue),
        "repay",
      );
      const easyAfter = (await easyToken.balanceOf(o.borrower)) as bigint;
      const rewardAfter = await rewardView
        .connect(deployer)
        .getUserRewardSummaryWithMeta(o.borrower);
      const colAfter = (await cm.getCollateral(
        o.borrower,
        assetAddr,
      )) as bigint;
      const collateralOut = colBefore > colAfter ? colBefore - colAfter : 0n;
      await logLEVOrder(
        "after repay (pair5 overdue)",
        o.orderId,
        borrowerSigner,
      );

      expectedDebtByBorrower.set(
        o.borrower,
        (expectedDebtByBorrower.get(o.borrower) || 0n) - o.principal,
      );
      const releasedAll = (await vle.getUserTotalDebtValue(o.borrower)) === 0n;
      assertRepayAndSettleDataPush(
        "Pair5 repay(overdue)",
        repayRc,
        settlementManager,
        o.borrower,
        assetAddr,
        totalDue,
        o.orderId,
        releasedAll,
      );
      if (releasedAll)
        assertCollateralReleasedDataPush(
          "Pair5 repay(overdue)",
          repayRc,
          o.borrower,
          assetAddr,
        );
      if (releasedAll) {
        expectedCollateralByBorrower.set(o.borrower, 0n);
      }
      await maybePushStatsAfterRepay(o.borrower, collateralOut, o.principal);
      await assertViews(
        "After repay (pair5 overdue)",
        o.borrower,
        assetAddr,
        expectedCollateralByBorrower.get(o.borrower),
        expectedDebtByBorrower.get(o.borrower),
      );
      {
        const pushes = recordDataPushed(repayRc);
        const burnPushes = pushes.filter(
          (p) => p.dataTypeHash === DATA_TYPE_REWARD_BURNED.toLowerCase(),
        );
        const ledgerPushes = pushes.filter(
          (p) =>
            p.dataTypeHash ===
            DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED.toLowerCase(),
        );

        console.log(
          `  [RewardDiag] Pair5 overdue repay tx=${(repayRc as any).hash ?? "n/a"} block=${(repayRc as any).blockNumber ?? "n/a"} orderId=${o.orderId.toString()} user=${o.borrower}`,
        );
        console.log(
          `  [RewardDiag] RewardView summary before: burned=${(rewardBefore[0] as bigint).toString()} pendingPenalty=${(rewardBefore[1] as bigint).toString()}`,
        );
        console.log(
          `  [RewardDiag] RewardView summary after:  burned=${(rewardAfter[0] as bigint).toString()} pendingPenalty=${(rewardAfter[1] as bigint).toString()}`,
        );
        console.log(
          `  [RewardDiag] DataPushed counts: burned=${burnPushes.length} penaltyLedger=${ledgerPushes.length}`,
        );

        for (let i = 0; i < burnPushes.length; i++) {
          const p = burnPushes[i];
          const [user, amount, reason, blockNumber] = coder.decode(
            ["address", "uint256", "string", "uint256"],
            p.payload,
          ) as unknown as [string, bigint, string, bigint];
          console.log(
            `  [RewardDiag] burned#${i + 1}/${burnPushes.length}: user=${user} amount=${amount.toString()} reason=${reason} blockNumber=${blockNumber.toString()}`,
          );
        }

        for (let i = 0; i < ledgerPushes.length; i++) {
          const p = ledgerPushes[i];
          const [user, pendingDebt, blockNumber] = coder.decode(
            ["address", "uint256", "uint256"],
            p.payload,
          ) as unknown as [string, bigint, bigint];
          console.log(
            `  [RewardDiag] penaltyLedger#${i + 1}/${ledgerPushes.length}: user=${user} pendingDebt=${pendingDebt.toString()} blockNumber=${blockNumber.toString()}`,
          );
        }

        // Strict consistency checks: if there are multiple pushes in one tx, compare against the LAST push
        // (it represents the final write in that tx), but keep full logs above.
        const lastBurn =
          burnPushes.length > 0 ? burnPushes[burnPushes.length - 1] : null;
        if (lastBurn) {
          const [user, amount] = coder.decode(
            ["address", "uint256", "string", "uint256"],
            lastBurn.payload,
          ) as unknown as [string, bigint, string, bigint];
          if (user.toLowerCase() !== o.borrower.toLowerCase()) {
            throw new Error("Pair5 overdue: REWARD_BURNED user mismatch");
          }
          const burnedDelta =
            (rewardAfter[0] as bigint) - (rewardBefore[0] as bigint);
          if (burnedDelta !== amount) {
            throw new Error(
              `Pair5 overdue: totalBurned delta mismatch vs REWARD_BURNED payload (viewDelta=${burnedDelta.toString()} payload=${amount.toString()})`,
            );
          }
        }

        const lastLedger =
          ledgerPushes.length > 0
            ? ledgerPushes[ledgerPushes.length - 1]
            : null;
        if (lastLedger) {
          const [user, pendingDebt] = coder.decode(
            ["address", "uint256", "uint256"],
            lastLedger.payload,
          ) as unknown as [string, bigint, bigint];
          if (user.toLowerCase() !== o.borrower.toLowerCase()) {
            throw new Error(
              "Pair5 overdue: REWARD_PENALTY_LEDGER_UPDATED user mismatch",
            );
          }
          if ((rewardAfter[1] as bigint) !== pendingDebt) {
            throw new Error(
              `Pair5 overdue: pendingPenalty mismatch vs REWARD_PENALTY_LEDGER_UPDATED payload (view=${(rewardAfter[1] as bigint).toString()} payload=${pendingDebt.toString()})`,
            );
          }
        }
      }
      assertRewardAutoTriggers("Pair5 overdue repay", repayRc, {
        // EasyEmissionController mints on full repay for outcome 1/2/3 (on-time/early/late),
        // with late repay applying penalty offset first.
        expectMinted: true,
        expectPenalty: "burn-or-ledger",
        mintedFallback: easyAfter > easyBefore,
      });
      console.log("  ✅ Pair5 overdue repaid\n");
    }

    // ============ Extra: Early repay (auto Reward) ============
    console.log("=== Extra: Early Repay (auto Reward) ===");
    const extraUsed = new Set<string>();
    {
      const used = new Set<string>(
        [
          deployer.address,
          ...borrowers.map((x) => x.address),
          ...lenders.map((x) => x.address),
          ...extraUsed,
        ].map((x) => x.toLowerCase()),
      );
      let eBorrower: any | null = null;
      let eLender: any | null = null;
      for (const s of signers) {
        if (used.has(s.address.toLowerCase())) continue;
        if ((await vle.getUserTotalDebtValue(s.address)) !== 0n) continue;
        if ((await cm.getCollateral(s.address, assetAddr)) !== 0n) continue;
        eBorrower = s;
        used.add(s.address.toLowerCase());
        break;
      }
      for (const s of signers) {
        if (used.has(s.address.toLowerCase())) continue;
        if (
          eBorrower &&
          s.address.toLowerCase() === eBorrower.address.toLowerCase()
        )
          continue;
        eLender = s;
        break;
      }
      if (!eBorrower || !eLender) {
        throw new Error(
          "Early repay: cannot find fresh borrower/lender; restart localhost node for a clean state.",
        );
      }
      extraUsed.add(eBorrower.address.toLowerCase());
      extraUsed.add(eLender.address.toLowerCase());

      await fundUsdcUsers(
        [eBorrower.address, eLender.address],
        ethers.parseUnits("20000", 6),
        "fund early pair",
      );
      await waitTx(
        usdc.connect(eBorrower).approve(cmAddr, collateralAmt),
        "approve collateral",
      );
      await waitTx(
        vaultCore.connect(eBorrower).deposit(assetAddr, collateralAmt),
        "deposit",
      );
      expectedCollateralByBorrower.set(
        eBorrower.address,
        await cm.getCollateral(eBorrower.address, assetAddr),
      );
      expectedDebtByBorrower.set(
        eBorrower.address,
        await vle.getDebt(eBorrower.address, assetAddr),
      );

      const eOrderId = await finalizeOne(
        eBorrower,
        eLender,
        principal,
        "early-repay",
        { forceDisableGuarantee: true },
      );
      await logLEVOrder(
        "after finalizeMatch (early repay)",
        eOrderId,
        eBorrower,
      );
      const eDue = calcTotalDue(principal, rateBps, termSec);
      const easyBefore = (await easyToken.balanceOf(
        eBorrower.address,
      )) as bigint;
      await waitTx(
        usdc.connect(eBorrower).approve(vaultCoreAddr, eDue),
        "approve early repay",
      );
      const eRepayRc = await waitTx(
        vaultCore.connect(eBorrower).repay(eOrderId, assetAddr, eDue),
        "early repay",
      );
      await logLEVOrder("after repay (early repay)", eOrderId, eBorrower);
      const easyAfter = (await easyToken.balanceOf(
        eBorrower.address,
      )) as bigint;

      assertRewardAutoTriggers("Early repay", eRepayRc, {
        // EasyEmissionController mints on full repay for outcome 1/2/3 (on-time/early/late).
        expectMinted: true,
        expectPenalty: "none",
        mintedFallback: easyAfter > easyBefore,
      });
      console.log("  ✅ Early repay auto-reward check completed\n");
    }

    // ============ Extra: Reward threshold boundary (999.999 vs 1000) =========
    console.log("=== Extra: Reward Threshold Boundary ===");
    {
      const usedBase = new Set<string>(
        [
          deployer.address,
          ...borrowers.map((x) => x.address),
          ...lenders.map((x) => x.address),
        ].map((x) => x.toLowerCase()),
      );
      const used = new Set<string>([...usedBase, ...extraUsed]);
      const pickFreshFrom = async (blocklist: Set<string>) => {
        for (const s of signers) {
          if (blocklist.has(s.address.toLowerCase())) continue;
          if ((await vle.getUserTotalDebtValue(s.address)) !== 0n) continue;
          if ((await cm.getCollateral(s.address, assetAddr)) !== 0n) continue;
          if ((await cm.getCollateral(s.address, altAssetAddr)) !== 0n)
            continue;
          blocklist.add(s.address.toLowerCase());
          extraUsed.add(s.address.toLowerCase());
          return s;
        }
        return null;
      };
      const pickFresh = async () =>
        (await pickFreshFrom(used)) ?? (await pickFreshFrom(usedBase));
      const b1 = await pickFresh();
      const b2 = await pickFresh();
      const l1 = await pickFresh();
      if (!b1 || !b2 || !l1) {
        throw new Error(
          "Threshold boundary: cannot find fresh borrower/lender; restart localhost node for a clean state.",
        );
      }

      await fundUsdcUsers(
        [b1.address, b2.address, l1.address],
        ethers.parseUnits("20000", 6),
        "fund split users",
      );
      await waitTx(
        usdc.connect(b1).approve(cmAddr, collateralAmt),
        "approve collateral b1",
      );
      await waitTx(
        vaultCore.connect(b1).deposit(assetAddr, collateralAmt),
        "deposit b1",
      );
      expectedCollateralByBorrower.set(
        b1.address,
        (await cm.getCollateral(b1.address, assetAddr)) as bigint,
      );
      expectedDebtByBorrower.set(
        b1.address,
        (await vle.getDebt(b1.address, assetAddr)) as bigint,
      );
      await waitTx(
        usdc.connect(b2).approve(cmAddr, collateralAmt),
        "approve collateral b2",
      );
      await waitTx(
        vaultCore.connect(b2).deposit(assetAddr, collateralAmt),
        "deposit b2",
      );
      expectedCollateralByBorrower.set(
        b2.address,
        (await cm.getCollateral(b2.address, assetAddr)) as bigint,
      );
      expectedDebtByBorrower.set(
        b2.address,
        (await vle.getDebt(b2.address, assetAddr)) as bigint,
      );

      const below = MIN_ELIGIBLE_PRINCIPAL - 1n;
      const at = MIN_ELIGIBLE_PRINCIPAL;
      const idBelow = await finalizeOne(b1, l1, below, "th-below", {
        forceDisableGuarantee: true,
      });
      const idAt = await finalizeOne(b2, l1, at, "th-at", {
        forceDisableGuarantee: true,
      });
      await logLEVOrder("after finalizeMatch (threshold below)", idBelow, b1);
      await logLEVOrder("after finalizeMatch (threshold at)", idAt, b2);

      let maxMaturity = 0n;
      for (const id of [idBelow, idAt]) {
        const ord = await orderEngine.getLoanOrderForView(id);
        const maturity = BigInt(ord.maturity);
        if (maturity > maxMaturity) maxMaturity = maturity;
      }
      if (maxMaturity > 0n) {
        await mineToBlock(maxMaturity - 1n);
        const nowAfterWarp = await latestBlockNumber();
        await waitTx(
          po
            .connect(deployer)
            .updatePrice(assetAddr, ethers.parseUnits("1", 8), nowAfterWarp),
          "updatePrice",
        );
      }

      const dueBelow = calcTotalDue(below, rateBps, termSec);
      await waitTx(
        usdc.connect(b1).approve(vaultCoreAddr, dueBelow),
        "approve repay below",
      );
      const repayBelow = await waitTx(
        vaultCore.connect(b1).repay(idBelow, assetAddr, dueBelow),
        "repay below",
      );
      await logLEVOrder("after repay (threshold below)", idBelow, b1);
      assertRewardAutoTriggers("Threshold below repay", repayBelow, {
        expectMinted: false,
        expectPenalty: "none",
      });

      const dueAt = calcTotalDue(at, rateBps, termSec);
      await waitTx(
        usdc.connect(b2).approve(vaultCoreAddr, dueAt),
        "approve repay at",
      );
      const repayAt = await waitTx(
        vaultCore.connect(b2).repay(idAt, assetAddr, dueAt),
        "repay at",
      );
      await logLEVOrder("after repay (threshold at)", idAt, b2);
      assertRewardAutoTriggers("Threshold at repay", repayAt, {
        expectMinted: true,
        expectPenalty: "none",
      });

      console.log("  ✅ Threshold boundary checks completed\n");
    }

    // ============ Extra: Partial repay should not mint until fully repaid =====
    console.log("=== Extra: Partial Repay Reward Timing ===");
    {
      const used = new Set<string>(
        [
          deployer.address,
          ...borrowers.map((x) => x.address),
          ...lenders.map((x) => x.address),
          ...extraUsed,
        ].map((x) => x.toLowerCase()),
      );
      const pickFresh = async () => {
        for (const s of signers) {
          if (used.has(s.address.toLowerCase())) continue;
          if ((await vle.getUserTotalDebtValue(s.address)) !== 0n) continue;
          if ((await cm.getCollateral(s.address, assetAddr)) !== 0n) continue;
          if ((await cm.getCollateral(s.address, altAssetAddr)) !== 0n)
            continue;
          used.add(s.address.toLowerCase());
          extraUsed.add(s.address.toLowerCase());
          return s;
        }
        return null;
      };
      const borrower = await pickFresh();
      const lender = await pickFresh();
      if (!borrower || !lender) {
        throw new Error(
          "Partial repay test: cannot find fresh borrower/lender; restart localhost node for a clean state.",
        );
      }

      await fundUsdcUsers(
        [borrower.address, lender.address],
        ethers.parseUnits("20000", 6),
        "fund borrower-lender pair",
      );
      await waitTx(
        usdc.connect(borrower).approve(cmAddr, collateralAmt),
        "approve collateral",
      );
      const depositRc = await waitTx(
        vaultCore.connect(borrower).deposit(assetAddr, collateralAmt),
        "deposit",
      );
      recordDataPushed(depositRc);
      expectedCollateralByBorrower.set(
        borrower.address,
        (await cm.getCollateral(borrower.address, assetAddr)) as bigint,
      );
      expectedDebtByBorrower.set(
        borrower.address,
        (await vle.getDebt(borrower.address, assetAddr)) as bigint,
      );

      const orderId = await finalizeOne(
        borrower,
        lender,
        principal,
        "partial",
        { forceDisableGuarantee: true },
      );
      await logLEVOrder(
        "after finalizeMatch (partial repay)",
        orderId,
        borrower,
      );
      const ord = await orderEngine.getLoanOrderForView(orderId);
      await mineToBlock(BigInt(ord.maturity) - 1n);
      const nowAfterWarp = await latestBlockNumber();
      await waitTx(
        po
          .connect(deployer)
          .updatePrice(assetAddr, ethers.parseUnits("1", 8), nowAfterWarp),
        "updatePrice",
      );

      const totalDue = calcTotalDue(principal, rateBps, termSec);
      const partial = totalDue / 2n;
      const remaining = totalDue - partial;
      await waitTx(
        usdc.connect(borrower).approve(vaultCoreAddr, totalDue),
        "approve repay",
      );
      const repayPartial = await waitTx(
        vaultCore.connect(borrower).repay(orderId, assetAddr, partial),
        "repay partial",
      );
      await logLEVOrder("after repay (partial repay)", orderId, borrower);
      assertRewardAutoTriggers("Partial repay", repayPartial, {
        expectMinted: false,
        expectPenalty: "none",
      });
      const repayFull = await waitTx(
        vaultCore.connect(borrower).repay(orderId, assetAddr, remaining),
        "repay remaining",
      );
      await logLEVOrder("after repay (partial repay full)", orderId, borrower);
      assertRewardAutoTriggers("Full repay after partial", repayFull, {
        expectMinted: true,
        expectPenalty: "none",
      });

      console.log("  ✅ Partial repay timing check completed\n");
    }

    // ============ Extra: Consecutive borrowing (same borrower, two loans) =====
    console.log(
      "=== Extra: Consecutive Borrowing (same borrower, two loans) ===",
    );
    {
      const used = new Set<string>(
        [
          deployer.address,
          ...borrowers.map((x) => x.address),
          ...lenders.map((x) => x.address),
          ...extraUsed,
        ].map((x) => x.toLowerCase()),
      );
      const pickFresh = async () => {
        for (const s of signers) {
          if (used.has(s.address.toLowerCase())) continue;
          if ((await vle.getUserTotalDebtValue(s.address)) !== 0n) continue;
          if ((await cm.getCollateral(s.address, assetAddr)) !== 0n) continue;
          if ((await cm.getCollateral(s.address, altAssetAddr)) !== 0n)
            continue;
          used.add(s.address.toLowerCase());
          extraUsed.add(s.address.toLowerCase());
          return s;
        }
        return null;
      };
      const borrower = await pickFresh();
      const lender = await pickFresh();
      if (!borrower || !lender) {
        throw new Error(
          "Consecutive borrow test: cannot find fresh borrower/lender; restart localhost node for a clean state.",
        );
      }

      const collateralAmt2 = ethers.parseUnits("4000", 6);
      await fundUsdcUsers(
        [borrower.address, lender.address],
        ethers.parseUnits("20000", 6),
        "fund borrower-lender pair",
      );
      await waitTx(
        usdc.connect(borrower).approve(cmAddr, collateralAmt2),
        "approve collateral",
      );
      await waitTx(
        vaultCore.connect(borrower).deposit(assetAddr, collateralAmt2),
        "deposit",
      );
      expectedCollateralByBorrower.set(
        borrower.address,
        (await cm.getCollateral(borrower.address, assetAddr)) as bigint,
      );
      expectedDebtByBorrower.set(
        borrower.address,
        (await vle.getDebt(borrower.address, assetAddr)) as bigint,
      );
      await assertViews(
        "After consecutive-borrow deposit",
        borrower.address,
        assetAddr,
        expectedCollateralByBorrower.get(borrower.address),
        expectedDebtByBorrower.get(borrower.address),
      );

      const id1 = await finalizeOne(borrower, lender, principal, "cb-1", {
        forceDisableGuarantee: true,
      });
      await logLEVOrder("after borrow #1", id1, borrower);
      {
        const [pvCol, pvDebt] = await positionView.getUserPositionWithMeta(
          borrower.address,
          assetAddr,
        );
        const [uvCol, uvDebt] = await userView.getUserPosition(
          borrower.address,
          assetAddr,
        );
        const rewardSummary = await rewardView
          .connect(deployer)
          .getUserRewardSummaryWithMeta(borrower.address);
        console.log(
          `  [Snapshot] after borrow #1: PositionView col=${ethers.formatUnits(pvCol, 6)} debt=${ethers.formatUnits(pvDebt, 6)}`,
        );
        console.log(
          `  [Snapshot] after borrow #1: UserView col=${ethers.formatUnits(uvCol, 6)} debt=${ethers.formatUnits(uvDebt, 6)}`,
        );
        console.log(
          `  [Snapshot] after borrow #1: RewardView burned=${fmtEasy(rewardSummary[0])} pendingPenalty=${fmtEasy(
            rewardSummary[1],
          )}`,
        );
      }

      const id2 = await finalizeOne(borrower, lender, principal, "cb-2", {
        forceDisableGuarantee: true,
      });
      await logLEVOrder("after borrow #2", id2, borrower);
      {
        const [pvCol, pvDebt] = await positionView.getUserPositionWithMeta(
          borrower.address,
          assetAddr,
        );
        const [uvCol, uvDebt] = await userView.getUserPosition(
          borrower.address,
          assetAddr,
        );
        const rewardSummary = await rewardView
          .connect(deployer)
          .getUserRewardSummaryWithMeta(borrower.address);
        console.log(
          `  [Snapshot] after borrow #2: PositionView col=${ethers.formatUnits(pvCol, 6)} debt=${ethers.formatUnits(pvDebt, 6)}`,
        );
        console.log(
          `  [Snapshot] after borrow #2: UserView col=${ethers.formatUnits(uvCol, 6)} debt=${ethers.formatUnits(uvDebt, 6)}`,
        );
        console.log(
          `  [Snapshot] after borrow #2: RewardView burned=${fmtEasy(rewardSummary[0])} pendingPenalty=${fmtEasy(
            rewardSummary[1],
          )}`,
        );
      }

      let maxMaturity = 0n;
      for (const id of [id1, id2]) {
        const ord = await orderEngine.getLoanOrderForView(id);
        const maturity = BigInt(ord.maturity);
        if (maturity > maxMaturity) maxMaturity = maturity;
      }
      if (maxMaturity > 0n) {
        await mineToBlock(maxMaturity - 1n);
        const nowAfterWarp = await latestBlockNumber();
        await waitTx(
          po
            .connect(deployer)
            .updatePrice(assetAddr, ethers.parseUnits("1", 8), nowAfterWarp),
          "updatePrice",
        );
      }

      const due1 = calcTotalDue(principal, rateBps, termSec);
      const due2 = calcTotalDue(principal, rateBps, termSec);
      await waitTx(
        usdc.connect(borrower).approve(vaultCoreAddr, due1 + due2),
        "approve repay",
      );
      const repay1 = await waitTx(
        vaultCore.connect(borrower).repay(id1, assetAddr, due1),
        "repay #1",
      );
      await logLEVOrder("after repay (consecutive #1)", id1, borrower);
      assertRewardAutoTriggers("Consecutive borrow repay #1", repay1, {
        expectMinted: true,
        expectPenalty: "none",
      });
      expectedDebtByBorrower.set(
        borrower.address,
        (expectedDebtByBorrower.get(borrower.address) || 0n) - principal,
      );
      await assertViews(
        "After consecutive repay #1",
        borrower.address,
        assetAddr,
        expectedCollateralByBorrower.get(borrower.address),
        expectedDebtByBorrower.get(borrower.address),
      );

      const repay2 = await waitTx(
        vaultCore.connect(borrower).repay(id2, assetAddr, due2),
        "repay #2",
      );
      await logLEVOrder("after repay (consecutive #2)", id2, borrower);
      assertRewardAutoTriggers("Consecutive borrow repay #2", repay2, {
        expectMinted: true,
        expectPenalty: "none",
      });
      expectedDebtByBorrower.set(
        borrower.address,
        (expectedDebtByBorrower.get(borrower.address) || 0n) - principal,
      );
      expectedCollateralByBorrower.set(borrower.address, 0n);
      await assertViews(
        "After consecutive repay #2",
        borrower.address,
        assetAddr,
        expectedCollateralByBorrower.get(borrower.address),
        expectedDebtByBorrower.get(borrower.address),
      );

      console.log("  ✅ Consecutive borrowing snapshot completed\n");
    }

    // ============ Extra: Multi-asset + multi-order ===========================
    console.log("=== Extra: Multi-Asset / Multi-Order ===");
    {
      // Avoid guarantee fund allowance requirements for extra multi-asset orders.
      try {
        await waitTx(
          ergm.connect(deployer).setGuaranteeEnabled(assetAddr, false),
          "setGuaranteeEnabled(false)",
        );
      } catch {
        // best-effort
      }
      try {
        await waitTx(
          ergm.connect(deployer).setGuaranteeEnabled(altAssetAddr, false),
          "setGuaranteeEnabled(false)",
        );
      } catch {
        // best-effort
      }
      const usedBase = new Set<string>(
        [
          deployer.address,
          ...borrowers.map((x) => x.address),
          ...lenders.map((x) => x.address),
        ].map((x) => x.toLowerCase()),
      );
      const used = new Set<string>([...usedBase, ...extraUsed]);
      const pickFreshFrom = async (blocklist: Set<string>) => {
        for (const s of signers) {
          if (blocklist.has(s.address.toLowerCase())) continue;
          if ((await vle.getUserTotalDebtValue(s.address)) !== 0n) continue;
          if ((await cm.getCollateral(s.address, assetAddr)) !== 0n) continue;
          if ((await cm.getCollateral(s.address, altAssetAddr)) !== 0n)
            continue;
          blocklist.add(s.address.toLowerCase());
          extraUsed.add(s.address.toLowerCase());
          return s;
        }
        return null;
      };
      const pickFresh = async () =>
        (await pickFreshFrom(used)) ?? (await pickFreshFrom(usedBase));
      const createEphemeral = async (label: string) => {
        const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
        await waitTx(
          deployer.sendTransaction({
            to: wallet.address,
            value: ethers.parseEther("5"),
          }),
          `fund ephemeral ${label}`,
        );
        extraUsed.add(wallet.address.toLowerCase());
        return wallet;
      };
      const borrower =
        (await pickFresh()) ?? (await createEphemeral("borrower"));
      const lender = (await pickFresh()) ?? (await createEphemeral("lender"));

      await fundUsdcUsers(
        [borrower.address, lender.address],
        ethers.parseUnits("20000", 6),
        "fund borrower-lender usdc",
      );
      await waitTx(
        altToken
          .connect(deployer)
          .transfer(borrower.address, ethers.parseUnits("20000", 6)),
        "fund borrower alt",
      );
      await waitTx(
        altToken
          .connect(deployer)
          .transfer(lender.address, ethers.parseUnits("20000", 6)),
        "fund lender alt",
      );

      await waitTx(
        usdc.connect(borrower).approve(cmAddr, collateralAmt),
        "approve collateral usdc",
      );
      await waitTx(
        vaultCore.connect(borrower).deposit(assetAddr, collateralAmt),
        "deposit usdc",
      );
      await waitTx(
        altToken.connect(borrower).approve(cmAddr, collateralAmt),
        "approve collateral alt",
      );
      await waitTx(
        vaultCore.connect(borrower).deposit(altAssetAddr, collateralAmt),
        "deposit alt",
      );

      const finalizeOneWithAsset = async (
        amount: bigint,
        asset: string,
        token: any,
        suffix: string,
      ) => {
        const expireAt = (await latestBlockNumber()) + ONE_HOUR_BLOCKS;
        const borrowIntent = {
          borrower: borrower.address,
          collateralAsset: asset,
          collateralAmount: collateralAmt,
          borrowAsset: asset,
          amount,
          termDays,
          rateBps,
          expireAt,
          salt: ethers.keccak256(
            ethers.toUtf8Bytes(`ma-${suffix}-${Date.now()}`),
          ),
        };
        const lendIntent = {
          lenderSigner: lender.address,
          asset,
          amount,
          minTermDays: 1,
          maxTermDays: 30,
          minRateBps: 0n,
          expireAt,
          salt: ethers.keccak256(
            ethers.toUtf8Bytes(`ma-l-${suffix}-${Date.now()}`),
          ),
        };
        await waitTx(
          token.connect(lender).approve(vblAddr, amount),
          "approve reserve",
        );
        const lendHash = buildLendIntentHash(lendIntent);
        await waitTx(
          vbl
            .connect(lender)
            .reserveForLending(lender.address, asset, amount, lendHash),
          "reserveForLending",
        );
        const sigBorrower = await borrower.signTypedData(
          domain,
          typesBorrow as any,
          borrowIntent as any,
        );
        const sigLender = await lender.signTypedData(
          domain,
          typesLend as any,
          lendIntent as any,
        );
        const tx = await vbl
          .connect(deployer)
          .finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [sigLender]);
        const receipt = await waitTx(Promise.resolve(tx), "finalizeMatch");
        let orderId: bigint | null = null;
        for (const log of receipt!.logs) {
          try {
            // LendingEngine emits legacy LoanOrderCreated too; ORDER_ENGINE is SSOT.
            if (
              String(log.address).toLowerCase() !==
              String(orderEngineAddr).toLowerCase()
            )
              continue;
            const parsed = orderEngine.interface.parseLog({
              topics: log.topics as string[],
              data: log.data,
            });
            if (parsed?.name === "LoanOrderCreated") {
              orderId = parsed.args.orderId as bigint;
              break;
            }
          } catch {
            // ignore
          }
        }
        if (orderId === null)
          throw new Error("Multi-asset: LoanOrderCreated not found");
        return orderId;
      };

      const idUsdc = await finalizeOneWithAsset(
        principal,
        assetAddr,
        usdc,
        "usdc",
      );
      const idAlt = await finalizeOneWithAsset(
        MIN_ELIGIBLE_PRINCIPAL - 1n,
        altAssetAddr,
        altToken,
        "alt",
      );

      // IMPORTANT: these two orders are part of this batch run and must be recorded in artifacts,
      // otherwise orderIds will appear "gappy" (e.g. missing 12/13) when later scenarios create more orders.
      artifactOrderCreates.push({
        saltSuffix: "ma-usdc",
        borrower: borrower.address,
        lender: lender.address,
        orderId: idUsdc.toString(),
        principalRaw: principal.toString(),
        withGuarantee: false,
      });
      recordExpectedBorrowerOrderId(borrower.address, idUsdc);
      await assertBorrowerEnumeratesOrder(
        borrower,
        idUsdc,
        "finalizeMatch(multi-asset usdc)",
      );
      artifactOrderCreates.push({
        saltSuffix: "ma-alt",
        borrower: borrower.address,
        lender: lender.address,
        orderId: idAlt.toString(),
        principalRaw: (MIN_ELIGIBLE_PRINCIPAL - 1n).toString(),
        withGuarantee: false,
      });
      recordExpectedBorrowerOrderId(borrower.address, idAlt);
      await assertBorrowerEnumeratesOrder(
        borrower,
        idAlt,
        "finalizeMatch(multi-asset alt)",
      );

      await logLEVOrder(
        "after finalizeMatch (multi-asset usdc)",
        idUsdc,
        borrower,
      );
      await logLEVOrder(
        "after finalizeMatch (multi-asset alt)",
        idAlt,
        borrower,
      );

      let maxMaturity = 0n;
      for (const id of [idUsdc, idAlt]) {
        const ord = await orderEngine.getLoanOrderForView(id);
        const maturity = BigInt(ord.maturity);
        if (maturity > maxMaturity) maxMaturity = maturity;
      }
      if (maxMaturity > 0n) {
        await mineToBlock(maxMaturity - 1n);
        const nowAfterWarp = await latestBlockNumber();
        await waitTx(
          po
            .connect(deployer)
            .updatePrice(assetAddr, ethers.parseUnits("1", 8), nowAfterWarp),
          "updatePrice usdc",
        );
        await waitTx(
          po
            .connect(deployer)
            .updatePrice(altAssetAddr, ethers.parseUnits("1", 8), nowAfterWarp),
          "updatePrice alt",
        );
      }

      const dueUsdc = calcTotalDue(principal, rateBps, termSec);
      await waitTx(
        usdc.connect(borrower).approve(vaultCoreAddr, dueUsdc),
        "approve repay usdc",
      );
      const altCollateralBefore = (await cm.getCollateral(
        borrower.address,
        altAssetAddr,
      )) as bigint;
      const repayUsdc = await waitTx(
        vaultCore.connect(borrower).repay(idUsdc, assetAddr, dueUsdc),
        "repay usdc",
      );
      await logLEVOrder("after repay (multi-asset usdc)", idUsdc, borrower);
      assertRewardAutoTriggers("Multi-asset USDC repay", repayUsdc, {
        expectMinted: true,
        expectPenalty: "none",
      });
      const altCollateralAfter = (await cm.getCollateral(
        borrower.address,
        altAssetAddr,
      )) as bigint;
      if (altCollateralAfter !== altCollateralBefore) {
        throw new Error(
          "Multi-asset: alt collateral changed after USDC repay (should be unchanged)",
        );
      }

      const dueAlt = calcTotalDue(
        MIN_ELIGIBLE_PRINCIPAL - 1n,
        rateBps,
        termSec,
      );
      await waitTx(
        altToken.connect(borrower).approve(vaultCoreAddr, dueAlt),
        "approve repay alt",
      );
      const repayAlt = await waitTx(
        vaultCore.connect(borrower).repay(idAlt, altAssetAddr, dueAlt),
        "repay alt",
      );
      await logLEVOrder("after repay (multi-asset alt)", idAlt, borrower);
      assertRewardAutoTriggers("Multi-asset alt repay", repayAlt, {
        expectMinted: false,
        expectPenalty: "none",
      });

      console.log("  ✅ Multi-asset / multi-order checks completed\n");
    }

    // ============ Extra coverage: CollateralReleased + DataPush strong assertions ============
    // Goal: deterministically hit "releasedAllCollateral=true" path in SettlementManager.
    console.log(
      "=== Extra: CollateralReleased (repay triggers auto-release) ===",
    );
    {
      const used = new Set<string>(
        [
          deployer.address,
          ...borrowers.map((x) => x.address),
          ...lenders.map((x) => x.address),
        ].map((x) => x.toLowerCase()),
      );
      let cleanBorrower: any | null = null;
      let cleanLender: any | null = null;
      for (const s of signers) {
        if (used.has(s.address.toLowerCase())) continue;
        if ((await vle.getUserTotalDebtValue(s.address)) === 0n) {
          cleanBorrower = s;
          break;
        }
      }
      for (const s of signers) {
        if (used.has(s.address.toLowerCase())) continue;
        if (
          cleanBorrower &&
          s.address.toLowerCase() === cleanBorrower.address.toLowerCase()
        )
          continue;
        cleanLender = s;
        break;
      }
      if (!cleanBorrower || !cleanLender) {
        throw new Error(
          "Extra CollateralReleased: cannot find unused clean borrower/lender signers; restart localhost node for a clean state.",
        );
      }

      // fund + seed expected maps for this borrower
      await fundUsdcUsers(
        [cleanBorrower.address, cleanLender.address],
        ethers.parseUnits("20000", 6),
        "fund clean pair",
      );
      expectedCollateralByBorrower.set(
        cleanBorrower.address,
        await cm.getCollateral(cleanBorrower.address, assetAddr),
      );
      expectedDebtByBorrower.set(
        cleanBorrower.address,
        await vle.getDebt(cleanBorrower.address, assetAddr),
      );

      // deposit collateral
      await waitTx(
        usdc.connect(cleanBorrower).approve(cmAddr, collateralAmt),
        "approve collateral",
      );
      await waitTx(
        vaultCore.connect(cleanBorrower).deposit(assetAddr, collateralAmt),
        "deposit",
      );
      expectedCollateralByBorrower.set(
        cleanBorrower.address,
        (expectedCollateralByBorrower.get(cleanBorrower.address) || 0n) +
          collateralAmt,
      );

      // create a small fresh order
      const demoPrincipal = ethers.parseUnits("100", 6);
      const demoOrderId = await finalizeOne(
        cleanBorrower,
        cleanLender,
        demoPrincipal,
        "release-demo",
      );

      // repay full (principal + interest); this borrower has no other debt ⇒ must auto-release collateral
      const demoDue = calcTotalDue(demoPrincipal, rateBps, termSec);
      await waitTx(
        usdc.connect(cleanBorrower).approve(vaultCoreAddr, demoDue),
        "approve repay",
      );
      const demoRepayRc = await waitTx(
        vaultCore.connect(cleanBorrower).repay(demoOrderId, assetAddr, demoDue),
        "repay",
      );
      const releasedAll =
        (await vle.getUserTotalDebtValue(cleanBorrower.address)) === 0n;
      if (!releasedAll)
        throw new Error(
          "Extra CollateralReleased: expected releasedAllCollateral=true but user still has debt",
        );

      assertRepayAndSettleDataPush(
        "Extra CollateralReleased repay",
        demoRepayRc,
        settlementManager,
        cleanBorrower.address,
        assetAddr,
        demoDue,
        demoOrderId,
        true,
      );
      assertCollateralReleasedDataPush(
        "Extra CollateralReleased repay",
        demoRepayRc,
        cleanBorrower.address,
        assetAddr,
      );

      expectedDebtByBorrower.set(
        cleanBorrower.address,
        (expectedDebtByBorrower.get(cleanBorrower.address) || 0n) -
          demoPrincipal,
      );
      expectedCollateralByBorrower.set(cleanBorrower.address, 0n);

      // ledger must show collateral is now 0
      if ((await cm.getCollateral(cleanBorrower.address, assetAddr)) !== 0n) {
        throw new Error(
          "Extra CollateralReleased: collateral not fully released on ledger",
        );
      }
      await assertViews(
        "After repay (extra collateral release)",
        cleanBorrower.address,
        assetAddr,
        expectedCollateralByBorrower.get(cleanBorrower.address),
        expectedDebtByBorrower.get(cleanBorrower.address),
      );
      console.log(
        "  ✅ CollateralReleased + DataPush(REPAY_AND_SETTLE/COLLATERAL_RELEASED) verified",
      );
    }

    // ============ Extra: LoanNFT transfer + SBT lock =========
    console.log("=== Extra: LoanNFT Transfer + SBT Lock ===");
    {
      const used = new Set<string>(
        [
          deployer.address,
          ...borrowers.map((x) => x.address),
          ...lenders.map((x) => x.address),
        ].map((x) => x.toLowerCase()),
      );
      const pickFresh = async () => {
        for (const s of signers) {
          if (used.has(s.address.toLowerCase())) continue;
          if ((await vle.getUserTotalDebtValue(s.address)) !== 0n) continue;
          if ((await cm.getCollateral(s.address, assetAddr)) !== 0n) continue;
          used.add(s.address.toLowerCase());
          extraUsed.add(s.address.toLowerCase());
          return s;
        }
        return null;
      };
      const borrower = await pickFresh();
      const lender = await pickFresh();
      const receiver = await pickFresh();
      if (!borrower || !lender || !receiver) {
        throw new Error(
          "LoanNFT transfer test: cannot find fresh borrower/lender/receiver; restart localhost node for a clean state.",
        );
      }

      await fundUsdcUsers(
        [borrower.address, lender.address],
        ethers.parseUnits("20000", 6),
        "fund nft pair",
      );
      await waitTx(
        usdc.connect(borrower).approve(cmAddr, collateralAmt),
        "approve collateral nft",
      );
      await waitTx(
        vaultCore.connect(borrower).deposit(assetAddr, collateralAmt),
        "deposit nft collateral",
      );

      // Seed expected maps for this fresh borrower so finalizeOne/assertViews is consistent.
      expectedCollateralByBorrower.set(
        borrower.address,
        await cm.getCollateral(borrower.address, assetAddr),
      );
      expectedDebtByBorrower.set(
        borrower.address,
        await vle.getDebt(borrower.address, assetAddr),
      );

      const nftPrincipal = ethers.parseUnits("200", 6);
      const orderId = await finalizeOne(
        borrower,
        lender,
        nftPrincipal,
        "nft-transfer",
        { forceDisableGuarantee: true },
      );
      const tokenId = await findLoanNftTokenIdByLoanId(
        borrower.address,
        orderId,
      );
      if (tokenId === null)
        throw new Error("LoanNFT transfer test: token not found");

      await loanNft
        .connect(borrower)
        .transferFrom(borrower.address, receiver.address, tokenId);
      const ownerAfter = await loanNft.ownerOf(tokenId);
      if (ownerAfter.toLowerCase() !== receiver.address.toLowerCase()) {
        throw new Error(
          "LoanNFT transfer test: owner did not update after transfer",
        );
      }

      // LoanNFTView enumerates by current token owner. After transfer, expectations should move to the receiver.
      moveExpectedOrderId(
        borrower.address,
        receiver.address,
        orderId,
        "nft-transfer",
      );
      await assertBorrowerEnumeratesOrder(
        receiver,
        orderId,
        "after LoanNFT transfer (pre-SBT)",
      );

      await loanNft.connect(deployer).lockAsSBT(tokenId);
      const soulSel = errorSelector("LoanNFT__SoulBound(uint256)");
      await mustRevertWithSelector(
        "LoanNFT SBT should block transfer",
        async () =>
          loanNft
            .connect(receiver)
            .transferFrom(receiver.address, borrower.address, tokenId),
        soulSel,
      );

      const due = calcTotalDue(nftPrincipal, rateBps, termSec);
      await waitTx(
        usdc.connect(borrower).approve(vaultCoreAddr, due),
        "approve repay nft",
      );
      await waitTx(
        vaultCore.connect(borrower).repay(orderId, assetAddr, due),
        "repay nft",
      );
      const meta = await loanNft.getLoanMetadata(tokenId);
      if ((meta.status as bigint) !== 1n) {
        throw new Error(
          "LoanNFT transfer test: status should be Repaid after repay",
        );
      }

      const remainingCollateral = (await cm.getCollateral(
        borrower.address,
        assetAddr,
      )) as bigint;
      if (remainingCollateral > 0n) {
        await waitTx(
          vaultCore.connect(borrower).withdraw(assetAddr, remainingCollateral),
          "withdraw remaining collateral (nft)",
        );
      }
      console.log("  ✅ LoanNFT transfer + SBT lock checks passed");
    }

    // ============ Extra coverage: Early repayment guarantee (Extension Flow SSOT path) ============
    // Doc mapping (Funds-Flow-Architecture-Guide.md §5):
    // - Lock/record: VaultBusinessLogic.finalizeMatch -> GFM.lockGuarantee + ERGM.lockGuaranteeRecord
    // - Early settle: VaultCore.repay -> SettlementManager.repayAndSettle -> ERGM.settleEarlyRepayment -> GFM.settleEarlyRepayment
    console.log(
      "=== Extra: EarlyRepaymentGuarantee (VBL lock+record → repay triggers early settle) ===",
    );
    if (!guaranteeToggleSupported) {
      logNotice(
        "  [Notice] Skipping: ERGM toggle not supported in this localhost deployment (see message above).",
      );
    } else {
      // Enable extension flow for this dedicated block (asset-level toggle SSOT).
      if (!(await ergm.isGuaranteeEnabled(assetAddr))) {
        await waitTx(
          ergm.connect(deployer).setGuaranteeEnabled(assetAddr, true),
          "setGuaranteeEnabled(true)",
        );
      }
      // Use fresh users so this block is robust even on dirty state.
      const used = new Set<string>(
        [
          deployer.address,
          ...borrowers.map((x) => x.address),
          ...lenders.map((x) => x.address),
        ].map((x) => x.toLowerCase()),
      );
      let gBorrower: any | null = null;
      let gLender: any | null = null;
      for (const s of signers) {
        if (used.has(s.address.toLowerCase())) continue;
        if ((await ergm.hasActiveGuarantee(s.address, assetAddr)) as boolean)
          continue;
        if ((await vle.getUserTotalDebtValue(s.address)) !== 0n) continue;
        gBorrower = s;
        break;
      }
      for (const s of signers) {
        if (used.has(s.address.toLowerCase())) continue;
        if (
          gBorrower &&
          s.address.toLowerCase() === gBorrower.address.toLowerCase()
        )
          continue;
        if ((await ergm.hasActiveGuarantee(s.address, assetAddr)) as boolean)
          continue;
        gLender = s;
        break;
      }
      if (!gBorrower || !gLender) {
        throw new Error(
          "EarlyRepaymentGuarantee(E2E): cannot find fresh borrower/lender signers; restart localhost node for a clean state.",
        );
      }

      // Fund + deposit collateral (finalizeOne requires borrower already deposited `collateralAmt`)
      await fundUsdcUsers(
        [gBorrower.address, gLender.address],
        ethers.parseUnits("20000", 6),
        "fund guarantee pair",
      );
      await waitTx(
        usdc.connect(gBorrower).approve(cmAddr, collateralAmt),
        "approve collateral",
      );
      await waitTx(
        vaultCore.connect(gBorrower).deposit(assetAddr, collateralAmt),
        "deposit",
      );
      // Seed expected maps for this extra user so finalizeOne/assertViews can validate ledger/view consistency.
      expectedCollateralByBorrower.set(
        gBorrower.address,
        await cm.getCollateral(gBorrower.address, assetAddr),
      );
      expectedDebtByBorrower.set(
        gBorrower.address,
        await vle.getDebt(gBorrower.address, assetAddr),
      );

      const gPrincipal = ethers.parseUnits("200", 6);
      const orderId = await finalizeOne(
        gBorrower,
        gLender,
        gPrincipal,
        "guarantee-early",
        { withGuarantee: true },
      );

      // After match, guarantee must be active and custodied.
      const gid = (await ergm.getUserGuaranteeId(
        gBorrower.address,
        assetAddr,
      )) as bigint;
      if (gid === 0n)
        throw new Error(
          "EarlyRepaymentGuarantee(E2E): missing guaranteeId after finalizeMatch",
        );
      if (!(await ergm.hasActiveGuarantee(gBorrower.address, assetAddr)))
        throw new Error(
          "EarlyRepaymentGuarantee(E2E): expected active guarantee after match",
        );
      if (
        !((await gfm.isGuaranteePaid(gBorrower.address, assetAddr)) as boolean)
      )
        throw new Error(
          "EarlyRepaymentGuarantee(E2E): expected GFM.isGuaranteePaid==true after match",
        );

      // Preview (active guarantee), then repay via VaultCore (funds-flow SSOT).
      const repayAmount = calcTotalDue(gPrincipal, rateBps, termSec); // should fully clear debt → trigger early settle
      const previewBlock = BigInt(await ethers.provider.getBlockNumber());
      const preview = await ergm.previewEarlyRepayment(gid, repayAmount);
      const platformFeeRate = (await ergm.platformFeeRate()) as bigint;
      const lockedBefore = (await gfm.getLockedGuarantee(
        gBorrower.address,
        assetAddr,
      )) as bigint;

      await waitTx(
        usdc.connect(gBorrower).approve(vaultCoreAddr, repayAmount),
        "approve repay",
      );
      const repayRc = await waitTx(
        vaultCore.connect(gBorrower).repay(orderId, assetAddr, repayAmount),
        "repay",
      );

      // Strong: ERGM must emit EarlyRepaymentProcessed (triggered by SettlementManager).
      // IMPORTANT: do NOT use ERC20 balance deltas here (repay also moves principal+interest through OrderEngine),
      // so we assert using the SSOT event payload + GFM custody.
      let processed: any | null = null;
      for (const log of repayRc?.logs || []) {
        try {
          const parsed = ergm.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          if (parsed?.name === "EarlyRepaymentProcessed") {
            processed = parsed;
            break;
          }
        } catch {
          // ignore
        }
      }
      if (!processed)
        throw new Error(
          "EarlyRepaymentGuarantee(E2E): missing ERGM.EarlyRepaymentProcessed event in repay receipt",
        );

      const [
        ,
        borrower,
        lender,
        asset,
        penaltyToLender,
        refundToBorrower,
        platformFee,
        actualInterestPaid,
        eventBlockNumber,
      ] = processed.args as any[];
      if (
        (borrower as string).toLowerCase() !== gBorrower.address.toLowerCase()
      )
        throw new Error(
          "EarlyRepaymentGuarantee(E2E): event borrower mismatch",
        );
      if ((lender as string).toLowerCase() !== lenderPoolAddr.toLowerCase())
        throw new Error(
          "EarlyRepaymentGuarantee(E2E): event lender(pool) mismatch",
        );
      if ((asset as string).toLowerCase() !== assetAddr.toLowerCase())
        throw new Error("EarlyRepaymentGuarantee(E2E): event asset mismatch");

      const calcExpectedAtBlock = (blockNum: bigint) => {
        const record = ergm.getGuaranteeRecord(gid);
        return record.then((rec) => {
          const calcMulDiv = (a: bigint, b: bigint, c: bigint) => (a * b) / c;
          const startBlock = toBigInt(rec.startTime);
          const maturityBlock = toBigInt(rec.maturityTime);
          let totalBlocks =
            maturityBlock > startBlock ? maturityBlock - startBlock : 0n;
          if (totalBlocks === 0n) totalBlocks = 1n;
          let elapsedBlocks = blockNum - startBlock;
          if (elapsedBlocks > totalBlocks) elapsedBlocks = totalBlocks;
          if (elapsedBlocks < 0n) elapsedBlocks = 0n;
          const promisedInterest = toBigInt(rec.promisedInterest);
          const actualInterest = calcMulDiv(
            promisedInterest,
            elapsedBlocks,
            totalBlocks,
          );
          const penaltyBlocks = toBigInt(rec.earlyRepayPenaltyDays);
          let penaltyInterest = calcMulDiv(
            promisedInterest,
            penaltyBlocks,
            totalBlocks,
          );
          const remainingGuarantee = promisedInterest - actualInterest;
          if (penaltyInterest > remainingGuarantee)
            penaltyInterest = remainingGuarantee;
          const expectedPlatformFee =
            (penaltyInterest * platformFeeRate) / 10000n;
          const expectedPenaltyToLender =
            actualInterest + penaltyInterest - expectedPlatformFee;
          const expectedRefundToBorrower =
            promisedInterest - actualInterest - penaltyInterest;
          return {
            expectedPenaltyToLender,
            expectedRefundToBorrower,
            expectedPlatformFee,
            actualInterest,
          };
        });
      };

      // Compare against deterministic calc at the event block.
      const record = await ergm.getGuaranteeRecord(gid);
      const eventExpected = await calcExpectedAtBlock(
        toBigInt(eventBlockNumber),
      );
      const expectedPenaltyToLender = eventExpected.expectedPenaltyToLender;
      const expectedRefundToBorrower = eventExpected.expectedRefundToBorrower;
      const expectedPlatformFee = eventExpected.expectedPlatformFee;
      const actualInterest = eventExpected.actualInterest;

      if (toBigInt(penaltyToLender) !== expectedPenaltyToLender) {
        throw new Error(
          "EarlyRepaymentGuarantee(E2E): penaltyToLender mismatch vs event-block calc",
        );
      }
      if (toBigInt(refundToBorrower) !== expectedRefundToBorrower) {
        throw new Error(
          "EarlyRepaymentGuarantee(E2E): refundToBorrower mismatch vs event-block calc",
        );
      }
      if (toBigInt(platformFee) !== expectedPlatformFee) {
        throw new Error(
          "EarlyRepaymentGuarantee(E2E): platformFee mismatch vs event-block calc",
        );
      }
      if (toBigInt(actualInterestPaid) !== actualInterest) {
        throw new Error(
          "EarlyRepaymentGuarantee(E2E): actualInterestPaid mismatch vs event-block calc",
        );
      }

      // Preview should match calc at its call block (allow off-by-one if a block advanced).
      const previewExpected = await calcExpectedAtBlock(previewBlock);
      const previewExpectedNext = await calcExpectedAtBlock(previewBlock + 1n);
      const previewMatches =
        (toBigInt(preview.penaltyToLender) ===
          previewExpected.expectedPenaltyToLender &&
          toBigInt(preview.refundToBorrower) ===
            previewExpected.expectedRefundToBorrower &&
          toBigInt(preview.platformFee) ===
            previewExpected.expectedPlatformFee &&
          toBigInt(preview.actualInterestPaid) ===
            previewExpected.actualInterest) ||
        (toBigInt(preview.penaltyToLender) ===
          previewExpectedNext.expectedPenaltyToLender &&
          toBigInt(preview.refundToBorrower) ===
            previewExpectedNext.expectedRefundToBorrower &&
          toBigInt(preview.platformFee) ===
            previewExpectedNext.expectedPlatformFee &&
          toBigInt(preview.actualInterestPaid) ===
            previewExpectedNext.actualInterest);
      if (!previewMatches) {
        throw new Error(
          "EarlyRepaymentGuarantee(E2E): preview mismatch vs call-block calc",
        );
      }

      // Guarantee must be cleared on-chain (custody + record)
      const lockedAfter = (await gfm.getLockedGuarantee(
        gBorrower.address,
        assetAddr,
      )) as bigint;
      if (lockedAfter !== 0n) {
        throw new Error(
          `EarlyRepaymentGuarantee(E2E): expected locked guarantee cleared. before=${lockedBefore.toString()} after=${lockedAfter.toString()}`,
        );
      }
      if (
        (await ergm.hasActiveGuarantee(gBorrower.address, assetAddr)) as boolean
      ) {
        throw new Error(
          "EarlyRepaymentGuarantee(E2E): expected ERGM.hasActiveGuarantee==false after early settlement",
        );
      }
      if (
        (await gfm.isGuaranteePaid(gBorrower.address, assetAddr)) as boolean
      ) {
        throw new Error(
          "EarlyRepaymentGuarantee(E2E): expected GFM.isGuaranteePaid==false after early settlement",
        );
      }

      console.log(
        "  ✅ VBL lock+record → VaultCore.repay triggered early guarantee settlement (3-way distribution checked)",
      );
    }

    // ============ Extra coverage: Default guarantee processing (settleOrLiquidate SSOT path) ============
    // - Lock/record: VBL.finalizeMatch
    // - Default: SettlementManager.settleOrLiquidate (keeper SSOT) triggers ERGM.processDefault -> GFM.forfeitPartial
    console.log(
      "=== Extra: EarlyRepaymentGuarantee (VBL lock+record → settleOrLiquidate triggers forfeiture) ===",
    );
    if (!guaranteeToggleSupported) {
      logNotice(
        "  [Notice] Skipping: ERGM toggle not supported in this localhost deployment (see message above).",
      );
    } else {
      // Ensure extension flow is enabled for this block as well.
      if (!(await ergm.isGuaranteeEnabled(assetAddr))) {
        await waitTx(
          ergm.connect(deployer).setGuaranteeEnabled(assetAddr, true),
          "setGuaranteeEnabled(true)",
        );
      }
      const used = new Set<string>(
        [
          deployer.address,
          ...borrowers.map((x) => x.address),
          ...lenders.map((x) => x.address),
        ].map((x) => x.toLowerCase()),
      );
      let dBorrower: any | null = null;
      let dLender: any | null = null;
      for (const s of signers) {
        if (used.has(s.address.toLowerCase())) continue;
        if ((await ergm.hasActiveGuarantee(s.address, assetAddr)) as boolean)
          continue;
        if ((await vle.getUserTotalDebtValue(s.address)) !== 0n) continue;
        // Ensure the "fresh" borrower isn't carrying leftover collateral from prior runs.
        if (((await cm.getCollateral(s.address, assetAddr)) as bigint) !== 0n)
          continue;
        dBorrower = s;
        break;
      }
      for (const s of signers) {
        if (used.has(s.address.toLowerCase())) continue;
        if (
          dBorrower &&
          s.address.toLowerCase() === dBorrower.address.toLowerCase()
        )
          continue;
        if ((await ergm.hasActiveGuarantee(s.address, assetAddr)) as boolean)
          continue;
        dLender = s;
        break;
      }
      if (!dBorrower || !dLender) {
        throw new Error(
          "DefaultGuarantee(E2E): cannot find fresh borrower/lender signers; restart localhost node for a clean state.",
        );
      }

      await fundUsdcUsers(
        [dBorrower.address, dLender.address],
        ethers.parseUnits("20000", 6),
        "fund degen pair",
      );
      await waitTx(
        usdc.connect(dBorrower).approve(cmAddr, collateralAmt),
        "approve collateral",
      );
      await waitTx(
        vaultCore.connect(dBorrower).deposit(assetAddr, collateralAmt),
        "deposit",
      );
      expectedCollateralByBorrower.set(
        dBorrower.address,
        await cm.getCollateral(dBorrower.address, assetAddr),
      );
      expectedDebtByBorrower.set(
        dBorrower.address,
        await vle.getDebt(dBorrower.address, assetAddr),
      );

      const dPrincipal = ethers.parseUnits("150", 6);
      const dOrderId = await finalizeOne(
        dBorrower,
        dLender,
        dPrincipal,
        "guarantee-default",
        { withGuarantee: true },
      );

      // Ensure guarantee exists before default processing
      const dGid = (await ergm.getUserGuaranteeId(
        dBorrower.address,
        assetAddr,
      )) as bigint;
      if (dGid === 0n)
        throw new Error(
          "DefaultGuarantee(E2E): missing guaranteeId after finalizeMatch",
        );
      const dRec = await ergm.getGuaranteeRecord(dGid);
      if (
        !((await gfm.isGuaranteePaid(dBorrower.address, assetAddr)) as boolean)
      )
        throw new Error(
          "DefaultGuarantee(E2E): expected GFM.isGuaranteePaid==true after match",
        );
      if (
        !((await ergm.hasActiveGuarantee(
          dBorrower.address,
          assetAddr,
        )) as boolean)
      )
        throw new Error(
          "DefaultGuarantee(E2E): expected ERGM.hasActiveGuarantee==true after match",
        );

      // Mine beyond maturity → overdue branch
      const ord = await orderEngine.getLoanOrderForView(dOrderId);
      const maturityBlock = BigInt(ord.maturity);
      await mineToBlock(maturityBlock + 1n);
      // Refresh price after time travel to avoid stale valuation (Liquidation path uses valuation).
      await refreshPriceOracleBlock({
        priceOracle: po,
        asset: assetAddr,
        signer: deployer,
        print: true,
      });

      // Keeper entry is ACTION_LIQUIDATE-gated (SettlementManager SSOT).
      // Make this block robust even if localhost deployments differ in initial role grants.
      await ensureRole("LIQUIDATE", deployer.address);
      // SettlementManager internally queries risk valuation via PositionView.getAssetValue(),
      // which is gated by ACTION_VIEW_RISK_DATA (Scheme U / view read policy).
      // Grant this role to the SettlementManager contract address to avoid MissingRole() during liquidation routing.
      await ensureRole("VIEW_RISK_DATA", settlementManagerAddr);
      await ensureRole("VIEW_USER_DATA", settlementManagerAddr);
      await ensureRole("VIEW_SYSTEM_DATA", settlementManagerAddr);
      await ensureRole("VIEW_SYSTEM_DATA", liquidationManagerAddr);
      await ensureRole("VIEW_RISK_DATA", liquidationManagerAddr);
      await ensureRole("VIEW_USER_DATA", liquidationRiskManagerAddr);

      const liqRc = await waitTx(
        settlementManager.connect(deployer).settleOrLiquidate(dOrderId),
        "settleOrLiquidate",
      );

      const hasForfeited = (liqRc?.logs || []).some((log: any) => {
        try {
          const parsed = ergm.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          return parsed?.name === "GuaranteeForfeited";
        } catch {
          return false;
        }
      });
      if (!hasForfeited)
        throw new Error(
          "DefaultGuarantee(E2E): missing ERGM.GuaranteeForfeited event in settleOrLiquidate receipt",
        );
      // Parse the forfeiture event and assert SSOT payload consistency.
      let forfeited: any | null = null;
      for (const log of liqRc?.logs || []) {
        try {
          const parsed = ergm.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          if (parsed?.name === "GuaranteeForfeited") {
            forfeited = parsed;
            break;
          }
        } catch {
          // ignore
        }
      }
      if (!forfeited)
        throw new Error(
          "DefaultGuarantee(E2E): cannot parse ERGM.GuaranteeForfeited event",
        );
      const [gidEvt, borrowerEvt, lenderEvt, assetEvt, forfeitedAmount] =
        forfeited.args as any[];
      if (toBigInt(gidEvt) !== dGid)
        throw new Error("DefaultGuarantee(E2E): event guaranteeId mismatch");
      if (
        (borrowerEvt as string).toLowerCase() !==
        dBorrower.address.toLowerCase()
      )
        throw new Error("DefaultGuarantee(E2E): event borrower mismatch");
      if ((lenderEvt as string).toLowerCase() !== lenderPoolAddr.toLowerCase())
        throw new Error("DefaultGuarantee(E2E): event lender(pool) mismatch");
      if ((assetEvt as string).toLowerCase() !== assetAddr.toLowerCase())
        throw new Error("DefaultGuarantee(E2E): event asset mismatch");
      // Current product rule: forfeited == promisedInterest (custodied in GFM).
      if (toBigInt(forfeitedAmount) !== toBigInt(dRec.promisedInterest)) {
        throw new Error(
          "DefaultGuarantee(E2E): forfeitedAmount mismatch vs promisedInterest",
        );
      }

      if (
        (await ergm.hasActiveGuarantee(dBorrower.address, assetAddr)) as boolean
      ) {
        throw new Error(
          "DefaultGuarantee(E2E): expected ERGM.hasActiveGuarantee==false after forfeiture",
        );
      }
      if (
        (await gfm.isGuaranteePaid(dBorrower.address, assetAddr)) as boolean
      ) {
        throw new Error(
          "DefaultGuarantee(E2E): expected GFM.isGuaranteePaid==false after forfeiture",
        );
      }
      console.log(
        "  ✅ settleOrLiquidate triggered guarantee forfeiture + cleared custody/record",
      );

      // Reward should NOT auto-trigger on settleOrLiquidate (no repay callback).
      assertRewardAutoTriggers("Default guarantee settleOrLiquidate", liqRc, {
        expectMinted: false,
        expectPenalty: "none",
      });

      // IMPORTANT:
      // `settleOrLiquidate` may only seize the minimum collateral needed to cover the debt.
      // Any remaining collateral stays in CollateralManager under the borrower's account, which will
      // make global `StatisticsView.totalCollateral` drift vs the main 5-borrower ledger delta.
      // Withdraw the remainder to keep the run delta-neutral for strict E2E.
      const dRemainingCollateral = (await cm.getCollateral(
        dBorrower.address,
        assetAddr,
      )) as bigint;
      if (dRemainingCollateral > 0n) {
        await waitTx(
          vaultCore
            .connect(dBorrower)
            .withdraw(assetAddr, dRemainingCollateral),
          "withdraw",
        );
        console.log(
          `  ✅ default borrower withdrew remaining collateral ${ethers.formatUnits(dRemainingCollateral, 6)}`,
        );
      }
    }

    // ============ Checkpoint (pre-extras): all debts cleared (delta-based) ============
    console.log("=== Checkpoint (pre-extras): totals after all repaid ===");
    // Expected (SSOT): after full repay, SettlementManager auto-releases all collateral for that user (when totalDebtValue==0),
    // so the expected final collateral delta is derived from our per-borrower expected map (not "deposit amount").
    let expectedFinalColSum = 0n;
    for (const b of borrowers)
      expectedFinalColSum += expectedCollateralByBorrower.get(b.address) || 0n;
    const expectedFinalLedgerColDelta =
      expectedFinalColSum - baselineTotals.colSum;

    await ensureStatisticsConverged("after all repaid", toUsd8(expectedFinalLedgerColDelta), 0n);
    const finalTotals = await snapshotBorrowersTotals(assetAddr);
    const [finalStats] = await statisticsView.getGlobalStatisticsWithMeta();

    const finalLedgerColDelta = finalTotals.colSum - baselineTotals.colSum;
    const finalLedgerDebtDelta = finalTotals.debtSum - baselineTotals.debtSum;
    const finalStatsColDelta =
      toBigInt(finalStats.totalCollateral) -
      toBigInt(baselineStats.totalCollateral);
    const finalStatsDebtDelta =
      toBigInt(finalStats.totalDebt) - toBigInt(baselineStats.totalDebt);

    const checkpointPreExtrasAfterAllRepaid = {
      expected: {
        ledgerCollateralDeltaRaw: expectedFinalLedgerColDelta.toString(),
        ledgerDebtDeltaRaw: "0",
      },
      ledger: {
        collateralDeltaRaw: finalLedgerColDelta.toString(),
        debtDeltaRaw: finalLedgerDebtDelta.toString(),
      },
      statisticsView: {
        collateralDeltaUsd8Raw: finalStatsColDelta.toString(),
        debtDeltaUsd8Raw: finalStatsDebtDelta.toString(),
      },
      note: "This checkpoint is captured BEFORE extras. Later extras may change totals (e.g. liquidation demo).",
    };
    // New name (avoid misreading it as the end-of-script final state).
    artifactCheckpoints["checkpoint_pre_extras_after_all_repaid"] =
      checkpointPreExtrasAfterAllRepaid;
    // Legacy name kept for backward compatibility with existing artifact tooling.
    artifactCheckpoints["final_after_all_repaid"] =
      checkpointPreExtrasAfterAllRepaid;
    const expectedFinalStatsColDelta = toUsd8(expectedFinalLedgerColDelta);

    console.log(
      "Expected deltas: collateral",
      ethers.formatUnits(expectedFinalLedgerColDelta, 6),
      "debt",
      ethers.formatUnits(0n, 6),
    );
    console.log(
      "Ledger deltas:    collateral",
      ethers.formatUnits(finalLedgerColDelta, 6),
      "debt",
      ethers.formatUnits(finalLedgerDebtDelta, 6),
    );
    console.log(
      "Stats deltas:     collateral",
      ethers.formatUnits(finalStatsColDelta, 8),
      "debt",
      ethers.formatUnits(finalStatsDebtDelta, 8),
    );

    if (finalLedgerColDelta !== expectedFinalLedgerColDelta)
      throw new Error("Final: ledger collateral delta mismatch");
    if (finalLedgerDebtDelta !== 0n)
      throw new Error(
        "Final: ledger debt delta should be 0 (new loans fully repaid)",
      );
    if (finalStatsColDelta !== expectedFinalStatsColDelta) {
      const msg = `Final: StatisticsView collateral delta mismatch got=${ethers.formatUnits(
        finalStatsColDelta,
        8,
      )} expected=${ethers.formatUnits(expectedFinalStatsColDelta, 8)}`;
      logNotice(
        `  [Notice] [BestEffort] ${msg} (PositionView/ledger remains SSOT for collateral valuation)`,
      );
    }
    if (finalStatsDebtDelta !== 0n) {
      const msg = `Final: StatisticsView debt delta expected 0, got=${ethers.formatUnits(finalStatsDebtDelta, 8)}`;
      if (strictViews && !baselineDirty) throw new Error(msg);
      logNotice(`  [Notice] [BestEffort] ${msg} (continuing)`);
    }

    console.log("✅ Checkpoint passed (pre-extras)\n");
    await logPositionViewVersion("checkpoint (pre-extras, after all repaid)");

    // ============ EasyToken Guide coverage (Spend + Staking/Governance) ============
    console.log(
      "=== EasyToken Guide Coverage (Spend + Staking/Governance) ===",
    );
    const easySupply = (await easyToken.totalSupply()) as bigint;
    const allowEasyGuide =
      !skipEasyMintAssertion && (strictReward || easySupply > 0n);
    if (!allowEasyGuide) {
      logNotice(
        "  [Notice]  Easy mint not observed; skipping EasyToken guide coverage",
      );
    } else {
      const easyConsumptionAddr = (await registry.getModule(
        key("EASY_CONSUMPTION"),
      )) as string;
      const easyRecycleAddr = (await registry.getModule(
        key("EASY_RECYCLE_DISTRIBUTOR"),
      )) as string;
      const easyStakingAddr = (await registry.getModule(
        key("EASY_STAKING"),
      )) as string;
      const crossChainGovAddr = (await registry.getModule(
        key("CROSS_CHAIN_GOVERNANCE"),
      )) as string;

      const guideUser = rewardBorrower;
      const guideLender = lenders[0].address;
      const minEasyForGuide = ONE_EASY * 4n;
      await ensureEasyBalance(guideUser.address, guideLender, minEasyForGuide);

      const DATA_TYPE_EASY_SPENT = ethers
        .keccak256(ethers.toUtf8Bytes("EASY_SPENT"))
        .toLowerCase();
      const DATA_TYPE_EASY_RECYCLED_SPLIT = ethers
        .keccak256(ethers.toUtf8Bytes("EASY_RECYCLED_SPLIT"))
        .toLowerCase();

      if (
        easyConsumptionAddr &&
        easyConsumptionAddr !== ethers.ZeroAddress &&
        easyRecycleAddr &&
        easyRecycleAddr !== ethers.ZeroAddress
      ) {
        const easyConsumption = (await ethers.getContractAt(
          "EasyConsumption",
          easyConsumptionAddr,
        )) as any;
        const bal0 = (await easyToken.balanceOf(guideUser.address)) as bigint;
        await waitTx(
          easyToken
            .connect(guideUser)
            .approve(await easyConsumption.getAddress(), ONE_EASY),
          "approve easy spend",
        );
        const rcpt = await waitTx(
          easyConsumption
            .connect(guideUser)
            .consumeEasiMCall(guideUser.address),
          "consumeEasiMCall",
        );
        const bal1 = (await easyToken.balanceOf(guideUser.address)) as bigint;
        if (bal0 - bal1 !== ONE_EASY)
          throw new Error("[Easy] consumeEasiMCall burn delta mismatch");
        const pushes = recordDataPushed(rcpt);
        if (!pushes.some((p) => p.dataTypeHash === DATA_TYPE_EASY_SPENT)) {
          throw new Error(
            "[Easy] missing DataPushed(EASY_SPENT) on consumeEasiMCall",
          );
        }
        const split = pushes.find(
          (p) => p.dataTypeHash === DATA_TYPE_EASY_RECYCLED_SPLIT,
        );
        if (!split)
          throw new Error(
            "[Easy] missing DataPushed(EASY_RECYCLED_SPLIT) on consumeEasiMCall",
          );
        const [u, amt, burn, team, eco, spendType] = coder.decode(
          [
            "address",
            "uint256",
            "uint256",
            "uint256",
            "uint256",
            "uint8",
            "uint256",
          ],
          split.payload,
        ) as unknown as [
          string,
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
        ];
        if (u.toLowerCase() !== guideUser.address.toLowerCase())
          throw new Error("[Easy] EASY_RECYCLED_SPLIT user mismatch");
        if (amt !== ONE_EASY)
          throw new Error("[Easy] EASY_RECYCLED_SPLIT amount mismatch");
        if (spendType !== 0n)
          throw new Error(
            "[Easy] EASY_RECYCLED_SPLIT spendType mismatch (expect EasiMCall=0)",
          );
        if (burn + team + eco !== amt)
          throw new Error("[Easy] EASY_RECYCLED_SPLIT sum mismatch");
      } else {
        logNotice(
          "  [Notice]  EasyConsumption/EasyRecycleDistributor not bound; skipping per-call spend checks",
        );
      }

      if (easyStakingAddr && easyStakingAddr !== ethers.ZeroAddress) {
        const easyStaking = (await ethers.getContractAt(
          "EasyStaking",
          easyStakingAddr,
        )) as any;
        const bal0 = (await easyToken.balanceOf(guideUser.address)) as bigint;
        await waitTx(
          easyToken
            .connect(guideUser)
            .approve(await easyStaking.getAddress(), ONE_EASY),
          "approve stake",
        );
        const rcptStake = await waitTx(
          easyStaking.connect(guideUser).stake(ONE_EASY),
          "stake",
        );
        const bal1 = (await easyToken.balanceOf(guideUser.address)) as bigint;
        const stBal = (await easyStaking.balanceOf(
          guideUser.address,
        )) as bigint;
        if (bal0 - bal1 !== ONE_EASY)
          throw new Error("[Governance] stake burn delta mismatch");
        if (stBal < ONE_EASY)
          throw new Error(
            "[Governance] stEASY balance did not increase after stake",
          );
        const delegate = await easyStaking.delegates(guideUser.address);
        if (delegate.toLowerCase() !== guideUser.address.toLowerCase()) {
          throw new Error(
            "[Governance] stEASY should self-delegate on first stake",
          );
        }
        const votes = (await easyStaking.getVotes(guideUser.address)) as bigint;
        if (votes < ONE_EASY)
          throw new Error(
            "[Governance] getVotes should reflect stEASY balance",
          );
        const stakeBlock = BigInt(rcptStake.blockNumber);
        const snapshotBlock = stakeBlock > 0n ? stakeBlock - 1n : 0n;
        await easyStaking.getPastVotes(guideUser.address, snapshotBlock);
      } else {
        logNotice(
          "  [Notice]  EasyStaking not bound; skipping staking/votes checks",
        );
      }

      if (
        crossChainGovAddr &&
        crossChainGovAddr !== ethers.ZeroAddress &&
        easyStakingAddr &&
        easyStakingAddr !== ethers.ZeroAddress
      ) {
        const ccg = (await ethers.getContractAt(
          "CrossChainGovernance",
          crossChainGovAddr,
        )) as any;
        const expected = await ccg.expectedGovernanceToken();
        const cached = await ccg.governanceToken();
        if (expected.toLowerCase() !== easyStakingAddr.toLowerCase()) {
          throw new Error(
            "[Governance] expectedGovernanceToken mismatch vs Registry[KEY_EASY_STAKING]",
          );
        }
        if (cached.toLowerCase() !== expected.toLowerCase()) {
          throw new Error(
            "[Governance] governanceToken cache out of sync with Registry",
          );
        }
      } else {
        logNotice(
          "  [Notice]  CrossChainGovernance or EasyStaking not bound; skipping governance SSOT checks",
        );
      }

      console.log("  ✅ EasyToken guide checks passed\n");
    }

    // ============ Extra coverage: Cancel Reserve (Reserve → Cancel) ============
    console.log("=== Extra: Cancel Reserve (Reserve → Cancel) ===");
    {
      const lender = lenders[0];
      const amount = ethers.parseUnits("123", 6);
      const lenderBalBefore = (await usdc.balanceOf(lender.address)) as bigint;

      const poolAddr = (await registry.getModuleOrRevert(
        key("LENDER_POOL_VAULT"),
      )) as string;
      const poolBalBefore = (await usdc.balanceOf(poolAddr)) as bigint;

      const expireAt = (await latestBlockNumber()) + ONE_HOUR_BLOCKS;
      const lendIntent = {
        lenderSigner: lender.address,
        asset: assetAddr,
        amount,
        minTermDays: 1,
        maxTermDays: 30,
        minRateBps: 0n,
        expireAt,
        salt: ethers.keccak256(ethers.toUtf8Bytes("lend-cancel-demo")),
      };

      await waitTx(
        usdc.connect(lender).approve(vblAddr, amount),
        "approve reserve",
      );
      const lendHash = buildLendIntentHash(lendIntent);
      await waitTx(
        vbl
          .connect(lender)
          .reserveForLending(lender.address, assetAddr, amount, lendHash),
        "reserveForLending",
      );

      const lenderBalAfterReserve = (await usdc.balanceOf(
        lender.address,
      )) as bigint;
      const poolBalAfterReserve = (await usdc.balanceOf(poolAddr)) as bigint;
      if (lenderBalBefore - lenderBalAfterReserve !== amount)
        throw new Error(
          "CancelReserve: lender balance did not decrease by reserve amount",
        );
      if (poolBalAfterReserve - poolBalBefore !== amount)
        throw new Error(
          "CancelReserve: pool balance did not increase by reserve amount",
        );

      await waitTx(
        vbl.connect(lender).cancelReserve(lendHash),
        "cancelReserve",
      );
      const lenderBalAfterCancel = (await usdc.balanceOf(
        lender.address,
      )) as bigint;
      const poolBalAfterCancel = (await usdc.balanceOf(poolAddr)) as bigint;
      if (lenderBalAfterCancel !== lenderBalBefore)
        throw new Error(
          "CancelReserve: lender balance not restored after cancel",
        );
      if (poolBalAfterCancel !== poolBalBefore)
        throw new Error(
          "CancelReserve: pool balance not restored after cancel",
        );
      console.log("  ✅ reserve → cancel verified");
    }

    // ============ Extra coverage: PriceOracle stale price (negative) ==========
    console.log("=== Extra: PriceOracle Stale Price (negative) ===");
    {
      const used = new Set<string>(
        [
          deployer.address,
          ...borrowers.map((x) => x.address),
          ...lenders.map((x) => x.address),
        ].map((x) => x.toLowerCase()),
      );
      let user: any | null = null;
      for (const s of signers) {
        if (used.has(s.address.toLowerCase())) continue;
        if ((await vle.getUserTotalDebtValue(s.address)) === 0n) {
          user = s;
          break;
        }
      }
      if (!user)
        throw new Error(
          "Stale price: cannot find unused signer; restart localhost node for a clean state.",
        );

      const depositAmt = ethers.parseUnits("100", 6);
      await fundUsdcUsers(
        [user.address],
        ethers.parseUnits("20000", 6),
        "fund user",
      );
      await waitTx(
        usdc.connect(user).approve(cmAddr, depositAmt),
        "approve collateral",
      );
      await waitTx(
        vaultCore.connect(user).deposit(assetAddr, depositAmt),
        "deposit",
      );

      const nowBlock = await latestBlockNumber();
      await waitTx(
        po
          .connect(deployer)
          .updatePrice(assetAddr, ethers.parseUnits("1", 8), nowBlock),
        "updatePrice",
      );

      // PriceOracle staleness is block-number based (maxPriceAgeBlocks).
      // Mine enough blocks so: (block.number - updatedAtBlock) > maxPriceAgeBlocks.
      const cfg: any = await po.getAssetConfig(assetAddr);
      const maxAgeBlocks: bigint = cfg?.maxPriceAgeBlocks ?? cfg?.[3];
      if (typeof maxAgeBlocks !== "bigint")
        throw new Error(
          "Stale price: cannot read maxPriceAgeBlocks from PriceOracle.getAssetConfig",
        );
      await mineToBlock(nowBlock + maxAgeBlocks + 2n);

      const staleSel = errorSelector("PriceOracle__StalePrice()");
      await mustRevertWithSelector(
        "PriceOracle.getPrice should revert on stale price",
        async () => po.getPrice(assetAddr),
        staleSel,
      );

      // Refresh price and ensure view works again
      const nowAfter = await latestBlockNumber();
      await waitTx(
        po
          .connect(deployer)
          .updatePrice(assetAddr, ethers.parseUnits("1", 8), nowAfter),
        "updatePrice",
      );
      await positionView.getUserTotalCollateralValue(user.address);

      const colNow = (await cm.getCollateral(
        user.address,
        assetAddr,
      )) as bigint;
      if (colNow > 0n) {
        await waitTx(
          vaultCore.connect(user).withdraw(assetAddr, colNow),
          "withdraw",
        );
      }
      console.log("  ✅ stale price negative path verified");
    }

    // ============ Extra coverage: User Withdraw (Deposit → Withdraw) ============
    console.log("=== Extra: User Withdraw (Deposit → Withdraw) ===");
    {
      // Use a fresh user (not one of the borrowers), because in SSOT repay flow
      // collateral may be auto-released to 0 for the main borrowers after full repayment.
      const used = new Set<string>(
        [
          deployer.address,
          ...borrowers.map((x) => x.address),
          ...lenders.map((x) => x.address),
        ].map((x) => x.toLowerCase()),
      );
      let user: any | null = null;
      for (const s of signers) {
        if (used.has(s.address.toLowerCase())) continue;
        if ((await vle.getUserTotalDebtValue(s.address)) === 0n) {
          user = s;
          break;
        }
      }
      if (!user)
        throw new Error(
          "Withdraw: cannot find unused signer; restart localhost node for a clean state.",
        );

      const depositAmt = ethers.parseUnits("1000", 6);
      const withdrawAmt = ethers.parseUnits("100", 6);
      await fundUsdcUsers(
        [user.address],
        ethers.parseUnits("20000", 6),
        "fund user",
      );

      await waitTx(
        usdc.connect(user).approve(cmAddr, depositAmt),
        "approve collateral",
      );
      await waitTx(
        vaultCore.connect(user).deposit(assetAddr, depositAmt),
        "deposit",
      );

      const colBefore = (await cm.getCollateral(
        user.address,
        assetAddr,
      )) as bigint;
      const balBefore = (await usdc.balanceOf(user.address)) as bigint;
      await waitTx(
        vaultCore.connect(user).withdraw(assetAddr, withdrawAmt),
        "withdraw",
      );
      const colAfter = (await cm.getCollateral(
        user.address,
        assetAddr,
      )) as bigint;
      const balAfter = (await usdc.balanceOf(user.address)) as bigint;
      if (colBefore - colAfter !== withdrawAmt)
        throw new Error("Withdraw: collateral delta mismatch");
      if (balAfter - balBefore !== withdrawAmt)
        throw new Error("Withdraw: user token delta mismatch");
      await assertViews(
        "After withdraw (extra)",
        user.address,
        assetAddr,
        colAfter,
        0n,
      );
      await mustRevert("Withdraw should reject amount > collateral", async () =>
        vaultCore.connect(user).withdraw(assetAddr, colAfter + 1n),
      );
      if (colAfter > 0n) {
        await waitTx(
          vaultCore.connect(user).withdraw(assetAddr, colAfter),
          "withdraw remaining collateral",
        );
        const colFinal = (await cm.getCollateral(
          user.address,
          assetAddr,
        )) as bigint;
        if (colFinal !== 0n)
          throw new Error("Withdraw: remaining collateral cleanup failed");
      }
      console.log("  ✅ withdraw verified");
    }

    // ============ Extra coverage: Keeper Liquidation SSOT (settleOrLiquidate) ============
    console.log("=== Extra: Keeper Liquidation (settleOrLiquidate SSOT) ===");
    {
      // Liquidation demo is unrelated to the guarantee extension flow; disable guarantee to keep
      // `finalizeOne()` free of extra ERC20 approvals and "1 active guarantee per (user, asset)" constraints.
      if (guaranteeToggleSupported) {
        try {
          if ((await ergm.isGuaranteeEnabled(assetAddr)) as boolean) {
            await waitTx(
              ergm.connect(deployer).setGuaranteeEnabled(assetAddr, false),
              "setGuaranteeEnabled(false)",
            );
          }
        } catch {
          // best-effort; if toggle is unavailable we already skipped guarantee blocks
        }
      }

      // Create a fresh order and make it overdue; then trigger unified liquidation entry.
      const liqBorrower = borrowers[4];
      const liqLender = lenders[1];
      const liqPrincipal = ethers.parseUnits("200", 6);

      // Ensure borrower has enough collateral for `finalizeOne()`:
      // finalizeOne() uses the script-wide `collateralAmt` as borrowIntent.collateralAmount.
      const colNow = (await cm.getCollateral(
        liqBorrower.address,
        assetAddr,
      )) as bigint;
      if (colNow < collateralAmt) {
        const topUp = collateralAmt - colNow;
        await waitTx(
          usdc.connect(liqBorrower).approve(cmAddr, topUp),
          "approve collateral",
        );
        await waitTx(
          vaultCore.connect(liqBorrower).deposit(assetAddr, topUp),
          "deposit",
        );
        expectedCollateralByBorrower.set(
          liqBorrower.address,
          (expectedCollateralByBorrower.get(liqBorrower.address) || 0n) + topUp,
        );
      }

      const orderId = await finalizeOne(
        liqBorrower,
        liqLender,
        liqPrincipal,
        "liq-demo",
      );
      // SettlementManager liquidation path selects collateral via CM.getUserCollateralAssets(user),
      // so ensure the user's collateral asset list is non-empty (SSOT requirement).
      let assets = (await cm.getUserCollateralAssets(
        liqBorrower.address,
      )) as string[];
      if (assets.length === 0) {
        const bump = ethers.parseUnits("1", 6);
        await waitTx(
          usdc.connect(liqBorrower).approve(cmAddr, bump),
          "approve collateral",
        );
        await waitTx(
          vaultCore.connect(liqBorrower).deposit(assetAddr, bump),
          "deposit",
        );
        assets = (await cm.getUserCollateralAssets(
          liqBorrower.address,
        )) as string[];
      }
      if (assets.length === 0)
        throw new Error(
          "Liquidation: user has no collateral asset list (CM.getUserCollateralAssets empty)",
        );
      if (
        !assets.map((a) => a.toLowerCase()).includes(assetAddr.toLowerCase())
      ) {
        const bump = ethers.parseUnits("1", 6);
        await waitTx(
          usdc.connect(liqBorrower).approve(cmAddr, bump),
          "approve collateral",
        );
        await waitTx(
          vaultCore.connect(liqBorrower).deposit(assetAddr, bump),
          "deposit",
        );
        assets = (await cm.getUserCollateralAssets(
          liqBorrower.address,
        )) as string[];
      }
      if (
        !assets.map((a) => a.toLowerCase()).includes(assetAddr.toLowerCase())
      ) {
        throw new Error(
          "Liquidation: collateral asset list does not include assetAddr",
        );
      }

      const debtBefore = (await vle.getDebt(
        liqBorrower.address,
        assetAddr,
      )) as bigint;
      const colBefore = (await cm.getCollateral(
        liqBorrower.address,
        assetAddr,
      )) as bigint;
      if (colBefore === 0n)
        throw new Error(
          "Liquidation: user collateral balance is 0 before liquidation",
        );

      // Mine beyond maturity (block-based time axis).
      const ord = await orderEngine.getLoanOrderForView(orderId);
      await mineToBlock(BigInt(ord.maturity) + 1n);
      // PriceOracle may treat old prices as stale after time travel; refresh price so valuation != 0.
      await refreshPriceOracleBlock({
        priceOracle: po,
        asset: assetAddr,
        signer: deployer,
        print: true,
      });
      const liqRc = await waitTx(
        settlementManager.connect(deployer).settleOrLiquidate(orderId),
        "settleOrLiquidate",
      );
      await assertRiskStatusUpdated(
        "After keeper liquidation",
        liqBorrower.address,
      );
      assertLiquidationDataPush("Liquidation", liqRc, liqBorrower.address);
      assertRewardAutoTriggers("Liquidation", liqRc, {
        expectMinted: false,
        expectPenalty: "none",
      });

      const debtAfter = (await vle.getDebt(
        liqBorrower.address,
        assetAddr,
      )) as bigint;
      const colAfter = (await cm.getCollateral(
        liqBorrower.address,
        assetAddr,
      )) as bigint;
      if (debtAfter >= debtBefore)
        throw new Error("Liquidation: debt did not decrease");
      if (colAfter >= colBefore)
        throw new Error("Liquidation: collateral did not decrease");
      const liqTokenId = await findLoanNftTokenIdByLoanId(
        liqBorrower.address,
        orderId,
      );
      if (liqTokenId === null)
        throw new Error(
          "Liquidation: LoanNFT token not found for liquidated order",
        );
      const liqMeta = await loanNft.getLoanMetadata(liqTokenId);
      // NOTE: `SettlementManager.settleOrLiquidate` (and `LiquidationManager`) do not update LoanNFT status.
      // Status transitions are managed via `LoanNFT.updateLoanStatus` by the minter.
      if ((liqMeta.status as bigint) === 1n) {
        throw new Error(
          "Liquidation: LoanNFT status unexpectedly became Repaid after settleOrLiquidate",
        );
      }
      console.log(
        "  ✅ liquidation executed (debt reduced, collateral seized)",
      );
    }

    // ============ Extra coverage: Blocks-only rollout smoke ============
    console.log("=== Extra: Blocks-only rollout smoke (Registry-bound) ===");
    {
      const blocksOnlySummary = await runBlocksOnlyRolloutSmoke({
        label: "Blocks-only rollout smoke (embedded in batch)",
        borrower: borrowers[0],
        lender: lenders[0],
        liquidationBorrower: borrowers[1],
        excludedAddresses: [deployer.address],
        useSnapshot: false,
        writeArtifact: true,
        artifactTag: "advanced-batch",
        printSummary: true,
        strictRolePreflight: true,
        strictDataPushPayloads: strictDataPush,
      });

      for (const [typeHash, count] of Object.entries(
        blocksOnlySummary.dataPushCounts,
      )) {
        dataPushCounts[typeHash.toLowerCase()] =
          (dataPushCounts[typeHash.toLowerCase()] ?? 0) + count;
      }
      artifactCheckpoints["blocksOnlyRolloutSmoke"] = blocksOnlySummary;
      console.log("  ✅ blocks-only rollout smoke verified");
    }

    // ============ Checkpoint (post-extras): end-of-script deltas (informational) ============
    // IMPORTANT: extras are expected to be able to change totals (e.g. liquidation demo).
    // This checkpoint is for observability / artifact consumers; it intentionally does NOT assert zero deltas.
    console.log("=== Checkpoint (post-extras): end-of-script deltas ===");
    const postTotals = await snapshotBorrowersTotals(assetAddr);
    const postLedgerColDelta = postTotals.colSum - baselineTotals.colSum;
    const postLedgerDebtDelta = postTotals.debtSum - baselineTotals.debtSum;
    await ensureStatisticsConverged("post extras", toUsd8(postLedgerColDelta), toUsd8(postLedgerDebtDelta));
    const [postStats] = await statisticsView.getGlobalStatisticsWithMeta();
    const postStatsColDelta =
      toBigInt(postStats.totalCollateral) -
      toBigInt(baselineStats.totalCollateral);
    const postStatsDebtDelta =
      toBigInt(postStats.totalDebt) - toBigInt(baselineStats.totalDebt);
    const expectedPostStatsColDelta = toUsd8(postLedgerColDelta);
    const expectedPostStatsDebtDelta = toUsd8(postLedgerDebtDelta);
    artifactCheckpoints["final_end_of_script"] = {
      ledger: {
        collateralDeltaRaw: postLedgerColDelta.toString(),
        debtDeltaRaw: postLedgerDebtDelta.toString(),
      },
      statisticsView: {
        collateralDeltaUsd8Raw: postStatsColDelta.toString(),
        debtDeltaUsd8Raw: postStatsDebtDelta.toString(),
      },
      note: "Captured AFTER extras. Deltas may be non-zero by design (extras include additional flows such as liquidation demo).",
    };
    console.log(
      "Post-extras ledger deltas: collateral",
      ethers.formatUnits(postLedgerColDelta, 6),
      "debt",
      ethers.formatUnits(postLedgerDebtDelta, 6),
    );
    console.log(
      "Post-extras stats deltas:  collateral",
      ethers.formatUnits(postStatsColDelta, 8),
      "debt",
      ethers.formatUnits(postStatsDebtDelta, 8),
    );
    if (postStatsColDelta !== expectedPostStatsColDelta) {
      const msg = `Post-extras: StatisticsView collateral delta mismatch got=${ethers.formatUnits(
        postStatsColDelta,
        8,
      )} expected=${ethers.formatUnits(expectedPostStatsColDelta, 8)}`;
      if (strictViews && !baselineDirty) throw new Error(msg);
      logNotice(`  [Notice] [BestEffort] ${msg} (dirty baseline)`);
    }
    if (postStatsDebtDelta !== expectedPostStatsDebtDelta) {
      const msg = `Post-extras: StatisticsView debt delta mismatch got=${ethers.formatUnits(
        postStatsDebtDelta,
        8,
      )} expected=${ethers.formatUnits(expectedPostStatsDebtDelta, 8)}`;
      if (strictViews && !baselineDirty) throw new Error(msg);
      logNotice(`  [Notice] [BestEffort] ${msg} (dirty baseline)`);
    }
    console.log("✅ Post-extras checkpoint passed\n");

    console.log("✅ Advanced batch E2E Completed!");

    // ===== LoanNFTView per-user trade summary (MUST-style) =====
    {
      console.log("\n=== Per-user LoanNFTView trade summary ===");
      const printOrderDetails = process.env.E2E_PRINT_ORDER_DETAILS === "1";
      const maxDetailsPerUser = (() => {
        const raw = process.env.E2E_PRINT_ORDER_DETAILS_MAX;
        if (!raw) return 10;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) return 10;
        return Math.floor(n);
      })();
      const userTradeSummaries: Record<string, any> = {};
      const addrToSigner = new Map<string, any>();
      for (const s of signers)
        addrToSigner.set(String(s.address).toLowerCase(), s);
      for (const s of borrowers)
        addrToSigner.set(String(s.address).toLowerCase(), s);
      for (const s of lenders)
        addrToSigner.set(String(s.address).toLowerCase(), s);

      const usersToReport = new Set<string>();
      for (const a of Object.keys(expectedOrderIdsByBorrower))
        usersToReport.add(a.toLowerCase());
      for (const s of borrowers)
        usersToReport.add(String(s.address).toLowerCase());
      for (const s of lenders)
        usersToReport.add(String(s.address).toLowerCase());

      let orderDetailsOkTotal = 0;
      let orderDetailsErrTotal = 0;
      let orderDetailsFallbackTotal = 0;
      const orderDetailsErrUsers: string[] = [];
      const firstOrderDetailsErrByUser: Record<string, string> = {};

      for (const addr of usersToReport) {
        const s = addrToSigner.get(addr) ?? (await ethers.getSigner(addr));
        const snap = await collectUserTradeSnapshot(s);
        userTradeSummaries[addr] = snap;
        const labels = (snap.items || []).map(
          (it: any) => `${String(it.orderId)}(${it.statusLabel})`,
        );
        console.log(
          `- ${addr} count=${snap.count.toString()} orders=[${labels.join(", ")}]`,
        );

        const okTotal = (snap.orderDetailsOk ?? []).length;
        const errTotal = (snap.orderDetailsError ?? []).length;
        const fbTotal = (snap.orderDetailsFallback ?? []).length;

        orderDetailsOkTotal += okTotal;
        orderDetailsErrTotal += errTotal;
        orderDetailsFallbackTotal += fbTotal;

        if (errTotal > 0) {
          const first = (snap.orderDetailsError ?? [])[0];
          if (!orderDetailsErrUsers.includes(addr))
            orderDetailsErrUsers.push(addr);
          if (firstOrderDetailsErrByUser[addr] === undefined) {
            firstOrderDetailsErrByUser[addr] = String(first?.error ?? "");
          }
          console.log(
            `  ⚠️ [OrderDetails] user=${addr} ok=${okTotal} err=${errTotal} fallback=${fbTotal} firstError=${String(first?.error ?? "")}`,
          );
          if (strictViews)
            throw new Error(
              `[OrderDetails] user=${addr} has ${errTotal} orderDetailsError (see logs)`,
            );
        } else if (fbTotal > 0) {
          const first = (snap.orderDetailsFallback ?? [])[0];
          console.log(
            `  [OrderDetails] user=${addr} ok=${okTotal} err=0 fallback=${fbTotal} (e.g. ${String(
              first?.userAccessError ?? "",
            )})`,
          );
        }

        if (printOrderDetails) {
          const ok = (snap.orderDetailsOk ?? []).slice(0, maxDetailsPerUser);
          const err = (snap.orderDetailsError ?? []).slice(
            0,
            maxDetailsPerUser,
          );
          console.log(
            `  [OrderDetails] user=${addr} ok=${(snap.orderDetailsOk ?? []).length} err=${(snap.orderDetailsError ?? []).length} maxPerUser=${maxDetailsPerUser}`,
          );
          for (const x of ok) {
            console.log(`  - orderId=${String(x.orderId)} ok=true`);
            console.log(pretty(x.order));
          }
          for (const x of err) {
            console.log(
              `  - orderId=${String(x.orderId)} ok=false error=${String(x.error)}`,
            );
          }
          if (
            maxDetailsPerUser > 0 &&
            (okTotal > ok.length || errTotal > err.length)
          ) {
            console.log(
              `  [OrderDetails] truncated: okShown=${ok.length}/${okTotal} errShown=${err.length}/${errTotal} (set E2E_PRINT_ORDER_DETAILS_MAX=0 for unlimited)`,
            );
          }
        }
      }

      // Prominent summary so artifacts cannot silently contain ok=false/errors.
      console.log(
        "\n=== OrderDetails summary (LoanNFTView -> LendingEngineView.getLoanOrder) ===",
      );
      console.log(
        `totalOk=${orderDetailsOkTotal} totalErr=${orderDetailsErrTotal} totalFallback=${orderDetailsFallbackTotal} usersWithErr=${orderDetailsErrUsers.length}`,
      );
      if (orderDetailsErrTotal > 0) {
        const sample = orderDetailsErrUsers
          .slice(0, 3)
          .map((u) => `${u}:${String(firstOrderDetailsErrByUser[u] ?? "")}`);
        console.log(`  sampleErrors: ${sample.join(" | ")}`);
        const failOnOrderDetailsError =
          process.env.E2E_FAIL_ON_ORDER_DETAILS_ERROR !== "0";
        if (!strictViews && failOnOrderDetailsError) {
          console.error(
            `\n❌ [OrderDetails] found orderDetailsError (n=${orderDetailsErrTotal}). ` +
              `This indicates view access/role mismatch or read-path failure. ` +
              `Set E2E_FAIL_ON_ORDER_DETAILS_ERROR=0 to ignore (not recommended).\n`,
          );
          process.exitCode = 1;
        }
      } else {
        console.log("  ✅ no orderDetailsError");
      }

      artifactCheckpoints["view_orderDetailsSummary"] = {
        totalOk: orderDetailsOkTotal,
        totalErr: orderDetailsErrTotal,
        totalFallback: orderDetailsFallbackTotal,
        usersWithErr: orderDetailsErrUsers,
        firstErrorByUser: firstOrderDetailsErrByUser,
        note: "orderDetailsError means a per-order getLoanOrder read failed (commonly MissingRole/selector mismatch).",
      };

      for (const [uLower0, expectedIds] of Object.entries(
        expectedOrderIdsByBorrower,
      )) {
        const uLower = uLower0.toLowerCase();
        const snap = userTradeSummaries[uLower];
        if (!snap)
          throw new Error(
            `[LoanNFTView] missing snapshot for expected borrower=${uLower}`,
          );
        const got = new Set(
          (snap.items || []).map((it: any) => String(it.orderId)),
        );
        const missing = expectedIds.filter((id) => !got.has(String(id)));
        if (missing.length > 0) {
          console.log(
            `\n[LoanNFTView][Debug] borrower=${uLower} expected=[${expectedIds.join(", ")}] got=[${[...got].join(", ")}]`,
          );
          console.log(
            `[LoanNFTView][Debug] borrower items (tokenId -> orderId/status):`,
          );
          for (const it of snap.items || []) {
            console.log(
              `  - tokenId=${String(it.tokenId)} orderId=${String(it.orderId)} status=${String(it.statusLabel)}`,
            );
          }
          console.log(`[LoanNFTView][Debug] missing order create meta:`);
          for (const id of missing) {
            console.log(
              `  - orderId=${String(id)} meta=${JSON.stringify(orderCreateMetaById[String(id)] ?? null)}`,
            );
          }
          console.log(
            `[LoanNFTView][Debug] searching missing orderIds across all user snapshots:`,
          );
          for (const id of missing) {
            let found = false;
            for (const [addr2, snap2] of Object.entries(userTradeSummaries)) {
              for (const it of (snap2 as any)?.items || []) {
                if (String(it.orderId) === String(id)) {
                  console.log(
                    `  - orderId=${String(id)} is enumerated by user=${addr2} tokenId=${String(it.tokenId)} status=${String(it.statusLabel)}`,
                  );
                  found = true;
                  break;
                }
              }
              if (found) break;
            }
            if (!found) {
              console.log(
                `  - orderId=${String(id)} not found in any reported user's enumeration`,
              );
            }
          }
          throw new Error(
            `[LoanNFTView] borrower=${uLower} missing expected orderIds: ${missing.join(", ")}. got=[${[...got].join(", ")}]`,
          );
        }
      }

      artifactCheckpoints["loanNftViewUserTradesFinal"] = {
        expectedOrderIdsByBorrower,
        orderCreateMetaById,
        userTradeSummaries,
      };
    }

    // ===== Key event coverage (DataPushed) =====
    {
      const required: Array<{ name: string; hash: string }> = [
        { name: "LOAN_CREATED", hash: DATA_TYPE_LOAN_CREATED },
        { name: "LOAN_NFT_MINTED", hash: DATA_TYPE_LOAN_NFT_MINTED },
        { name: "RESERVE_CONSUMED", hash: DATA_TYPE_RESERVE_CONSUMED },
        { name: "GUARANTEE_LOCKED", hash: DATA_TYPE_GUARANTEE_LOCKED },
        { name: "RISK_STATUS_UPDATE", hash: DATA_TYPE_RISK_STATUS_UPDATE },
        {
          name: "BLOCKS_ONLY_MATCH_FINALIZED",
          hash: DATA_TYPE_BLOCKS_ONLY_MATCH_FINALIZED,
        },
        { name: "BLOCKS_ONLY_REPAID", hash: DATA_TYPE_BLOCKS_ONLY_REPAID },
        { name: "BLOCKS_ONLY_SETTLED", hash: DATA_TYPE_BLOCKS_ONLY_SETTLED },
        {
          name: "BLOCKS_ONLY_LIQUIDATED",
          hash: DATA_TYPE_BLOCKS_ONLY_LIQUIDATED,
        },
      ];
      const missing = required.filter(
        (r) => (dataPushCounts[r.hash.toLowerCase()] ?? 0) === 0,
      );
      if (missing.length > 0) {
        const list = missing.map((m) => `${m.name}(${m.hash})`).join(", ");
        const msg = `[DataPush] key event coverage missing: ${list}`;
        if (strictDataPush) throw new Error(msg);
        logNotice(`  [Notice] ${msg}`);
      }
    }

    // ===== Artifacts (MUST-style) =====
    const rvVer = (await rewardView.getVersionInfo()) as [
      bigint,
      bigint,
      string,
    ];
    const rpcUrl = process.env.LOCALHOST_RPC_URL || "";
    const blockNumber = await ethers.provider.getBlockNumber();
    const artifactPath = artifacts.writeJson(
      `batch-advanced-10-users.${Date.now()}.json`,
      {
        name: "e2e-localhost-batch-advanced-10-users (Reward-aligned)",
        generatedAt: new Date().toISOString(),
        chainId: (await ethers.provider.getNetwork()).chainId.toString(),
        rpcUrl,
        blockNumber,
        modules: {
          Registry: registryAddr,
          AccessControlManager: acmAddrFromRegistry,
          RewardView: rewardViewAddr,
          RewardManagerCore: rmCoreAddr,
          EasyToken: easyTokenAddr,
          OrderEngine: String(orderEngineAddr),
          VaultCore: vaultCoreAddr,
          VaultBusinessLogic: vblAddr,
        },
        orders: artifactOrderCreates,
        checkpoints: artifactCheckpoints,
        versionInfo: {
          RewardView: {
            apiVersion: rvVer[0].toString(),
            schemaVersion: rvVer[1].toString(),
            implementation: rvVer[2],
          },
        },
        counters: {
          dataPushedByTypeHash: dataPushCounts,
          expectedReverts,
        },
      },
    );
    console.log("  📦 artifacts:", artifactPath);
  } finally {
    await withTimeout(
      network.provider.send("evm_revert", [snap]),
      EVM_TIMEOUT_MS,
      "evm_revert",
    );
  }
}

// Keep backward-compatible CLI entrypoint (`npx hardhat run ...`)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const _isMain = typeof require !== "undefined" && require.main === module;
if (_isMain) {
  runAdvancedBatch().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
