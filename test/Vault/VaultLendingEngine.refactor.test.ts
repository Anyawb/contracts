/**
 * VaultLendingEngine 拆分后的账本与入口一致性测试
 *
 * 覆盖点（对应 Architecture-Analysis-Refactor-Summary）：
 * - 统一入口：borrow/repay 仅允许 KEY_VAULT_CORE 调用（onlyVaultCore）
 * - 清算直达入口：forceReduceDebt 需 ACTION_LIQUIDATE，且会同步 View/Health
 * - 账本写入与视图推送：借/还/清算后 VaultView 缓存更新
 * - 健康推送：借/清算后 HealthView 收到 pushRiskStatus
 *
 * 规范：参考 docs/test-file-standards.md（权限、断言、导入方式）
 */

import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';

import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import type {
  VaultLendingEngine,
  MockRegistry,
  MockAccessControlManager,
  MockCollateralManager,
  MockVaultView,
  MockHealthView,
  MockRewardManager,
  MockPriceOracle,
  MockERC20,
  MockVaultCoreView,
  MockLiquidationRiskManager,
} from '../../types';

// Module keys（与 ModuleKeys.sol 保持一致）
const ModuleKeys = {
  KEY_CM: ethers.keccak256(ethers.toUtf8Bytes('COLLATERAL_MANAGER')),
  KEY_HEALTH_VIEW: ethers.keccak256(ethers.toUtf8Bytes('HEALTH_VIEW')),
  KEY_LIQUIDATION_RISK_MANAGER: ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATION_RISK_MANAGER')),
  KEY_VAULT_CORE: ethers.keccak256(ethers.toUtf8Bytes('VAULT_CORE')),
  KEY_ACCESS_CONTROL: ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER')),
  KEY_REWARD_MANAGER_V1: ethers.keccak256(ethers.toUtf8Bytes('REWARD_MANAGER_V1')),
};

// Action keys（与 ActionKeys.sol 保持一致）
const ACTION_LIQUIDATE = ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATE'));

describe('VaultLendingEngine – refactor regression', function () {
  async function deployFixture() {
    const [vaultCore, liquidator, user] = await ethers.getSigners();

    // Deploy mocks
    const Registry = await ethers.getContractFactory('MockRegistry');
    const registry = (await Registry.deploy()) as MockRegistry;

    const ACM = await ethers.getContractFactory('MockAccessControlManager');
    const acm = (await ACM.deploy()) as MockAccessControlManager;

    const CM = await ethers.getContractFactory('MockCollateralManager');
    const cm = (await CM.deploy()) as MockCollateralManager;

    const VaultView = await ethers.getContractFactory('MockVaultView');
    const vaultView = (await VaultView.deploy()) as MockVaultView;

    const HealthView = await ethers.getContractFactory('MockHealthView');
    const healthView = (await HealthView.deploy()) as MockHealthView;

    const RewardManager = await ethers.getContractFactory('MockRewardManager');
    const rewardManager = (await RewardManager.deploy()) as MockRewardManager;

    const PriceOracle = await ethers.getContractFactory('MockPriceOracle');
    const priceOracle = (await PriceOracle.deploy()) as MockPriceOracle;

    const LRM = await ethers.getContractFactory('MockLiquidationRiskManager');
    const lrm = (await LRM.deploy()) as MockLiquidationRiskManager;

    const ERC20 = await ethers.getContractFactory('MockERC20');
    const settlementToken = (await ERC20.deploy('Settlement', 'ST', ethers.parseEther('1000000'))) as MockERC20;

    // Configure oracle price
    // Using 1e8 (100000000) to match DEFAULT_MAX_REASONABLE_PRICE = 1e12
    // Price should be <= 1e12 to pass validation in GracefulDegradation
    const nowTs = Math.floor(Date.now() / 1000);
    const priceValue = ethers.parseUnits('1', 8); // 1e8, which is < 1e12
    await priceOracle.connect(vaultCore).setPrice(await settlementToken.getAddress(), priceValue, nowTs, 8);
    const debtAsset = ethers.Wallet.createRandom().address;
    await priceOracle.connect(vaultCore).setPrice(debtAsset, priceValue, nowTs, 8);

    // Deploy LendingEngine
    const LendingEngine = await ethers.getContractFactory('VaultLendingEngine');
    const lending = (await LendingEngine.deploy()) as VaultLendingEngine;
    await lending.initialize(await priceOracle.getAddress(), await settlementToken.getAddress(), await registry.getAddress());

    // VaultCore mock with view resolver + forwarder
    // IMPORTANT: Deploy, configure, THEN register to Registry
    const VaultCoreView = await ethers.getContractFactory('MockVaultCoreView');
    const vaultCoreModule = await VaultCoreView.deploy();
    await vaultCoreModule.setViewContractAddr(await vaultView.getAddress());
    await vaultCoreModule.setLendingEngine(await lending.getAddress());

    // Registry wiring - ensure ALL required modules are registered
    // Verify all addresses are non-zero before registration
    const acmAddr = await acm.getAddress();
    const cmAddr = await cm.getAddress();
    const healthViewAddr = await healthView.getAddress();
    const lrmAddr = await lrm.getAddress();
    const vaultCoreModuleAddr = await vaultCoreModule.getAddress();
    const rewardManagerAddr = await rewardManager.getAddress();
    const vaultViewAddr = await vaultView.getAddress();

    // Verify addresses are non-zero
    if (acmAddr === ethers.ZeroAddress || cmAddr === ethers.ZeroAddress || 
        healthViewAddr === ethers.ZeroAddress || lrmAddr === ethers.ZeroAddress ||
        vaultCoreModuleAddr === ethers.ZeroAddress || rewardManagerAddr === ethers.ZeroAddress ||
        vaultViewAddr === ethers.ZeroAddress) {
      throw new Error('One or more module addresses are zero');
    }

    // Verify viewContractAddr is set
    const viewContractAddr = await vaultCoreModule.viewContractAddrVar();
    if (viewContractAddr === ethers.ZeroAddress || viewContractAddr !== vaultViewAddr) {
      throw new Error(`viewContractAddr not set correctly: ${viewContractAddr} != ${vaultViewAddr}`);
    }

    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, acmAddr);
    await registry.setModule(ModuleKeys.KEY_CM, cmAddr);
    await registry.setModule(ModuleKeys.KEY_HEALTH_VIEW, healthViewAddr);
    await registry.setModule(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER, lrmAddr);
    await registry.setModule(ModuleKeys.KEY_VAULT_CORE, vaultCoreModuleAddr);
    await registry.setModule(ModuleKeys.KEY_REWARD_MANAGER_V1, rewardManagerAddr);

    // Roles
    await acm.grantRole(ACTION_LIQUIDATE, liquidator.address);

    // Seed collateral to get meaningful health factor
    await cm.depositCollateral(user.address, debtAsset, 200);

    return { vaultCoreModule, vaultCore, liquidator, user, lending, registry, cm, vaultView, healthView, debtAsset, acm, priceOracle, settlementToken, lrm };
  }

  describe('onlyVaultCore guard', function () {
    it('borrow should revert when caller is not KEY_VAULT_CORE', async function () {
      const { lending, user, debtAsset } = await loadFixture(deployFixture);
      try {
        await lending.connect(user).borrow(user.address, debtAsset, 10, 0, 0);
        throw new Error('Expected transaction to revert');
      } catch (error: any) {
        console.log('\n=== onlyVaultCore guard test error ===');
        console.log('Error message:', error.message);
        console.log('Error reason:', error.reason);
        console.log('Error data:', error.data);
        if (error.data && error.data !== '0x') {
          try {
            const iface = new ethers.Interface([
              'error VaultLendingEngine__OnlyVaultCore()',
              'error ZeroAddress()',
            ]);
            const decoded = iface.parseError(error.data);
            console.log('Decoded error:', decoded.name);
          } catch (decodeErr) {
            console.log('Could not decode error');
          }
        }
        // Re-throw to let the test framework handle it
        await expect(
          lending.connect(user).borrow(user.address, debtAsset, 10, 0, 0)
        ).to.be.revertedWithCustomError(lending, 'VaultLendingEngine__OnlyVaultCore');
      }
    });

    it('repay should revert when caller is not KEY_VAULT_CORE', async function () {
      const { vaultCoreModule, lending, user, debtAsset } = await loadFixture(deployFixture);
      await vaultCoreModule.borrow(user.address, debtAsset, 20, 0, 0);
      await expect(
        lending.connect(user).repay(user.address, debtAsset, 10)
      ).to.be.revertedWithCustomError(lending, 'VaultLendingEngine__OnlyVaultCore');
    });
  });

  describe('borrow / repay happy path', function () {
    it('should update ledger, push view, and push health on borrow', async function () {
      const { vaultCoreModule, user, lending, cm, debtAsset, healthView, vaultView, priceOracle, registry } = await loadFixture(deployFixture);

      // Debug: Check all module addresses and code sizes
      console.log('\n=== Module Address and Code Size Check ===');
      try {
        const acmAddr = await registry.getModule(ModuleKeys.KEY_ACCESS_CONTROL);
        const cmAddr = await registry.getModule(ModuleKeys.KEY_CM);
        const healthViewAddr = await registry.getModule(ModuleKeys.KEY_HEALTH_VIEW);
        const lrmAddr = await registry.getModule(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        const vaultCoreAddr = await registry.getModule(ModuleKeys.KEY_VAULT_CORE);
        const rewardManagerAddr = await registry.getModule(ModuleKeys.KEY_REWARD_MANAGER_V1);
        
        console.log('ACM address:', acmAddr);
        console.log('CM address:', cmAddr);
        console.log('HealthView address:', healthViewAddr);
        console.log('LRM address:', lrmAddr);
        console.log('VaultCore address:', vaultCoreAddr);
        console.log('RewardManager address:', rewardManagerAddr);
        
        // Check code sizes
        const acmCode = await ethers.provider.getCode(acmAddr);
        const cmCode = await ethers.provider.getCode(cmAddr);
        const healthViewCode = await ethers.provider.getCode(healthViewAddr);
        const lrmCode = await ethers.provider.getCode(lrmAddr);
        const vaultCoreCode = await ethers.provider.getCode(vaultCoreAddr);
        const rewardManagerCode = await ethers.provider.getCode(rewardManagerAddr);
        
        console.log('ACM code size:', acmCode.length);
        console.log('CM code size:', cmCode.length);
        console.log('HealthView code size:', healthViewCode.length);
        console.log('LRM code size:', lrmCode.length);
        console.log('VaultCore code size:', vaultCoreCode.length);
        console.log('RewardManager code size:', rewardManagerCode.length);
        
        // Check viewContractAddr from VaultCore
        const vaultCoreContract = await ethers.getContractAt('MockVaultCoreView', vaultCoreAddr);
        const viewContractAddr = await vaultCoreContract.viewContractAddrVar();
        console.log('ViewContractAddr from VaultCore:', viewContractAddr);
        const viewCode = await ethers.provider.getCode(viewContractAddr);
        console.log('View code size:', viewCode.length);
        
        if (acmCode === '0x' || cmCode === '0x' || healthViewCode === '0x' || lrmCode === '0x' || vaultCoreCode === '0x' || rewardManagerCode === '0x' || viewCode === '0x') {
          console.log('*** WARNING: One or more contracts have zero code size! ***');
        }
      } catch (addrErr: any) {
        console.log('Error checking addresses:', addrErr.message);
      }

      // Debug: Check price and decimals
      try {
        const [price, timestamp, decimals] = await priceOracle.getPrice(debtAsset);
        console.log('\n=== Price Debug Info ===');
        console.log('debtAsset:', debtAsset);
        console.log('Price:', price.toString());
        console.log('Timestamp:', timestamp.toString());
        console.log('Decimals:', decimals.toString());
        console.log('Amount to borrow: 50');
        // Calculate expected value: 50 * price / 10^decimals
        const priceMultiplier = 10n ** BigInt(decimals);
        const expectedValue = (50n * BigInt(price)) / priceMultiplier;
        console.log('Expected calculated value:', expectedValue.toString());
        console.log('Price multiplier:', priceMultiplier.toString());
        console.log('Amount value: 50');
        // Check overflow detection: calculatedValue >= amountValue || priceValue >= priceMultiplier
        const overflowCheck1 = expectedValue >= 50n;
        const overflowCheck2 = BigInt(price) >= priceMultiplier;
        const overflowCheckPass = overflowCheck1 || overflowCheck2;
        console.log('Overflow check 1 (calculatedValue >= amountValue):', overflowCheck1);
        console.log('Overflow check 2 (priceValue >= priceMultiplier):', overflowCheck2);
        console.log('Overflow check passes:', overflowCheckPass);
        if (expectedValue === 0n) {
          console.log('*** WARNING: Expected calculated value is 0! This will cause revert ***');
        }
        if (!overflowCheckPass) {
          console.log('*** WARNING: Overflow check will fail! This will cause revert ***');
        }
      } catch (priceErr: any) {
        console.log('Error getting price:', priceErr.message);
      }

      try {
        // First try to simulate the call to get revert reason
        try {
          const iface = new ethers.Interface(['function borrow(address,address,uint256,uint256,uint16)']);
          const data = iface.encodeFunctionData('borrow', [user.address, debtAsset, 50, 0, 0]);
          const result = await ethers.provider.call({
            to: await lending.getAddress(),
            from: await vaultCoreModule.getAddress(),
            data: data,
          });
          console.log('Simulated call succeeded, result:', result);
        } catch (simError: any) {
          console.log('\n=== Simulated Call Error ===');
          console.log('Error:', simError.message);
          console.log('Error data:', simError.data);
          if (simError.data && simError.data !== '0x' && simError.data.length > 2) {
            const reason = simError.data.slice(2);
            // Check if it's a string error (starts with 08c379a0 for Error(string))
            if (reason.startsWith('08c379a0')) {
              try {
                const offset = parseInt(reason.slice(8, 72), 16);
                const length = parseInt(reason.slice(72, 136), 16);
                const errorString = ethers.toUtf8String('0x' + reason.slice(136, 136 + length * 2));
                console.log('String revert reason:', errorString);
              } catch (decodeErr) {
                console.log('Could not decode string error');
              }
            } else {
              console.log('Raw error data (hex):', reason);
              console.log('Error data length:', reason.length);
            }
          } else {
            console.log('No error data or data is 0x - this is a low-level revert (assert/address(0) call)');
          }
        }

        // Try to execute borrow and trace if it fails
        let tx;
        try {
          tx = await vaultCoreModule.borrow(user.address, debtAsset, 50, 0, 0);
          await tx.wait();
          console.log('Borrow succeeded!');
        } catch (borrowError: any) {
          console.log('\n=== Borrow Failed, Attempting Trace ===');
          console.log('Error:', borrowError.message);
          
          // If we have a transaction hash, try to trace it
          if (borrowError.transactionHash) {
            try {
              const trace = await ethers.provider.send("debug_traceTransaction", [
                borrowError.transactionHash,
                { disableStorage: true, disableStack: false, enableMemory: true }
              ]);
              console.log('\n=== Transaction Trace ===');
              console.log('Trace length:', trace.structLogs?.length || 0);
              
              // Find the REVERT opcode
              const revertOps = trace.structLogs?.filter((log: any) => log.op === 'REVERT' || log.op === 'INVALID') || [];
              console.log('Found', revertOps.length, 'REVERT/INVALID operations');
              
              if (revertOps.length > 0) {
                const firstRevert = revertOps[0];
                const revertIndex = trace.structLogs?.findIndex((log: any) => log === firstRevert) || -1;
                console.log('First REVERT at index:', revertIndex);
                
                // Show context around revert (last 50 operations before revert to find CALL)
                if (revertIndex >= 0 && trace.structLogs) {
                  const start = Math.max(0, revertIndex - 50);
                  const end = Math.min(trace.structLogs.length, revertIndex + 5);
                  console.log('\n=== Context around REVERT (ops', start, 'to', end, ') ===');
                  
                  // First, find all CALL operations before revert
                  const callsBeforeRevert: any[] = [];
                  for (let i = start; i < revertIndex; i++) {
                    const log = trace.structLogs[i];
                    if (log.op === 'CALL' || log.op === 'STATICCALL' || log.op === 'DELEGATECALL') {
                      callsBeforeRevert.push({ index: i, log });
                    }
                  }
                  
                  if (callsBeforeRevert.length > 0) {
                    console.log('\n=== CALL operations before REVERT ===');
                    callsBeforeRevert.forEach(({ index, log }) => {
                      console.log(`[${index}] ${log.op} at PC ${log.pc}`);
                      if (log.stack && log.stack.length >= 7) {
                        const toAddress = '0x' + log.stack[log.stack.length - 2].slice(-40).toLowerCase();
                        console.log('  To address:', toAddress);
                        if (toAddress === '0x0000000000000000000000000000000000000000') {
                          console.log('  *** CALL to address(0) detected! ***');
                        }
                        // Show function selector if available
                        if (log.stack.length >= 6) {
                          const dataOffset = log.stack[log.stack.length - 4];
                          console.log('  Data offset:', dataOffset);
                        }
                      }
                    });
                  }
                  
                  // Show operations around revert
                  for (let i = Math.max(0, revertIndex - 20); i < end; i++) {
                    const log = trace.structLogs[i];
                    const stackTop = log.stack?.slice(-3) || [];
                    if (log.op === 'REVERT' || log.op === 'INVALID') {
                      console.log(`[${i}] ${log.op} at PC ${log.pc}`);
                      console.log('  Stack:', log.stack?.slice(-5));
                      console.log('  Memory:', log.memory?.slice(-3));
                    } else if (log.op === 'SLT' || log.op === 'SGT' || log.op === 'LT' || log.op === 'GT' || log.op === 'EQ' || log.op === 'ISZERO') {
                      console.log(`[${i}] ${log.op} at PC ${log.pc}, stack top:`, stackTop);
                    }
                  }
                }
              }
            } catch (traceErr: any) {
              console.log('Trace error:', traceErr.message);
            }
          } else if (borrowError.transaction) {
            // Try to get transaction hash from transaction object
            try {
              const txHash = borrowError.transaction.hash || (await borrowError.transaction.getHash?.());
              if (txHash) {
                const trace = await ethers.provider.send("debug_traceTransaction", [
                  txHash,
                  { disableStorage: true, disableStack: false, enableMemory: true }
                ]);
                console.log('\n=== Transaction Trace (from transaction object) ===');
                console.log('Trace length:', trace.structLogs?.length || 0);
              }
            } catch (traceErr2: any) {
              console.log('Trace error (from transaction object):', traceErr2.message);
            }
          }
          
          // Re-throw to fail the test
          throw borrowError;
        }
      } catch (error: any) {
        console.log('\n=== Detailed Error Information ===');
        console.log('Error message:', error.message);
        console.log('Error reason:', error.reason);
        console.log('Error code:', error.code);
        console.log('Error data:', error.data);
        if (error.transaction) {
          console.log('Transaction hash:', error.transaction.hash);
          try {
            const receipt = await ethers.provider.getTransactionReceipt(error.transaction.hash);
            console.log('Transaction receipt status:', receipt?.status);
            if (receipt && receipt.status === 0) {
              console.log('Transaction reverted');
              // Try to get revert reason using trace
              try {
                const tx = await ethers.provider.getTransaction(receipt.hash);
                const trace = await ethers.provider.send('debug_traceTransaction', [receipt.hash, {}]);
                console.log('Transaction trace available');
              } catch (traceErr: any) {
                console.log('Trace error:', traceErr.message);
              }
            }
          } catch (receiptErr: any) {
            console.log('Receipt error:', receiptErr.message);
          }
        }
        // Try to decode error data
        if (error.data && error.data !== '0x') {
          console.log('Attempting to decode error data:', error.data);
          try {
            const iface = new ethers.Interface([
              'error VaultLendingEngine__OnlyVaultCore()',
              'error ZeroAddress()',
              'error AmountIsZero()',
            ]);
            const decoded = iface.parseError(error.data);
            console.log('Decoded error:', decoded.name);
          } catch (decodeErr: any) {
            console.log('Could not decode as custom error');
          }
        }
        console.log('Full error object:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
        
        // Try to get transaction trace if available
        if (error.transactionHash) {
          console.log('\n=== Attempting to get transaction trace ===');
          try {
            const trace = await ethers.provider.send('debug_traceTransaction', [error.transactionHash, {}]);
            // Look for REVERT opcode in trace
            if (Array.isArray(trace.structLogs)) {
              const revertOps = trace.structLogs.filter((log: any) => log.op === 'REVERT' || log.op === 'INVALID');
              if (revertOps.length > 0) {
                console.log(`Found ${revertOps.length} REVERT/INVALID operations`);
                // Get context around the revert
                const revertIndex = trace.structLogs.findIndex((log: any) => log.op === 'REVERT' || log.op === 'INVALID');
                if (revertIndex >= 0) {
                  const start = Math.max(0, revertIndex - 50);
                  const end = Math.min(trace.structLogs.length, revertIndex + 5);
                  console.log('Context around revert (ops ' + start + ' to ' + end + '):');
                  let callToZeroFound = false;
                  let lastCallOp = -1;
                  for (let i = start; i < end; i++) {
                    const log = trace.structLogs[i];
                    // Look for CALL operations
                    if (log.op === 'CALL' && log.stack && log.stack.length >= 7) {
                      lastCallOp = i;
                      const toAddress = '0x' + log.stack[log.stack.length - 2].slice(-40).toLowerCase();
                      console.log(`    [${i}] CALL at PC ${log.pc}, to address: ${toAddress}`);
                      if (toAddress === '0x0000000000000000000000000000000000000000') {
                        console.log(`    *** CALL to address(0) found at [${i}] PC ${log.pc} ***`);
                        callToZeroFound = true;
                        // Show context before this CALL
                        const callStart = Math.max(start, i - 15);
                        console.log(`    Context before CALL (ops ${callStart} to ${i}):`);
                        for (let j = callStart; j <= i; j++) {
                          const prevLog = trace.structLogs[j];
                          if (prevLog.op === 'CALL' || prevLog.op === 'STATICCALL' || prevLog.op === 'DELEGATECALL') {
                            console.log(`      [${j}] ${prevLog.op} at PC ${prevLog.pc}`);
                          }
                        }
                      }
                    }
                    // Look for STATICCALL operations (used for view functions)
                    if (log.op === 'STATICCALL' && log.stack && log.stack.length >= 6) {
                      const toAddress = '0x' + log.stack[log.stack.length - 2].slice(-40).toLowerCase();
                      if (toAddress === '0x0000000000000000000000000000000000000000') {
                        console.log(`    *** STATICCALL to address(0) found at [${i}] PC ${log.pc} ***`);
                        callToZeroFound = true;
                      }
                    }
                    if (log.op === 'REVERT' || log.op === 'INVALID') {
                      console.log(`    *** REVERT FOUND at [${i}] PC ${log.pc} ***`);
                      if (log.stack && log.stack.length > 0) {
                        console.log('    Stack (last 5):', log.stack.slice(-5));
                        // Check if stack contains address(0)
                        const hasZeroAddress = log.stack.some((val: string) => 
                          val.toLowerCase() === '0000000000000000000000000000000000000000000000000000000000000000'
                        );
                        if (hasZeroAddress) {
                          console.log('    *** WARNING: Stack contains address(0) ***');
                        }
                      }
                      // Show the last few operations before revert
                      console.log('    Last 10 operations before REVERT:');
                      for (let j = Math.max(start, i - 10); j < i; j++) {
                        const prevLog = trace.structLogs[j];
                        console.log(`      [${j}] ${prevLog.op} at PC ${prevLog.pc}`);
                      }
                    }
                  }
                  if (!callToZeroFound) {
                    console.log('    No CALL/STATICCALL to address(0) found before revert');
                    if (lastCallOp >= 0) {
                      console.log(`    Last CALL operation was at [${lastCallOp}]`);
                    }
                  }
                }
              } else {
                console.log('No REVERT opcode found in trace');
              }
            }
          } catch (traceErr: any) {
            console.log('Could not get trace:', traceErr.message);
          }
        }
        
        throw error;
      }

      expect(await lending.getDebt(user.address, debtAsset)).to.equal(50);
      expect(await lending.getTotalDebtByAsset(debtAsset)).to.equal(50);
      // HealthView should receive an update (health factor > 0)
      expect(await healthView.getUserHealthFactor(user.address)).to.be.gt(0);
      // VaultView updated via pushUserPositionUpdate
      expect(await vaultView.getUserDebt(user.address, debtAsset)).to.equal(50);
      // Collateral unchanged in cm, debt recorded in ledger
      expect(await cm.getUserTotalCollateralValue(user.address)).to.equal(200);
    });

    it('repay should reduce debt and push view/health', async function () {
      const { vaultCoreModule, user, lending, cm, healthView, vaultView, debtAsset } = await loadFixture(deployFixture);
      try {
        await vaultCoreModule.borrow(user.address, debtAsset, 30, 0, 0);
      } catch (error: any) {
        console.log('\n=== Borrow Error in repay test ===');
        console.log('Error:', error.message);
        console.log('Data:', error.data);
        throw error;
      }
      try {
        await vaultCoreModule.repay(user.address, debtAsset, 10);
      } catch (error: any) {
        console.log('\n=== Repay Error ===');
        console.log('Error:', error.message);
        console.log('Data:', error.data);
        throw error;
      }

      expect(await lending.getDebt(user.address, debtAsset)).to.equal(20);
      expect(await lending.getTotalDebtByAsset(debtAsset)).to.equal(20);
      expect(await healthView.getUserHealthFactor(user.address)).to.be.gt(0);
      expect(await vaultView.getUserDebt(user.address, debtAsset)).to.equal(20);
      expect(await cm.getUserTotalCollateralValue(user.address)).to.equal(200);
    });

    it('should handle multiple borrows and repays correctly', async function () {
      const { vaultCoreModule, user, lending, debtAsset } = await loadFixture(deployFixture);
      
      await vaultCoreModule.borrow(user.address, debtAsset, 30, 0, 0);
      expect(await lending.getDebt(user.address, debtAsset)).to.equal(30);
      
      await vaultCoreModule.borrow(user.address, debtAsset, 20, 0, 0);
      expect(await lending.getDebt(user.address, debtAsset)).to.equal(50);
      expect(await lending.getTotalDebtByAsset(debtAsset)).to.equal(50);
      
      await vaultCoreModule.repay(user.address, debtAsset, 15);
      expect(await lending.getDebt(user.address, debtAsset)).to.equal(35);
      expect(await lending.getTotalDebtByAsset(debtAsset)).to.equal(35);
      
      await vaultCoreModule.repay(user.address, debtAsset, 35);
      expect(await lending.getDebt(user.address, debtAsset)).to.equal(0);
      expect(await lending.getTotalDebtByAsset(debtAsset)).to.equal(0);
    });

    it('should track total debt value correctly', async function () {
      const { vaultCoreModule, user, lending, debtAsset } = await loadFixture(deployFixture);
      
      const initialTotal = await lending.getTotalDebtValue();
      await vaultCoreModule.borrow(user.address, debtAsset, 50, 0, 0);
      
      const afterBorrow = await lending.getTotalDebtValue();
      expect(afterBorrow).to.be.gt(initialTotal);
      
      await vaultCoreModule.repay(user.address, debtAsset, 30);
      const afterRepay = await lending.getTotalDebtValue();
      expect(afterRepay).to.be.lt(afterBorrow);
    });

    it('should support multiple debt assets per user', async function () {
      const { vaultCoreModule, vaultCore, user, lending, debtAsset, priceOracle } = await loadFixture(deployFixture);
      const debtAsset2 = ethers.Wallet.createRandom().address;

      const nowTs = Math.floor(Date.now() / 1000);
      await priceOracle.connect(vaultCore).setPrice(debtAsset2, ethers.parseEther('1'), nowTs, 18);

      await vaultCoreModule.borrow(user.address, debtAsset, 30, 0, 0);
      await vaultCoreModule.borrow(user.address, debtAsset2, 20, 0, 0);

      expect(await lending.getDebt(user.address, debtAsset)).to.equal(30);
      expect(await lending.getDebt(user.address, debtAsset2)).to.equal(20);
      expect(await lending.getTotalDebtByAsset(debtAsset)).to.equal(30);
      expect(await lending.getTotalDebtByAsset(debtAsset2)).to.equal(20);

      const assets = await lending.getUserDebtAssets(user.address);
      expect(assets.length).to.equal(2);
      expect(assets).to.include(debtAsset);
      expect(assets).to.include(debtAsset2);
    });
  });

  describe('forceReduceDebt (liquidation path)', function () {
    it('should revert without ACTION_LIQUIDATE role', async function () {
      const { vaultCoreModule, user, lending, debtAsset, acm } = await loadFixture(deployFixture);
      await vaultCoreModule.borrow(user.address, debtAsset, 15, 0, 0);
      await expect(
        lending.forceReduceDebt(user.address, debtAsset, 5)
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('should reduce debt, push view/health with proper role', async function () {
      const { vaultCoreModule, liquidator, lending, cm, healthView, vaultView, debtAsset } = await loadFixture(deployFixture);
      await vaultCoreModule.borrow(liquidator.address, debtAsset, 40, 0, 0);

      await lending.connect(liquidator).forceReduceDebt(liquidator.address, debtAsset, 25);

      expect(await lending.getDebt(liquidator.address, debtAsset)).to.equal(15);
      expect(await cm.getUserTotalCollateralValue(liquidator.address)).to.equal(0); // liquidator had no collateral seeded
      expect(await vaultView.getUserDebt(liquidator.address, debtAsset)).to.equal(15);
      expect(await healthView.getUserHealthFactor(liquidator.address)).to.be.gte(0);
    });

    it('should cap reduction to current debt amount', async function () {
      const { vaultCoreModule, liquidator, lending, debtAsset } = await loadFixture(deployFixture);
      await vaultCoreModule.borrow(liquidator.address, debtAsset, 40, 0, 0);

      // Try to reduce more than debt
      await lending.connect(liquidator).forceReduceDebt(liquidator.address, debtAsset, 100);

      // Should only reduce to 0, not go negative
      expect(await lending.getDebt(liquidator.address, debtAsset)).to.equal(0);
      expect(await lending.getTotalDebtByAsset(debtAsset)).to.equal(0);
    });

    it('should update total debt by asset on liquidation', async function () {
      const { vaultCoreModule, liquidator, lending, debtAsset } = await loadFixture(deployFixture);
      await vaultCoreModule.borrow(liquidator.address, debtAsset, 50, 0, 0);
      expect(await lending.getTotalDebtByAsset(debtAsset)).to.equal(50);

      await lending.connect(liquidator).forceReduceDebt(liquidator.address, debtAsset, 30);
      expect(await lending.getTotalDebtByAsset(debtAsset)).to.equal(20);
    });
  });

  describe('edge cases and error handling', function () {
    it('should revert borrow with zero amount', async function () {
      const { vaultCoreModule, lending, user, debtAsset } = await loadFixture(deployFixture);
      await expect(
        vaultCoreModule.borrow(user.address, debtAsset, 0, 0, 0)
      ).to.be.revertedWithCustomError(lending, 'AmountIsZero');
    });

    it('should revert repay with zero amount', async function () {
      const { vaultCoreModule, lending, user, debtAsset } = await loadFixture(deployFixture);
      await vaultCoreModule.borrow(user.address, debtAsset, 30, 0, 0);
      await expect(
        vaultCoreModule.repay(user.address, debtAsset, 0)
      ).to.be.revertedWithCustomError(lending, 'AmountIsZero');
    });

    it('should revert repay exceeding debt', async function () {
      const { vaultCoreModule, lending, user, debtAsset } = await loadFixture(deployFixture);
      await vaultCoreModule.borrow(user.address, debtAsset, 30, 0, 0);
      await expect(
        vaultCoreModule.repay(user.address, debtAsset, 50)
      ).to.be.revertedWithCustomError(lending, 'Overpay');
    });

    it('should revert forceReduceDebt with zero amount', async function () {
      const { vaultCoreModule, liquidator, lending, debtAsset } = await loadFixture(deployFixture);
      await vaultCoreModule.borrow(liquidator.address, debtAsset, 30, 0, 0);
      await expect(
        lending.connect(liquidator).forceReduceDebt(liquidator.address, debtAsset, 0)
      ).to.be.revertedWithCustomError(lending, 'AmountIsZero');
    });

    it('should handle full repayment correctly', async function () {
      const { vaultCoreModule, user, lending, debtAsset } = await loadFixture(deployFixture);
      await vaultCoreModule.borrow(user.address, debtAsset, 30, 0, 0);
      
      await vaultCoreModule.repay(user.address, debtAsset, 30);
      
      expect(await lending.getDebt(user.address, debtAsset)).to.equal(0);
      expect(await lending.getTotalDebtByAsset(debtAsset)).to.equal(0);
      
      // Asset should be removed from user debt assets list
      const assets = await lending.getUserDebtAssets(user.address);
      expect(assets.length).to.equal(0);
    });

    it('should handle full liquidation correctly', async function () {
      const { vaultCoreModule, liquidator, lending, debtAsset } = await loadFixture(deployFixture);
      await vaultCoreModule.borrow(liquidator.address, debtAsset, 30, 0, 0);
      
      await lending.connect(liquidator).forceReduceDebt(liquidator.address, debtAsset, 30);
      
      expect(await lending.getDebt(liquidator.address, debtAsset)).to.equal(0);
      expect(await lending.getTotalDebtByAsset(debtAsset)).to.equal(0);
      
      // Asset should be removed from user debt assets list
      const assets = await lending.getUserDebtAssets(liquidator.address);
      expect(assets.length).to.equal(0);
    });
  });

  describe('view and health status updates', function () {
    it('should push position update to VaultView on borrow', async function () {
      const { vaultCoreModule, user, vaultView, debtAsset, cm } = await loadFixture(deployFixture);
      
      await expect(
        vaultCoreModule.borrow(user.address, debtAsset, 50, 0, 0)
      ).to.emit(vaultView, 'UserPositionUpdated')
        .withArgs(user.address, debtAsset, 200, 50); // collateral: 200, debt: 50
    });

    it('should push position update to VaultView on repay', async function () {
      const { vaultCoreModule, user, vaultView, debtAsset } = await loadFixture(deployFixture);
      await vaultCoreModule.borrow(user.address, debtAsset, 50, 0, 0);
      
      await expect(
        vaultCoreModule.repay(user.address, debtAsset, 20)
      ).to.emit(vaultView, 'UserPositionUpdated')
        .withArgs(user.address, debtAsset, 200, 30); // collateral: 200, debt: 30
    });

    it('should push health status on borrow', async function () {
      const { vaultCoreModule, user, healthView, debtAsset } = await loadFixture(deployFixture);
      const beforeHF = await healthView.getUserHealthFactor(user.address);
      await vaultCoreModule.borrow(user.address, debtAsset, 50, 0, 0);
      const afterHF = await healthView.getUserHealthFactor(user.address);
      expect(afterHF).to.not.equal(beforeHF);
    });

    it('should push health status on repay', async function () {
      const { vaultCoreModule, user, healthView, debtAsset } = await loadFixture(deployFixture);
      await vaultCoreModule.borrow(user.address, debtAsset, 50, 0, 0);
      
      const beforeHF = await healthView.getUserHealthFactor(user.address);
      
      await vaultCoreModule.repay(user.address, debtAsset, 20);
      
      const afterHF = await healthView.getUserHealthFactor(user.address);
      expect(afterHF).to.not.equal(beforeHF);
      // Health should improve after repay
      expect(afterHF).to.be.gt(beforeHF);
    });

    it('should push health status on liquidation', async function () {
      const { vaultCoreModule, liquidator, lending, healthView, cm, debtAsset } = await loadFixture(deployFixture);
      // Add collateral to liquidator so health factor is meaningful
      await cm.depositCollateral(liquidator.address, debtAsset, 200);
      await vaultCoreModule.borrow(liquidator.address, debtAsset, 50, 0, 0);
      
      const beforeHF = await healthView.getUserHealthFactor(liquidator.address);
      
      await lending.connect(liquidator).forceReduceDebt(liquidator.address, debtAsset, 30);
      
      const afterHF = await healthView.getUserHealthFactor(liquidator.address);
      expect(afterHF).to.not.equal(beforeHF);
    });
  });

  describe('events', function () {
    it('should emit DebtRecorded on borrow', async function () {
      const { vaultCoreModule, user, lending, debtAsset } = await loadFixture(deployFixture);
      
      await expect(
        vaultCoreModule.borrow(user.address, debtAsset, 50, 0, 0)
      ).to.emit(lending, 'DebtRecorded')
        .withArgs(user.address, debtAsset, 50, true);
    });

    it('should emit DebtRecorded on repay', async function () {
      const { vaultCoreModule, user, lending, debtAsset } = await loadFixture(deployFixture);
      await vaultCoreModule.borrow(user.address, debtAsset, 50, 0, 0);
      
      await expect(
        vaultCoreModule.repay(user.address, debtAsset, 20)
      ).to.emit(lending, 'DebtRecorded')
        .withArgs(user.address, debtAsset, 20, false);
    });

    it('should emit DebtRecorded on liquidation', async function () {
      const { vaultCoreModule, liquidator, lending, debtAsset } = await loadFixture(deployFixture);
      await vaultCoreModule.borrow(liquidator.address, debtAsset, 50, 0, 0);
      
      await expect(
        lending.connect(liquidator).forceReduceDebt(liquidator.address, debtAsset, 30)
      ).to.emit(lending, 'DebtRecorded')
        .withArgs(liquidator.address, debtAsset, 30, false);
    });

    it('should emit UserTotalDebtValueUpdated on borrow', async function () {
      const { vaultCoreModule, user, lending, debtAsset } = await loadFixture(deployFixture);
      
      await expect(
        vaultCoreModule.borrow(user.address, debtAsset, 50, 0, 0)
      ).to.emit(lending, 'UserTotalDebtValueUpdated')
        .withArgs(user.address, BigInt(0), (value: bigint) => value > BigInt(0));
    });

    it('should emit UserTotalDebtValueUpdated on repay', async function () {
      const { vaultCoreModule, user, lending, debtAsset } = await loadFixture(deployFixture);
      await vaultCoreModule.borrow(user.address, debtAsset, 50, 0, 0);
      
      const beforeValue = await lending.getUserTotalDebtValue(user.address);
      
      await expect(
        vaultCoreModule.repay(user.address, debtAsset, 20)
      ).to.emit(lending, 'UserTotalDebtValueUpdated')
        .withArgs(user.address, beforeValue, (value: bigint) => value < beforeValue);
    });
  });
});

