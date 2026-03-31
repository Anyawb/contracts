import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { ethers, upgrades } from 'hardhat';

const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
const KEY_VAULT_CORE = ethers.keccak256(ethers.toUtf8Bytes('VAULT_CORE'));
const KEY_FR = ethers.keccak256(ethers.toUtf8Bytes('FEE_ROUTER'));

const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
const ACTION_DEPOSIT = ethers.keccak256(ethers.toUtf8Bytes('DEPOSIT'));
const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));

function calcExpectedFee(amount: bigint): bigint {
  return amount * 10n / 10000n;
}

describe('Funds Flow FeeRouter gateway integration', function () {
  async function deployFixture(includeFeeRouterView = true) {
    const [owner, alice, treasury, ecoVault, newTreasury, newEcoVault] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
    const assetWhitelist = await (await ethers.getContractFactory('MockAssetWhitelist')).deploy();
    const priceOracle = await (await ethers.getContractFactory('MockPriceOracle')).deploy();
    const settlementToken = await (await ethers.getContractFactory('MockERC20')).deploy(
      'Settlement',
      'SET',
      18,
      ethers.parseUnits('1000000', 18),
    );

    const VaultRouterFactory = await ethers.getContractFactory('VaultRouter');
    const vaultRouter = await upgrades.deployProxy(
      VaultRouterFactory,
      [await registry.getAddress(), await assetWhitelist.getAddress(), await priceOracle.getAddress(), await settlementToken.getAddress(), owner.address],
      { kind: 'uups', initializer: 'initialize' },
    );

    const vaultCore = await (await ethers.getContractFactory('MockVaultCoreView')).deploy();
    await vaultCore.setViewContractAddr(await vaultRouter.getAddress());

    const FeeRouterFactory = await ethers.getContractFactory('FeeRouter');
    const feeRouter = await upgrades.deployProxy(
      FeeRouterFactory,
      [await registry.getAddress(), treasury.address, ecoVault.address, 9, 1],
      { kind: 'uups', initializer: 'initialize' },
    );

    let feeRouterView: Awaited<ReturnType<typeof upgrades.deployProxy>> | null = null;
    if (includeFeeRouterView) {
      const FeeRouterViewFactory = await ethers.getContractFactory('FeeRouterView');
      feeRouterView = await upgrades.deployProxy(FeeRouterViewFactory, [await registry.getAddress()], {
        kind: 'uups',
        initializer: 'initialize',
      });
    }

    const token = await (await ethers.getContractFactory('MockERC20')).deploy(
      'Mock USDC',
      'USDC',
      6,
      ethers.parseUnits('2000000', 6),
    );

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(KEY_VAULT_CORE, await vaultCore.getAddress());
    await registry.setModule(KEY_FR, await feeRouter.getAddress());

    await acm.grantRole(ACTION_SET_PARAMETER, owner.address);
    await acm.grantRole(ACTION_DEPOSIT, alice.address);
    await acm.grantRole(ACTION_ADMIN, owner.address);

    if (feeRouterView) {
      await (vaultRouter.connect(owner) as any).setFeeRouterView(await feeRouterView.getAddress());
    }

    await feeRouter.connect(owner).addSupportedToken(await token.getAddress());
    await token.transfer(alice.address, ethers.parseUnits('10000', 6));

    return {
      owner,
      alice,
      treasury,
      ecoVault,
      newTreasury,
      newEcoVault,
      vaultRouter,
      feeRouter,
      feeRouterView,
      token,
    };
  }

  async function deployFixtureWithoutFeeRouterView() {
    return deployFixture(false);
  }

  it('routes FeeRouter pushes through VaultRouter and mirrors only actual fee amounts', async function () {
    const { owner, alice, treasury, ecoVault, feeRouter, feeRouterView, token } = await loadFixture(deployFixture);
    const feeRouterViewContract = feeRouterView as any;
    const amount = ethers.parseUnits('1000', 6);
    const expectedFee = calcExpectedFee(amount);

    await token.connect(alice).approve(await feeRouter.getAddress(), amount);
    await feeRouter.connect(alice).distributeNormal(await token.getAddress(), amount);

    const [userFee] = await feeRouterViewContract.connect(alice).getUserFeeStatisticsWithMeta(alice.address, ACTION_DEPOSIT);
    expect(userFee).to.equal(expectedFee);

    const [userStats] = await feeRouterViewContract.connect(alice).getUserStatsWithMeta(alice.address);
    expect(userStats.totalFeePaid).to.equal(expectedFee);
    expect(userStats.transactionCount).to.equal(1n);

    const [globalFee] = await feeRouterViewContract.connect(owner).getGlobalFeeStatisticsWithMeta(await token.getAddress(), ACTION_DEPOSIT);
    expect(globalFee).to.equal(expectedFee);

    const [distributions, totalAmount] = await feeRouterViewContract.connect(owner).getGlobalOperationStatsWithMeta();
    expect(distributions).to.equal(1n);
    expect(totalAmount).to.equal(expectedFee);

    const [config] = await feeRouterViewContract.connect(owner).getSystemConfigWithMeta();
    expect(config.platformTreasury).to.equal(treasury.address);
    expect(config.ecosystemVault).to.equal(ecoVault.address);
    expect(config.platformFeeBps).to.equal(9n);
    expect(config.ecosystemFeeBps).to.equal(1n);
    expect(config.supportedTokens).to.deep.equal([await token.getAddress()]);
  });

  it('syncs treasury and fee config changes through the same gateway path', async function () {
    const { owner, newTreasury, newEcoVault, feeRouter, feeRouterView } = await loadFixture(deployFixture);
    const feeRouterViewContract = feeRouterView as any;

    await feeRouter.connect(owner).setTreasury(newTreasury.address, newEcoVault.address);
    await feeRouter.connect(owner).setFeeConfig(20, 5);

    const [config] = await feeRouterViewContract.connect(owner).getSystemConfigWithMeta();
    expect(config.platformTreasury).to.equal(newTreasury.address);
    expect(config.ecosystemVault).to.equal(newEcoVault.address);
    expect(config.platformFeeBps).to.equal(20n);
    expect(config.ecosystemFeeBps).to.equal(5n);
  });

  it('keeps fee distribution alive when the downstream FeeRouterView is unavailable', async function () {
    const { alice, feeRouter, token } = await loadFixture(deployFixtureWithoutFeeRouterView);
    const amount = ethers.parseUnits('1000', 6);

    await token.connect(alice).approve(await feeRouter.getAddress(), amount);
    const tx = await feeRouter.connect(alice).distributeNormal(await token.getAddress(), amount);
    const receipt = await tx.wait();

    const failureLogs =
      receipt?.logs.filter((log: unknown) => {
        try {
          const parsed = feeRouter.interface.parseLog(log as { topics: readonly string[]; data: string });
          return parsed?.name === 'FeeRouterViewPushFailed';
        } catch {
          return false;
        }
      }) ?? [];

    expect(failureLogs.length).to.be.greaterThan(0);
    expect(await feeRouter.getTotalDistributions()).to.equal(1n);
    expect(await feeRouter.getTotalAmountDistributed()).to.equal(calcExpectedFee(amount));
  });

  it('does not require KEY_FRV when the canonical gateway already knows the FeeRouterView target', async function () {
    const { owner, feeRouterView, vaultRouter } = await loadFixture(deployFixture);
    const vaultRouterContract = vaultRouter as any;

    expect(await vaultRouterContract.feeRouterViewAddrVar()).to.equal(await feeRouterView!.getAddress());
    expect(await vaultRouterContract.owner()).to.equal(owner.address);
  });
});