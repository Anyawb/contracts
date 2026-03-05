import { ethers, network } from "hardhat";
import { getErc20, key } from "./_fundsFlowUtils";
import { loadAddressMap, resolveAddress } from "./_addressResolver";

const ONE_DAY = 24n * 60n * 60n;
const ONE_HOUR_BLOCKS = 1_800n;

async function latestBlockNumber(): Promise<bigint> {
  return BigInt(await ethers.provider.getBlockNumber());
}

function envBool(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "y") return true;
  if (v === "0" || v === "false" || v === "no" || v === "n") return false;
  return defaultValue;
}

function fmtErr(e: any) {
  return e?.shortMessage ?? e?.message ?? String(e);
}

function calcInterest(principal: bigint, rateBps: bigint, termSec: bigint) {
  const YEAR = 365n * ONE_DAY;
  return (principal * rateBps * termSec) / (10_000n * YEAR);
}

async function pickCleanSigner(opts: {
  signers: any[];
  exclude: Set<string>;
  vLe: any;
  cm: any;
  allowDirty: boolean;
}) {
  const { signers, exclude, vLe, cm, allowDirty } = opts;
  // Prefer a signer that has: no debt AND no collateral assets.
  for (let i = 2; i < signers.length; i++) {
    const s = signers[i];
    const k = s.address.toLowerCase();
    if (exclude.has(k)) continue;
    const [debtValue, assets] = await Promise.all([
      (vLe.getUserTotalDebtValue(s.address) as Promise<bigint>),
      (cm.getUserCollateralAssets(s.address) as Promise<string[]>).catch(() => [] as string[]),
    ]);
    if (debtValue === 0n && (assets?.length ?? 0) === 0) {
      exclude.add(k);
      return s;
    }
  }
  if (!allowDirty) {
    throw new Error(
      "No clean signer found. Restart localhost node for a clean state, or set E2E_ALLOW_DIRTY_STATE=1."
    );
  }
  // Dirty fallback: any unused signer.
  for (let i = 2; i < signers.length; i++) {
    const s = signers[i];
    const k = s.address.toLowerCase();
    if (exclude.has(k)) continue;
    exclude.add(k);
    return s;
  }
  throw new Error("No unused signer available.");
}

async function main() {
  const supportsHardhat = network.name === "localhost" || network.name === "hardhat";
  const readOnly = envBool("READ_ONLY", network.name !== "localhost");
  const enableWrite = envBool("ENABLE_WRITE", !readOnly);

  // This smoke step runs in a shared localhost chain (smoke runner executes multiple scripts sequentially).
  // To avoid cross-test coupling (e.g. leaving ERC20 allowances that break later "expected revert" checks),
  // we snapshot+revert by default. Set KEEP_STATE=1 to keep state (not recommended in the runner).
  const KEEP_STATE = envBool("KEEP_STATE", false);
  const USE_SNAPSHOT = envBool("USE_SNAPSHOT", supportsHardhat && enableWrite && !KEEP_STATE);
  const snap = USE_SNAPSHOT ? ((await ethers.provider.send("evm_snapshot", [])) as string) : "";
  try {
  const STRICT = envBool("STRICT", true);
  const allowDirty = envBool("E2E_ALLOW_DIRTY_STATE", false);
  const noAutoGrant = envBool("NO_AUTO_GRANT", false);

  const signers = await ethers.getSigners();
  const deployer = signers[0];

  const addressMap = loadAddressMap(network.name);
  const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });

  // ---- SSOT bootstrap: Registry drift safe ----
  const registryBootstrap = (await ethers.getContractAt("Registry", registryAddr)) as any;
  const settlementManagerBootstrapAddr = (await registryBootstrap.getModuleOrRevert(
    key("SETTLEMENT_MANAGER")
  )) as string;
  const settlementManager = (await ethers.getContractAt(
    "SettlementManager",
    settlementManagerBootstrapAddr
  )) as any;
  const registryAddrSSOT = (await settlementManager.registryAddrVar()) as string;
  const registry = (await ethers.getContractAt("Registry", registryAddrSSOT)) as any;

  const acmAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
  const awAddr = (await registry.getModuleOrRevert(key("ASSET_WHITELIST"))) as string;
  const poAddr = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;
  const feeRouterAddr = (await registry.getModuleOrRevert(key("FEE_ROUTER"))) as string;

  const vaultCoreAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;
  const vblAddr = (await registry.getModuleOrRevert(key("VAULT_BUSINESS_LOGIC"))) as string;
  const cmAddr = (await registry.getModuleOrRevert(key("COLLATERAL_MANAGER"))) as string;
  const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
  const lenderPoolVaultAddr = (await registry.getModuleOrRevert(key("LENDER_POOL_VAULT"))) as string;
  const lendingEngineViewAddr = (await registry.getModuleOrRevert(key("LENDING_ENGINE_VIEW"))) as string;

  const acm = (await ethers.getContractAt("AccessControlManager", acmAddr)) as any;
  const aw = (await ethers.getContractAt("AssetWhitelist", awAddr)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", poAddr)) as any;
  const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", feeRouterAddr)) as any;
  const vaultCore = (await ethers.getContractAt("VaultCore", vaultCoreAddr)) as any;
  const vbl = (await ethers.getContractAt("VaultBusinessLogic", vblAddr)) as any;
  const gfmAddr = (await registry.getModuleOrRevert(key("GUARANTEE_FUND_MANAGER"))) as string;
  const ergmAddr = (await registry.getModuleOrRevert(key("EARLY_REPAYMENT_GUARANTEE_MANAGER"))) as string;
  const ergm = await ethers.getContractAt(["function isGuaranteeEnabled(address asset) view returns (bool)"], ergmAddr);
  const cm = await ethers.getContractAt(
    ["function getUserCollateralAssets(address user) view returns (address[])", "function getCollateral(address user,address asset) view returns (uint256)"],
    cmAddr
  );

  // VaultLendingEngine interface (minimal; aligns with other smoke scripts).
  const vLeAddr = (await registry.getModuleOrRevert(key("LENDING_ENGINE"))) as string;
  const vLe = await ethers.getContractAt(
    [
      "function getUserTotalDebtValue(address user) view returns (uint256)",
      "function getDebt(address user, address asset) view returns (uint256)",
      "function getUserDebtAssets(address user) view returns (address[])",
    ],
    vLeAddr
  );

  const lendingEngineView = (await ethers.getContractAt("LendingEngineView", lendingEngineViewAddr)) as any;

  // Token selection: prefer FeeRouter supported token[0], fallback to MockUSDC.
  let assetAddr: string = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;
  try {
    const toks = (await feeRouter.getSupportedTokens()) as string[];
    if (toks?.length) assetAddr = toks[0];
  } catch {
    // ignore
  }
  const erc20 = (await getErc20(assetAddr)) as any;
  const [symbol, decimals] = await Promise.all([
    erc20.symbol().catch(() => "TOKEN"),
    erc20.decimals().catch(() => 6),
  ]);
  const dec = Number(decimals);

  async function ensureRole(role: string, who: string, label: string): Promise<boolean> {
    const ok = (await acm.hasRole(role, who)) as boolean;
    if (ok) return true;
    if (noAutoGrant) {
      console.log(`  ⚠️  [NO_AUTO_GRANT] missing role=${label} for ${who}`);
      return false;
    }
    await (await acm.connect(deployer).grantRole(role, who)).wait();
    return true;
  }

  console.log(`=== LendingEngine Smoke (${network.name}) ===`);
  console.log(
    `Config: READ_ONLY=${readOnly} ENABLE_WRITE=${enableWrite} STRICT=${STRICT} E2E_ALLOW_DIRTY_STATE=${allowDirty} NO_AUTO_GRANT=${noAutoGrant}`
  );
  console.log(`Registry(SSOT): ${registryAddrSSOT}`);
  console.log(`Token: ${String(symbol)} @ ${assetAddr} (decimals=${dec})`);

  if (readOnly || !enableWrite) {
    // Arbitrum-mode: read-path only (no state mutations).
    // Minimal invariants: Registry bindings exist and core reads work.
    const mustNonZero = (label: string, addr: string) => {
      if (!addr || addr === ethers.ZeroAddress) throw new Error(`[FAIL] missing module: ${label}`);
      console.log(`  ✅ module ${label}=${addr}`);
    };
    mustNonZero("VAULT_CORE", vaultCoreAddr);
    mustNonZero("VAULT_BUSINESS_LOGIC", vblAddr);
    mustNonZero("COLLATERAL_MANAGER", cmAddr);
    mustNonZero("ORDER_ENGINE", orderEngineAddr);
    mustNonZero("LENDING_ENGINE (KEY_LE)", vLeAddr);
    mustNonZero("LENDING_ENGINE_VIEW", lendingEngineViewAddr);
    mustNonZero("PRICE_ORACLE", poAddr);
    mustNonZero("FEE_ROUTER", feeRouterAddr);

    try {
      await po.getPrice(assetAddr);
      console.log("  ✅ PriceOracle.getPrice(asset) ok");
    } catch (e: any) {
      console.log(`  ⚠️  PriceOracle.getPrice(asset) failed (best-effort): ${fmtErr(e)}`);
    }

    console.log("\n✅ lendingengine-smoke (read-only) PASSED\n");
    return;
  }

  // ---- minimal preconditions (best-effort, but strict by default) ----
  const canAddWhitelist = await ensureRole(key("ADD_WHITELIST"), deployer.address, "ADD_WHITELIST(deployer)");
  const canUpdatePrice = await ensureRole(key("UPDATE_PRICE"), deployer.address, "UPDATE_PRICE(deployer)");
  const canSetParam = await ensureRole(key("SET_PARAMETER"), deployer.address, "SET_PARAMETER(deployer)");
  const canOrderCreate = await ensureRole(key("ORDER_CREATE"), vblAddr, "ORDER_CREATE(vbl)");
  const canDeposit = await ensureRole(key("DEPOSIT"), vblAddr, "DEPOSIT(vbl)");
  const canBorrow = await ensureRole(key("BORROW"), orderEngineAddr, "BORROW(orderEngine)");

  // View roles for deployer observability (LendingEngineView ops/system reads).
  await ensureRole(key("VIEW_USER_DATA"), deployer.address, "VIEW_USER_DATA(deployer)");
  await ensureRole(key("VIEW_SYSTEM_DATA"), deployer.address, "VIEW_SYSTEM_DATA(deployer)");

  if (!(await aw.isAssetAllowed(assetAddr))) {
    if (!canAddWhitelist) throw new Error("AssetWhitelist: token not allowed and cannot ADD_WHITELIST");
    await (await aw.connect(deployer).addAllowedAsset(assetAddr)).wait();
  }
  if (!(await feeRouter.isTokenSupported(assetAddr))) {
    if (!canSetParam) throw new Error("FeeRouter: token not supported and cannot SET_PARAMETER");
    await (await feeRouter.connect(deployer).addSupportedToken(assetAddr)).wait();
  }
  {
    const cfg = await po.getAssetConfig(assetAddr);
    if (!cfg.isActive) {
      if (!canUpdatePrice) throw new Error("PriceOracle: token config inactive and cannot UPDATE_PRICE");
      await (await po.connect(deployer).configureAsset(assetAddr, "usd-coin", dec, 3600)).wait();
    }
    if (canUpdatePrice) {
      const blockNumber = await latestBlockNumber();
      await (await po.connect(deployer).updatePrice(assetAddr, ethers.parseUnits("1", 8), blockNumber)).wait();
    } else {
      // In production-like mode, we just require it to be readable (fresh).
      await po.getPrice(assetAddr);
    }
  }

  if (noAutoGrant && (!canOrderCreate || !canDeposit || !canBorrow)) {
    const missing: string[] = [];
    if (!canOrderCreate) missing.push("ORDER_CREATE(vbl)");
    if (!canDeposit) missing.push("DEPOSIT(vbl)");
    if (!canBorrow) missing.push("BORROW(orderEngine)");
    throw new Error(`Missing core roles for finalizeMatch path: ${missing.join(", ")}`);
  }

  // ---- pick borrower/lender ----
  const exclude = new Set<string>([deployer.address.toLowerCase()]);
  const borrower = await pickCleanSigner({ signers, exclude, vLe, cm, allowDirty });
  const lender = await pickCleanSigner({ signers, exclude, vLe, cm, allowDirty });

  // ---- fund accounts ----
  const fundAmt = ethers.parseUnits("20000", dec);
  await (await erc20.connect(deployer).transfer(borrower.address, fundAmt)).wait();
  await (await erc20.connect(deployer).transfer(lender.address, fundAmt)).wait();

  // ---- Extension flow (guarantee custody) ----
  // finalizeMatch may lock promised interest/guarantee into GuaranteeFundManager (GFM).
  // When the guarantee extension is enabled, borrower must approve GFM as spender,
  // otherwise finalizeMatch can revert with ERC20InsufficientAllowance(GFM, 0, interest).
  let guaranteeEnabled: boolean | undefined;
  try {
    guaranteeEnabled = (await ergm.isGuaranteeEnabled(assetAddr)) as boolean;
  } catch (e: any) {
    // If the toggle can't be queried on this deployment, be conservative.
    console.log(`  ⚠️  [BestEffort] ERGM.isGuaranteeEnabled(asset) unavailable: ${fmtErr(e)}; approving GFM defensively`);
    guaranteeEnabled = undefined;
  }
  if (guaranteeEnabled !== false) {
    await (await erc20.connect(borrower).approve(gfmAddr, ethers.MaxUint256)).wait();
  }

  // ---- Step 1: deposit collateral ----
  const collateralAmt = ethers.parseUnits("1000", dec);
  await (await erc20.connect(borrower).approve(cmAddr, collateralAmt)).wait();
  await (await vaultCore.connect(borrower).deposit(assetAddr, collateralAmt)).wait();
  const colAfterDeposit = (await cm.getCollateral(borrower.address, assetAddr)) as bigint;
  if (colAfterDeposit !== collateralAmt) {
    throw new Error(`deposit: collateral mismatch (expected=${collateralAmt} actual=${colAfterDeposit})`);
  }
  console.log(`  ✅ deposit collateral=${ethers.formatUnits(collateralAmt, dec)}`);

  // ---- Step 2: reserve lender funds ----
  const principal = ethers.parseUnits("500", dec);
  await (await erc20.connect(lender).approve(vblAddr, principal)).wait();
  const lendIntent = {
    lenderSigner: lender.address,
    asset: assetAddr,
    amount: principal,
    minTermDays: 1,
    maxTermDays: 30,
    minRateBps: 0n,
    expireAt: (await latestBlockNumber()) + ONE_HOUR_BLOCKS,
    salt: ethers.keccak256(ethers.toUtf8Bytes(`le-smoke-lend-${Date.now()}-${Math.random()}`)),
  };
  const typeHash = ethers.keccak256(
    ethers.toUtf8Bytes(
      "LendIntent(address lenderSigner,address asset,uint256 amount,uint16 minTermDays,uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)"
    )
  );
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const lendHash = ethers.keccak256(
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
  await (await vbl.connect(lender).reserveForLending(lender.address, assetAddr, principal, lendHash)).wait();

  // ---- Step 3: finalize match (create order) ----
  const termDays = 5;
  const rateBps = 1000n;
  const borrowIntent = {
    borrower: borrower.address,
    collateralAsset: assetAddr,
    collateralAmount: collateralAmt,
    borrowAsset: assetAddr,
    amount: principal,
    termDays,
    rateBps,
    expireAt: lendIntent.expireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes(`le-smoke-borrow-${Date.now()}-${Math.random()}`)),
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
  const sigBorrower = await borrower.signTypedData(domain, typesBorrow as any, borrowIntent as any);
  const sigLender = await lender.signTypedData(domain, typesLend as any, lendIntent as any);

  const rc = await (await vbl.connect(deployer).finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [sigLender])).wait();

  // Parse LoanOrderCreated(orderId, borrower, lender, asset, principal, ...)
  const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;
  let orderId: bigint | null = null;
  for (const log of rc!.logs) {
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
  if (orderId === null) throw new Error("finalizeMatch: missing LoanOrderCreated");
  console.log(`  ✅ finalizeMatch -> orderId=${orderId.toString()} (pool=${lenderPoolVaultAddr})`);

  // ---- Step 4: LendingEngineView observability (borrower self-read + ops read) ----
  // Version + engine-binding observability (align with e2e scenario-matrix / batch-advanced).
  const [levApi, levSchema, levImpl] = (await lendingEngineView.getVersionInfo()) as [bigint, bigint, string];
  console.log(`  [LEV VersionInfo] api=${levApi.toString()} schema=${levSchema.toString()} implementation=${levImpl}`);
  const regFromEngine = (await lendingEngineView.connect(deployer).getRegistryFromEngine()) as string;
  if (regFromEngine.toLowerCase() !== registryAddrSSOT.toLowerCase()) {
    throw new Error(`LEView: getRegistryFromEngine mismatch (got=${regFromEngine} expected=${registryAddrSSOT})`);
  }
  const isMatch = (await lendingEngineView.connect(deployer).isMatchEngine(orderEngineAddr)) as boolean;
  console.log(`  [LEV] isMatchEngine(ORDER_ENGINE)=${isMatch}`);

  const asBorrower = await lendingEngineView.connect(borrower).getLoanOrder(orderId);
  let asOps: any | null = null;
  try {
    asOps = await lendingEngineView.connect(deployer).getLoanOrder(orderId);
  } catch (e) {
    if (STRICT) throw e;
    console.log(`  ⚠️  [BestEffort] ops getLoanOrder failed: ${fmtErr(e)}`);
  }

  // Basic SSOT invariants.
  if (String(asBorrower.borrower).toLowerCase() !== borrower.address.toLowerCase()) throw new Error("LEView: borrower mismatch");
  if (String(asBorrower.asset).toLowerCase() !== assetAddr.toLowerCase()) throw new Error("LEView: asset mismatch");
  if ((asBorrower.principal as bigint) !== principal) throw new Error("LEView: principal mismatch");
  if (String(asBorrower.lender).toLowerCase() !== lenderPoolVaultAddr.toLowerCase()) {
    throw new Error("LEView: lender should be LenderPoolVault (pool-based match)");
  }
  if (asOps) {
    if ((asOps.principal as bigint) !== (asBorrower.principal as bigint)) throw new Error("LEView: ops principal mismatch");
    if (String(asOps.borrower).toLowerCase() !== String(asBorrower.borrower).toLowerCase()) throw new Error("LEView: ops borrower mismatch");
    if (String(asOps.lender).toLowerCase() !== String(asBorrower.lender).toLowerCase()) throw new Error("LEView: ops lender mismatch");
    if ((asOps.repaidAmount as bigint) !== (asBorrower.repaidAmount as bigint)) throw new Error("LEView: ops repaidAmount mismatch");
  }

  // Debt is SSOT in VaultLendingEngine (not exposed by LendingEngineView).
  const debtAfterBorrow = (await vLe.getDebt(borrower.address, assetAddr)) as bigint;
  if (debtAfterBorrow !== principal) throw new Error(`LEView: debt mismatch (expected=${principal} got=${debtAfterBorrow})`);

  // System diagnostics should be callable by deployer (VIEW_SYSTEM_DATA).
  try {
    const failedFee = (await lendingEngineView.connect(deployer).getFailedFeeAmount(orderId)) as bigint;
    const retry = (await lendingEngineView.connect(deployer).getNftRetryCount(orderId)) as bigint;
    console.log(`  ✅ LEView diagnostics failedFee=${failedFee.toString()} nftRetry=${retry.toString()}`);
  } catch (e) {
    if (STRICT) throw e;
    console.log(`  ⚠️  [BestEffort] LEView diagnostics failed: ${fmtErr(e)}`);
  }

  // LEV-02–style: borrower is related party → canAccessLoanOrder true; LoanNFTView.getUserLoanCount >= 1.
  const [canAccess] = (await lendingEngineView
    .connect(borrower)
    .canAccessLoanOrder(orderId, borrower.address)) as [boolean, boolean, bigint];
  if (!canAccess) throw new Error("LEView: canAccessLoanOrder(orderId, borrower) must be true");

  const loanNftViewAddr = (await registry.getModuleOrRevert(key("LOAN_NFT_VIEW"))) as string;
  const loanNftView = (await ethers.getContractAt("LoanNFTView", loanNftViewAddr)) as any;
  const [userLoanCount] = (await loanNftView
    .connect(deployer)
    .getUserLoanCount(borrower.address)) as [bigint, boolean, bigint];
  if (userLoanCount < 1n) {
    throw new Error(
      `LoanNFTView: getUserLoanCount(borrower) must be >= 1 after match (got ${userLoanCount})`,
    );
  }
  console.log(
    `  ✅ LEView canAccessLoanOrder(borrower)=true LoanNFTView.getUserLoanCount(borrower)=${userLoanCount.toString()}`,
  );

  // ---- Step 5: repay full (principal + interest) ----
  const termSec = BigInt(termDays) * ONE_DAY;
  const interest = calcInterest(principal, rateBps, termSec);
  const totalDue = principal + interest;
  await (await erc20.connect(borrower).approve(vaultCoreAddr, totalDue)).wait();
  await (await vaultCore.connect(borrower).repay(orderId, assetAddr, totalDue)).wait();
  console.log(`  ✅ repay totalDue=${ethers.formatUnits(totalDue, dec)} (interest=${ethers.formatUnits(interest, dec)})`);

  // Post-repay: debt must be 0 and order must reflect repayment.
  const debtAfterRepay = (await vLe.getDebt(borrower.address, assetAddr)) as bigint;
  if (debtAfterRepay !== 0n) throw new Error(`LEView: expected debt=0 after repay, got ${debtAfterRepay.toString()}`);
  const ordAfter = await lendingEngineView.connect(borrower).getLoanOrder(orderId);
  if ((ordAfter.repaidAmount as bigint) < totalDue) {
    throw new Error(`LEView: expected repaidAmount>=totalDue after repay (repaid=${ordAfter.repaidAmount} due=${totalDue})`);
  }
  // Ops/borrower consistency after repay (same as batch-advanced logLEVOrder invariant).
  const ordAfterOps = await lendingEngineView.connect(deployer).getLoanOrder(orderId);
  if ((ordAfterOps.repaidAmount as bigint) !== (ordAfter.repaidAmount as bigint)) {
    throw new Error(`LEView: ops repaidAmount after repay must match borrower (ops=${ordAfterOps.repaidAmount} borrower=${ordAfter.repaidAmount})`);
  }

  // Best-effort: full-repay auto-release should clear collateral (depends on SettlementManager strict mode/config).
  const colAfterRepay = (await cm.getCollateral(borrower.address, assetAddr)) as bigint;
  if (colAfterRepay !== 0n) {
    const msg = `Collateral not fully auto-released after repay (remaining=${ethers.formatUnits(colAfterRepay, dec)}).`;
    if (STRICT) throw new Error(msg);
    console.log(`  ⚠️  [BestEffort] ${msg}`);
  }

  console.log("\n✅ LendingEngine smoke PASSED");
  } finally {
    if (USE_SNAPSHOT && !KEEP_STATE) {
      try {
        await ethers.provider.send("evm_revert", [snap]);
      } catch {
        // ignore on live networks
      }
    } else if (KEEP_STATE && USE_SNAPSHOT) {
      console.log("  ⚠️  KEEP_STATE=1: leaving localhost chain state modified by lendingengine-smoke-local.ts");
    }
  }
}

main().catch((e) => {
  console.error("\n❌ LendingEngine smoke FAILED\n");
  console.error(e);
  process.exitCode = 1;
});

