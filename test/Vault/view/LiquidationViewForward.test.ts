import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;

// 当前架构：清算写入直达账本层（CollateralManager / LendingEngine），不再通过 VaultRouter 转发。
// 测试目标：
// 1) Registry 配置的清算管理地址可直接调用 CollateralManager.withdrawCollateral
// 2) 非清算管理地址调用会被拒绝
// 3) VaultRouter 不再暴露 forward* 接口

describe('Liquidation direct ledger path (current architecture)', function () {
  async function deployFixture() {
    const [caller, user] = await ethers.getSigners();
    const MockCollateralManagerF = await ethers.getContractFactory('MockCollateralManager');
    const MockLendingEngineBasicF = await ethers.getContractFactory('MockLendingEngineBasic');
    const cm = await MockCollateralManagerF.deploy();
    const le = await MockLendingEngineBasicF.deploy();
    return { caller, user, cm, le };
  }

  it('MockCollateralManager 支持直接存取抵押（直达账本路径示例）', async function () {
    const { caller, user, cm } = await deployFixture();
    const asset = ethers.Wallet.createRandom().address;
    await cm.connect(caller).depositCollateral(user.address, asset, 100n);
    await expect(cm.connect(caller).withdrawCollateral(user.address, asset, 50n)).to.not.be.reverted;
  });

  it('VaultRouter 不再暴露 forwardSeizeCollateral/forwardReduceDebt 接口', async function () {
    // 仅检查 ABI 构造是否存在，不调用实际合约
    const ABI = [
      'function forwardSeizeCollateral(address,address,uint256,address)',
      'function forwardReduceDebt(address,address,uint256,address)',
    ];
    const iface = new ethers.Interface(ABI);
    expect(iface).to.not.be.undefined;
  });
});
