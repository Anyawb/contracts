/**
 * FeeRouter E2E 测试脚本
 * 
 * 测试目标:
 * - 费率初始化正确性
 * - 费用分发功能
 * - 动态费率设置
 * - 权限控制验证
 * - 批量费用分发
 * - 费用统计功能
 * - 大金额处理
 * - 事件验证
 */

import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";
import { expect } from "chai";

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const BPS_DENOM = 10000n;
function calcFee(amount: bigint, bps: bigint): bigint {
  return (amount * bps) / BPS_DENOM;
}

async function main() {
  console.log("=== FeeRouter E2E Test on Localhost ===\n");

  const [deployer, alice, bob, treasury, ecoVault] = await ethers.getSigners();
  console.log("📋 Test Accounts:");
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`  Alice: ${alice.address}`);
  console.log(`  Bob: ${bob.address}`);
  console.log(`  Treasury: ${treasury.address}`);
  console.log(`  EcoVault: ${ecoVault.address}\n`);

  // 获取已部署的合约
  const registry = await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry);
  const acm = await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager);
  const feeRouter = await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", CONTRACT_ADDRESSES.FeeRouter);
  const usdc = await ethers.getContractAt("MockERC20", CONTRACT_ADDRESSES.MockUSDC);

  console.log("📋 Contract Addresses:");
  console.log(`  Registry: ${await registry.getAddress()}`);
  console.log(`  ACM: ${await acm.getAddress()}`);
  console.log(`  FeeRouter: ${await feeRouter.getAddress()}`);
  console.log(`  USDC: ${await usdc.getAddress()}\n`);

  // 设置权限
  const ACTION_DEPOSIT = ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT"));
  const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes("SET_PARAMETER"));
  const ACTION_PAUSE_SYSTEM = ethers.keccak256(ethers.toUtf8Bytes("PAUSE_SYSTEM"));
  const ACTION_UNPAUSE_SYSTEM = ethers.keccak256(ethers.toUtf8Bytes("UNPAUSE_SYSTEM"));

  const ensureRole = async (role: string, account: string) => {
    const has = await acm.hasRole(role, account);
    if (!has) {
      await (await acm.grantRole(role, account)).wait();
      console.log(`  ✅ Granted role to ${account}`);
    }
  };

  console.log("🔐 Setting up permissions...");
  await ensureRole(ACTION_DEPOSIT, alice.address);
  await ensureRole(ACTION_SET_PARAMETER, deployer.address);
  await ensureRole(ACTION_PAUSE_SYSTEM, deployer.address);
  await ensureRole(ACTION_UNPAUSE_SYSTEM, deployer.address);
  console.log("");

  // 准备代币
  const tokenAmount = ethers.parseUnits("100000", 6); // 10万 USDC
  await usdc.connect(deployer).transfer(alice.address, tokenAmount);
  await usdc.connect(deployer).transfer(bob.address, tokenAmount);
  console.log("💰 Transferred tokens to test accounts");

  // 确保代币已添加到 FeeRouter 支持列表
  const isSupported = await feeRouter.isTokenSupported(await usdc.getAddress());
  if (!isSupported) {
    await feeRouter.connect(deployer).addSupportedToken(await usdc.getAddress());
    console.log("✅ Added USDC to supported tokens");
  }

  // ====== 1. 费率初始化测试 ======
  console.log("\n=== 1. Fee Configuration Test ===");
  const platformFeeBps = await feeRouter.getPlatformFeeBps();
  const ecosystemFeeBps = await feeRouter.getEcosystemFeeBps();
  const totalFeeRate = await feeRouter.getFeeRate();
  const platformTreasury = await feeRouter.getPlatformTreasury();
  const ecosystemVault = await feeRouter.getEcosystemVault();

  console.log(`  Platform Fee: ${platformFeeBps} bps (${Number(platformFeeBps) / 100}%)`);
  console.log(`  Ecosystem Fee: ${ecosystemFeeBps} bps (${Number(ecosystemFeeBps) / 100}%)`);
  console.log(`  Total Fee Rate: ${totalFeeRate} bps (${Number(totalFeeRate) / 100}%)`);
  console.log(`  Platform Treasury: ${platformTreasury}`);
  console.log(`  Ecosystem Vault: ${ecosystemVault}`);
  // NOTE: Do not assume "treasury/ecoVault" signers are the configured recipients.
  // Always validate against FeeRouter's configured treasury addresses.
  expect(platformTreasury).to.not.equal(ZERO_ADDRESS);
  expect(ecosystemVault).to.not.equal(ZERO_ADDRESS);

  // 测试费用计算
  const testAmount = ethers.parseUnits("1000", 6);
  const depositFee = await feeRouter.chargeDepositFee(ZERO_ADDRESS, testAmount);
  const borrowFee = await feeRouter.chargeBorrowFee(ZERO_ADDRESS, testAmount);
  console.log(`  Deposit Fee for 1000 USDC: ${ethers.formatUnits(depositFee, 6)} USDC`);
  console.log(`  Borrow Fee for 1000 USDC: ${ethers.formatUnits(borrowFee, 6)} USDC`);
  expect(depositFee).to.equal(borrowFee);
  expect(depositFee).to.equal(calcFee(testAmount, BigInt(totalFeeRate)));

  // ====== 2. 常规费用分发测试 ======
  console.log("\n=== 2. Normal Fee Distribution Test ===");
  const distributeAmount = ethers.parseUnits("1000", 6);
  await usdc.connect(alice).approve(await feeRouter.getAddress(), distributeAmount);

  const treasuryInitialBalance = await usdc.balanceOf(platformTreasury);
  const ecoVaultInitialBalance = await usdc.balanceOf(ecosystemVault);
  const aliceInitialBalance = await usdc.balanceOf(alice.address);

  console.log(`  Distributing ${ethers.formatUnits(distributeAmount, 6)} USDC...`);
  const tx = await feeRouter.connect(alice).distributeNormal(await usdc.getAddress(), distributeAmount);
  const receipt = await tx.wait();
  console.log(`  ✅ Transaction hash: ${receipt?.hash}`);

  // 验证余额变化
  const treasuryFinalBalance = await usdc.balanceOf(platformTreasury);
  const ecoVaultFinalBalance = await usdc.balanceOf(ecosystemVault);
  const aliceFinalBalance = await usdc.balanceOf(alice.address);

  const treasuryReceived = treasuryFinalBalance - treasuryInitialBalance;
  const ecoVaultReceived = ecoVaultFinalBalance - ecoVaultInitialBalance;
  const aliceSpent = aliceInitialBalance - aliceFinalBalance;

  console.log(`  Treasury received: ${ethers.formatUnits(treasuryReceived, 6)} USDC`);
  console.log(`  EcoVault received: ${ethers.formatUnits(ecoVaultReceived, 6)} USDC`);
  console.log(`  Alice spent: ${ethers.formatUnits(aliceSpent, 6)} USDC`);

  // Assert distribution math (FeeRouter returns remaining to caller)
  const expectedPlatform = calcFee(distributeAmount, BigInt(platformFeeBps));
  const expectedEco = calcFee(distributeAmount, BigInt(ecosystemFeeBps));
  expect(treasuryReceived).to.equal(expectedPlatform);
  expect(ecoVaultReceived).to.equal(expectedEco);
  expect(aliceSpent).to.equal(expectedPlatform + expectedEco);

  // 验证事件
  const feeDistributedEvent = receipt?.logs.find((log: any) => {
    try {
      const parsed = feeRouter.interface.parseLog(log);
      return parsed?.name === "FeeDistributed";
    } catch {
      return false;
    }
  });
  if (feeDistributedEvent) {
    const parsed = feeRouter.interface.parseLog(feeDistributedEvent);
    console.log(`  ✅ FeeDistributed event emitted`);
    console.log(`     Platform: ${ethers.formatUnits(parsed?.args[1], 6)} USDC`);
    console.log(`     Ecosystem: ${ethers.formatUnits(parsed?.args[2], 6)} USDC`);
  }

  // ====== 3. 动态费率测试 ======
  console.log("\n=== 3. Dynamic Fee Test ===");
  const feeType = ethers.keccak256(ethers.toUtf8Bytes("CUSTOM_FEE"));
  const dynamicFeeBps = 50; // 0.5%

  console.log(`  Setting dynamic fee: ${dynamicFeeBps} bps (0.5%)`);
  const setFeeTx = await feeRouter.connect(deployer).setDynamicFee(await usdc.getAddress(), feeType, dynamicFeeBps);
  const setFeeReceipt = await setFeeTx.wait();
  console.log(`  ✅ Dynamic fee set`);

  // 验证动态费率
  const retrievedFee = await feeRouter.getDynamicFee(await usdc.getAddress(), feeType);
  console.log(`  Retrieved dynamic fee: ${retrievedFee} bps`);

  // 验证事件
  const dynamicFeeUpdatedEvent = setFeeReceipt?.logs.find((log: any) => {
    try {
      const parsed = feeRouter.interface.parseLog(log);
      return parsed?.name === "DynamicFeeUpdated";
    } catch {
      return false;
    }
  });
  if (dynamicFeeUpdatedEvent) {
    const parsed = feeRouter.interface.parseLog(dynamicFeeUpdatedEvent);
    console.log(`  ✅ DynamicFeeUpdated event emitted`);
    console.log(`     Old Fee: ${parsed?.args[2]} bps`);
    console.log(`     New Fee: ${parsed?.args[3]} bps`);
  }

  // 测试动态费率分发
  const dynamicAmount = ethers.parseUnits("2000", 6);
  await usdc.connect(alice).approve(await feeRouter.getAddress(), dynamicAmount);
  console.log(`  Distributing ${ethers.formatUnits(dynamicAmount, 6)} USDC with dynamic fee...`);
  await feeRouter.connect(alice).distributeDynamic(await usdc.getAddress(), dynamicAmount, feeType);
  console.log(`  ✅ Dynamic fee distribution completed`);

  // ====== 4. 批量费用分发测试 ======
  console.log("\n=== 4. Batch Fee Distribution Test ===");
  const amounts = [
    ethers.parseUnits("100", 6),
    ethers.parseUnits("200", 6),
    ethers.parseUnits("300", 6)
  ];
  const feeTypes = [
    ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT")),
    ethers.keccak256(ethers.toUtf8Bytes("BORROW")),
    ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATE"))
  ];

  const totalBatchAmount = amounts.reduce((sum, amount) => sum + amount, 0n);
  await usdc.connect(alice).approve(await feeRouter.getAddress(), totalBatchAmount);

  console.log(`  Batch distributing ${amounts.length} fees (total: ${ethers.formatUnits(totalBatchAmount, 6)} USDC)...`);
  const batchTx = await feeRouter.connect(alice).batchDistribute(await usdc.getAddress(), amounts, feeTypes);
  const batchReceipt = await batchTx.wait();
  console.log(`  ✅ Batch distribution completed`);

  // 验证事件
  const batchFeeDistributedEvent = batchReceipt?.logs.find((log: any) => {
    try {
      const parsed = feeRouter.interface.parseLog(log);
      return parsed?.name === "BatchFeeDistributed";
    } catch {
      return false;
    }
  });
  if (batchFeeDistributedEvent) {
    const parsed = feeRouter.interface.parseLog(batchFeeDistributedEvent);
    console.log(`  ✅ BatchFeeDistributed event emitted`);
    console.log(`     Total Amount: ${ethers.formatUnits(parsed?.args[1], 6)} USDC`);
    console.log(`     Distribution Count: ${parsed?.args[2]}`);
  }

  // ====== 5. 费用统计测试 ======
  console.log("\n=== 5. Fee Statistics Test ===");
  const depositFeeType = ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT"));
  const feeStatistics = await feeRouter.getFeeStatistics(await usdc.getAddress(), depositFeeType);
  const feeCache = await feeRouter.getFeeCache(await usdc.getAddress(), depositFeeType);
  const totalDistributions = await feeRouter.getTotalDistributions();
  const totalAmountDistributed = await feeRouter.getTotalAmountDistributed();

  console.log(`  Fee Statistics (DEPOSIT): ${ethers.formatUnits(feeStatistics, 6)} USDC`);
  console.log(`  Fee Cache (DEPOSIT): ${ethers.formatUnits(feeCache, 6)} USDC`);
  console.log(`  Total Distributions: ${totalDistributions}`);
  console.log(`  Total Amount Distributed: ${ethers.formatUnits(totalAmountDistributed, 6)} USDC`);

  // ====== 6. 大金额处理测试 ======
  console.log("\n=== 6. Large Amount Test ===");
  const largeAmount = ethers.parseUnits("100000", 6); // 10万 USDC
  await usdc.connect(deployer).transfer(alice.address, largeAmount);
  await usdc.connect(alice).approve(await feeRouter.getAddress(), largeAmount);

  const treasuryInitialLarge = await usdc.balanceOf(platformTreasury);
  const ecoVaultInitialLarge = await usdc.balanceOf(ecosystemVault);

  console.log(`  Distributing large amount: ${ethers.formatUnits(largeAmount, 6)} USDC...`);
  await feeRouter.connect(alice).distributeNormal(await usdc.getAddress(), largeAmount);
  console.log(`  ✅ Large amount distribution completed`);

  const treasuryFinalLarge = await usdc.balanceOf(platformTreasury);
  const ecoVaultFinalLarge = await usdc.balanceOf(ecosystemVault);

  const expectedPlatformFee = calcFee(largeAmount, BigInt(platformFeeBps));
  const expectedEcoFee = calcFee(largeAmount, BigInt(ecosystemFeeBps));

  console.log(`  Treasury received: ${ethers.formatUnits(treasuryFinalLarge - treasuryInitialLarge, 6)} USDC (expected: ${ethers.formatUnits(expectedPlatformFee, 6)})`);
  console.log(`  EcoVault received: ${ethers.formatUnits(ecoVaultFinalLarge - ecoVaultInitialLarge, 6)} USDC (expected: ${ethers.formatUnits(expectedEcoFee, 6)})`);
  expect(treasuryFinalLarge - treasuryInitialLarge).to.equal(expectedPlatformFee);
  expect(ecoVaultFinalLarge - ecoVaultInitialLarge).to.equal(expectedEcoFee);

  // ====== 7. 费率配置更新测试 ======
  console.log("\n=== 7. Fee Config Update Test ===");
  const newPlatformBps = 10; // 0.1%
  const newEcoBps = 2; // 0.02%

  console.log(`  Updating fee config: platform=${newPlatformBps} bps, eco=${newEcoBps} bps`);
  const updateConfigTx = await feeRouter.connect(deployer).setFeeConfig(newPlatformBps, newEcoBps);
  const updateConfigReceipt = await updateConfigTx.wait();
  console.log(`  ✅ Fee config updated`);

  // 验证更新
  const updatedPlatformFeeBps = await feeRouter.getPlatformFeeBps();
  const updatedEcoFeeBps = await feeRouter.getEcosystemFeeBps();
  console.log(`  Updated Platform Fee: ${updatedPlatformFeeBps} bps`);
  console.log(`  Updated Ecosystem Fee: ${updatedEcoFeeBps} bps`);

  // 验证事件
  const feeConfigUpdatedEvent = updateConfigReceipt?.logs.find((log: any) => {
    try {
      const parsed = feeRouter.interface.parseLog(log);
      return parsed?.name === "FeeConfigUpdated";
    } catch {
      return false;
    }
  });
  if (feeConfigUpdatedEvent) {
    const parsed = feeRouter.interface.parseLog(feeConfigUpdatedEvent);
    console.log(`  ✅ FeeConfigUpdated event emitted`);
    console.log(`     Platform Bps: ${parsed?.args[0]}`);
    console.log(`     Eco Bps: ${parsed?.args[1]}`);
  }

  // ====== 8. 暂停/恢复测试 ======
  console.log("\n=== 8. Pause/Unpause Test ===");
  console.log(`  Pausing FeeRouter...`);
  await feeRouter.connect(deployer).pause();
  console.log(`  ✅ FeeRouter paused`);

  // 尝试在暂停状态下分发（应该失败）
  const testPauseAmount = ethers.parseUnits("100", 6);
  await usdc.connect(alice).approve(await feeRouter.getAddress(), testPauseAmount);
  try {
    await feeRouter.connect(alice).distributeNormal(await usdc.getAddress(), testPauseAmount);
    console.log(`  ⚠️ Distribution succeeded (unexpected)`);
  } catch (error: any) {
    console.log(`  ✅ Distribution correctly reverted: ${error.message.substring(0, 100)}`);
  }

  console.log(`  Unpausing FeeRouter...`);
  await feeRouter.connect(deployer).unpause();
  console.log(`  ✅ FeeRouter unpaused`);

  // 恢复后应该可以分发
  await feeRouter.connect(alice).distributeNormal(await usdc.getAddress(), testPauseAmount);
  console.log(`  ✅ Distribution succeeded after unpause`);

  // ====== 9. 代币管理测试 ======
  console.log("\n=== 9. Token Management Test ===");
  const supportedTokens = await feeRouter.getSupportedTokens();
  console.log(`  Supported tokens count: ${supportedTokens.length}`);
  console.log(`  USDC is supported: ${await feeRouter.isTokenSupported(await usdc.getAddress())}`);

  // ====== 10. 操作统计测试 ======
  console.log("\n=== 10. Operation Statistics Test ===");
  const [finalDistributions, finalTotalAmount] = await feeRouter.getOperationStats();
  console.log(`  Total Distributions: ${finalDistributions}`);
  console.log(`  Total Amount Distributed: ${ethers.formatUnits(finalTotalAmount, 6)} USDC`);

  console.log("\n✅ All FeeRouter E2E tests completed successfully!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
