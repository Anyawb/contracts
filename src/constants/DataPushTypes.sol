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
    bytes32 public constant DATA_TYPE_REGISTRY_UPDATED         = keccak256("REGISTRY_UPDATED");
    bytes32 public constant DATA_TYPE_MODULE_HEALTH            = keccak256("MODULE_HEALTH");
    /// @dev Component/service health alert with human-readable details (string).
    ///      payload = abi.encode(address component, string name, bool ok, string details, uint256 ts)
    bytes32 public constant DATA_TYPE_COMPONENT_HEALTH         = keccak256("COMPONENT_HEALTH");
    /// @dev User-scoped degradation event (frontends can filter by user).
    bytes32 public constant DATA_TYPE_USER_DEGRADATION         = keccak256("USER_DEGRADATION");

    /*━━━━━━━━━━━━━━━ COINGECKO PRICE UPDATER ━━━━━━━━━━━━━━━*/
    bytes32 public constant DATA_TYPE_PRICE_UPDATED            = keccak256("PRICE_UPDATED");
    bytes32 public constant DATA_TYPE_PRICE_UPDATE_FAILED      = keccak256("PRICE_UPDATE_FAILED");
    bytes32 public constant DATA_TYPE_PRICE_VALIDATION_FAILED  = keccak256("PRICE_VALIDATION_FAILED");
    bytes32 public constant DATA_TYPE_AUTO_UPDATE_TOGGLED      = keccak256("AUTO_UPDATE_TOGGLED");
    bytes32 public constant DATA_TYPE_PRICE_VALIDATION_TOGGLED = keccak256("PRICE_VALIDATION_TOGGLED");
    bytes32 public constant DATA_TYPE_MONITORING_REGISTERED    = keccak256("MONITORING_REGISTERED");
    bytes32 public constant DATA_TYPE_BACKUP_SOURCE_REGISTERED = keccak256("BACKUP_SOURCE_REGISTERED");

    /*━━━━━━━━━━━━━━━ FEEROUTER ━━━━━━━━━━━━━━━*/
    bytes32 public constant DATA_TYPE_FEE_DISTRIBUTED          = keccak256("FEE_DISTRIBUTED");
    bytes32 public constant DATA_TYPE_BATCH_FEE_DISTRIBUTED    = keccak256("BATCH_FEE_DISTRIBUTED");
    bytes32 public constant DATA_TYPE_FEE_CONFIG_UPDATED       = keccak256("FEE_CONFIG_UPDATED");
    bytes32 public constant DATA_TYPE_TREASURY_UPDATED         = keccak256("TREASURY_UPDATED");
    bytes32 public constant DATA_TYPE_TOKEN_SUPPORTED          = keccak256("TOKEN_SUPPORTED");
    bytes32 public constant DATA_TYPE_FEE_CACHE_CLEARED        = keccak256("FEE_CACHE_CLEARED");
    bytes32 public constant DATA_TYPE_PAUSE_STATUS_UPDATED     = keccak256("PAUSE_STATUS_UPDATED");
    bytes32 public constant DATA_TYPE_DYNAMIC_FEE_UPDATED      = keccak256("DYNAMIC_FEE_UPDATED");

    /*━━━━━━━━━━━━━━━ LENDING / LOANNFT ━━━━━━━━━━━━━━━*/
    bytes32 public constant DATA_TYPE_LOAN_CREATED             = keccak256("LOAN_CREATED");
    bytes32 public constant DATA_TYPE_LOAN_REPAID              = keccak256("LOAN_REPAID");

    bytes32 public constant DATA_TYPE_LOAN_NFT_MINTED           = keccak256("LOAN_NFT_MINTED");
    bytes32 public constant DATA_TYPE_LOAN_NFT_LOCKED           = keccak256("LOAN_NFT_LOCKED");
    bytes32 public constant DATA_TYPE_LOAN_NFT_BURNED           = keccak256("LOAN_NFT_BURNED");
    bytes32 public constant DATA_TYPE_LOAN_NFT_STATUS_UPDATED   = keccak256("LOAN_NFT_STATUS_UPDATED");
    bytes32 public constant DATA_TYPE_LOAN_NFT_REGISTRY_UPDATED = keccak256("LOAN_NFT_REGISTRY_UPDATED");
    bytes32 public constant DATA_TYPE_LOAN_NFT_PAUSED           = keccak256("LOAN_NFT_PAUSED");
    bytes32 public constant DATA_TYPE_LOAN_NFT_UNPAUSED         = keccak256("LOAN_NFT_UNPAUSED");

    /*━━━━━━━━━━━━━━━ COLLATERALMANAGER ━━━━━━━━━━━━━━━*/
    bytes32 public constant DATA_TYPE_DEPOSIT_PROCESSED        = keccak256("DEPOSIT_PROCESSED");
    bytes32 public constant DATA_TYPE_WITHDRAW_PROCESSED       = keccak256("WITHDRAW_PROCESSED");
    bytes32 public constant DATA_TYPE_BATCH_DEPOSIT_PROCESSED  = keccak256("BATCH_DEPOSIT_PROCESSED");
    bytes32 public constant DATA_TYPE_BATCH_WITHDRAW_PROCESSED = keccak256("BATCH_WITHDRAW_PROCESSED");

    /*━━━━━━━━━━━━━━━ LENDER RESERVE FLOW ━━━━━━━━━━━━━━━*/
    /// @dev payload = abi.encode(bytes32 lendIntentHash, address lenderSigner, address asset,
    ///      uint256 amount, uint256 ts)
    bytes32 public constant DATA_TYPE_RESERVE_FOR_LENDING      = keccak256("RESERVE_FOR_LENDING");
    /// @dev payload = abi.encode(bytes32 lendIntentHash, address lenderSigner, address asset,
    ///      uint256 amount, uint256 ts)
    bytes32 public constant DATA_TYPE_CANCEL_RESERVE           = keccak256("CANCEL_RESERVE");
    /// @dev payload = abi.encode(bytes32 lendIntentHash, address lenderSigner, address asset,
    ///      uint256 amount, uint256 ts)
    bytes32 public constant DATA_TYPE_RESERVE_CONSUMED         = keccak256("RESERVE_CONSUMED");

    /*━━━━━━━━━━━━━━━ SETTLEMENTMANAGER (REPAY / SETTLE) ━━━━━━━━━━━━━━━*/
    /// @dev payload = abi.encode(address user, address debtAsset, uint256 repayAmount, uint256 orderId,
    ///      bool releasedAllCollateral, uint256 ts)
    bytes32 public constant DATA_TYPE_REPAY_AND_SETTLE         = keccak256("REPAY_AND_SETTLE");
    /// @dev payload = abi.encode(address user, address collateralAsset, uint256 collateralAmount, uint256 ts)
    bytes32 public constant DATA_TYPE_COLLATERAL_RELEASED      = keccak256("COLLATERAL_RELEASED");

    /*━━━━━━━━━━━━━━━ GUARANTEEFUNDMANAGER ━━━━━━━━━━━━━━━*/
    bytes32 public constant DATA_TYPE_GUARANTEE_LOCKED         = keccak256("GUARANTEE_LOCKED");
    bytes32 public constant DATA_TYPE_GUARANTEE_RELEASED       = keccak256("GUARANTEE_RELEASED");
    bytes32 public constant DATA_TYPE_GUARANTEE_FORFEITED      = keccak256("GUARANTEE_FORFEITED");
    bytes32 public constant DATA_TYPE_BATCH_GUARANTEE_LOCKED   = keccak256("BATCH_GUARANTEE_LOCKED");
    bytes32 public constant DATA_TYPE_BATCH_GUARANTEE_RELEASED = keccak256("BATCH_GUARANTEE_RELEASED");

    /*━━━━━━━━━━━━━━━ ACCESSCONTROLVIEW ━━━━━━━━━━━━━━━*/
    bytes32 public constant DATA_TYPE_PERMISSION_BIT_UPDATE    = keccak256("PERMISSION_BIT_UPDATE");
    bytes32 public constant DATA_TYPE_PERMISSION_LEVEL_UPDATE  = keccak256("PERMISSION_LEVEL_UPDATE");

    /*━━━━━━━━━━━━━━━ ASSETWHITELIST ━━━━━━━━━━━━━━━*/
    /// @dev payload = abi.encode(address asset, address actor, uint256 ts)
    bytes32 public constant DATA_TYPE_ASSET_WHITELIST_ADDED        = keccak256("ASSET_WHITELIST_ADDED");
    /// @dev payload = abi.encode(address asset, address actor, uint256 ts)
    bytes32 public constant DATA_TYPE_ASSET_WHITELIST_REMOVED      = keccak256("ASSET_WHITELIST_REMOVED");
    /// @dev payload = abi.encode(address[] assets, address actor, uint256 addedCount, uint256 totalCount, uint256 ts)
    bytes32 public constant DATA_TYPE_ASSET_WHITELIST_BATCH_ADDED  = keccak256("ASSET_WHITELIST_BATCH_ADDED");
    /// @dev payload = abi.encode(address[] assets, address actor, uint256 removedCount, uint256 totalCount, uint256 ts)
    bytes32 public constant DATA_TYPE_ASSET_WHITELIST_BATCH_REMOVED = keccak256("ASSET_WHITELIST_BATCH_REMOVED");
    /// @dev payload = abi.encode(address asset, address actor, uint256 ts)
    bytes32 public constant DATA_TYPE_ASSET_WHITELIST_INFO_UPDATED = keccak256("ASSET_WHITELIST_INFO_UPDATED");
    /// @dev payload = abi.encode(address oldRegistry, address newRegistry, address actor, uint256 ts)
    bytes32 public constant DATA_TYPE_ASSET_WHITELIST_REGISTRY_UPDATED =
        keccak256("ASSET_WHITELIST_REGISTRY_UPDATED");

    /*━━━━━━━━━━━━━━━ VIEW / STATS ━━━━━━━━━━━━━━━*/
    bytes32 public constant DATA_TYPE_SYSTEM_STATUS        = keccak256("SYSTEM_STATUS_CACHE");
    bytes32 public constant DATA_TYPE_USER_FEE             = keccak256("USER_FEE");
    bytes32 public constant DATA_TYPE_GLOBAL_FEE_STATS     = keccak256("GLOBAL_FEE_STATS");
    bytes32 public constant DATA_TYPE_FEE_ROUTER_SYSTEM_CONFIG_UPDATED =
        keccak256("FEE_ROUTER_SYSTEM_CONFIG_UPDATED");
    bytes32 public constant DATA_TYPE_FEE_ROUTER_GLOBAL_FEE_STATISTIC_UPDATED =
        keccak256("FEE_ROUTER_GLOBAL_FEE_STATISTIC_UPDATED");
    bytes32 public constant DATA_TYPE_USER_POSITION_UPDATE     = keccak256("USER_POSITION_UPDATE");
    /// @dev StatisticsView user-scoped stats update (cache + global aggregates).
    bytes32 public constant DATA_TYPE_USER_STATS_UPDATE        = keccak256("USER_STATS_UPDATE");
    /// @dev StatisticsView guarantee aggregation update.
    bytes32 public constant DATA_TYPE_GUARANTEE_STATS_UPDATE   = keccak256("GUARANTEE_STATS_UPDATE");
    /// @dev StatisticsView lightweight snapshot marker (observability for recordSnapshot).
    bytes32 public constant DATA_TYPE_STATS_SNAPSHOT_RECORDED  = keccak256("STATS_SNAPSHOT_RECORDED");
    bytes32 public constant DATA_TYPE_LIQUIDATION_UPDATE       = keccak256("LIQUIDATION_UPDATE");
    bytes32 public constant DATA_TYPE_LIQUIDATION_BATCH_UPDATE = keccak256("LIQUIDATION_BATCH_UPDATE");
    bytes32 public constant DATA_TYPE_LIQUIDATION_PAYOUT       = keccak256("LIQUIDATION_PAYOUT");
    bytes32 public constant DATA_TYPE_USER_VIEW_INITIALIZED    = keccak256("USER_VIEW_INITIALIZED");
    bytes32 public constant DATA_TYPE_DEGRADATION_STATS_UPDATE = keccak256("DEGRADATION_STATS_UPDATE");
    bytes32 public constant DATA_TYPE_HISTORY                  = keccak256("EVENT_HISTORY");
    bytes32 public constant DATA_TYPE_HEALTH_FACTOR            = keccak256("HEALTH_FACTOR_UPDATE");
    bytes32 public constant DATA_TYPE_RISK_STATUS              = keccak256("RISK_STATUS_UPDATE");
    bytes32 public constant DATA_TYPE_RISK_STATUS_BATCH        = keccak256("RISK_STATUS_UPDATE_BATCH");

    /*━━━━━━━━━━━━━━━ REWARD ━━━━━━━━━━━━━━━*/
    bytes32 public constant DATA_TYPE_REWARD_EARNED            = keccak256("REWARD_EARNED");
    bytes32 public constant DATA_TYPE_REWARD_BURNED            = keccak256("REWARD_BURNED");
    bytes32 public constant DATA_TYPE_REWARD_LEVEL_UPDATED     = keccak256("REWARD_LEVEL_UPDATED");
    bytes32 public constant DATA_TYPE_REWARD_PRIVILEGE_UPDATED = keccak256("REWARD_PRIVILEGE_UPDATED");
    bytes32 public constant DATA_TYPE_REWARD_STATS_UPDATED     = keccak256("REWARD_STATS_UPDATED");
    /// @notice Penalty ledger update (user pending debt points).
    /// @dev payload = abi.encode(address user, uint256 pendingDebt, uint256 ts)
    bytes32 public constant DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED = keccak256("REWARD_PENALTY_LEDGER_UPDATED");
    /// @notice Reward consumption record update.
    /// @dev payload = abi.encode(address user, uint8 serviceType, uint8 serviceLevel, uint256 points, uint256 expirationTime, uint256 ts)
    bytes32 public constant DATA_TYPE_REWARD_CONSUMPTION_RECORDED = keccak256("REWARD_CONSUMPTION_RECORDED");
}


