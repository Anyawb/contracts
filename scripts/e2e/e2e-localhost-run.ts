import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost.ts";
import { runRewardManagerGovernance } from "./e2e-localhost-rewardmanager-governance";
// Optional: cross-chain governance veto acceptance is not always present.

const BLOCKS_PER_DAY = 7_200n;
const ONE_HOUR_BLOCKS = 1_800n;

function calcTotalDue(principal: bigint, rateBps: bigint, termBlocks: bigint) {
  const denom = 365n * BLOCKS_PER_DAY * 10_000n;
  const interest = (principal * rateBps * termBlocks) / denom;
  return principal + interest;
}

async function latestBlockNumber(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.number);
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

function inferOrderIdFromReceipt(orderEngine: any, receipt: any): bigint {
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = orderEngine.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "LoanOrderCreated") return parsed.args.orderId as bigint;
    } catch {
      // ignore
    }
  }
  throw new Error("LoanOrderCreated not found; cannot infer orderId");
}

async function main() {
  const [deployer, borrower, lender] = await ethers.getSigners();

  const {
    AccessControlManager: ACM,
    AssetWhitelist: AW,
    PriceOracle: PO,
    VaultRouter: VR,
    VaultCore: VC,
    CollateralManager: CM,
    LendingEngine: LE,
    MockUSDC: USDC,
  } = CONTRACT_ADDRESSES;

  const acm = (await ethers.getContractAt("AccessControlManager", ACM)) as any;
  const aw = (await ethers.getContractAt("AssetWhitelist", AW)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", PO)) as any;
  const vr = (await ethers.getContractAt("VaultRouter", VR)) as any;
  const vc = (await ethers.getContractAt("VaultCore", VC)) as any;
  const cm = (await ethers.getContractAt("CollateralManager", CM)) as any;
  const vbl = (await ethers.getContractAt("VaultBusinessLogic", (CONTRACT_ADDRESSES as any).VaultBusinessLogic)) as any;
  // ORDER_ENGINE in src/core/LendingEngine.sol (see Architecture-Guide SSOT)
  const le = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", LE)) as any;
  const usdc = (await ethers.getContractAt("MockERC20", USDC)) as any;

  const ACTION_DEPOSIT = ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT"));
  const ACTION_BORROW = ethers.keccak256(ethers.toUtf8Bytes("BORROW"));
  const ACTION_REPAY = ethers.keccak256(ethers.toUtf8Bytes("REPAY"));
  const ACTION_ORDER_CREATE = ethers.keccak256(ethers.toUtf8Bytes("ORDER_CREATE"));
  const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes("SET_PARAMETER"));
  const ACTION_ADD_WHITELIST = ethers.keccak256(ethers.toUtf8Bytes("ADD_WHITELIST"));
  const ACTION_UPDATE_PRICE = ethers.keccak256(ethers.toUtf8Bytes("UPDATE_PRICE"));

  const ensureRole = async (role: string, who: string) => {
    if (!(await acm.hasRole(role, who))) {
      await acm.grantRole(role, who);
    }
  };

  // Grant router/core basic roles
  for (const r of [ACTION_DEPOSIT, ACTION_BORROW, ACTION_REPAY]) {
    await ensureRole(r, VR);
    await ensureRole(r, VC);
  }
  // Funds-flow SSOT: orchestrator + settlement manager roles
  await ensureRole(ACTION_ORDER_CREATE, vbl.target);
  await ensureRole(ACTION_DEPOSIT, vbl.target); // FeeRouter.distributeNormal permission
  const settlementManagerAddr = await (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)).getModuleOrRevert(
    ethers.keccak256(ethers.toUtf8Bytes("SETTLEMENT_MANAGER"))
  );
  await ensureRole(ACTION_REPAY, settlementManagerAddr);
  await ensureRole(ACTION_BORROW, LE); // OrderEngine mints/updates LoanNFT

  // Allow asset + price
  if (!(await aw.isAssetAllowed(usdc.target))) {
    await ensureRole(ACTION_ADD_WHITELIST, deployer.address);
    await aw.connect(deployer).addAllowedAsset(usdc.target);
  }
  {
    const cfg = await po.getAssetConfig(usdc.target);
    if (!cfg.isActive) {
      await ensureRole(ACTION_SET_PARAMETER, deployer.address);
      const usdcDecimals = Number(await usdc.decimals().catch(() => 6));
      await po.connect(deployer).configureAsset(usdc.target, "usd-coin", usdcDecimals, 3600);
    }
  }
  const now = await ethers.provider.getBlockNumber();
  await ensureRole(ACTION_UPDATE_PRICE, deployer.address);
  await po.connect(deployer).updatePrice(usdc.target, ethers.parseUnits("1", 8), now);

  // Optional (legacy): enable router testing mode if the deployed VaultRouter supports it.
  // Newer deployments may not expose setTestingMode(); smoke should still run without it.
  await ensureRole(ACTION_SET_PARAMETER, deployer.address);
  if (typeof (vr as any).setTestingMode === "function") {
    await vr.connect(deployer).setTestingMode(true);
    console.log("ℹ️  VaultRouter.setTestingMode(true) enabled");
  } else {
    console.log("ℹ️  VaultRouter.setTestingMode not found on this deployment; skipping");
  }

  // Fund & approve
  await usdc.connect(deployer).transfer(borrower.address, ethers.parseUnits("10000", 6));
  await usdc.connect(deployer).transfer(lender.address, ethers.parseUnits("10000", 6));
  await usdc.connect(borrower).approve(CONTRACT_ADDRESSES.CollateralManager, ethers.MaxUint256);
  await usdc.connect(lender).approve(vbl.target, ethers.MaxUint256);

  // 1) Deposit
  const depositAmt = ethers.parseUnits("1000", 6);
  await vc.connect(borrower).deposit(usdc.target, depositAmt);
  const col = await cm.getCollateral(borrower.address, usdc.target);
  console.log("Collateral after deposit:", col.toString());

  // 2) Borrow via SSOT matchflow (finalizeMatch -> borrowFor -> createLoanOrder)
  const principal = ethers.parseUnits("500", 6);
  const termDays = 5;
  const rateBps = 1000n;
  const expireAt = (await latestBlockNumber()) + ONE_HOUR_BLOCKS;

  const borrowIntent = {
    borrower: borrower.address,
    collateralAsset: usdc.target,
    collateralAmount: depositAmt,
    borrowAsset: usdc.target,
    amount: principal,
    termDays,
    rateBps,
    expireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes("borrow-salt-e2e-localhost-run")),
  };
  const lendIntent = {
    lenderSigner: lender.address,
    asset: usdc.target,
    amount: principal,
    minTermDays: 1,
    maxTermDays: 30,
    minRateBps: 0n,
    expireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes("lend-salt-e2e-localhost-run")),
  };

  const lendHash = buildLendIntentHash(lendIntent);
  await vbl.connect(lender).reserveForLending(lender.address, usdc.target, principal, lendHash);

  const domain = {
    name: "RwaLending",
    version: "1",
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    verifyingContract: (CONTRACT_ADDRESSES as any).VaultBusinessLogic,
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
  const orderId = inferOrderIdFromReceipt(le, receipt);
  console.log("Borrow finalized, orderId:", orderId.toString());

  // 3) Repay via SSOT settlement path
  const termBlocks = BigInt(termDays) * BLOCKS_PER_DAY;
  const totalDue = calcTotalDue(principal, rateBps, termBlocks);
  await usdc.connect(borrower).approve(VC, totalDue);
  await vc.connect(borrower).repay(orderId, usdc.target, totalDue);
  console.log("Repay done");

  const colAfter = await cm.getCollateral(borrower.address, usdc.target);
  console.log("Collateral after repay:", colAfter.toString());

  // RewardManager governance/permission sanity (best-effort, local only)
  await runRewardManagerGovernance();

  try {
    const mod = await import("./e2e-localhost-crosschaingov-gate-veto");
    if (typeof mod.runCrossChainGovernanceGateVeto === "function") {
      await mod.runCrossChainGovernanceGateVeto();
    }
  } catch {
    console.log("ℹ️  CrossChainGovernance gate/veto script not found; skipping");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

