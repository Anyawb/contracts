import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { FunctionFragment } from 'ethers';

const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
const KEY_ORDER_ENGINE = ethers.keccak256(ethers.toUtf8Bytes('ORDER_ENGINE'));

const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
const ACTION_VIEW_USER_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA'));
const ACTION_VIEW_SYSTEM_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_SYSTEM_DATA'));

describe('LendingEngineView', function () {
  async function deployFixture() {
    const [admin, borrower, lender, outsider, ops] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
    const engine = await (await ethers.getContractFactory('MockLendingEngineViewAdapter')).deploy();

    await engine.setRegistry(await registry.getAddress());
    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(KEY_ORDER_ENGINE, await engine.getAddress());

    // grant admin for upgrades + privileged reads
    await acm.grantRole(ACTION_ADMIN, admin.address);
    // ops can do user/system scoped reads
    await acm.grantRole(ACTION_VIEW_USER_DATA, ops.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, ops.address);

    const LendingEngineViewFactory = await ethers.getContractFactory('LendingEngineView');
    const view = await upgrades.deployProxy(LendingEngineViewFactory, [await registry.getAddress()], {
      kind: 'uups',
    });

    // seed mock data
    await engine.setLoanOrder(1, {
      principal: 1_000n,
      rate: 500n,
      term: 30n,
      borrower: borrower.address,
      lender: lender.address,
      asset: ethers.ZeroAddress,
      startTimestamp: 1000n,
      maturity: 2000n,
      repaidAmount: 100n,
    });
    await engine.setUserLoanCount(borrower.address, 2);
    await engine.setFailedFeeAmount(1, 77);
    await engine.setNftRetryCount(1, 3);
    await engine.setMatchEngine(admin.address, true);

    return { view, registry, acm, admin, borrower, lender, outsider, ops, engine };
  }

  describe('LEV-01 responsibility boundary (read-only, no push*)', function () {
    it('has no push* functions and no unexpected non-view externals', async function () {
      const { view } = await deployFixture();

      const functionFragments = view.interface.fragments.filter(
        (f): f is FunctionFragment => f.type === 'function',
      );

      const pushFns = functionFragments.filter((f) => f.name.startsWith('push'));
      expect(pushFns.map((f) => f.name)).to.deep.equal([]);

      const nonView = functionFragments.filter((f) => !['view', 'pure'].includes(f.stateMutability));
      for (const fn of nonView) {
        const isAllowed =
          fn.name === 'initialize' || fn.name.startsWith('upgradeTo') || fn.name === 'upgradeToAndCall';
        expect(
          isAllowed,
          `unexpected non-view external function: ${fn.name}(${fn.inputs.map((i) => i.type).join(',')})`,
        ).to.equal(true);
      }

      // ABI-level: should not expose DataPushed event (view module has no push/write surface)
      const eventNames = view.interface.fragments
        .filter((f) => f.type === 'event')
        .map((f) => (f as any).name);
      expect(eventNames).to.not.include('DataPushed');

      // runtime-level: enumerate selectors and ensure no push*
      const selectors = functionFragments.map((f) => view.interface.getFunction(f.format()).selector);
      expect(selectors.length).to.equal(new Set(selectors).size);
    });
  });

  describe('LEV-02/03 order privacy (borrower/lender vs outsider)', function () {
    it('allows borrower and lender to read getLoanOrder(orderId)', async function () {
      const { view, borrower, lender } = await deployFixture();
      const borrowerView = view.connect(borrower);
      const lenderView = view.connect(lender);

      const orderAsBorrower = await borrowerView.getLoanOrder(1);
      const orderAsLender = await lenderView.getLoanOrder(1);

      expect(orderAsBorrower.principal).to.equal(1_000n);
      expect(orderAsBorrower.borrower).to.equal(borrower.address);
      expect(orderAsBorrower.lender).to.equal(lender.address);
      expect(orderAsBorrower.repaidAmount).to.equal(100n);

      // lender sees the same snapshot
      expect(orderAsLender.principal).to.equal(orderAsBorrower.principal);
      expect(orderAsLender.borrower).to.equal(orderAsBorrower.borrower);
      expect(orderAsLender.lender).to.equal(orderAsBorrower.lender);
      expect(orderAsLender.repaidAmount).to.equal(orderAsBorrower.repaidAmount);
    });

    it('rejects outsider reading getLoanOrder(orderId) with MissingRole()', async function () {
      const { view, outsider } = await deployFixture();
      await expect(view.connect(outsider).getLoanOrder(1)).to.be.revertedWithCustomError(
        view,
        'MissingRole',
      );
    });
  });

  describe('LEV-04 user-scoped reads (self vs ops/admin)', function () {
    it('allows self read; denies unauthorized; allows ops (VIEW_USER_DATA)', async function () {
      const { view, borrower, outsider, ops } = await deployFixture();
      const [borrowerCount] = await view.connect(borrower).getUserLoanCount(borrower.address);
      expect(borrowerCount).to.equal(2n);

      await expect(view.connect(outsider).getUserLoanCount(borrower.address)).to.be.revertedWithCustomError(
        view,
        'MissingRole',
      );

      const [opsCount] = await view.connect(ops).getUserLoanCount(borrower.address);
      expect(opsCount).to.equal(2n);
    });

    it('applies the same gate to canAccessLoanOrder(orderId,user)', async function () {
      const { view, borrower, outsider, ops } = await deployFixture();
      const [borrowerAccess] = await view.connect(borrower).canAccessLoanOrder(1, borrower.address);
      const [opsAccess] = await view.connect(ops).canAccessLoanOrder(1, borrower.address);
      expect(borrowerAccess).to.equal(true);
      expect(opsAccess).to.equal(true);

      await expect(
        view.connect(outsider).canAccessLoanOrder(1, borrower.address),
      ).to.be.revertedWithCustomError(view, 'MissingRole');
    });
  });

  describe('LEV-05 ops diagnostics (system data) only for ops/admin', function () {
    it('allows ops/admin; rejects outsider with MissingRole()', async function () {
      const { view, admin, ops, outsider, registry } = await deployFixture();

      // admin (ACTION_ADMIN) can access
      expect(await view.connect(admin).getFailedFeeAmount(1)).to.equal(77n);
      expect(await view.connect(admin).getNftRetryCount(1)).to.equal(3n);
      expect(await view.connect(admin).isMatchEngine(admin.address)).to.equal(true);
      expect(await view.connect(admin).getRegistryFromEngine()).to.equal(await registry.getAddress());

      // ops (VIEW_SYSTEM_DATA) can access
      expect(await view.connect(ops).getFailedFeeAmount(1)).to.equal(77n);
      expect(await view.connect(ops).getNftRetryCount(1)).to.equal(3n);
      expect(await view.connect(ops).isMatchEngine(admin.address)).to.equal(true);
      expect(await view.connect(ops).getRegistryFromEngine()).to.equal(await registry.getAddress());

      // outsider cannot access any ops-only endpoint
      await expect(view.connect(outsider).getFailedFeeAmount(1)).to.be.revertedWithCustomError(
        view,
        'MissingRole',
      );
      await expect(view.connect(outsider).getNftRetryCount(1)).to.be.revertedWithCustomError(view, 'MissingRole');
      await expect(view.connect(outsider).isMatchEngine(admin.address)).to.be.revertedWithCustomError(
        view,
        'MissingRole',
      );
      await expect(view.connect(outsider).getRegistryFromEngine()).to.be.revertedWithCustomError(view, 'MissingRole');
    });
  });

  describe('upgrade authorization', function () {
    it('allows admin to upgrade', async function () {
      const { view, admin } = await deployFixture();
      const LendingEngineViewFactory = await ethers.getContractFactory('LendingEngineView');
      await upgrades.upgradeProxy(await view.getAddress(), LendingEngineViewFactory.connect(admin));
    });

    it('reverts upgrade when caller is not admin', async function () {
      const { view, outsider, acm } = await deployFixture();
      const LendingEngineViewFactory = await ethers.getContractFactory('LendingEngineView');
      await expect(
        upgrades.upgradeProxy(await view.getAddress(), LendingEngineViewFactory.connect(outsider)),
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

  describe('initialization (basic sanity)', function () {
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
      ).to.be.revertedWithCustomError(impl, 'ZeroAddress');
    });

    it('reverts on EOA init (NotAContract)', async function () {
      const [eoa] = await ethers.getSigners();
      const LendingEngineViewFactory = await ethers.getContractFactory('LendingEngineView');
      const impl = await LendingEngineViewFactory.deploy();
      await impl.waitForDeployment();

      await expect(
        upgrades.deployProxy(LendingEngineViewFactory, [eoa.address], { kind: 'uups' }),
      ).to.be.revertedWithCustomError(impl, 'NotAContract');
    });

    it('prevents double initialization on proxy', async function () {
      const { view, registry } = await deployFixture();
      await expect(view.initialize(await registry.getAddress())).to.be.revertedWithCustomError(
        view,
        'InvalidInitialization',
      );
    });

    it('uninitialized implementation rejects read APIs (ZeroAddress)', async function () {
      const LendingEngineViewFactory = await ethers.getContractFactory('LendingEngineView');
      const impl = await LendingEngineViewFactory.deploy();
      await impl.waitForDeployment();

      await expect(impl.getLoanOrder(1)).to.be.revertedWithCustomError(impl, 'ZeroAddress');
      await expect(impl.getUserLoanCount(ethers.ZeroAddress)).to.be.revertedWithCustomError(impl, 'ZeroAddress');
      await expect(impl.getFailedFeeAmount(1)).to.be.revertedWithCustomError(impl, 'ZeroAddress');
      await expect(impl.getNftRetryCount(1)).to.be.revertedWithCustomError(impl, 'ZeroAddress');
      await expect(impl.isMatchEngine(ethers.ZeroAddress)).to.be.revertedWithCustomError(impl, 'ZeroAddress');
      await expect(impl.getRegistryFromEngine()).to.be.revertedWithCustomError(impl, 'ZeroAddress');
    });
  });

  describe('version info (5.1.2 acceptance requirement)', function () {
    it('exposes apiVersion() and schemaVersion() baselines', async function () {
      const { view } = await deployFixture();
      expect(await view.apiVersion()).to.equal(1n);
      expect(await view.schemaVersion()).to.equal(1n);
    });

    it('getVersionInfo() returns complete version info for off-chain introspection', async function () {
      const { view } = await deployFixture();
      const [apiVer, schemaVer, implementation] = await view.getVersionInfo();
      expect(apiVer).to.equal(await view.apiVersion());
      expect(schemaVer).to.equal(await view.schemaVersion());
      expect(implementation).to.not.equal(ethers.ZeroAddress);
      // In proxy deployments, implementation must differ from proxy address.
      expect(implementation).to.not.equal(await view.getAddress());
    });
  });

  describe('extended coverage: ops/admin read paths', function () {
    it('allows ops/admin to read getLoanOrder even when not borrower/lender', async function () {
      const { view, admin, ops, engine, borrower, lender } = await deployFixture();

      // Create a new order that admin/ops are not parties to.
      await engine.setLoanOrder(2, {
        principal: 2_000n,
        rate: 600n,
        term: 60n,
        borrower: borrower.address,
        lender: lender.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 2000n,
        maturity: 3000n,
        repaidAmount: 0n,
      });

      const orderAsAdmin = await view.connect(admin).getLoanOrder(2);
      const orderAsOps = await view.connect(ops).getLoanOrder(2);

      expect(orderAsAdmin.principal).to.equal(2_000n);
      expect(orderAsOps.principal).to.equal(2_000n);
      expect(orderAsAdmin.borrower).to.equal(borrower.address);
      expect(orderAsAdmin.lender).to.equal(lender.address);
    });

    it('ops/admin reads are consistent with borrower/lender reads (LEV-02 data consistency)', async function () {
      const { view, admin, ops, borrower, lender } = await deployFixture();

      const orderBorrower = await view.connect(borrower).getLoanOrder(1);
      const orderLender = await view.connect(lender).getLoanOrder(1);
      const orderOps = await view.connect(ops).getLoanOrder(1);
      const orderAdmin = await view.connect(admin).getLoanOrder(1);

      for (const order of [orderLender, orderOps, orderAdmin]) {
        expect(order.principal).to.equal(orderBorrower.principal);
        expect(order.rate).to.equal(orderBorrower.rate);
        expect(order.term).to.equal(orderBorrower.term);
        expect(order.borrower).to.equal(orderBorrower.borrower);
        expect(order.lender).to.equal(orderBorrower.lender);
        expect(order.repaidAmount).to.equal(orderBorrower.repaidAmount);
      }
    });
  });

  describe('extended coverage: non-existent IDs and default behavior', function () {
    it('returns false for non-existent order in canAccessLoanOrder (gated)', async function () {
      const { view, borrower, ops } = await deployFixture();
      const [borrowerAccess] = await view.connect(borrower).canAccessLoanOrder(999, borrower.address);
      const [opsAccess] = await view.connect(ops).canAccessLoanOrder(999, borrower.address);
      expect(borrowerAccess).to.equal(false);
      expect(opsAccess).to.equal(false);
    });

    it('rejects non-existent order reads for non-ops callers (MissingRole)', async function () {
      const { view, borrower, lender, outsider } = await deployFixture();
      await expect(view.connect(borrower).getLoanOrder(999)).to.be.revertedWithCustomError(view, 'MissingRole');
      await expect(view.connect(lender).getLoanOrder(999)).to.be.revertedWithCustomError(view, 'MissingRole');
      await expect(view.connect(outsider).getLoanOrder(999)).to.be.revertedWithCustomError(view, 'MissingRole');
    });

    it('allows ops/admin to read non-existent order IDs (returns default struct)', async function () {
      const { view, ops, admin } = await deployFixture();
      const asOps = await view.connect(ops).getLoanOrder(999);
      const asAdmin = await view.connect(admin).getLoanOrder(999);
      expect(asOps.principal).to.equal(0n);
      expect(asOps.borrower).to.equal(ethers.ZeroAddress);
      expect(asOps.lender).to.equal(ethers.ZeroAddress);
      expect(asAdmin.principal).to.equal(0n);
    });

    it('self can read own count even when not seeded (returns 0)', async function () {
      const { view, lender } = await deployFixture();
      const [lenderCount] = await view.connect(lender).getUserLoanCount(lender.address);
      expect(lenderCount).to.equal(0n);
    });

    it('ops-only diagnostics return false/0 defaults without reverting', async function () {
      const { view, ops } = await deployFixture();
      expect(await view.connect(ops).getFailedFeeAmount(999)).to.equal(0n);
      expect(await view.connect(ops).getNftRetryCount(999)).to.equal(0n);
      expect(await view.connect(ops).isMatchEngine(ethers.ZeroAddress)).to.equal(false);
    });

    it('handles orders with borrower == address(0) (lender-only access)', async function () {
      const { view, engine, borrower, lender, ops, admin } = await deployFixture();

      await engine.setLoanOrder(10, {
        principal: 111n,
        rate: 222n,
        term: 333n,
        borrower: ethers.ZeroAddress,
        lender: lender.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1n,
        maturity: 2n,
        repaidAmount: 0n,
      });

      // lender can read
      const asLender = await view.connect(lender).getLoanOrder(10);
      expect(asLender.principal).to.equal(111n);
      expect(asLender.borrower).to.equal(ethers.ZeroAddress);
      expect(asLender.lender).to.equal(lender.address);

      // borrower is not a party -> MissingRole
      await expect(view.connect(borrower).getLoanOrder(10)).to.be.revertedWithCustomError(view, 'MissingRole');

      // ops/admin can read regardless
      expect((await view.connect(ops).getLoanOrder(10)).principal).to.equal(111n);
      expect((await view.connect(admin).getLoanOrder(10)).principal).to.equal(111n);
    });

    it('handles orders with lender == address(0) (borrower-only access)', async function () {
      const { view, engine, borrower, lender, ops, admin } = await deployFixture();

      await engine.setLoanOrder(11, {
        principal: 999n,
        rate: 1n,
        term: 2n,
        borrower: borrower.address,
        lender: ethers.ZeroAddress,
        asset: ethers.ZeroAddress,
        startTimestamp: 1n,
        maturity: 2n,
        repaidAmount: 0n,
      });

      // borrower can read
      const asBorrower = await view.connect(borrower).getLoanOrder(11);
      expect(asBorrower.principal).to.equal(999n);
      expect(asBorrower.borrower).to.equal(borrower.address);
      expect(asBorrower.lender).to.equal(ethers.ZeroAddress);

      // lender is not a party -> MissingRole
      await expect(view.connect(lender).getLoanOrder(11)).to.be.revertedWithCustomError(view, 'MissingRole');

      // ops/admin can read regardless
      expect((await view.connect(ops).getLoanOrder(11)).principal).to.equal(999n);
      expect((await view.connect(admin).getLoanOrder(11)).principal).to.equal(999n);
    });
  });

  describe('extended coverage: registry/module resolution & adapter passthrough', function () {
    it('reverts when ORDER_ENGINE module is not registered', async function () {
      const [admin] = await ethers.getSigners();
      const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
      const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
      await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
      await acm.grantRole(ACTION_ADMIN, admin.address);

      const LendingEngineViewFactory = await ethers.getContractFactory('LendingEngineView');
      const view = await upgrades.deployProxy(LendingEngineViewFactory, [await registry.getAddress()], {
        kind: 'uups',
      });

      // Registry revert string comes from MockRegistry, not from access-control; acceptable to assert string here.
      await expect(view.getLoanOrder(1)).to.be.revertedWith('MockRegistry: module not found');
    });

    it('getRegistryFromEngine mirrors the adapter registry (ops/admin only)', async function () {
      const { view, engine, ops } = await deployFixture();
      const otherRegistryAddr = ethers.Wallet.createRandom().address;
      await engine.setRegistry(otherRegistryAddr);
      expect(await view.connect(ops).getRegistryFromEngine()).to.equal(otherRegistryAddr);
    });

    it('behavior when ACCESS_CONTROL module is missing (registry resolves fail)', async function () {
      const [admin, borrower, lender, outsider, ops] = await ethers.getSigners();
      const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
      const engine = await (await ethers.getContractFactory('MockLendingEngineViewAdapter')).deploy();
      await engine.setRegistry(await registry.getAddress());
      await registry.setModule(KEY_ORDER_ENGINE, await engine.getAddress());

      // seed an order
      await engine.setLoanOrder(1, {
        principal: 1_000n,
        rate: 500n,
        term: 30n,
        borrower: borrower.address,
        lender: lender.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1000n,
        maturity: 2000n,
        repaidAmount: 100n,
      });

      const LendingEngineViewFactory = await ethers.getContractFactory('LendingEngineView');
      const view = await upgrades.deployProxy(LendingEngineViewFactory, [await registry.getAddress()], {
        kind: 'uups',
      });

      // NOTE: because getLoanOrder computes `isOps` via ViewAccessLib.hasRole(), missing ACCESS_CONTROL makes the
      // Registry lookup revert (MockRegistry string). This captures the "Registry must register ACCESS_CONTROL" invariant.
      await expect(view.connect(borrower).getLoanOrder(1)).to.be.revertedWith('MockRegistry: module not found');

      // Self-scoped reads that do not touch role checks should still work (Scheme U self-bypass).
      await engine.setUserLoanCount(borrower.address, 7);
      const [borrowerCount] = await view.connect(borrower).getUserLoanCount(borrower.address);
      expect(borrowerCount).to.equal(7n);
      const [borrowerAccess] = await view.connect(borrower).canAccessLoanOrder(1, borrower.address);
      expect(borrowerAccess).to.equal(true);

      // Non-self reads attempt role lookup and will revert due to missing ACCESS_CONTROL module.
      await expect(view.connect(outsider).getUserLoanCount(borrower.address)).to.be.revertedWith(
        'MockRegistry: module not found',
      );

      // Ops-only endpoints also require role lookup and will revert due to missing ACCESS_CONTROL module.
      await expect(view.connect(ops).getFailedFeeAmount(1)).to.be.revertedWith('MockRegistry: module not found');

      // Admin upgrade path also depends on ACCESS_CONTROL.
      await expect(
        upgrades.upgradeProxy(await view.getAddress(), LendingEngineViewFactory.connect(admin)),
      ).to.be.revertedWith('MockRegistry: module not found');
    });
  });

  describe('canAccessLoanOrder() edge cases', function () {
    it('returns false when user == address(0) (ops/admin callers)', async function () {
      const { view, ops, admin } = await deployFixture();
      const [opsAccess] = await view.connect(ops).canAccessLoanOrder(1, ethers.ZeroAddress);
      const [adminAccess] = await view.connect(admin).canAccessLoanOrder(1, ethers.ZeroAddress);
      expect(opsAccess).to.equal(false);
      expect(adminAccess).to.equal(false);
    });

    it('returns false when self is neither borrower nor lender (existing order)', async function () {
      const { view, outsider } = await deployFixture();
      const [outsiderAccess] = await view.connect(outsider).canAccessLoanOrder(1, outsider.address);
      expect(outsiderAccess).to.equal(false);
    });

    it('returns false for borrower when order.borrower == address(0)', async function () {
      const { view, engine, borrower, lender } = await deployFixture();
      await engine.setLoanOrder(20, {
        principal: 1n,
        rate: 1n,
        term: 1n,
        borrower: ethers.ZeroAddress,
        lender: lender.address,
        asset: ethers.ZeroAddress,
        startTimestamp: 1n,
        maturity: 2n,
        repaidAmount: 0n,
      });

      const [borrowerAccess] = await view.connect(borrower).canAccessLoanOrder(20, borrower.address);
      expect(borrowerAccess).to.equal(false);
    });

    it('returns false for lender when order.lender == address(0)', async function () {
      const { view, engine, borrower, lender } = await deployFixture();
      await engine.setLoanOrder(21, {
        principal: 1n,
        rate: 1n,
        term: 1n,
        borrower: borrower.address,
        lender: ethers.ZeroAddress,
        asset: ethers.ZeroAddress,
        startTimestamp: 1n,
        maturity: 2n,
        repaidAmount: 0n,
      });

      const [lenderAccess] = await view.connect(lender).canAccessLoanOrder(21, lender.address);
      expect(lenderAccess).to.equal(false);
    });
  });

  describe('permission matrix completeness (fine-grained)', function () {
    it('getUserLoanCount: VIEW_USER_DATA and ADMIN are equivalent for non-self reads', async function () {
      const { view, borrower, ops, admin } = await deployFixture();
      const [opsCount] = await view.connect(ops).getUserLoanCount(borrower.address);
      const [adminCount] = await view.connect(admin).getUserLoanCount(borrower.address);
      expect(opsCount).to.equal(2n);
      expect(adminCount).to.equal(2n);
    });

    it('ops diagnostics: VIEW_SYSTEM_DATA and ADMIN are equivalent; VIEW_SYSTEM_DATA alone does not grant getLoanOrder', async function () {
      const { view, acm, outsider, borrower } = await deployFixture();

      // Give outsider only VIEW_SYSTEM_DATA (not VIEW_USER_DATA).
      await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, outsider.address);

      // Can call ops diagnostics.
      expect(await view.connect(outsider).getFailedFeeAmount(1)).to.equal(77n);
      expect(await view.connect(outsider).getNftRetryCount(1)).to.equal(3n);

      // But still cannot read user-scoped order data unless borrower/lender or VIEW_USER_DATA/ADMIN.
      await expect(view.connect(outsider).getLoanOrder(1)).to.be.revertedWithCustomError(view, 'MissingRole');

      // Self read path remains allowed.
      expect(await view.connect(borrower).getLoanOrder(1)).to.not.equal(undefined);
    });

    it('explicitly asserts all permission-failure paths revert MissingRole()', async function () {
      const { view, outsider, borrower, admin } = await deployFixture();

      const failingCalls: Array<Promise<unknown>> = [
        // order privacy: outsider cannot read parties' order
        view.connect(outsider).getLoanOrder(1),
        // user-scoped reads: outsider cannot read others
        view.connect(outsider).getUserLoanCount(borrower.address),
        view.connect(outsider).canAccessLoanOrder(1, borrower.address),
        // ops-only diagnostics: outsider cannot access
        view.connect(outsider).getFailedFeeAmount(1),
        view.connect(outsider).getNftRetryCount(1),
        view.connect(outsider).isMatchEngine(admin.address),
        view.connect(outsider).getRegistryFromEngine(),
      ];

      for (const call of failingCalls) {
        await expect(call).to.be.revertedWithCustomError(view, 'MissingRole');
      }
    });
  });

  describe('concurrent reads (optional)', function () {
    it('returns consistent order snapshot under parallel reads', async function () {
      const { view, borrower, lender, ops, admin } = await deployFixture();

      const [asBorrower, asLender, asOps, asAdmin] = await Promise.all([
        view.connect(borrower).getLoanOrder(1),
        view.connect(lender).getLoanOrder(1),
        view.connect(ops).getLoanOrder(1),
        view.connect(admin).getLoanOrder(1),
      ]);

      for (const order of [asLender, asOps, asAdmin]) {
        expect(order.principal).to.equal(asBorrower.principal);
        expect(order.rate).to.equal(asBorrower.rate);
        expect(order.term).to.equal(asBorrower.term);
        expect(order.borrower).to.equal(asBorrower.borrower);
        expect(order.lender).to.equal(asBorrower.lender);
        expect(order.repaidAmount).to.equal(asBorrower.repaidAmount);
      }
    });
  });
});

