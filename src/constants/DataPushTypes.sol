// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title DataPushTypes
 * @notice Centralized data-push type constants (keccak256("UPPER_SNAKE_CASE")) for off-chain consumers.
 * @dev Reverts if:
 *      - N/A (constants-only library)
 *
 * Security:
 * - Keys must remain stable once deployed; do not change existing values.
 * - Prefer reusing these constants instead of duplicating keccak256 literals across modules.
 */
library DataPushTypes {
    /*━━━━━━━━━━━━━━━ COMMON ━━━━━━━━━━━━━━━*/
    bytes32 public constant DATA_TYPE_REGISTRY_UPDATED =
        keccak256("REGISTRY_UPDATED");
    bytes32 public constant DATA_TYPE_MODULE_HEALTH =
        keccak256("MODULE_HEALTH");
    /// @dev Component/service health alert with human-readable details (string).
    ///      payload = abi.encode(address component, string name, bool ok, string details, uint256 blockNumber)
    bytes32 public constant DATA_TYPE_COMPONENT_HEALTH =
        keccak256("COMPONENT_HEALTH");
    /// @dev User-scoped degradation event (frontends can filter by user).
    bytes32 public constant DATA_TYPE_USER_DEGRADATION =
        keccak256("USER_DEGRADATION");

    /*━━━━━━━━━━━━━━━ COINGECKO PRICE UPDATER ━━━━━━━━━━━━━━━*/
    bytes32 public constant DATA_TYPE_PRICE_UPDATED =
        keccak256("PRICE_UPDATED");
    bytes32 public constant DATA_TYPE_PRICE_UPDATE_FAILED =
        keccak256("PRICE_UPDATE_FAILED");
    bytes32 public constant DATA_TYPE_PRICE_VALIDATION_FAILED =
        keccak256("PRICE_VALIDATION_FAILED");
    bytes32 public constant DATA_TYPE_AUTO_UPDATE_TOGGLED =
        keccak256("AUTO_UPDATE_TOGGLED");
    bytes32 public constant DATA_TYPE_PRICE_VALIDATION_TOGGLED =
        keccak256("PRICE_VALIDATION_TOGGLED");
    bytes32 public constant DATA_TYPE_MONITORING_REGISTERED =
        keccak256("MONITORING_REGISTERED");
    bytes32 public constant DATA_TYPE_BACKUP_SOURCE_REGISTERED =
        keccak256("BACKUP_SOURCE_REGISTERED");

    /*━━━━━━━━━━━━━━━ FEEROUTER ━━━━━━━━━━━━━━━*/
    bytes32 public constant DATA_TYPE_FEE_DISTRIBUTED =
        keccak256("FEE_DISTRIBUTED");
    bytes32 public constant DATA_TYPE_BATCH_FEE_DISTRIBUTED =
        keccak256("BATCH_FEE_DISTRIBUTED");
    bytes32 public constant DATA_TYPE_FEE_CONFIG_UPDATED =
        keccak256("FEE_CONFIG_UPDATED");
    bytes32 public constant DATA_TYPE_TREASURY_UPDATED =
        keccak256("TREASURY_UPDATED");
    bytes32 public constant DATA_TYPE_TOKEN_SUPPORTED =
        keccak256("TOKEN_SUPPORTED");
    bytes32 public constant DATA_TYPE_FEE_CACHE_CLEARED =
        keccak256("FEE_CACHE_CLEARED");
    bytes32 public constant DATA_TYPE_PAUSE_STATUS_UPDATED =
        keccak256("PAUSE_STATUS_UPDATED");
    bytes32 public constant DATA_TYPE_DYNAMIC_FEE_UPDATED =
        keccak256("DYNAMIC_FEE_UPDATED");

    /*━━━━━━━━━━━━━━━ LENDING / LOANNFT ━━━━━━━━━━━━━━━*/
    bytes32 public constant DATA_TYPE_LOAN_CREATED = keccak256("LOAN_CREATED");
    bytes32 public constant DATA_TYPE_LOAN_REPAID = keccak256("LOAN_REPAID");
    /// @notice DataPush type for a finalized blocks-only match.
    /// @dev Emitted by BlocksOnlyCoordinator after principal transfer, debt booking, and order storage initialization.
    ///      payload = abi.encode(address coordinator, uint256 orderId, address borrower, address lender,
    ///      address asset, uint256 principal, uint256 termBlocks, uint256 startBlock, uint256 maturityBlock)
    ///      `termBlocks`, `startBlock`, and `maturityBlock` are block-based values, not timestamp-based values.
    bytes32 public constant DATA_TYPE_BLOCKS_ONLY_MATCH_FINALIZED =
        keccak256("BLOCKS_ONLY_MATCH_FINALIZED");
    /// @notice DataPush type for a blocks-only repayment update.
    /// @dev Emitted by BlocksOnlyCoordinator after repayment forwarding and debt-ledger refresh.
    ///      payload = abi.encode(address coordinator, uint256 orderId, address payer, address borrower,
    ///      address asset, uint256 repayAmount, uint256 remainingDebt, uint256 blockNumber)
    ///      `remainingDebt` follows the lending-engine debt SSOT and `blockNumber` is block-based metadata.
    bytes32 public constant DATA_TYPE_BLOCKS_ONLY_REPAID =
        keccak256("BLOCKS_ONLY_REPAID");
    /// @notice DataPush type for a matured blocks-only order settled without remaining debt.
    /// @dev Emitted by BlocksOnlyCoordinator after collateral release and order close.
    ///      payload = abi.encode(address coordinator, uint256 orderId, address borrower, address asset,
    ///      uint256 closeBlock)
    ///      `closeBlock` is the block number at which the order transitioned to SETTLED.
    bytes32 public constant DATA_TYPE_BLOCKS_ONLY_SETTLED =
        keccak256("BLOCKS_ONLY_SETTLED");
    /// @notice DataPush type for a matured blocks-only order closed through collateral delivery.
    /// @dev Emitted by BlocksOnlyCoordinator after the bound collateral is delivered to the recorded lender.
    ///      payload = abi.encode(address coordinator, uint256 orderId, address borrower, address asset,
    ///      address lender, address collateralAsset, uint256 collateralAmount, uint256 closeBlock)
    ///      `collateralAmount` uses collateral-asset base units and `closeBlock` is the block number at which the
    ///      order transitioned to the maturity-delivery terminal state.
    bytes32 public constant DATA_TYPE_BLOCKS_ONLY_DELIVERED =
        keccak256("BLOCKS_ONLY_DELIVERED");
    /// @notice DataPush type for a trade-style close of a debt-free blocks-only order.
    /// @dev Emitted by BlocksOnlyCoordinator after collateral release and order close without waiting for maturity.
    ///      payload = abi.encode(address coordinator, uint256 orderId, address borrower, address asset,
    ///      uint256 closeBlock)
    ///      `closeBlock` is the block number at which the order transitioned to TRADE_CLOSED.
    bytes32 public constant DATA_TYPE_BLOCKS_ONLY_TRADE_CLOSED =
        keccak256("BLOCKS_ONLY_TRADE_CLOSED");
    /// @notice Legacy reserved DataPush type for the removed blocks-only liquidation path.
    /// @dev Kept only for hash/ABI compatibility with historical artifacts. The current trade-like maturity-delivery
    ///      implementation emits {DATA_TYPE_BLOCKS_ONLY_DELIVERED} instead.
    ///      payload = abi.encode(address coordinator, uint256 orderId, address borrower, address asset,
    ///      address liquidator, address collateralAsset, uint256 collateralAmount, uint256 debtAmount,
    ///      uint256 closeBlock)
    ///      `collateralAmount` uses collateral-asset base units; `debtAmount` uses debt-asset base units.
    bytes32 public constant DATA_TYPE_BLOCKS_ONLY_LIQUIDATED =
        keccak256("BLOCKS_ONLY_LIQUIDATED");
    /// @notice Loan flow statistics update (borrow/repay volume counters).
    /// @dev payload = abi.encode(
    ///      address user,
    ///      uint256 borrowDeltaValue,
    ///      uint256 repayDeltaValue,
    ///      uint8 valuationDecimals,
    ///      uint64 nextVersion,
    ///      bytes32 requestId,
    ///      uint64 seq,
    ///      uint256 blockNumber
    ///      )
    ///      `borrowDeltaValue/repayDeltaValue` use the shared system valuation unit and
    ///      `valuationDecimals` declares the pushed precision.
    bytes32 public constant DATA_TYPE_LOAN_FLOW_UPDATED =
        keccak256("LOAN_FLOW_UPDATED");

    bytes32 public constant DATA_TYPE_LOAN_NFT_MINTED =
        keccak256("LOAN_NFT_MINTED");
    bytes32 public constant DATA_TYPE_LOAN_NFT_LOCKED =
        keccak256("LOAN_NFT_LOCKED");
    bytes32 public constant DATA_TYPE_LOAN_NFT_BURNED =
        keccak256("LOAN_NFT_BURNED");
    bytes32 public constant DATA_TYPE_LOAN_NFT_STATUS_UPDATED =
        keccak256("LOAN_NFT_STATUS_UPDATED");
    bytes32 public constant DATA_TYPE_LOAN_NFT_REGISTRY_UPDATED =
        keccak256("LOAN_NFT_REGISTRY_UPDATED");
    bytes32 public constant DATA_TYPE_LOAN_NFT_PAUSED =
        keccak256("LOAN_NFT_PAUSED");
    bytes32 public constant DATA_TYPE_LOAN_NFT_UNPAUSED =
        keccak256("LOAN_NFT_UNPAUSED");

    /*━━━━━━━━━━━━━━━ COLLATERALMANAGER ━━━━━━━━━━━━━━━*/
    bytes32 public constant DATA_TYPE_DEPOSIT_PROCESSED =
        keccak256("DEPOSIT_PROCESSED");
    bytes32 public constant DATA_TYPE_WITHDRAW_PROCESSED =
        keccak256("WITHDRAW_PROCESSED");
    bytes32 public constant DATA_TYPE_BATCH_DEPOSIT_PROCESSED =
        keccak256("BATCH_DEPOSIT_PROCESSED");
    bytes32 public constant DATA_TYPE_BATCH_WITHDRAW_PROCESSED =
        keccak256("BATCH_WITHDRAW_PROCESSED");

    /*━━━━━━━━━━━━━━━ LENDER RESERVE FLOW ━━━━━━━━━━━━━━━*/
    /// @dev payload = abi.encode(bytes32 lendIntentHash, address lenderSigner, address asset,
    ///      uint256 amount, uint256 blockNumber)
    bytes32 public constant DATA_TYPE_RESERVE_FOR_LENDING =
        keccak256("RESERVE_FOR_LENDING");
    /// @dev payload = abi.encode(bytes32 lendIntentHash, address lenderSigner, address asset,
    ///      uint256 amount, uint256 blockNumber)
    bytes32 public constant DATA_TYPE_CANCEL_RESERVE =
        keccak256("CANCEL_RESERVE");
    /// @dev payload = abi.encode(bytes32 lendIntentHash, address lenderSigner, address asset,
    ///      uint256 amount, uint256 blockNumber)
    bytes32 public constant DATA_TYPE_RESERVE_CONSUMED =
        keccak256("RESERVE_CONSUMED");

    /*━━━━━━━━━━━━━━━ SETTLEMENTMANAGER (REPAY / SETTLE) ━━━━━━━━━━━━━━━*/
    /// @dev payload = abi.encode(address user, address debtAsset, uint256 repayAmount, uint256 orderId,
    ///      bool releasedAllCollateral, uint256 blockNumber)
    bytes32 public constant DATA_TYPE_REPAY_AND_SETTLE =
        keccak256("REPAY_AND_SETTLE");
    /// @dev payload = abi.encode(address user, address collateralAsset, uint256 collateralAmount, uint256 blockNumber)
    bytes32 public constant DATA_TYPE_COLLATERAL_RELEASED =
        keccak256("COLLATERAL_RELEASED");

    /*━━━━━━━━━━━━━━━ GUARANTEEFUNDMANAGER ━━━━━━━━━━━━━━━*/
    bytes32 public constant DATA_TYPE_GUARANTEE_LOCKED =
        keccak256("GUARANTEE_LOCKED");
    bytes32 public constant DATA_TYPE_GUARANTEE_RELEASED =
        keccak256("GUARANTEE_RELEASED");
    bytes32 public constant DATA_TYPE_GUARANTEE_FORFEITED =
        keccak256("GUARANTEE_FORFEITED");
    bytes32 public constant DATA_TYPE_BATCH_GUARANTEE_LOCKED =
        keccak256("BATCH_GUARANTEE_LOCKED");
    bytes32 public constant DATA_TYPE_BATCH_GUARANTEE_RELEASED =
        keccak256("BATCH_GUARANTEE_RELEASED");

    /*━━━━━━━━━━━━━━━ ACCESSCONTROLVIEW ━━━━━━━━━━━━━━━*/
    bytes32 public constant DATA_TYPE_PERMISSION_BIT_UPDATE =
        keccak256("PERMISSION_BIT_UPDATE");
    bytes32 public constant DATA_TYPE_PERMISSION_LEVEL_UPDATE =
        keccak256("PERMISSION_LEVEL_UPDATE");

    /*━━━━━━━━━━━━━━━ ASSETWHITELIST ━━━━━━━━━━━━━━━*/
    /// @dev payload = abi.encode(address asset, address actor, uint256 blockNumber)
    bytes32 public constant DATA_TYPE_ASSET_WHITELIST_ADDED =
        keccak256("ASSET_WHITELIST_ADDED");
    /// @dev payload = abi.encode(address asset, address actor, uint256 blockNumber)
    bytes32 public constant DATA_TYPE_ASSET_WHITELIST_REMOVED =
        keccak256("ASSET_WHITELIST_REMOVED");
    /// @dev payload = abi.encode(
    ///      address[] assets,
    ///      address actor,
    ///      uint256 addedCount,
    ///      uint256 totalCount,
    ///      uint256 blockNumber
    ///      )
    bytes32 public constant DATA_TYPE_ASSET_WHITELIST_BATCH_ADDED =
        keccak256("ASSET_WHITELIST_BATCH_ADDED");
    /// @dev payload = abi.encode(
    ///      address[] assets,
    ///      address actor,
    ///      uint256 removedCount,
    ///      uint256 totalCount,
    ///      uint256 blockNumber
    ///      )
    bytes32 public constant DATA_TYPE_ASSET_WHITELIST_BATCH_REMOVED =
        keccak256("ASSET_WHITELIST_BATCH_REMOVED");
    /// @dev payload = abi.encode(address asset, address actor, uint256 blockNumber)
    bytes32 public constant DATA_TYPE_ASSET_WHITELIST_INFO_UPDATED =
        keccak256("ASSET_WHITELIST_INFO_UPDATED");
    /// @dev payload = abi.encode(address oldRegistry, address newRegistry, address actor, uint256 blockNumber)
    bytes32 public constant DATA_TYPE_ASSET_WHITELIST_REGISTRY_UPDATED =
        keccak256("ASSET_WHITELIST_REGISTRY_UPDATED");

    /*━━━━━━━━━━━━━━━ VIEW / STATS ━━━━━━━━━━━━━━━*/
    bytes32 public constant DATA_TYPE_SYSTEM_STATUS =
        keccak256("SYSTEM_STATUS_CACHE");
    bytes32 public constant DATA_TYPE_USER_FEE = keccak256("USER_FEE");
    bytes32 public constant DATA_TYPE_GLOBAL_FEE_STATS =
        keccak256("GLOBAL_FEE_STATS");
    bytes32 public constant DATA_TYPE_FEE_ROUTER_SYSTEM_CONFIG_UPDATED =
        keccak256("FEE_ROUTER_SYSTEM_CONFIG_UPDATED");
    bytes32 public constant DATA_TYPE_FEE_ROUTER_GLOBAL_FEE_STATISTIC_UPDATED =
        keccak256("FEE_ROUTER_GLOBAL_FEE_STATISTIC_UPDATED");
    bytes32 public constant DATA_TYPE_USER_POSITION_UPDATE =
        keccak256("USER_POSITION_UPDATE");
    /// @dev StatisticsView user-scoped stats update (cache + global aggregates).
    bytes32 public constant DATA_TYPE_USER_STATS_UPDATE =
        keccak256("USER_STATS_UPDATE");
    /// @dev StatisticsView guarantee aggregation update.
    bytes32 public constant DATA_TYPE_GUARANTEE_STATS_UPDATE =
        keccak256("GUARANTEE_STATS_UPDATE");
    /// @dev StatisticsView lightweight snapshot marker (observability for recordSnapshot).
    bytes32 public constant DATA_TYPE_STATS_SNAPSHOT_RECORDED =
        keccak256("STATS_SNAPSHOT_RECORDED");
    bytes32 public constant DATA_TYPE_LIQUIDATION_UPDATE =
        keccak256("LIQUIDATION_UPDATE");
    bytes32 public constant DATA_TYPE_LIQUIDATION_BATCH_UPDATE =
        keccak256("LIQUIDATION_BATCH_UPDATE");
    bytes32 public constant DATA_TYPE_LIQUIDATION_PAYOUT =
        keccak256("LIQUIDATION_PAYOUT");
    bytes32 public constant DATA_TYPE_USER_VIEW_INITIALIZED =
        keccak256("USER_VIEW_INITIALIZED");
    bytes32 public constant DATA_TYPE_DEGRADATION_STATS_UPDATE =
        keccak256("DEGRADATION_STATS_UPDATE");
    bytes32 public constant DATA_TYPE_HISTORY = keccak256("EVENT_HISTORY");
    bytes32 public constant DATA_TYPE_HEALTH_FACTOR =
        keccak256("HEALTH_FACTOR_UPDATE");
    bytes32 public constant DATA_TYPE_RISK_STATUS =
        keccak256("RISK_STATUS_UPDATE");
    bytes32 public constant DATA_TYPE_RISK_STATUS_BATCH =
        keccak256("RISK_STATUS_UPDATE_BATCH");

    /*━━━━━━━━━━━━━━━ REWARD ━━━━━━━━━━━━━━━*/
    bytes32 public constant DATA_TYPE_REWARD_BURNED =
        keccak256("REWARD_BURNED");
    bytes32 public constant DATA_TYPE_REWARD_LEVEL_UPDATED =
        keccak256("REWARD_LEVEL_UPDATED");
    bytes32 public constant DATA_TYPE_REWARD_PRIVILEGE_UPDATED =
        keccak256("REWARD_PRIVILEGE_UPDATED");
    bytes32 public constant DATA_TYPE_REWARD_STATS_UPDATED =
        keccak256("REWARD_STATS_UPDATED");
    /// @notice Penalty ledger update (user pending Easy debt).
    /// @dev payload = abi.encode(address user, uint256 pendingDebt, uint256 blockNumber)
    bytes32 public constant DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED =
        keccak256("REWARD_PENALTY_LEDGER_UPDATED");

    /// @notice Easy minted (borrower/lender) update.
    /// @dev payload = abi.encode(address borrower, address lender, uint256 totalMinted, uint256 borrowerShare,
    ///      uint256 lenderShare, uint256 orderId, uint256 amountValue, uint8 valuationDecimals, uint256 blockNumber)
    ///      `totalMinted/borrowerShare/lenderShare` use Easy token 18-decimal base units.
    ///      `amountValue` uses the shared system valuation unit and `valuationDecimals` declares its precision.
    bytes32 public constant DATA_TYPE_EASY_MINTED = keccak256("EASY_MINTED");

    /// @notice Easy spent (per-call) update.
    /// @dev payload = abi.encode(address user, uint8 spendType, uint256 amount, uint256 blockNumber)
    bytes32 public constant DATA_TYPE_EASY_SPENT = keccak256("EASY_SPENT");

    /// @notice Easy recycled split (burn/team/eco).
    /// @dev payload = abi.encode(address payer, uint256 amount, uint256 burnAmount, uint256 teamAmount,
    ///      uint256 ecoAmount, uint8 spendType, uint256 blockNumber)
    bytes32 public constant DATA_TYPE_EASY_RECYCLED_SPLIT =
        keccak256("EASY_RECYCLED_SPLIT");

    /// @notice Easy staked update.
    /// @dev payload = abi.encode(address user, uint256 amount, uint256 newStaked, uint256 blockNumber)
    bytes32 public constant DATA_TYPE_EASY_STAKED = keccak256("EASY_STAKED");

    /// @notice Easy unstaked update.
    /// @dev payload = abi.encode(address user, uint256 amount, uint256 newStaked, uint256 blockNumber)
    bytes32 public constant DATA_TYPE_EASY_UNSTAKED =
        keccak256("EASY_UNSTAKED");

    /// @notice Easy emission params updated.
    /// @dev payload = abi.encode(
    ///      uint256 thresholdValue,
    ///      uint8 valuationDecimals,
    ///      uint256 mintPer1000Usd,
    ///      uint256 kNum,
    ///      uint256 kDen,
    ///      uint256 blockNumber
    ///      )
    ///      `thresholdValue` uses the shared system valuation unit and `valuationDecimals` declares its precision.
    ///      `mintPer1000Usd` uses Easy token 18-decimal base units.
    bytes32 public constant DATA_TYPE_EASY_EMISSION_PARAMS_UPDATED =
        keccak256("EASY_EMISSION_PARAMS_UPDATED");

    /// @notice Earn-side dynamic reward parameters updated (governance observability).
    /// @dev payload = abi.encode(uint256 thresholdEasy, uint256 multiplierBps, uint256 blockNumber)
    bytes32 public constant DATA_TYPE_REWARD_DYNAMIC_REWARD_PARAMS_UPDATED =
        keccak256("REWARD_DYNAMIC_REWARD_PARAMS_UPDATED");

    /// @notice Earn-side level multiplier updated (governance observability).
    /// @dev payload = abi.encode(uint8 level, uint256 multiplierBps, uint256 blockNumber)
    bytes32 public constant DATA_TYPE_REWARD_LEVEL_MULTIPLIER_UPDATED =
        keccak256("REWARD_LEVEL_MULTIPLIER_UPDATED");

    /// @notice Per-user earn state updated.
    /// @dev payload = abi.encode(address user, uint256 lockedEasy, uint256 eligibleLoanCount,
    ///      uint256 onTimeRepayCount, uint256 blockNumber)
    bytes32 public constant DATA_TYPE_REWARD_EARN_STATE_UPDATED =
        keccak256("REWARD_EARN_STATE_UPDATED");
}
