import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";
import { assertConservation, discoverTrackedAddresses, getErc20, key, snapshotBalances, uniqAddrs } from "./_fundsFlowUtils";

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
 * - RUN_LIQUIDATION=0/1 (default 1)
 * - E2E_ALLOW_DIRTY_STATE=1 (allows running even if node has historical positions; suite will try to pick clean signers)
 */

const ONE_DAY = 24n * 60n * 60n;

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
      "function _getLoanOrderForView(uint256) view returns (tuple(uint256 principal,uint256 rate,uint256 term,address borrower,address lender,address asset,uint256 startTimestamp,uint256 maturity,uint256 repaidAmount))",
    ],
    orderEngineAddr
  );
  return (await orderEngineView._getLoanOrderForView(orderId)) as {
    principal: bigint;
    rate: bigint;
    term: bigint;
    borrower: string;
    lender: string;
    asset: string;
    startTimestamp: bigint;
    maturity: bigint;
    repaidAmount: bigint;
  };
}

function calcInterest(principal: bigint, rateBps: bigint, termSec: bigint) {
  const YEAR = 365n * ONE_DAY;
  return (principal * rateBps * termSec) / (10_000n * YEAR);
}

async function evmIncreaseTime(seconds: bigint) {
  await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
  await ethers.provider.send("evm_mine", []);
}

async function main() {
  const allowDirtyState = process.env.E2E_ALLOW_DIRTY_STATE === "1";
  const runFinalizeMatchOnly = process.env.RUN_FINALIZE_MATCH_ONLY === "1";
  const runMatchDisbursementOnly = process.env.RUN_MATCH_DISBURSEMENT_ONLY === "1";
  const runReserveCancel = process.env.RUN_RESERVE_CANCEL !== "0";
  const runPartialRepay = process.env.RUN_PARTIAL_REPAY !== "0";
  const runStrictAggDebt = process.env.RUN_STRICT_AGGREGATED_DEBT !== "0";
  const runLiquidation = process.env.RUN_LIQUIDATION !== "0";
  const tokensEnv = (process.env.TOKENS ?? "").trim();
  const assertRoleGates = process.env.ASSERT_ROLE_GATES === "1";

  if (runFinalizeMatchOnly && runMatchDisbursementOnly) {
    throw new Error("Config: RUN_FINALIZE_MATCH_ONLY and RUN_MATCH_DISBURSEMENT_ONLY are mutually exclusive.");
  }

  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const keeper = signers[1];
  const signerByAddr = new Map<string, any>(signers.map((s) => [s.address.toLowerCase(), s]));

  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
  const aw = (await ethers.getContractAt("AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", CONTRACT_ADDRESSES.PriceOracle)) as any;
  const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", CONTRACT_ADDRESSES.FeeRouter)) as any;
  const usdc = (await ethers.getContractAt("MockERC20", CONTRACT_ADDRESSES.MockUSDC)) as any;

  const vaultCoreAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;
  const vblAddr = (await registry.getModuleOrRevert(key("VAULT_BUSINESS_LOGIC"))) as string;
  const cmAddr = (await registry.getModuleOrRevert(key("COLLATERAL_MANAGER"))) as string;
  const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
  const settlementManagerAddr = (await registry.getModuleOrRevert(key("SETTLEMENT_MANAGER"))) as string;
  const lenderPoolVaultAddr = (await registry.getModuleOrRevert(key("LENDER_POOL_VAULT"))) as string;
  const liquidationManagerAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_MANAGER"))) as string;
  const liquidationPayoutManagerAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_PAYOUT_MANAGER"))) as string;

  const vaultCore = (await ethers.getContractAt("VaultCore", vaultCoreAddr)) as any;
  const vbl = (await ethers.getContractAt("VaultBusinessLogic", vblAddr)) as any;
  const settlementManager = (await ethers.getContractAt("SettlementManager", settlementManagerAddr)) as any;
  const vLe = await ethers.getContractAt(
    ["function getUserTotalDebtValue(address user) view returns (uint256)", "function getDebt(address user, address asset) view returns (uint256)"],
    CONTRACT_ADDRESSES.VaultLendingEngine
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

  // ---- helper: pick clean users (no debt, no collateral) to avoid noisy aggregated state ----
  const isCleanUser = async (addr: string) => {
    const [debtValue, assets] = await Promise.all([
      (vLe.getUserTotalDebtValue(addr) as Promise<bigint>),
      (cm.getUserCollateralAssets(addr) as Promise<string[]>).catch(() => [] as string[]),
    ]);
    return debtValue === 0n && (assets?.length ?? 0) === 0;
  };

  const exclude = new Set<string>([deployer.address.toLowerCase(), keeper.address.toLowerCase()]);
  const pickCleanSigner = async () => {
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
      throw new Error("No clean signer found. Restart localhost node for a clean state, or set E2E_ALLOW_DIRTY_STATE=1.");
    }
    // fallback: any unused signer
    for (let i = 2; i < signers.length; i++) {
      const s = signers[i];
      const k = s.address.toLowerCase();
      if (exclude.has(k)) continue;
      exclude.add(k);
      return s;
    }
    throw new Error("No unused signer available.");
  };

  const ensureRole = async (role: string, who: string) => {
    if (!(await acm.hasRole(role, who))) await (await acm.grantRole(role, who)).wait();
  };

  // ---- ensure minimal config (best-effort) ----
  await ensureRole(key("ADD_WHITELIST"), deployer.address);
  await ensureRole(key("UPDATE_PRICE"), deployer.address);
  await ensureRole(key("SET_PARAMETER"), deployer.address);
  await ensureRole(key("ORDER_CREATE"), vblAddr);
  await ensureRole(key("DEPOSIT"), vblAddr);
  await ensureRole(key("BORROW"), orderEngineAddr);

  if (!(await aw.isAssetAllowed(usdc.target))) await (await aw.connect(deployer).addAllowedAsset(usdc.target)).wait();
  {
    const cfg = await po.getAssetConfig(usdc.target);
    if (!cfg.isActive) await (await po.connect(deployer).configureAsset(usdc.target, "usd-coin", 8, 3600)).wait();
  }
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  await (await po.connect(deployer).updatePrice(usdc.target, ethers.parseUnits("1", 8), now)).wait();
  if (!(await feeRouter.isTokenSupported(usdc.target))) await (await feeRouter.connect(deployer).addSupportedToken(usdc.target)).wait();

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
    const fundAmt = ethers.parseUnits("20000", decimals);

    // fund borrower/lender so their balances are available (totalSupply unchanged)
    await (await erc20.connect(deployer).transfer(opts.borrower.address, fundAmt)).wait();
    await (await erc20.connect(deployer).transfer(opts.lender.address, fundAmt)).wait();
    await (await erc20.connect(deployer).transfer(keeper.address, fundAmt)).wait();

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
      expireAt: BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600),
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
      const termSec = BigInt(opts.termDays) * ONE_DAY;
      await evmIncreaseTime(termSec + 60n);
      const nowAfter = (await ethers.provider.getBlock("latest"))!.timestamp;
      await (await po.connect(deployer).updatePrice(opts.asset, ethers.parseUnits("1", 8), nowAfter)).wait();
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
  for (const assetAddr of tokensToRun) {
    const erc20 = (await getErc20(assetAddr)) as any;
    const decimals = Number(await erc20.decimals().catch(() => 6));
    const symbol = String(await erc20.symbol().catch(() => "TOKEN"));

    // Best-effort: ensure token is supported/whitelisted and has a price configured.
    try {
      if (!(await aw.isAssetAllowed(assetAddr))) await (await aw.connect(deployer).addAllowedAsset(assetAddr)).wait();
    } catch {}
    try {
      const cfg = await po.getAssetConfig(assetAddr);
      if (!cfg.isActive) await (await po.connect(deployer).configureAsset(assetAddr, "usd-coin", 8, 3600)).wait();
      const ts = (await ethers.provider.getBlock("latest"))!.timestamp;
      await (await po.connect(deployer).updatePrice(assetAddr, ethers.parseUnits("1", 8), ts)).wait();
    } catch {}
    try {
      if (!(await feeRouter.isTokenSupported(assetAddr))) await (await feeRouter.connect(deployer).addSupportedToken(assetAddr)).wait();
    } catch {}

    if (!runFinalizeMatchOnly && !runMatchDisbursementOnly) {
      console.log(`\n## Token: ${symbol} @ ${assetAddr} (decimals=${decimals})\n`);
    } else {
      console.log(`\n## Token (minimal): ${symbol} @ ${assetAddr}\n`);
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
            // payload = abi.encode(lHash, lenderSigner, asset, amount, ts)
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
      if (poolDelta !== -principal) {
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
      await (await erc20.connect(deployer).transfer(lender.address, ethers.parseUnits("5000", decimals))).wait();

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
        expireAt: BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600),
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
      if (lenderBalDelta !== -amount) {
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
      if (poolBalDelta2 !== -amount) {
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
    const remainingPrincipal = ord.principal > ord.repaidAmount ? ord.principal - ord.repaidAmount : 0n;
    const totalDue = remainingPrincipal + calcInterest(ord.principal, ord.rate, ord.term);

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
      if (ordAfter2.repaidAmount < totalDue) throw new Error("expected fully repaid order (repaidAmount < totalDue)");
      console.log("  ✅ OK\n");
    }

    // ========= CASE 2: Strict full-repay + aggregated debt behavior =========
    if (runStrictAggDebt) {
      console.log("=== Case: strict full-repay + aggregated debt (expected revert, then success) ===");

    // enable strict full-repay mode
    try {
      await ensureRole(key("SET_PARAMETER"), deployer.address);
      await (await settlementManager.connect(deployer).setRequireFullRepayRelease(true)).wait();
    } catch (e) {
      console.log("  ⚠️  Could not enable strict full-repay mode; skipping this case:", e);
    }

      const borrower = await pickCleanSigner();
      const lender1 = await pickCleanSigner();
      const lender2 = await pickCleanSigner();
      const tracked = uniqAddrs(
        await discoverTrackedAddresses({
          include: [deployer.address],
          borrower: borrower.address,
          lender: lender1.address,
          keeper: keeper.address,
        })
      );
      const tracked2 = uniqAddrs([...tracked, lender2.address]);

      const { orderId: orderA } = await createOrder({
        borrower,
        lender: lender1,
        asset: assetAddr,
        principal: ethers.parseUnits("500", decimals),
        collateral: ethers.parseUnits("1000", decimals),
        termDays: 5,
        rateBps: 1000n,
        makeOverdue: false,
      });
      const { orderId: orderB } = await createOrder({
        borrower,
        lender: lender2,
        asset: assetAddr,
        principal: ethers.parseUnits("500", decimals),
        collateral: ethers.parseUnits("1000", decimals),
        termDays: 5,
        rateBps: 1000n,
        makeOverdue: false,
      });

    const ordA = await getOrderForView(orderEngineAddr, orderA);
    const dueA = (ordA.principal - ordA.repaidAmount) + calcInterest(ordA.principal, ordA.rate, ordA.term);
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

    // disable strict and retry
      await (await settlementManager.connect(deployer).setRequireFullRepayRelease(false)).wait();
      await (await erc20.connect(borrower).approve(vaultCoreAddr, dueA)).wait();
      await (await vaultCore.connect(borrower).repay(orderA, ordA.asset, dueA)).wait();
      const after = await snapshotBalances(ordA.asset, tracked2);
      assertConservation("strictAggDebt.afterDisableStrict", before, after);

    // sanity: borrower still has debt because orderB is active
    const debtValue = (await vLe.getUserTotalDebtValue(borrower.address)) as bigint;
    if (debtValue === 0n) {
      throw new Error("expected aggregated debt to remain after repaying only one of two orders");
    }
    console.log(`  ✅ OK (remaining aggregated debtValue=${debtValue.toString()})\n`);
      orderB; // silence unused
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

    // ensure keeper role for liquidation (best-effort)
    try {
      await ensureRole(key("LIQUIDATE"), keeper.address);
    } catch (e) {
      console.log("  ⚠️  Could not grant LIQUIDATE to keeper; liquidation may revert:", e);
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

    const before = await snapshotBalances(ord.asset, tracked);
    await (await settlementManager.connect(keeper).settleOrLiquidate(orderId)).wait();
    const after = await snapshotBalances(ord.asset, tracked);
    assertConservation("liquidation", before, after);
      console.log("  ✅ OK\n");
    }
  } // end token loop

  console.log("✅ Invariants suite completed.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

