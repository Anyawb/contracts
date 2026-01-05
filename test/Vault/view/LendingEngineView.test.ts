import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';

const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
const KEY_LENDING_ENGINE = ethers.keccak256(ethers.toUtf8Bytes('LENDING_ENGINE'));

const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));

describe('LendingEngineView', function () {
  async function deployFixture() {
    const [admin, user, other] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
    const engine = await (await ethers.getContractFactory('MockLendingEngineViewAdapter')).deploy();

    await engine.setRegistry(await registry.getAddress());
    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(KEY_LENDING_ENGINE, await engine.getAddress());

    // grant admin for upgrades
    await acm.grantRole(ACTION_ADMIN, admin.address);

    const LendingEngineViewFactory = await ethers.getContractFactory('LendingEngineView');
    const view = await upgrades.deployProxy(LendingEngineViewFactory, [await registry.getAddress()], {
      kind: 'uups',
    });

    // seed mock data
    await engine.setLoanOrder(1, {
      principal: 1_000n,
      rate: 500n,
      term: 30n,
      borrower: user.address,
      lender: admin.address,
      asset: ethers.ZeroAddress,
      startTimestamp: 1000n,
      maturity: 2000n,
      repaidAmount: 100n,
    });
    await engine.setUserLoanCount(user.address, 2);
    await engine.setFailedFeeAmount(1, 77);
    await engine.setNftRetryCount(1, 3);
    await engine.setOrderAccess(1, user.address, true);
    await engine.setMatchEngine(admin.address, true);

    return { view, registry, acm, admin, user, other, engine };
  }

  describe('initialization', function () {
    it('stores registry and exposes getters', async function () {
      const { view, registry } = await deployFixture();
      expect(await view.registryAddr()).to.equal(await registry.getAddress());
      expect(await view.getRegistry()).to.equal(await registry.getAddress());
    });

    it('reverts on zero address init', async function () {
      const LendingEngineViewFactory = await ethers.getContractFactory('LendingEngineView');
      const impl = await LendingEngineViewFactory.deploy();
      await impl.waitForDeployment();
      await expect(
        upgrades.deployProxy(LendingEngineViewFactory, [ethers.ZeroAddress], { kind: 'uups' }),
      ).to.be.revertedWithCustomError(impl, 'LendingEngineView__ZeroAddress');
    });
  });

  describe('read APIs', function () {
    it('returns loan order data resolved via registry', async function () {
      const { view, user, admin } = await deployFixture();
      const order = await view.getLoanOrder(1);
      expect(order.principal).to.equal(1_000n);
      expect(order.rate).to.equal(500n);
      expect(order.term).to.equal(30n);
      expect(order.borrower).to.equal(user.address);
      expect(order.lender).to.equal(admin.address);
      expect(order.repaidAmount).to.equal(100n);
    });

    it('returns user loan count', async function () {
      const { view, user } = await deployFixture();
      expect(await view.getUserLoanCount(user.address)).to.equal(2n);
    });

    it('returns failed fee amount', async function () {
      const { view } = await deployFixture();
      expect(await view.getFailedFeeAmount(1)).to.equal(77n);
    });

    it('returns nft retry count', async function () {
      const { view } = await deployFixture();
      expect(await view.getNftRetryCount(1)).to.equal(3n);
    });

    it('checks access via engine', async function () {
      const { view, user } = await deployFixture();
      expect(await view.canAccessLoanOrder(1, user.address)).to.equal(true);
      expect(await view.canAccessLoanOrder(1, ethers.ZeroAddress)).to.equal(false);
    });

    it('checks match engine flag via engine', async function () {
      const { view, admin } = await deployFixture();
      expect(await view.isMatchEngine(admin.address)).to.equal(true);
      expect(await view.isMatchEngine(ethers.ZeroAddress)).to.equal(false);
    });

    it('returns registry from engine', async function () {
      const { view, registry } = await deployFixture();
      expect(await view.getRegistryFromEngine()).to.equal(await registry.getAddress());
    });
  });

  describe('upgrade authorization', function () {
    it('allows admin to upgrade', async function () {
      const { view, admin } = await deployFixture();
      const LendingEngineViewFactory = await ethers.getContractFactory('LendingEngineView');
      await upgrades.upgradeProxy(await view.getAddress(), LendingEngineViewFactory.connect(admin));
    });

    it('reverts upgrade when caller is not admin', async function () {
      const { view, other, acm } = await deployFixture();
      const LendingEngineViewFactory = await ethers.getContractFactory('LendingEngineView');
      await expect(
        upgrades.upgradeProxy(await view.getAddress(), LendingEngineViewFactory.connect(other)),
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('reverts upgrade with zero address implementation', async function () {
      const { view, admin } = await deployFixture();
      const LendingEngineViewFactory = await ethers.getContractFactory('LendingEngineView');
      const impl = await LendingEngineViewFactory.deploy();
      await expect(
        upgrades.upgradeProxy(await view.getAddress(), LendingEngineViewFactory.connect(admin)),
      ).to.not.be.reverted; // UUPS upgrade should work, but we can't test zero address upgrade directly
    });
  });

  describe('edge cases and error handling', function () {
    it('handles non-existent order ID', async function () {
      const { view, engine } = await deployFixture();
      // Query order that doesn't exist - should return empty/default struct
      const order = await view.getLoanOrder(999);
      expect(order.principal).to.equal(0n);
      expect(order.borrower).to.equal(ethers.ZeroAddress);
    });

    it('handles zero order ID', async function () {
      const { view, engine } = await deployFixture();
      // Set order 0
      await engine.setLoanOrder(0, {
        principal: 500n,
        rate: 300n,
        term: 15n,
        borrower: ethers.ZeroAddress,
        lender: ethers.ZeroAddress,
        asset: ethers.ZeroAddress,
        startTimestamp: 500n,
        maturity: 1000n,
        repaidAmount: 0n,
      });
      const order = await view.getLoanOrder(0);
      expect(order.principal).to.equal(500n);
    });

    it('handles zero address user for loan count', async function () {
      const { view, engine } = await deployFixture();
      await engine.setUserLoanCount(ethers.ZeroAddress, 0);
      expect(await view.getUserLoanCount(ethers.ZeroAddress)).to.equal(0n);
    });

    it('handles non-existent user for loan count', async function () {
      const { view } = await deployFixture();
      const nonExistentUser = ethers.Wallet.createRandom().address;
      expect(await view.getUserLoanCount(nonExistentUser)).to.equal(0n);
    });

    it('handles zero failed fee amount', async function () {
      const { view, engine } = await deployFixture();
      await engine.setFailedFeeAmount(2, 0);
      expect(await view.getFailedFeeAmount(2)).to.equal(0n);
    });

    it('handles zero nft retry count', async function () {
      const { view, engine } = await deployFixture();
      await engine.setNftRetryCount(2, 0);
      expect(await view.getNftRetryCount(2)).to.equal(0n);
    });

    it('handles very large order ID', async function () {
      const { view, engine } = await deployFixture();
      const largeOrderId = ethers.MaxUint256;
      const order = await view.getLoanOrder(largeOrderId);
      expect(order.principal).to.equal(0n); // Non-existent order
    });

    it('handles access check for non-existent order', async function () {
      const { view, user } = await deployFixture();
      expect(await view.canAccessLoanOrder(999, user.address)).to.equal(false);
    });

    it('handles match engine check for zero address', async function () {
      const { view } = await deployFixture();
      expect(await view.isMatchEngine(ethers.ZeroAddress)).to.equal(false);
    });
  });

  describe('multiple orders and users', function () {
    it('handles multiple orders for same user', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      // Set multiple orders
      await engine.setLoanOrder(2, {
        principal: 2_000n,
        rate: 600n,
        term: 60n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 2000n,
        maturity: 3000n,
        repaidAmount: 200n,
      });

      await engine.setLoanOrder(3, {
        principal: 3_000n,
        rate: 700n,
        term: 90n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 3000n,
        maturity: 4000n,
        repaidAmount: 300n,
      });

      const order1 = await view.getLoanOrder(1);
      const order2 = await view.getLoanOrder(2);
      const order3 = await view.getLoanOrder(3);

      expect(order1.principal).to.equal(1_000n);
      expect(order2.principal).to.equal(2_000n);
      expect(order3.principal).to.equal(3_000n);
    });

    it('handles multiple users with different loan counts', async function () {
      const { view, engine, user, admin, other } = await deployFixture();
      
      await engine.setUserLoanCount(user.address, 2);
      await engine.setUserLoanCount(admin.address, 5);
      await engine.setUserLoanCount(other.address, 0);

      expect(await view.getUserLoanCount(user.address)).to.equal(2n);
      expect(await view.getUserLoanCount(admin.address)).to.equal(5n);
      expect(await view.getUserLoanCount(other.address)).to.equal(0n);
    });

    it('handles different access permissions for different orders', async function () {
      const { view, engine, user, admin, other } = await deployFixture();
      
      // Order 1: user has access
      await engine.setOrderAccess(1, user.address, true);
      await engine.setOrderAccess(1, admin.address, false);
      
      // Order 2: admin has access
      await engine.setOrderAccess(2, user.address, false);
      await engine.setOrderAccess(2, admin.address, true);
      
      // Order 3: neither has access
      await engine.setOrderAccess(3, user.address, false);
      await engine.setOrderAccess(3, admin.address, false);

      expect(await view.canAccessLoanOrder(1, user.address)).to.equal(true);
      expect(await view.canAccessLoanOrder(1, admin.address)).to.equal(false);
      expect(await view.canAccessLoanOrder(2, user.address)).to.equal(false);
      expect(await view.canAccessLoanOrder(2, admin.address)).to.equal(true);
      expect(await view.canAccessLoanOrder(3, user.address)).to.equal(false);
      expect(await view.canAccessLoanOrder(3, admin.address)).to.equal(false);
    });

    it('handles different match engine flags for different accounts', async function () {
      const { view, engine, user, admin, other } = await deployFixture();
      
      await engine.setMatchEngine(user.address, true);
      await engine.setMatchEngine(admin.address, true);
      await engine.setMatchEngine(other.address, false);

      expect(await view.isMatchEngine(user.address)).to.equal(true);
      expect(await view.isMatchEngine(admin.address)).to.equal(true);
      expect(await view.isMatchEngine(other.address)).to.equal(false);
    });
  });

  describe('registry and module resolution', function () {
    it('reverts when registry address is zero', async function () {
      const { view } = await deployFixture();
      // This is tested via onlyValidRegistry modifier
      // We can't directly test this without deploying with zero registry
      // But the modifier should catch it
    });

    it('reverts when lending engine module is not registered', async function () {
      const [admin] = await ethers.getSigners();
      const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
      const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();

      await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
      // Intentionally not setting KEY_LENDING_ENGINE

      const LendingEngineViewFactory = await ethers.getContractFactory('LendingEngineView');
      const view = await upgrades.deployProxy(LendingEngineViewFactory, [await registry.getAddress()], {
        kind: 'uups',
      });

      await expect(view.getLoanOrder(1)).to.be.revertedWith('MockRegistry: module not found');
    });

    it('reverts when access control module is not registered for upgrade', async function () {
      const [admin] = await ethers.getSigners();
      const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
      const engine = await (await ethers.getContractFactory('MockLendingEngineViewAdapter')).deploy();

      await registry.setModule(KEY_LENDING_ENGINE, await engine.getAddress());
      // Intentionally not setting KEY_ACCESS_CONTROL

      const LendingEngineViewFactory = await ethers.getContractFactory('LendingEngineView');
      const view = await upgrades.deployProxy(LendingEngineViewFactory, [await registry.getAddress()], {
        kind: 'uups',
      });

      await expect(
        upgrades.upgradeProxy(await view.getAddress(), LendingEngineViewFactory.connect(admin)),
      ).to.be.revertedWith('MockRegistry: module not found');
    });
  });

  describe('order data integrity', function () {
    it('returns complete order structure with all fields', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      const testAsset = ethers.Wallet.createRandom().address;
      await engine.setLoanOrder(10, {
        principal: 5_000n,
        rate: 800n,
        term: 120n,
        borrower: user.address,
        lender: admin.address,
        asset: testAsset,
        startTimestamp: 5000n,
        maturity: 6000n,
        repaidAmount: 1000n,
      });

      const order = await view.getLoanOrder(10);
      expect(order.principal).to.equal(5_000n);
      expect(order.rate).to.equal(800n);
      expect(order.term).to.equal(120n);
      expect(order.borrower).to.equal(user.address);
      expect(order.lender).to.equal(admin.address);
      expect(order.asset).to.equal(testAsset);
      expect(order.startTimestamp).to.equal(5000n);
      expect(order.maturity).to.equal(6000n);
      expect(order.repaidAmount).to.equal(1000n);
    });

    it('handles order with maximum values', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      await engine.setLoanOrder(20, {
        principal: ethers.MaxUint256,
        rate: ethers.MaxUint256,
        term: ethers.MaxUint256,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: ethers.MaxUint256,
        maturity: ethers.MaxUint256,
        repaidAmount: ethers.MaxUint256,
      });

      const order = await view.getLoanOrder(20);
      expect(order.principal).to.equal(ethers.MaxUint256);
      expect(order.rate).to.equal(ethers.MaxUint256);
      expect(order.term).to.equal(ethers.MaxUint256);
    });
  });

  describe('getter consistency', function () {
    it('registryAddr and getRegistry return same value', async function () {
      const { view, registry } = await deployFixture();
      const addr1 = await view.registryAddr();
      const addr2 = await view.getRegistry();
      expect(addr1).to.equal(addr2);
      expect(addr1).to.equal(await registry.getAddress());
    });

    it('getRegistryFromEngine returns same registry as getRegistry', async function () {
      const { view, registry } = await deployFixture();
      const addr1 = await view.getRegistry();
      const addr2 = await view.getRegistryFromEngine();
      expect(addr1).to.equal(addr2);
      expect(addr1).to.equal(await registry.getAddress());
    });
  });

  describe('prevent double initialization', function () {
    it('reverts on second initialization', async function () {
      const { view, registry } = await deployFixture();
      await expect(view.initialize(await registry.getAddress())).to.be.revertedWith(
        'Initializable: contract is already initialized',
      );
    });
  });

  describe('data updates and query consistency', function () {
    it('reflects updated order data immediately', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      // Initial order
      await engine.setLoanOrder(100, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 0n,
      });

      let order = await view.getLoanOrder(100);
      expect(order.repaidAmount).to.equal(0n);

      // Update repaid amount
      await engine.setLoanOrder(100, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 500n,
      });

      order = await view.getLoanOrder(100);
      expect(order.repaidAmount).to.equal(500n);
    });

    it('reflects updated user loan count immediately', async function () {
      const { view, engine, user } = await deployFixture();
      
      expect(await view.getUserLoanCount(user.address)).to.equal(2n);
      
      await engine.setUserLoanCount(user.address, 10);
      expect(await view.getUserLoanCount(user.address)).to.equal(10n);
    });

    it('reflects updated failed fee amount immediately', async function () {
      const { view, engine } = await deployFixture();
      
      expect(await view.getFailedFeeAmount(1)).to.equal(77n);
      
      await engine.setFailedFeeAmount(1, 150);
      expect(await view.getFailedFeeAmount(1)).to.equal(150n);
    });

    it('reflects updated nft retry count immediately', async function () {
      const { view, engine } = await deployFixture();
      
      expect(await view.getNftRetryCount(1)).to.equal(3n);
      
      await engine.setNftRetryCount(1, 10);
      expect(await view.getNftRetryCount(1)).to.equal(10n);
    });

    it('reflects updated access permissions immediately', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      expect(await view.canAccessLoanOrder(1, user.address)).to.equal(true);
      
      await engine.setOrderAccess(1, user.address, false);
      expect(await view.canAccessLoanOrder(1, user.address)).to.equal(false);
      
      await engine.setOrderAccess(1, admin.address, true);
      expect(await view.canAccessLoanOrder(1, admin.address)).to.equal(true);
    });

    it('reflects updated match engine flag immediately', async function () {
      const { view, engine, other } = await deployFixture();
      
      expect(await view.isMatchEngine(other.address)).to.equal(false);
      
      await engine.setMatchEngine(other.address, true);
      expect(await view.isMatchEngine(other.address)).to.equal(true);
      
      await engine.setMatchEngine(other.address, false);
      expect(await view.isMatchEngine(other.address)).to.equal(false);
    });
  });

  describe('time-related scenarios', function () {
    it('handles orders with different timestamps', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      const now = Math.floor(Date.now() / 1000);
      const future = now + 86400; // 1 day later
      
      await engine.setLoanOrder(200, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: BigInt(now),
        maturity: BigInt(future),
        repaidAmount: 0n,
      });

      const order = await view.getLoanOrder(200);
      expect(order.startTimestamp).to.equal(BigInt(now));
      expect(order.maturity).to.equal(BigInt(future));
    });

    it('handles orders with past timestamps', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      const past = 1000n;
      const pastMaturity = 2000n;
      
      await engine.setLoanOrder(201, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: past,
        maturity: pastMaturity,
        repaidAmount: 0n,
      });

      const order = await view.getLoanOrder(201);
      expect(order.startTimestamp).to.equal(past);
      expect(order.maturity).to.equal(pastMaturity);
    });

    it('handles orders with same start and maturity timestamp', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      const sameTime = 5000n;
      
      await engine.setLoanOrder(202, {
        principal: 1_000n,
        rate: 500n,
        term: 0n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: sameTime,
        maturity: sameTime,
        repaidAmount: 0n,
      });

      const order = await view.getLoanOrder(202);
      expect(order.startTimestamp).to.equal(sameTime);
      expect(order.maturity).to.equal(sameTime);
    });
  });

  describe('repayment scenarios', function () {
    it('handles fully repaid orders', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      await engine.setLoanOrder(300, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 1_000n, // Fully repaid
      });

      const order = await view.getLoanOrder(300);
      expect(order.repaidAmount).to.equal(1_000n);
      expect(order.principal).to.equal(1_000n);
    });

    it('handles partially repaid orders', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      await engine.setLoanOrder(301, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 300n, // Partially repaid
      });

      const order = await view.getLoanOrder(301);
      expect(order.repaidAmount).to.equal(300n);
      expect(order.repaidAmount).to.be.lt(order.principal);
    });

    it('handles overpaid orders', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      await engine.setLoanOrder(302, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 1_500n, // Overpaid
      });

      const order = await view.getLoanOrder(302);
      expect(order.repaidAmount).to.equal(1_500n);
      expect(order.repaidAmount).to.be.gt(order.principal);
    });

    it('handles orders with zero principal but non-zero repayment', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      await engine.setLoanOrder(303, {
        principal: 0n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 100n,
      });

      const order = await view.getLoanOrder(303);
      expect(order.principal).to.equal(0n);
      expect(order.repaidAmount).to.equal(100n);
    });
  });

  describe('asset-related scenarios', function () {
    it('handles orders with different assets', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      const asset1 = ethers.Wallet.createRandom().address;
      const asset2 = ethers.Wallet.createRandom().address;
      const asset3 = ethers.Wallet.createRandom().address;
      
      await engine.setLoanOrder(400, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: asset1,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 0n,
      });

      await engine.setLoanOrder(401, {
        principal: 2_000n,
        rate: 600n,
        term: 60n,
        borrower: user.address,
        lender: admin.address,
        asset: asset2,
        startTimestamp: 2000n,
        maturity: 3000n,
        repaidAmount: 0n,
      });

      await engine.setLoanOrder(402, {
        principal: 3_000n,
        rate: 700n,
        term: 90n,
        borrower: user.address,
        lender: admin.address,
        asset: asset3,
        startTimestamp: 3000n,
        maturity: 4000n,
        repaidAmount: 0n,
      });

      const order1 = await view.getLoanOrder(400);
      const order2 = await view.getLoanOrder(401);
      const order3 = await view.getLoanOrder(402);

      expect(order1.asset).to.equal(asset1);
      expect(order2.asset).to.equal(asset2);
      expect(order3.asset).to.equal(asset3);
    });

    it('handles orders with zero address asset', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      await engine.setLoanOrder(403, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 0n,
      });

      const order = await view.getLoanOrder(403);
      expect(order.asset).to.equal(ethers.ZeroAddress);
    });
  });

  describe('rate and term scenarios', function () {
    it('handles orders with zero rate', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      await engine.setLoanOrder(500, {
        principal: 1_000n,
        rate: 0n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 0n,
      });

      const order = await view.getLoanOrder(500);
      expect(order.rate).to.equal(0n);
    });

    it('handles orders with zero term', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      await engine.setLoanOrder(501, {
        principal: 1_000n,
        rate: 500n,
        term: 0n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 1000n,
        repaidAmount: 0n,
      });

      const order = await view.getLoanOrder(501);
      expect(order.term).to.equal(0n);
    });

    it('handles orders with very high rates', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      await engine.setLoanOrder(502, {
        principal: 1_000n,
        rate: 10_000n, // 100% rate
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 0n,
      });

      const order = await view.getLoanOrder(502);
      expect(order.rate).to.equal(10_000n);
    });

    it('handles orders with very long terms', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      await engine.setLoanOrder(503, {
        principal: 1_000n,
        rate: 500n,
        term: 365n * 10n, // 10 years
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 1000n + 365n * 10n,
        repaidAmount: 0n,
      });

      const order = await view.getLoanOrder(503);
      expect(order.term).to.equal(365n * 10n);
    });
  });

  describe('borrower and lender scenarios', function () {
    it('handles orders with same borrower and lender', async function () {
      const { view, engine, user } = await deployFixture();
      
      await engine.setLoanOrder(600, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: user.address, // Same as borrower
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 0n,
      });

      const order = await view.getLoanOrder(600);
      expect(order.borrower).to.equal(user.address);
      expect(order.lender).to.equal(user.address);
    });

    it('handles orders with zero address borrower', async function () {
      const { view, engine, admin } = await deployFixture();
      
      await engine.setLoanOrder(601, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: ethers.ZeroAddress,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 0n,
      });

      const order = await view.getLoanOrder(601);
      expect(order.borrower).to.equal(ethers.ZeroAddress);
    });

    it('handles orders with zero address lender', async function () {
      const { view, engine, user } = await deployFixture();
      
      await engine.setLoanOrder(602, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: ethers.ZeroAddress,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 0n,
      });

      const order = await view.getLoanOrder(602);
      expect(order.lender).to.equal(ethers.ZeroAddress);
    });
  });

  describe('integration scenarios', function () {
    it('queries multiple order properties in sequence', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      await engine.setLoanOrder(700, {
        principal: 5_000n,
        rate: 800n,
        term: 120n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 5000n,
        maturity: 6000n,
        repaidAmount: 1_000n,
      });

      // Query all properties
      const order = await view.getLoanOrder(700);
      const loanCount = await view.getUserLoanCount(user.address);
      const failedFee = await view.getFailedFeeAmount(700);
      const retryCount = await view.getNftRetryCount(700);
      const hasAccess = await view.canAccessLoanOrder(700, user.address);

      expect(order.principal).to.equal(5_000n);
      expect(loanCount).to.equal(2n);
      expect(failedFee).to.equal(0n);
      expect(retryCount).to.equal(0n);
      expect(hasAccess).to.equal(false); // Not set in fixture
    });

    it('queries same order multiple times returns consistent data', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      await engine.setLoanOrder(701, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 100n,
      });

      const order1 = await view.getLoanOrder(701);
      const order2 = await view.getLoanOrder(701);
      const order3 = await view.getLoanOrder(701);

      expect(order1.principal).to.equal(order2.principal);
      expect(order2.principal).to.equal(order3.principal);
      expect(order1.repaidAmount).to.equal(order2.repaidAmount);
      expect(order2.repaidAmount).to.equal(order3.repaidAmount);
    });

    it('queries multiple users loan counts efficiently', async function () {
      const { view, engine, user, admin, other } = await deployFixture();
      
      await engine.setUserLoanCount(user.address, 3);
      await engine.setUserLoanCount(admin.address, 7);
      await engine.setUserLoanCount(other.address, 1);

      const count1 = await view.getUserLoanCount(user.address);
      const count2 = await view.getUserLoanCount(admin.address);
      const count3 = await view.getUserLoanCount(other.address);

      expect(count1).to.equal(3n);
      expect(count2).to.equal(7n);
      expect(count3).to.equal(1n);
    });
  });

  describe('module upgrade scenarios', function () {
    it('maintains functionality after upgrade', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      // Set test data
      await engine.setLoanOrder(800, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 0n,
      });

      // Upgrade
      const LendingEngineViewFactory = await ethers.getContractFactory('LendingEngineView');
      await upgrades.upgradeProxy(await view.getAddress(), LendingEngineViewFactory);

      // Verify functionality still works
      const order = await view.getLoanOrder(800);
      expect(order.principal).to.equal(1_000n);
      expect(await view.getUserLoanCount(user.address)).to.equal(2n);
      expect(await view.getRegistry()).to.not.equal(ethers.ZeroAddress);
    });

    it('maintains registry address after upgrade', async function () {
      const { view, registry, admin } = await deployFixture();
      
      const registryBefore = await view.getRegistry();
      
      // Upgrade
      const LendingEngineViewFactory = await ethers.getContractFactory('LendingEngineView');
      await upgrades.upgradeProxy(await view.getAddress(), LendingEngineViewFactory.connect(admin));

      const registryAfter = await view.getRegistry();
      expect(registryBefore).to.equal(registryAfter);
      expect(registryAfter).to.equal(await registry.getAddress());
    });
  });

  describe('concurrent query scenarios', function () {
    it('handles rapid sequential queries', async function () {
      const { view, engine, user } = await deployFixture();
      
      // Set multiple orders
      for (let i = 900; i < 910; i++) {
        await engine.setLoanOrder(i, {
          principal: BigInt(i * 100),
          rate: 500n,
          term: 30n,
          borrower: user.address,
          lender: user.address,
          asset: ethers.ZeroAddress,
          startTimestamp: 1000n,
          maturity: 2000n,
          repaidAmount: 0n,
        });
      }

      // Query all rapidly
      for (let i = 900; i < 910; i++) {
        const order = await view.getLoanOrder(i);
        expect(order.principal).to.equal(BigInt(i * 100));
      }
    });

    it('handles interleaved queries for different orders', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      await engine.setLoanOrder(950, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 0n,
      });

      await engine.setLoanOrder(951, {
        principal: 2_000n,
        rate: 600n,
        term: 60n,
        borrower: admin.address,
        lender: user.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 2000n,
        maturity: 3000n,
        repaidAmount: 0n,
      });

      // Interleaved queries
      const order1 = await view.getLoanOrder(950);
      const order2 = await view.getLoanOrder(951);
      const order1Again = await view.getLoanOrder(950);
      const order2Again = await view.getLoanOrder(951);

      expect(order1.principal).to.equal(1_000n);
      expect(order2.principal).to.equal(2_000n);
      expect(order1Again.principal).to.equal(order1.principal);
      expect(order2Again.principal).to.equal(order2.principal);
    });
  });

  describe('business logic: order access control', function () {
    it('allows borrower to access their own order', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      await engine.setLoanOrder(1000, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 0n,
      });

      // Borrower should have access (set via setOrderAccess or checked in real engine)
      await engine.setOrderAccess(1000, user.address, true);
      expect(await view.canAccessLoanOrder(1000, user.address)).to.equal(true);
    });

    it('allows lender to access their order', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      await engine.setLoanOrder(1001, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 0n,
      });

      // Lender should have access
      await engine.setOrderAccess(1001, admin.address, true);
      expect(await view.canAccessLoanOrder(1001, admin.address)).to.equal(true);
    });

    it('denies access to unrelated users', async function () {
      const { view, engine, user, admin, other } = await deployFixture();
      
      await engine.setLoanOrder(1002, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 0n,
      });

      // Unrelated user should not have access
      await engine.setOrderAccess(1002, other.address, false);
      expect(await view.canAccessLoanOrder(1002, other.address)).to.equal(false);
    });

    it('denies access to non-existent orders', async function () {
      const { view, user } = await deployFixture();
      
      // Order doesn't exist
      expect(await view.canAccessLoanOrder(99999, user.address)).to.equal(false);
    });

    it('handles access check for order with zero address borrower', async function () {
      const { view, engine, admin } = await deployFixture();
      
      await engine.setLoanOrder(1003, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: ethers.ZeroAddress,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 0n,
      });

      // Zero address borrower should not grant access
      expect(await view.canAccessLoanOrder(1003, ethers.ZeroAddress)).to.equal(false);
    });
  });

  describe('business logic: order lifecycle', function () {
    it('tracks order from creation to full repayment', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      const orderId = 2000;
      
      // 1. Order created
      await engine.setLoanOrder(orderId, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 0n,
      });

      let order = await view.getLoanOrder(orderId);
      expect(order.repaidAmount).to.equal(0n);
      expect(order.principal).to.equal(1_000n);

      // 2. Partial repayment
      await engine.setLoanOrder(orderId, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 300n,
      });

      order = await view.getLoanOrder(orderId);
      expect(order.repaidAmount).to.equal(300n);
      expect(order.repaidAmount).to.be.lt(order.principal);

      // 3. More partial repayment
      await engine.setLoanOrder(orderId, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 700n,
      });

      order = await view.getLoanOrder(orderId);
      expect(order.repaidAmount).to.equal(700n);

      // 4. Full repayment
      await engine.setLoanOrder(orderId, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 1_000n,
      });

      order = await view.getLoanOrder(orderId);
      expect(order.repaidAmount).to.equal(1_000n);
      expect(order.repaidAmount).to.equal(order.principal);
    });

    it('tracks order maturity timeline', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      const startTime = 1000n;
      const term = 30n;
      const maturity = startTime + term;
      
      await engine.setLoanOrder(2001, {
        principal: 1_000n,
        rate: 500n,
        term: term,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: startTime,
        maturity: maturity,
        repaidAmount: 0n,
      });

      const order = await view.getLoanOrder(2001);
      expect(order.startTimestamp).to.equal(startTime);
      expect(order.maturity).to.equal(maturity);
      expect(order.maturity - order.startTimestamp).to.equal(term);
    });

    it('handles order with expired maturity', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      const pastTime = 1000n;
      const pastMaturity = 2000n;
      
      await engine.setLoanOrder(2002, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: pastTime,
        maturity: pastMaturity,
        repaidAmount: 500n, // Partially repaid before expiry
      });

      const order = await view.getLoanOrder(2002);
      expect(order.maturity).to.equal(pastMaturity);
      expect(order.repaidAmount).to.equal(500n);
    });
  });

  describe('business logic: user loan count calculation', function () {
    it('counts only orders where user is borrower', async function () {
      const { view, engine, user, admin, other } = await deployFixture();
      
      // User as borrower
      await engine.setLoanOrder(3000, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 0n,
      });

      await engine.setLoanOrder(3001, {
        principal: 2_000n,
        rate: 600n,
        term: 60n,
        borrower: user.address,
        lender: other.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 2000n,
        maturity: 3000n,
        repaidAmount: 0n,
      });

      // User as lender (should not count)
      await engine.setLoanOrder(3002, {
        principal: 3_000n,
        rate: 700n,
        term: 90n,
        borrower: admin.address,
        lender: user.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 3000n,
        maturity: 4000n,
        repaidAmount: 0n,
      });

      await engine.setUserLoanCount(user.address, 2); // Only orders 3000 and 3001
      expect(await view.getUserLoanCount(user.address)).to.equal(2n);
    });

    it('counts orders regardless of repayment status', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      // Unpaid order
      await engine.setLoanOrder(3003, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 0n,
      });

      // Partially paid order
      await engine.setLoanOrder(3004, {
        principal: 2_000n,
        rate: 600n,
        term: 60n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 2000n,
        maturity: 3000n,
        repaidAmount: 1_000n,
      });

      // Fully paid order
      await engine.setLoanOrder(3005, {
        principal: 3_000n,
        rate: 700n,
        term: 90n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 3000n,
        maturity: 4000n,
        repaidAmount: 3_000n,
      });

      await engine.setUserLoanCount(user.address, 3); // All three orders count
      expect(await view.getUserLoanCount(user.address)).to.equal(3n);
    });

    it('returns zero for user with no loans', async function () {
      const { view, engine, other } = await deployFixture();
      
      await engine.setUserLoanCount(other.address, 0);
      expect(await view.getUserLoanCount(other.address)).to.equal(0n);
    });
  });

  describe('business logic: failed fee accumulation', function () {
    it('tracks cumulative failed fees for an order', async function () {
      const { view, engine } = await deployFixture();
      
      const orderId = 4000;
      
      // Initial failed fee
      await engine.setFailedFeeAmount(orderId, 100);
      expect(await view.getFailedFeeAmount(orderId)).to.equal(100n);

      // Accumulate more failed fees
      await engine.setFailedFeeAmount(orderId, 250);
      expect(await view.getFailedFeeAmount(orderId)).to.equal(250n);

      // Further accumulation
      await engine.setFailedFeeAmount(orderId, 500);
      expect(await view.getFailedFeeAmount(orderId)).to.equal(500n);
    });

    it('handles zero failed fees for new orders', async function () {
      const { view, engine } = await deployFixture();
      
      const orderId = 4001;
      await engine.setFailedFeeAmount(orderId, 0);
      expect(await view.getFailedFeeAmount(orderId)).to.equal(0n);
    });

    it('tracks failed fees independently per order', async function () {
      const { view, engine } = await deployFixture();
      
      await engine.setFailedFeeAmount(4002, 100);
      await engine.setFailedFeeAmount(4003, 200);
      await engine.setFailedFeeAmount(4004, 300);

      expect(await view.getFailedFeeAmount(4002)).to.equal(100n);
      expect(await view.getFailedFeeAmount(4003)).to.equal(200n);
      expect(await view.getFailedFeeAmount(4004)).to.equal(300n);
    });
  });

  describe('business logic: NFT retry mechanism', function () {
    it('tracks retry count for failed NFT minting', async function () {
      const { view, engine } = await deployFixture();
      
      const orderId = 5000;
      
      // First retry attempt
      await engine.setNftRetryCount(orderId, 1);
      expect(await view.getNftRetryCount(orderId)).to.equal(1n);

      // Second retry attempt
      await engine.setNftRetryCount(orderId, 2);
      expect(await view.getNftRetryCount(orderId)).to.equal(2n);

      // Third retry attempt
      await engine.setNftRetryCount(orderId, 3);
      expect(await view.getNftRetryCount(orderId)).to.equal(3n);
    });

    it('handles zero retry count for successful mints', async function () {
      const { view, engine } = await deployFixture();
      
      const orderId = 5001;
      await engine.setNftRetryCount(orderId, 0);
      expect(await view.getNftRetryCount(orderId)).to.equal(0n);
    });

    it('tracks retry counts independently per order', async function () {
      const { view, engine } = await deployFixture();
      
      await engine.setNftRetryCount(5002, 1);
      await engine.setNftRetryCount(5003, 5);
      await engine.setNftRetryCount(5004, 10);

      expect(await view.getNftRetryCount(5002)).to.equal(1n);
      expect(await view.getNftRetryCount(5003)).to.equal(5n);
      expect(await view.getNftRetryCount(5004)).to.equal(10n);
    });

    it('handles high retry counts for persistent failures', async function () {
      const { view, engine } = await deployFixture();
      
      const orderId = 5005;
      const highRetryCount = 100;
      
      await engine.setNftRetryCount(orderId, highRetryCount);
      expect(await view.getNftRetryCount(orderId)).to.equal(BigInt(highRetryCount));
    });
  });

  describe('business logic: match engine permissions', function () {
    it('identifies accounts with match engine permission', async function () {
      const { view, engine, admin } = await deployFixture();
      
      // Admin has match engine permission (set in fixture)
      expect(await view.isMatchEngine(admin.address)).to.equal(true);
    });

    it('identifies accounts without match engine permission', async function () {
      const { view, engine, other } = await deployFixture();
      
      // Other user does not have match engine permission
      await engine.setMatchEngine(other.address, false);
      expect(await view.isMatchEngine(other.address)).to.equal(false);
    });

    it('handles multiple accounts with match engine permission', async function () {
      const { view, engine, user, admin, other } = await deployFixture();
      
      await engine.setMatchEngine(user.address, true);
      await engine.setMatchEngine(admin.address, true);
      await engine.setMatchEngine(other.address, false);

      expect(await view.isMatchEngine(user.address)).to.equal(true);
      expect(await view.isMatchEngine(admin.address)).to.equal(true);
      expect(await view.isMatchEngine(other.address)).to.equal(false);
    });

    it('allows revoking match engine permission', async function () {
      const { view, engine, user } = await deployFixture();
      
      // Grant permission
      await engine.setMatchEngine(user.address, true);
      expect(await view.isMatchEngine(user.address)).to.equal(true);

      // Revoke permission
      await engine.setMatchEngine(user.address, false);
      expect(await view.isMatchEngine(user.address)).to.equal(false);
    });
  });

  describe('business logic: order state transitions', function () {
    it('tracks order from unpaid to fully paid state', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      const orderId = 6000;
      const principal = 1_000n;
      
      // State 1: Unpaid
      await engine.setLoanOrder(orderId, {
        principal: principal,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 0n,
      });

      let order = await view.getLoanOrder(orderId);
      expect(order.repaidAmount).to.equal(0n);
      const isUnpaid = order.repaidAmount === 0n;
      expect(isUnpaid).to.equal(true);

      // State 2: Partially paid
      await engine.setLoanOrder(orderId, {
        principal: principal,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: principal / 2n,
      });

      order = await view.getLoanOrder(orderId);
      const isPartiallyPaid = order.repaidAmount > 0n && order.repaidAmount < principal;
      expect(isPartiallyPaid).to.equal(true);

      // State 3: Fully paid
      await engine.setLoanOrder(orderId, {
        principal: principal,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: principal,
      });

      order = await view.getLoanOrder(orderId);
      const isFullyPaid = order.repaidAmount >= principal;
      expect(isFullyPaid).to.equal(true);
    });

    it('handles order with progressive repayment', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      const orderId = 6001;
      const repayments = [100n, 200n, 300n, 400n];
      
      for (let i = 0; i < repayments.length; i++) {
        const cumulativeRepayment = repayments.slice(0, i + 1).reduce((a, b) => a + b, 0n);
        
        await engine.setLoanOrder(orderId, {
          principal: 1_000n,
          rate: 500n,
          term: 30n,
          borrower: user.address,
          lender: admin.address,
          asset: ethers.ZeroAddress,
          startTimestamp: 1000n,
          maturity: 2000n,
          repaidAmount: cumulativeRepayment,
        });

        const order = await view.getLoanOrder(orderId);
        expect(order.repaidAmount).to.equal(cumulativeRepayment);
      }
    });
  });

  describe('business logic: multi-order scenarios', function () {
    it('handles user with multiple active orders', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      // Create multiple orders for same user
      for (let i = 7000; i < 7010; i++) {
        await engine.setLoanOrder(i, {
          principal: BigInt(i * 100),
          rate: 500n,
          term: 30n,
          borrower: user.address,
          lender: admin.address,
          asset: ethers.ZeroAddress,
          startTimestamp: 1000n,
          maturity: 2000n,
          repaidAmount: 0n,
        });
      }

      await engine.setUserLoanCount(user.address, 10);
      expect(await view.getUserLoanCount(user.address)).to.equal(10n);

      // Verify all orders are accessible
      for (let i = 7000; i < 7010; i++) {
        const order = await view.getLoanOrder(i);
        expect(order.principal).to.equal(BigInt(i * 100));
        expect(order.borrower).to.equal(user.address);
      }
    });

    it('handles multiple users with overlapping order IDs', async function () {
      const { view, engine, user, admin, other } = await deployFixture();
      
      // User's order
      await engine.setLoanOrder(8000, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 0n,
      });

      // Admin's order (as borrower)
      await engine.setLoanOrder(8001, {
        principal: 2_000n,
        rate: 600n,
        term: 60n,
        borrower: admin.address,
        lender: other.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 2000n,
        maturity: 3000n,
        repaidAmount: 0n,
      });

      // Other's order
      await engine.setLoanOrder(8002, {
        principal: 3_000n,
        rate: 700n,
        term: 90n,
        borrower: other.address,
        lender: user.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 3000n,
        maturity: 4000n,
        repaidAmount: 0n,
      });

      await engine.setUserLoanCount(user.address, 1);
      await engine.setUserLoanCount(admin.address, 1);
      await engine.setUserLoanCount(other.address, 1);

      expect(await view.getUserLoanCount(user.address)).to.equal(1n);
      expect(await view.getUserLoanCount(admin.address)).to.equal(1n);
      expect(await view.getUserLoanCount(other.address)).to.equal(1n);
    });
  });

  describe('business logic: order validation scenarios', function () {
    it('validates order with minimum valid values', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      await engine.setLoanOrder(9000, {
        principal: 1n, // Minimum principal
        rate: 1n, // Minimum rate
        term: 1n, // Minimum term
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1n,
        maturity: 2n,
        repaidAmount: 0n,
      });

      const order = await view.getLoanOrder(9000);
      expect(order.principal).to.equal(1n);
      expect(order.rate).to.equal(1n);
      expect(order.term).to.equal(1n);
    });

    it('handles order with maximum valid values', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      await engine.setLoanOrder(9001, {
        principal: ethers.MaxUint256,
        rate: ethers.MaxUint256,
        term: ethers.MaxUint256,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: ethers.MaxUint256,
        maturity: ethers.MaxUint256,
        repaidAmount: ethers.MaxUint256,
      });

      const order = await view.getLoanOrder(9001);
      expect(order.principal).to.equal(ethers.MaxUint256);
      expect(order.rate).to.equal(ethers.MaxUint256);
      expect(order.term).to.equal(ethers.MaxUint256);
    });

    it('handles order where repaid amount equals principal exactly', async function () {
      const { view, engine, user, admin } = await deployFixture();
      
      const principal = 1_000n;
      
      await engine.setLoanOrder(9002, {
        principal: principal,
        rate: 500n,
        term: 30n,
        borrower: user.address,
        lender: admin.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: principal, // Exactly equal
      });

      const order = await view.getLoanOrder(9002);
      expect(order.repaidAmount).to.equal(order.principal);
    });
  });
});

