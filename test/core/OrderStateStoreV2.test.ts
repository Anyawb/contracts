import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { ethers, upgrades } from 'hardhat';

const KEY_ORDER_ENGINE = ethers.id('ORDER_ENGINE');
const KEY_SETTLEMENT_MANAGER = ethers.id('SETTLEMENT_MANAGER');
const KEY_BLOCKS_ONLY_COORDINATOR = ethers.id('BLOCKS_ONLY_COORDINATOR');

const PRODUCT_LOAN = 1n;
const PRODUCT_BLOCKS_ONLY = 2n;

const LIFECYCLE_ACTIVE = 1n;
const LIFECYCLE_REPAID = 2n;
const LIFECYCLE_LIQUIDATED = 3n;
const LIFECYCLE_CLOSED = 5n;

const CLOSE_REASON_NONE = 0n;
const CLOSE_REASON_FULL_REPAY = 1n;
const CLOSE_REASON_KEEPER_LIQUIDATION = 2n;
const CLOSE_REASON_BLOCKS_TRADE_CLOSE = 4n;

const SHORTFALL_NONE = 0n;
const SHORTFALL_ACTIVE = 1n;
const SHORTFALL_RESOLVED = 5n;

const DISPOSITION_NONE = 0n;
const DISPOSITION_COORDINATOR_CUSTODY = 1n;
const DISPOSITION_RETURNED_TO_BORROWER = 2n;
const DISPOSITION_SEIZED_AND_DISTRIBUTED = 4n;

describe('OrderStateStoreV2', function () {
  async function deployFixture() {
    const [owner, orderEngine, settlementManager, blocksOnlyCoordinator, outsider] =
      await ethers.getSigners();

    const Registry = await ethers.getContractFactory('Registry');
    const registry = await upgrades.deployProxy(
      Registry,
      [1n, 10_000n, owner.address, owner.address, owner.address],
      { kind: 'uups' },
    );

    const OrderStateStoreV2 = await ethers.getContractFactory('OrderStateStoreV2');
    const store = await upgrades.deployProxy(OrderStateStoreV2, [await registry.getAddress()], {
      kind: 'uups',
    });

    await registry.setModule(KEY_ORDER_ENGINE, orderEngine.address);
    await registry.setModule(KEY_SETTLEMENT_MANAGER, settlementManager.address);
    await registry.setModule(KEY_BLOCKS_ONLY_COORDINATOR, blocksOnlyCoordinator.address);

    return { store, registry, owner, orderEngine, settlementManager, blocksOnlyCoordinator, outsider };
  }

  async function deployRecoveryFixture() {
    const [owner, settlementManager, blocksOnlyCoordinator, borrower, lender] =
      await ethers.getSigners();

    const Registry = await ethers.getContractFactory('Registry');
    const registry = await upgrades.deployProxy(
      Registry,
      [1n, 10_000n, owner.address, owner.address, owner.address],
      { kind: 'uups' },
    );

    const OrderStateStoreV2 = await ethers.getContractFactory('OrderStateStoreV2');
    const store = await upgrades.deployProxy(OrderStateStoreV2, [await registry.getAddress()], {
      kind: 'uups',
    });

    const MockOrderEngine = await ethers.getContractFactory('MockOrderEngineForSettlementManager');
    const orderEngine = await MockOrderEngine.deploy();
    await orderEngine.waitForDeployment();

    await registry.setModule(KEY_ORDER_ENGINE, await orderEngine.getAddress());
    await registry.setModule(KEY_SETTLEMENT_MANAGER, settlementManager.address);
    await registry.setModule(KEY_BLOCKS_ONLY_COORDINATOR, blocksOnlyCoordinator.address);

    return { store, registry, settlementManager, orderEngine, borrower, lender };
  }

  it('keeps loan and blocks-only state isolated for the same order id', async function () {
    const { store, orderEngine, blocksOnlyCoordinator } = await loadFixture(deployFixture);

    await store.connect(orderEngine).initializeLoanOrderState(1, 123);
    await store.connect(blocksOnlyCoordinator).initializeBlocksOnlyOrderState(1, 456);

    const loanState = await store.getOrderState(PRODUCT_LOAN, 1);
    const blocksState = await store.getOrderState(PRODUCT_BLOCKS_ONLY, 1);

    expect(loanState.productType).to.equal(PRODUCT_LOAN);
    expect(loanState.lifecycle).to.equal(LIFECYCLE_ACTIVE);
    expect(loanState.createdBlock).to.equal(123n);
    expect(loanState.collateralDisposition).to.equal(DISPOSITION_NONE);

    expect(blocksState.productType).to.equal(PRODUCT_BLOCKS_ONLY);
    expect(blocksState.lifecycle).to.equal(LIFECYCLE_ACTIVE);
    expect(blocksState.createdBlock).to.equal(456n);
    expect(blocksState.collateralDisposition).to.equal(DISPOSITION_COORDINATOR_CUSTODY);
  });

  it('bootstraps and records the loan repay terminal state without using legacy with-shortfall enums', async function () {
    const { store, orderEngine } = await loadFixture(deployFixture);

    await store.connect(orderEngine).markLoanRepaid(7, 777);

    const state = await store.getOrderState(PRODUCT_LOAN, 7);
    expect(state.productType).to.equal(PRODUCT_LOAN);
    expect(state.lifecycle).to.equal(LIFECYCLE_REPAID);
    expect(state.closeReason).to.equal(CLOSE_REASON_FULL_REPAY);
    expect(state.shortfallStatus).to.equal(SHORTFALL_NONE);
    expect(state.closedBlock).to.be.gt(0n);
    expect(await store.getLegacyLoanStatus(7)).to.equal(1n);
  });

  it('tracks liquidation lifecycle separately from shortfall status history', async function () {
    const { store, settlementManager } = await loadFixture(deployFixture);

    await store.connect(settlementManager).applyLoanTerminalTransition(
      9,
      900,
      LIFECYCLE_LIQUIDATED,
      CLOSE_REASON_KEEPER_LIQUIDATION,
      SHORTFALL_ACTIVE,
      DISPOSITION_SEIZED_AND_DISTRIBUTED,
    );

    let state = await store.getOrderState(PRODUCT_LOAN, 9);
    expect(state.lifecycle).to.equal(LIFECYCLE_LIQUIDATED);
    expect(state.closeReason).to.equal(CLOSE_REASON_KEEPER_LIQUIDATION);
    expect(state.shortfallStatus).to.equal(SHORTFALL_ACTIVE);
    expect(state.collateralDisposition).to.equal(DISPOSITION_SEIZED_AND_DISTRIBUTED);
    expect(await store.getLegacyLoanStatus(9)).to.equal(4n);

    await store.connect(settlementManager).syncLoanShortfallState(9, 900, SHORTFALL_RESOLVED);

    state = await store.getOrderState(PRODUCT_LOAN, 9);
    expect(state.lifecycle).to.equal(LIFECYCLE_LIQUIDATED);
    expect(state.shortfallStatus).to.equal(SHORTFALL_RESOLVED);
    expect(await store.getLegacyLoanStatus(9)).to.equal(4n);
  });

  it('does not bootstrap ACTIVE loan state from shortfall-only sync when terminal context is unavailable', async function () {
    const { store, settlementManager } = await loadFixture(deployFixture);

    expect(await store.hasOrderState(PRODUCT_LOAN, 77)).to.equal(false);

    await store.connect(settlementManager).syncLoanShortfallState(77, 0, SHORTFALL_ACTIVE);

    expect(await store.hasOrderState(PRODUCT_LOAN, 77)).to.equal(false);
  });

  it('compensates missing loan state from ORDER_ENGINE terminal status during shortfall sync', async function () {
    const { store, settlementManager, orderEngine, borrower, lender } =
      await loadFixture(deployRecoveryFixture);

    const debtAsset = ethers.Wallet.createRandom().address;
    const orderId = 88n;
    const createdBlockHint = 8_888n;

    await orderEngine.setOrder(orderId, {
      principal: 100n,
      rate: 0n,
      term: 1n,
      borrower: borrower.address,
      lender: lender.address,
      asset: debtAsset,
      startTimestamp: createdBlockHint,
      maturity: createdBlockHint + 1n,
      repaidAmount: 0n,
    });
    // LiquidatedWithShortfall
    await orderEngine.setOrderStatus(orderId, 4);

    expect(await store.hasOrderState(PRODUCT_LOAN, orderId)).to.equal(false);

    await store.connect(settlementManager).syncLoanShortfallState(orderId, createdBlockHint, SHORTFALL_ACTIVE);

    expect(await store.hasOrderState(PRODUCT_LOAN, orderId)).to.equal(true);
    const state = await store.getOrderState(PRODUCT_LOAN, orderId);
    expect(state.lifecycle).to.equal(LIFECYCLE_LIQUIDATED);
    expect(state.closeReason).to.equal(CLOSE_REASON_KEEPER_LIQUIDATION);
    expect(state.shortfallStatus).to.equal(SHORTFALL_ACTIVE);
    expect(state.collateralDisposition).to.equal(DISPOSITION_SEIZED_AND_DISTRIBUTED);
    expect(state.createdBlock).to.equal(createdBlockHint);
  });

  it('records blocks-only repaid-open state before explicit trade close', async function () {
    const { store, blocksOnlyCoordinator } = await loadFixture(deployFixture);

    await store.connect(blocksOnlyCoordinator).initializeBlocksOnlyOrderState(12, 1200);
    await store.connect(blocksOnlyCoordinator).markBlocksOnlyRepaid(12, 1200);

    let state = await store.getOrderState(PRODUCT_BLOCKS_ONLY, 12);
    expect(state.lifecycle).to.equal(LIFECYCLE_REPAID);
    expect(state.closeReason).to.equal(CLOSE_REASON_NONE);
    expect(state.collateralDisposition).to.equal(DISPOSITION_COORDINATOR_CUSTODY);
    expect(state.closedBlock).to.equal(0n);

    await store.connect(blocksOnlyCoordinator).applyBlocksOnlyCloseTransition(
      12,
      1200,
      CLOSE_REASON_BLOCKS_TRADE_CLOSE,
      DISPOSITION_RETURNED_TO_BORROWER,
    );

    state = await store.getOrderState(PRODUCT_BLOCKS_ONLY, 12);
    expect(state.lifecycle).to.equal(LIFECYCLE_CLOSED);
    expect(state.closeReason).to.equal(CLOSE_REASON_BLOCKS_TRADE_CLOSE);
    expect(state.collateralDisposition).to.equal(DISPOSITION_RETURNED_TO_BORROWER);
    expect(state.closedBlock).to.be.gt(0n);
  });

  it('rejects unauthorized writers', async function () {
    const { store, outsider } = await loadFixture(deployFixture);

    await expect(store.connect(outsider).initializeLoanOrderState(99, 1)).to.be.revertedWithCustomError(
      store,
      'OrderStateStoreV2__UnauthorizedWriter',
    );
  });
});