import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { ethers, upgrades } from 'hardhat';

const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
const ACTION_DEPOSIT = ethers.keccak256(ethers.toUtf8Bytes('DEPOSIT'));
const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));

function makeRng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };
}

function calcExpectedFee(amount: bigint, platformFeeBps: bigint, ecosystemFeeBps: bigint): bigint {
  return (amount * platformFeeBps) / 10000n + (amount * ecosystemFeeBps) / 10000n;
}

describe('FeeRouter - invariant accounting', function () {
  async function deployFixture() {
    const [owner, alice, treasuryA, ecoA, treasuryB, ecoB] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    await registry.waitForDeployment();

    const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
    await acm.waitForDeployment();

    const token = await (await ethers.getContractFactory('MockERC20')).deploy(
      'Mock USDC',
      'USDC',
      6,
      ethers.parseUnits('2000000', 6),
    );
    await token.waitForDeployment();

    const FeeRouterFactory = await ethers.getContractFactory('FeeRouter');
    const feeRouter = await upgrades.deployProxy(
      FeeRouterFactory,
      [await registry.getAddress(), treasuryA.address, ecoA.address, 9, 1],
      { kind: 'uups', initializer: 'initialize' },
    );
    await feeRouter.waitForDeployment();

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

    await acm.grantRole(ACTION_DEPOSIT, alice.address);
    await acm.grantRole(ACTION_SET_PARAMETER, owner.address);
    await acm.grantRole(ACTION_ADMIN, owner.address);

    await feeRouter.connect(owner).addSupportedToken(await token.getAddress());
    await token.transfer(alice.address, ethers.parseUnits('50000', 6));
    await token.connect(alice).approve(await feeRouter.getAddress(), ethers.MaxUint256);

    return {
      owner,
      alice,
      treasuryA,
      ecoA,
      treasuryB,
      ecoB,
      token,
      feeRouter,
    };
  }

  it('preserves fee totals and recipient balances across config and treasury changes', async function () {
    const { owner, alice, treasuryA, ecoA, treasuryB, ecoB, token, feeRouter } = await loadFixture(deployFixture);

    const tokenAddress = await token.getAddress();
    const feeRouterAddress = await feeRouter.getAddress();

    const recipients = new Set<string>([
      treasuryA.address.toLowerCase(),
      ecoA.address.toLowerCase(),
      treasuryB.address.toLowerCase(),
      ecoB.address.toLowerCase(),
    ]);

    let currentPlatformFeeBps = 9n;
    let currentEcosystemFeeBps = 1n;
    let expectedDistributions = 0n;
    let expectedDistributedFeeAmount = 0n;

    const rng = makeRng(20260411);

    for (let step = 0; step < 25; step += 1) {
      const mode = rng() % 4;

      if (mode <= 1) {
        const amount = BigInt(50_000 + (rng() % 950_000));
        await feeRouter.connect(alice).distributeNormal(tokenAddress, amount);
        expectedDistributions += 1n;
        expectedDistributedFeeAmount += calcExpectedFee(amount, currentPlatformFeeBps, currentEcosystemFeeBps);
      } else if (mode === 2) {
        const platformFeeBps = BigInt(rng() % 20);
        const ecosystemFeeBps = BigInt(1 + (rng() % 10));
        await feeRouter.connect(owner).setFeeConfig(Number(platformFeeBps), Number(ecosystemFeeBps));
        currentPlatformFeeBps = platformFeeBps;
        currentEcosystemFeeBps = ecosystemFeeBps;
      } else {
        const useSecondTreasury = (rng() & 1) === 1;
        const nextTreasury = useSecondTreasury ? treasuryB.address : treasuryA.address;
        const nextEcoVault = useSecondTreasury ? ecoB.address : ecoA.address;
        await feeRouter.connect(owner).setTreasury(nextTreasury, nextEcoVault);
      }

      const onchainDistributions = await feeRouter.getTotalDistributions();
      const onchainDistributedAmount = await feeRouter.getTotalAmountDistributed();

      expect(onchainDistributions).to.equal(expectedDistributions);
      expect(onchainDistributedAmount).to.equal(expectedDistributedFeeAmount);

      let recipientAggregateBalance = 0n;
      for (const recipient of recipients) {
        recipientAggregateBalance += await token.balanceOf(recipient);
      }

      expect(recipientAggregateBalance).to.equal(expectedDistributedFeeAmount);
      expect(await token.balanceOf(feeRouterAddress)).to.equal(0n);
      expect((await token.balanceOf(alice.address)) >= 0n).to.equal(true);
    }
  });
});