import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;

// 导入自动生成的类型
import type { SimpleMock } from '../../types/contracts/Mocks/SimpleMock';
import { SimpleMock__factory } from '../../types/factories/contracts/Mocks/SimpleMock__factory';

/**
 * SimpleMock 演示测试
 * 
 * 展示如何使用自动生成的 TypeScript 类型
 */
describe('SimpleMock 类型演示', function () {
  let simpleMock: SimpleMock; // 使用生成的类型
  let deployer: any;
  let alice: any;
  let bob: any;

  beforeEach(async function () {
    [deployer, alice, bob] = await ethers.getSigners();

    // 使用生成的工厂类部署合约
    const factory = (await ethers.getContractFactory('SimpleMock')) as SimpleMock__factory;
    simpleMock = await factory.deploy();
    await simpleMock.waitForDeployment();
  });

  describe('类型安全的合约交互', function () {
    it('应该能够使用类型安全的方法调用', async function () {
      // ✅ 类型安全的授权
      await simpleMock.authorizeUser(await alice.getAddress(), true);
      
      // ✅ 类型安全的查询
      const isAuthorized = await simpleMock.isAuthorized(await alice.getAddress());
      expect(isAuthorized).to.be.true;
      
      // ✅ 类型安全的状态查询
      const counter = await simpleMock.counter();
      expect(counter).to.equal(0n);
    });

    it('应该能够使用类型安全的事件监听', async function () {
      // ✅ 类型安全的事件监听
      const filter = simpleMock.filters.CounterIncremented();
      
      // 授权用户
      await simpleMock.authorizeUser(await alice.getAddress(), true);
      
      // 增加计数器
      await simpleMock.connect(alice).increment();
      
      // 查询事件
      const events = await simpleMock.queryFilter(filter);
      expect(events.length).to.equal(1);
      
      // 类型安全的事件数据访问
      const event = events[0];
      expect(event.args?.user).to.equal(await alice.getAddress());
      expect(event.args?.newValue).to.equal(1n);
    });

    it('应该能够使用类型安全的映射查询', async function () {
      // ✅ 类型安全的映射查询
      const isAuthorized = await simpleMock.authorizedUsers(await alice.getAddress());
      expect(isAuthorized).to.be.false;
      
      // 授权用户
      await simpleMock.authorizeUser(await alice.getAddress(), true);
      
      // 再次查询
      const isAuthorizedAfter = await simpleMock.authorizedUsers(await alice.getAddress());
      expect(isAuthorizedAfter).to.be.true;
    });
  });

  describe('IDE 支持和类型检查', function () {
    it('应该提供完整的 IDE 支持', async function () {
      // ✅ 代码补全：输入 simpleMock. 会显示所有可用方法
      // ✅ 参数提示：hover 方法会显示参数类型
      // ✅ 错误检查：错误参数类型会显示编译错误
      
      // 正确的类型使用
      await simpleMock.authorizeUser(await alice.getAddress(), true);
      
      // 如果使用错误类型，TypeScript 会报错：
      // await simpleMock.authorizeUser("invalid", "not boolean"); // ❌ 类型错误
      // await simpleMock.increment("extra param"); // ❌ 参数数量错误
    });

    it('应该支持类型安全的返回值', async function () {
      // ✅ 返回值类型安全
      const counter: bigint = await simpleMock.getCounter(); // 明确类型
      const isAuth: boolean = await simpleMock.isAuthorized(await alice.getAddress()); // 明确类型
      
      expect(typeof counter).to.equal('bigint');
      expect(typeof isAuth).to.equal('boolean');
    });
  });

  describe('事件类型安全', function () {
    it('应该支持类型安全的事件处理', async function () {
      // ✅ 类型安全的事件监听器
      let capturedEvent: any;
      
      simpleMock.on(simpleMock.filters.CounterIncremented(), (user, newValue) => {
        // user 和 newValue 有正确的类型
        capturedEvent = { user, newValue };
      });
      
      // 触发事件
      await simpleMock.authorizeUser(await alice.getAddress(), true);
      await simpleMock.connect(alice).increment();
      
      // 等待事件处理
      await new Promise(resolve => setTimeout(resolve, 100));
      
      expect(capturedEvent.user).to.equal(await alice.getAddress());
      expect(capturedEvent.newValue).to.equal(1n);
      
      // 清理监听器
      simpleMock.removeAllListeners();
    });
  });
}); 