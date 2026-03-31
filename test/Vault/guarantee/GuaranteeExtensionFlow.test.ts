import hardhat from 'hardhat';
const { ethers } = hardhat;
import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

function calcExpectedInterest(principal: bigint, annualRateBps: bigint, termDays: bigint): bigint {
  // interest = principal * annualRateBps/1e4 * termDays/365
  return (principal * annualRateBps * termDays) / (365n * 10_000n);
}

function calcExpectedEarlyRepaymentSplit(
  record: { promisedInterest: bigint; startTime: bigint; maturityTime: bigint; earlyRepayPenaltyDays: bigint },
  platformFeeRateBps: bigint,
  currentBlock: bigint
): { actualInterestPaid: bigint; penaltyToLender: bigint; refundToBorrower: bigint; platformFee: bigint } {
  // Mirror EarlyRepaymentGuaranteeManager._calculateEarlyRepaymentResult (SSOT: blocks).
  const startBlock = record.startTime;
  const maturityBlock = record.maturityTime;
  let totalBlocks = maturityBlock > startBlock ? (maturityBlock - startBlock) : 0n;
  if (totalBlocks === 0n) totalBlocks = 1n;

  let elapsedBlocks = currentBlock - startBlock;
  if (elapsedBlocks > totalBlocks) elapsedBlocks = totalBlocks;

  const promised = record.promisedInterest;
  const actualInterestPaid = (promised * elapsedBlocks) / totalBlocks;

  const penaltyBlocks = record.earlyRepayPenaltyDays; // legacy field name; semantics are penaltyBlocks
  let penaltyInterest = (promised * penaltyBlocks) / totalBlocks;

  const remainingGuarantee = promised - actualInterestPaid;
  if (penaltyInterest > remainingGuarantee) penaltyInterest = remainingGuarantee;

  const platformFee = (penaltyInterest * platformFeeRateBps) / 10_000n;
  const penaltyToLender = actualInterestPaid + penaltyInterest - platformFee;
  const refundToBorrower = promised - actualInterestPaid - penaltyInterest;

  return { actualInterestPaid, penaltyToLender, refundToBorrower, platformFee };
}

async function deployUUPSProxy(implName: string, initData: string) {
  const ImplFactory = await ethers.getContractFactory(implName);
  const impl = await ImplFactory.deploy();
  await impl.waitForDeployment();

  const ProxyFactory = await ethers.getContractFactory('ERC1967Proxy');
  const proxy = await ProxyFactory.deploy(impl.target, initData);
  await proxy.waitForDeployment();

  return ImplFactory.attach(proxy.target);
}

describe('Guarantee Extension Flow (Funds-Flow Guide §5)', function () {
  const EIP712_DOMAIN_NAME = 'RwaLending';
  const EIP712_DOMAIN_VERSION = '1';

  const BORROW_INTENT_TYPES = {
    BorrowIntent: [
      { name: 'borrower', type: 'address' },
      { name: 'collateralAsset', type: 'address' },
      { name: 'collateralAmount', type: 'uint256' },
      { name: 'borrowAsset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'termDays', type: 'uint16' },
      { name: 'rateBps', type: 'uint256' },
      { name: 'expireAt', type: 'uint256' },
      { name: 'salt', type: 'bytes32' },
    ],
  } as const;

  const LEND_INTENT_TYPES = {
    LendIntent: [
      { name: 'lenderSigner', type: 'address' },
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'minTermDays', type: 'uint16' },
      { name: 'maxTermDays', type: 'uint16' },
      { name: 'minRateBps', type: 'uint256' },
      { name: 'expireAt', type: 'uint256' },
      { name: 'salt', type: 'bytes32' },
    ],
  } as const;

  async function finalizeMatchAndGetOrderId(args: {
    vbl: any;
    orderEngine: any;
    borrower: any;
    lender: any;
    token: any;
    principal: bigint;
    annualRateBps: bigint;
    termDays: number;
  }): Promise<bigint> {
    const { vbl, orderEngine, borrower, lender, token, principal, annualRateBps, termDays } = args;

    const network = await ethers.provider.getNetwork();
    const domain = {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: network.chainId,
      verifyingContract: await vbl.getAddress(),
    };

    const currentBlock = await ethers.provider.getBlockNumber();
    const expireAt = BigInt(currentBlock + 10_000);

    const borrowIntent = {
      borrower: borrower.address,
      collateralAsset: ethers.ZeroAddress,
      collateralAmount: 0n,
      borrowAsset: await token.getAddress(),
      amount: principal,
      termDays,
      rateBps: annualRateBps,
      expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`borrow-${borrower.address}-${principal}-${Date.now()}`)),
    };

    const lendIntent = {
      lenderSigner: lender.address,
      asset: await token.getAddress(),
      amount: principal,
      minTermDays: termDays,
      maxTermDays: termDays,
      minRateBps: annualRateBps,
      expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`lend-${lender.address}-${principal}-${Date.now()}`)),
    };

    const lendIntentHash = ethers.TypedDataEncoder.hashStruct('LendIntent', LEND_INTENT_TYPES, lendIntent);

    // Lender reserves principal into pool custody.
    await token.connect(lender).approve(await vbl.getAddress(), principal);
    await vbl.connect(lender).reserveForLending(lender.address, await token.getAddress(), principal, lendIntentHash);

    const sigBorrower = await borrower.signTypedData(domain, BORROW_INTENT_TYPES, borrowIntent);
    const sigLender = await lender.signTypedData(domain, LEND_INTENT_TYPES, lendIntent);

    const tx = await vbl.connect(borrower).finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [sigLender]);
    const receipt = await tx.wait();

    // Parse MockOrderEngineForSettlementManager.MockOrderCreated(orderId,...)
    for (const log of receipt!.logs) {
      if (log.address.toLowerCase() !== (await orderEngine.getAddress()).toLowerCase()) continue;
      try {
        const parsed = orderEngine.interface.parseLog(log);
        if (parsed?.name === 'MockOrderCreated') {
          return BigInt(parsed.args.orderId);
        }
      } catch {
        // ignore non-matching logs
      }
    }

    throw new Error('orderId not found in MockOrderCreated logs');
  }

  async function fixture() {
    const [owner, borrower, keeper] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    await registry.waitForDeployment();

    const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
    await acm.waitForDeployment();

    const token = await (await ethers.getContractFactory('MockERC20')).deploy(
      'TestToken',
      'TT',
      18,
      ethers.parseUnits('100000000', 18)
    );
    await token.waitForDeployment();

    const vaultRouter = await (await ethers.getContractFactory('MockVaultRouter')).deploy();
    await vaultRouter.waitForDeployment();

    const le = await (await ethers.getContractFactory('MockLendingEngineBasic')).deploy();
    await le.waitForDeployment();

    const cm = await (await ethers.getContractFactory('MockCollateralManager')).deploy();
    await cm.waitForDeployment();

    const risk = await (await ethers.getContractFactory('MockLiquidationRiskManager')).deploy();
    await risk.waitForDeployment();

    const pvVal = await (await ethers.getContractFactory('MockPositionViewValuation')).deploy();
    await pvVal.waitForDeployment();

    const liquidationManager = await (await ethers.getContractFactory('MockLiquidationManager')).deploy();
    await liquidationManager.waitForDeployment();

    const assetWhitelist = await (await ethers.getContractFactory('MockAssetWhitelist')).deploy();
    await assetWhitelist.waitForDeployment();

    const orderEngine = await (await ethers.getContractFactory('MockOrderEngineForSettlementManager')).deploy();
    await orderEngine.waitForDeployment();
    // link LE for debt-value==0 checks when repaid
    await orderEngine.setLendingEngine(le.target);

    // Deploy core upgradeables via UUPS proxies
    const vaultCore = await deployUUPSProxy(
      'VaultCore',
      (await ethers.getContractFactory('VaultCore')).interface.encodeFunctionData('initialize', [
        registry.target,
        vaultRouter.target,
      ])
    );

    const settlementManager = await deployUUPSProxy(
      'SettlementManager',
      (await ethers.getContractFactory('SettlementManager')).interface.encodeFunctionData('initialize', [registry.target])
    );

    const lenderPoolVault = await deployUUPSProxy(
      'LenderPoolVault',
      (await ethers.getContractFactory('LenderPoolVault')).interface.encodeFunctionData('initialize', [registry.target])
    );

    const gfm = await deployUUPSProxy(
      'GuaranteeFundManager',
      (await ethers.getContractFactory('GuaranteeFundManager')).interface.encodeFunctionData('initialize', [
        vaultCore.target, // compat param; runtime SSOT uses Registry
        registry.target,
        owner.address,
      ])
    );

    const feeRouter = await deployUUPSProxy(
      'FeeRouter',
      (await ethers.getContractFactory('FeeRouter')).interface.encodeFunctionData('initialize', [
        registry.target,
        owner.address,
        owner.address,
        300,
        0,
      ])
    );

    const ergm = await deployUUPSProxy(
      'EarlyRepaymentGuaranteeManager',
      (await ethers.getContractFactory('EarlyRepaymentGuaranteeManager')).interface.encodeFunctionData('initialize', [
        registry.target,
        owner.address, // platformFeeReceiver
        300, // 3%
      ])
    );

    const vbl = await deployUUPSProxy(
      'VaultBusinessLogic',
      (await ethers.getContractFactory('VaultBusinessLogic')).interface.encodeFunctionData('initialize', [
        registry.target,
        token.target, // settlement token (not used by our tests)
      ])
    );

    // Wire registry keys (must match ModuleKeys on-chain constants)
    const ModuleKeys = {
      KEY_ACCESS_CONTROL: ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER')),
      KEY_LE: ethers.keccak256(ethers.toUtf8Bytes('LENDING_ENGINE')),
      KEY_CM: ethers.keccak256(ethers.toUtf8Bytes('COLLATERAL_MANAGER')),
      KEY_ORDER_ENGINE: ethers.keccak256(ethers.toUtf8Bytes('ORDER_ENGINE')),
      KEY_VAULT_CORE: ethers.keccak256(ethers.toUtf8Bytes('VAULT_CORE')),
      KEY_SETTLEMENT_MANAGER: ethers.keccak256(ethers.toUtf8Bytes('SETTLEMENT_MANAGER')),
      KEY_LENDER_POOL_VAULT: ethers.keccak256(ethers.toUtf8Bytes('LENDER_POOL_VAULT')),
      KEY_VAULT_BUSINESS_LOGIC: ethers.keccak256(ethers.toUtf8Bytes('VAULT_BUSINESS_LOGIC')),
      KEY_GUARANTEE_FUND: ethers.keccak256(ethers.toUtf8Bytes('GUARANTEE_FUND_MANAGER')),
      KEY_EARLY_REPAYMENT_GUARANTEE: ethers.keccak256(ethers.toUtf8Bytes('EARLY_REPAYMENT_GUARANTEE_MANAGER')),
      KEY_LIQUIDATION_RISK_MANAGER: ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATION_RISK_MANAGER')),
      KEY_POSITION_VIEW: ethers.keccak256(ethers.toUtf8Bytes('POSITION_VIEW')),
      KEY_LIQUIDATION_MANAGER: ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATION_MANAGER')),
      KEY_FR: ethers.keccak256(ethers.toUtf8Bytes('FEE_ROUTER')),
      KEY_ASSET_WHITELIST: ethers.keccak256(ethers.toUtf8Bytes('ASSET_WHITELIST')),
    } as const;

    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, acm.target);
    await registry.setModule(ModuleKeys.KEY_LE, le.target);
    await registry.setModule(ModuleKeys.KEY_CM, cm.target);
    await registry.setModule(ModuleKeys.KEY_ORDER_ENGINE, orderEngine.target);
    await registry.setModule(ModuleKeys.KEY_VAULT_CORE, vaultCore.target);
    await registry.setModule(ModuleKeys.KEY_SETTLEMENT_MANAGER, settlementManager.target);
    await registry.setModule(ModuleKeys.KEY_LENDER_POOL_VAULT, lenderPoolVault.target);
    await registry.setModule(ModuleKeys.KEY_VAULT_BUSINESS_LOGIC, vbl.target);
    await registry.setModule(ModuleKeys.KEY_GUARANTEE_FUND, gfm.target);
    await registry.setModule(ModuleKeys.KEY_EARLY_REPAYMENT_GUARANTEE, ergm.target);
    await registry.setModule(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER, risk.target);
    await registry.setModule(ModuleKeys.KEY_POSITION_VIEW, pvVal.target);
    await registry.setModule(ModuleKeys.KEY_LIQUIDATION_MANAGER, liquidationManager.target);
    await registry.setModule(ModuleKeys.KEY_FR, feeRouter.target);
    await registry.setModule(ModuleKeys.KEY_ASSET_WHITELIST, assetWhitelist.target);

    // Roles
    const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
    const ACTION_ORDER_CREATE = ethers.keccak256(ethers.toUtf8Bytes('ORDER_CREATE'));
    const ACTION_LIQUIDATE = ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATE'));
    const ACTION_DEPOSIT = ethers.keccak256(ethers.toUtf8Bytes('DEPOSIT'));

    await acm.grantRole(ACTION_SET_PARAMETER, owner.address);
    await acm.grantRole(ACTION_ORDER_CREATE, vbl.target);
    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);
    await acm.grantRole(ACTION_DEPOSIT, gfm.target);
    await acm.grantRole(ACTION_DEPOSIT, vbl.target);
    await feeRouter.connect(owner).addSupportedToken(token.target);

    await assetWhitelist.setAssetAllowed(token.target, true);

    // Enable guarantee for this asset
    await ergm.connect(owner).setGuaranteeEnabled(token.target, true);

    // Seed pool liquidity
    await token.transfer(lenderPoolVault.target, ethers.parseUnits('1000000', 18));

    return {
      owner,
      borrower,
      keeper,
      registry,
      token,
      le,
      cm,
      risk,
      lenderPoolVault,
      vaultCore,
      settlementManager,
      orderEngine,
      gfm,
      feeRouter,
      ergm,
      vbl,
    };
  }

  it('match borrow (finalizeMatch) -> locks custody + writes guarantee record', async function () {
    const { owner, borrower, token, vbl, orderEngine, gfm, ergm } = await loadFixture(fixture);

    const principal = ethers.parseUnits('1000', 18);
    const annualRateBps = 1000n; // 10%
    const termDays = 30n;
    const expectedInterest = calcExpectedInterest(principal, annualRateBps, termDays);

    await token.connect(borrower).approve(gfm.target, principal); // plenty for guarantee pull

    const orderId = await finalizeMatchAndGetOrderId({
      vbl,
      orderEngine,
      borrower,
      lender: owner,
      token,
      principal,
      annualRateBps,
      termDays: Number(termDays),
    });

    expect(orderId).to.equal(0n);
    expect(await gfm.getLockedGuarantee(borrower.address, token.target)).to.equal(expectedInterest);
    expect(await ergm.hasActiveGuarantee(borrower.address, token.target)).to.equal(true);
  });

  it('early full repay -> 3-way distribution (refund / lender penalty / platform fee) and clears custody', async function () {
    const { owner, borrower, token, vbl, orderEngine, vaultCore, gfm, ergm, lenderPoolVault } = await loadFixture(fixture);

    const principal = ethers.parseUnits('1000', 18);
    const annualRateBps = 1000n; // 10%
    const termDays = 30n;
    const expectedInterest = calcExpectedInterest(principal, annualRateBps, termDays);

    await token.connect(borrower).approve(gfm.target, principal);
    const orderId = await finalizeMatchAndGetOrderId({
      vbl,
      orderEngine,
      borrower,
      lender: owner,
      token,
      principal,
      annualRateBps,
      termDays: Number(termDays),
    });

    const guaranteeId = await ergm.getUserGuaranteeId(borrower.address, token.target);
    expect(guaranteeId).to.not.equal(0n);

    // NOTE: preview is block-sensitive (computed at `block.number`), while `repay` executes in a later block.
    // We compute the expected split using the settle block number to avoid flaky 1-block drift.
    const recordBefore = await ergm.getGuaranteeRecord(guaranteeId);
    const feeRate = await ergm.platformFeeRate();

    // Ensure borrower can repay full principal even after paying guarantee + match fees
    const borrowerBalBeforeTopUp = await token.balanceOf(borrower.address);
    if (borrowerBalBeforeTopUp < principal) {
      await token.transfer(borrower.address, principal - borrowerBalBeforeTopUp);
    }
    await token.connect(borrower).approve(vaultCore.target, principal);

    const userBalBefore = await token.balanceOf(borrower.address);
    const poolBalBefore = await token.balanceOf(lenderPoolVault.target);
    const ownerBalBefore = await token.balanceOf(owner.address);
    const gfmBalBefore = await token.balanceOf(gfm.target);
    expect(gfmBalBefore).to.equal(expectedInterest);

    const tx = await vaultCore.connect(borrower).repay(orderId, token.target, principal);
    const receipt = await tx.wait();
    const settleBlock = BigInt(receipt!.blockNumber);
    const expected = calcExpectedEarlyRepaymentSplit(recordBefore, feeRate, settleBlock);

    // custody cleared
    expect(await gfm.getLockedGuarantee(borrower.address, token.target)).to.equal(0n);
    expect(await token.balanceOf(gfm.target)).to.equal(0n);
    expect(await ergm.hasActiveGuarantee(borrower.address, token.target)).to.equal(false);

    // balance deltas match previewed split
    const userBalAfter = await token.balanceOf(borrower.address);
    const poolBalAfter = await token.balanceOf(lenderPoolVault.target);
    const ownerBalAfter = await token.balanceOf(owner.address);

    expect(ownerBalAfter - ownerBalBefore).to.equal(expected.platformFee);
    expect(poolBalAfter - poolBalBefore).to.equal(expected.penaltyToLender);
    expect(userBalAfter).to.equal(userBalBefore - principal + expected.refundToBorrower);
  });

  it('settleOrLiquidate -> processes default guarantee forfeiture and clears custody', async function () {
    const { owner, borrower, keeper, token, vbl, gfm, ergm, lenderPoolVault, risk, cm, le, orderEngine, settlementManager } =
      await loadFixture(fixture);

    const principal = ethers.parseUnits('500', 18);
    const annualRateBps = 1500n; // 15%
    const termDays = 60n;
    const expectedInterest = calcExpectedInterest(principal, annualRateBps, termDays);

    await token.connect(borrower).approve(gfm.target, principal);
    const orderId = await finalizeMatchAndGetOrderId({
      vbl,
      orderEngine,
      borrower,
      lender: owner,
      token,
      principal,
      annualRateBps,
      termDays: Number(termDays),
    });

    // Make user liquidatable (risk branch) and ensure collateral exists
    await risk.setLiquidatable(borrower.address, true);
    await cm.setUserCollateral(borrower.address, token.target, ethers.parseUnits('1000', 18));

    // Ensure debt exists (borrowFor wrote it via VaultCore -> LE)
    expect(await le.getDebt(borrower.address, token.target)).to.equal(principal);

    const poolBalBefore = await token.balanceOf(lenderPoolVault.target);
    const gfmBalBefore = await token.balanceOf(gfm.target);
    expect(gfmBalBefore).to.equal(expectedInterest);
    expect(await ergm.hasActiveGuarantee(borrower.address, token.target)).to.equal(true);

    await settlementManager.connect(keeper).settleOrLiquidate(orderId);

    // Guarantee forfeited to lender (pool) and custody cleared
    expect(await token.balanceOf(lenderPoolVault.target)).to.equal(poolBalBefore + expectedInterest);
    expect(await gfm.getLockedGuarantee(borrower.address, token.target)).to.equal(0n);
    expect(await ergm.hasActiveGuarantee(borrower.address, token.target)).to.equal(false);

    // keep a no-op read of orderEngine to ensure it is wired (silence unused)
    await orderEngine.getLoanOrderForView(orderId);
  });
});

