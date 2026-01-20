import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";
import { scanViewModules } from "./utils/view-scan";

const ONE_DAY = 24n * 60n * 60n;
const BPS_DENOM = 10_000n;

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

// ===== DataPush (SSOT observability) =====
// NOTE: Some deployments may have DataPushed with or without `indexed` dataTypeHash.
// We parse logs by topic0 and decode accordingly (robust across both shapes).
const coder = ethers.AbiCoder.defaultAbiCoder();
const DATA_PUSH_TOPIC0 = ethers.keccak256(ethers.toUtf8Bytes("DataPushed(bytes32,bytes)")).toLowerCase();

const DATA_TYPE_REPAY_AND_SETTLE = ethers.keccak256(ethers.toUtf8Bytes("REPAY_AND_SETTLE"));
const DATA_TYPE_COLLATERAL_RELEASED = ethers.keccak256(ethers.toUtf8Bytes("COLLATERAL_RELEASED"));
const DATA_TYPE_LIQUIDATION_UPDATE = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATION_UPDATE"));
const DATA_TYPE_LIQUIDATION_BATCH_UPDATE = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATION_BATCH_UPDATE"));
const DATA_TYPE_LIQUIDATION_PAYOUT = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATION_PAYOUT"));
const asBigInt = (x: any): bigint => (typeof x === "bigint" ? x : BigInt(x));

function calcTotalDue(principal: bigint, rateBps: bigint, termSec: bigint) {
  const denom = 365n * ONE_DAY * 10_000n;
  const interest = (principal * rateBps * termSec) / denom;
  return principal + interest;
}

function calcFee(amount: bigint, bps: bigint) {
  return (amount * bps) / BPS_DENOM;
}

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

function assertHasDataPushType(label: string, receipt: any, typeHash: string) {
  const pushes = extractDataPushed(receipt);
  const want = typeHash.toLowerCase();
  if (!pushes.some((p) => p.dataTypeHash === want)) {
    throw new Error(`${label}: missing DataPushed(${want})`);
  }
}

function assertRepayAndSettleDataPush(
  label: string,
  receipt: any,
  settlementManager: any,
  expectUser: string,
  expectDebtAsset: string,
  expectRepayAmount: bigint,
  expectOrderId: bigint,
  expectReleasedAllCollateral: boolean
) {
  const pushes = extractDataPushed(receipt);
  const want = DATA_TYPE_REPAY_AND_SETTLE.toLowerCase();
  const p = pushes.find((x) => x.dataTypeHash === want);
  if (!p) {
    const logs = receipt?.logs || [];
    const hasAnyDataPush = (logs as any[]).some((l) => ((l.topics?.[0] || "") as string).toLowerCase() === DATA_PUSH_TOPIC0);
    const hasRepayEvt = (logs as any[]).some((log) => {
      try {
        const parsed = settlementManager.interface.parseLog({ topics: log.topics as string[], data: log.data });
        return parsed?.name === "RepayAndSettleProcessed";
      } catch {
        return false;
      }
    });
    throw new Error(
      `${label}: missing DataPushed(REPAY_AND_SETTLE). ` +
        `Debug: hasAnyDataPushTopic0=${hasAnyDataPush} hasSettlementManager.RepayAndSettleProcessed=${hasRepayEvt}. ` +
        `If false/false, your localhost deployment is likely outdated; restart node and re-run deploylocal.ts.`
    );
  }

  const decoded = coder.decode(
    ["address", "address", "uint256", "uint256", "bool", "uint256"],
    p.payload
  ) as unknown as [string, string, bigint, bigint, boolean, bigint];

  const [user, debtAsset, repayAmount, orderId, releasedAllCollateral] = decoded;
  if (user.toLowerCase() !== expectUser.toLowerCase()) throw new Error(`${label}: REPAY_AND_SETTLE user mismatch`);
  if (debtAsset.toLowerCase() !== expectDebtAsset.toLowerCase()) throw new Error(`${label}: REPAY_AND_SETTLE debtAsset mismatch`);
  if (asBigInt(repayAmount) !== expectRepayAmount) throw new Error(`${label}: REPAY_AND_SETTLE repayAmount mismatch`);
  if (asBigInt(orderId) !== expectOrderId) throw new Error(`${label}: REPAY_AND_SETTLE orderId mismatch`);
  if (releasedAllCollateral !== expectReleasedAllCollateral) {
    throw new Error(`${label}: REPAY_AND_SETTLE releasedAllCollateral mismatch`);
  }
}

function assertCollateralReleasedDataPush(label: string, receipt: any, expectUser: string, expectAsset?: string) {
  const pushes = extractDataPushed(receipt);
  const want = DATA_TYPE_COLLATERAL_RELEASED.toLowerCase();
  const matches = pushes.filter((x) => x.dataTypeHash === want);
  if (matches.length === 0) throw new Error(`${label}: missing DataPushed(COLLATERAL_RELEASED)`);
  // At least one payload must match user (+ optional asset)
  const ok = matches.some((m) => {
    const [user, asset] = coder.decode(["address", "address", "uint256", "uint256"], m.payload) as unknown as [
      string,
      string,
      bigint,
      bigint
    ];
    if (user.toLowerCase() !== expectUser.toLowerCase()) return false;
    if (expectAsset && asset.toLowerCase() !== expectAsset.toLowerCase()) return false;
    return true;
  });
  if (!ok) throw new Error(`${label}: COLLATERAL_RELEASED payload does not match expected user/asset`);
}

function assertLiquidationDataPush(label: string, receipt: any, expectUser: string) {
  const pushes = extractDataPushed(receipt);
  const u = expectUser.toLowerCase();
  const types = new Set([
    DATA_TYPE_LIQUIDATION_UPDATE.toLowerCase(),
    DATA_TYPE_LIQUIDATION_BATCH_UPDATE.toLowerCase(),
    DATA_TYPE_LIQUIDATION_PAYOUT.toLowerCase(),
  ]);
  const relevant = pushes.filter((p) => types.has(p.dataTypeHash));
  if (relevant.length === 0) throw new Error(`${label}: missing liquidation DataPushed(LIQUIDATION_*)`);

  // Strong: ensure at least one liquidation push includes the expected user.
  const ok = relevant.some((p) => {
    try {
      if (p.dataTypeHash === DATA_TYPE_LIQUIDATION_UPDATE.toLowerCase()) {
        const [user] = coder.decode(
          ["address", "address", "address", "uint256", "uint256", "address", "uint256", "uint256"],
          p.payload
        ) as unknown as [string, string, string, bigint, bigint, string, bigint, bigint];
        return user.toLowerCase() === u;
      }
      if (p.dataTypeHash === DATA_TYPE_LIQUIDATION_PAYOUT.toLowerCase()) {
        const [user] = coder.decode(
          ["address", "address", "address", "address", "address", "address", "uint256", "uint256", "uint256", "uint256", "uint256"],
          p.payload
        ) as unknown as [string, string, string, string, string, string, bigint, bigint, bigint, bigint, bigint];
        return user.toLowerCase() === u;
      }
      if (p.dataTypeHash === DATA_TYPE_LIQUIDATION_BATCH_UPDATE.toLowerCase()) {
        const [users] = coder.decode(
          ["address[]", "address[]", "address[]", "uint256[]", "uint256[]", "address", "uint256[]", "uint256"],
          p.payload
        ) as unknown as [string[], string[], string[], bigint[], bigint[], string, bigint[], bigint];
        return (users || []).some((x) => x.toLowerCase() === u);
      }
      return false;
    } catch {
      return false;
    }
  });
  if (!ok) throw new Error(`${label}: liquidation DataPushed payload did not include expected user`);
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

async function evmIncreaseTime(seconds: bigint) {
  await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
  await ethers.provider.send("evm_mine", []);
}

async function impersonateAndFund(addr: string) {
  // Hardhat-only helper: used in E2E to simulate VaultCore-only module calls.
  await ethers.provider.send("hardhat_impersonateAccount", [addr]);
  // Give the impersonated account enough ETH for tx gas.
  await ethers.provider.send("hardhat_setBalance", [addr, "0x3635C9ADC5DEA00000"]); // 1000 ETH
  return await ethers.getSigner(addr);
}

async function stopImpersonating(addr: string) {
  try {
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [addr]);
  } catch {
    // best-effort
  }
}

export async function runAdvancedBatch(opts?: { sampleBorrowerIndex?: number }) {
  const signers = await ethers.getSigners();
  if (signers.length < 11) throw new Error(`Need at least 11 signers (have ${signers.length})`);

  const deployer = signers[0];
  // Default to strict mode: warnings become errors
  const strictViews = process.env.E2E_STRICT_VIEWS !== "0";
  const allowDirtyState = process.env.E2E_ALLOW_DIRTY_STATE === "1";

  // 10 users → 5 borrowers + 5 lenders
  const borrowers = [signers[1], signers[3], signers[5], signers[7], signers[9]];
  const lenders = [signers[2], signers[4], signers[6], signers[8], signers[10]];

  console.log("=== E2E Advanced Batch (10 users / 5 borrowers + 5 lenders) ===\n");
  console.log("Scenarios:");
  console.log("- Pair1: on-time full repay");
  console.log("- Pair2: partial repay then full repay (on-time)");
  console.log("- Pair3: on-time full repay");
  console.log("- Pair4: multi-lender split via 2 orders (2 lenders, 250 + 250)");
  console.log("- Pair5: overdue full repay (time travel)\n");

  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
  const aw = (await ethers.getContractAt("AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", CONTRACT_ADDRESSES.PriceOracle)) as any;
  const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", CONTRACT_ADDRESSES.FeeRouter)) as any;
  const usdc = (await ethers.getContractAt("MockERC20", CONTRACT_ADDRESSES.MockUSDC)) as any;
  // Always derive core module addresses from Registry to avoid stale frontend-config.
  const vaultCoreAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;
  const vblAddr = (await registry.getModuleOrRevert(key("VAULT_BUSINESS_LOGIC"))) as string;
  const cmAddr = (await registry.getModuleOrRevert(key("COLLATERAL_MANAGER"))) as string;
  const vaultCore = (await ethers.getContractAt("VaultCore", vaultCoreAddr)) as any;
  const vbl = (await ethers.getContractAt("VaultBusinessLogic", vblAddr)) as any;
  const cm = (await ethers.getContractAt("CollateralManager", cmAddr)) as any;
  const vle = await ethers.getContractAt(
    "src/Vault/modules/VaultLendingEngine.sol:VaultLendingEngine",
    CONTRACT_ADDRESSES.VaultLendingEngine
  );

  const orderEngineAddr = await registry.getModuleOrRevert(key("ORDER_ENGINE"));
  const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;

  const settlementManagerAddr = (await registry.getModuleOrRevert(key("SETTLEMENT_MANAGER"))) as string;
  const settlementManager = (await ethers.getContractAt("SettlementManager", settlementManagerAddr)) as any;
  // This script includes a partial repay scenario (Pair2). If strict full-repay auto-release is enabled,
  // SettlementManager will revert partial repays with SettlementManager__DebtNotCleared.
  const requireFullRepayRelease = (await settlementManager.requireFullRepayRelease()) as boolean;
  if (requireFullRepayRelease) {
    console.log(
      "  ⚠️  SettlementManager.requireFullRepayRelease=true; disabling for this run to allow partial repay scenario (Pair2)."
    );
    await (await settlementManager.connect(deployer).setRequireFullRepayRelease(false)).wait();
  }

  const positionViewAddr = await registry.getModuleOrRevert(key("POSITION_VIEW"));
  const userViewAddr = await registry.getModuleOrRevert(key("USER_VIEW"));
  const riskViewAddr = await registry.getModuleOrRevert(key("RISK_VIEW"));
  const statisticsViewAddr = await registry.getModuleOrRevert(key("STATISTICS_VIEW"));

  const positionView = (await ethers.getContractAt("PositionView", positionViewAddr)) as any;
  const userView = (await ethers.getContractAt("UserView", userViewAddr)) as any;
  const riskView = (await ethers.getContractAt("RiskView", riskViewAddr)) as any;
  const statisticsView = (await ethers.getContractAt("StatisticsView", statisticsViewAddr)) as any;

  const assetAddr = usdc.target as string;
  const toBigInt = (x: any): bigint => (typeof x === "bigint" ? x : BigInt(x));

  // EarlyRepaymentGuaranteeManager + GuaranteeFundManager (SSOT: resolved from Registry).
  const ergmAddr = (await registry.getModuleOrRevert(key("EARLY_REPAYMENT_GUARANTEE_MANAGER"))) as string;
  const gfmAddr = (await registry.getModuleOrRevert(key("GUARANTEE_FUND_MANAGER"))) as string;
  const ergm = (await ethers.getContractAt(
    "src/Vault/modules/EarlyRepaymentGuaranteeManager.sol:EarlyRepaymentGuaranteeManager",
    ergmAddr
  )) as any;
  const gfm = (await ethers.getContractAt(
    "src/Vault/modules/GuaranteeFundManager.sol:GuaranteeFundManager",
    gfmAddr
  )) as any;
  const lenderPoolAddr = (await registry.getModuleOrRevert(key("LENDER_POOL_VAULT"))) as string;

  // FeeRouter recipients + fee rates (SSOT: always derive from FeeRouter config).
  const platformTreasury = (await feeRouter.getPlatformTreasury()) as string;
  const ecosystemVault = (await feeRouter.getEcosystemVault()) as string;
  const platformFeeBps = toBigInt(await feeRouter.getPlatformFeeBps());
  const ecoFeeBps = toBigInt(await feeRouter.getEcosystemFeeBps());

  // ============ ViewScan (broader view coverage) ============
  await scanViewModules(CONTRACT_ADDRESSES.Registry, {
    assetAddr,
    sampleUser: borrowers[0].address,
    strict: strictViews,
  });

  // ============ Reward (Architecture-Guide) ============
  const rewardView = (await ethers.getContractAt("RewardView", CONTRACT_ADDRESSES.RewardView)) as any;
  const rewardPoints = (await ethers.getContractAt(
    "src/Token/RewardPoints.sol:RewardPoints",
    CONTRACT_ADDRESSES.RewardPoints
  )) as any;
  const rewardDecimals = (await rewardPoints.decimals()) as number;
  const ONE_POINT = 10n ** BigInt(rewardDecimals);
  const fmtPoints = (x: bigint) => ethers.formatUnits(x, rewardDecimals);
  // Reward eligibility (SSOT in RewardManagerCore): principal must be >= 1000 USDC (6 decimals)
  const MIN_ELIGIBLE_PRINCIPAL = 1_000n * 1_000_000n;

  // ============ C baseline: unified version introspection ============
  async function logViewVersionInfo(label: string, view: any, expectSchema?: bigint) {
    const [apiVersion, schemaVersion, implementation] = await view.getVersionInfo();
    console.log(
      `  [VersionInfo] ${label}: api=${apiVersion.toString()} schema=${schemaVersion.toString()} implementation=${implementation}`
    );
    if (expectSchema !== undefined && schemaVersion !== expectSchema) {
      throw new Error(`[VersionInfo] ${label}: unexpected schemaVersion=${schemaVersion.toString()} expect=${expectSchema.toString()}`);
    }
  }
  await logViewVersionInfo("PositionView", positionView, 2n);
  await logViewVersionInfo("UserView", userView, 1n);
  await logViewVersionInfo("RiskView", riskView, 1n);
  await logViewVersionInfo("StatisticsView", statisticsView, 1n);

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
    if (!Number.isInteger(n)) throw new Error(`Invalid sample borrower index: ${raw}`);
    return n;
  }

  const sampleBorrowerIndex = opts?.sampleBorrowerIndex ?? parseSampleBorrowerIndexFromEnv();
  if (sampleBorrowerIndex < 0 || sampleBorrowerIndex >= borrowers.length) {
    throw new Error(
      `sampleBorrowerIndex out of range: ${sampleBorrowerIndex}. Must be in [0, ${borrowers.length - 1}]`
    );
  }
  const sampleBorrower = borrowers[sampleBorrowerIndex];
  async function logPositionViewVersion(step: string) {
    const v = await positionView.getPositionVersion(sampleBorrower.address, assetAddr);
    const [pvCol, pvDebt] = await positionView.getUserPosition(sampleBorrower.address, assetAddr);
    console.log(
      `  [PositionView] ${step}: sampleBorrowerIndex=${sampleBorrowerIndex} borrower=${sampleBorrower.address} version=${v.toString()} col=${ethers.formatUnits(
        pvCol,
        6
      )} debt=${ethers.formatUnits(pvDebt, 6)}`
    );
  }

  // ============ Roles ============
  const ensureRole = async (roleName: string, who: string | any) => {
    const whoAddr = await ethers.resolveAddress(who);
    const role = key(roleName);
    if (!(await acm.hasRole(role, whoAddr))) {
      await (await acm.grantRole(role, whoAddr)).wait();
    }
  };

  // config/admin
  await ensureRole("ADD_WHITELIST", deployer.address);
  await ensureRole("UPDATE_PRICE", deployer.address);
  await ensureRole("SET_PARAMETER", deployer.address);
  // strict mode helpers (PositionView.retryUserPositionUpdate, upgrades, etc.)
  await ensureRole("ACTION_ADMIN", deployer.address);

  // match orchestration
  await ensureRole("ORDER_CREATE", vblAddr);
  await ensureRole("DEPOSIT", vblAddr);

  // order engine
  await ensureRole("BORROW", orderEngineAddr);

  // repay SSOT: SettlementManager calls ORDER_ENGINE.repay + ORDER_ENGINE._getLoanOrderForView
  await ensureRole("REPAY", settlementManagerAddr);
  await ensureRole("VIEW_SYSTEM_DATA", settlementManagerAddr);

  // StatisticsView push is performed by VaultBusinessLogic and VaultRouter (best-effort in library/router),
  // so grant them VIEW_SYSTEM_DATA to make stats strict-checkable in E2E.
  const vaultRouterAddr = (await vaultCore.viewContractAddrVar()) as string;
  // PositionView delta/full pushes require ACTION_VIEW_PUSH on the caller (VaultRouter).
  await ensureRole("ACTION_VIEW_PUSH", vaultRouterAddr);
  await ensureRole("VIEW_SYSTEM_DATA", vblAddr);
  await ensureRole("VIEW_SYSTEM_DATA", vaultRouterAddr);

  // keeper liquidation SSOT entry
  await ensureRole("LIQUIDATE", deployer.address);

  // ============ Asset/price setup ============
  if (!(await aw.isAssetAllowed(assetAddr))) {
    await (await aw.connect(deployer).addAllowedAsset(assetAddr)).wait();
  }
  {
    const cfg = await po.getAssetConfig(assetAddr);
    if (!cfg.isActive) {
      await (await po.connect(deployer).configureAsset(assetAddr, "usd-coin", 8, 3600)).wait();
    }
  }
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  await (await po.connect(deployer).updatePrice(assetAddr, ethers.parseUnits("1", 6), now)).wait();

  if (!(await feeRouter.isTokenSupported(assetAddr))) {
    await (await feeRouter.connect(deployer).addSupportedToken(assetAddr)).wait();
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
    const currentlyEnabled = (await ergm.isGuaranteeEnabled(assetAddr)) as boolean;
    if (currentlyEnabled) {
      await (await ergm.connect(deployer).setGuaranteeEnabled(assetAddr, false)).wait();
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
    console.log(`  ⚠️ ${msg}`);
  }

  // ============ Helpers: per-step assertions ============
  async function assertViews(step: string, user: string, asset: string, expectedCollateral?: bigint, expectedDebt?: bigint) {
    const ledgerCol = await cm.getCollateral(user, asset);
    const ledgerDebt = await vle.getDebt(user, asset);

    // View consistency is best-effort (push-based); some localhost deployments may not wire pushes.
    // Ledger (CollateralManager + VaultLendingEngine) is authoritative.
    let pvCol: bigint | null = null;
    let pvDebt: bigint | null = null;
    try {
      [pvCol, pvDebt] = await positionView.getUserPosition(user, asset);
    } catch (e: any) {
      const msg = `${step}: [BestEffort] PositionView query failed for ${user}: ${e?.message || e}`;
      if (strictViews) throw new Error(msg);
      console.log(`  ⚠️ ${msg}`);
    }
    if (pvCol !== null && pvDebt !== null && (pvCol !== ledgerCol || pvDebt !== ledgerDebt)) {
      const msg = `${step}: [BestEffort] PositionView != ledger for ${user}. ledger(col=${ledgerCol},debt=${ledgerDebt}) pv(col=${pvCol},debt=${pvDebt})`;
      if (strictViews) throw new Error(msg);
      console.log(`  ⚠️ ${msg}`);
    }

    let uvCol: bigint | null = null;
    let uvDebt: bigint | null = null;
    try {
      [uvCol, uvDebt] = await userView.getUserPosition(user, asset);
    } catch (e: any) {
      const msg = `${step}: [BestEffort] UserView query failed for ${user}: ${e?.message || e}`;
      if (strictViews) throw new Error(msg);
      console.log(`  ⚠️ ${msg}`);
    }
    if (uvCol !== null && uvDebt !== null && (uvCol !== ledgerCol || uvDebt !== ledgerDebt)) {
      const msg = `${step}: [BestEffort] UserView != ledger for ${user}. ledger(col=${ledgerCol},debt=${ledgerDebt}) uv(col=${uvCol},debt=${uvDebt})`;
      if (strictViews) throw new Error(msg);
      console.log(`  ⚠️ ${msg}`);
    }

    if (expectedCollateral !== undefined && ledgerCol !== expectedCollateral) {
      throw new Error(`${step}: unexpected collateral for ${user}. expected=${expectedCollateral} actual=${ledgerCol}`);
    }
    if (expectedDebt !== undefined && ledgerDebt !== expectedDebt) {
      throw new Error(`${step}: unexpected debt for ${user}. expected=${expectedDebt} actual=${ledgerDebt}`);
    }

    // RiskView: best-effort; ensure callable when wired.
    try {
      const ra = await riskView.getUserRiskAssessment(user);
      ra.healthFactor; // touch
    } catch (e: any) {
      const msg = `${step}: [BestEffort] RiskView query failed for ${user}: ${e?.message || e}`;
      if (strictViews) throw new Error(msg);
      console.log(`  ⚠️ ${msg}`);
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
  // Reward: print points in human-readable units (RewardPoints.decimals()) and assert delta == 1 point per successful loan cycle.
  const collateralAmt = ethers.parseUnits("1000", 6);
  const principal = ethers.parseUnits("500", 6);
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
    await (await usdc.connect(deployer).transfer(b.address, ethers.parseUnits("20000", 6))).wait();
  }
  for (const l of lenders) {
    await (await usdc.connect(deployer).transfer(l.address, ethers.parseUnits("20000", 6))).wait();
  }

  // ============ Baseline (delta-based checkpoints) ============
  const baselineTotals = await snapshotBorrowersTotals(assetAddr);
  const baselineStats = await statisticsView.getGlobalStatistics();
  const baselineDirty = baselineTotals.colSum !== 0n || baselineTotals.debtSum !== 0n;
  if (strictViews && !allowDirtyState && baselineDirty) {
    console.log(
      `  ⚠️ Strict E2E prefers a clean state, but baseline ledger is non-zero: ` +
        `col=${ethers.formatUnits(baselineTotals.colSum, 6)} debt=${ethers.formatUnits(baselineTotals.debtSum, 6)}. ` +
        `Continuing in delta-based mode. For a clean run, restart localhost node + re-run deploylocal.ts, ` +
        `or set E2E_ALLOW_DIRTY_STATE=1 to silence this warning.`
    );
  }

  console.log("\n=== Baseline ===");
  console.log("Borrowers ledger sum collateral:", ethers.formatUnits(baselineTotals.colSum, 6));
  console.log("Borrowers ledger sum debt:", ethers.formatUnits(baselineTotals.debtSum, 6));
  console.log("StatisticsView totalCollateral:", ethers.formatUnits(baselineStats.totalCollateral, 6));
  console.log("StatisticsView totalDebt:", ethers.formatUnits(baselineStats.totalDebt, 6));
  await logPositionViewVersion("baseline");

  // Reward baseline snapshot (reward-qualifying borrower = borrower#1 / Pair1)
  const rewardBorrower = borrowers[0];
  const rewardBalBefore = (await rewardPoints.balanceOf(rewardBorrower.address)) as bigint;
  const rewardSummaryBefore = await rewardView.connect(deployer).getUserRewardSummary(rewardBorrower.address);
  console.log(
    `  [Reward] baseline: borrower=${rewardBorrower.address} pointsBalance=${fmtPoints(rewardBalBefore)} (raw=${rewardBalBefore.toString()}) totalEarned=${fmtPoints(
      rewardSummaryBefore[0]
    )} (raw=${rewardSummaryBefore[0].toString()}) totalBurned=${fmtPoints(rewardSummaryBefore[1])} pendingPenalty=${fmtPoints(
      rewardSummaryBefore[2]
    )}`
  );

  // Track expected per-borrower absolute state relative to current chain (do not assume fresh chain)
  const expectedCollateralByBorrower = new Map<string, bigint>();
  const expectedDebtByBorrower = new Map<string, bigint>();
  for (const b of borrowers) {
    expectedCollateralByBorrower.set(b.address, await cm.getCollateral(b.address, assetAddr));
    expectedDebtByBorrower.set(b.address, await vle.getDebt(b.address, assetAddr));
  }

  // ============ Step 1: Deposits (all borrowers) ============
  console.log("\n=== Step 1: Deposits (all borrowers) ===");
  for (let i = 0; i < borrowers.length; i++) {
    const borrower = borrowers[i];
    const pvVerBefore = await positionView.getPositionVersion(borrower.address, assetAddr);
    // Funds-flow SSOT: Collateral is pulled by CollateralManager (spender MUST be CM).
    await (await usdc.connect(borrower).approve(cmAddr, collateralAmt)).wait();
    const depRc = await (await vaultCore.connect(borrower).deposit(assetAddr, collateralAmt)).wait();

    // Strict diagnostics: surface silent view-push failures immediately.
    if (strictViews) {
      const pvVerAfter = await positionView.getPositionVersion(borrower.address, assetAddr);
      const failedPushes = (depRc?.logs || [])
        .map((log: any) => {
          try {
            return cm.interface.parseLog({ topics: log.topics as string[], data: log.data });
          } catch {
            return null;
          }
        })
        .filter((e: any) => e && e.name === "ViewCachePushFailed");

      if (failedPushes.length > 0) {
        const e: any = failedPushes[0];
        const reason = (e.args?.reason as string) || "0x";
        throw new Error(
          `Deposit view-cache push failed for borrower#${i + 1} (${borrower.address}). reason=${reason}`
        );
      }

      if (pvVerAfter === pvVerBefore) {
        throw new Error(
          `Deposit did not advance PositionView version for borrower#${i + 1} (${borrower.address}). ` +
            `verBefore=${pvVerBefore.toString()} verAfter=${pvVerAfter.toString()}`
        );
      }
    }
    expectedCollateralByBorrower.set(
      borrower.address,
      (expectedCollateralByBorrower.get(borrower.address) || 0n) + collateralAmt
    );
    await assertViews(
      `After deposit borrower#${i + 1}`,
      borrower.address,
      assetAddr,
      expectedCollateralByBorrower.get(borrower.address),
      expectedDebtByBorrower.get(borrower.address)
    );
    console.log(`  ✅ borrower#${i + 1} deposited ${ethers.formatUnits(collateralAmt, 6)}`);
  }
  await logPositionViewVersion("after deposits");

  // ============ Step 2: Create orders via matchflow ============
  console.log("\n=== Step 2: Matchflow finalize (create orders) ===");

  type OrderRef = { borrower: string; orderId: bigint; principal: bigint };
  const orders: OrderRef[] = [];

  async function finalizeOne(
    borrowerSigner: any,
    lenderSigner: any,
    amount: bigint,
    saltSuffix: string,
    opts?: { withGuarantee?: boolean }
  ): Promise<bigint> {
    const expireAt = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);

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

    await (await usdc.connect(lenderSigner).approve(vblAddr, amount)).wait();
    const lendHash = buildLendIntentHash(lendIntent);
    await (await vbl.connect(lenderSigner).reserveForLending(lenderSigner.address, assetAddr, amount, lendHash)).wait();

    const sigBorrower = await borrowerSigner.signTypedData(domain, typesBorrow as any, borrowIntent as any);
    const sigLender = await lenderSigner.signTypedData(domain, typesLend as any, lendIntent as any);

    const withGuarantee = opts?.withGuarantee === true;

    // Extension Flow (docs/Usage-Guide/Funds-Flow-Architecture-Guide.md §5):
    // If guarantee is enabled, VaultBusinessLogic.finalizeMatch should
    // - pull promisedInterest from borrower into GuaranteeFundManager (custody SSOT)
    // - write a guarantee record into ERGM (semantic SSOT)
    //
    // IMPORTANT: this requires borrower approving GFM for promisedInterest (transferFrom).
    const promisedInterest = calcTotalDue(amount, rateBps, termSec) - amount;
    const gfmLockedBefore = withGuarantee ? ((await gfm.getLockedGuarantee(borrowerSigner.address, assetAddr)) as bigint) : 0n;
    const hadGuaranteeBefore = withGuarantee ? ((await ergm.hasActiveGuarantee(borrowerSigner.address, assetAddr)) as boolean) : false;
    if (withGuarantee) {
      if (hadGuaranteeBefore) {
        throw new Error(
          `finalizeMatch(${saltSuffix}): borrower already has an active guarantee for this asset; ` +
            `extension flow currently supports only 1 active guarantee per (user, asset).`
        );
      }
      if (promisedInterest > 0n) {
        await (await usdc.connect(borrowerSigner).approve(gfmAddr, promisedInterest)).wait();
      }
    }

    // Fee flow assertions (SSOT):
    // - borrower receives "net" = amount - platformFee - ecosystemFee
    // - platformTreasury/ecosystemVault receive the fee amounts
    const borrowerBalBefore = (await usdc.balanceOf(borrowerSigner.address)) as bigint;
    const treasuryBalBefore = (await usdc.balanceOf(platformTreasury)) as bigint;
    const ecoBalBefore = (await usdc.balanceOf(ecosystemVault)) as bigint;

    const tx = await vbl.connect(deployer).finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [sigLender]);
    const receipt = await tx.wait();

    let orderId: bigint | null = null;
    for (const log of receipt!.logs) {
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
    if (orderId === null) throw new Error(`LoanOrderCreated not found (${saltSuffix})`);

    // Extension Flow assertions:
    if (withGuarantee) {
      const gfmLockedAfter = (await gfm.getLockedGuarantee(borrowerSigner.address, assetAddr)) as bigint;
      if (gfmLockedAfter - gfmLockedBefore !== promisedInterest) {
        throw new Error(
          `finalizeMatch(${saltSuffix}): guarantee custody mismatch. lockedDelta=${ethers.formatUnits(
            gfmLockedAfter - gfmLockedBefore,
            6
          )} expected=${ethers.formatUnits(promisedInterest, 6)}`
        );
      }
      const gid = (await ergm.getUserGuaranteeId(borrowerSigner.address, assetAddr)) as bigint;
      if (gid === 0n) throw new Error(`finalizeMatch(${saltSuffix}): ERGM guaranteeId not set`);
      const rec = await ergm.getGuaranteeRecord(gid);
      if ((rec.asset as string).toLowerCase() !== assetAddr.toLowerCase()) throw new Error(`finalizeMatch(${saltSuffix}): ERGM record asset mismatch`);
      // NOTE: current implementation records lender as LenderPoolVault (not the lender EOA).
      if ((rec.lender as string).toLowerCase() !== lenderPoolAddr.toLowerCase()) throw new Error(`finalizeMatch(${saltSuffix}): ERGM record lender(pool) mismatch`);
      if (toBigInt(rec.principal) !== amount) throw new Error(`finalizeMatch(${saltSuffix}): ERGM record principal mismatch`);
      if (toBigInt(rec.promisedInterest) !== promisedInterest) throw new Error(`finalizeMatch(${saltSuffix}): ERGM record promisedInterest mismatch`);
      if (!(await ergm.hasActiveGuarantee(borrowerSigner.address, assetAddr))) {
        throw new Error(`finalizeMatch(${saltSuffix}): ERGM expected active guarantee`);
      }
    }

    const expectedPlatformFee = calcFee(amount, platformFeeBps);
    const expectedEcoFee = calcFee(amount, ecoFeeBps);
    const expectedNet = amount - expectedPlatformFee - expectedEcoFee;
    // If guarantee is enabled for this finalizeMatch, borrower also pays promisedInterest into GFM custody.
    const expectedBorrowerDelta = expectedNet - (withGuarantee ? promisedInterest : 0n);

    const borrowerBalAfter = (await usdc.balanceOf(borrowerSigner.address)) as bigint;
    const treasuryBalAfter = (await usdc.balanceOf(platformTreasury)) as bigint;
    const ecoBalAfter = (await usdc.balanceOf(ecosystemVault)) as bigint;

    const borrowerDelta = borrowerBalAfter - borrowerBalBefore;
    if (borrowerDelta !== expectedBorrowerDelta) {
      throw new Error(
        `finalizeMatch(${saltSuffix}): borrower net mismatch got=${ethers.formatUnits(borrowerDelta, 6)} expected=${ethers.formatUnits(
          expectedBorrowerDelta,
          6
        )}`
      );
    }

    if (platformTreasury.toLowerCase() === ecosystemVault.toLowerCase()) {
      const feeDelta = treasuryBalAfter - treasuryBalBefore;
      const expectedFee = expectedPlatformFee + expectedEcoFee;
      if (feeDelta !== expectedFee) {
        throw new Error(
          `finalizeMatch(${saltSuffix}): treasury==ecoVault fee mismatch got=${ethers.formatUnits(
            feeDelta,
            6
          )} expected=${ethers.formatUnits(expectedFee, 6)}`
        );
      }
    } else {
      const platformDelta = treasuryBalAfter - treasuryBalBefore;
      const ecoDelta = ecoBalAfter - ecoBalBefore;
      if (platformDelta !== expectedPlatformFee) {
        throw new Error(`finalizeMatch(${saltSuffix}): platform fee mismatch`);
      }
      if (ecoDelta !== expectedEcoFee) {
        throw new Error(`finalizeMatch(${saltSuffix}): ecosystem fee mismatch`);
      }
    }

    // update expected debt
    expectedDebtByBorrower.set(
      borrowerSigner.address,
      (expectedDebtByBorrower.get(borrowerSigner.address) || 0n) + amount
    );

    await assertViews(
      `After finalizeMatch(${saltSuffix})`,
      borrowerSigner.address,
      assetAddr,
      expectedCollateralByBorrower.get(borrowerSigner.address),
      expectedDebtByBorrower.get(borrowerSigner.address)
    );

    return orderId;
  }

  // Pair1: borrower1 + lender1 (single 500)
  orders.push({ borrower: borrowers[0].address, orderId: await finalizeOne(borrowers[0], lenders[0], principal, "p1"), principal });
  console.log("  ✅ Pair1 order created");

  // Pair2: borrower2 + lender2 (single 500) — will do partial repay
  orders.push({ borrower: borrowers[1].address, orderId: await finalizeOne(borrowers[1], lenders[1], principal, "p2"), principal });
  console.log("  ✅ Pair2 order created (will partial repay)");

  // Pair3: borrower3 + lender3 (single 500)
  orders.push({ borrower: borrowers[2].address, orderId: await finalizeOne(borrowers[2], lenders[2], principal, "p3"), principal });
  console.log("  ✅ Pair3 order created");

  // Pair4: borrower4 split: two orders 250+250 with two lenders
  const half = principal / 2n;
  orders.push({
    borrower: borrowers[3].address,
    orderId: await finalizeOne(borrowers[3], lenders[3], half, "p4a"),
    principal: half,
  });
  orders.push({
    borrower: borrowers[3].address,
    orderId: await finalizeOne(borrowers[3], lenders[4], principal - half, "p4b"),
    principal: principal - half,
  });
  console.log("  ✅ Pair4 split orders created (2 lenders)");

  // Pair5: borrower5 + lender1 again (single 500) — will repay overdue
  orders.push({ borrower: borrowers[4].address, orderId: await finalizeOne(borrowers[4], lenders[0], principal, "p5"), principal });
  console.log("  ✅ Pair5 order created (will repay overdue)\n");

  // ============ Checkpoint A: Totals after all matches (delta-based) ============
  console.log("=== Checkpoint A: Totals after matches ===");
  const afterMatchTotals = await snapshotBorrowersTotals(assetAddr);
  const afterMatchStats = await statisticsView.getGlobalStatistics();

  const expectedCollateralDelta = collateralAmt * BigInt(borrowers.length);
  const expectedDebtDelta = orders.reduce((a, o) => a + o.principal, 0n);

  const ledgerColDelta = afterMatchTotals.colSum - baselineTotals.colSum;
  const ledgerDebtDelta = afterMatchTotals.debtSum - baselineTotals.debtSum;
  const statsColDelta = toBigInt(afterMatchStats.totalCollateral) - toBigInt(baselineStats.totalCollateral);
  const statsDebtDelta = toBigInt(afterMatchStats.totalDebt) - toBigInt(baselineStats.totalDebt);

  console.log("Expected deltas: collateral", ethers.formatUnits(expectedCollateralDelta, 6), "debt", ethers.formatUnits(expectedDebtDelta, 6));
  console.log("Ledger deltas:    collateral", ethers.formatUnits(ledgerColDelta, 6), "debt", ethers.formatUnits(ledgerDebtDelta, 6));
  console.log("Stats deltas:     collateral", ethers.formatUnits(statsColDelta, 6), "debt", ethers.formatUnits(statsDebtDelta, 6));

  if (ledgerColDelta !== expectedCollateralDelta) throw new Error("Checkpoint A: ledger collateral delta mismatch");
  if (ledgerDebtDelta !== expectedDebtDelta) throw new Error("Checkpoint A: ledger debt delta mismatch");
  if (statsColDelta !== expectedCollateralDelta) {
    const msg = `Checkpoint A: StatisticsView collateral delta mismatch got=${ethers.formatUnits(
      statsColDelta,
      6
    )} expected=${ethers.formatUnits(expectedCollateralDelta, 6)}`;
    if (strictViews && !baselineDirty) throw new Error(msg);
    console.log(`  ⚠️ [BestEffort] ${msg} (continuing; ledger/view are authoritative here)`);
  }
  if (statsDebtDelta !== expectedDebtDelta) {
    const msg = `Checkpoint A: StatisticsView debt delta mismatch got=${ethers.formatUnits(
      statsDebtDelta,
      6
    )} expected=${ethers.formatUnits(expectedDebtDelta, 6)}`;
    if (strictViews && !baselineDirty) throw new Error(msg);
    console.log(`  ⚠️ [BestEffort] ${msg} (continuing; ledger/view are authoritative here)`);
  }
  console.log("✅ Checkpoint A passed\n");
  await logPositionViewVersion("checkpoint A (after matches)");

  // ============ Step 3: Repayments (with partial + overdue) ============
  console.log("=== Step 3: Repayments ===");

  // Helper: find signer by address
  const signerByAddr = new Map<string, any>();
  for (const s of signers) signerByAddr.set(s.address.toLowerCase(), s);

  // Pair1: repay full on-time
  {
    const o = orders.find((x) => x.borrower === borrowers[0].address)!;
    const totalDue = calcTotalDue(o.principal, rateBps, termSec);
    const borrowerSigner = signerByAddr.get(o.borrower.toLowerCase());
    await (await usdc.connect(borrowerSigner).approve(vaultCoreAddr, totalDue)).wait();
    const repayRc = await (await vaultCore.connect(borrowerSigner).repay(o.orderId, assetAddr, totalDue)).wait();
    expectedDebtByBorrower.set(o.borrower, (expectedDebtByBorrower.get(o.borrower) || 0n) - o.principal);
    // If this user has no debt left, SettlementManager auto-releases all collateral (SSOT).
    const releasedAll = (await vle.getUserTotalDebtValue(o.borrower)) === 0n;
    assertRepayAndSettleDataPush("Pair1 repay", repayRc, settlementManager, o.borrower, assetAddr, totalDue, o.orderId, releasedAll);
    if (releasedAll) {
      assertCollateralReleasedDataPush("Pair1 repay", repayRc, o.borrower, assetAddr);
      const hasEvt = (repayRc?.logs || []).some((log: any) => {
        try {
          const parsed = settlementManager.interface.parseLog({ topics: log.topics as string[], data: log.data });
          return parsed?.name === "CollateralReleased" && (parsed.args.user as string).toLowerCase() === o.borrower.toLowerCase();
        } catch {
          return false;
        }
      });
      if (!hasEvt) throw new Error("Pair1 repay: missing SettlementManager.CollateralReleased event");
    }
    if (releasedAll) {
      expectedCollateralByBorrower.set(o.borrower, 0n);
    }
    await assertViews(
      "After repay (pair1 full)",
      o.borrower,
      assetAddr,
      expectedCollateralByBorrower.get(o.borrower),
      expectedDebtByBorrower.get(o.borrower)
    );
    // Reward assertion (Architecture-Guide / RewardManagerCore):
    // - Only eligible loans (principal >= 1000e6) accrue/lock points.
    // - Ineligible principals MUST NOT change points.
    const rewardBalAfter = (await rewardPoints.balanceOf(rewardBorrower.address)) as bigint;
    const rewardSummaryAfter = await rewardView.connect(deployer).getUserRewardSummary(rewardBorrower.address);
    console.log(
      `  [Reward] after repay(pair1): borrower=${rewardBorrower.address} pointsBalance=${fmtPoints(rewardBalAfter)} (raw=${rewardBalAfter.toString()}) totalEarned=${fmtPoints(
        rewardSummaryAfter[0]
      )} (raw=${rewardSummaryAfter[0].toString()}) totalBurned=${fmtPoints(rewardSummaryAfter[1])} pendingPenalty=${fmtPoints(
        rewardSummaryAfter[2]
      )}`
    );
    const balDelta = rewardBalAfter - rewardBalBefore;
    const earnedDelta = (rewardSummaryAfter[0] as bigint) - (rewardSummaryBefore[0] as bigint);
    if (o.principal >= MIN_ELIGIBLE_PRINCIPAL) {
      // V2 currently locks/releases 1 point per eligible order (see RewardManagerCore storage comments).
      if (balDelta !== ONE_POINT) {
        throw new Error(`[Reward] expected points balance delta == 1 (eligible principal) (got ${fmtPoints(balDelta)} raw=${balDelta.toString()})`);
      }
      if (earnedDelta !== ONE_POINT) {
        throw new Error(`[Reward] expected totalEarned delta == 1 (eligible principal) (got ${fmtPoints(earnedDelta)} raw=${earnedDelta.toString()})`);
      }
      if (rewardSummaryAfter[2] !== 0n) throw new Error("[Reward] expected pendingPenalty == 0 for on-time full repay (pair1)");
    } else {
      if (balDelta !== 0n || earnedDelta !== 0n) {
        throw new Error(
          `[Reward] expected no points change for ineligible principal (<1000e6): balDelta=${fmtPoints(balDelta)} earnedDelta=${fmtPoints(
            earnedDelta
          )}`
        );
      }
    }
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
    await (await usdc.connect(borrowerSigner).approve(vaultCoreAddr, totalDue)).wait();
    const repayPartialRc = await (await vaultCore.connect(borrowerSigner).repay(o.orderId, assetAddr, partial)).wait();
    assertRepayAndSettleDataPush("Pair2 repay(partial)", repayPartialRc, settlementManager, o.borrower, assetAddr, partial, o.orderId, false);

    // principal-first mapping: repay reduces principal debt by min(partial, principal)
    const principalPaid1 = partial > o.principal ? o.principal : partial;
    expectedDebtByBorrower.set(o.borrower, (expectedDebtByBorrower.get(o.borrower) || 0n) - principalPaid1);
    await assertViews(
      "After repay (pair2 partial)",
      o.borrower,
      assetAddr,
      expectedCollateralByBorrower.get(o.borrower),
      expectedDebtByBorrower.get(o.borrower)
    );
    console.log("  ✅ Pair2 partial repaid");

    // remaining
    const repayFullRc = await (await vaultCore.connect(borrowerSigner).repay(o.orderId, assetAddr, remaining)).wait();
    const principalRemaining = o.principal - principalPaid1;
    expectedDebtByBorrower.set(o.borrower, (expectedDebtByBorrower.get(o.borrower) || 0n) - principalRemaining);
    const releasedAll = (await vle.getUserTotalDebtValue(o.borrower)) === 0n;
    assertRepayAndSettleDataPush("Pair2 repay(full)", repayFullRc, settlementManager, o.borrower, assetAddr, remaining, o.orderId, releasedAll);
    if (releasedAll) {
      assertCollateralReleasedDataPush("Pair2 repay(full)", repayFullRc, o.borrower, assetAddr);
    }
    if (releasedAll) {
      expectedCollateralByBorrower.set(o.borrower, 0n);
    }
    await assertViews(
      "After repay (pair2 full)",
      o.borrower,
      assetAddr,
      expectedCollateralByBorrower.get(o.borrower),
      expectedDebtByBorrower.get(o.borrower)
    );
    console.log("  ✅ Pair2 fully repaid (on-time)");
  }

  // Pair3: full repay on-time
  {
    const o = orders.find((x) => x.borrower === borrowers[2].address)!;
    const totalDue = calcTotalDue(o.principal, rateBps, termSec);
    const borrowerSigner = signerByAddr.get(o.borrower.toLowerCase());
    await (await usdc.connect(borrowerSigner).approve(vaultCoreAddr, totalDue)).wait();
    const repayRc = await (await vaultCore.connect(borrowerSigner).repay(o.orderId, assetAddr, totalDue)).wait();
    expectedDebtByBorrower.set(o.borrower, (expectedDebtByBorrower.get(o.borrower) || 0n) - o.principal);
    const releasedAll = (await vle.getUserTotalDebtValue(o.borrower)) === 0n;
    assertRepayAndSettleDataPush("Pair3 repay", repayRc, settlementManager, o.borrower, assetAddr, totalDue, o.orderId, releasedAll);
    if (releasedAll) assertCollateralReleasedDataPush("Pair3 repay", repayRc, o.borrower, assetAddr);
    if (releasedAll) {
      expectedCollateralByBorrower.set(o.borrower, 0n);
    }
    await assertViews(
      "After repay (pair3 full)",
      o.borrower,
      assetAddr,
      expectedCollateralByBorrower.get(o.borrower),
      expectedDebtByBorrower.get(o.borrower)
    );
    console.log("  ✅ Pair3 full repaid");
  }

  // Pair4: split orders — repay both on-time
  {
    const os = orders.filter((x) => x.borrower === borrowers[3].address);
    const borrowerSigner = signerByAddr.get(borrowers[3].address.toLowerCase());
    for (let i = 0; i < os.length; i++) {
      const o = os[i];
      const totalDue = calcTotalDue(o.principal, rateBps, termSec);
      await (await usdc.connect(borrowerSigner).approve(vaultCoreAddr, totalDue)).wait();
      const repayRc = await (await vaultCore.connect(borrowerSigner).repay(o.orderId, assetAddr, totalDue)).wait();
      expectedDebtByBorrower.set(o.borrower, (expectedDebtByBorrower.get(o.borrower) || 0n) - o.principal);
      const releasedAll = (await vle.getUserTotalDebtValue(o.borrower)) === 0n;
      assertRepayAndSettleDataPush(
        `Pair4 repay(order#${i + 1})`,
        repayRc,
        settlementManager,
        o.borrower,
        assetAddr,
        totalDue,
        o.orderId,
        releasedAll
      );
      if (releasedAll) assertCollateralReleasedDataPush(`Pair4 repay(order#${i + 1})`, repayRc, o.borrower, assetAddr);
      if (releasedAll) {
        expectedCollateralByBorrower.set(o.borrower, 0n);
      }
      await assertViews(
        `After repay (pair4 split order#${i + 1})`,
        o.borrower,
        assetAddr,
        expectedCollateralByBorrower.get(o.borrower),
        expectedDebtByBorrower.get(o.borrower)
      );
    }
    console.log("  ✅ Pair4 split orders fully repaid");
  }

  // Pair5: overdue full repay — time travel, then repay
  {
    const o = orders.find((x) => x.borrower === borrowers[4].address)!;

    // move forward beyond maturity/window; be conservative
    await evmIncreaseTime(termSec + 3n * ONE_DAY);

    const totalDue = calcTotalDue(o.principal, rateBps, termSec);
    const borrowerSigner = signerByAddr.get(o.borrower.toLowerCase());
    await (await usdc.connect(borrowerSigner).approve(vaultCoreAddr, totalDue)).wait();
    const repayRc = await (await vaultCore.connect(borrowerSigner).repay(o.orderId, assetAddr, totalDue)).wait();

    expectedDebtByBorrower.set(o.borrower, (expectedDebtByBorrower.get(o.borrower) || 0n) - o.principal);
    const releasedAll = (await vle.getUserTotalDebtValue(o.borrower)) === 0n;
    assertRepayAndSettleDataPush("Pair5 repay(overdue)", repayRc, settlementManager, o.borrower, assetAddr, totalDue, o.orderId, releasedAll);
    if (releasedAll) assertCollateralReleasedDataPush("Pair5 repay(overdue)", repayRc, o.borrower, assetAddr);
    if (releasedAll) {
      expectedCollateralByBorrower.set(o.borrower, 0n);
    }
    await assertViews(
      "After repay (pair5 overdue)",
      o.borrower,
      assetAddr,
      expectedCollateralByBorrower.get(o.borrower),
      expectedDebtByBorrower.get(o.borrower)
    );
    console.log("  ✅ Pair5 overdue repaid\n");
  }

  // ============ Extra coverage: CollateralReleased + DataPush strong assertions ============
  // Goal: deterministically hit "releasedAllCollateral=true" path in SettlementManager.
  console.log("=== Extra: CollateralReleased (repay triggers auto-release) ===");
  {
    const used = new Set<string>([deployer.address, ...borrowers.map((x) => x.address), ...lenders.map((x) => x.address)].map((x) => x.toLowerCase()));
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
      if (cleanBorrower && s.address.toLowerCase() === cleanBorrower.address.toLowerCase()) continue;
      cleanLender = s;
      break;
    }
    if (!cleanBorrower || !cleanLender) {
      throw new Error("Extra CollateralReleased: cannot find unused clean borrower/lender signers; restart localhost node for a clean state.");
    }

    // fund + seed expected maps for this borrower
    await (await usdc.connect(deployer).transfer(cleanBorrower.address, ethers.parseUnits("20000", 6))).wait();
    await (await usdc.connect(deployer).transfer(cleanLender.address, ethers.parseUnits("20000", 6))).wait();
    expectedCollateralByBorrower.set(cleanBorrower.address, await cm.getCollateral(cleanBorrower.address, assetAddr));
    expectedDebtByBorrower.set(cleanBorrower.address, await vle.getDebt(cleanBorrower.address, assetAddr));

    // deposit collateral
    await (await usdc.connect(cleanBorrower).approve(cmAddr, collateralAmt)).wait();
    await (await vaultCore.connect(cleanBorrower).deposit(assetAddr, collateralAmt)).wait();
    expectedCollateralByBorrower.set(
      cleanBorrower.address,
      (expectedCollateralByBorrower.get(cleanBorrower.address) || 0n) + collateralAmt
    );

    // create a small fresh order
    const demoPrincipal = ethers.parseUnits("100", 6);
    const demoOrderId = await finalizeOne(cleanBorrower, cleanLender, demoPrincipal, "release-demo");

    // repay full (principal + interest); this borrower has no other debt ⇒ must auto-release collateral
    const demoDue = calcTotalDue(demoPrincipal, rateBps, termSec);
    await (await usdc.connect(cleanBorrower).approve(vaultCoreAddr, demoDue)).wait();
    const demoRepayRc = await (await vaultCore.connect(cleanBorrower).repay(demoOrderId, assetAddr, demoDue)).wait();
    const releasedAll = (await vle.getUserTotalDebtValue(cleanBorrower.address)) === 0n;
    if (!releasedAll) throw new Error("Extra CollateralReleased: expected releasedAllCollateral=true but user still has debt");

    assertRepayAndSettleDataPush(
      "Extra CollateralReleased repay",
      demoRepayRc,
      settlementManager,
      cleanBorrower.address,
      assetAddr,
      demoDue,
      demoOrderId,
      true
    );
    assertCollateralReleasedDataPush("Extra CollateralReleased repay", demoRepayRc, cleanBorrower.address, assetAddr);

    expectedDebtByBorrower.set(cleanBorrower.address, (expectedDebtByBorrower.get(cleanBorrower.address) || 0n) - demoPrincipal);
    expectedCollateralByBorrower.set(cleanBorrower.address, 0n);

    // ledger must show collateral is now 0
    if ((await cm.getCollateral(cleanBorrower.address, assetAddr)) !== 0n) {
      throw new Error("Extra CollateralReleased: collateral not fully released on ledger");
    }
    await assertViews(
      "After repay (extra collateral release)",
      cleanBorrower.address,
      assetAddr,
      expectedCollateralByBorrower.get(cleanBorrower.address),
      expectedDebtByBorrower.get(cleanBorrower.address)
    );
    console.log("  ✅ CollateralReleased + DataPush(REPAY_AND_SETTLE/COLLATERAL_RELEASED) verified");
  }

  // ============ Extra coverage: Early repayment guarantee (Extension Flow SSOT path) ============
  // Doc mapping (Funds-Flow-Architecture-Guide.md §5):
  // - Lock/record: VaultBusinessLogic.finalizeMatch -> GFM.lockGuarantee + ERGM.lockGuaranteeRecord
  // - Early settle: VaultCore.repay -> SettlementManager.repayAndSettle -> ERGM.settleEarlyRepayment -> GFM.settleEarlyRepayment
  console.log("=== Extra: EarlyRepaymentGuarantee (VBL lock+record → repay triggers early settle) ===");
  if (!guaranteeToggleSupported) {
    console.log("  ⚠️ Skipping: ERGM toggle not supported in this localhost deployment (see message above).");
  } else {
    // Enable extension flow for this dedicated block (asset-level toggle SSOT).
    if (!(await ergm.isGuaranteeEnabled(assetAddr))) {
      await (await ergm.connect(deployer).setGuaranteeEnabled(assetAddr, true)).wait();
    }
    // Use fresh users so this block is robust even on dirty state.
    const used = new Set<string>([deployer.address, ...borrowers.map((x) => x.address), ...lenders.map((x) => x.address)].map((x) =>
      x.toLowerCase()
    ));
    let gBorrower: any | null = null;
    let gLender: any | null = null;
    for (const s of signers) {
      if (used.has(s.address.toLowerCase())) continue;
      if ((await vle.getUserTotalDebtValue(s.address)) !== 0n) continue;
      gBorrower = s;
      break;
    }
    for (const s of signers) {
      if (used.has(s.address.toLowerCase())) continue;
      if (gBorrower && s.address.toLowerCase() === gBorrower.address.toLowerCase()) continue;
      gLender = s;
      break;
    }
    if (!gBorrower || !gLender) {
      throw new Error("EarlyRepaymentGuarantee(E2E): cannot find fresh borrower/lender signers; restart localhost node for a clean state.");
    }

    // Fund + deposit collateral (finalizeOne requires borrower already deposited `collateralAmt`)
    await (await usdc.connect(deployer).transfer(gBorrower.address, ethers.parseUnits("20000", 6))).wait();
    await (await usdc.connect(deployer).transfer(gLender.address, ethers.parseUnits("20000", 6))).wait();
    await (await usdc.connect(gBorrower).approve(cmAddr, collateralAmt)).wait();
    await (await vaultCore.connect(gBorrower).deposit(assetAddr, collateralAmt)).wait();
    // Seed expected maps for this extra user so finalizeOne/assertViews can validate ledger/view consistency.
    expectedCollateralByBorrower.set(gBorrower.address, await cm.getCollateral(gBorrower.address, assetAddr));
    expectedDebtByBorrower.set(gBorrower.address, await vle.getDebt(gBorrower.address, assetAddr));

    const gPrincipal = ethers.parseUnits("200", 6);
    const orderId = await finalizeOne(gBorrower, gLender, gPrincipal, "guarantee-early", { withGuarantee: true });

    // After match, guarantee must be active and custodied.
    const gid = (await ergm.getUserGuaranteeId(gBorrower.address, assetAddr)) as bigint;
    if (gid === 0n) throw new Error("EarlyRepaymentGuarantee(E2E): missing guaranteeId after finalizeMatch");
    if (!(await ergm.hasActiveGuarantee(gBorrower.address, assetAddr))) throw new Error("EarlyRepaymentGuarantee(E2E): expected active guarantee after match");
    if (!((await gfm.isGuaranteePaid(gBorrower.address, assetAddr)) as boolean)) throw new Error("EarlyRepaymentGuarantee(E2E): expected GFM.isGuaranteePaid==true after match");

    // Preview by ERGM (semantic SSOT), then repay via VaultCore (funds-flow SSOT)
    const repayAmount = calcTotalDue(gPrincipal, rateBps, termSec); // should fully clear debt → trigger early settle
    const preview = await ergm.previewEarlyRepayment(gid, repayAmount);
    const lockedBefore = (await gfm.getLockedGuarantee(gBorrower.address, assetAddr)) as bigint;

    await (await usdc.connect(gBorrower).approve(vaultCoreAddr, repayAmount)).wait();
    const repayRc = await (await vaultCore.connect(gBorrower).repay(orderId, assetAddr, repayAmount)).wait();

    // Strong: ERGM must emit EarlyRepaymentProcessed (triggered by SettlementManager).
    // IMPORTANT: do NOT use ERC20 balance deltas here (repay also moves principal+interest through OrderEngine),
    // so we assert using the SSOT event payload + GFM custody.
    let processed: any | null = null;
    for (const log of repayRc?.logs || []) {
      try {
        const parsed = ergm.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === "EarlyRepaymentProcessed") {
          processed = parsed;
          break;
        }
      } catch {
        // ignore
      }
    }
    if (!processed) throw new Error("EarlyRepaymentGuarantee(E2E): missing ERGM.EarlyRepaymentProcessed event in repay receipt");

    const [, borrower, lender, asset, penaltyToLender, refundToBorrower, platformFee, actualInterestPaid] = processed.args as any[];
    if ((borrower as string).toLowerCase() !== gBorrower.address.toLowerCase()) throw new Error("EarlyRepaymentGuarantee(E2E): event borrower mismatch");
    if ((lender as string).toLowerCase() !== lenderPoolAddr.toLowerCase()) throw new Error("EarlyRepaymentGuarantee(E2E): event lender(pool) mismatch");
    if ((asset as string).toLowerCase() !== assetAddr.toLowerCase()) throw new Error("EarlyRepaymentGuarantee(E2E): event asset mismatch");
    if (toBigInt(penaltyToLender) !== toBigInt(preview.penaltyToLender)) throw new Error("EarlyRepaymentGuarantee(E2E): penaltyToLender mismatch vs preview");
    if (toBigInt(refundToBorrower) !== toBigInt(preview.refundToBorrower)) throw new Error("EarlyRepaymentGuarantee(E2E): refundToBorrower mismatch vs preview");
    if (toBigInt(platformFee) !== toBigInt(preview.platformFee)) throw new Error("EarlyRepaymentGuarantee(E2E): platformFee mismatch vs preview");
    if (toBigInt(actualInterestPaid) !== toBigInt(preview.actualInterestPaid)) throw new Error("EarlyRepaymentGuarantee(E2E): actualInterestPaid mismatch vs preview");

    // Guarantee must be cleared on-chain (custody + record)
    const lockedAfter = (await gfm.getLockedGuarantee(gBorrower.address, assetAddr)) as bigint;
    if (lockedAfter !== 0n) {
      throw new Error(
        `EarlyRepaymentGuarantee(E2E): expected locked guarantee cleared. before=${lockedBefore.toString()} after=${lockedAfter.toString()}`
      );
    }
    if ((await ergm.hasActiveGuarantee(gBorrower.address, assetAddr)) as boolean) {
      throw new Error("EarlyRepaymentGuarantee(E2E): expected ERGM.hasActiveGuarantee==false after early settlement");
    }
    if ((await gfm.isGuaranteePaid(gBorrower.address, assetAddr)) as boolean) {
      throw new Error("EarlyRepaymentGuarantee(E2E): expected GFM.isGuaranteePaid==false after early settlement");
    }

    console.log("  ✅ VBL lock+record → VaultCore.repay triggered early guarantee settlement (3-way distribution checked)");
  }

  // ============ Extra coverage: Default guarantee processing (settleOrLiquidate SSOT path) ============
  // - Lock/record: VBL.finalizeMatch
  // - Default: SettlementManager.settleOrLiquidate (keeper SSOT) triggers ERGM.processDefault -> GFM.forfeitPartial
  console.log("=== Extra: EarlyRepaymentGuarantee (VBL lock+record → settleOrLiquidate triggers forfeiture) ===");
  if (!guaranteeToggleSupported) {
    console.log("  ⚠️ Skipping: ERGM toggle not supported in this localhost deployment (see message above).");
  } else {
    // Ensure extension flow is enabled for this block as well.
    if (!(await ergm.isGuaranteeEnabled(assetAddr))) {
      await (await ergm.connect(deployer).setGuaranteeEnabled(assetAddr, true)).wait();
    }
    const used = new Set<string>([deployer.address, ...borrowers.map((x) => x.address), ...lenders.map((x) => x.address)].map((x) =>
      x.toLowerCase()
    ));
    let dBorrower: any | null = null;
    let dLender: any | null = null;
    for (const s of signers) {
      if (used.has(s.address.toLowerCase())) continue;
      if ((await vle.getUserTotalDebtValue(s.address)) !== 0n) continue;
      dBorrower = s;
      break;
    }
    for (const s of signers) {
      if (used.has(s.address.toLowerCase())) continue;
      if (dBorrower && s.address.toLowerCase() === dBorrower.address.toLowerCase()) continue;
      dLender = s;
      break;
    }
    if (!dBorrower || !dLender) {
      throw new Error("DefaultGuarantee(E2E): cannot find fresh borrower/lender signers; restart localhost node for a clean state.");
    }

    await (await usdc.connect(deployer).transfer(dBorrower.address, ethers.parseUnits("20000", 6))).wait();
    await (await usdc.connect(deployer).transfer(dLender.address, ethers.parseUnits("20000", 6))).wait();
    await (await usdc.connect(dBorrower).approve(cmAddr, collateralAmt)).wait();
    await (await vaultCore.connect(dBorrower).deposit(assetAddr, collateralAmt)).wait();
    expectedCollateralByBorrower.set(dBorrower.address, await cm.getCollateral(dBorrower.address, assetAddr));
    expectedDebtByBorrower.set(dBorrower.address, await vle.getDebt(dBorrower.address, assetAddr));

    const dPrincipal = ethers.parseUnits("150", 6);
    const dOrderId = await finalizeOne(dBorrower, dLender, dPrincipal, "guarantee-default", { withGuarantee: true });

    // Ensure guarantee exists before default processing
    const dGid = (await ergm.getUserGuaranteeId(dBorrower.address, assetAddr)) as bigint;
    if (dGid === 0n) throw new Error("DefaultGuarantee(E2E): missing guaranteeId after finalizeMatch");
    const dRec = await ergm.getGuaranteeRecord(dGid);
    if (!((await gfm.isGuaranteePaid(dBorrower.address, assetAddr)) as boolean)) throw new Error("DefaultGuarantee(E2E): expected GFM.isGuaranteePaid==true after match");
    if (!((await ergm.hasActiveGuarantee(dBorrower.address, assetAddr)) as boolean)) throw new Error("DefaultGuarantee(E2E): expected ERGM.hasActiveGuarantee==true after match");

    // Time travel beyond maturity → overdue branch
    await evmIncreaseTime(termSec + 3n * ONE_DAY);
    // Refresh price after time travel to avoid stale valuation (Liquidation path uses valuation).
    const now2 = (await ethers.provider.getBlock("latest"))!.timestamp;
    await (await po.connect(deployer).updatePrice(assetAddr, ethers.parseUnits("1", 6), now2)).wait();

    const liqRc = await (await settlementManager.connect(deployer).settleOrLiquidate(dOrderId)).wait();

    const hasForfeited = (liqRc?.logs || []).some((log: any) => {
      try {
        const parsed = ergm.interface.parseLog({ topics: log.topics as string[], data: log.data });
        return parsed?.name === "GuaranteeForfeited";
      } catch {
        return false;
      }
    });
    if (!hasForfeited) throw new Error("DefaultGuarantee(E2E): missing ERGM.GuaranteeForfeited event in settleOrLiquidate receipt");
    // Parse the forfeiture event and assert SSOT payload consistency.
    let forfeited: any | null = null;
    for (const log of liqRc?.logs || []) {
      try {
        const parsed = ergm.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === "GuaranteeForfeited") {
          forfeited = parsed;
          break;
        }
      } catch {
        // ignore
      }
    }
    if (!forfeited) throw new Error("DefaultGuarantee(E2E): cannot parse ERGM.GuaranteeForfeited event");
    const [gidEvt, borrowerEvt, lenderEvt, assetEvt, forfeitedAmount] = forfeited.args as any[];
    if (toBigInt(gidEvt) !== dGid) throw new Error("DefaultGuarantee(E2E): event guaranteeId mismatch");
    if ((borrowerEvt as string).toLowerCase() !== dBorrower.address.toLowerCase()) throw new Error("DefaultGuarantee(E2E): event borrower mismatch");
    if ((lenderEvt as string).toLowerCase() !== lenderPoolAddr.toLowerCase()) throw new Error("DefaultGuarantee(E2E): event lender(pool) mismatch");
    if ((assetEvt as string).toLowerCase() !== assetAddr.toLowerCase()) throw new Error("DefaultGuarantee(E2E): event asset mismatch");
    // Current product rule: forfeited == promisedInterest (custodied in GFM).
    if (toBigInt(forfeitedAmount) !== toBigInt(dRec.promisedInterest)) {
      throw new Error("DefaultGuarantee(E2E): forfeitedAmount mismatch vs promisedInterest");
    }

    if ((await ergm.hasActiveGuarantee(dBorrower.address, assetAddr)) as boolean) {
      throw new Error("DefaultGuarantee(E2E): expected ERGM.hasActiveGuarantee==false after forfeiture");
    }
    if ((await gfm.isGuaranteePaid(dBorrower.address, assetAddr)) as boolean) {
      throw new Error("DefaultGuarantee(E2E): expected GFM.isGuaranteePaid==false after forfeiture");
    }
    console.log("  ✅ settleOrLiquidate triggered guarantee forfeiture + cleared custody/record");
  }

  // ============ Final Checkpoint: all debts cleared (delta-based) ============
  console.log("=== Final Checkpoint: totals after all repaid ===");
  const finalTotals = await snapshotBorrowersTotals(assetAddr);
  const finalStats = await statisticsView.getGlobalStatistics();

  // Expected (SSOT): after full repay, SettlementManager auto-releases all collateral for that user (when totalDebtValue==0),
  // so the expected final collateral delta is derived from our per-borrower expected map (not "deposit amount").
  let expectedFinalColSum = 0n;
  for (const b of borrowers) expectedFinalColSum += expectedCollateralByBorrower.get(b.address) || 0n;
  const expectedFinalLedgerColDelta = expectedFinalColSum - baselineTotals.colSum;

  const finalLedgerColDelta = finalTotals.colSum - baselineTotals.colSum;
  const finalLedgerDebtDelta = finalTotals.debtSum - baselineTotals.debtSum;
  const finalStatsColDelta = toBigInt(finalStats.totalCollateral) - toBigInt(baselineStats.totalCollateral);
  const finalStatsDebtDelta = toBigInt(finalStats.totalDebt) - toBigInt(baselineStats.totalDebt);

  console.log("Expected deltas: collateral", ethers.formatUnits(expectedFinalLedgerColDelta, 6), "debt", ethers.formatUnits(0n, 6));
  console.log("Ledger deltas:    collateral", ethers.formatUnits(finalLedgerColDelta, 6), "debt", ethers.formatUnits(finalLedgerDebtDelta, 6));
  console.log("Stats deltas:     collateral", ethers.formatUnits(finalStatsColDelta, 6), "debt", ethers.formatUnits(finalStatsDebtDelta, 6));

  if (finalLedgerColDelta !== expectedFinalLedgerColDelta) throw new Error("Final: ledger collateral delta mismatch");
  if (finalLedgerDebtDelta !== 0n) throw new Error("Final: ledger debt delta should be 0 (new loans fully repaid)");
  if (finalStatsColDelta !== expectedFinalLedgerColDelta) {
    const msg = `Final: StatisticsView collateral delta mismatch got=${ethers.formatUnits(
      finalStatsColDelta,
      6
    )} expected=${ethers.formatUnits(expectedFinalLedgerColDelta, 6)}`;
    if (strictViews && !baselineDirty) throw new Error(msg);
    console.log(`  ⚠️ [BestEffort] ${msg} (continuing)`);
  }
  if (finalStatsDebtDelta !== 0n) {
    const msg = `Final: StatisticsView debt delta expected 0, got=${ethers.formatUnits(finalStatsDebtDelta, 6)}`;
    if (strictViews && !baselineDirty) throw new Error(msg);
    console.log(`  ⚠️ [BestEffort] ${msg} (continuing)`);
  }

  console.log("✅ Final checkpoint passed\n");
  await logPositionViewVersion("final checkpoint (after all repaid)");

  // ============ Extra coverage: Cancel Reserve (Reserve → Cancel) ============
  console.log("=== Extra: Cancel Reserve (Reserve → Cancel) ===");
  {
    const lender = lenders[0];
    const amount = ethers.parseUnits("123", 6);
    const lenderBalBefore = (await usdc.balanceOf(lender.address)) as bigint;

    const poolAddr = (await registry.getModuleOrRevert(key("LENDER_POOL_VAULT"))) as string;
    const poolBalBefore = (await usdc.balanceOf(poolAddr)) as bigint;

    const expireAt = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
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

    await (await usdc.connect(lender).approve(vblAddr, amount)).wait();
    const lendHash = buildLendIntentHash(lendIntent);
    await (await vbl.connect(lender).reserveForLending(lender.address, assetAddr, amount, lendHash)).wait();

    const lenderBalAfterReserve = (await usdc.balanceOf(lender.address)) as bigint;
    const poolBalAfterReserve = (await usdc.balanceOf(poolAddr)) as bigint;
    if (lenderBalBefore - lenderBalAfterReserve !== amount) throw new Error("CancelReserve: lender balance did not decrease by reserve amount");
    if (poolBalAfterReserve - poolBalBefore !== amount) throw new Error("CancelReserve: pool balance did not increase by reserve amount");

    await (await vbl.connect(lender).cancelReserve(lendHash)).wait();
    const lenderBalAfterCancel = (await usdc.balanceOf(lender.address)) as bigint;
    const poolBalAfterCancel = (await usdc.balanceOf(poolAddr)) as bigint;
    if (lenderBalAfterCancel !== lenderBalBefore) throw new Error("CancelReserve: lender balance not restored after cancel");
    if (poolBalAfterCancel !== poolBalBefore) throw new Error("CancelReserve: pool balance not restored after cancel");
    console.log("  ✅ reserve → cancel verified");
  }

  // ============ Extra coverage: User Withdraw (Deposit → Withdraw) ============
  console.log("=== Extra: User Withdraw (Deposit → Withdraw) ===");
  {
    // Use a fresh user (not one of the borrowers), because in SSOT repay flow
    // collateral may be auto-released to 0 for the main borrowers after full repayment.
    const used = new Set<string>([deployer.address, ...borrowers.map((x) => x.address), ...lenders.map((x) => x.address)].map((x) => x.toLowerCase()));
    let user: any | null = null;
    for (const s of signers) {
      if (used.has(s.address.toLowerCase())) continue;
      if ((await vle.getUserTotalDebtValue(s.address)) === 0n) {
        user = s;
        break;
      }
    }
    if (!user) throw new Error("Withdraw: cannot find unused signer; restart localhost node for a clean state.");

    const depositAmt = ethers.parseUnits("1000", 6);
    const withdrawAmt = ethers.parseUnits("100", 6);
    await (await usdc.connect(deployer).transfer(user.address, ethers.parseUnits("20000", 6))).wait();

    await (await usdc.connect(user).approve(cmAddr, depositAmt)).wait();
    await (await vaultCore.connect(user).deposit(assetAddr, depositAmt)).wait();

    const colBefore = (await cm.getCollateral(user.address, assetAddr)) as bigint;
    const balBefore = (await usdc.balanceOf(user.address)) as bigint;
    await (await vaultCore.connect(user).withdraw(assetAddr, withdrawAmt)).wait();
    const colAfter = (await cm.getCollateral(user.address, assetAddr)) as bigint;
    const balAfter = (await usdc.balanceOf(user.address)) as bigint;
    if (colBefore - colAfter !== withdrawAmt) throw new Error("Withdraw: collateral delta mismatch");
    if (balAfter - balBefore !== withdrawAmt) throw new Error("Withdraw: user token delta mismatch");
    await assertViews(
      "After withdraw (extra)",
      user.address,
      assetAddr,
      colAfter,
      0n
    );
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
          await (await ergm.connect(deployer).setGuaranteeEnabled(assetAddr, false)).wait();
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
    const colNow = (await cm.getCollateral(liqBorrower.address, assetAddr)) as bigint;
    if (colNow < collateralAmt) {
      const topUp = collateralAmt - colNow;
      await (await usdc.connect(liqBorrower).approve(cmAddr, topUp)).wait();
      await (await vaultCore.connect(liqBorrower).deposit(assetAddr, topUp)).wait();
      expectedCollateralByBorrower.set(
        liqBorrower.address,
        (expectedCollateralByBorrower.get(liqBorrower.address) || 0n) + topUp
      );
    }

    const orderId = await finalizeOne(liqBorrower, liqLender, liqPrincipal, "liq-demo");
    // SettlementManager liquidation path selects collateral via CM.getUserCollateralAssets(user),
    // so ensure the user's collateral asset list is non-empty (SSOT requirement).
    let assets = (await cm.getUserCollateralAssets(liqBorrower.address)) as string[];
    if (assets.length === 0) {
      const bump = ethers.parseUnits("1", 6);
      await (await usdc.connect(liqBorrower).approve(cmAddr, bump)).wait();
      await (await vaultCore.connect(liqBorrower).deposit(assetAddr, bump)).wait();
      assets = (await cm.getUserCollateralAssets(liqBorrower.address)) as string[];
    }
    if (assets.length === 0) throw new Error("Liquidation: user has no collateral asset list (CM.getUserCollateralAssets empty)");
    if (!assets.map((a) => a.toLowerCase()).includes(assetAddr.toLowerCase())) {
      const bump = ethers.parseUnits("1", 6);
      await (await usdc.connect(liqBorrower).approve(cmAddr, bump)).wait();
      await (await vaultCore.connect(liqBorrower).deposit(assetAddr, bump)).wait();
      assets = (await cm.getUserCollateralAssets(liqBorrower.address)) as string[];
    }
    if (!assets.map((a) => a.toLowerCase()).includes(assetAddr.toLowerCase())) {
      throw new Error("Liquidation: collateral asset list does not include assetAddr");
    }

    const debtBefore = (await vle.getDebt(liqBorrower.address, assetAddr)) as bigint;
    const colBefore = (await cm.getCollateral(liqBorrower.address, assetAddr)) as bigint;
    if (colBefore === 0n) throw new Error("Liquidation: user collateral balance is 0 before liquidation");

    // move time beyond maturity (termDays=5 in this script)
    await evmIncreaseTime(termSec + 3n * ONE_DAY);
    // PriceOracle may treat old prices as stale after time travel; refresh price so valuation != 0.
    {
      const now2 = (await ethers.provider.getBlock("latest"))!.timestamp;
      await (await po.connect(deployer).updatePrice(assetAddr, ethers.parseUnits("1", 6), now2)).wait();
    }
    const liqRc = await (await settlementManager.connect(deployer).settleOrLiquidate(orderId)).wait();
    assertLiquidationDataPush("Liquidation", liqRc, liqBorrower.address);

    const debtAfter = (await vle.getDebt(liqBorrower.address, assetAddr)) as bigint;
    const colAfter = (await cm.getCollateral(liqBorrower.address, assetAddr)) as bigint;
    if (debtAfter >= debtBefore) throw new Error("Liquidation: debt did not decrease");
    if (colAfter >= colBefore) throw new Error("Liquidation: collateral did not decrease");
    console.log("  ✅ liquidation executed (debt reduced, collateral seized)");
  }

  console.log("✅ Advanced batch E2E Completed!");
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
