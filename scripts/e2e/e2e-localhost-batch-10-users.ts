import { ethers } from "hardhat";
import type { Addressable } from "ethers";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";
import { scanViewModules } from "./utils/view-scan";

const ONE_DAY = 24n * 60n * 60n;
const WAD = 10n ** 18n;

function parseSampleBorrowerIndexFromEnv(): number {
  const raw = process.env.E2E_SAMPLE_BORROWER_INDEX;
  if (raw === undefined || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`Invalid sample borrower index: ${raw}`);
  return n;
}

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function calcTotalDue(principal: bigint, rateBps: bigint, termSec: bigint) {
  const denom = 365n * ONE_DAY * 10_000n;
  const interest = (principal * rateBps * termSec) / denom;
  return principal + interest;
}

function shortAddr(a: string) {
  if (!a) return a;
  return a.length <= 10 ? a : a.slice(0, 10);
}

function decodeRevertData(data: string): string {
  try {
    if (!data || data === "0x") return "<empty>";
    if (data.length < 10) return `0x${data.replace(/^0x/, "")} (short)`;

    const selector = data.slice(0, 10).toLowerCase();
    const payload = `0x${data.slice(10)}`;
    const coder = ethers.AbiCoder.defaultAbiCoder();

    // Error(string)
    if (selector === "0x08c379a0") {
      const [msg] = coder.decode(["string"], payload);
      return `Error("${msg}")`;
    }
    // Panic(uint256)
    if (selector === "0x4e487b71") {
      const [code] = coder.decode(["uint256"], payload);
      return `Panic(${code.toString()})`;
    }

    // Common custom errors seen in this repo / e2e.
    const known: Record<string, string> = {
      "0xb1306c73": "PriceOracle__StalePrice()",
      "0x94235922": "MissingRole()",
      "0xd92e233d": "ZeroAddress()",
      "0x336ee1e5": "VaultRouter__UnauthorizedAccess()",
    };
    return known[selector] ? `${known[selector]} (selector=${selector})` : `CustomError(selector=${selector})`;
  } catch (e: any) {
    return `UnparsedRevertData(${data.slice(0, 18)}...): ${e?.message ?? String(e)}`;
  }
}

function buildLendIntentHash(li: any) {
  const typeHash = ethers.keccak256(
    ethers.toUtf8Bytes(
      "LendIntent(address lender,address asset,uint256 amount,uint16 minTermDays,uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)"
    )
  );
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "address", "address", "uint256", "uint16", "uint16", "uint256", "uint256", "bytes32"],
      [
        typeHash,
        li.lender,
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

async function main() {
  await runBatch10Users();
}

export async function runBatch10Users(opts?: { sampleBorrowerIndex?: number }) {
  const signers = await ethers.getSigners();
  const deployer = signers[0];

  // 10 users: (1,2) (3,4) (5,6) (7,8) (9,10)
  if (signers.length < 11) throw new Error(`Need at least 11 signers (have ${signers.length})`);

  const pairs = [
    { borrower: signers[1], lender: signers[2] },
    { borrower: signers[3], lender: signers[4] },
    { borrower: signers[5], lender: signers[6] },
    { borrower: signers[7], lender: signers[8] },
    { borrower: signers[9], lender: signers[10] },
  ];

  console.log("=== E2E Batch Test (10 users / 5 pairs) ===\n");

  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
  // Diagnostics: detect registry/view wiring mismatches (common when reusing a long-lived localhost chain)
  const vaultCoreFromRegistryAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;
  console.log("  [Diag] Registry:", CONTRACT_ADDRESSES.Registry);
  console.log("  [Diag] Registry.KEY_VAULT_CORE:", vaultCoreFromRegistryAddr);
  if (String(CONTRACT_ADDRESSES.VaultCore).toLowerCase() !== vaultCoreFromRegistryAddr.toLowerCase()) {
    console.log(`  ⚠️ [Diag] CONTRACT_ADDRESSES.VaultCore != Registry.KEY_VAULT_CORE (${CONTRACT_ADDRESSES.VaultCore} != ${vaultCoreFromRegistryAddr})`);
  }
  const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
  const aw = (await ethers.getContractAt("AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", CONTRACT_ADDRESSES.PriceOracle)) as any;
  const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", CONTRACT_ADDRESSES.FeeRouter)) as any;
  const usdc = (await ethers.getContractAt("MockERC20", CONTRACT_ADDRESSES.MockUSDC)) as any;
  const vaultCore = (await ethers.getContractAt("VaultCore", vaultCoreFromRegistryAddr)) as any;
  // View contract (VaultRouter) is derived from VaultCore → viewContractAddrVar() per Architecture-Guide.
  try {
    const viewAddr = (await vaultCore.viewContractAddrVar()) as string;
    const view = (await ethers.getContractAt("VaultRouter", viewAddr)) as any;
    const viewRegistry = (await view.getRegistry()) as string;
    console.log("  [Diag] VaultCore.viewContractAddrVar():", viewAddr);
    console.log("  [Diag] VaultRouter.getRegistry():", viewRegistry);
    if (viewRegistry.toLowerCase() !== String(CONTRACT_ADDRESSES.Registry).toLowerCase()) {
      console.log(`  ⚠️ [Diag] VaultRouter is wired to a DIFFERENT Registry (${viewRegistry}) than CONTRACT_ADDRESSES.Registry (${CONTRACT_ADDRESSES.Registry})`);
      console.log("  ⚠️ [Diag] This will cause VaultRouter__UnauthorizedAccess during cache push (msg.sender vaultCore != registry.KEY_VAULT_CORE).");
    }
  } catch (e: any) {
    console.log(`  ⚠️ [Diag] Failed to read VaultCore/VaultRouter wiring: ${e?.message ?? String(e)}`);
  }
  const vbl = (await ethers.getContractAt("VaultBusinessLogic", CONTRACT_ADDRESSES.VaultBusinessLogic)) as any;
  const cm = (await ethers.getContractAt("CollateralManager", CONTRACT_ADDRESSES.CollateralManager)) as any;
  const vle = (await ethers.getContractAt(
    "src/Vault/modules/VaultLendingEngine.sol:VaultLendingEngine",
    CONTRACT_ADDRESSES.VaultLendingEngine
  )) as any;
  try {
    const vleReg = (await vle.registryAddr()) as string;
    console.log("  [Diag] VaultLendingEngine.registryAddr():", vleReg);
    if (vleReg.toLowerCase() !== String(CONTRACT_ADDRESSES.Registry).toLowerCase()) {
      console.log(`  ⚠️ [Diag] VaultLendingEngine is wired to a DIFFERENT Registry (${vleReg}) than CONTRACT_ADDRESSES.Registry (${CONTRACT_ADDRESSES.Registry})`);
    }
  } catch {
    // ignore
  }

  // LiquidationManager (Direct-to-ledger, single entry)
  const liquidationManagerAddr = await registry.getModuleOrRevert(key("LIQUIDATION_MANAGER"));
  const liquidationManager = (await ethers.getContractAt("LiquidationManager", liquidationManagerAddr)) as any;

  // LiquidationRiskManager (needed for HealthView fallback refresh after time travel)
  const liquidationRiskManagerAddr = await registry.getModuleOrRevert(key("LIQUIDATION_RISK_MANAGER"));
  const liquidationRiskManager = (await ethers.getContractAt(
    "LiquidationRiskManager",
    liquidationRiskManagerAddr
  )) as any;

  const orderEngineAddr = await registry.getModuleOrRevert(key("ORDER_ENGINE"));
  const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;

  const loanNftAddr = await registry.getModuleOrRevert(key("LOAN_NFT"));
  const loanNft = (await ethers.getContractAt("LoanNFT", loanNftAddr)) as any;

  const statisticsViewAddr = await registry.getModuleOrRevert(key("STATISTICS_VIEW"));
  const statisticsView = (await ethers.getContractAt("StatisticsView", statisticsViewAddr)) as any;

  const positionViewAddr = await registry.getModuleOrRevert(key("POSITION_VIEW"));
  const positionView = (await ethers.getContractAt("PositionView", positionViewAddr)) as any;

  const viewCacheAddr = await registry.getModuleOrRevert(key("VIEW_CACHE"));
  const viewCache = (await ethers.getContractAt("ViewCache", viewCacheAddr)) as any;

  // HealthView for health factor testing
  let healthView: any = null;
  try {
    const healthViewAddr = await registry.getModuleOrRevert(key("HEALTH_VIEW"));
    healthView = (await ethers.getContractAt("HealthView", healthViewAddr)) as any;
    console.log(`  [Debug] HealthView registered @ ${healthViewAddr}`);
  } catch (e: any) {
    console.log(`  ⚠️ [Debug] HealthView not registered: ${e?.message ?? String(e)}`);
  }

  // Debug: Check RewardManager registration
  try {
    const rewardManagerAddr = await registry.getModuleOrRevert(key("REWARD_MANAGER"));
    console.log(`  [Debug] RewardManager registered @ ${rewardManagerAddr}`);
    const rewardManagerCode = await ethers.provider.getCode(rewardManagerAddr);
    if (rewardManagerCode === "0x") {
      console.log(`  ⚠️ [Debug] RewardManager has no code at ${rewardManagerAddr}`);
    }
  } catch (e: any) {
    console.log(`  ⚠️ [Debug] RewardManager not registered in Registry: ${e?.message ?? String(e)}`);
  }

  const assetAddr = usdc.target as string;
  const toBigInt = (x: any): bigint => (typeof x === "bigint" ? x : BigInt(x));

  // CacheUpdateFailed is emitted by multiple contracts with identical ABI.
  // We decode it via a minimal event-only interface and print emitter+reason.
  const cacheUpdateFailedTopic = ethers.keccak256(
    ethers.toUtf8Bytes("CacheUpdateFailed(address,address,address,uint256,uint256,bytes)")
  );
  const cacheUpdateFailedIface = new ethers.Interface([
    "event CacheUpdateFailed(address indexed user, address indexed asset, address viewAddr, uint256 collateral, uint256 debt, bytes reason)",
  ]);

  const emitterLabel = (addr: string): string => {
    const a = addr.toLowerCase();
    const map: Record<string, string> = {
      [String(CONTRACT_ADDRESSES.VaultCore).toLowerCase()]: "VaultCore",
      [String(CONTRACT_ADDRESSES.VaultBusinessLogic).toLowerCase()]: "VaultBusinessLogic",
      [String(CONTRACT_ADDRESSES.VaultLendingEngine).toLowerCase()]: "VaultLendingEngine",
      [String(CONTRACT_ADDRESSES.VaultRouter).toLowerCase()]: "VaultRouter",
      [String(CONTRACT_ADDRESSES.CollateralManager).toLowerCase()]: "CollateralManager",
      [String(CONTRACT_ADDRESSES.PriceOracle).toLowerCase()]: "PriceOracle",
      [String(CONTRACT_ADDRESSES.Registry).toLowerCase()]: "Registry",
      [String(CONTRACT_ADDRESSES.StatisticsView).toLowerCase()]: "StatisticsView",
      [String(CONTRACT_ADDRESSES.PositionView).toLowerCase()]: "PositionView",
      [String(CONTRACT_ADDRESSES.ViewCache).toLowerCase()]: "ViewCache",
    };
    return map[a] ?? "Unknown";
  };

  const logCacheUpdateFailedEvents = (logs: any[], context: string) => {
    const matches = (logs || []).filter((log: any) => log.topics?.[0] === cacheUpdateFailedTopic);
    if (matches.length === 0) return;
    console.log(`    ⚠️ [CacheUpdateFailed] ${matches.length} event(s) detected (${context})`);
    for (const log of matches) {
      try {
        const parsed = cacheUpdateFailedIface.parseLog({ topics: log.topics, data: log.data });
        if (!parsed) throw new Error("parseLog returned null");
        const user = String(parsed.args.user);
        const asset = String(parsed.args.asset);
        const viewAddr = String(parsed.args.viewAddr);
        const collateral = toBigInt(parsed.args.collateral);
        const debt = toBigInt(parsed.args.debt);
        const reason = String(parsed.args.reason);
        const emitter = String(log.address);
        console.log(
          `      - emitter=${emitterLabel(emitter)}@${emitter} user=${shortAddr(user)} asset=${shortAddr(asset)} view=${shortAddr(viewAddr)} col=${ethers.formatUnits(
            collateral,
            6
          )} debt=${ethers.formatUnits(debt, 6)} reason=${decodeRevertData(reason)}`
        );
      } catch (e: any) {
        const emitter = String(log.address);
        console.log(`      - emitter=${emitterLabel(emitter)}@${emitter} (failed to decode): ${e?.message ?? String(e)}`);
      }
    }
  };

  async function findLoanNftTokenIdByLoanId(owner: string, loanId: bigint): Promise<bigint | null> {
    const bal = (await loanNft.balanceOf(owner)) as bigint;
    for (let i = 0n; i < bal; i++) {
      const tokenId = (await loanNft.tokenOfOwnerByIndex(owner, i)) as bigint;
      const meta = await loanNft.getLoanMetadata(tokenId);
      if ((meta.loanId as bigint) === loanId) return tokenId;
    }
    return null;
  }

  async function assertLoanNftMintedForBorrower(borrower: string, orderId: bigint) {
    const tokenId = await findLoanNftTokenIdByLoanId(borrower, orderId);
    if (tokenId === null) throw new Error(`[LoanNFT] not minted: borrower=${borrower} orderId=${orderId.toString()}`);
    const meta = await loanNft.getLoanMetadata(tokenId);
    const st = meta.status as bigint;
    if (st !== 0n) {
      throw new Error(`[LoanNFT] unexpected status after mint: borrower=${borrower} orderId=${orderId.toString()} tokenId=${tokenId.toString()} status=${st.toString()} (expect 0=Active)`);
    }
    return tokenId;
  }

  async function assertLoanNftRepaidForBorrower(borrower: string, orderId: bigint) {
    const tokenId = await findLoanNftTokenIdByLoanId(borrower, orderId);
    if (tokenId === null) throw new Error(`[LoanNFT] missing token for repay-check: borrower=${borrower} orderId=${orderId.toString()}`);
    const meta = await loanNft.getLoanMetadata(tokenId);
    const st = meta.status as bigint;
    if (st !== 1n) {
      throw new Error(`[LoanNFT] not repaid: borrower=${borrower} orderId=${orderId.toString()} tokenId=${tokenId.toString()} status=${st.toString()} (expect 1=Repaid)`);
    }
  }

  // ============ ViewScan (broader view coverage) ============
  await scanViewModules(CONTRACT_ADDRESSES.Registry, {
    assetAddr,
    sampleUser: pairs[0].borrower.address,
  });

  // ============ Reward (Architecture-Guide: LE -> RM/Core -> RewardView) ============
  // Reward: print points in human-readable units (RewardPoints.decimals()) and assert delta == 1 point per successful loan cycle.
  const rewardView = (await ethers.getContractAt("RewardView", CONTRACT_ADDRESSES.RewardView)) as any;
  const rewardPoints = (await ethers.getContractAt(
    "src/Token/RewardPoints.sol:RewardPoints",
    CONTRACT_ADDRESSES.RewardPoints
  )) as any;
  const rewardDecimals = (await rewardPoints.decimals()) as number;
  const ONE_POINT = 10n ** BigInt(rewardDecimals);
  const fmtPoints = (x: bigint) => ethers.formatUnits(x, rewardDecimals);

  // ============ FeeRouter helpers (reuses single-asset setup) ============
  async function runFeeRouterFlow() {
    const [deployer, alice, bob, treasury, ecoVault] = await ethers.getSigners();

    console.log("\n=== FeeRouter Sub-Test (embedded) ===");
    console.log("  Using addresses:");
    console.log("   - FeeRouter:", await feeRouter.getAddress());
    console.log("   - Asset (USDC):", assetAddr);
    console.log("   - Alice (payer):", alice.address);
    console.log("   - Treasury:", treasury.address);
    console.log("   - EcoVault:", ecoVault.address);

    // Grant minimal roles used in standalone feeRouter script
    await ensureRole("DEPOSIT", alice.address);
    await ensureRole("SET_PARAMETER", deployer.address);
    await ensureRole("PAUSE_SYSTEM", deployer.address);
    await ensureRole("UNPAUSE_SYSTEM", deployer.address);

    // Fund actors
    const seed = ethers.parseUnits("30000", 6);
    await (await usdc.connect(deployer).transfer(alice.address, seed)).wait();
    await (await usdc.connect(deployer).transfer(bob.address, seed)).wait();

    // Ensure token supported
    if (!(await feeRouter.isTokenSupported(assetAddr))) {
      await (await feeRouter.connect(deployer).addSupportedToken(assetAddr)).wait();
      console.log("  ✅ Added token to FeeRouter supported list");
    }

    // Snapshot balances before distribution
    const beforeTreasury = await usdc.balanceOf(treasury.address);
    const beforeEco = await usdc.balanceOf(ecoVault.address);

    // Normal distribution
    const distributeAmt = ethers.parseUnits("1000", 6);
    await (await usdc.connect(alice).approve(await feeRouter.getAddress(), distributeAmt)).wait();
    const tx = await feeRouter.connect(alice).distributeNormal(assetAddr, distributeAmt);
    const receipt = await tx.wait();
    console.log("  ✅ distributeNormal tx:", receipt?.hash);

    // Dynamic fee flow (lightweight)
    const feeType = ethers.keccak256(ethers.toUtf8Bytes("CUSTOM_FEE"));
    await (await feeRouter.connect(deployer).setDynamicFee(assetAddr, feeType, 50)).wait(); // 0.5%
    await (await usdc.connect(alice).approve(await feeRouter.getAddress(), distributeAmt)).wait();
    await (await feeRouter.connect(alice).distributeDynamic(assetAddr, distributeAmt, feeType)).wait();
    console.log("  ✅ distributeDynamic completed");

    // Batch distribution (small)
    const amounts = [ethers.parseUnits("100", 6), ethers.parseUnits("150", 6)];
    const feeTypes = [ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT")), ethers.keccak256(ethers.toUtf8Bytes("BORROW"))];
    const totalBatch = amounts.reduce((a, b) => a + b, 0n);
    await (await usdc.connect(alice).approve(await feeRouter.getAddress(), totalBatch)).wait();
    await (await feeRouter.connect(alice).batchDistribute(assetAddr, amounts, feeTypes)).wait();
    console.log("  ✅ batchDistribute completed");

    // Balances after
    const afterTreasury = await usdc.balanceOf(treasury.address);
    const afterEco = await usdc.balanceOf(ecoVault.address);
    console.log("  Treasury delta:", ethers.formatUnits(afterTreasury - beforeTreasury, 6), "USDC");
    console.log("  EcoVault delta:", ethers.formatUnits(afterEco - beforeEco, 6), "USDC");

    // Basic sanity: total distributions counter must have advanced
    const totalDists = await feeRouter.getTotalDistributions();
    console.log("  Total distributions (FeeRouter):", totalDists.toString());

    console.log("✅ FeeRouter sub-test completed\n");
  }

  // ============ C baseline: unified version introspection ============
  async function logViewVersionInfo(label: string, view: any, expectSchema?: bigint) {
    try {
      const [apiVersion, schemaVersion, implementation] = await view.getVersionInfo();
      console.log(
        `  [VersionInfo] ${label}: api=${apiVersion.toString()} schema=${schemaVersion.toString()} implementation=${implementation}`
      );
      if (expectSchema !== undefined && schemaVersion !== expectSchema) {
        throw new Error(`[VersionInfo] ${label}: unexpected schemaVersion=${schemaVersion.toString()} expect=${expectSchema.toString()}`);
      }
    } catch (e: any) {
      console.log(`  ⚠️ [VersionInfo] ${label}: ${e?.message ?? String(e)}`);
    }
  }
  await logViewVersionInfo("PositionView", positionView, 2n);
  await logViewVersionInfo("StatisticsView", statisticsView, 1n);
  
  // Additional View modules version info
  if (healthView) {
    await logViewVersionInfo("HealthView", healthView);
  }
  
  // Try to get other View modules and log their version info
  const viewModules = [
    { moduleKey: "USER_VIEW", name: "UserView" },
    { moduleKey: "BATCH_VIEW", name: "BatchView" },
    { moduleKey: "REGISTRY_VIEW", name: "RegistryView" },
    { moduleKey: "SYSTEM_VIEW", name: "SystemView" },
    { moduleKey: "DASHBOARD_VIEW", name: "DashboardView" },
    { moduleKey: "PREVIEW_VIEW", name: "PreviewView" },
    { moduleKey: "RISK_VIEW", name: "RiskView" },
    { moduleKey: "VALUATION_ORACLE_VIEW", name: "ValuationOracleView" },
    { moduleKey: "FEE_ROUTER_VIEW", name: "FeeRouterView" },
    { moduleKey: "LENDING_ENGINE_VIEW", name: "LendingEngineView" },
    { moduleKey: "MODULE_HEALTH_VIEW", name: "ModuleHealthView" },
    { moduleKey: "LIQUIDATION_VIEW", name: "LiquidatorView" },
    { moduleKey: "LIQUIDATION_RISK_VIEW", name: "LiquidationRiskView" },
  ];
  
  for (const { moduleKey, name } of viewModules) {
    try {
      const addr = await registry.getModuleOrRevert(key(moduleKey));
      const view = (await ethers.getContractAt(name, addr)) as any;
      await logViewVersionInfo(name, view);
    } catch (e: any) {
      // Module not registered or not available, skip
    }
  }

  // Optional: print one borrower's PositionView version to visualize Phase3 monotonic updates.
  const sampleBorrowerIndex = opts?.sampleBorrowerIndex ?? parseSampleBorrowerIndexFromEnv();
  if (sampleBorrowerIndex < 0 || sampleBorrowerIndex >= pairs.length) {
    throw new Error(`E2E_SAMPLE_BORROWER_INDEX out of range: ${sampleBorrowerIndex}. Must be in [0, ${pairs.length - 1}]`);
  }
  const sampleBorrower = pairs[sampleBorrowerIndex].borrower;
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
  const ensureRole = async (roleName: string, who: string | Addressable) => {
    const whoAddr = await ethers.resolveAddress(who);
    const role = key(roleName);
    if (!(await acm.hasRole(role, whoAddr))) {
      await (await acm.grantRole(role, whoAddr)).wait();
    }
  };

  // admin/config
  await ensureRole("ADD_WHITELIST", deployer.address);
  await ensureRole("UPDATE_PRICE", deployer.address);
  await ensureRole("SET_PARAMETER", deployer.address);
  await ensureRole("ACTION_VIEW_PUSH", CONTRACT_ADDRESSES.VaultLendingEngine);
  // Allow the deployer to refresh View caches in E2E when needed (e.g., after time travel).
  await ensureRole("ACTION_VIEW_PUSH", deployer.address);
  await ensureRole("VIEW_SYSTEM_DATA", deployer.address);

  // match orchestration
  await ensureRole("ORDER_CREATE", CONTRACT_ADDRESSES.VaultBusinessLogic);
  await ensureRole("DEPOSIT", CONTRACT_ADDRESSES.VaultBusinessLogic);

  // order engine
  await ensureRole("BORROW", orderEngineAddr);

  // liquidation
  // - LiquidationManager requires caller to have LIQUIDATE
  // - VaultLendingEngine.forceReduceDebt checks LIQUIDATE on msg.sender (LiquidationManager)
  await ensureRole("LIQUIDATE", deployer.address);
  await ensureRole("LIQUIDATE", liquidationManagerAddr);

  // each borrower needs repay on order engine
  for (const { borrower } of pairs) {
    await ensureRole("REPAY", borrower.address);
  }

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
  await (await po.connect(deployer).updatePrice(assetAddr, ethers.parseUnits("1", 8), now)).wait();

  if (!(await feeRouter.isTokenSupported(assetAddr))) {
    await (await feeRouter.connect(deployer).addSupportedToken(assetAddr)).wait();
  }

  // FeeRouter coverage (aligned with standalone FeeRouter script)
  await runFeeRouterFlow();

  // Helper: push stats delta to StatisticsView.
  // 注意：当前 localhost 部署中，抵押（collateralIn）可能已由业务模块自动推送；
  // 为避免重复计数，本脚本不会在「存款」步骤调用 pushStats(collateralIn)。
  const pushStats = async (user: string, collateralIn = 0n, collateralOut = 0n, borrow = 0n, repay = 0n) => {
    await statisticsView.connect(deployer).pushUserStatsUpdate(user, collateralIn, collateralOut, borrow, repay);
  };

  const refreshViewCache = async (label: string) => {
    const stats = await statisticsView.getGlobalStatistics();
    const totalCollateral = toBigInt(stats.totalCollateral);
    const totalDebt = toBigInt(stats.totalDebt);
    const utilization = totalCollateral === 0n ? 0n : (totalDebt * WAD) / totalCollateral;
    await (await viewCache.connect(deployer).setSystemStatus(assetAddr, totalCollateral, totalDebt, utilization)).wait();
    console.log(
      `  [ViewCache] ${label}: totalCollateral=${ethers.formatUnits(totalCollateral, 6)} totalDebt=${ethers.formatUnits(
        totalDebt,
        6
      )} utilization=${ethers.formatUnits(utilization, 18)}`
    );
  };

  // ============ Parameters ============
  const collateralAmt = ethers.parseUnits("2000", 6);
  const principal = ethers.parseUnits("1000", 6); // 至少 1000 USDC 才能触发奖励系统 (MIN_ELIGIBLE_PRINCIPAL)
  const termDays = 5;
  const rateBps = 1000n;

  const expectedCollateralDelta = collateralAmt * BigInt(pairs.length);
  const expectedDebtDelta = principal * BigInt(pairs.length);

  const domain = {
    name: "RwaLending",
    version: "1",
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    verifyingContract: CONTRACT_ADDRESSES.VaultBusinessLogic,
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
      { name: "lender", type: "address" },
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "minTermDays", type: "uint16" },
      { name: "maxTermDays", type: "uint16" },
      { name: "minRateBps", type: "uint256" },
      { name: "expireAt", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
  };

  // ============ Fund users (simple) ============
  console.log("💵 Funding 10 users...");
  for (const { borrower, lender } of pairs) {
    await (await usdc.connect(deployer).transfer(borrower.address, ethers.parseUnits("20000", 6))).wait();
    await (await usdc.connect(deployer).transfer(lender.address, ethers.parseUnits("20000", 6))).wait();
  }

  // ============ Baseline snapshot (for delta-based assertions) ============
  let baselineBorrowerCollateralSum = 0n;
  let baselineBorrowerDebtSum = 0n;
  for (const { borrower } of pairs) {
    baselineBorrowerCollateralSum += await cm.getCollateral(borrower.address, assetAddr);
    baselineBorrowerDebtSum += await vle.getDebt(borrower.address, assetAddr);
  }
  const baselineStats = await statisticsView.getGlobalStatistics();

  console.log("\n=== Baseline ===");
  console.log("📗 Ledger(sum over 5 borrowers):");
  console.log("  totalCollateral:", ethers.formatUnits(baselineBorrowerCollateralSum, 6));
  console.log("  totalDebt:", ethers.formatUnits(baselineBorrowerDebtSum, 6));
  console.log("📈 StatisticsView:");
  console.log("  activeUsers:", baselineStats.activeUsers.toString());
  console.log("  totalCollateral:", ethers.formatUnits(baselineStats.totalCollateral, 6));
  console.log("  totalDebt:", ethers.formatUnits(baselineStats.totalDebt, 6));
  await logPositionViewVersion("baseline");
  await refreshViewCache("baseline snapshot");

  // Reward baseline snapshot (reward-qualifying borrower = Pair#1 borrower)
  const rewardBorrower = pairs[0].borrower;
  const rewardBalBefore = (await rewardPoints.balanceOf(rewardBorrower.address)) as bigint;
  const rewardSummaryBefore = await rewardView.connect(deployer).getUserRewardSummary(rewardBorrower.address);
  const MIN_ELIGIBLE_PRINCIPAL = 1_000e6; // 与 RewardManagerCore 中的常量保持一致
  const shouldEarnReward = principal >= MIN_ELIGIBLE_PRINCIPAL;
  console.log(
    `  [Reward] baseline: borrower=${rewardBorrower.address} pointsBalance=${fmtPoints(rewardBalBefore)} (raw=${rewardBalBefore.toString()}) totalEarned=${fmtPoints(
      rewardSummaryBefore[0]
    )} (raw=${rewardSummaryBefore[0].toString()}) totalBurned=${fmtPoints(rewardSummaryBefore[1])} pendingPenalty=${fmtPoints(
      rewardSummaryBefore[2]
    )}`
  );
  console.log(
    `  [Reward] principal=${ethers.formatUnits(principal, 6)} USDC, MIN_ELIGIBLE_PRINCIPAL=${ethers.formatUnits(MIN_ELIGIBLE_PRINCIPAL, 6)} USDC, shouldEarnReward=${shouldEarnReward}`
  );

  // ============ Step A: All borrowers deposit collateral ============
  console.log("\n=== Step A: Deposits (5 borrowers) ===");
  for (let i = 0; i < pairs.length; i++) {
    const { borrower } = pairs[i];
    // NOTE: VaultCore.deposit -> VaultRouter.processUserOperation -> CollateralManager.processDeposit,
    // so the ERC20 spender is CollateralManager (it pulls funds into the pool via transferFrom).
    await (await usdc.connect(borrower).approve(CONTRACT_ADDRESSES.CollateralManager, collateralAmt)).wait();
    await (await vaultCore.connect(borrower).deposit(assetAddr, collateralAmt)).wait();
    console.log(`  ✅ Pair ${i + 1}: borrower ${borrower.address.slice(0, 10)} deposited ${ethers.formatUnits(collateralAmt, 6)}`);
  }

  // ============ Step B: finalize 5 matches ============
  console.log("\n=== Step B: Matchflow finalize (5 loans) ===");
  const orderIds: bigint[] = [];

  for (let i = 0; i < pairs.length; i++) {
    const { borrower, lender } = pairs[i];

    const expireAt = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
    const borrowIntent = {
      borrower: borrower.address,
      collateralAsset: assetAddr,
      collateralAmount: collateralAmt,
      borrowAsset: assetAddr,
      amount: principal,
      termDays,
      rateBps,
      expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`borrow-salt-batch-${i + 1}`)),
    };

    const lendIntent = {
      lender: lender.address,
      asset: assetAddr,
      amount: principal,
      minTermDays: 1,
      maxTermDays: 30,
      minRateBps: 0n,
      expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`lend-salt-batch-${i + 1}`)),
    };

    await (await usdc.connect(lender).approve(CONTRACT_ADDRESSES.VaultBusinessLogic, principal)).wait();
    const lendHash = buildLendIntentHash(lendIntent);
    await (await vbl.connect(lender).reserveForLending(lender.address, assetAddr, principal, lendHash)).wait();

    const sigBorrower = await borrower.signTypedData(domain, typesBorrow as any, borrowIntent as any);
    const sigLender = await lender.signTypedData(domain, typesLend as any, lendIntent as any);

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
    if (orderId === null) throw new Error(`Pair ${i + 1}: LoanOrderCreated not found`);

    // DataPush: verify DataPushed events were emitted (architecture: unified DataPush interface)
    // Note: DataPushed events are emitted by various View modules via DataPushLibrary
    const dataPushedEvents = receipt!.logs.filter((log: any) => {
      try {
        // DataPushed event signature: DataPushed(bytes32 indexed dataTypeHash, bytes payload)
        // First topic is keccak256("DataPushed(bytes32,bytes)")
        const dataPushedTopic = ethers.keccak256(ethers.toUtf8Bytes("DataPushed(bytes32,bytes)"));
        return log.topics[0] === dataPushedTopic;
      } catch {
        return false;
      }
    });
    if (dataPushedEvents.length > 0) {
      console.log(`    [DataPush] ${dataPushedEvents.length} DataPushed event(s) emitted`);
      // Verify expected DataPush types (RISK_STATUS_UPDATE, USER_POSITION_UPDATE, etc.)
      const expectedTypes = [
        ethers.keccak256(ethers.toUtf8Bytes("RISK_STATUS_UPDATE")),
        ethers.keccak256(ethers.toUtf8Bytes("USER_POSITION_UPDATE")),
        ethers.keccak256(ethers.toUtf8Bytes("LOAN_CREATED")),
      ];
      for (const event of dataPushedEvents) {
        const dataTypeHash = event.topics[1]; // Second topic is dataTypeHash
        const found = expectedTypes.some((t) => t === dataTypeHash);
        if (found) {
          console.log(`      [DataPush] Found expected type: ${dataTypeHash.slice(0, 10)}...`);
        }
      }
    }

    // CacheUpdateFailed / HealthPushFailed: verify failure events (architecture: best-effort push)
    // These events should NOT be emitted in normal operation, but we check for them
    logCacheUpdateFailedEvents(receipt!.logs || [], "borrow");

    const healthPushFailedEvents = receipt!.logs.filter((log: any) => {
      try {
        // HealthPushFailed event signature from LendingEngineCore
        const healthPushFailedTopic = ethers.keccak256(ethers.toUtf8Bytes("HealthPushFailed(address,address,uint256,uint256,bytes)"));
        return log.topics[0] === healthPushFailedTopic;
      } catch {
        return false;
      }
    });
    if (healthPushFailedEvents.length > 0) {
      console.log(`    ⚠️ [HealthPushFailed] ${healthPushFailedEvents.length} failure event(s) detected`);
    }

    orderIds.push(orderId);
    await pushStats(borrower.address, 0n, 0n, principal, 0n);
    console.log(`  ✅ Pair ${i + 1}: orderId=${orderId.toString()} borrower=${borrower.address.slice(0, 10)} lender=${lender.address.slice(0, 10)}`);

    // LoanNFT: ensure minted and loanId matches orderId (architecture: ORDER_ENGINE triggers LoanNFT mint)
    const tokenId = await assertLoanNftMintedForBorrower(borrower.address, orderId);
    console.log(`    [LoanNFT] minted: borrower=${borrower.address.slice(0, 10)} tokenId=${tokenId.toString()} loanId=${orderId.toString()} status=Active`);

    // HealthView: verify health factor was pushed after borrow (architecture: LE -> HealthView.pushRiskStatus)
    if (healthView) {
      try {
        const [hfBps, isValid] = await healthView.getUserHealthFactor(borrower.address);
        if (isValid) {
          const hfPercent = Number(hfBps) / 100;
          console.log(`    [HealthView] healthFactor=${hfPercent.toFixed(2)}% (${hfBps.toString()} bps) isValid=${isValid}`);
          // Health factor should be > 100% (10000 bps) for healthy position (collateral > debt)
          if (hfBps < 10000n) {
            console.log(`    ⚠️ [HealthView] Warning: health factor below 100% (${hfPercent.toFixed(2)}%)`);
          }
        } else {
          console.log(`    ⚠️ [HealthView] health factor cache not valid yet for ${borrower.address.slice(0, 10)}`);
        }
      } catch (e: any) {
        console.log(`    ⚠️ [HealthView] Failed to query health factor: ${e?.message ?? String(e)}`);
      }
    }
  }

  // ============ Check totals after match ============
  console.log("\n=== Checkpoint 1: Totals after all matches ===");

  let ledgerCollateralSum = 0n;
  let ledgerDebtSum = 0n;
  for (const { borrower } of pairs) {
    ledgerCollateralSum += await cm.getCollateral(borrower.address, assetAddr);
    ledgerDebtSum += await vle.getDebt(borrower.address, assetAddr);
  }

  const stats1 = await statisticsView.getGlobalStatistics();

  const ledgerCollateralDelta = ledgerCollateralSum - baselineBorrowerCollateralSum;
  const ledgerDebtDelta = ledgerDebtSum - baselineBorrowerDebtSum;
  const statsCollateralDelta = toBigInt(stats1.totalCollateral) - toBigInt(baselineStats.totalCollateral);
  const statsDebtDelta = toBigInt(stats1.totalDebt) - toBigInt(baselineStats.totalDebt);

  console.log("📊 Expected deltas (from baseline):");
  console.log("  collateralDelta:", ethers.formatUnits(expectedCollateralDelta, 6));
  console.log("  debtDelta:", ethers.formatUnits(expectedDebtDelta, 6));

  console.log("📗 Ledger(sum over 5 borrowers):");
  console.log("  totalCollateral:", ethers.formatUnits(ledgerCollateralSum, 6));
  console.log("  totalDebt:", ethers.formatUnits(ledgerDebtSum, 6));
  console.log("  deltaCollateral:", ethers.formatUnits(ledgerCollateralDelta, 6));
  console.log("  deltaDebt:", ethers.formatUnits(ledgerDebtDelta, 6));

  console.log("📈 StatisticsView:");
  console.log("  activeUsers:", stats1.activeUsers.toString());
  console.log("  totalCollateral:", ethers.formatUnits(stats1.totalCollateral, 6));
  console.log("  totalDebt:", ethers.formatUnits(stats1.totalDebt, 6));
  console.log("  deltaCollateral:", ethers.formatUnits(statsCollateralDelta, 6));
  console.log("  deltaDebt:", ethers.formatUnits(statsDebtDelta, 6));

  if (ledgerCollateralDelta !== expectedCollateralDelta) throw new Error("Ledger collateral delta mismatch vs expected");
  if (ledgerDebtDelta !== expectedDebtDelta) throw new Error("Ledger debt delta mismatch vs expected");
  if (statsCollateralDelta !== expectedCollateralDelta) throw new Error("StatisticsView collateral delta mismatch vs expected");
  if (statsDebtDelta !== expectedDebtDelta) throw new Error("StatisticsView debt delta mismatch vs expected");

  console.log("✅ Checkpoint 1 passed: ledger == statistics == expected");
  await logPositionViewVersion("checkpoint 1 (after matches)");
  await refreshViewCache("after matches");

  // HealthView: batch verify health factors for all borrowers
  if (healthView) {
    console.log("\n=== HealthView: Batch Health Factor Check (after matches) ===");
    const borrowerAddrs = pairs.map((p) => p.borrower.address);
    try {
      const [hfs, validFlags] = await healthView.batchGetHealthFactors(borrowerAddrs);
      for (let i = 0; i < borrowerAddrs.length; i++) {
        const hfPercent = Number(hfs[i]) / 100;
        console.log(
          `  Borrower ${i + 1} (${borrowerAddrs[i].slice(0, 10)}): healthFactor=${hfPercent.toFixed(2)}% (${hfs[i].toString()} bps) isValid=${validFlags[i]}`
        );
      }
    } catch (e: any) {
      console.log(`  ⚠️ [HealthView] Batch query failed: ${e?.message ?? String(e)}`);
    }
  }

  // ============ Step C: repay all orders ============
  console.log("\n=== Step C: Repay all orders (5 borrowers) ===");
  const termSec = BigInt(termDays) * ONE_DAY;

  // 加速时间到接近到期日（在 ON_TIME_WINDOW 内），以便触发"按期还款"奖励
  // ON_TIME_WINDOW = 24 hours，我们提前 1 小时还款（在窗口内）
  const timeToAdvance = termSec - 1n * 60n * 60n; // termDays - 1 hour
  console.log(`  ⏰ Advancing time by ${timeToAdvance.toString()} seconds (${termDays} days - 1 hour) to simulate near-maturity repayment...`);
  await ethers.provider.send("evm_increaseTime", [Number(timeToAdvance)]);
  await ethers.provider.send("evm_mine", []);

  // IMPORTANT:
  // PriceOracle 默认 maxPriceAge=3600s；上面的时间旅行会让价格“过期”，导致
  // - cm.getUserTotalCollateralValue(...) revert: PriceOracle__StalePrice()
  // - repay 内部的 HealthView push 失败（LendingEngineCore 会 emit HealthPushFailed/CacheUpdateFailed）
  // 所以在 repay 之前先刷新一次价格时间戳（价格本身不变即可）。
  try {
    const nowAfterWarp = (await ethers.provider.getBlock("latest"))!.timestamp;
    const pd = await po.getPriceData(assetAddr);
    const price = toBigInt((pd as any).price);
    await (await po.connect(deployer).updatePrice(assetAddr, price, nowAfterWarp)).wait();
    console.log(`  ✅ Refreshed PriceOracle timestamp for ${assetAddr.slice(0, 10)} (price unchanged)`);
  } catch (e: any) {
    console.log(`  ⚠️ [PriceOracle] Failed to refresh price after time travel: ${e?.message ?? String(e)}`);
  }

  for (let i = 0; i < pairs.length; i++) {
    const { borrower } = pairs[i];
    const orderId = orderIds[i];
    const totalDue = calcTotalDue(principal, rateBps, termSec);
    await (await usdc.connect(borrower).approve(orderEngineAddr, totalDue)).wait();
    const repayTx = await orderEngine.connect(borrower).repay(orderId, totalDue);
    const repayReceipt = await repayTx.wait();
    // StatisticsView 的 debt 口径按「本金」统计；repay 的利息/费用不应作为 debt 减项推送，否则会出现负 delta
    await pushStats(borrower.address, 0n, 0n, 0n, principal);
    console.log(`  ✅ Pair ${i + 1}: repaid orderId=${orderId.toString()} totalDue=${ethers.formatUnits(totalDue, 6)}`);

    // LoanNFT: ensure status updated to Repaid after repay
    await assertLoanNftRepaidForBorrower(borrower.address, orderId);
    console.log(`    [LoanNFT] repaid: borrower=${borrower.address.slice(0, 10)} loanId=${orderId.toString()} status=Repaid`);

    // Best-effort: surface push failures (helps explain stale HealthView after time travel)
    {
      const healthPushFailedTopic = ethers.keccak256(ethers.toUtf8Bytes("HealthPushFailed(address,address,uint256,uint256,bytes)"));
      const healthFails = (repayReceipt!.logs || []).filter((log: any) => log.topics?.[0] === healthPushFailedTopic);
      logCacheUpdateFailedEvents(repayReceipt!.logs || [], "repay");
      if (healthFails.length > 0) console.log(`    ⚠️ [HealthPushFailed] ${healthFails.length} failure event(s) detected (repay)`);
    }

    // HealthView: verify health factor was updated after repay (architecture: LE -> HealthView.pushRiskStatus)
    if (healthView) {
      try {
        const [hfBps, isValid] = await healthView.getUserHealthFactor(borrower.address);
        if (isValid) {
          if (hfBps === ethers.MaxUint256) {
            console.log(`    [HealthView] healthFactor=∞ (${hfBps.toString()} bps) isValid=${isValid}`);
          } else {
            const hfPercent = Number(hfBps) / 100;
            console.log(`    [HealthView] healthFactor=${hfPercent.toFixed(2)}% (${hfBps.toString()} bps) isValid=${isValid}`);
          }
          // After full repay, health factor should be very high (debt = 0, only collateral remains)
          if (hfBps !== ethers.MaxUint256 && hfBps < 10000n) {
            const hfPercent = Number(hfBps) / 100;
            console.log(`    ⚠️ [HealthView] Warning: health factor below 100% after repay (${hfPercent.toFixed(2)}%)`);
          }
        } else {
          console.log(`    ⚠️ [HealthView] health factor cache not valid yet for ${borrower.address.slice(0, 10)}`);
          // Fallback (E2E only): refresh HealthView after time-travel so cache becomes valid immediately.
          try {
            const totalCollateral = (await cm.getUserTotalCollateralValue(borrower.address)) as bigint;
            const totalDebt = (await vle.getUserTotalDebtValue(borrower.address)) as bigint;
            const minHFBps = (await liquidationRiskManager.getMinHealthFactor()) as bigint;
            const under = totalDebt > 0n && totalCollateral * 10000n < totalDebt * minHFBps;
            const hfBpsNew = totalDebt === 0n ? ethers.MaxUint256 : (totalCollateral * 10000n) / totalDebt;
            await (await healthView.connect(deployer).pushRiskStatus(borrower.address, hfBpsNew, minHFBps, under, 0)).wait();
            const [hf2, valid2] = await healthView.getUserHealthFactor(borrower.address);
            if (valid2) {
              if (hf2 === ethers.MaxUint256) {
                console.log(`    [HealthView] refreshed: healthFactor=∞ (${hf2.toString()} bps) isValid=${valid2}`);
              } else {
                const hfPercent2 = Number(hf2) / 100;
                console.log(`    [HealthView] refreshed: healthFactor=${hfPercent2.toFixed(2)}% (${hf2.toString()} bps) isValid=${valid2}`);
              }
            } else {
              console.log(`    ⚠️ [HealthView] refresh attempted but cache still invalid`);
            }
          } catch (e2: any) {
            console.log(`    ⚠️ [HealthView] Failed to refresh cache: ${e2?.message ?? String(e2)}`);
          }
        }
      } catch (e: any) {
        console.log(`    ⚠️ [HealthView] Failed to query health factor: ${e?.message ?? String(e)}`);
      }
    }
  }

  // ============ Check totals after repay ============
  console.log("\n=== Checkpoint 2: Totals after all repaid ===");

  ledgerCollateralSum = 0n;
  ledgerDebtSum = 0n;
  for (const { borrower } of pairs) {
    ledgerCollateralSum += await cm.getCollateral(borrower.address, assetAddr);
    ledgerDebtSum += await vle.getDebt(borrower.address, assetAddr);
  }

  const stats2 = await statisticsView.getGlobalStatistics();
  const ledgerCollateralDelta2 = ledgerCollateralSum - baselineBorrowerCollateralSum;
  const ledgerDebtDelta2 = ledgerDebtSum - baselineBorrowerDebtSum;
  const statsCollateralDelta2 = toBigInt(stats2.totalCollateral) - toBigInt(baselineStats.totalCollateral);
  const statsDebtDelta2 = toBigInt(stats2.totalDebt) - toBigInt(baselineStats.totalDebt);

  console.log("📗 Ledger(sum over 5 borrowers):");
  console.log("  totalCollateral:", ethers.formatUnits(ledgerCollateralSum, 6));
  console.log("  totalDebt:", ethers.formatUnits(ledgerDebtSum, 6));
  console.log("  deltaCollateral:", ethers.formatUnits(ledgerCollateralDelta2, 6));
  console.log("  deltaDebt:", ethers.formatUnits(ledgerDebtDelta2, 6));

  console.log("📈 StatisticsView:");
  console.log("  activeUsers:", stats2.activeUsers.toString());
  console.log("  totalCollateral:", ethers.formatUnits(stats2.totalCollateral, 6));
  console.log("  totalDebt:", ethers.formatUnits(stats2.totalDebt, 6));
  console.log("  deltaCollateral:", ethers.formatUnits(statsCollateralDelta2, 6));
  console.log("  deltaDebt:", ethers.formatUnits(statsDebtDelta2, 6));

  if (ledgerCollateralDelta2 !== expectedCollateralDelta) throw new Error("Ledger collateral delta mismatch after repay");
  if (ledgerDebtDelta2 !== 0n) throw new Error("Ledger debt delta should be 0 after repay (new loans fully repaid)");
  if (statsCollateralDelta2 !== expectedCollateralDelta) throw new Error("StatisticsView collateral delta mismatch after repay");
  if (statsDebtDelta2 !== 0n) throw new Error("StatisticsView debt delta should be 0 after repay (new loans fully repaid)");

  console.log("✅ Checkpoint 2 passed: ledger == statistics, debt cleared");
  await logPositionViewVersion("checkpoint 2 (after all repaid)");
  await refreshViewCache("after repayments");

  // HealthView: batch verify health factors after all repaid
  if (healthView) {
    console.log("\n=== HealthView: Batch Health Factor Check (after all repaid) ===");
    const borrowerAddrs = pairs.map((p) => p.borrower.address);
    try {
      const [hfs, validFlags] = await healthView.batchGetHealthFactors(borrowerAddrs);
      for (let i = 0; i < borrowerAddrs.length; i++) {
        const hfPercent = Number(hfs[i]) / 100;
        console.log(
          `  Borrower ${i + 1} (${borrowerAddrs[i].slice(0, 10)}): healthFactor=${hfPercent.toFixed(2)}% (${hfs[i].toString()} bps) isValid=${validFlags[i]}`
        );
        // After full repay, health factor should be very high (debt = 0, only collateral)
        if (validFlags[i] && hfs[i] < 10000n) {
          console.log(`    ⚠️ Warning: health factor below 100% after full repay`);
        }
      }
    } catch (e: any) {
      console.log(`  ⚠️ [HealthView] Batch query failed: ${e?.message ?? String(e)}`);
    }
  }

  // Reward assertion: borrower#1 should have earned points after on-time full repay (only if amount >= 1000e6)
  const rewardBalAfter = (await rewardPoints.balanceOf(rewardBorrower.address)) as bigint;
  const rewardSummaryAfter = await rewardView.connect(deployer).getUserRewardSummary(rewardBorrower.address);
  console.log(
    `  [Reward] after repay: borrower=${rewardBorrower.address} pointsBalance=${fmtPoints(rewardBalAfter)} (raw=${rewardBalAfter.toString()}) totalEarned=${fmtPoints(
      rewardSummaryAfter[0]
    )} (raw=${rewardSummaryAfter[0].toString()}) totalBurned=${fmtPoints(rewardSummaryAfter[1])} pendingPenalty=${fmtPoints(
      rewardSummaryAfter[2]
    )}`
  );
  const balDelta = rewardBalAfter - rewardBalBefore;
  const earnedDelta = (rewardSummaryAfter[0] as bigint) - (rewardSummaryBefore[0] as bigint);
  
  if (shouldEarnReward) {
    // 借款金额 >= 1000 USDC，应该发放积分
    if (balDelta !== ONE_POINT) throw new Error(`[Reward] expected points balance delta == 1 (got ${fmtPoints(balDelta)} raw=${balDelta.toString()})`);
    if (earnedDelta !== ONE_POINT) throw new Error(`[Reward] expected totalEarned delta == 1 (got ${fmtPoints(earnedDelta)} raw=${earnedDelta.toString()})`);
    if (rewardSummaryAfter[2] !== 0n) throw new Error("[Reward] expected pendingPenalty == 0 for on-time full repay (pair#1)");
    console.log("  ✅ Reward assertion passed: points earned as expected (principal >= 1000 USDC)");
  } else {
    // 借款金额 < 1000 USDC，不应该发放积分（但程序应该正常运行）
    if (balDelta !== 0n) throw new Error(`[Reward] expected no points for principal < 1000 USDC (got ${fmtPoints(balDelta)} raw=${balDelta.toString()})`);
    if (earnedDelta !== 0n) throw new Error(`[Reward] expected no totalEarned delta for principal < 1000 USDC (got ${fmtPoints(earnedDelta)} raw=${earnedDelta.toString()})`);
    console.log("  ✅ Reward assertion passed: no points earned as expected (principal < 1000 USDC)");
  }

  // ============ Additional View Modules Testing ============
  console.log("\n=== Additional View Modules Testing ===");
  
  // UserView: test user dimension aggregation
  try {
    const userViewAddr = await registry.getModuleOrRevert(key("USER_VIEW"));
    const userView = (await ethers.getContractAt("UserView", userViewAddr)) as any;
    console.log("  [UserView] Testing user dimension queries...");
    
    const sampleUser = pairs[0].borrower.address;
    try {
      const [col, debt] = await userView.getUserPosition(sampleUser, assetAddr);
      console.log(`    [UserView] getUserPosition: col=${ethers.formatUnits(col, 6)} debt=${ethers.formatUnits(debt, 6)}`);
    } catch (e: any) {
      console.log(`    ⚠️ [UserView] getUserPosition failed: ${e?.message ?? String(e)}`);
    }
  } catch (e: any) {
    console.log(`  ⚠️ [UserView] Module not available: ${e?.message ?? String(e)}`);
  }

  // BatchView: test batch queries
  try {
    const batchViewAddr = await registry.getModuleOrRevert(key("BATCH_VIEW"));
    const batchView = (await ethers.getContractAt("BatchView", batchViewAddr)) as any;
    console.log("  [BatchView] Testing batch queries...");
    
    const sampleUsers = pairs.slice(0, 3).map((p) => p.borrower.address);
    try {
      // Test batch price query if available
      const assets = [assetAddr];
      try {
        const prices = await batchView.batchGetPrices(assets);
        console.log(`    [BatchView] batchGetPrices: ${prices.length} price(s) retrieved`);
      } catch (e: any) {
        // Method might not exist or require different params
      }
    } catch (e: any) {
      console.log(`    ⚠️ [BatchView] Batch query failed: ${e?.message ?? String(e)}`);
    }
  } catch (e: any) {
    console.log(`  ⚠️ [BatchView] Module not available: ${e?.message ?? String(e)}`);
  }

  // RegistryView: test module discovery
  try {
    const registryViewAddr = await registry.getModuleOrRevert(key("REGISTRY_VIEW"));
    const registryView = (await ethers.getContractAt("RegistryView", registryViewAddr)) as any;
    console.log("  [RegistryView] Testing module discovery...");
    
    try {
      // Use getRegisteredModuleKeysPaginated to get totalCount
      const limit = 5n;
      const [modules, totalCount] = await registryView.getRegisteredModuleKeysPaginated(0n, limit);
      console.log(`    [RegistryView] Total modules registered: ${totalCount.toString()}`);
      console.log(`    [RegistryView] First ${modules.length} modules retrieved`);
    } catch (e: any) {
      console.log(`    ⚠️ [RegistryView] Query failed: ${e?.message ?? String(e)}`);
    }
  } catch (e: any) {
    console.log(`  ⚠️ [RegistryView] Module not available: ${e?.message ?? String(e)}`);
  }

  // SystemView: test unified entry point
  try {
    const systemViewAddr = await registry.getModuleOrRevert(key("SYSTEM_VIEW"));
    const systemView = (await ethers.getContractAt("SystemView", systemViewAddr)) as any;
    console.log("  [SystemView] Testing unified entry point...");
    
    try {
      // SystemView should provide registry access (use registry() instead of getRegistry())
      const regAddr = await systemView.registry();
      console.log(`    [SystemView] Registry address: ${regAddr}`);
      
      // Try to get a module through SystemView
      const cmKey = key("COLLATERAL_MANAGER");
      const cmAddr = await systemView.getModule(cmKey);
      console.log(`    [SystemView] CM module resolved: ${cmAddr}`);
    } catch (e: any) {
      console.log(`    ⚠️ [SystemView] Query failed: ${e?.message ?? String(e)}`);
    }
  } catch (e: any) {
    console.log(`  ⚠️ [SystemView] Module not available: ${e?.message ?? String(e)}`);
  }

  console.log("\n✅ Batch E2E Completed!");

  // ============ Additional Test Case: Small Amount Loan (< 1000 USDC) ============
  // 测试用例：验证借款金额 < 1000 USDC 时，不发放积分，但程序正常运行
  console.log("\n=== Additional Test: Small Amount Loan (< 1000 USDC) ===");
  const smallAmountBorrower = pairs[0].borrower;
  const smallAmountLender = pairs[0].lender;
  const smallCollateralAmt = ethers.parseUnits("1000", 6);
  const smallPrincipal = ethers.parseUnits("500", 6); // < 1000 USDC，不应该发放积分
  const smallTermDays = 5;

  console.log(`  Testing borrower: ${smallAmountBorrower.address.slice(0, 10)}`);
  console.log(`  Principal: ${ethers.formatUnits(smallPrincipal, 6)} USDC (should NOT earn reward)`);

  // Baseline for small amount test
  const smallRewardBalBefore = (await rewardPoints.balanceOf(smallAmountBorrower.address)) as bigint;
  const smallRewardSummaryBefore = await rewardView.connect(deployer).getUserRewardSummary(smallAmountBorrower.address);

  // Deposit collateral
  // VaultCore.deposit -> VaultRouter -> CollateralManager, so approve CollateralManager.
  await (await usdc.connect(smallAmountBorrower).approve(CONTRACT_ADDRESSES.CollateralManager, smallCollateralAmt)).wait();
  await (await vaultCore.connect(smallAmountBorrower).deposit(assetAddr, smallCollateralAmt)).wait();
  console.log("  ✅ Small amount deposit completed");

  // Create and finalize match
  const smallExpireAt = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
  const smallBorrowIntent = {
    borrower: smallAmountBorrower.address,
    collateralAsset: assetAddr,
    collateralAmount: smallCollateralAmt,
    borrowAsset: assetAddr,
    amount: smallPrincipal,
    termDays: smallTermDays,
    rateBps,
    expireAt: smallExpireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes(`small-amount-borrow-test`)),
  };

  const smallLendIntent = {
    lender: smallAmountLender.address,
    asset: assetAddr,
    amount: smallPrincipal,
    minTermDays: 1,
    maxTermDays: 30,
    minRateBps: 0n,
    expireAt: smallExpireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes(`small-amount-lend-test`)),
  };

  await (await usdc.connect(smallAmountLender).approve(CONTRACT_ADDRESSES.VaultBusinessLogic, smallPrincipal)).wait();
  const smallLendHash = buildLendIntentHash(smallLendIntent);
  await (await vbl.connect(smallAmountLender).reserveForLending(smallAmountLender.address, assetAddr, smallPrincipal, smallLendHash)).wait();

  const smallSigBorrower = await smallAmountBorrower.signTypedData(domain, typesBorrow as any, smallBorrowIntent as any);
  const smallSigLender = await smallAmountLender.signTypedData(domain, typesLend as any, smallLendIntent as any);

  const smallTx = await vbl.connect(deployer).finalizeMatch(smallBorrowIntent, [smallLendIntent], smallSigBorrower, [smallSigLender]);
  const smallReceipt = await smallTx.wait();

  let smallOrderId: bigint | null = null;
  for (const log of smallReceipt!.logs) {
    try {
      const parsed = orderEngine.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "LoanOrderCreated") {
        smallOrderId = parsed.args.orderId as bigint;
        break;
      }
    } catch {
      // ignore
    }
  }
  if (smallOrderId === null) throw new Error("Small amount test: LoanOrderCreated not found");
  console.log(`  ✅ Small amount loan created: orderId=${smallOrderId.toString()}`);

  await pushStats(smallAmountBorrower.address, 0n, 0n, smallPrincipal, 0n);

  // Advance time to near maturity
  const smallTermSec = BigInt(smallTermDays) * ONE_DAY;
  const smallTimeToAdvance = smallTermSec - 1n * 60n * 60n;
  await ethers.provider.send("evm_increaseTime", [Number(smallTimeToAdvance)]);
  await ethers.provider.send("evm_mine", []);

  // Repay
  const smallTotalDue = calcTotalDue(smallPrincipal, rateBps, smallTermSec);
  await (await usdc.connect(smallAmountBorrower).approve(orderEngineAddr, smallTotalDue)).wait();
  await (await orderEngine.connect(smallAmountBorrower).repay(smallOrderId, smallTotalDue)).wait();
  await pushStats(smallAmountBorrower.address, 0n, 0n, 0n, smallPrincipal);
  console.log(`  ✅ Small amount loan repaid: orderId=${smallOrderId.toString()}`);

  // Verify no reward points were earned
  const smallRewardBalAfter = (await rewardPoints.balanceOf(smallAmountBorrower.address)) as bigint;
  const smallRewardSummaryAfter = await rewardView.connect(deployer).getUserRewardSummary(smallAmountBorrower.address);
  const smallBalDelta = smallRewardBalAfter - smallRewardBalBefore;
  const smallEarnedDelta = (smallRewardSummaryAfter[0] as bigint) - (smallRewardSummaryBefore[0] as bigint);

  console.log(
    `  [Reward] small amount test: pointsBalance=${fmtPoints(smallRewardBalAfter)} (delta=${fmtPoints(smallBalDelta)}) totalEarned=${fmtPoints(
      smallRewardSummaryAfter[0]
    )} (delta=${fmtPoints(smallEarnedDelta)})`
  );

  if (smallBalDelta !== 0n) {
    throw new Error(
      `[Reward] Small amount test failed: expected no points for principal < 1000 USDC (got ${fmtPoints(smallBalDelta)} raw=${smallBalDelta.toString()})`
    );
  }
  if (smallEarnedDelta !== 0n) {
    throw new Error(
      `[Reward] Small amount test failed: expected no totalEarned delta for principal < 1000 USDC (got ${fmtPoints(smallEarnedDelta)} raw=${smallEarnedDelta.toString()})`
    );
  }

  console.log("  ✅ Small amount test passed: no reward points earned (as expected for principal < 1000 USDC)");
  console.log("  ✅ Program continued running normally despite no reward (as expected)");

  // ============ Additional Test Case: Liquidation (Direct ledger + single push) ============
  // 目的：把清算模块（LM 唯一入口 + CM.withdrawCollateralTo + LE.forceReduceDebt + LiquidatorView 单点推送）纳入本地 E2E 脚本覆盖。
  console.log("\n=== Additional Test: Liquidation (Direct ledger + single push) ===");

  // Reuse borrower/lender but create a fresh order and liquidate it (do NOT repay this order).
  const liqBorrower = pairs[0].borrower;
  const liqLender = pairs[0].lender;

  const liqPrincipal = ethers.parseUnits("300", 6);
  const liqCollateralAmt = ethers.parseUnits("500", 6);
  const liqSeize = ethers.parseUnits("120", 6);
  const liqReduce = ethers.parseUnits("120", 6);
  const liqBonus = 0n;

  // Snapshot before
  const liqColBefore = (await cm.getCollateral(liqBorrower.address, assetAddr)) as bigint;
  const liqDebtBefore = (await vle.getDebt(liqBorrower.address, assetAddr)) as bigint;
  // NOTE: do NOT snapshot liquidator balance here. finalizeMatch may legitimately transfer protocol fees
  // to the executor (deployer), which would pollute the "liquidation received amount" assertion.

  // Ensure enough collateral for this scenario (deposit extra collateral into CM via VaultCore)
  // VaultCore.deposit -> VaultRouter -> CollateralManager, so approve CollateralManager.
  await (await usdc.connect(liqBorrower).approve(CONTRACT_ADDRESSES.CollateralManager, liqCollateralAmt)).wait();
  await (await vaultCore.connect(liqBorrower).deposit(assetAddr, liqCollateralAmt)).wait();
  console.log(`  ✅ Liquidation scenario: borrower deposited extra ${ethers.formatUnits(liqCollateralAmt, 6)} USDC collateral`);

  // Create a new order (borrow) but do not repay
  const liqExpireAt = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
  const liqBorrowIntent = {
    borrower: liqBorrower.address,
    collateralAsset: assetAddr,
    collateralAmount: liqCollateralAmt,
    borrowAsset: assetAddr,
    amount: liqPrincipal,
    termDays: smallTermDays,
    rateBps,
    expireAt: liqExpireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes(`liq-borrow-${Date.now()}`)),
  };

  const liqLendIntent = {
    lender: liqLender.address,
    asset: assetAddr,
    amount: liqPrincipal,
    minTermDays: 1,
    maxTermDays: 30,
    minRateBps: 0n,
    expireAt: liqExpireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes(`liq-lend-${Date.now()}`)),
  };

  await (await usdc.connect(liqLender).approve(CONTRACT_ADDRESSES.VaultBusinessLogic, liqPrincipal)).wait();
  const liqLendHash = buildLendIntentHash(liqLendIntent);
  await (await vbl.connect(liqLender).reserveForLending(liqLender.address, assetAddr, liqPrincipal, liqLendHash)).wait();

  const liqSigBorrower = await liqBorrower.signTypedData(domain, typesBorrow as any, liqBorrowIntent as any);
  const liqSigLender = await liqLender.signTypedData(domain, typesLend as any, liqLendIntent as any);
  const liqTx = await vbl.connect(deployer).finalizeMatch(liqBorrowIntent, [liqLendIntent], liqSigBorrower, [liqSigLender]);
  const liqReceipt = await liqTx.wait();
  console.log("  ✅ Liquidation scenario: new loan created (not repaid)");

  // Now execute liquidation (direct ledger)
  const liquidatorBalBefore = (await usdc.balanceOf(deployer.address)) as bigint;
  const txLiq = await liquidationManager
    .connect(deployer)
    .liquidate(liqBorrower.address, assetAddr, assetAddr, liqSeize, liqReduce, liqBonus);
  const receiptLiq = await txLiq.wait();
  console.log(`  ✅ Liquidation executed: seize=${ethers.formatUnits(liqSeize, 6)} reduceDebt=${ethers.formatUnits(liqReduce, 6)}`);

  // Assert ledger deltas
  const liqColAfter = (await cm.getCollateral(liqBorrower.address, assetAddr)) as bigint;
  const liqDebtAfter = (await vle.getDebt(liqBorrower.address, assetAddr)) as bigint;
  const liquidatorBalAfter = (await usdc.balanceOf(deployer.address)) as bigint;

  if (liqColAfter !== liqColBefore + liqCollateralAmt - liqSeize) {
    throw new Error(
      `[Liquidation] collateral mismatch: before=${liqColBefore} after=${liqColAfter} expected=${liqColBefore + liqCollateralAmt - liqSeize}`
    );
  }

  // debtBefore includes any prior debt + this new liqPrincipal; liquidation reduces by liqReduce
  if (liqDebtAfter !== liqDebtBefore + liqPrincipal - liqReduce) {
    throw new Error(
      `[Liquidation] debt mismatch: before=${liqDebtBefore} after=${liqDebtAfter} expected=${liqDebtBefore + liqPrincipal - liqReduce}`
    );
  }

  if (liquidatorBalAfter - liquidatorBalBefore !== liqSeize) {
    throw new Error(
      `[Liquidation] liquidator did not receive seized collateral: delta=${liquidatorBalAfter - liquidatorBalBefore} expected=${liqSeize}`
    );
  }

  // Assert single-point DataPush emitted for liquidation update (LiquidatorView emits DataPushed)
  const dataPushedTopic = ethers.keccak256(ethers.toUtf8Bytes("DataPushed(bytes32,bytes)"));
  const liqUpdateType = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATION_UPDATE"));
  const liqDataPushed = (receiptLiq!.logs || []).some((log: any) => log.topics?.[0] === dataPushedTopic && log.topics?.[1] === liqUpdateType);
  if (!liqDataPushed) {
    throw new Error("[Liquidation] expected LIQUIDATION_UPDATE DataPushed from LiquidatorView");
  }
  console.log("  ✅ Liquidation DataPush assertion passed (LIQUIDATION_UPDATE)");
}

// Keep backward-compatible CLI entrypoint (`npx hardhat run ...`)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const _isMain = typeof require !== "undefined" && require.main === module;
if (_isMain) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
