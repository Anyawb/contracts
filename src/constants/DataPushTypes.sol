// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title DataPushTypes
/// @notice 统一的链下数据推送类型常量库（keccak256("UPPER_SNAKE_CASE"))
/// @dev 供各业务/视图模块复用，避免散落重复定义，便于链下订阅与解析
library DataPushTypes {
    // ===== 通用 =====
    bytes32 constant DATA_TYPE_REGISTRY_UPDATED         = keccak256("REGISTRY_UPDATED");
    bytes32 constant DATA_TYPE_MODULE_HEALTH            = keccak256("MODULE_HEALTH");
    // 用户维度降级事件（前端按 user 过滤展示）
    bytes32 constant DATA_TYPE_USER_DEGRADATION         = keccak256("USER_DEGRADATION");

    // ===== CoinGeckoPriceUpdater / 价格更新 =====
    bytes32 constant DATA_TYPE_PRICE_UPDATED            = keccak256("PRICE_UPDATED");
    bytes32 constant DATA_TYPE_PRICE_UPDATE_FAILED      = keccak256("PRICE_UPDATE_FAILED");
    bytes32 constant DATA_TYPE_PRICE_VALIDATION_FAILED  = keccak256("PRICE_VALIDATION_FAILED");
    bytes32 constant DATA_TYPE_AUTO_UPDATE_TOGGLED      = keccak256("AUTO_UPDATE_TOGGLED");
    bytes32 constant DATA_TYPE_PRICE_VALIDATION_TOGGLED = keccak256("PRICE_VALIDATION_TOGGLED");
    bytes32 constant DATA_TYPE_MONITORING_REGISTERED    = keccak256("MONITORING_REGISTERED");
    bytes32 constant DATA_TYPE_BACKUP_SOURCE_REGISTERED = keccak256("BACKUP_SOURCE_REGISTERED");

    // ===== FeeRouter =====
    bytes32 constant DATA_TYPE_FEE_DISTRIBUTED          = keccak256("FEE_DISTRIBUTED");
    bytes32 constant DATA_TYPE_BATCH_FEE_DISTRIBUTED    = keccak256("BATCH_FEE_DISTRIBUTED");
    bytes32 constant DATA_TYPE_FEE_CONFIG_UPDATED       = keccak256("FEE_CONFIG_UPDATED");
    bytes32 constant DATA_TYPE_TREASURY_UPDATED         = keccak256("TREASURY_UPDATED");
    bytes32 constant DATA_TYPE_TOKEN_SUPPORTED          = keccak256("TOKEN_SUPPORTED");
    bytes32 constant DATA_TYPE_FEE_CACHE_CLEARED        = keccak256("FEE_CACHE_CLEARED");
    bytes32 constant DATA_TYPE_PAUSE_STATUS_UPDATED     = keccak256("PAUSE_STATUS_UPDATED");
    bytes32 constant DATA_TYPE_DYNAMIC_FEE_UPDATED      = keccak256("DYNAMIC_FEE_UPDATED");

    // ===== Lending / LoanNFT =====
    bytes32 constant DATA_TYPE_LOAN_CREATED             = keccak256("LOAN_CREATED");
    bytes32 constant DATA_TYPE_LOAN_REPAID              = keccak256("LOAN_REPAID");

    bytes32 constant DATA_TYPE_LOAN_NFT_MINTED          = keccak256("LOAN_NFT_MINTED");
    bytes32 constant DATA_TYPE_LOAN_NFT_LOCKED          = keccak256("LOAN_NFT_LOCKED");
    bytes32 constant DATA_TYPE_LOAN_NFT_BURNED          = keccak256("LOAN_NFT_BURNED");
    bytes32 constant DATA_TYPE_LOAN_NFT_STATUS_UPDATED  = keccak256("LOAN_NFT_STATUS_UPDATED");
    bytes32 constant DATA_TYPE_LOAN_NFT_REGISTRY_UPDATED= keccak256("LOAN_NFT_REGISTRY_UPDATED");
    bytes32 constant DATA_TYPE_LOAN_NFT_PAUSED          = keccak256("LOAN_NFT_PAUSED");
    bytes32 constant DATA_TYPE_LOAN_NFT_UNPAUSED        = keccak256("LOAN_NFT_UNPAUSED");

    // ===== CollateralManager =====
    bytes32 constant DATA_TYPE_DEPOSIT_PROCESSED        = keccak256("DEPOSIT_PROCESSED");
    bytes32 constant DATA_TYPE_WITHDRAW_PROCESSED       = keccak256("WITHDRAW_PROCESSED");
    bytes32 constant DATA_TYPE_BATCH_DEPOSIT_PROCESSED  = keccak256("BATCH_DEPOSIT_PROCESSED");
    bytes32 constant DATA_TYPE_BATCH_WITHDRAW_PROCESSED = keccak256("BATCH_WITHDRAW_PROCESSED");

    // ===== GuaranteeFundManager =====
    bytes32 constant DATA_TYPE_GUARANTEE_LOCKED         = keccak256("GUARANTEE_LOCKED");
    bytes32 constant DATA_TYPE_GUARANTEE_RELEASED       = keccak256("GUARANTEE_RELEASED");
    bytes32 constant DATA_TYPE_GUARANTEE_FORFEITED      = keccak256("GUARANTEE_FORFEITED");
    bytes32 constant DATA_TYPE_BATCH_GUARANTEE_LOCKED   = keccak256("BATCH_GUARANTEE_LOCKED");
    bytes32 constant DATA_TYPE_BATCH_GUARANTEE_RELEASED = keccak256("BATCH_GUARANTEE_RELEASED");

    // ===== AccessControlView =====
    bytes32 constant DATA_TYPE_PERMISSION_BIT_UPDATE    = keccak256("PERMISSION_BIT_UPDATE");
    bytes32 constant DATA_TYPE_PERMISSION_LEVEL_UPDATE  = keccak256("PERMISSION_LEVEL_UPDATE");

    // ===== View 层/统计 =====
    bytes32 constant DATA_TYPE_SYSTEM_STATUS            = keccak256("SYSTEM_STATUS_CACHE");
    bytes32 constant DATA_TYPE_USER_FEE                 = keccak256("USER_FEE");
    bytes32 constant DATA_TYPE_GLOBAL_FEE_STATS         = keccak256("GLOBAL_FEE_STATS");
    bytes32 constant DATA_TYPE_FEE_ROUTER_SYSTEM_CONFIG_UPDATED = keccak256("FEE_ROUTER_SYSTEM_CONFIG_UPDATED");
    bytes32 constant DATA_TYPE_FEE_ROUTER_GLOBAL_FEE_STATISTIC_UPDATED = keccak256("FEE_ROUTER_GLOBAL_FEE_STATISTIC_UPDATED");
    bytes32 constant DATA_TYPE_USER_POSITION_UPDATE     = keccak256("USER_POSITION_UPDATE");
    bytes32 constant DATA_TYPE_LIQUIDATION_UPDATE       = keccak256("LIQUIDATION_UPDATE");
    bytes32 constant DATA_TYPE_LIQUIDATION_BATCH_UPDATE = keccak256("LIQUIDATION_BATCH_UPDATE");
    bytes32 constant DATA_TYPE_LIQUIDATION_PAYOUT       = keccak256("LIQUIDATION_PAYOUT");
    bytes32 constant DATA_TYPE_USER_VIEW_INITIALIZED    = keccak256("USER_VIEW_INITIALIZED");
    bytes32 constant DATA_TYPE_DEGRADATION_STATS_UPDATE = keccak256("DEGRADATION_STATS_UPDATE");
    bytes32 constant DATA_TYPE_HISTORY                  = keccak256("EVENT_HISTORY");
    bytes32 constant DATA_TYPE_HEALTH_FACTOR            = keccak256("HEALTH_FACTOR_UPDATE");
    bytes32 constant DATA_TYPE_RISK_STATUS              = keccak256("RISK_STATUS_UPDATE");
    bytes32 constant DATA_TYPE_RISK_STATUS_BATCH        = keccak256("RISK_STATUS_UPDATE_BATCH");

    // ===== Reward / 积分相关（新增） =====
    bytes32 constant DATA_TYPE_REWARD_EARNED            = keccak256("REWARD_EARNED");
    bytes32 constant DATA_TYPE_REWARD_BURNED            = keccak256("REWARD_BURNED");
    bytes32 constant DATA_TYPE_REWARD_LEVEL_UPDATED     = keccak256("REWARD_LEVEL_UPDATED");
    bytes32 constant DATA_TYPE_REWARD_PRIVILEGE_UPDATED = keccak256("REWARD_PRIVILEGE_UPDATED");
    bytes32 constant DATA_TYPE_REWARD_STATS_UPDATED     = keccak256("REWARD_STATS_UPDATED");
    /// @notice 用户欠分账本更新（penaltyLedger）
    /// @dev payload = abi.encode(address user, uint256 pendingDebt, uint256 ts)
    bytes32 constant DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED = keccak256("REWARD_PENALTY_LEDGER_UPDATED");
}


