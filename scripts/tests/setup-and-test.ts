import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";

async function main() {
  console.log("=== 前置条件设置 ===\n");

  // 1) 读取 Registry -> 关键地址
  const [deployer, keeper, borrower] = await ethers.getSigners();
  console.log("  Deployer:", deployer.address);
  console.log("  Keeper:", keeper.address);
  console.log("  Borrower:", borrower.address);
  console.log("");

  const registryAddr = CONTRACT_ADDRESSES.Registry;
  if (!registryAddr) {
    throw new Error("[Config] Missing Registry in frontend-config/contracts-localhost.ts");
  }
  console.log("  Registry:", registryAddr);

  const registry = await ethers.getContractAt(
    ["function getModule(bytes32) view returns (address)"],
    registryAddr
  );

  const key = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name));

  const vaultCore = await registry.getModule(key("VAULT_CORE"));
  const cm = await registry.getModule(key("COLLATERAL_MANAGER"));
  const orderEngine = await registry.getModule(key("ORDER_ENGINE"));
  const settlementManager = await registry.getModule(key("SETTLEMENT_MANAGER"));
  const lendingEngine = await registry.getModule(key("LENDING_ENGINE"));

  console.log("  VaultCore:", vaultCore);
  console.log("  CollateralManager:", cm);
  console.log("  OrderEngine:", orderEngine);
  console.log("  SettlementManager:", settlementManager);
  console.log("  LendingEngine:", lendingEngine);
  console.log("");

  // 2) 取订单里的债务资产（debtAsset）
  const orderId = BigInt(process.env.ORDER_ID ?? "10");
  console.log(`  订单 ID: ${orderId.toString()}`);

  const orderEngineAbi = [
    "function _getLoanOrderForView(uint256) view returns (tuple(uint256 principal,uint256 rate,uint256 term,address borrower,address lender,address asset,uint256 startTimestamp,uint256 maturity,uint256 repaidAmount))",
  ];
  const orderEngineContract = (await ethers.getContractAt(orderEngineAbi, orderEngine)) as any;
  const orderRes = (await orderEngineContract._getLoanOrderForView(orderId)) as any;
  const order = Array.isArray(orderRes) && orderRes.length === 1 ? orderRes[0] : orderRes;
  const orderBorrower = (order?.borrower ?? order?.[3]) as string | undefined;
  const debtAsset = (order?.asset ?? order?.[5]) as string | undefined;
  const principal = (order?.principal ?? order?.[0]) as bigint | undefined;
  const rate = (order?.rate ?? order?.[1]) as bigint | undefined;
  const term = (order?.term ?? order?.[2]) as bigint | undefined;
  const repaidAmount = (order?.repaidAmount ?? order?.[8]) as bigint | undefined;
  if (!orderBorrower || !debtAsset) {
    throw new Error(`[Config] Invalid order response for orderId=${orderId.toString()}`);
  }

  let borrowerSigner = borrower;
  if (orderBorrower.toLowerCase() !== borrower.address.toLowerCase()) {
    try {
      borrowerSigner = await ethers.getSigner(orderBorrower);
      console.log(`  borrower signer: ${borrowerSigner.address}`);
    } catch {
      throw new Error(
        `[Config] Order borrower (${orderBorrower}) is not an available local signer.`
      );
    }
  }

  if (principal === undefined || rate === undefined || term === undefined || repaidAmount === undefined) {
    throw new Error(`[Config] Invalid order fields for orderId=${orderId.toString()}`);
  }
  const YEAR = 365n * 24n * 60n * 60n;
  const interest = (principal * rate * term) / (YEAR * 10000n);
  const totalDue = principal + interest;
  const remainingDue = totalDue > repaidAmount ? totalDue - repaidAmount : 0n;

  console.log("  订单 borrower:", orderBorrower);
  console.log("  订单 debtAsset:", debtAsset);
  console.log("  订单 principal:", principal.toString());
  console.log("  订单 rate:", rate.toString());
  console.log("  订单 term:", term.toString());
  console.log("  订单 repaidAmount:", repaidAmount.toString());
  console.log("  订单 totalDue:", totalDue.toString());
  console.log("  订单 remainingDue:", remainingDue.toString());
  console.log("");

  const cmAbi = ["function getUserCollateralAssets(address) view returns (address[])"];
  const cmContract = (await ethers.getContractAt(cmAbi, cm)) as any;
  const collateralAssets = (await cmContract.getUserCollateralAssets(orderBorrower)) as string[];
  const collateralAsset = collateralAssets.length > 0 ? collateralAssets[0] : debtAsset;
  console.log("  Collateral asset (first):", collateralAsset);
  console.log("");

  const smAbi = ["function requireFullRepayRelease() view returns (bool)"];
  const smContract = (await ethers.getContractAt(smAbi, settlementManager)) as any;
  const requireFullRepayRelease = (await smContract.requireFullRepayRelease()) as boolean;
  console.log("  requireFullRepayRelease:", requireFullRepayRelease);

  const leAbi = ["function getDebt(address user, address asset) view returns (uint256)"];
  const leContract = (await ethers.getContractAt(leAbi, lendingEngine)) as any;
  const currentDebt = (await leContract.getDebt(orderBorrower, debtAsset)) as bigint;
  console.log("  currentDebt:", currentDebt.toString());
  console.log("");

  const erc20CommonAbi = [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256)",
    "function mint(address,uint256)",
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)",
  ];
  const minAmount = 1n;
  if (requireFullRepayRelease && remainingDue == 0n) {
    throw new Error("[Config] remainingDue is zero while strict full-repay mode is enabled.");
  }
  const repayAmount = requireFullRepayRelease ? remainingDue : minAmount;

  async function ensureBalanceAndAllowance(
    tokenAddr: string,
    label: string,
    spender: string,
    requiredAmount: bigint = minAmount
  ) {
    console.log(`  [${label}] 检查余额与 allowance...`);
    const token = (await ethers.getContractAt(erc20CommonAbi, tokenAddr)) as any;
    const bal = await token.balanceOf(orderBorrower);
    console.log(`  [${label}] Borrower 当前余额:`, bal.toString());
    if (bal < requiredAmount) {
      console.log(`  [${label}] 余额不足，尝试 mint...`);
      try {
        const tx = await token.connect(deployer).mint(orderBorrower, requiredAmount);
        await tx.wait();
        console.log(`  ✅ [${label}] Mint 成功`);
      } catch {
        console.log(`  [${label}] Mint 失败，尝试 transfer...`);
        const deployerBal = await token.balanceOf(deployer.address);
        if (deployerBal < requiredAmount) {
          throw new Error(`[${label}] Deployer 也没有余额，无法转账`);
        }
        const tx = await token.connect(deployer).transfer(orderBorrower, requiredAmount);
        await tx.wait();
        console.log(`  ✅ [${label}] Transfer 成功`);
      }
    } else {
      console.log(`  ✅ [${label}] Borrower 已有足够余额`);
    }

    const allowance = await token.allowance(orderBorrower, spender);
    console.log(`  [${label}] allowance:`, allowance.toString());
    if (allowance < requiredAmount) {
      const tx = await token.connect(borrowerSigner).approve(spender, ethers.MaxUint256);
      await tx.wait();
      console.log(`  ✅ [${label}] Approve 成功`);
    } else {
      console.log(`  ✅ [${label}] Allowance 已满足最小值`);
    }
    console.log("");
  }

  await ensureBalanceAndAllowance(collateralAsset, "Collateral", cm);
  await ensureBalanceAndAllowance(debtAsset, "Debt", vaultCore, repayAmount);

  console.log("=== 前置条件设置完成 ===\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
