import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";

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
  const le = (await ethers.getContractAt("src/Vault/LendingEngine.sol:LendingEngine", LE)) as any;
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
  // Borrower needs order/repay permissions for LendingEngine
  await ensureRole(ACTION_ORDER_CREATE, borrower.address);
  await ensureRole(ACTION_REPAY, borrower.address);

  // Allow asset + price
  if (!(await aw.isAssetAllowed(usdc.target))) {
    await ensureRole(ACTION_ADD_WHITELIST, deployer.address);
    await aw.connect(deployer).addAllowedAsset(usdc.target);
  }
  {
    const cfg = await po.getAssetConfig(usdc.target);
    if (!cfg.isActive) {
      await ensureRole(ACTION_SET_PARAMETER, deployer.address);
      await po.connect(deployer).configureAsset(usdc.target, "usd-coin", 8, 3600);
    }
  }
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  await ensureRole(ACTION_UPDATE_PRICE, deployer.address);
  await po.connect(deployer).updatePrice(usdc.target, ethers.parseUnits("1", 8), now);

  // Enable testing mode on router
  await ensureRole(ACTION_SET_PARAMETER, deployer.address);
  await vr.connect(deployer).setTestingMode(true);

  // Fund & approve
  await usdc.connect(deployer).transfer(borrower.address, ethers.parseUnits("10000", 6));
  await usdc.connect(deployer).transfer(lender.address, ethers.parseUnits("10000", 6));
  await usdc.connect(borrower).approve(VC, ethers.MaxUint256);
  await usdc.connect(lender).approve(le.target, ethers.MaxUint256);

  // 1) Deposit
  const depositAmt = ethers.parseUnits("1000", 6);
  await vc.connect(borrower).deposit(usdc.target, depositAmt);
  const col = await cm.getCollateral(borrower.address, usdc.target);
  console.log("Collateral after deposit:", col.toString());

  // 2) Borrow (simple path via LendingEngine core — may rely on ACTION_ORDER_CREATE)
  const borrowAmt = ethers.parseUnits("500", 6);
  await vc.connect(borrower).borrow(usdc.target, borrowAmt);
  console.log("Borrow done");

  // 3) Repay
  await usdc.connect(borrower).approve(VC, borrowAmt);
  const orderId = 1n; // legacy demo script: placeholder orderId
  await vc.connect(borrower).repay(orderId, usdc.target, borrowAmt);
  console.log("Repay done");

  const colAfter = await cm.getCollateral(borrower.address, usdc.target);
  console.log("Collateral after repay (should be unchanged):", colAfter.toString());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

