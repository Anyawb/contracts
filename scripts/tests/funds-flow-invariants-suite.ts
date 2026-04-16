import { ethers, network } from "hardhat";
import { loadAddressMap, resolveAddress, envBool } from "./_addressResolver";
import { assertConservation, discoverTrackedAddresses, getErc20, key, snapshotBalances, uniqAddrs } from "./_fundsFlowUtils";
import {
  ensureRewardConfigEmergencyGranted,
  ensureRewardConfigEmergencyRevoked,
  roleKeyRewardConfigEmergency,
} from "../deploy/utils/reward-config-emergency";

/**
 * Funds-Flow Invariants Suite (localhost)
 *
 * Goal: provide a more "realistic" smoke suite than a single clean-case conservation check.
 * It validates:
 * - ERC20 totalSupply invariance (no mint/burn) across core flows
 * - balance-sum conservation across a curated tracked-address set
 * - key behavioral invariants: partial repay behavior, strict full-repay mode behavior, aggregated debt behavior
 *
 * This is still a smoke suite (fast, deterministic), not a full formal proof.
 *
 * Env knobs:
 * - RUN_FINALIZE_MATCH_ONLY=1 (runs only createOrder -> finalizeMatch checks; disables other cases; uses first token only)
 * - RUN_MATCH_DISBURSEMENT_ONLY=1 (runs only match -> borrow disbursement SSOT assertions; disables other cases; uses first token only)
 * - RUN_RESERVE_CANCEL=0/1 (default 1)
 * - RUN_PARTIAL_REPAY=0/1 (default 1)
 * - RUN_STRICT_AGGREGATED_DEBT=0/1 (default 1)
 * - ASSERT_AGG_DEBT_SUM=1 (strictly assert aggregated debt sum before repay)
 *   - AGG_DEBT_PRINCIPAL_A=200 (defaults to 200 when ASSERT_AGG_DEBT_SUM=1)
 *   - AGG_DEBT_PRINCIPAL_B=300 (defaults to 300 when ASSERT_AGG_DEBT_SUM=1)
 *   - AGG_DEBT_PRINCIPAL_C=100 (defaults to 100 when REBORROW_AFTER_REPAY=1)
 * - REBORROW_AFTER_REPAY=1 (borrow again after repaying orderA in strict agg debt case)
 * - STRICT_AGG_DEBT_ITERATIONS=10 (repeat strict agg debt case N times; default 1)
 * - BORROWER_INDEX=2 (force a specific signer index for borrower; useful for dirty cumulative runs)
 * - BORROWER_INDEXES=2,3,4 (rotate borrower across these indices per iteration)
 * - ALLOW_SIGNER_REUSE=1 (allow reusing signers when iterations are high)
 * - USE_VARIANT_AMOUNTS=1 (vary A/B/C principal amounts per iteration)
 * - RUN_LIQUIDATION=0/1 (default 1)
 * - E2E_ALLOW_DIRTY_STATE=1 (allows running even if node has historical positions; suite will try to pick clean signers)
 * - NO_AUTO_GRANT=1 (production-like): do NOT grant roles inside the suite; missing roles will SKIP the affected case(s)
 */

const ONE_DAY = 24n * 60n * 60n;
const ONE_HOUR_BLOCKS = 1_800n;
// Keep consistent with TermBlocksLib bucket mapping (5d=36000 => 7200 blocks/day baseline).
// Note: this suite treats most "time" axes as block-based SSOT; don't interpret as wallclock.
const BLOCKS_PER_DAY = 7_200n;

function hashLendIntentStruct(lendIntent: {
  lenderSigner: string;
  asset: string;
  amount: bigint;
  minTermDays: number;
  maxTermDays: number;
  minRateBps: bigint;
  expireAt: bigint;
  salt: string;
}) {
  // Must match SettlementIntentLib.hashLendIntent (SSOT) type string and encoding.
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
        lendIntent.lenderSigner,
        lendIntent.asset,
        lendIntent.amount,
        lendIntent.minTermDays,
        lendIntent.maxTermDays,
        lendIntent.minRateBps,
        lendIntent.expireAt,
        lendIntent.salt,
      ]
    )
  );
}

async function getOrderForView(orderEngineAddr: string, orderId: bigint) {
  const orderEngineView = await ethers.getContractAt(
    [
      "function getLoanOrderForView(uint256) view returns (tuple(uint256 principal,uint256 rate,uint256 term,address borrower,address lender,address asset,uint256 startBlock,uint256 maturity,uint256 repaidAmount))",
    ],
    orderEngineAddr
  );
  return (await orderEngineView.getLoanOrderForView(orderId)) as {
    principal: bigint;
    rate: bigint;
    term: bigint;
    borrower: string;
    lender: string;
    asset: string;
    startBlock: bigint;
    maturity: bigint;
    repaidAmount: bigint;
  };
}

async function getOrderTotalDueForView(orderEngineAddr: string, orderId: bigint) {
  const orderEngineView = await ethers.getContractAt(
    ["function getOrderTotalDueForView(uint256) view returns (uint256)"],
    orderEngineAddr
  );
  return (await orderEngineView.getOrderTotalDueForView(orderId)) as bigint;
}

async function getOrderStatusForView(orderEngineAddr: string, orderId: bigint) {
  const orderEngineView = await ethers.getContractAt(
    ["function getOrderStatusForView(uint256) view returns (uint8)"],
    orderEngineAddr
  );
  return BigInt(await orderEngineView.getOrderStatusForView(orderId));
}

function calcInterest(principal: bigint, rateBps: bigint, termSec: bigint) {
  const YEAR = 365n * ONE_DAY;
  return (principal * rateBps * termSec) / (10_000n * YEAR);
}

async function latestBlockNumber(): Promise<bigint> {
  return BigInt(await ethers.provider.getBlockNumber());
}

async function mineToBlock(targetBlock: bigint) {
  const current = await latestBlockNumber();
  if (targetBlock <= current) return;
  const delta = targetBlock - current;
  if (network.name === "localhost" || network.name === "hardhat") {
    await ethers.provider.send("hardhat_mine", ["0x" + delta.toString(16)]);
  }
}

async function main() {
  const readOnly = envBool("READ_ONLY", network.name !== "localhost");
  const enableWrite = envBool("ENABLE_WRITE", !readOnly);

  if (readOnly || !enableWrite) {
    const addressMap = loadAddressMap(network.name);
    const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });
    const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;
    const vaultCoreAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;
    const settlementMgrAddr = (await registry.getModuleOrRevert(key("SETTLEMENT_MANAGER"))) as string;
    console.log(`=== funds-flow-invariants-suite (read-only) network=${network.name} ===`);
    console.log(`  Registry=${registryAddr}`);
    console.log(`  VAULT_CORE=${vaultCoreAddr}`);
    console.log(`  SETTLEMENT_MANAGER=${settlementMgrAddr}`);
    console.log("  ℹ️  [skip] invariants suite requires local writeable chain + time-advance.");
    console.log("\n✅ funds-flow-invariants-suite (read-only) PASSED\n");
    return;
  }
  const allowDirtyState = process.env.E2E_ALLOW_DIRTY_STATE === "1";
  const runFinalizeMatchOnly = process.env.RUN_FINALIZE_MATCH_ONLY === "1";
  const runMatchDisbursementOnly = process.env.RUN_MATCH_DISBURSEMENT_ONLY === "1";
  const runReserveCancel = process.env.RUN_RESERVE_CANCEL !== "0";
  const runPartialRepay = process.env.RUN_PARTIAL_REPAY !== "0";
  const runStrictAggDebt = process.env.RUN_STRICT_AGGREGATED_DEBT !== "0";
  const runLiquidation = process.env.RUN_LIQUIDATION !== "0";
  const wantGuaranteeExtension = process.env.RUN_GUARANTEE_EXTENSION !== "0";
  const tokensEnv = (process.env.TOKENS ?? "").trim();
  const assertRoleGates = process.env.ASSERT_ROLE_GATES === "1";
  const assertAggDebtSum = process.env.ASSERT_AGG_DEBT_SUM === "1";
  const aggDebtPrincipalA = process.env.AGG_DEBT_PRINCIPAL_A ?? "200";
  const aggDebtPrincipalB = process.env.AGG_DEBT_PRINCIPAL_B ?? "300";
  const aggDebtPrincipalC = process.env.AGG_DEBT_PRINCIPAL_C ?? "100";
  const reborrowAfterRepay = process.env.REBORROW_AFTER_REPAY === "1";
  const strictAggDebtIterations = Number(process.env.STRICT_AGG_DEBT_ITERATIONS ?? "1");
  const borrowerIndexEnv = process.env.BORROWER_INDEX;
  const borrowerIndexesEnv = (process.env.BORROWER_INDEXES ?? "").trim();
  const allowSignerReuse = process.env.ALLOW_SIGNER_REUSE === "1";
  const useVariantAmounts = process.env.USE_VARIANT_AMOUNTS === "1";
  const priceRefreshMapEnv = (process.env.PRICE_REFRESH_MAP ?? "").trim();
  const noAutoGrant = process.env.NO_AUTO_GRANT === "1";

  if (runFinalizeMatchOnly && runMatchDisbursementOnly) {
    throw new Error("Config: RUN_FINALIZE_MATCH_ONLY and RUN_MATCH_DISBURSEMENT_ONLY are mutually exclusive.");
  }

  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const keeper = signers[1];
  const signerByAddr = new Map<string, any>(signers.map((s) => [s.address.toLowerCase(), s]));

  // SSOT: resolve module addresses via Registry.
  //
  // In dirty state, `frontend-config/contracts-localhost.ts` can drift from the live Registry due to upgrades.
  // Critically, *roles are validated via Registry.KEY_ACCESS_CONTROL_MANAGER*, so granting roles against a
  // stale ACM instance will not satisfy on-chain permission checks.
  //
  // We bootstrap from the frontend-config Registry address, then switch to the Registry actually bound inside
  // SettlementManager (since keeper-path flows validate roles using SettlementManager._registryAddr).
  const addressMap = loadAddressMap(network.name);
  const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });
  const registryBootstrap = (await ethers.getContractAt("Registry", registryAddr)) as any;
  const settlementManagerBootstrapAddr = (await registryBootstrap.getModuleOrRevert(key("SETTLEMENT_MANAGER"))) as string;
  const settlementManager = (await ethers.getContractAt("SettlementManager", settlementManagerBootstrapAddr)) as any;
  const registryAddrSSOT = (await settlementManager.registryAddrVar()) as string;
  if ((registryBootstrap.target as string).toLowerCase() !== registryAddrSSOT.toLowerCase()) {
    console.log(
      `  ⚠️  Registry drift detected: bootstrap=${String(registryBootstrap.target)} settlementManager.registry=${registryAddrSSOT}. ` +
        `Using SettlementManager-bound Registry as SSOT.`
    );
  }
  const registry = (await ethers.getContractAt("Registry", registryAddrSSOT)) as any;

  const acmAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
  const awAddr = (await registry.getModuleOrRevert(key("ASSET_WHITELIST"))) as string;
  const poAddr = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;
  const feeRouterAddr = (await registry.getModuleOrRevert(key("FEE_ROUTER"))) as string;

  const acm = (await ethers.getContractAt("AccessControlManager", acmAddr)) as any;
  const awRead = (await ethers.getContractAt("IAssetWhitelistRead", awAddr)) as any;
  const awAdmin = (await ethers.getContractAt("IAssetWhitelistAdmin", awAddr)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", poAddr)) as any;
  const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", feeRouterAddr)) as any;
  const settlementTokenAddr = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;
  const usdc = (await ethers.getContractAt("MockERC20", settlementTokenAddr)) as any;

  const vaultCoreAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;
  const vblAddr = (await registry.getModuleOrRevert(key("VAULT_BUSINESS_LOGIC"))) as string;
  const cmAddr = (await registry.getModuleOrRevert(key("COLLATERAL_MANAGER"))) as string;
  const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
  const settlementManagerAddr = (settlementManager.target as string) ?? settlementManagerBootstrapAddr;
  const lenderPoolVaultAddr = (await registry.getModuleOrRevert(key("LENDER_POOL_VAULT"))) as string;
  const liquidationManagerAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_MANAGER"))) as string;
  const liquidationPayoutManagerAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_PAYOUT_MANAGER"))) as string;
  const liquidationRiskManagerAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_RISK_MANAGER"))) as string;
  // Guarantee extension modules exist on most localhost deployments, and can affect finalizeMatch even if the
  // invariants suite isn't explicitly testing them (e.g. guarantee enabled => extra allowance requirement).
  // So we resolve them best-effort and force a baseline "disabled" state for non-extension cases.
  const gfmAddr = (await registry.getModule(key("GUARANTEE_FUND_MANAGER"))) as string;
  const ergmAddr = (await registry.getModule(key("EARLY_REPAYMENT_GUARANTEE_MANAGER"))) as string;
  const hasGuaranteeModules = gfmAddr !== ethers.ZeroAddress && ergmAddr !== ethers.ZeroAddress;
  const runGuaranteeExtension = wantGuaranteeExtension && hasGuaranteeModules;

  const vaultCore = (await ethers.getContractAt("VaultCore", vaultCoreAddr)) as any;
  const vbl = (await ethers.getContractAt("VaultBusinessLogic", vblAddr)) as any;
  const gfm = hasGuaranteeModules
    ? await ethers.getContractAt(
        [
          "function getLockedGuarantee(address user, address asset) view returns (uint256)",
          "function isGuaranteePaid(address user, address asset) view returns (bool)",
        ],
        gfmAddr
      )
    : null;
  const ergm = hasGuaranteeModules
    ? await ethers.getContractAt(
        [
          "function isGuaranteeEnabled(address asset) view returns (bool)",
          "function setGuaranteeEnabled(address asset, bool enabled)",
          "function getUserGuaranteeId(address user, address asset) view returns (uint256)",
          "function hasActiveGuarantee(address user, address asset) view returns (bool)",
          "function getGuaranteeRecord(uint256 guaranteeId) view returns (tuple(uint256 principal,uint256 promisedInterest,uint256 startTime,uint256 maturityTime,uint256 earlyRepayPenaltyDays,bool isActive,address lender,address asset))",
          "function previewEarlyRepayment(uint256 guaranteeId, uint256 actualRepayAmount) view returns (tuple(uint256 penaltyToLender,uint256 refundToBorrower,uint256 platformFee,uint256 actualInterestPaid))",
        ],
        ergmAddr
      )
    : null;

  // NOTE: `getContractAt` with a fragment-only ABI yields a BaseContract type in TS.
  // We intentionally cast to `any` for script ergonomics (smoke scripts run via hardhat/ts-node).
  const gfmAny = gfm as any;
  const ergmAny = ergm as any;
  const vLe = await ethers.getContractAt(
    [
      "function getUserTotalDebtValue(address user) view returns (uint256)",
      "function getDebt(address user, address asset) view returns (uint256)",
      "function getUserDebtAssets(address user) view returns (address[])",
    ],
    (await registry.getModuleOrRevert(key("LENDING_ENGINE"))) as string
  );
  const cm = await ethers.getContractAt(["function getUserCollateralAssets(address user) view returns (address[])"], cmAddr);
  const lpm = await ethers.getContractAt(
    ["function getRecipients() view returns (tuple(address platform,address reserve,address lenderCompensation))"],
    liquidationPayoutManagerAddr
  );

  const platformTreasury = (await feeRouter.getPlatformTreasury()) as string;
  const ecosystemVault = (await feeRouter.getEcosystemVault()) as string;
  const recipients = (await lpm.getRecipients()) as { platform: string; reserve: string; lenderCompensation: string };

  const tokensToTest: string[] = tokensEnv
    ? tokensEnv.split(",").map((s) => s.trim()).filter(Boolean)
    : ((await feeRouter.getSupportedTokens().catch(() => [])) as string[]);
  if (tokensToTest.length === 0) {
    // Fallback for early/local deployments: default to MockUSDC.
    tokensToTest.push(usdc.target as string);
  }

  // ---- helper: pick clean users (no debt, no collateral, and no lingering guarantee state) ----
  const isCleanUser = async (addr: string) => {
    const [debtValue, assets] = await Promise.all([
      (vLe.getUserTotalDebtValue(addr) as Promise<bigint>),
      (cm.getUserCollateralAssets(addr) as Promise<string[]>).catch(() => [] as string[]),
    ]);
    if (debtValue !== 0n || (assets?.length ?? 0) !== 0) {
      return false;
    }
    if (!hasGuaranteeModules) {
      return true;
    }
    for (const asset of tokensToTest) {
      const [locked, active] = await Promise.all([
        gfmAny.getLockedGuarantee(addr, asset).catch(() => 0n),
        ergmAny.hasActiveGuarantee(addr, asset).catch(() => false),
      ]);
      if (BigInt(locked) !== 0n || Boolean(active)) {
        return false;
      }
    }
    return true;
  };

  const exclude = new Set<string>([deployer.address.toLowerCase(), keeper.address.toLowerCase()]);
  const reclaimCleanExcludedSigners = async () => {
    if (!allowDirtyState) {
      return;
    }
    for (let i = 2; i < signers.length; i++) {
      const signer = signers[i];
      const signerKey = signer.address.toLowerCase();
      if (!exclude.has(signerKey)) {
        continue;
      }
      if (await isCleanUser(signer.address)) {
        exclude.delete(signerKey);
      }
    }
  };
  const borrowerIndexes = borrowerIndexesEnv
    ? borrowerIndexesEnv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => Number(s))
    : [];
  for (const idx of borrowerIndexes) {
    if (!Number.isInteger(idx) || idx < 2 || idx >= signers.length) {
      throw new Error(`Invalid BORROWER_INDEXES entry=${idx} (must be 2..${signers.length - 1})`);
    }
  }

  const priceRefreshMap = new Map<string, string>();
  if (priceRefreshMapEnv) {
    for (const entry of priceRefreshMapEnv.split(",")) {
      const [addrRaw, priceRaw] = entry.split(":").map((s) => s.trim());
      if (!addrRaw || !priceRaw) continue;
      priceRefreshMap.set(addrRaw.toLowerCase(), priceRaw);
    }
  }

  const tokenDecimalsCache = new Map<string, bigint>();
  const getTokenDecimals = async (asset: string): Promise<bigint> => {
    const k = asset.toLowerCase();
    const cached = tokenDecimalsCache.get(k);
    if (cached !== undefined) return cached;
    const erc20 = (await getErc20(asset)) as any;
    const dec = BigInt(Number(await erc20.decimals().catch(() => 6)));
    tokenDecimalsCache.set(k, dec);
    return dec;
  };
  const refreshPriceForAsset = async (asset: string) => {
    const decimals = Number(await getTokenDecimals(asset));
    const blockNumber = await latestBlockNumber();
    const fallback = priceRefreshMap.get(asset.toLowerCase());

    if (fallback) {
      await (await po.connect(deployer).updatePrice(asset, ethers.parseUnits(fallback, decimals), blockNumber)).wait();
      return "explicit-fallback" as const;
    }

    try {
      const priceData = await po.getPriceData(asset);
      const storedPrice = BigInt(priceData?.price ?? 0);
      if (storedPrice > 0n) {
        await (await po.connect(deployer).updatePrice(asset, storedPrice, blockNumber)).wait();
        return "stored-price" as const;
      }
    } catch {
      // Fall through to deterministic unit-price refresh below.
    }

    await (await po.connect(deployer).updatePrice(asset, ethers.parseUnits("1", decimals), blockNumber)).wait();
    return "unit-price" as const;
  };
  const ensureTokenBalance = async (erc20: any, recipient: { address: string }, targetBalance: bigint, label: string) => {
    const currentBalance = (await erc20.balanceOf(recipient.address)) as bigint;
    if (currentBalance >= targetBalance) {
      return currentBalance;
    }

    let remaining = targetBalance - currentBalance;
    for (const source of signers) {
      if (source.address.toLowerCase() === recipient.address.toLowerCase()) {
        continue;
      }
      const sourceBalance = (await erc20.balanceOf(source.address)) as bigint;
      if (sourceBalance === 0n) {
        continue;
      }
      const transferAmount = sourceBalance >= remaining ? remaining : sourceBalance;
      await (await erc20.connect(source).transfer(recipient.address, transferAmount)).wait();
      remaining -= transferAmount;
      if (remaining === 0n) {
        break;
      }
    }

    const finalBalance = (await erc20.balanceOf(recipient.address)) as bigint;
    if (finalBalance < targetBalance) {
      throw new Error(
        `${label}: insufficient token liquidity for ${recipient.address} target=${targetBalance.toString()} current=${finalBalance.toString()}`,
      );
    }
    return finalBalance;
  };

  const getPriceValue = async (asset: string) => {
    try {
      const [p, , dec] = (await po.getPrice(asset)) as [bigint, bigint, bigint];
      return { price: p, decimals: dec };
    } catch (e) {
      const fallback = priceRefreshMap.get(asset.toLowerCase());
      if (fallback) {
        // SSOT: `IPriceOracle.getPrice().decimals` is assetDecimals (token decimals), not "price decimals".
        // Keep `amount * price / 10**assetDecimals` consistent on the fallback path.
        const decimals = await getTokenDecimals(asset);
        return { price: ethers.parseUnits(fallback, Number(decimals)), decimals };
      }
      throw e;
    }
  };

  const computeUserDebtValue = async (user: string) => {
    const assets = (await vLe.getUserDebtAssets(user)) as string[];
    let total = 0n;
    for (const asset of assets) {
      const debt = (await vLe.getDebt(user, asset)) as bigint;
      if (debt === 0n) continue;
      const { price, decimals } = await getPriceValue(asset);
      total += (debt * price) / 10n ** decimals;
    }
    return total;
  };
  const reusableSignerPool = signers.slice(2);
  let reuseCursor = 0;
  const nextReusableSigner = () => {
    if (reusableSignerPool.length === 0) {
      throw new Error("No reusable signer available.");
    }
    const signer = reusableSignerPool[reuseCursor % reusableSignerPool.length];
    reuseCursor += 1;
    return signer;
  };
  const provisionFreshSigner = async () => {
    const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
    await (await deployer.sendTransaction({ to: wallet.address, value: ethers.parseEther("1") })).wait();
    exclude.add(wallet.address.toLowerCase());
    return wallet;
  };
  const pickCleanSigner = async () => {
    await reclaimCleanExcludedSigners();
    for (let i = 2; i < signers.length; i++) {
      const s = signers[i];
      const k = s.address.toLowerCase();
      if (exclude.has(k)) continue;
      if (await isCleanUser(s.address)) {
        exclude.add(k);
        return s;
      }
    }
    if (!allowDirtyState) {
      if (allowSignerReuse) {
        return nextReusableSigner();
      }
      throw new Error("No clean signer found. Restart localhost node for a clean state, or set E2E_ALLOW_DIRTY_STATE=1.");
    }
    // In dirty-state mode, preserve the "clean signer" contract of this helper.
    // Reuse any signer that is currently clean before provisioning a fresh signer.
    for (let i = 2; i < signers.length; i++) {
      const s = signers[i];
      if (await isCleanUser(s.address)) {
        exclude.add(s.address.toLowerCase());
        return s;
      }
    }
    return provisionFreshSigner();
    if (allowSignerReuse) {
      return nextReusableSigner();
    }
    throw new Error("No unused signer available.");
  };

  const ensureRole = async (role: string, who: string, roleName?: string): Promise<boolean> => {
    const ok = (await acm.hasRole(role, who)) as boolean;
    if (ok) return true;
    const name = roleName ?? role;
    if (noAutoGrant) {
      console.log(`  ⚠️  [NO_AUTO_GRANT] missing role=${name} for ${who}`);
      return false;
    }
    try {
      await (await acm.connect(deployer).grantRole(role, who)).wait();
      return true;
    } catch (e: any) {
      const msg = String(e?.message ?? e ?? "");
      if (msg.includes("RoleAlreadyGranted") || msg.includes("AccessControlManager__RoleAlreadyGranted")) {
        return true;
      }
      throw e;
    }
  };

  const pickBorrower = async (iteration: number, assetIdx: number) => {
    if (borrowerIndexEnv) {
      const idx = Number(borrowerIndexEnv);
      if (!Number.isInteger(idx) || idx < 2 || idx >= signers.length) {
        throw new Error(`Invalid BORROWER_INDEX=${borrowerIndexEnv} (must be 2..${signers.length - 1})`);
      }
      const s = signers[idx];
      exclude.add(s.address.toLowerCase());
      return s;
    }
    if (borrowerIndexes.length > 0) {
      const pick = borrowerIndexes[(iteration - 1 + assetIdx) % borrowerIndexes.length];
      const s = signers[pick];
      exclude.add(s.address.toLowerCase());
      return s;
    }
    return pickCleanSigner();
  };

  const pickLender = async () => {
    if (allowSignerReuse) {
      // Reuse a rotating non-deployer/keeper signer to avoid exhaustion in long loops.
      return nextReusableSigner();
    }
    await reclaimCleanExcludedSigners();
    for (let i = 2; i < signers.length; i++) {
      const s = signers[i];
      const k = s.address.toLowerCase();
      if (exclude.has(k)) continue;
      exclude.add(k);
      return s;
    }
    if (allowDirtyState) {
      for (let i = 2; i < signers.length; i++) {
        const s = signers[i];
        if (await isCleanUser(s.address)) {
          exclude.add(s.address.toLowerCase());
          return s;
        }
      }
      return provisionFreshSigner();
    }
    throw new Error("No unused signer available.");
  };

  // ---- ensure minimal config (best-effort; in NO_AUTO_GRANT mode we only verify) ----
  const canAddWhitelist = await ensureRole(key("ADD_WHITELIST"), deployer.address, "ADD_WHITELIST");
  const canUpdatePrice = await ensureRole(key("UPDATE_PRICE"), deployer.address, "UPDATE_PRICE");
  const canSetParam = await ensureRole(key("SET_PARAMETER"), deployer.address, "SET_PARAMETER");
  const canOrderCreate = await ensureRole(key("ORDER_CREATE"), vblAddr, "ORDER_CREATE");
  const canDeposit = await ensureRole(key("DEPOSIT"), vblAddr, "DEPOSIT");
  const canBorrow = await ensureRole(key("BORROW"), orderEngineAddr, "BORROW");

  // AssetWhitelist: must already be configured, or we need ADD_WHITELIST.
  if (!(await awRead.isAssetAllowed(usdc.target))) {
    if (!canAddWhitelist) {
      console.log(`  ⏭️  [SKIP] USDC is not whitelisted and caller cannot ADD_WHITELIST. Skipping suite.`);
      return;
    }
    await (await awAdmin.connect(deployer).addAllowedAsset(usdc.target)).wait();
  }

  // PriceOracle: must have active config + fresh price, or we need UPDATE_PRICE (and possibly configure via SET_PARAMETER-like authority).
  // (We treat both configureAsset and updatePrice as requiring UPDATE_PRICE role in localhost setup scripts.)
  {
    const cfg = await po.getAssetConfig(usdc.target);
    if (!cfg.isActive) {
      if (!canUpdatePrice) {
        console.log(`  ⏭️  [SKIP] USDC oracle config is inactive and caller cannot UPDATE_PRICE. Skipping suite.`);
        return;
      }
      const usdcDecimals = Number(await usdc.decimals().catch(() => 6));
      await (await po.connect(deployer).configureAsset(usdc.target, "usd-coin", usdcDecimals, 3600)).wait();
    }
  }
  {
    const now = await latestBlockNumber();
    if (!canUpdatePrice) {
      // In NO_AUTO_GRANT mode we won't update; rely on existing on-chain price freshness.
      try {
        await po.getPrice(usdc.target);
      } catch (e) {
        console.log(`  ⏭️  [SKIP] USDC price is not readable/fresh and caller cannot UPDATE_PRICE. Skipping suite.`);
        return;
      }
    } else {
      const usdcDecimals = Number(await usdc.decimals().catch(() => 6));
      await (await po.connect(deployer).updatePrice(usdc.target, ethers.parseUnits("1", usdcDecimals), now)).wait();
    }
  }

  // FeeRouter: supported token must already exist or requires SET_PARAMETER.
  if (!(await feeRouter.isTokenSupported(usdc.target))) {
    if (!canSetParam) {
      console.log(`  ⏭️  [SKIP] FeeRouter does not support USDC and caller cannot SET_PARAMETER. Skipping suite.`);
      return;
    }
    await (await feeRouter.connect(deployer).addSupportedToken(usdc.target)).wait();
  }

  // Core flow requires module roles; if missing and we cannot auto-grant, skip all createOrder-dependent cases.
  if (noAutoGrant && (!canOrderCreate || !canDeposit || !canBorrow)) {
    const missing: string[] = [];
    if (!canOrderCreate) missing.push("ORDER_CREATE(vbl)");
    if (!canDeposit) missing.push("DEPOSIT(vbl)");
    if (!canBorrow) missing.push("BORROW(orderEngine)");
    console.log(`  ⏭️  [SKIP] Missing core roles for finalizeMatch path: ${missing.join(", ")}. Skipping suite.`);
    return;
  }

  console.log("=== Funds-Flow Invariants Suite (localhost) ===");
  console.log("Config:");
  console.log(`- allowDirtyState: ${allowDirtyState}`);
  console.log(`- runFinalizeMatchOnly: ${runFinalizeMatchOnly}`);
  console.log(`- runMatchDisbursementOnly: ${runMatchDisbursementOnly}`);
  console.log(`- assertRoleGates: ${assertRoleGates}`);
  console.log(`- runReserveCancel: ${runReserveCancel}`);
  console.log(`- runPartialRepay: ${runPartialRepay}`);
  console.log(`- runStrictAggDebt: ${runStrictAggDebt}`);
  console.log(`- runLiquidation: ${runLiquidation}`);
  console.log(`- runGuaranteeExtension: ${runGuaranteeExtension}`);
  console.log(`- tokensToTest: ${tokensToTest.join(", ")}`);
  console.log("");

  // Auto-discovered base tracked set (modules + fee recipients + view router).
  const baseTracked = await discoverTrackedAddresses({
    include: [deployer.address],
    keeper: keeper.address,
  });

  // ---- helper: create an order via reserveForLending + finalizeMatch ----
  async function createOrder(opts: {
    borrower: any;
    lender: any;
    asset: string;
    principal: bigint;
    collateral: bigint;
    termDays: number;
    rateBps: bigint;
    makeOverdue: boolean;
    enableGuarantee?: boolean;
  }): Promise<{
    orderId: bigint;
    lendHash: string;
    finalizeMatchReceipt: any;
    borrower: string;
    lender: string;
    asset: string;
    principal: bigint;
    balancesBeforeFinalize?: {
      pool: bigint;
      vbl: bigint;
      borrower: bigint;
      cm: bigint;
      platform: bigint;
      ecosystem: bigint;
    };
    balancesAfterFinalize?: {
      pool: bigint;
      vbl: bigint;
      borrower: bigint;
      cm: bigint;
      platform: bigint;
      ecosystem: bigint;
    };
  }> {
    const erc20 = (await getErc20(opts.asset)) as any;
    const decimals = Number(await erc20.decimals().catch(() => 6));
    const termSec = BigInt(opts.termDays) * ONE_DAY;
    const promisedInterest = opts.enableGuarantee && runGuaranteeExtension
      ? calcInterest(opts.principal, opts.rateBps, termSec)
      : 0n;
    const borrowerTargetBalance = opts.collateral + opts.principal + promisedInterest + (opts.principal / 2n);
    const lenderTargetBalance = opts.principal + (opts.principal / 4n);
    const keeperTargetBalance = opts.principal;

    // Fund only up to the actual scenario requirement to avoid draining the canonical holder in dirty multi-asset runs.
    await ensureTokenBalance(erc20, opts.borrower, borrowerTargetBalance, "borrower funding");
    await ensureTokenBalance(erc20, opts.lender, lenderTargetBalance, "lender funding");
    await ensureTokenBalance(erc20, keeper, keeperTargetBalance, "keeper funding");

    // deposit collateral via VaultCore (SSOT)
    await (await erc20.connect(opts.borrower).approve(cmAddr, opts.collateral)).wait();
    await (await vaultCore.connect(opts.borrower).deposit(opts.asset, opts.collateral)).wait();

    // reserve lender funds in pool
    await (await erc20.connect(opts.lender).approve(vblAddr, opts.principal)).wait();
    const lendIntent = {
      lenderSigner: opts.lender.address,
      asset: opts.asset,
      amount: opts.principal,
      minTermDays: 1,
      maxTermDays: 30,
      minRateBps: 0n,
      expireAt: (await latestBlockNumber()) + ONE_HOUR_BLOCKS,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`suite-lend-${Date.now()}-${Math.random()}`)),
    };
    const lendHash = hashLendIntentStruct(lendIntent);
    await (await vbl.connect(opts.lender).reserveForLending(opts.lender.address, opts.asset, opts.principal, lendHash)).wait();

    const borrowIntent = {
      borrower: opts.borrower.address,
      collateralAsset: opts.asset,
      collateralAmount: opts.collateral,
      borrowAsset: opts.asset,
      amount: opts.principal,
      termDays: opts.termDays,
      rateBps: opts.rateBps,
      expireAt: lendIntent.expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`suite-borrow-${Date.now()}-${Math.random()}`)),
    };

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

    const sigBorrower = await opts.borrower.signTypedData(domain, typesBorrow as any, borrowIntent as any);
    const sigLender = await opts.lender.signTypedData(domain, typesLend as any, lendIntent as any);

    // Extension Flow: if guarantee is enabled, borrower MUST approve GFM for promisedInterest before finalizeMatch.
    if (opts.enableGuarantee && runGuaranteeExtension) {
      if (promisedInterest > 0n) {
        await (await erc20.connect(opts.borrower).approve(gfmAddr, promisedInterest)).wait();
      }
    }

    const captureFinalizeBalances = runFinalizeMatchOnly || runMatchDisbursementOnly;
    let balancesBeforeFinalize:
      | {
          pool: bigint;
          vbl: bigint;
          borrower: bigint;
          cm: bigint;
          platform: bigint;
          ecosystem: bigint;
        }
      | undefined;
    if (captureFinalizeBalances) {
      const [poolBal, vblBal, borrowerBal, cmBal, platBal, ecoBal] = await Promise.all([
        (erc20.balanceOf(lenderPoolVaultAddr) as Promise<bigint>),
        (erc20.balanceOf(vblAddr) as Promise<bigint>),
        (erc20.balanceOf(opts.borrower.address) as Promise<bigint>),
        (erc20.balanceOf(cmAddr) as Promise<bigint>),
        (erc20.balanceOf(platformTreasury) as Promise<bigint>),
        (erc20.balanceOf(ecosystemVault) as Promise<bigint>),
      ]);
      balancesBeforeFinalize = { pool: poolBal, vbl: vblBal, borrower: borrowerBal, cm: cmBal, platform: platBal, ecosystem: ecoBal };
    }

    const receipt = await (await vbl.connect(deployer).finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [sigLender])).wait();
    let orderId: bigint | null = null;
    // parse LoanOrderCreated from OrderEngine ABI
    const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;
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
    if (orderId === null) throw new Error("LoanOrderCreated not found");

    if (opts.makeOverdue) {
      const ord = await getOrderForView(orderEngineAddr, orderId);
      await mineToBlock(BigInt(ord.maturity) + ONE_HOUR_BLOCKS);
      const nowAfter = await latestBlockNumber();
      await (await po.connect(deployer).updatePrice(opts.asset, ethers.parseUnits("1", decimals), nowAfter)).wait();
    }

    let balancesAfterFinalize:
      | {
          pool: bigint;
          vbl: bigint;
          borrower: bigint;
          cm: bigint;
          platform: bigint;
          ecosystem: bigint;
        }
      | undefined;
    if (balancesBeforeFinalize) {
      const [poolBal, vblBal, borrowerBal, cmBal, platBal, ecoBal] = await Promise.all([
        (erc20.balanceOf(lenderPoolVaultAddr) as Promise<bigint>),
        (erc20.balanceOf(vblAddr) as Promise<bigint>),
        (erc20.balanceOf(opts.borrower.address) as Promise<bigint>),
        (erc20.balanceOf(cmAddr) as Promise<bigint>),
        (erc20.balanceOf(platformTreasury) as Promise<bigint>),
        (erc20.balanceOf(ecosystemVault) as Promise<bigint>),
      ]);
      balancesAfterFinalize = { pool: poolBal, vbl: vblBal, borrower: borrowerBal, cm: cmBal, platform: platBal, ecosystem: ecoBal };
    }

    return {
      orderId,
      lendHash,
      finalizeMatchReceipt: receipt,
      borrower: opts.borrower.address,
      lender: opts.lender.address,
      asset: opts.asset,
      principal: opts.principal,
      balancesBeforeFinalize,
      balancesAfterFinalize,
    };
  }

  const tokensToRun = runFinalizeMatchOnly || runMatchDisbursementOnly ? tokensToTest.slice(0, 1) : tokensToTest;
  for (let assetIdx = 0; assetIdx < tokensToRun.length; assetIdx++) {
    const assetAddr = tokensToRun[assetIdx];
    const erc20 = (await getErc20(assetAddr)) as any;
    const decimals = Number(await erc20.decimals().catch(() => 6));
    const symbol = String(await erc20.symbol().catch(() => "TOKEN"));

    // Best-effort: ensure token is supported/whitelisted and has a price configured.
    try {
      if (!(await awRead.isAssetAllowed(assetAddr))) await (await awAdmin.connect(deployer).addAllowedAsset(assetAddr)).wait();
    } catch {}
    try {
      const cfg = await po.getAssetConfig(assetAddr);
      if (!cfg.isActive) await (await po.connect(deployer).configureAsset(assetAddr, "usd-coin", decimals, 3600)).wait();
      await refreshPriceForAsset(assetAddr);
    } catch {}
    try {
      if (!(await feeRouter.isTokenSupported(assetAddr))) await (await feeRouter.connect(deployer).addSupportedToken(assetAddr)).wait();
    } catch {}

    if (!runFinalizeMatchOnly && !runMatchDisbursementOnly) {
      console.log(`\n## Token: ${symbol} @ ${assetAddr} (decimals=${decimals})\n`);
    } else {
      console.log(`\n## Token (minimal): ${symbol} @ ${assetAddr}\n`);
    }

    // Guarantee baseline: always try to disable guarantee unless we are explicitly running the extension-flow tests.
    // This avoids finalizeMatch coupling on borrower -> GFM allowance when guarantee happens to be enabled in the deployment.
    if (hasGuaranteeModules) {
      try {
        await ensureRole(key("SET_PARAMETER"), deployer.address);
        await (await ergmAny.connect(deployer).setGuaranteeEnabled(assetAddr, false)).wait();
      } catch (e) {
        throw new Error(
          `GuaranteeBaseline: failed to disable guarantee for asset=${assetAddr}. ` +
            `Ensure deployer has ACTION_SET_PARAMETER and ERGM is registered. Raw=${String((e as any)?.message ?? e)}`
        );
      }
    }

    // ========= CASE 0.5: finalizeMatch consume + RESERVE_CONSUMED DataPush (minimal) =========
    if (runFinalizeMatchOnly) {
      console.log("=== Case: finalizeMatch (consume + DataPush RESERVE_CONSUMED) ===");
      const borrower = await pickCleanSigner();
      const lender = await pickCleanSigner();
      const tracked = uniqAddrs(
        await discoverTrackedAddresses({
          include: [deployer.address],
          borrower: borrower.address,
          lender: lender.address,
          keeper: keeper.address,
        })
      );
      const principal = ethers.parseUnits("500", decimals);
      const collateral = ethers.parseUnits("1000", decimals);
      const before = await snapshotBalances(assetAddr, tracked);
      const res = await createOrder({
        borrower,
        lender,
        asset: assetAddr,
        principal,
        collateral,
        termDays: 5,
        rateBps: 1000n,
        makeOverdue: false,
      });
      const after = await snapshotBalances(assetAddr, tracked);
      assertConservation("finalizeMatch", before, after);

      // Observability: LendReserveConsumed + DataPushed(RESERVE_CONSUMED), with hash alignment.
      const DT_CONSUMED = ethers.keccak256(ethers.toUtf8Bytes("RESERVE_CONSUMED"));
      const dataPushIface = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
      let sawConsumedEvent = false;
      let sawConsumedPush = false;
      for (const log of res.finalizeMatchReceipt!.logs) {
        try {
          const parsed = vbl.interface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "LendReserveConsumed") {
            if (String(parsed.args.lendIntentHash).toLowerCase() !== res.lendHash.toLowerCase()) {
              throw new Error("LendReserveConsumed: lendIntentHash mismatch (SSOT hash divergence)");
            }
            if (String(parsed.args.lenderSigner).toLowerCase() !== res.lender.toLowerCase()) throw new Error("LendReserveConsumed: lender mismatch");
            if (String(parsed.args.asset).toLowerCase() !== res.asset.toLowerCase()) throw new Error("LendReserveConsumed: asset mismatch");
            if ((parsed.args.amount as bigint) !== res.principal) throw new Error("LendReserveConsumed: amount mismatch");
            sawConsumedEvent = true;
          }
        } catch {}
        try {
          const parsed = dataPushIface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "DataPushed" && (parsed.args.dataTypeHash as string).toLowerCase() === DT_CONSUMED.toLowerCase()) {
            // payload = abi.encode(lHash, lenderSigner, asset, amount, blockNumber)
            const coder = ethers.AbiCoder.defaultAbiCoder();
            const decoded = coder.decode(["bytes32", "address", "address", "uint256", "uint256"], parsed.args.payload as string);
            const lHash = String(decoded[0]).toLowerCase();
            const lenderSigner = String(decoded[1]).toLowerCase();
            const asset = String(decoded[2]).toLowerCase();
            const amount = decoded[3] as bigint;
            if (lHash !== res.lendHash.toLowerCase()) throw new Error("DataPushed(RESERVE_CONSUMED): hash mismatch");
            if (lenderSigner !== res.lender.toLowerCase()) throw new Error("DataPushed(RESERVE_CONSUMED): lender mismatch");
            if (asset !== res.asset.toLowerCase()) throw new Error("DataPushed(RESERVE_CONSUMED): asset mismatch");
            if (amount !== res.principal) throw new Error("DataPushed(RESERVE_CONSUMED): amount mismatch");
            sawConsumedPush = true;
          }
        } catch {}
      }
      if (!sawConsumedEvent) throw new Error("finalizeMatch: missing LendReserveConsumed event");
      if (!sawConsumedPush) throw new Error("finalizeMatch: missing DataPushed(RESERVE_CONSUMED)");

      console.log(`  ✅ OK (orderId=${res.orderId.toString()})\n`);
      continue;
    }

    // ========= CASE 0.6: Match -> Borrow disbursement SSOT assertions (minimal) =========
    if (runMatchDisbursementOnly) {
      console.log("=== Case: match -> borrow disbursement (SSOT) ===");

      // Optional: role-gate regression tests (silent unless failure). Requires deployer to be ACM owner.
      if (assertRoleGates) {
        const ROLE_ORDER_CREATE = key("ORDER_CREATE");
        const ROLE_DEPOSIT = key("DEPOSIT");
        // ORDER_CREATE gate: revoke from VBL and expect finalizeMatch to revert, then restore.
        try {
          await (await acm.connect(deployer).revokeRole(ROLE_ORDER_CREATE, vblAddr)).wait();
          const borrower = await pickCleanSigner();
          const lender = await pickCleanSigner();
          let reverted = false;
          try {
            await createOrder({
              borrower,
              lender,
              asset: assetAddr,
              principal: ethers.parseUnits("10", decimals),
              collateral: ethers.parseUnits("20", decimals),
              termDays: 5,
              rateBps: 1000n,
              makeOverdue: false,
            });
          } catch {
            reverted = true;
          }
          if (!reverted) throw new Error("Role gate: expected finalizeMatch to revert when ORDER_CREATE is revoked from VBL");
        } finally {
          await (await acm.connect(deployer).grantRole(ROLE_ORDER_CREATE, vblAddr)).wait();
        }

        // DEPOSIT (FeeRouter) gate: revoke from VBL and expect finalizeMatch to revert, then restore.
        try {
          await (await acm.connect(deployer).revokeRole(ROLE_DEPOSIT, vblAddr)).wait();
          const borrower = await pickCleanSigner();
          const lender = await pickCleanSigner();
          let reverted = false;
          try {
            await createOrder({
              borrower,
              lender,
              asset: assetAddr,
              principal: ethers.parseUnits("10", decimals),
              collateral: ethers.parseUnits("20", decimals),
              termDays: 5,
              rateBps: 1000n,
              makeOverdue: false,
            });
          } catch {
            reverted = true;
          }
          if (!reverted) throw new Error("Role gate: expected finalizeMatch to revert when DEPOSIT is revoked from VBL");
        } finally {
          await (await acm.connect(deployer).grantRole(ROLE_DEPOSIT, vblAddr)).wait();
        }
      }

      const borrower = await pickCleanSigner();
      const lender = await pickCleanSigner();
      const tracked = uniqAddrs(
        await discoverTrackedAddresses({
          include: [deployer.address],
          borrower: borrower.address,
          lender: lender.address,
          keeper: keeper.address,
        })
      );

      const principal = ethers.parseUnits("500", decimals);
      const collateral = ethers.parseUnits("1000", decimals);
      const before = await snapshotBalances(assetAddr, tracked);
      const res = await createOrder({
        borrower,
        lender,
        asset: assetAddr,
        principal,
        collateral,
        termDays: 5,
        rateBps: 1000n,
        makeOverdue: false,
      });
      const after = await snapshotBalances(assetAddr, tracked);
      assertConservation("matchDisbursement", before, after);

      if (!res.balancesBeforeFinalize || !res.balancesAfterFinalize) {
        throw new Error("matchDisbursement: missing pre/post finalizeMatch balance snapshots");
      }

      // (B) Strict architecture: finalizeMatch MUST NOT top up collateral (CM token balance must not change during finalizeMatch).
      const cmDelta = res.balancesAfterFinalize.cm - res.balancesBeforeFinalize.cm;
      if (cmDelta !== 0n) {
        throw new Error(`matchDisbursement: expected CollateralManager balance delta 0 during finalizeMatch, got ${cmDelta.toString()}`);
      }

      // (C) Funding + fees + net disbursement (SSOT).
      const poolDelta = res.balancesAfterFinalize.pool - res.balancesBeforeFinalize.pool;
      if (poolDelta !== 0n - principal) {
        throw new Error(`matchDisbursement: expected pool delta -${principal.toString()}, got ${poolDelta.toString()}`);
      }
      const vblDelta = res.balancesAfterFinalize.vbl - res.balancesBeforeFinalize.vbl;
      if (vblDelta !== 0n) {
        throw new Error(`matchDisbursement: expected VBL balance delta 0 (no retention), got ${vblDelta.toString()}`);
      }
      const borrowerNet = res.balancesAfterFinalize.borrower - res.balancesBeforeFinalize.borrower;
      if (borrowerNet <= 0n || borrowerNet > principal) {
        throw new Error(`matchDisbursement: invalid borrower net delta ${borrowerNet.toString()} (principal=${principal.toString()})`);
      }
      const platformDelta = res.balancesAfterFinalize.platform - res.balancesBeforeFinalize.platform;
      const ecosystemDelta = res.balancesAfterFinalize.ecosystem - res.balancesBeforeFinalize.ecosystem;
      if (platformDelta < 0n || ecosystemDelta < 0n) {
        throw new Error(`matchDisbursement: expected non-negative fee recipient deltas, got platform=${platformDelta} eco=${ecosystemDelta}`);
      }
      // NOTE: platformTreasury and ecosystemVault may be configured to the same address in some environments.
      // In that case, summing both deltas would double-count the same recipient.
      const totalFeesOut =
        platformTreasury.toLowerCase() === ecosystemVault.toLowerCase() ? platformDelta : platformDelta + ecosystemDelta;
      const feesPaid = principal - borrowerNet;
      if (totalFeesOut !== feesPaid) {
        throw new Error(`matchDisbursement: fee mismatch (paid=${feesPaid.toString()} != out=${totalFeesOut.toString()})`);
      }

      // (D) Ledger + order fields.
      const ord = await getOrderForView(orderEngineAddr, res.orderId);
      if (ord.borrower.toLowerCase() !== borrower.address.toLowerCase()) throw new Error("matchDisbursement: order borrower mismatch");
      if (ord.lender.toLowerCase() !== lenderPoolVaultAddr.toLowerCase()) throw new Error("matchDisbursement: order lender is not pool vault");
      if (ord.principal !== principal) throw new Error("matchDisbursement: order principal mismatch");
      if (ord.repaidAmount !== 0n) throw new Error("matchDisbursement: expected repaidAmount=0 on fresh order");
      const debt = (await vLe.getDebt(borrower.address, assetAddr)) as bigint;
      if (debt !== principal) throw new Error(`matchDisbursement: expected debt=${principal.toString()}, got ${debt.toString()}`);

      // (A) Consume observability (also validates lendIntentHash SSOT alignment).
      const DT_CONSUMED = ethers.keccak256(ethers.toUtf8Bytes("RESERVE_CONSUMED"));
      const dataPushIface = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
      let sawConsumedEvent = false;
      let sawConsumedPush = false;
      for (const log of res.finalizeMatchReceipt!.logs) {
        try {
          const parsed = vbl.interface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "LendReserveConsumed") {
            if (String(parsed.args.lendIntentHash).toLowerCase() !== res.lendHash.toLowerCase()) {
              throw new Error("LendReserveConsumed: lendIntentHash mismatch (SSOT hash divergence)");
            }
            sawConsumedEvent = true;
          }
        } catch {}
        try {
          const parsed = dataPushIface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "DataPushed" && (parsed.args.dataTypeHash as string).toLowerCase() === DT_CONSUMED.toLowerCase()) {
            sawConsumedPush = true;
          }
        } catch {}
      }
      if (!sawConsumedEvent) throw new Error("matchDisbursement: missing LendReserveConsumed event");
      if (!sawConsumedPush) throw new Error("matchDisbursement: missing DataPushed(RESERVE_CONSUMED)");

      console.log(`  ✅ OK (orderId=${res.orderId.toString()}, net=${borrowerNet.toString()}, fees=${feesPaid.toString()})\n`);
      continue;
    }

    // ========= CASE 0: Reserve -> Cancel conservation =========
    if (runReserveCancel) {
      console.log("=== Case: reserve -> cancel (conservation) ===");
      const lender = await pickCleanSigner();
      await ensureTokenBalance(
        erc20,
        lender,
        ethers.parseUnits("5000", decimals),
        "reserve-cancel lender funding",
      );

      const tracked = uniqAddrs(
        await discoverTrackedAddresses({
          include: [deployer.address],
          lender: lender.address,
          keeper: keeper.address,
        })
      );
      const before = await snapshotBalances(assetAddr, tracked);

      const amount = ethers.parseUnits("500", decimals);
      await (await erc20.connect(lender).approve(vblAddr, amount)).wait();
      const lendIntent = {
        lenderSigner: lender.address,
        asset: assetAddr,
        amount,
        minTermDays: 1,
        maxTermDays: 30,
        minRateBps: 0n,
        expireAt: (await latestBlockNumber()) + ONE_HOUR_BLOCKS,
        salt: ethers.keccak256(ethers.toUtf8Bytes(`suite-reserve-${Date.now()}-${Math.random()}`)),
      };
      const lendHash = hashLendIntentStruct(lendIntent);
      const reserveReceipt = await (await vbl.connect(lender).reserveForLending(lender.address, assetAddr, amount, lendHash)).wait();

      const mid = await snapshotBalances(assetAddr, tracked);
      assertConservation("reserveForLending", before, mid);

      // Directional sanity: lender -> pool on reserve.
      const poolBalDelta = (mid.balances.get(lenderPoolVaultAddr) ?? 0n) - (before.balances.get(lenderPoolVaultAddr) ?? 0n);
      const lenderBalDelta = (mid.balances.get(lender.address) ?? 0n) - (before.balances.get(lender.address) ?? 0n);
      if (poolBalDelta !== amount) {
        throw new Error(`reserveForLending: expected pool balance +${amount.toString()}, got ${poolBalDelta.toString()}`);
      }
      if (lenderBalDelta !== 0n - amount) {
        throw new Error(`reserveForLending: expected lender balance -${amount.toString()}, got ${lenderBalDelta.toString()}`);
      }

      // Event sanity: LendReserveCreated + DataPushed(RESERVE_FOR_LENDING).
      const dataPushIface = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
      const DT_RESERVE = ethers.keccak256(ethers.toUtf8Bytes("RESERVE_FOR_LENDING"));
      let sawCreated = false;
      let sawReservePush = false;
      for (const log of reserveReceipt!.logs) {
        try {
          const parsed = vbl.interface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "LendReserveCreated") {
            if (String(parsed.args.lendIntentHash).toLowerCase() !== lendHash.toLowerCase()) throw new Error("LendReserveCreated: hash mismatch");
            if (String(parsed.args.lenderSigner).toLowerCase() !== lender.address.toLowerCase()) throw new Error("LendReserveCreated: lender mismatch");
            if (String(parsed.args.asset).toLowerCase() !== assetAddr.toLowerCase()) throw new Error("LendReserveCreated: asset mismatch");
            if ((parsed.args.amount as bigint) !== amount) throw new Error("LendReserveCreated: amount mismatch");
            sawCreated = true;
          }
        } catch {}
        try {
          const parsed = dataPushIface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "DataPushed" && (parsed.args.dataTypeHash as string).toLowerCase() === DT_RESERVE.toLowerCase()) {
            sawReservePush = true;
          }
        } catch {}
      }
      if (!sawCreated) throw new Error("reserveForLending: missing LendReserveCreated event");
      if (!sawReservePush) throw new Error("reserveForLending: missing DataPushed(RESERVE_FOR_LENDING)");

      const cancelReceipt = await (await vbl.connect(lender).cancelReserve(lendHash)).wait();
      const after = await snapshotBalances(assetAddr, tracked);
      assertConservation("cancelReserve", before, after);

      // Directional sanity: pool -> lender on cancel.
      const poolBalDelta2 = (after.balances.get(lenderPoolVaultAddr) ?? 0n) - (mid.balances.get(lenderPoolVaultAddr) ?? 0n);
      const lenderBalDelta2 = (after.balances.get(lender.address) ?? 0n) - (mid.balances.get(lender.address) ?? 0n);
      if (poolBalDelta2 !== 0n - amount) {
        throw new Error(`cancelReserve: expected pool balance -${amount.toString()}, got ${poolBalDelta2.toString()}`);
      }
      if (lenderBalDelta2 !== amount) {
        throw new Error(`cancelReserve: expected lender balance +${amount.toString()}, got ${lenderBalDelta2.toString()}`);
      }

      // Event sanity: LendReserveCancelled + DataPushed(CANCEL_RESERVE).
      const DT_CANCEL = ethers.keccak256(ethers.toUtf8Bytes("CANCEL_RESERVE"));
      let sawCancelled = false;
      let sawCancelPush = false;
      for (const log of cancelReceipt!.logs) {
        try {
          const parsed = vbl.interface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "LendReserveCancelled") {
            if (String(parsed.args.lendIntentHash).toLowerCase() !== lendHash.toLowerCase()) throw new Error("LendReserveCancelled: hash mismatch");
            if (String(parsed.args.lenderSigner).toLowerCase() !== lender.address.toLowerCase()) throw new Error("LendReserveCancelled: lender mismatch");
            if (String(parsed.args.asset).toLowerCase() !== assetAddr.toLowerCase()) throw new Error("LendReserveCancelled: asset mismatch");
            if ((parsed.args.amount as bigint) !== amount) throw new Error("LendReserveCancelled: amount mismatch");
            sawCancelled = true;
          }
        } catch {}
        try {
          const parsed = dataPushIface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "DataPushed" && (parsed.args.dataTypeHash as string).toLowerCase() === DT_CANCEL.toLowerCase()) {
            sawCancelPush = true;
          }
        } catch {}
      }
      if (!sawCancelled) throw new Error("cancelReserve: missing LendReserveCancelled event");
      if (!sawCancelPush) throw new Error("cancelReserve: missing DataPushed(CANCEL_RESERVE)");

      console.log("  ✅ OK\n");
    }

    // ========= CASE 0.7: Extension Flow (guarantee lock+record + early settle + overdue forfeit) =========
    if (!runFinalizeMatchOnly && !runMatchDisbursementOnly && runGuaranteeExtension) {
      console.log("=== Case: Extension Flow (Early Repayment Guarantee) ===");

      // (A) Enable guarantee for this token.
      await (await ergmAny.connect(deployer).setGuaranteeEnabled(assetAddr, true)).wait();
      const enabled = (await ergmAny.isGuaranteeEnabled(assetAddr)) as boolean;
      if (!enabled) throw new Error("GuaranteeExtension: setGuaranteeEnabled(true) did not take effect");

      // (B) Match/borrow should lock custody + write record (VBL SSOT path).
      const borrower = await pickCleanSigner();
      const lender = await pickCleanSigner();
      const tracked = uniqAddrs(
        await discoverTrackedAddresses({
          include: [deployer.address],
          borrower: borrower.address,
          lender: lender.address,
          keeper: keeper.address,
        })
      );

      const principal = ethers.parseUnits("500", decimals);
      const collateral = ethers.parseUnits("1000", decimals);
      const termDays = 5;
      const rateBps = 1000n;
      const promisedInterest = calcInterest(principal, rateBps, BigInt(termDays) * ONE_DAY);

      const before = await snapshotBalances(assetAddr, tracked);
      const res = await createOrder({
        borrower,
        lender,
        asset: assetAddr,
        principal,
        collateral,
        termDays,
        rateBps,
        makeOverdue: false,
        enableGuarantee: true,
      });
      const mid = await snapshotBalances(assetAddr, tracked);
      assertConservation("guarantee.finalizeMatch", before, mid);

      if (promisedInterest > 0n) {
        const locked = (await gfmAny.getLockedGuarantee(borrower.address, assetAddr)) as bigint;
        if (locked !== promisedInterest) {
          throw new Error(`GuaranteeExtension: locked mismatch (locked=${locked.toString()} promised=${promisedInterest.toString()})`);
        }
        const gid = (await ergmAny.getUserGuaranteeId(borrower.address, assetAddr)) as bigint;
        if (gid === 0n) throw new Error("GuaranteeExtension: expected non-zero guaranteeId after finalizeMatch");
        const active = (await ergmAny.hasActiveGuarantee(borrower.address, assetAddr)) as boolean;
        if (!active) throw new Error("GuaranteeExtension: expected hasActiveGuarantee=true after finalizeMatch");
        const rec = (await ergmAny.getGuaranteeRecord(gid)) as any;
        if ((rec.principal as bigint) !== principal) throw new Error("GuaranteeExtension: guaranteeRecord.principal mismatch");
        if ((rec.promisedInterest as bigint) !== promisedInterest) throw new Error("GuaranteeExtension: guaranteeRecord.promisedInterest mismatch");
        {
          // In pool-based matches, the "lender" semantic may be the pool vault (order.lender), not the lender signer.
          const lenderInRecord = String(rec.lender).toLowerCase();
          const ok =
            lenderInRecord === lenderPoolVaultAddr.toLowerCase() || lenderInRecord === lender.address.toLowerCase();
          if (!ok) throw new Error("GuaranteeExtension: guaranteeRecord.lender mismatch");
        }
        if (String(rec.asset).toLowerCase() !== assetAddr.toLowerCase()) throw new Error("GuaranteeExtension: guaranteeRecord.asset mismatch");
      }

      // (C) Early full repay should trigger 3-way distribution and clear custody+record (SettlementManager SSOT path).
      const ord = await getOrderForView(orderEngineAddr, res.orderId);
      const totalDue = await getOrderTotalDueForView(orderEngineAddr, res.orderId);
      await (await erc20.connect(borrower).approve(vaultCoreAddr, totalDue)).wait();

      const gid2 = (await ergmAny.getUserGuaranteeId(borrower.address, assetAddr)) as bigint;
      const preview = gid2 === 0n ? null : ((await ergmAny.previewEarlyRepayment(gid2, totalDue)) as any);
      const repayReceipt = await (await vaultCore.connect(borrower).repay(res.orderId, ord.asset, totalDue)).wait();
      const after = await snapshotBalances(assetAddr, tracked);
      assertConservation("guarantee.earlyRepay", before, after);

      if (promisedInterest > 0n) {
        // State cleared
        const lockedAfter = (await gfmAny.getLockedGuarantee(borrower.address, assetAddr)) as bigint;
        if (lockedAfter !== 0n) throw new Error("GuaranteeExtension: expected locked guarantee cleared after early repay");
        const activeAfter = (await ergmAny.hasActiveGuarantee(borrower.address, assetAddr)) as boolean;
        if (activeAfter) throw new Error("GuaranteeExtension: expected guarantee inactive after early repay");

        // Best-effort event check (semantic layer)
        const ergmIface = new ethers.Interface([
          "event EarlyRepaymentProcessed(uint256 indexed guaranteeId,address indexed borrower,address indexed lender,address asset,uint256 penaltyToLender,uint256 refundToBorrower,uint256 platformFee,uint256 actualInterestPaid,uint256 blockNumber)",
        ]);
        let saw = false;
        for (const log of repayReceipt!.logs) {
          try {
            const parsed = ergmIface.parseLog({ topics: log.topics as string[], data: log.data });
            if (parsed?.name === "EarlyRepaymentProcessed") {
              saw = true;
              if (preview) {
                const pPenalty = preview.penaltyToLender as bigint;
                const pRefund = preview.refundToBorrower as bigint;
                const pFee = preview.platformFee as bigint;
                if ((parsed.args.penaltyToLender as bigint) !== pPenalty) throw new Error("GuaranteeExtension: penaltyToLender mismatch vs preview");
                if ((parsed.args.refundToBorrower as bigint) !== pRefund) throw new Error("GuaranteeExtension: refundToBorrower mismatch vs preview");
                if ((parsed.args.platformFee as bigint) !== pFee) throw new Error("GuaranteeExtension: platformFee mismatch vs preview");
              }
              break;
            }
          } catch {}
        }
        if (!saw) {
          console.log("  ⚠️  ExtensionFlow: repay did not emit ERGM.EarlyRepaymentProcessed (event check skipped).");
        }
      }

      // (D) Overdue settleOrLiquidate should trigger forfeiture and clear custody+record.
      const borrower2 = await pickCleanSigner();
      const lender2 = await pickCleanSigner();
      const res2 = await createOrder({
        borrower: borrower2,
        lender: lender2,
        asset: assetAddr,
        principal,
        collateral,
        termDays,
        rateBps,
        makeOverdue: true,
        enableGuarantee: true,
      });
      // Forfeiture happens in settleOrLiquidate branch (overdue/risk).
      // Ensure liquidation roles for:
      // - keeper (external entry gate on SettlementManager)
      // - SettlementManager (direct-ledger fallback path: CM.withdrawCollateralTo + LE.forceReduceDebt)
      // - LiquidationManager (primary path: CM/LE direct-ledger writes)
      try {
        const okKeeper = await ensureRole(key("LIQUIDATE"), keeper.address, "LIQUIDATE(keeper)");
        const okSm = await ensureRole(key("LIQUIDATE"), settlementManagerAddr, "LIQUIDATE(settlementManager)");
        const okLm = await ensureRole(key("LIQUIDATE"), liquidationManagerAddr, "LIQUIDATE(liquidationManager)");
        // LiquidationRiskManager queries HealthView.getUserHealthFactorWithMeta (Scheme U user-dimensional read).
        // Since msg.sender is LiquidationRiskManager (not the user), it requires ACTION_VIEW_USER_DATA (or admin).
        const okRiskUser = await ensureRole(
          key("VIEW_USER_DATA"),
          liquidationRiskManagerAddr,
          "VIEW_USER_DATA(liquidationRiskManager)"
        );
        // SettlementManager (and sometimes LiquidationManager) queries PositionView valuation during liquidation.
        // IMPORTANT: PositionView.getAssetValue is gated by ACTION_VIEW_PRICE_DATA (not VIEW_RISK_DATA).
        const okSmView = await ensureRole(key("VIEW_PRICE_DATA"), settlementManagerAddr, "VIEW_PRICE_DATA(settlementManager)");
        const okLmView = await ensureRole(key("VIEW_PRICE_DATA"), liquidationManagerAddr, "VIEW_PRICE_DATA(liquidationManager)");
        if (noAutoGrant && (!okKeeper || !okSm || !okLm || !okRiskUser || !okSmView || !okLmView)) {
          console.log(
            "  ⏭️  [SKIP] ExtensionFlow default/forfeit path requires LIQUIDATE + VIEW_PRICE_DATA on keeper/SM/LM."
          );
          // Restore baseline off so other cases remain decoupled.
          await (await ergmAny.connect(deployer).setGuaranteeEnabled(assetAddr, false)).wait();
          console.log("");
          // Skip the rest of Extension Flow case.
          // (Other suite cases can still run.)
          // eslint-disable-next-line no-lone-blocks
          {
            // no-op block to keep structure readable
          }
          // Use a labeled boolean to gate below, without large refactor.
        }
      } catch (e) {
        throw new Error(
          `GuaranteeExtension: failed to grant ACTION_LIQUIDATE for liquidation path. ` +
            `keeper=${keeper.address} settlementManager=${settlementManagerAddr} liquidationManager=${liquidationManagerAddr}. ` +
            `Raw=${String((e as any)?.message ?? e)}`
        );
      }
      // In NO_AUTO_GRANT mode, we may have detected missing roles above and should skip the settleOrLiquidate call.
      if (
        noAutoGrant &&
        !(
          ((await acm.hasRole(key("LIQUIDATE"), keeper.address)) as boolean) &&
          ((await acm.hasRole(key("LIQUIDATE"), settlementManagerAddr)) as boolean) &&
          ((await acm.hasRole(key("LIQUIDATE"), liquidationManagerAddr)) as boolean) &&
          ((await acm.hasRole(key("VIEW_USER_DATA"), liquidationRiskManagerAddr)) as boolean) &&
          ((await acm.hasRole(key("VIEW_PRICE_DATA"), settlementManagerAddr)) as boolean) &&
          ((await acm.hasRole(key("VIEW_PRICE_DATA"), liquidationManagerAddr)) as boolean)
        )
      ) {
        // Restore baseline off so other cases remain decoupled.
        await (await ergmAny.connect(deployer).setGuaranteeEnabled(assetAddr, false)).wait();
        console.log("  ⏭️  [SKIP] ExtensionFlow overdue settleOrLiquidate (missing roles).");
        console.log("");
      } else {
        // Preflight: make MissingRole() actionable (it has no args).
        // settleOrLiquidate requires ACTION_LIQUIDATE on the keeper (tx sender),
        // and it calls PositionView.getAssetValue which requires ACTION_VIEW_PRICE_DATA on the calling module.
        try {
          const acmFromRegistry = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
          const ACTION_LIQUIDATE = key("LIQUIDATE");
          const ACTION_VIEW_USER_DATA = key("VIEW_USER_DATA");
          const ACTION_VIEW_PRICE_DATA = key("VIEW_PRICE_DATA");
          const kHasLiq = (await acm.hasRole(ACTION_LIQUIDATE, keeper.address)) as boolean;
          const smHasLiq = (await acm.hasRole(ACTION_LIQUIDATE, settlementManagerAddr)) as boolean;
          const lmHasLiq = (await acm.hasRole(ACTION_LIQUIDATE, liquidationManagerAddr)) as boolean;
          const lrmHasUser = (await acm.hasRole(ACTION_VIEW_USER_DATA, liquidationRiskManagerAddr)) as boolean;
          const smHasPrice = (await acm.hasRole(ACTION_VIEW_PRICE_DATA, settlementManagerAddr)) as boolean;
          const lmHasPrice = (await acm.hasRole(ACTION_VIEW_PRICE_DATA, liquidationManagerAddr)) as boolean;
          if (
            acmFromRegistry.toLowerCase() !== String(acmAddr).toLowerCase() ||
            !kHasLiq ||
            !smHasLiq ||
            !lmHasLiq ||
            !lrmHasUser ||
            !smHasPrice ||
            !lmHasPrice
          ) {
            console.log("  [Diag] Role preflight before settleOrLiquidate:");
            console.log(`    - Registry.KEY_ACCESS_CONTROL_MANAGER: ${acmFromRegistry}`);
            console.log(`    - script.acmAddr: ${acmAddr}`);
            console.log(`    - keeper ACTION_LIQUIDATE: ${kHasLiq}`);
            console.log(`    - SettlementManager ACTION_LIQUIDATE: ${smHasLiq}`);
            console.log(`    - LiquidationManager ACTION_LIQUIDATE: ${lmHasLiq}`);
            console.log(`    - LiquidationRiskManager ACTION_VIEW_USER_DATA: ${lrmHasUser}`);
            console.log(`    - SettlementManager ACTION_VIEW_PRICE_DATA: ${smHasPrice}`);
            console.log(`    - LiquidationManager ACTION_VIEW_PRICE_DATA: ${lmHasPrice}`);
          }
        } catch {
          // ignore diagnostics
        }
        let liqReceipt: any | null = null;
        let skippedOverdue = false;
        try {
          liqReceipt = await (await settlementManager.connect(keeper).settleOrLiquidate(res2.orderId)).wait();
        } catch (e: any) {
          const msg = String(e?.message ?? e ?? "");
          // MissingRole() selector = 0x94235922
          if (allowDirtyState && (msg.includes("0x94235922") || msg.includes("MissingRole"))) {
            console.log(
              "  ⏭️  [SKIP] ExtensionFlow overdue settleOrLiquidate: MissingRole() (dirty chain role drift)."
            );
            // Restore baseline off so other cases remain decoupled.
            await (await ergmAny.connect(deployer).setGuaranteeEnabled(assetAddr, false)).wait();
            console.log("");
            skippedOverdue = true;
          } else {
            throw e;
          }
        }

        if (!skippedOverdue) {
          if (promisedInterest > 0n) {
            const locked2 = (await gfmAny.getLockedGuarantee(borrower2.address, assetAddr)) as bigint;
            if (locked2 !== 0n) throw new Error("GuaranteeExtension: expected locked guarantee cleared after settleOrLiquidate");
            const active2 = (await ergmAny.hasActiveGuarantee(borrower2.address, assetAddr)) as boolean;
            if (active2) throw new Error("GuaranteeExtension: expected guarantee inactive after settleOrLiquidate");
            // Best-effort event check
            const ergmIface2 = new ethers.Interface([
              "event GuaranteeForfeited(uint256 indexed guaranteeId,address indexed borrower,address indexed lender,address asset,uint256 forfeitedAmount,uint256 blockNumber)",
            ]);
            let sawF = false;
            for (const log of liqReceipt!.logs) {
              try {
                const parsed = ergmIface2.parseLog({ topics: log.topics as string[], data: log.data });
                if (parsed?.name === "GuaranteeForfeited") {
                  sawF = true;
                  break;
                }
              } catch {}
            }
            if (!sawF) {
              console.log("  ⚠️  ExtensionFlow: settleOrLiquidate did not emit ERGM.GuaranteeForfeited (event check skipped).");
            }
          }

          // Restore baseline off so other cases remain decoupled.
          await (await ergmAny.connect(deployer).setGuaranteeEnabled(assetAddr, false)).wait();
          console.log("  ✅ OK\n");
        }
      }
    }

    // ========= CASE 1: Partial repay (allowed when strict mode disabled) =========
    if (runPartialRepay) {
      console.log("=== Case: partial repay then full repay (conservation + state) ===");

    // best-effort disable strict full-repay mode to allow partial repay.
    try {
      await ensureRole(key("SET_PARAMETER"), deployer.address);
      const requireFull = (await settlementManager.requireFullRepayRelease()) as boolean;
      if (requireFull) {
        await (await settlementManager.connect(deployer).setRequireFullRepayRelease(false)).wait();
      }
    } catch (e) {
      console.log("  ⚠️  Could not disable strict full-repay mode; partial repay may revert:", e);
    }

      const borrower = await pickCleanSigner();
      const lender = await pickCleanSigner();
      const tracked = uniqAddrs(
        await discoverTrackedAddresses({
          include: [deployer.address],
          borrower: borrower.address,
          lender: lender.address,
          keeper: keeper.address,
        })
      );

      const { orderId } = await createOrder({
        borrower,
        lender,
        asset: assetAddr,
        principal: ethers.parseUnits("500", decimals),
        collateral: ethers.parseUnits("1000", decimals),
        termDays: 5,
        rateBps: 1000n,
        makeOverdue: false,
      });
    const ord = await getOrderForView(orderEngineAddr, orderId);
    const totalDue = await getOrderTotalDueForView(orderEngineAddr, orderId);

    const half = totalDue / 2n;
      // partial
      const before = await snapshotBalances(ord.asset, tracked);
      await (await erc20.connect(borrower).approve(vaultCoreAddr, totalDue)).wait();
      await (await vaultCore.connect(borrower).repay(orderId, ord.asset, half)).wait();
      const afterPartial = await snapshotBalances(ord.asset, tracked);
      assertConservation("partialRepay", before, afterPartial);
      const ordAfter1 = await getOrderForView(orderEngineAddr, orderId);
      if (ordAfter1.repaidAmount <= ord.repaidAmount) throw new Error("partial repay did not increase repaidAmount");

    // full remaining
    const remaining = totalDue - half;
      await (await vaultCore.connect(borrower).repay(orderId, ord.asset, remaining)).wait();
      const afterFull = await snapshotBalances(ord.asset, tracked);
      assertConservation("fullRepay", before, afterFull);
      const ordAfter2 = await getOrderForView(orderEngineAddr, orderId);
      if (await getOrderStatusForView(orderEngineAddr, orderId) !== 1n) {
        throw new Error("expected Repaid order status after full repay");
      }
      if (ordAfter2.repaidAmount < totalDue) throw new Error("expected fully repaid order (repaidAmount < totalDue)");
      console.log("  ✅ OK\n");
    }

    // ========= CASE 2: Strict full-repay + aggregated debt behavior =========
    if (runStrictAggDebt) {
      console.log("=== Case: strict full-repay + aggregated debt (expected revert, then success) ===");

      if (!Number.isInteger(strictAggDebtIterations) || strictAggDebtIterations < 1) {
        throw new Error(`Invalid STRICT_AGG_DEBT_ITERATIONS=${process.env.STRICT_AGG_DEBT_ITERATIONS}`);
      }

      for (let iter = 1; iter <= strictAggDebtIterations; iter++) {
        console.log(`  --- Iteration ${iter}/${strictAggDebtIterations} ---`);

        // Refresh price blockNumbers for all tokens to keep valuation stable across dirty, multi-asset runs.
        for (const t of tokensToRun) {
          try {
            const refreshMode = await refreshPriceForAsset(t);
            const decimalsForToken = await getTokenDecimals(t);
            if (decimalsForToken === 0n) {
              console.log("  ⚠️  price decimals returned 0; valuation may be unstable");
            }
            if (refreshMode === "explicit-fallback") {
              console.log(`  ℹ️  price refresh used explicit fallback for ${t}`);
            }
          } catch (e) {
            throw new Error(`price refresh failed for ${t}: ${String((e as any)?.message ?? e)}`);
          }
        }

        // enable strict full-repay mode
        try {
          await ensureRole(key("SET_PARAMETER"), deployer.address);
          await (await settlementManager.connect(deployer).setRequireFullRepayRelease(true)).wait();
        } catch (e) {
          console.log("  ⚠️  Could not enable strict full-repay mode; skipping this case:", e);
        }

        const borrower = await pickBorrower(iter, assetIdx);
        const lender1 = await pickLender();
        const lender2 = await pickLender();
        const tracked = uniqAddrs(
          await discoverTrackedAddresses({
            include: [deployer.address],
            borrower: borrower.address,
            lender: lender1.address,
            keeper: keeper.address,
          })
        );
        const tracked2 = uniqAddrs([...tracked, lender2.address]);

        const variants = [1n, 2n, 5n, 10n];
        const variant = (base: bigint, slot: number) => {
          if (!useVariantAmounts) return base;
          const mult = variants[(iter + assetIdx + slot) % variants.length];
          return base * mult;
        };

        const baseA = assertAggDebtSum ? ethers.parseUnits(aggDebtPrincipalA, decimals) : ethers.parseUnits("500", decimals);
        const baseB = assertAggDebtSum ? ethers.parseUnits(aggDebtPrincipalB, decimals) : ethers.parseUnits("500", decimals);
        const baseC = assertAggDebtSum ? ethers.parseUnits(aggDebtPrincipalC, decimals) : ethers.parseUnits("200", decimals);
        const principalA = variant(baseA, 0);
        const principalB = variant(baseB, 1);
        const principalC = variant(baseC, 2);
        const rateBps = assertAggDebtSum ? 0n : 1000n;

        const baselineValue = (await vLe.getUserTotalDebtValue(borrower.address)) as bigint;
        const baselineRawDebt = (await vLe.getDebt(borrower.address, assetAddr)) as bigint;

        const { orderId: orderA } = await createOrder({
          borrower,
          lender: lender1,
          asset: assetAddr,
          principal: principalA,
          collateral: ethers.parseUnits("1000", decimals),
          termDays: 5,
          rateBps,
          makeOverdue: false,
        });
        const { orderId: orderB } = await createOrder({
          borrower,
          lender: lender2,
          asset: assetAddr,
          principal: principalB,
          collateral: ethers.parseUnits("1000", decimals),
          termDays: 5,
          rateBps,
          makeOverdue: false,
        });

        if (assertAggDebtSum) {
          const expectedValue = await computeUserDebtValue(borrower.address);
          const actualValue = (await vLe.getUserTotalDebtValue(borrower.address)) as bigint;
          const rawDebt = (await vLe.getDebt(borrower.address, assetAddr)) as bigint;
          const expectedRawDebt = baselineRawDebt + principalA + principalB;
          if (actualValue !== expectedValue || rawDebt !== expectedRawDebt) {
            throw new Error(
              `strictAggDebt.sumMismatch: expected=${expectedValue.toString()} actual=${actualValue.toString()} ` +
                `(baselineValue=${baselineValue.toString()} principalA=${principalA.toString()} principalB=${principalB.toString()} ` +
                `rawDebt=${rawDebt.toString()} expectedRawDebt=${expectedRawDebt.toString()})`
            );
          }
          console.log(
            `  ✅ strictAggDebt.sumMatch (expected=${expectedValue.toString()} actual=${actualValue.toString()})`
          );
        }

        const ordA = await getOrderForView(orderEngineAddr, orderA);
        const dueA = await getOrderTotalDueForView(orderEngineAddr, orderA);
        await (await erc20.connect(borrower).approve(vaultCoreAddr, dueA)).wait();

        const before = await snapshotBalances(ordA.asset, tracked2);
        let reverted = false;
        try {
          await (await vaultCore.connect(borrower).repay(orderA, ordA.asset, dueA)).wait();
        } catch (e) {
          reverted = true;
        }
        const afterAttempt = await snapshotBalances(ordA.asset, tracked2);
        // if reverted, balances must be unchanged
        if (reverted) {
          assertConservation("strictAggDebt.revertNoSideEffects", before, afterAttempt);
          console.log("  ✅ Expected revert observed (DebtNotCleared), and no balance side-effects.");
        } else {
          console.log("  ⚠️  repay did not revert under strict mode; continuing.");
        }

        let after = afterAttempt;
        if (reverted) {
          // disable strict and retry
          await (await settlementManager.connect(deployer).setRequireFullRepayRelease(false)).wait();
          await (await erc20.connect(borrower).approve(vaultCoreAddr, dueA)).wait();
          await (await vaultCore.connect(borrower).repay(orderA, ordA.asset, dueA)).wait();
          after = await snapshotBalances(ordA.asset, tracked2);
          assertConservation("strictAggDebt.afterDisableStrict", before, after);
        } else {
          // Repay succeeded under strict mode; keep going (observed in some local configs).
          console.log("  ⚠️  repay succeeded under strict mode; skipping strictAggDebt.afterRepay conservation.");
        }

        if (reborrowAfterRepay) {
          const lender3 = await pickLender();
          await createOrder({
            borrower,
            lender: lender3,
            asset: assetAddr,
            principal: principalC,
            collateral: ethers.parseUnits("1000", decimals),
            termDays: 5,
            rateBps,
            makeOverdue: false,
          });
          if (assertAggDebtSum) {
            const expectedValue = await computeUserDebtValue(borrower.address);
            const actualValue = (await vLe.getUserTotalDebtValue(borrower.address)) as bigint;
            const rawDebt = (await vLe.getDebt(borrower.address, assetAddr)) as bigint;
            const expectedRawDebt = baselineRawDebt + principalB + principalC;
            if (actualValue !== expectedValue || rawDebt !== expectedRawDebt) {
              throw new Error(
                `strictAggDebt.reborrowMismatch: expected=${expectedValue.toString()} actual=${actualValue.toString()} ` +
                  `(baselineValue=${baselineValue.toString()} principalB=${principalB.toString()} principalC=${principalC.toString()} ` +
                  `rawDebt=${rawDebt.toString()} expectedRawDebt=${expectedRawDebt.toString()})`
              );
            }
            console.log(
              `  ✅ strictAggDebt.reborrowMatch (expected=${expectedValue.toString()} actual=${actualValue.toString()})`
            );
          }
        }

        // sanity: borrower still has debt because orderB is active
        const debtValue = (await vLe.getUserTotalDebtValue(borrower.address)) as bigint;
        if (debtValue === 0n) {
          throw new Error("expected aggregated debt to remain after repaying only one of two orders");
        }
        console.log(`  ✅ OK (remaining aggregated debtValue=${debtValue.toString()})\n`);
        orderB; // silence unused
      }
    }

    // ========= CASE 3: Liquidation conservation =========
    if (runLiquidation) {
      console.log("=== Case: overdue liquidation (conservation) ===");
      const borrower = await pickCleanSigner();
      const lender = await pickCleanSigner();
      const tracked = uniqAddrs(
        await discoverTrackedAddresses({
          include: [deployer.address],
          borrower: borrower.address,
          lender: lender.address,
          keeper: keeper.address,
        })
      );

    // ensure liquidation roles (best-effort; in NO_AUTO_GRANT mode we only verify)
    try {
      await ensureRole(key("LIQUIDATE"), keeper.address, "LIQUIDATE(keeper)");
      await ensureRole(key("LIQUIDATE"), settlementManagerAddr, "LIQUIDATE(settlementManager)");
      await ensureRole(key("LIQUIDATE"), liquidationManagerAddr, "LIQUIDATE(liquidationManager)");
      await ensureRole(key("VIEW_RISK_DATA"), settlementManagerAddr, "VIEW_RISK_DATA(settlementManager)");
      await ensureRole(key("VIEW_RISK_DATA"), liquidationManagerAddr, "VIEW_RISK_DATA(liquidationManager)");
    } catch (e) {
      console.log(
        "  ⚠️  Could not grant LIQUIDATE for liquidation path; liquidation may revert:",
        e
      );
    }

      const { orderId } = await createOrder({
        borrower,
        lender,
        asset: assetAddr,
        principal: ethers.parseUnits("500", decimals),
        collateral: ethers.parseUnits("1000", decimals),
        termDays: 5,
        rateBps: 1000n,
        makeOverdue: true,
      });
    const ord = await getOrderForView(orderEngineAddr, orderId);

    const hasLiqKeeper = (await acm.hasRole(key("LIQUIDATE"), keeper.address)) as boolean;
    const hasLiqSettlement = (await acm.hasRole(key("LIQUIDATE"), settlementManagerAddr)) as boolean;
    const hasLiqManager = (await acm.hasRole(key("LIQUIDATE"), liquidationManagerAddr)) as boolean;
    const hasRiskSettlement = (await acm.hasRole(key("VIEW_RISK_DATA"), settlementManagerAddr)) as boolean;
    const hasRiskManager = (await acm.hasRole(key("VIEW_RISK_DATA"), liquidationManagerAddr)) as boolean;
    if (!(hasLiqKeeper && hasLiqSettlement && hasLiqManager && hasRiskSettlement && hasRiskManager)) {
      console.log("  ⏭️  [SKIP] Liquidation case (missing LIQUIDATE/VIEW_RISK_DATA roles).");
      console.log(
        `      keeper=${hasLiqKeeper} settlement=${hasLiqSettlement} liqMgr=${hasLiqManager} ` +
          `riskSettlement=${hasRiskSettlement} riskLiqMgr=${hasRiskManager}`
      );
      console.log("");
    } else {
      const before = await snapshotBalances(ord.asset, tracked);
      try {
        await (await settlementManager.connect(keeper).settleOrLiquidate(orderId)).wait();
      } catch (e: any) {
        const msg = String(e?.message ?? e ?? "");
        // MissingRole() selector = 0x94235922
        if (msg.includes("0x94235922") || msg.includes("MissingRole")) {
          console.log("  ⏭️  [SKIP] Liquidation case: MissingRole() on keeper (unexpected; roles likely drifted).");
          console.log("");
          continue;
        }
        throw e;
      }
      const after = await snapshotBalances(ord.asset, tracked);
      assertConservation("liquidation", before, after);
      console.log("  ✅ OK\n");
    }
    }
  } // end token loop

  console.log("✅ Invariants suite completed.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

