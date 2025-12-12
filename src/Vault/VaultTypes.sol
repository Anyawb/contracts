// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";

/// @title VaultTypes
/// @notice 常量、错误声明与事件统一管理，供所有 Vault 相关模块复用
/// @dev 这是一个库合约，包含 Vault 系统的所有类型定义
/// @dev 所有事件定义集中在此，确保唯一性和一致性
/// @dev 重命名自CollateralVaultTypes，提供统一的类型定义
/// @dev 与 ActionKeys 和 ModuleKeys 集成，提供标准化的事件和常量管理
library VaultTypes {
    /* ============ Constants ============ */
    /// @notice 精度常量，用于计算时的精度控制
    uint256 internal constant PRECISION = 1e18;
    
    /// @notice 100% 的基点表示，用于百分比计算
    uint256 internal constant HUNDRED_PERCENT = 10_000; // 100% = 10000 (basis points)
    
    /// @notice 最大贷款价值比（LTV），85% 的基点表示
    uint256 internal constant MAX_LTV = 8_500; // 85% in basis points

    /// @notice 最小健康因子，110% 的基点表示
    uint256 internal constant MIN_HEALTH_FACTOR = 11_000; // 110% in basis points

    /// @notice 清算奖励，10% 的基点表示
    uint256 internal constant LIQUIDATION_BONUS = 1_000; // 10% in basis points

    /* ============ Errors ============ */
    // 所有错误定义已移至 StandardErrors.sol 以确保一致性
    // 请使用 import { ZeroAddress, NotGovernance, NotKeeper, NotWhitelisted, AssetNotAllowed } from "../errors/StandardErrors.sol";

    /* ============ Events ============ */
    
    // ---------- Core Business Events ----------
    /// @notice 用户存入抵押物事件
    /// @param user 用户地址
    /// @param asset 抵押资产地址
    /// @param amount 存入金额
    /// @param timestamp 操作时间戳
    /// @dev 对应 ActionKeys.ACTION_DEPOSIT
    event Deposit(
        address indexed user, 
        address indexed asset, 
        uint256 amount,
        uint256 timestamp
    );
    
    /// @notice 用户提取抵押物事件
    /// @param user 用户地址
    /// @param asset 抵押资产地址
    /// @param amount 提取金额
    /// @param timestamp 操作时间戳
    /// @dev 对应 ActionKeys.ACTION_WITHDRAW
    event Withdraw(
        address indexed user, 
        address indexed asset, 
        uint256 amount,
        uint256 timestamp
    );
    
    /// @notice 用户借款事件
    /// @param user 用户地址
    /// @param asset 借款资产地址
    /// @param amount 借款金额
    /// @param timestamp 操作时间戳
    /// @dev 对应 ActionKeys.ACTION_BORROW
    event Borrow(
        address indexed user, 
        address indexed asset, 
        uint256 amount,
        uint256 timestamp
    );
    
    /// @notice 用户还款事件
    /// @param user 用户地址
    /// @param asset 还款资产地址
    /// @param amount 还款金额
    /// @param timestamp 操作时间戳
    /// @dev 对应 ActionKeys.ACTION_REPAY
    event Repay(
        address indexed user, 
        address indexed asset, 
        uint256 amount,
        uint256 timestamp
    );
    
    /// @notice 清算事件
    /// @param liquidator 清算人地址
    /// @param user 被清算用户地址
    /// @param asset 清算资产地址
    /// @param amount 清算金额
    /// @param bonus 清算奖励
    /// @param timestamp 操作时间戳
    /// @dev 对应 ActionKeys.ACTION_LIQUIDATE
    event Liquidation(
        address indexed liquidator,
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 bonus,
        uint256 timestamp
    );

    // ---------- Fee & Reward Events ----------
    /// @notice 手续费支付事件
    /// @param user 用户地址
    /// @param amount 手续费金额
    /// @param isBorrowFee 是否为借款手续费
    /// @param timestamp 操作时间戳
    event FeePaid(
        address indexed user, 
        uint256 amount, 
        bool isBorrowFee,
        uint256 timestamp
    );
    
    /// @notice 奖励发放事件
    /// @param user 用户地址
    /// @param points 奖励积分
    /// @param reason 奖励原因
    /// @param timestamp 操作时间戳
    /// @dev 对应 ActionKeys.ACTION_CLAIM_REWARD
    event RewardEarned(
        address indexed user,
        uint256 points,
        string reason,
        uint256 timestamp
    );

    /// @notice 资产添加到白名单事件
    /// @param asset 资产地址
    /// @param addedBy 添加者地址
    /// @param timestamp 添加时间戳
    /// @dev 对应 ActionKeys.ACTION_MANAGE_WHITELIST
    event AssetAdded(
        address indexed asset, 
        address indexed addedBy,
        uint256 timestamp
    );

    /// @notice 资产从白名单移除事件
    /// @param asset 资产地址
    /// @param removedBy 移除者地址
    /// @param timestamp 移除时间戳
    /// @dev 对应 ActionKeys.ACTION_MANAGE_WHITELIST
    event AssetRemoved(
        address indexed asset, 
        address indexed removedBy,
        uint256 timestamp
    );

    // ---------- Composite Business Events ----------
    /// @notice 存入抵押物并借款的复合事件
    /// @param user 用户地址
    /// @param collateralAsset 抵押资产地址
    /// @param collateral 抵押物金额
    /// @param borrowAsset 借款资产地址
    /// @param borrow 借款金额
    /// @param timestamp 操作时间戳
    /// @dev 对应 ActionKeys.ACTION_DEPOSIT 和 ActionKeys.ACTION_BORROW 的组合
    event DepositAndBorrow(
        address indexed user, 
        address indexed collateralAsset, 
        uint256 collateral, 
        address indexed borrowAsset, 
        uint256 borrow,
        uint256 timestamp
    );
    
    /// @notice 还款并提取抵押物的复合事件
    /// @param user 用户地址
    /// @param repayAsset 还款资产地址
    /// @param repay 还款金额
    /// @param withdrawAsset 提取抵押资产地址
    /// @param withdraw 提取金额
    /// @param timestamp 操作时间戳
    /// @dev 对应 ActionKeys.ACTION_REPAY 和 ActionKeys.ACTION_WITHDRAW 的组合
    event RepayAndWithdraw(
        address indexed user, 
        address indexed repayAsset, 
        uint256 repay, 
        address indexed withdrawAsset, 
        uint256 withdraw,
        uint256 timestamp
    );

    // ---------- Governance & Parameter Events ----------
    /// @notice Vault 初始化事件
    /// @param collateralManager 抵押管理模块地址
    /// @param lendingEngine 借贷引擎模块地址
    /// @param hfCalculator 健康因子计算器地址（已废弃，固定为 address(0)）
    /// @param vaultStatistics 金库统计模块地址
    /// @param timestamp 初始化时间戳
    /// @dev 使用 ModuleKeys 进行模块引用
    event VaultInitialized(
        address indexed collateralManager,
        address indexed lendingEngine,
        address indexed hfCalculator,
        address vaultStatistics,
        uint256 timestamp
    );
    
    /// @notice 完整初始化事件，包含所有模块地址
    /// @param collateralManager 抵押管理模块地址
    /// @param lendingEngine 借贷引擎模块地址
    /// @param hfCalculator 健康因子计算器地址（已废弃，固定为 address(0)）
    /// @param vaultStatistics 金库统计模块地址
    /// @param feeRouter 手续费路由模块地址
    /// @param rewardManager 奖励管理模块地址
    /// @param timestamp 初始化时间戳
    /// @dev 使用 ModuleKeys 进行模块引用
    event VaultInitializedFull(
        address indexed collateralManager,
        address indexed lendingEngine,
        address indexed hfCalculator,
        address vaultStatistics,
        address feeRouter,
        address rewardManager,
        uint256 timestamp
    );

    /// @notice Vault 参数更新事件
    /// @param newMinHF 新的最小健康因子
    /// @param newCap 新的金库容量
    /// @param timestamp 更新时间戳
    /// @dev 对应 ActionKeys.ACTION_SET_PARAMETER
    event VaultParamsUpdated(
        uint256 newMinHF, 
        uint256 newCap,
        uint256 timestamp
    );

    /// @notice 金库容量更新事件
    /// @param oldCap 旧容量
    /// @param newCap 新容量
    /// @param timestamp 更新时间戳
    /// @dev 对应 ActionKeys.ACTION_SET_PARAMETER
    event VaultCapUpdated(
        uint256 oldCap, 
        uint256 newCap,
        uint256 timestamp
    );
    
    /// @notice 允许的 LTV 更新事件
    /// @param oldLTV 旧的 LTV 值
    /// @param newLTV 新的 LTV 值
    /// @param timestamp 更新时间戳
    /// @dev 对应 ActionKeys.ACTION_SET_PARAMETER
    event AllowedLTVUpdated(
        uint256 oldLTV, 
        uint256 newLTV,
        uint256 timestamp
    );

    /// @notice 清算奖励更新事件
    /// @param oldBonus 旧清算奖励
    /// @param newBonus 新清算奖励
    /// @param timestamp 更新时间戳
    /// @dev 对应 ActionKeys.ACTION_SET_PARAMETER
    event LiquidationBonusUpdated(
        uint256 oldBonus, 
        uint256 newBonus,
        uint256 timestamp
    );

    // ---------- Module Management Events ----------
    /// @notice 模块地址更新事件
    /// @param name 模块名称
    /// @param oldAddress 旧模块地址
    /// @param newAddress 新模块地址
    /// @param timestamp 更新时间戳
    /// @dev 对应 ActionKeys.ACTION_UPGRADE_MODULE
    event ModuleAddressUpdated(
        string indexed name, 
        address oldAddress,
        address newAddress,
        uint256 timestamp
    );
    
    /// @notice 预言机地址更新事件
    /// @param oldOracle 旧预言机地址
    /// @param newOracle 新预言机地址
    /// @param timestamp 更新时间戳
    /// @dev 对应 ActionKeys.ACTION_UPGRADE_MODULE
    event OracleUpdated(
        address indexed oldOracle, 
        address indexed newOracle,
        uint256 timestamp
    );

    // ---------- Action & Governance Events ----------
    /// @notice 标准化动作执行事件
    /// @param actionKey 动作Key（使用 ActionKeys 常量）
    /// @param actionName 动作名称（使用 ActionKeys.getActionKeyString() 获取）
    /// @param executor 执行者地址
    /// @param timestamp 执行时间戳
    /// @dev 与 ActionKeys 集成，提供标准化的动作记录
    /// @dev 在 VaultCore.sol 中被广泛使用
    event ActionExecuted(
        bytes32 indexed actionKey,
        string actionName,
        address indexed executor,
        uint256 timestamp
    );

    // ---------- External Module & Error Events ----------
    /// @notice 外部模块调用失败事件
    /// @param module 模块名称
    /// @param data 错误数据
    /// @param timestamp 失败时间戳
    event ExternalModuleReverted(
        string module, 
        bytes data,
        uint256 timestamp
    );

    /// @notice 健康因子过低警告事件
    /// @param user 用户地址
    /// @param currentHF 当前健康因子
    /// @param minHF 最小健康因子
    /// @param timestamp 警告时间戳
    event HealthFactorWarning(
        address indexed user,
        uint256 currentHF,
        uint256 minHF,
        uint256 timestamp
    );

    // ---------- Debug & Development Events ----------
    /// @notice 调试步骤事件，用于开发调试
    /// @param step 调试步骤描述
    /// @param data 调试数据
    /// @param timestamp 调试时间戳
    event DebugStep(
        string step, 
        bytes data,
        uint256 timestamp
    );

    /// @notice 性能监控事件
    /// @param operation 操作名称
    /// @param gasUsed 消耗的 gas
    /// @param timestamp 监控时间戳
    event PerformanceMonitor(
        string operation,
        uint256 gasUsed,
        uint256 timestamp
    );
} 