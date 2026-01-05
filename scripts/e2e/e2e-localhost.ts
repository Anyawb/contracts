import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";

async function main() {
  const [deployer, borrower, lender] = await ethers.getSigners();

  const usdc = (await ethers.getContractAt("MockERC20", CONTRACT_ADDRESSES.MockUSDC)) as any;
  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
  const whitelist = (await ethers.getContractAt("AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist)) as any;
  const priceOracle = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", CONTRACT_ADDRESSES.PriceOracle)) as any;
  const vaultCore = (await ethers.getContractAt("VaultCore", CONTRACT_ADDRESSES.VaultCore)) as any;
  const vaultRouter = (await ethers.getContractAt("VaultRouter", CONTRACT_ADDRESSES.VaultRouter)) as any;
  const cm = (await ethers.getContractAt("CollateralManager", CONTRACT_ADDRESSES.CollateralManager)) as any;
  // HH701: 使用 fully qualified name 避免重名 (src/core 与 src/Vault)
  const le = (await ethers.getContractAt("src/Vault/LendingEngine.sol:LendingEngine", CONTRACT_ADDRESSES.LendingEngine)) as any;

  const ACTION_DEPOSIT = ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT"));
  const ACTION_BORROW = ethers.keccak256(ethers.toUtf8Bytes("BORROW"));
  const ACTION_REPAY = ethers.keccak256(ethers.toUtf8Bytes("REPAY"));
  const ACTION_WITHDRAW = ethers.keccak256(ethers.toUtf8Bytes("WITHDRAW"));
  const ACTION_VIEW_PUSH = ethers.keccak256(ethers.toUtf8Bytes("ACTION_VIEW_PUSH"));
  const ACTION_ADD_WHITELIST = ethers.keccak256(ethers.toUtf8Bytes("ADD_WHITELIST"));
  const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes("SET_PARAMETER"));
  const ACTION_UPDATE_PRICE = ethers.keccak256(ethers.toUtf8Bytes("UPDATE_PRICE"));
  const KEY_VAULT_BUSINESS_LOGIC = ethers.keccak256(ethers.toUtf8Bytes("VAULT_BUSINESS_LOGIC"));

  const ensureRole = async (role: string, account: string) => {
    const has = await acm.hasRole(role, account);
    if (!has) {
      await acm.grantRole(role, account);
    }
  };

  // ====== 基础配置 ======
  // 白名单资产
  const allowed = await whitelist.isAssetAllowed(usdc.target);
  if (!allowed) {
    await ensureRole(ACTION_ADD_WHITELIST, deployer.address);
    await whitelist.connect(deployer).addAllowedAsset(usdc.target);
  }

  // 设置价格 (1 USD = 1e8, PriceOracle uses 8 decimals)
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  {
    const cfg = await priceOracle.getAssetConfig(usdc.target);
    if (!cfg.isActive) {
      await ensureRole(ACTION_SET_PARAMETER, deployer.address);
      await priceOracle.connect(deployer).configureAsset(usdc.target, "usd-coin", 8, 3600);
    }
  }
  await ensureRole(ACTION_UPDATE_PRICE, deployer.address);
  await priceOracle.connect(deployer).updatePrice(usdc.target, ethers.parseUnits("1", 8), now);

  // 授权角色给 VaultRouter / VaultCore
  const roles = [ACTION_DEPOSIT, ACTION_BORROW, ACTION_REPAY, ACTION_WITHDRAW];
  for (const r of roles) {
    await ensureRole(r, vaultRouter.target);
    await ensureRole(r, vaultCore.target);
  }
  await ensureRole(ACTION_VIEW_PUSH, vaultRouter.target);
  await ensureRole(ACTION_VIEW_PUSH, vaultCore.target);

  // 让 PositionView 识别 VaultRouter 为业务入口
  try {
    const currentVbl = await registry.getModuleOrRevert(KEY_VAULT_BUSINESS_LOGIC);
    if (currentVbl.toLowerCase() !== vaultRouter.target.toLowerCase()) {
      await registry.connect(deployer).setModule(KEY_VAULT_BUSINESS_LOGIC, vaultRouter.target);
    }
  } catch {
    await registry.connect(deployer).setModule(KEY_VAULT_BUSINESS_LOGIC, vaultRouter.target);
  }

  // 资金准备
  await usdc.connect(deployer).transfer(borrower.address, ethers.parseUnits("10000", 6));
  await usdc.connect(deployer).transfer(lender.address, ethers.parseUnits("10000", 6));
  await usdc.connect(borrower).approve(vaultCore.target, ethers.MaxUint256);
  await usdc.connect(lender).approve(le.target, ethers.MaxUint256);

  console.log("has VIEW_PUSH (router/core):", await acm.hasRole(ACTION_VIEW_PUSH, vaultRouter.target), await acm.hasRole(ACTION_VIEW_PUSH, vaultCore.target));

  // ====== 1) 存抵押 ======
  const depositAmount = ethers.parseUnits("1000", 6);
  await vaultCore.connect(borrower).deposit(usdc.target, depositAmount);
  const col = await cm.getCollateral(borrower.address, usdc.target);
  console.log("Collateral after deposit:", col.toString());

  // ====== 2) 借款 ======
  const borrowAmount = ethers.parseUnits("500", 6);
  await vaultCore.connect(borrower).borrow(usdc.target, borrowAmount);
  console.log("Borrow done");

  // ====== 3) 还款 ======
  await usdc.connect(borrower).approve(vaultCore.target, borrowAmount);
  await vaultCore.connect(borrower).repay(usdc.target, borrowAmount);
  console.log("Repay done");

  // 验证抵押仍在（未退出）
  const colAfter = await cm.getCollateral(borrower.address, usdc.target);
  console.log("Collateral after repay (should be unchanged):", colAfter.toString());

  console.log("E2E flow completed on localhost");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
