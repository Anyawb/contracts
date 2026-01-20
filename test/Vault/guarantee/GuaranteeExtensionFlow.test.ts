import hardhat from 'hardhat';
const { ethers } = hardhat;
import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

function calcExpectedInterest(principal: bigint, annualRateBps: bigint, termDays: bigint): bigint {
  // interest = principal * annualRateBps/1e4 * termDays/365
  return (principal * annualRateBps * termDays) / (365n * 10_000n);
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
  async function fixture() {
    const [owner, borrower, keeper] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    await registry.waitForDeployment();

    const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
    await acm.waitForDeployment();

    const token = await (await ethers.getContractFactory('MockERC20')).deploy(
      'TestToken',
      'TT',
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

    // Roles
    const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
    const ACTION_ORDER_CREATE = ethers.keccak256(ethers.toUtf8Bytes('ORDER_CREATE'));
    const ACTION_LIQUIDATE = ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATE'));

    await acm.grantRole(ACTION_SET_PARAMETER, owner.address);
    await acm.grantRole(ACTION_ORDER_CREATE, vbl.target);
    await acm.grantRole(ACTION_LIQUIDATE, keeper.address);

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
      ergm,
      vbl,
    };
  }

  it('match borrow (borrowWithRate) -> locks custody + writes guarantee record', async function () {
    const { borrower, token, vbl, gfm, ergm } = await loadFixture(fixture);

    const principal = ethers.parseUnits('1000', 18);
    const annualRateBps = 1000n; // 10%
    const termDays = 30n;
    const expectedInterest = calcExpectedInterest(principal, annualRateBps, termDays);

    await token.connect(borrower).approve(gfm.target, principal); // plenty for guarantee pull

    const orderId = await vbl.borrowWithRate.staticCall(borrower.address, ethers.ZeroAddress, token.target, principal, annualRateBps, Number(termDays));
    await vbl.borrowWithRate(borrower.address, ethers.ZeroAddress, token.target, principal, annualRateBps, Number(termDays));

    expect(orderId).to.equal(0n);
    expect(await gfm.getLockedGuarantee(borrower.address, token.target)).to.equal(expectedInterest);
    expect(await ergm.hasActiveGuarantee(borrower.address, token.target)).to.equal(true);
  });

  it('early full repay -> 3-way distribution (refund / lender penalty / platform fee) and clears custody', async function () {
    const { owner, borrower, token, vbl, vaultCore, gfm, ergm, lenderPoolVault } = await loadFixture(fixture);

    const principal = ethers.parseUnits('1000', 18);
    const annualRateBps = 1000n; // 10%
    const termDays = 30n;
    const expectedInterest = calcExpectedInterest(principal, annualRateBps, termDays);

    await token.connect(borrower).approve(gfm.target, principal);
    const orderId = await vbl.borrowWithRate.staticCall(borrower.address, ethers.ZeroAddress, token.target, principal, annualRateBps, Number(termDays));
    await vbl.borrowWithRate(borrower.address, ethers.ZeroAddress, token.target, principal, annualRateBps, Number(termDays));

    const guaranteeId = await ergm.getUserGuaranteeId(borrower.address, token.target);
    expect(guaranteeId).to.not.equal(0n);

    const preview = await ergm.previewEarlyRepayment(guaranteeId, principal);

    // Ensure borrower can repay full principal even after paying guarantee
    await token.transfer(borrower.address, expectedInterest);
    await token.connect(borrower).approve(vaultCore.target, principal);

    const userBalBefore = await token.balanceOf(borrower.address);
    const poolBalBefore = await token.balanceOf(lenderPoolVault.target);
    const ownerBalBefore = await token.balanceOf(owner.address);
    const gfmBalBefore = await token.balanceOf(gfm.target);
    expect(gfmBalBefore).to.equal(expectedInterest);

    await vaultCore.connect(borrower).repay(orderId, token.target, principal);

    // custody cleared
    expect(await gfm.getLockedGuarantee(borrower.address, token.target)).to.equal(0n);
    expect(await token.balanceOf(gfm.target)).to.equal(0n);
    expect(await ergm.hasActiveGuarantee(borrower.address, token.target)).to.equal(false);

    // balance deltas match previewed split
    const userBalAfter = await token.balanceOf(borrower.address);
    const poolBalAfter = await token.balanceOf(lenderPoolVault.target);
    const ownerBalAfter = await token.balanceOf(owner.address);

    expect(ownerBalAfter - ownerBalBefore).to.equal(preview.platformFee);
    expect(poolBalAfter - poolBalBefore).to.equal(preview.penaltyToLender);
    expect(userBalAfter).to.equal(userBalBefore - principal + preview.refundToBorrower);
  });

  it('settleOrLiquidate -> processes default guarantee forfeiture and clears custody', async function () {
    const { borrower, keeper, token, vbl, gfm, ergm, lenderPoolVault, risk, cm, le, orderEngine, settlementManager } =
      await loadFixture(fixture);

    const principal = ethers.parseUnits('500', 18);
    const annualRateBps = 1500n; // 15%
    const termDays = 60n;
    const expectedInterest = calcExpectedInterest(principal, annualRateBps, termDays);

    await token.connect(borrower).approve(gfm.target, principal);
    const orderId = await vbl.borrowWithRate.staticCall(borrower.address, ethers.ZeroAddress, token.target, principal, annualRateBps, Number(termDays));
    await vbl.borrowWithRate(borrower.address, ethers.ZeroAddress, token.target, principal, annualRateBps, Number(termDays));

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
    await orderEngine._getLoanOrderForView(orderId);
  });
});

