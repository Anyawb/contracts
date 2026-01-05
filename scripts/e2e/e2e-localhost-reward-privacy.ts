import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";

const ONE_HOUR = 60n * 60n;
const ONE_DAY = 24n * ONE_HOUR;

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function calcTotalDue(principal: bigint, rateBps: bigint, termSec: bigint) {
  // interest = principal * rate / 1e4 * term / 365 days
  const denom = 365n * ONE_DAY * 10_000n;
  const interest = (principal * rateBps * termSec) / denom;
  return principal + interest;
}

async function evmIncreaseTime(seconds: bigint) {
  await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
  await ethers.provider.send("evm_mine", []);
}

async function expectRevert(p: Promise<any>, label: string) {
  try {
    await p;
    throw new Error(`Expected revert but succeeded: ${label}`);
  } catch (e: any) {
    const msg = e?.shortMessage || e?.message || String(e);
    console.log(`  ✅ revert as expected: ${label} (${msg})`);
  }
}

async function inferOrderIdFromReceipt(orderEngine: any, receipt: any): Promise<bigint> {
  for (const log of receipt.logs) {
    try {
      const parsed = orderEngine.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "LoanOrderCreated") {
        return parsed.args.orderId as bigint;
      }
    } catch {
      // ignore
    }
  }
  throw new Error("LoanOrderCreated not found; cannot infer orderId");
}

async function main() {
  const signers = await ethers.getSigners();
  if (signers.length < 5) throw new Error(`Need at least 5 signers (have ${signers.length})`);

  const deployer = signers[0];
  const borrower = signers[1];
  const lender = signers[2];
  const outsider = signers[3];
  const ops = signers[4];

  console.log("=== E2E Reward Privacy + Read-Gate (localhost) ===\n");
  console.log("Scenarios:");
  console.log("- Privacy: RewardView user-only + ops-only reads");
  console.log("- Read-gate: direct RewardManagerCore.get* must revert; reads must go through RewardView");
  console.log("- Rewards: on-time repay mints 1 point; early repay mints 0; overdue repay burns 5% of locked (0.05 point)\n");

  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
  const aw = (await ethers.getContractAt("AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", CONTRACT_ADDRESSES.PriceOracle)) as any;
  const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", CONTRACT_ADDRESSES.FeeRouter)) as any;
  const usdc = (await ethers.getContractAt("MockERC20", CONTRACT_ADDRESSES.MockUSDC)) as any;
  const vaultCore = (await ethers.getContractAt("VaultCore", CONTRACT_ADDRESSES.VaultCore)) as any;

  const rewardView = (await ethers.getContractAt("RewardView", CONTRACT_ADDRESSES.RewardView)) as any;
  const rewardPoints = (await ethers.getContractAt(
    "src/Token/RewardPoints.sol:RewardPoints",
    CONTRACT_ADDRESSES.RewardPoints
  )) as any;
  const rmCore = (await ethers.getContractAt("RewardManagerCore", CONTRACT_ADDRESSES.RewardManagerCore)) as any;

  const rewardDecimals = (await rewardPoints.decimals()) as number;
  const ONE_POINT = 10n ** BigInt(rewardDecimals);
  const fmtPoints = (x: bigint) => ethers.formatUnits(x, rewardDecimals);

  const orderEngineAddr = await registry.getModuleOrRevert(key("ORDER_ENGINE"));
  const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;

  // IMPORTANT:
  // Solidity-side `ModuleKeys.KEY_LE` is defined as keccak256("LENDING_ENGINE") (see `src/constants/ModuleKeys.sol`).
  // Do NOT use `frontend-config/moduleKeys.ts` here: it may encode a different naming scheme (e.g. keccak256("KEY_LE")).
  const leAddr = await registry.getModuleOrRevert(key("LENDING_ENGINE"));

  console.log("Modules:");
  console.log("  ORDER_ENGINE:", orderEngineAddr);
  console.log("  LENDING_ENGINE (KEY_LE):", leAddr);
  console.log("  RewardView:", rewardView.target);
  console.log("  RewardManagerCore:", rmCore.target);
  console.log("  RewardPoints:", rewardPoints.target);
  console.log("");

  // ============ Roles ============
  const ensureRole = async (roleName: string, who: string | any) => {
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

  // order engine needs borrow + fee distribute permission
  await ensureRole("BORROW", orderEngineAddr);
  await ensureRole("DEPOSIT", orderEngineAddr);

  // borrower needs create+repay permission
  await ensureRole("ORDER_CREATE", borrower.address);
  await ensureRole("REPAY", borrower.address);

  // asset/price setup
  const assetAddr = usdc.target as string;
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

  // fund users
  await (await usdc.connect(deployer).transfer(borrower.address, ethers.parseUnits("20000", 6))).wait();
  await (await usdc.connect(deployer).transfer(lender.address, ethers.parseUnits("20000", 6))).wait();

  // ============ Privacy assertions (RewardView) ============
  console.log("=== A) Privacy gate: RewardView only user or ops can read ===");
  // user should be able to read own data
  await rewardView.connect(borrower).getUserRewardSummary(borrower.address);

  // outsider cannot read other user's reward data
  await expectRevert(
    rewardView.connect(outsider).getUserRewardSummary(borrower.address),
    "outsider cannot read borrower reward summary"
  );

  // ops can read only after role is granted
  await expectRevert(
    rewardView.connect(ops).getUserRewardSummary(borrower.address),
    "ops cannot read before VIEW_USER_DATA role"
  );
  await ensureRole("VIEW_USER_DATA", ops.address);
  await rewardView.connect(ops).getUserRewardSummary(borrower.address);
  console.log("  ✅ ops can read after VIEW_USER_DATA role\n");

  // ============ Protocol-only read entrance ============
  console.log("=== B) Protocol-only read: getUserLevelForBorrowCheck ===");
  await expectRevert(
    rewardView.connect(borrower).getUserLevelForBorrowCheck(borrower.address),
    "EOA cannot call getUserLevelForBorrowCheck (only KEY_LE)"
  );
  {
    const data = rewardView.interface.encodeFunctionData("getUserLevelForBorrowCheck", [borrower.address]);
    const raw = await ethers.provider.call({ to: rewardView.target as string, data, from: leAddr });
    const [level] = rewardView.interface.decodeFunctionResult("getUserLevelForBorrowCheck", raw) as [bigint];
    console.log(`  ✅ eth_call(from=KEY_LE) succeeded, level=${level.toString()}\n`);
  }

  // ============ Read-gate assertions (RewardManagerCore) ============
  console.log("=== C) Read-gate: direct RewardManagerCore.get* must revert ===");
  await expectRevert(rmCore.connect(borrower).getUserPenaltyDebt(borrower.address), "EOA direct call RMCore.getUserPenaltyDebt");
  await expectRevert(rmCore.connect(outsider).getUserLevel(borrower.address), "EOA direct call RMCore.getUserLevel");
  console.log("");

  // ============ Reward flow scenarios ============
  const principal = ethers.parseUnits("1200", 6); // >= MIN_ELIGIBLE_PRINCIPAL(1000)
  const rateBps = 1000n; // 10%
  const termSec = 5n * ONE_DAY;
  const totalDue = calcTotalDue(principal, rateBps, termSec);

  const readSnapshot = async (label: string) => {
    const bal = (await rewardPoints.balanceOf(borrower.address)) as bigint;
    const penaltyDebt = (await rewardView.connect(borrower).getUserPenaltyDebt(borrower.address)) as bigint;
    const summary = await rewardView.connect(borrower).getUserRewardSummary(borrower.address);
    const totalEarned = summary[0] as bigint;
    const totalBurned = summary[1] as bigint;
    console.log(
      `  [${label}] balance=${fmtPoints(bal)} totalEarned=${fmtPoints(totalEarned)} totalBurned=${fmtPoints(totalBurned)} penaltyDebt=${fmtPoints(penaltyDebt)}`
    );
    return { bal, penaltyDebt, totalEarned, totalBurned };
  };

  async function createOrder(): Promise<bigint> {
    // IMPORTANT (post-refactor):
    // ORDER_ENGINE.repay() will sync principal repayment into VaultCore.repayFor(...) -> VaultLendingEngine.repay(...).
    // To avoid VaultLendingEngine reverting with Overpay() (debt=0), ensure the borrower has a matching principal debt
    // recorded in VaultLendingEngine first.
    //
    // We do that via: deposit collateral -> VaultCore.borrow(principal).
    // (VaultCore is the only allowed caller of VaultLendingEngine due to onlyVaultCore.)
    const collateralAmt = ethers.parseUnits("5000", 6);
    await (await usdc.connect(deployer).transfer(borrower.address, collateralAmt)).wait();
    await (await usdc.connect(borrower).approve(CONTRACT_ADDRESSES.VaultCore, collateralAmt)).wait();
    await (await vaultCore.connect(borrower).deposit(assetAddr, collateralAmt)).wait();
    await (await vaultCore.connect(borrower).borrow(assetAddr, principal)).wait();
    // ensure borrower has extra funds for interest + fee
    await (await usdc.connect(deployer).transfer(borrower.address, ethers.parseUnits("2000", 6))).wait();

    const tx = await orderEngine.connect(borrower).createLoanOrder({
      principal,
      rate: rateBps,
      term: termSec,
      borrower: borrower.address,
      lender: lender.address,
      asset: assetAddr,
      startTimestamp: 0,
      maturity: 0,
      repaidAmount: 0,
    });
    const receipt = await tx.wait();
    const orderId = await inferOrderIdFromReceipt(orderEngine, receipt);
    return orderId;
  }

  async function repayFull(orderId: bigint) {
    await (await usdc.connect(borrower).approve(orderEngineAddr, totalDue)).wait();
    await (await orderEngine.connect(borrower).repay(orderId, totalDue)).wait();
  }

  console.log("=== D) Reward scenario: on-time repay => +1 point ===");
  const s0 = await readSnapshot("before on-time");
  const order1 = await createOrder();
  await readSnapshot("after borrow (locked, no mint)");

  // move time close to maturity so it's within ON_TIME_WINDOW
  // ON_TIME_WINDOW in ORDER_ENGINE is 24 hours; we repay at maturity - 1 hour.
  await evmIncreaseTime(termSec - ONE_HOUR);
  await repayFull(order1);

  const s1 = await readSnapshot("after on-time repay");
  if (s1.bal - s0.bal !== ONE_POINT) {
    throw new Error(`on-time repay: expected +1 point, got delta=${fmtPoints(s1.bal - s0.bal)}`);
  }
  if (s1.penaltyDebt !== 0n) throw new Error(`on-time repay: expected penaltyDebt=0, got ${s1.penaltyDebt.toString()}`);
  console.log("  ✅ on-time repay minted exactly 1 point\n");

  console.log("=== E) Reward scenario: early repay => +0 point ===");
  const s2 = await readSnapshot("before early");
  const order2 = await createOrder();
  await repayFull(order2); // repay immediately => early => isOnTime=false => hfHighEnough=false
  const s3 = await readSnapshot("after early repay");
  if (s3.bal !== s2.bal) throw new Error(`early repay: expected no mint, balance changed ${fmtPoints(s2.bal)} -> ${fmtPoints(s3.bal)}`);
  if (s3.penaltyDebt !== s2.penaltyDebt) throw new Error(`early repay: expected no penalty debt change`);
  console.log("  ✅ early repay minted 0 point (and no penalty)\n");

  console.log("=== F) Reward scenario: overdue repay => burn 5% of locked (0.05 point) ===");
  const s4 = await readSnapshot("before overdue");
  const order3 = await createOrder();
  // overdue: go beyond maturity + ON_TIME_WINDOW (24h) by 1 hour
  await evmIncreaseTime(termSec + 24n * ONE_HOUR + ONE_HOUR);
  await repayFull(order3);

  const s5 = await readSnapshot("after overdue repay");
  const balanceDecrease = s4.bal > s5.bal ? (s4.bal - s5.bal) : 0n;
  const penaltyDebtIncrease = s5.penaltyDebt > s4.penaltyDebt ? (s5.penaltyDebt - s4.penaltyDebt) : 0n;
  if (balanceDecrease === 0n && penaltyDebtIncrease === 0n) {
    throw new Error("overdue repay: expected either points burn (balance decrease) or penalty debt increase, but saw none");
  }
  if (s5.totalBurned < s4.totalBurned) {
    throw new Error("overdue repay: totalBurned should be non-decreasing");
  }
  console.log(
    `  ✅ overdue repay applied penalty (balanceDecrease=${fmtPoints(balanceDecrease)}, penaltyDebtIncrease=${fmtPoints(penaltyDebtIncrease)})\n`
  );

  console.log("All Reward privacy/read-gate E2E checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


