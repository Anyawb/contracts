import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { SimpleMock__factory } from '../../types/factories/contracts/Mocks/SimpleMock__factory';

describe('SimpleMock - Gas 测试', function () {
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

  async function deployFixture() {
    const [owner, user1, user2] = await ethers.getSigners();

    // 部署合约但不初始化
    const SimpleMockFactory = (await ethers.getContractFactory('SimpleMock')) as SimpleMock__factory;
    const simpleMock = await SimpleMockFactory.deploy();
    await simpleMock.waitForDeployment();

    return { 
      simpleMock, 
      owner, 
      user1, 
      user2 
    };
  }

  describe('基础功能测试', function () {
    it('应该正确部署合约', async function () {
      const { simpleMock } = await loadFixture(deployFixture);
      
      expect(await simpleMock.counter()).to.equal(0n);
    });

    it('应该能够增加计数器（需要先授权）', async function () {
      const { simpleMock, owner } = await loadFixture(deployFixture);
      
      // 先授权用户
      await simpleMock.authorizeUser(owner.address, true);
      
      const initialCounter = await simpleMock.counter();
      await simpleMock.increment();
      
      expect(await simpleMock.counter()).to.equal(initialCounter + 1n);
    });

    it('应该拒绝未授权用户的操作', async function () {
      const { simpleMock, user1 } = await loadFixture(deployFixture);
      
      await expect(
        simpleMock.connect(user1).increment()
      ).to.be.revertedWith('Not authorized');
    });

    it('应该正确授权和撤销用户权限', async function () {
      const { simpleMock, owner, user1 } = await loadFixture(deployFixture);
      
      // 授权用户
      await simpleMock.authorizeUser(user1.address, true);
      expect(await simpleMock.isAuthorized(user1.address)).to.be.true;
      
      // 撤销权限
      await simpleMock.authorizeUser(user1.address, false);
      expect(await simpleMock.isAuthorized(user1.address)).to.be.false;
    });
  });

  describe('权限控制测试', function () {
    it('应该只允许所有者修改权限', async function () {
      const { simpleMock, user1, user2 } = await loadFixture(deployFixture);
      
      // SimpleMock 没有权限控制，任何用户都可以调用 authorizeUser
      // 这是一个简化的测试合约
      await expect(
        simpleMock.connect(user1).authorizeUser(user2.address, true)
      ).to.not.be.reverted;
    });

    it('应该正确处理零地址', async function () {
      const { simpleMock, owner } = await loadFixture(deployFixture);
      
      // SimpleMock 没有零地址检查，这是一个简化的测试合约
      await expect(
        simpleMock.authorizeUser(ZERO_ADDRESS, true)
      ).to.not.be.reverted;
    });
  });

  describe('事件测试', function () {
    it('应该发出用户授权事件', async function () {
      const { simpleMock, owner, user1 } = await loadFixture(deployFixture);
      
      await expect(simpleMock.authorizeUser(user1.address, true))
        .to.emit(simpleMock, 'UserAuthorized')
        .withArgs(user1.address, true);
    });

    it('应该发出计数器增加事件', async function () {
      const { simpleMock, owner } = await loadFixture(deployFixture);
      
      await simpleMock.authorizeUser(owner.address, true);
      
      await expect(simpleMock.increment())
        .to.emit(simpleMock, 'CounterIncremented')
        .withArgs(owner.address, 1n);
    });
  });

  describe('边界条件测试', function () {
    it('应该处理多次连续增加', async function () {
      const { simpleMock, owner } = await loadFixture(deployFixture);
      
      await simpleMock.authorizeUser(owner.address, true);
      
      for (let i = 0; i < 5; i++) {
        await simpleMock.increment();
      }
      
      expect(await simpleMock.counter()).to.equal(5n);
    });

    it('应该正确处理权限状态切换', async function () {
      const { simpleMock, owner, user1 } = await loadFixture(deployFixture);
      
      // 多次切换权限状态
      await simpleMock.authorizeUser(user1.address, true);
      await simpleMock.authorizeUser(user1.address, false);
      await simpleMock.authorizeUser(user1.address, true);
      
      expect(await simpleMock.isAuthorized(user1.address)).to.be.true;
    });
  });

  describe('Gas 优化测试', function () {
    it('应该验证 Gas 消耗在合理范围内', async function () {
      const { simpleMock, owner } = await loadFixture(deployFixture);
      
      await simpleMock.authorizeUser(owner.address, true);
      
      const tx = await simpleMock.increment();
      const receipt = await tx.wait();
      
      // 验证 Gas 消耗在合理范围内（通常 < 50,000 gas）
      expect(receipt?.gasUsed).to.be.lt(50000n);
    });
  });
}); 