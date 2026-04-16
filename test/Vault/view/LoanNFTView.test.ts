import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { FunctionFragment } from 'ethers';

const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
const KEY_LOAN_NFT = ethers.keccak256(ethers.toUtf8Bytes('LOAN_NFT'));

const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
const ACTION_VIEW_USER_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA'));

describe('LoanNFTView', function () {
  async function deployFixture() {
    const [admin, borrower, outsider, ops] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
    const loanNft = await (await ethers.getContractFactory('MockLoanNFTEnumerable')).deploy();

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(KEY_LOAN_NFT, await loanNft.getAddress());

    await acm.grantRole(ACTION_ADMIN, admin.address);
    await acm.grantRole(ACTION_VIEW_USER_DATA, ops.address);

    // seed borrower with 3 tokens
    await loanNft.seedToken(borrower.address, 10, 1, 0); // Active
    await loanNft.seedToken(borrower.address, 11, 2, 1); // Repaid
    await loanNft.seedToken(borrower.address, 12, 3, 2); // Liquidated

    const LoanNFTViewFactory = await ethers.getContractFactory('LoanNFTView');
    const view = await upgrades.deployProxy(LoanNFTViewFactory, [await registry.getAddress()], {
      kind: 'uups',
    });

    return { view, registry, acm, loanNft, admin, borrower, outsider, ops };
  }

  describe('responsibility boundary (read-only, no push*)', function () {
    it('has no push* functions and no unexpected non-view externals', async function () {
      const { view } = await deployFixture();

      const functionFragments = view.interface.fragments.filter(
        (f): f is FunctionFragment => f.type === 'function',
      );

      const pushFns = functionFragments.filter((f) => f.name.startsWith('push'));
      expect(pushFns.map((f) => f.name)).to.deep.equal([]);

      const nonView = functionFragments.filter((f) => !['view', 'pure'].includes(f.stateMutability));
      for (const fn of nonView) {
        const isAllowed = fn.name === 'initialize' || fn.name.startsWith('upgradeTo') || fn.name === 'upgradeToAndCall';
        expect(
          isAllowed,
          `unexpected non-view external function: ${fn.name}(${fn.inputs.map((i) => i.type).join(',')})`,
        ).to.equal(true);
      }

      const eventNames = view.interface.fragments
        .filter((f) => f.type === 'event')
        .map((f) => (f as any).name);
      expect(eventNames).to.not.include('DataPushed');

      const selectors = functionFragments.map((f) => view.interface.getFunction(f.format())!.selector);
      expect(selectors.length).to.equal(new Set(selectors).size);
    });
  });

  describe('user-scoped gate (self vs ops/admin)', function () {
    it('allows self to read getUserLoanCount(user)', async function () {
      const { view, borrower } = await deployFixture();
      const [count, isValid] = await view.connect(borrower).getUserLoanCount(borrower.address);
      expect(count).to.equal(3n);
      expect(isValid).to.equal(true);
    });

    it('rejects outsider reading getUserLoanCount(user)', async function () {
      const { view, borrower, outsider } = await deployFixture();
      await expect(view.connect(outsider).getUserLoanCount(borrower.address)).to.be.revertedWithCustomError(
        view,
        'MissingRole',
      );
    });

    it('allows ops with VIEW_USER_DATA to read other user', async function () {
      const { view, borrower, ops } = await deployFixture();
      const [count] = await view.connect(ops).getUserLoanCount(borrower.address);
      expect(count).to.equal(3n);
    });
  });

  describe('pagination', function () {
    it('returns token ids paginated + total count', async function () {
      const { view, borrower } = await deployFixture();

      const [page1, total1] = await view.connect(borrower).getUserTokenIdsPaginated(borrower.address, 0, 2);
      expect(total1).to.equal(3n);
      expect(page1.map((x: bigint) => x.toString())).to.deep.equal(['10', '11']);

      const [page2, total2] = await view.connect(borrower).getUserTokenIdsPaginated(borrower.address, 2, 2);
      expect(total2).to.equal(3n);
      expect(page2.map((x: bigint) => x.toString())).to.deep.equal(['12']);

      const [empty, total3] = await view.connect(borrower).getUserTokenIdsPaginated(borrower.address, 3, 2);
      expect(total3).to.equal(3n);
      expect(empty).to.deep.equal([]);
    });

    it('returns (tokenId, orderId, status) paginated', async function () {
      const { view, borrower } = await deployFixture();

      const [items, total] = await view.connect(borrower).getUserLoansPaginated(borrower.address, 0, 3);
      expect(total).to.equal(3n);

      expect(items.length).to.equal(3);
      expect(items[0].tokenId).to.equal(10n);
      expect(items[0].orderId).to.equal(1n);
      expect(items[0].status).to.equal(0n);

      expect(items[2].tokenId).to.equal(12n);
      expect(items[2].orderId).to.equal(3n);
      expect(items[2].status).to.equal(2n);
    });

    it('reverts on limit=0', async function () {
      const { view, borrower } = await deployFixture();
      await expect(view.connect(borrower).getUserTokenIdsPaginated(borrower.address, 0, 0)).to.be.revertedWithCustomError(
        view,
        'LoanNFTView__InvalidLimit',
      );
    });

    it('reverts on limit > MAX_BATCH_SIZE', async function () {
      const { view, borrower } = await deployFixture();
      await expect(view.connect(borrower).getUserTokenIdsPaginated(borrower.address, 0, 101)).to.be.revertedWithCustomError(
        view,
        'BatchTooLarge',
      );
    });
  });

  describe('upgrade authorization', function () {
    it('allows admin to upgrade', async function () {
      const { view, admin } = await deployFixture();
      const LoanNFTViewFactory = await ethers.getContractFactory('LoanNFTView');
      await upgrades.upgradeProxy(await view.getAddress(), LoanNFTViewFactory.connect(admin));
    });

    it('reverts upgrade when caller is not admin', async function () {
      const { view, outsider, acm } = await deployFixture();
      const LoanNFTViewFactory = await ethers.getContractFactory('LoanNFTView');
      await expect(upgrades.upgradeProxy(await view.getAddress(), LoanNFTViewFactory.connect(outsider))).to.be
        .revertedWithCustomError(acm, 'MissingRole');
    });
  });

  describe('initialization (basic sanity)', function () {
    it('stores registry and exposes getters', async function () {
      const { view, registry } = await deployFixture();
      expect(await view.getRegistry()).to.equal(await registry.getAddress());
      expect(await view.getRegistry()).to.equal(await registry.getAddress());
    });

    it('reverts on zero address init', async function () {
      const LoanNFTViewFactory = await ethers.getContractFactory('LoanNFTView');
      const impl = await LoanNFTViewFactory.deploy();
      await impl.waitForDeployment();

      await expect(upgrades.deployProxy(LoanNFTViewFactory, [ethers.ZeroAddress], { kind: 'uups' })).to.be
        .revertedWithCustomError(impl, 'ZeroAddress');
    });

    it('reverts on EOA init (NotAContract)', async function () {
      const [eoa] = await ethers.getSigners();
      const LoanNFTViewFactory = await ethers.getContractFactory('LoanNFTView');
      const impl = await LoanNFTViewFactory.deploy();
      await impl.waitForDeployment();

      await expect(upgrades.deployProxy(LoanNFTViewFactory, [eoa.address], { kind: 'uups' })).to.be.revertedWithCustomError(
        impl,
        'NotAContract',
      );
    });

    it('uninitialized implementation rejects read APIs (ZeroAddress)', async function () {
      const LoanNFTViewFactory = await ethers.getContractFactory('LoanNFTView');
      const impl = await LoanNFTViewFactory.deploy();
      await impl.waitForDeployment();

      await expect(impl.getUserLoanCount(ethers.ZeroAddress)).to.be.revertedWithCustomError(impl, 'ZeroAddress');
      await expect(impl.getUserTokenIdsPaginated(ethers.ZeroAddress, 0, 1)).to.be.revertedWithCustomError(
        impl,
        'ZeroAddress',
      );
      await expect(impl.getUserLoansPaginated(ethers.ZeroAddress, 0, 1)).to.be.revertedWithCustomError(
        impl,
        'ZeroAddress',
      );
    });
  });
});
