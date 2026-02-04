import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import type {
  UserView,
  MockRegistry,
  MockAccessControlManager,
  MockPositionViewBatch,
  MockHealthViewBatch,
  MockPreviewView,
  MockERC20
} from '../../../types';

const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
const KEY_POSITION_VIEW = ethers.keccak256(ethers.toUtf8Bytes('POSITION_VIEW'));
const KEY_HEALTH_VIEW = ethers.keccak256(ethers.toUtf8Bytes('HEALTH_VIEW'));
const KEY_PREVIEW_VIEW = ethers.keccak256(ethers.toUtf8Bytes('PREVIEW_VIEW'));
const KEY_STATS = ethers.keccak256(ethers.toUtf8Bytes('VAULT_STATISTICS'));
const KEY_SETTLEMENT_TOKEN = ethers.keccak256(ethers.toUtf8Bytes('SETTLEMENT_TOKEN'));
const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
const MAX_BATCH_SIZE = 100;

describe('UserView', function () {
  async function deployFixture() {
    const [admin, user, other] = await ethers.getSigners();

    const RegistryF = await ethers.getContractFactory('MockRegistry');
    const registry = (await RegistryF.deploy()) as unknown as MockRegistry;

    const ACMF = await ethers.getContractFactory('MockAccessControlManager');
    const acm = (await ACMF.deploy()) as unknown as MockAccessControlManager;
    await acm.grantRole(ACTION_ADMIN, admin.address);

    const PositionF = await ethers.getContractFactory('MockPositionViewBatch');
    const position = (await PositionF.deploy()) as unknown as MockPositionViewBatch;

    const HealthF = await ethers.getContractFactory('MockHealthViewBatch');
    const health = (await HealthF.deploy()) as unknown as MockHealthViewBatch;

    const PreviewF = await ethers.getContractFactory('MockPreviewView');
    const preview = (await PreviewF.deploy()) as unknown as MockPreviewView;

    const StatsF = await ethers.getContractFactory('MockStatisticsViewUserSnapshot');
    const stats = await StatsF.deploy();

    const TokenF = await ethers.getContractFactory('MockERC20');
    const token = (await TokenF.deploy(
      'Test Token',
      'TEST',
      18,
      ethers.parseUnits('1000000', 18)
    )) as unknown as MockERC20;

    const tokenAddr = await token.getAddress();
    await position.setPosition(user.address, tokenAddr, ethers.parseUnits('100', 18), ethers.parseUnits('40', 18));
    await health.setHealth(user.address, 12_000, true);
    await preview.setPreviewBorrow(user.address, tokenAddr, 12_000, 4_000, ethers.parseUnits('10', 18));
    await preview.setPreviewDeposit(user.address, tokenAddr, 11_000, true);
    await preview.setPreviewRepay(user.address, tokenAddr, 13_000, 3_000);
    await preview.setPreviewWithdraw(user.address, tokenAddr, 10_000, true);

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(KEY_POSITION_VIEW, await position.getAddress());
    await registry.setModule(KEY_HEALTH_VIEW, await health.getAddress());
    await registry.setModule(KEY_PREVIEW_VIEW, await preview.getAddress());
    await registry.setModule(KEY_STATS, await stats.getAddress());
    await registry.setModule(KEY_SETTLEMENT_TOKEN, tokenAddr);

    const UserViewF = await ethers.getContractFactory('UserView');
    const userView = (await upgrades.deployProxy(UserViewF, [await registry.getAddress()])) as unknown as UserView;

    return { admin, user, other, registry, acm, position, health, preview, token, userView, stats };
  }

  describe('initialize', function () {
    it('reverts on zero registry', async function () {
      const UserViewF = await ethers.getContractFactory('UserView');
      await expect(upgrades.deployProxy(UserViewF, [ethers.ZeroAddress])).to.be.revertedWithCustomError(
        UserViewF,
        'ZeroAddress'
      );
    });

    it('stores registry address', async function () {
      const { userView, registry } = await loadFixture(deployFixture);
      expect(await userView.getRegistry()).to.equal(await registry.getAddress());
    });
  });

  describe('position queries', function () {
    it('returns data from PositionView', async function () {
      const { userView, user, token } = await loadFixture(deployFixture);
      const [c, d] = await userView.getUserPositionWithMeta(user.address, await token.getAddress());
      expect(c).to.equal(ethers.parseUnits('100', 18));
      expect(d).to.equal(ethers.parseUnits('40', 18));
    });

    it('returns zero when position module missing', async function () {
      const { userView, registry, user, token } = await loadFixture(deployFixture);
      await registry.setModule(KEY_POSITION_VIEW, ethers.ZeroAddress);
      const [c, d] = await userView.getUserPositionWithMeta(user.address, await token.getAddress());
      expect(c).to.equal(0n);
      expect(d).to.equal(0n);
    });
  });

  describe('health factor', function () {
    it('returns value from HealthView', async function () {
      const { userView, user } = await loadFixture(deployFixture);
      const [hf] = await userView.getHealthFactor(user.address);
      expect(hf).to.equal(12_000n);
    });

    it('returns zero when health module missing', async function () {
      const { userView, registry, user } = await loadFixture(deployFixture);
      await registry.setModule(KEY_HEALTH_VIEW, ethers.ZeroAddress);
      const [hf] = await userView.getHealthFactor(user.address);
      expect(hf).to.equal(0n);
    });
  });

  describe('stats aggregation', function () {
    it('calculates stats using view modules', async function () {
      const { userView, user, token } = await loadFixture(deployFixture);
      const [stats] = await userView.getUserStats(user.address, await token.getAddress());
      expect(stats.collateral).to.equal(ethers.parseUnits('100', 18));
      expect(stats.debt).to.equal(ethers.parseUnits('40', 18));
      expect(stats.hf).to.equal(12_000n);
      expect(stats.ltv).to.be.greaterThan(0n);
    });
  });

  describe('ARCH 4.7 UV-01: facade MUST NOT drop downstream validity/meta', function () {
    it('getUserPositionWithMeta matches downstream PositionView meta (isValid/blockNumber/version)', async function () {
      const { userView, user, token, position } = await loadFixture(deployFixture);

      const blk = await ethers.provider.getBlock('latest');
      const base = BigInt(blk!.number);
      const pBlockNumber = base > 11n ? base - 11n : base;
      const pVer = 42n;

      await position.setPositionWithMeta(
        user.address,
        await token.getAddress(),
        ethers.parseUnits('123', 18),
        ethers.parseUnits('45', 18),
        false,
        pBlockNumber,
        pVer
      );

      const downstream = await position.getUserPositionWithMeta(user.address, await token.getAddress());
      const facade = await userView.getUserPositionWithMeta(user.address, await token.getAddress());

      expect(facade).to.deep.equal(downstream);
    });

    it('getUserStatsWithMeta preserves position + health meta alongside business fields', async function () {
      const { userView, user, token, position, health } = await loadFixture(deployFixture);

      const blk = await ethers.provider.getBlock('latest');
      const base = BigInt(blk!.number);
      const pBlockNumber = base > 33n ? base - 33n : base;
      const hBlockNumber = base > 22n ? base - 22n : base;
      const pVer = 9n;

      await position.setPositionWithMeta(
        user.address,
        await token.getAddress(),
        ethers.parseUnits('200', 18),
        ethers.parseUnits('50', 18),
        true,
        pBlockNumber,
        pVer
      );
      await health.setHealthWithTimestamp(user.address, 11_000, false, hBlockNumber);

      const [stats, positionIsValid, positionBlockNumber, positionVersion, healthIsValid, healthBlockNumber] =
        await userView.getUserStatsWithMeta(user.address, await token.getAddress());

      expect(stats.collateral).to.equal(ethers.parseUnits('200', 18));
      expect(stats.debt).to.equal(ethers.parseUnits('50', 18));
      expect(stats.hf).to.equal(11_000n);
      expect(stats.ltv).to.be.greaterThan(0n);

      expect(positionIsValid).to.equal(true);
      expect(positionBlockNumber).to.equal(pBlockNumber);
      expect(positionVersion).to.equal(pVer);
      expect(healthIsValid).to.equal(false);
      expect(healthBlockNumber).to.equal(hBlockNumber);
    });

    it('getUserTotalsWithMeta preserves StatisticsView meta (isValid/blockNumber/version/seq)', async function () {
      const { userView, user, stats } = await loadFixture(deployFixture);

      const blk = await ethers.provider.getBlock('latest');
      const blockNumber = BigInt(blk!.number);
      await stats.setUserSnapshot(user.address, 123n, 45n, 0n, 0n, blockNumber, true, 7);

      const downstream = await stats.getUserSnapshotWithMeta(user.address);
      const [s, v, seq, , isValid, downstreamBlockNumber] = downstream;

      const [tc, td, fValid, fBlockNumber, fVer, fSeq] = await userView.getUserTotalsWithMeta(user.address);

      expect(tc).to.equal(s.collateral);
      expect(td).to.equal(s.debt);
      expect(fValid).to.equal(isValid);
      expect(fBlockNumber).to.equal(downstreamBlockNumber);
      expect(fVer).to.equal(v);
      expect(fSeq).to.equal(seq);
    });
  });

  describe('ARCH 4.7: totals MUST NOT use asset=0 placeholder', function () {
    it('getUserTotalsWithMeta reads from StatisticsView (not PositionView address(0))', async function () {
      const { userView, user, stats, registry } = await loadFixture(deployFixture);

      // Make PositionView missing to ensure totals still work (i.e. not calling getUserPosition(user, address(0))).
      await registry.setModule(KEY_POSITION_VIEW, ethers.ZeroAddress);

      // Seed user snapshot in stats mock (blockNumber = now)
      const blk = await ethers.provider.getBlock('latest');
      const blockNumber = BigInt(blk!.number);
      await stats.setUserSnapshot(user.address, 123n, 45n, 0n, 0n, blockNumber, true, 7);

      const [tc, td, isValid, blockNumberOut, version, seq] = await userView.getUserTotalsWithMeta(user.address);
      expect(tc).to.equal(123n);
      expect(td).to.equal(45n);
      expect(isValid).to.equal(true);
      expect(blockNumberOut).to.equal(blockNumber);
      expect(version).to.equal(7n);
      expect(seq).to.equal(0n);

      // Legacy helpers should forward to totals (no asset=0 semantics).
      const [totalCollateral] = await userView.getUserTotalCollateral(user.address);
      const [totalDebt] = await userView.getUserTotalDebt(user.address);
      expect(totalCollateral).to.equal(123n);
      expect(totalDebt).to.equal(45n);
    });
  });

  describe('ARCH 4.7 UV-02: no business write/push entrypoints', function () {
    it('exposes no push* or pushData functions in ABI', async function () {
      const { userView } = await loadFixture(deployFixture);

      const funcFragments = userView.interface.fragments.filter((f: any) => f.type === 'function');
      const names: string[] = funcFragments.map((f: any) => f.name);

      expect(names.some((n) => n.toLowerCase().startsWith('push'))).to.equal(false);
      expect(names.includes('pushData')).to.equal(false);
    });

    it('has no writable entrypoints besides initialize/upgrade plumbing', async function () {
      const { userView } = await loadFixture(deployFixture);

      const funcFragments = userView.interface.fragments.filter((f: any) => f.type === 'function');
      const writable = funcFragments.filter(
        (f: any) => !['view', 'pure'].includes(String(f.stateMutability))
      );
      const writableNames = Array.from(new Set(writable.map((f: any) => f.name)));

      const allowed = new Set(['initialize', 'upgradeTo', 'upgradeToAndCall']);
      for (const n of writableNames) {
        expect(allowed.has(n), `unexpected writable function in UserView ABI: ${n}`).to.equal(true);
      }
    });
  });

  describe('selector constants (explicit)', function () {
    function sigSelector(sig: string): string {
      // ethers.id() == keccak256(utf8(sig)); selector == first 4 bytes
      return ethers.id(sig).slice(0, 10);
    }

    it('matches canonical signatures and SSOT module ABIs', async function () {
      const HarnessF = await ethers.getContractFactory('UserViewSelectorHarness');
      const harness = await HarnessF.deploy();

      const positionIface = (await ethers.getContractFactory('PositionView')).interface;
      const healthIface = (await ethers.getContractFactory('HealthView')).interface;
      const statsIface = (await ethers.getContractFactory('StatisticsView')).interface;
      const previewIface = (await ethers.getContractFactory('PreviewView')).interface;

      // ---- PositionView selectors ----
      expect(await harness.selGetUserPositionWithMeta()).to.equal(sigSelector('getUserPositionWithMeta(address,address)'));
      expect(await harness.selGetUserPositionWithMeta()).to.equal(
        positionIface.getFunction('getUserPositionWithMeta')!.selector
      );
      expect(await harness.selBatchGetUserPositions()).to.equal(
        sigSelector('batchGetUserPositionsWithMeta(address[],address[])')
      );
      expect(await harness.selBatchGetUserPositions()).to.equal(
        positionIface.getFunction('batchGetUserPositionsWithMeta')!.selector
      );

      // ---- HealthView selectors ----
      expect(await harness.selGetUserHealthFactorWithMeta()).to.equal(sigSelector('getUserHealthFactorWithMeta(address)'));
      expect(await harness.selGetUserHealthFactorWithMeta()).to.equal(
        healthIface.getFunction('getUserHealthFactorWithMeta')!.selector
      );
      expect(await harness.selBatchGetHealthFactorsWithMeta()).to.equal(sigSelector('batchGetHealthFactorsWithMeta(address[])'));
      expect(await harness.selBatchGetHealthFactorsWithMeta()).to.equal(
        healthIface.getFunction('batchGetHealthFactorsWithMeta')!.selector
      );

      // ---- StatisticsView selectors ----
      expect(await harness.selGetUserSnapshotWithMeta()).to.equal(sigSelector('getUserSnapshotWithMeta(address)'));
      expect(await harness.selGetUserSnapshotWithMeta()).to.equal(
        statsIface.getFunction('getUserSnapshotWithMeta')!.selector
      );

      // ---- PreviewView selectors ----
      expect(await harness.selPreviewBorrow()).to.equal(
        sigSelector('previewBorrow(address,address,uint256,uint256,uint256)')
      );
      expect(await harness.selPreviewBorrow()).to.equal(previewIface.getFunction('previewBorrow')!.selector);

      expect(await harness.selPreviewDeposit()).to.equal(sigSelector('previewDeposit(address,address,uint256)'));
      expect(await harness.selPreviewDeposit()).to.equal(previewIface.getFunction('previewDeposit')!.selector);

      expect(await harness.selPreviewRepay()).to.equal(sigSelector('previewRepay(address,address,uint256)'));
      expect(await harness.selPreviewRepay()).to.equal(previewIface.getFunction('previewRepay')!.selector);

      expect(await harness.selPreviewWithdraw()).to.equal(sigSelector('previewWithdraw(address,address,uint256)'));
      expect(await harness.selPreviewWithdraw()).to.equal(previewIface.getFunction('previewWithdraw')!.selector);

      // ---- ERC20 selector ----
      expect(await harness.selBalanceOf()).to.equal(sigSelector('balanceOf(address)'));
      expect(await harness.selBalanceOf()).to.equal('0x70a08231');
    });

    it('matches encoded calldata prefixes (sanity)', async function () {
      const HarnessF = await ethers.getContractFactory('UserViewSelectorHarness');
      const harness = await HarnessF.deploy();

      const user = ethers.Wallet.createRandom().address;
      const asset = ethers.Wallet.createRandom().address;
      const users = [user];
      const assets = [asset];

      const positionIface = (await ethers.getContractFactory('PositionView')).interface;
      const healthIface = (await ethers.getContractFactory('HealthView')).interface;
      const statsIface = (await ethers.getContractFactory('StatisticsView')).interface;
      const previewIface = (await ethers.getContractFactory('PreviewView')).interface;

      const p1 = positionIface.encodeFunctionData('getUserPositionWithMeta', [user, asset]).slice(0, 10);
      expect(p1).to.equal(await harness.selGetUserPositionWithMeta());

      const p2 = positionIface.encodeFunctionData('batchGetUserPositionsWithMeta', [users, assets]).slice(0, 10);
      expect(p2).to.equal(await harness.selBatchGetUserPositions());

      const h1 = healthIface.encodeFunctionData('getUserHealthFactorWithMeta', [user]).slice(0, 10);
      expect(h1).to.equal(await harness.selGetUserHealthFactorWithMeta());

      const h2 = healthIface.encodeFunctionData('batchGetHealthFactorsWithMeta', [users]).slice(0, 10);
      expect(h2).to.equal(await harness.selBatchGetHealthFactorsWithMeta());

      const s1 = statsIface.encodeFunctionData('getUserSnapshotWithMeta', [user]).slice(0, 10);
      expect(s1).to.equal(await harness.selGetUserSnapshotWithMeta());

      const pv1 = previewIface.encodeFunctionData('previewBorrow', [user, asset, 0, 0, 0]).slice(0, 10);
      expect(pv1).to.equal(await harness.selPreviewBorrow());
    });
  });

  describe('settlement token balance (authority path)', function () {
    it('getUserSettlementBalanceStrict reads SETTLEMENT_TOKEN.balanceOf', async function () {
      const { userView, user, token } = await loadFixture(deployFixture);
      // MockERC20 initial supply minted to deployer; transfer to user
      await token.transfer(user.address, 777n);
      const [balance] = await userView.getUserSettlementBalanceStrict(user.address);
      expect(balance).to.equal(777n);
    });
  });

  describe('preview calls', function () {
    it('returns preview data when module present', async function () {
      const { userView, user, token } = await loadFixture(deployFixture);
      const [hf, ltv, maxBorrowable] = await userView.previewBorrow(user.address, await token.getAddress(), 0, 0, 0);
      expect(hf).to.equal(12_000n);
      expect(ltv).to.equal(4_000n);
      expect(maxBorrowable).to.equal(ethers.parseUnits('10', 18));
    });

    it('returns zeros when preview module missing', async function () {
      const { userView, registry, user, token } = await loadFixture(deployFixture);
      await registry.setModule(KEY_PREVIEW_VIEW, ethers.ZeroAddress);
      const [hf, ltv, maxBorrowable] = await userView.previewBorrow(user.address, await token.getAddress(), 0, 0, 0);
      expect(hf).to.equal(0n);
      expect(ltv).to.equal(0n);
      expect(maxBorrowable).to.equal(0n);
    });
  });

  describe('batch queries', function () {
    it('returns arrays from position view', async function () {
      const { userView, user, other, token, position } = await loadFixture(deployFixture);
      await position.setPosition(other.address, await token.getAddress(), ethers.parseUnits('1', 18), 0);
      const users = [user.address, other.address];
      const assets = [await token.getAddress(), await token.getAddress()];
      const [collaterals, debts] = await userView.batchGetUserPositions(users, assets);
      expect(collaterals).to.deep.equal([ethers.parseUnits('100', 18), ethers.parseUnits('1', 18)]);
      expect(debts).to.deep.equal([ethers.parseUnits('40', 18), 0n]);
    });

    it('falls back to zero arrays when module missing', async function () {
      const { userView, registry, user, token } = await loadFixture(deployFixture);
      await registry.setModule(KEY_POSITION_VIEW, ethers.ZeroAddress);
      const [collaterals, debts] = await userView.batchGetUserPositions([user.address], [await token.getAddress()]);
      expect(collaterals[0]).to.equal(0n);
      expect(debts[0]).to.equal(0n);
    });

    it('reverts on length mismatch', async function () {
      const { userView, user, token } = await loadFixture(deployFixture);
      await expect(userView.batchGetUserPositions([user.address], [])).to.be.revertedWithCustomError(
        userView,
        'ArrayLengthMismatch'
      );
    });

    it('reverts on oversized batch', async function () {
      const { userView, user, token } = await loadFixture(deployFixture);
      const users = Array(MAX_BATCH_SIZE + 1).fill(user.address);
      const assets = Array(MAX_BATCH_SIZE + 1).fill(await token.getAddress());
      await expect(userView.batchGetUserPositions(users, assets)).to.be.revertedWithCustomError(
        userView,
        'BatchTooLarge'
      );
    });

    it('returns health factors from module', async function () {
      const { userView, user, other, health } = await loadFixture(deployFixture);
      await health.setHealth(other.address, 9_000, true);
      const factors = await userView.batchGetUserHealthFactors([user.address, other.address]);
      expect(factors).to.deep.equal([12_000n, 9_000n]);
    });

    it('returns zeroed array when health module missing', async function () {
      const { userView, registry, user } = await loadFixture(deployFixture);
      await registry.setModule(KEY_HEALTH_VIEW, ethers.ZeroAddress);
      const factors = await userView.batchGetUserHealthFactors([user.address]);
      expect(factors[0]).to.equal(0n);
    });

    it('reverts on oversized health batch', async function () {
      const { userView, user } = await loadFixture(deployFixture);
      const users = Array(MAX_BATCH_SIZE + 1).fill(user.address);
      await expect(userView.batchGetUserHealthFactors(users)).to.be.revertedWithCustomError(
        userView,
        'BatchTooLarge'
      );
    });
  });

  describe('upgrade authorization', function () {
    it('requires ACTION_ADMIN role', async function () {
      const { userView, other, acm } = await loadFixture(deployFixture);
      const impl = await (await ethers.getContractFactory('UserView')).deploy();
      await expect(userView.connect(other).upgradeToAndCall(impl.target, '0x')).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('admin can upgrade to a new implementation', async function () {
      const { userView, admin } = await loadFixture(deployFixture);
      const impl = await (await ethers.getContractFactory('UserView')).deploy();
      await expect(userView.connect(admin).upgradeToAndCall(impl.target, '0x')).to.emit(userView, 'Upgraded');
    });
  });

  describe('SSOT callsite assertions (trap ACM)', function () {
    it('user-dimensional gate MUST use hasRole (must not call ACM.requireRole)', async function () {
      const [, user, other] = await ethers.getSigners();

      const RegistryF = await ethers.getContractFactory('MockRegistry');
      const registry = await RegistryF.deploy();

      const TrapACMF = await ethers.getContractFactory('MockAccessControlManagerTrapRequireRole');
      const acm = await TrapACMF.deploy();

      await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

      const UserViewF = await ethers.getContractFactory('UserView');
      const userView = await upgrades.deployProxy(UserViewF, [await registry.getAddress()]);

      // non-self: should be rejected by UserView's Scheme U gate without invoking requireRole().
      await expect(
        userView.connect(other).getUserPositionWithMeta(user.address, ethers.Wallet.createRandom().address),
      ).to.be.revertedWithCustomError(userView, 'MissingRole');
    });

    it('batch user gate MUST use hasRole and has no self-bypass (must not call ACM.requireRole)', async function () {
      const [admin] = await ethers.getSigners();

      const RegistryF = await ethers.getContractFactory('MockRegistry');
      const registry = await RegistryF.deploy();

      const TrapACMF = await ethers.getContractFactory('MockAccessControlManagerTrapRequireRole');
      const acm = await TrapACMF.deploy();

      await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

      const UserViewF = await ethers.getContractFactory('UserView');
      const userView = await upgrades.deployProxy(UserViewF, [await registry.getAddress()]);

      // users[] batch: even if querying only self, caller must be ops/admin.
      await expect(
        userView.connect(admin).batchGetUserPositions([admin.address], [ethers.Wallet.createRandom().address]),
      ).to.be.revertedWithCustomError(userView, 'MissingRole');
    });

    it('upgrade authorization MUST use requireRole (must not call ACM.hasRole)', async function () {
      const [, other] = await ethers.getSigners();

      const RegistryF = await ethers.getContractFactory('MockRegistry');
      const registry = await RegistryF.deploy();

      const ACMF = await ethers.getContractFactory('MockAccessControlManager');
      const acm = await ACMF.deploy();
      await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

      const UserViewF = await ethers.getContractFactory('UserView');
      const userView = await upgrades.deployProxy(UserViewF, [await registry.getAddress()]);

      const impl = await (await ethers.getContractFactory('UserView')).deploy();
      await expect(userView.connect(other).upgradeToAndCall(impl.target, '0x')).to.be.revertedWithCustomError(
        userView,
        'MissingRole',
      );
    });
  });
});