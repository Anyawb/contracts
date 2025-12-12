// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ICollateralManager } from "../interfaces/ICollateralManager.sol";
import { IGuaranteeFundManager } from "../interfaces/IGuaranteeFundManager.sol";
import { VaultTypes } from "../Vault/VaultTypes.sol";
import { ExternalModuleRevertedRaw, AmountIsZero, InvalidAmounts, AssetNotAllowed, ZeroAddress } from "../errors/StandardErrors.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { GracefulDegradation } from "../libraries/GracefulDegradation.sol";

/// @title VaultBusinessLogicLibrary
/// @notice 业务逻辑库，提供VaultBusinessLogic的重复功能
/// @dev 提取try/catch包装、批量操作、事件发出等重复逻辑
/// @dev 支持优雅降级和错误处理
/// @custom:security-contact security@example.com
/// @notice 统计视图最小接口（由 StatisticsView 提供），用于推送用户统计更新
interface IStatisticsViewMinimal {
    function pushUserStatsUpdate(
        address user,
        uint256 collateralIn,
        uint256 collateralOut,
        uint256 borrow,
        uint256 repay
    ) external;
}

/// @notice 统计视图最小接口（保证金聚合）
interface IStatisticsViewGuaranteeMinimal {
    function pushGuaranteeUpdate(
        address user,
        address asset,
        uint256 guaranteeAmount,
        bool isLocked
    ) external;
}

library VaultBusinessLogicLibrary {
    using SafeERC20 for IERC20;
    using GracefulDegradation for *;

    /* ============ Constants ============ */
    uint256 private constant MAX_BATCH_SIZE = 50;

    /* ============ Events ============ */
    /// @notice 业务操作事件
    /// @param operation 操作类型
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 金额
    event BusinessOperation(
        string indexed operation,
        address indexed user,
        address indexed asset,
        uint256 amount
    );

    // 已废弃：奖励相关事件与逻辑完全下沉至 LendingEngine（落账后触发）与 RewardManager 路径

    /// @notice 优雅降级事件
    /// @param asset 资产地址
    /// @param reason 降级原因
    /// @param fallbackValue 降级后的价值
    /// @param usedFallback 是否使用了降级策略
    event VaultBusinessLogicGracefulDegradation(
        address indexed asset,
        string reason,
        uint256 fallbackValue,
        bool usedFallback
    );

    /// @notice 健康度检查事件
    /// @param user 用户地址
    /// @param healthFactor 健康度
    /// @param isHealthy 是否健康
    event HealthFactorCheck(
        address indexed user,
        uint256 healthFactor,
        bool isHealthy
    );

    /* ============ 安全调用函数 ============ */
    
    /// @notice 计算预计利息（年化利率bps + 天期）
    /// @dev 纯计算，不读写状态，使用unchecked减少gas
    /// @param principal 借款本金
    /// @param annualRateBps 年化利率（bps，1e4=100%）
    /// @param termDays 借款天数
    /// @return interest 预计利息
    function calculateExpectedInterest(
        uint256 principal,
        uint256 annualRateBps,
        uint16 termDays
    ) internal pure returns (uint256 interest) {
        unchecked {
            // interest = principal * annualRateBps/1e4 * termDays/365
            // 为避免中途精度损失，按顺序进行整数除法
            // 此处按业务口径：bps 与天期线性折算
            interest = (principal * annualRateBps * uint256(termDays)) / (365 * 1e4);
        }
    }

    /// @notice 省gas版本：直接调用保证金锁定，不做try/catch降级
    /// @dev 调用方需自行保证参数合法与权限正确
    function lockGuaranteeFast(
        address guaranteeManager,
        address user,
        address asset,
        uint256 amount
    ) internal {
        IGuaranteeFundManager(guaranteeManager).lockGuarantee(user, asset, amount);
    }
    
    /// @notice 安全调用抵押物管理模块的存入功能
    /// @param collateralManager 抵押物管理合约地址
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 存入金额
    function safeDepositCollateral(
        address collateralManager,
        address user,
        address asset,
        uint256 amount
    ) internal {
        try ICollateralManager(collateralManager).depositCollateral(user, asset, amount) {
            // success
        } catch (bytes memory lowLevelData) {
            emit VaultTypes.ExternalModuleReverted("CollateralManager", lowLevelData, block.timestamp);
            revert ExternalModuleRevertedRaw("CollateralManager", lowLevelData);
        }
    }

    /// @notice 安全调用抵押物管理模块的提取功能
    /// @param collateralManager 抵押物管理合约地址
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 提取金额
    function safeWithdrawCollateral(
        address collateralManager,
        address user,
        address asset,
        uint256 amount
    ) internal {
        try ICollateralManager(collateralManager).withdrawCollateral(user, asset, amount) {
            // ok
        } catch (bytes memory lowLevelData) {
            emit VaultTypes.ExternalModuleReverted("CollateralManager", lowLevelData, block.timestamp);
            revert ExternalModuleRevertedRaw("CollateralManager", lowLevelData);
        }
    }

    // 已删除：原业务层直写账本路径（safeRecordBorrow/safeRepay）

    /// @notice 安全调用统计视图的用户统计更新功能
    /// @param statsView 统计视图合约地址（StatisticsView）
    /// @param user 用户地址
    /// @param collateralAdd 增加的抵押物价值
    /// @param collateralSub 减少的抵押物价值
    /// @param debtAdd 增加的债务价值
    /// @param debtSub 减少的债务价值
    function safeUpdateStats(
        address statsView,
        address user,
        uint256 collateralAdd,
        uint256 collateralSub,
        uint256 debtAdd,
        uint256 debtSub
    ) internal {
        try IStatisticsViewMinimal(statsView).pushUserStatsUpdate(user, collateralAdd, collateralSub, debtAdd, debtSub) {
            // ok
        } catch (bytes memory lowLevelData) {
            emit VaultTypes.ExternalModuleReverted("StatisticsView", lowLevelData, block.timestamp);
            revert ExternalModuleRevertedRaw("StatisticsView", lowLevelData);
        }
    }

    /// @notice 安全推送保证金更新到统计视图
    function safeUpdateGuarantee(
        address statsView,
        address user,
        address asset,
        uint256 amount,
        bool isLocked
    ) internal {
        if (statsView == address(0)) return;
        try IStatisticsViewGuaranteeMinimal(statsView).pushGuaranteeUpdate(user, asset, amount, isLocked) {
            // ok
        } catch (bytes memory lowLevelData) {
            emit VaultTypes.ExternalModuleReverted("StatisticsView", lowLevelData, block.timestamp);
            // 不中断主流程
        }
    }

    /// @notice 安全调用保证金管理模块的锁定功能
    /// @param guaranteeManager 保证金管理合约地址
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 保证金金额
    function safeLockGuarantee(
        address guaranteeManager,
        address user,
        address asset,
        uint256 amount
    ) internal {
        try IGuaranteeFundManager(guaranteeManager).lockGuarantee(user, asset, amount) {
            // success
        } catch (bytes memory lowLevelData) {
            emit VaultTypes.ExternalModuleReverted("GuaranteeFundManager", lowLevelData, block.timestamp);
            revert ExternalModuleRevertedRaw("GuaranteeFundManager", lowLevelData);
        }
    }

    /// @notice 安全调用保证金管理模块的释放功能
    /// @param guaranteeManager 保证金管理合约地址
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 释放金额
    function safeReleaseGuarantee(
        address guaranteeManager,
        address user,
        address asset,
        uint256 amount
    ) internal {
        try IGuaranteeFundManager(guaranteeManager).releaseGuarantee(user, asset, amount) {
            // ok
        } catch (bytes memory lowLevelData) {
            emit VaultTypes.ExternalModuleReverted("GuaranteeFundManager", lowLevelData, block.timestamp);
            revert ExternalModuleRevertedRaw("GuaranteeFundManager", lowLevelData);
        }
    }

    // 奖励触发统一在 LendingEngine 落账成功后进行；本库不再包含任何奖励相关逻辑

    /* ============ 批量操作函数 ============ */
    
    /// @notice 验证批量操作参数
    /// @param assets 资产地址数组
    /// @param amounts 金额数组
    function validateBatchParams(address[] calldata assets, uint256[] calldata amounts) internal pure {
        if (assets.length != amounts.length) revert InvalidAmounts();
        if (assets.length == 0) revert AmountIsZero();
        if (assets.length > MAX_BATCH_SIZE) revert("Batch too large");
    }

    /// @notice 批量存入单个操作（内部函数，避免重入）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 金额
    /// @param collateralManager 抵押物管理合约地址
    /// @param guaranteeManager 保证金管理合约地址
    /// @param vaultStatistics 统计模块合约地址
    /// @param settlementTokenAddr (deprecated) 保留签名兼容
    function batchDepositSingle(
        address user,
        address asset,
        uint256 amount,
        address collateralManager,
        address guaranteeManager,
        address vaultStatistics,
        address settlementTokenAddr
    ) internal {
        if (amount == 0) revert AmountIsZero();
        if (asset == address(0)) revert ZeroAddress();
        
        // 价格/健康检查下沉到 LE + View 层；业务层批量不再触发
        settlementTokenAddr; // silence unused (签名兼容)
        
        // 转移代币到合约
        IERC20(asset).safeTransferFrom(user, address(this), amount);
        
        // 存入抵押物
        safeDepositCollateral(collateralManager, user, asset, amount);
        
        // 锁定保证金（如果需要）
        safeLockGuarantee(guaranteeManager, user, asset, amount);
        // 同步统计视图的保证金聚合
        safeUpdateGuarantee(vaultStatistics, user, asset, amount, true);
        
        // 更新统计
        safeUpdateStats(vaultStatistics, user, amount, 0, 0, 0);
        
        emit BusinessOperation("deposit", user, asset, amount);
    }

    /// @notice 批量借款单个操作（内部函数，避免重入）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 金额
    /// @param _lendingEngine 借贷引擎合约地址（已废弃，仅保留签名兼容）
    /// @param vaultStatistics 统计模块合约地址
    /// @param _settlementTokenAddr 结算币地址（已废弃，仅保留签名兼容）
    function batchBorrowSingle(
        address user,
        address asset,
        uint256 amount,
        address _lendingEngine,
        address vaultStatistics,
        address _settlementTokenAddr
    ) internal {
        if (amount == 0) revert AmountIsZero();
        if (asset == address(0)) revert ZeroAddress();
        
        // 价格/健康检查下沉到 LE + View 层
        
        // 账本更新由 VaultCore → LE 统一触发；批量业务层不再直连 LE
        _lendingEngine; _settlementTokenAddr; // silence unused (签名兼容)
        
        // 转移代币给用户
        IERC20(asset).safeTransfer(user, amount);
        
        // 更新统计
        safeUpdateStats(vaultStatistics, user, 0, 0, amount, 0);
        
        emit BusinessOperation("borrow", user, asset, amount);
    }

    /// @notice 批量还款单个操作（内部函数，避免重入）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 金额
    /// @param _lendingEngine 借贷引擎合约地址（已废弃，仅保留签名兼容）
    /// @param vaultStatistics 统计模块合约地址
    /// @param _settlementTokenAddr 结算币地址（已废弃，仅保留签名兼容）
    function batchRepaySingle(
        address user,
        address asset,
        uint256 amount,
        address _lendingEngine,
        address vaultStatistics,
        address _settlementTokenAddr
    ) internal {
        if (amount == 0) revert AmountIsZero();
        if (asset == address(0)) revert ZeroAddress();
        
        // 价格/健康检查下沉到 LE + View 层
        
        // 转移代币到合约
        IERC20(asset).safeTransferFrom(user, address(this), amount);
        
        // 账本更新由 VaultCore → LE 统一触发；批量业务层不再直连 LE
        _lendingEngine; _settlementTokenAddr; // silence unused (签名兼容)
        
        // 更新统计
        safeUpdateStats(vaultStatistics, user, 0, 0, 0, amount);
        
        emit BusinessOperation("repay", user, asset, amount);
    }

    /// @notice 批量提取单个操作（内部函数，避免重入）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 金额
    /// @param collateralManager 抵押物管理合约地址
    /// @param guaranteeManager 保证金管理合约地址
    /// @param vaultStatistics 统计模块合约地址
    /// @param _settlementTokenAddr 结算币地址（已废弃，仅保留签名兼容）
    function batchWithdrawSingle(
        address user,
        address asset,
        uint256 amount,
        address collateralManager,
        address guaranteeManager,
        address vaultStatistics,
        address /*rewardManager*/,
        address _settlementTokenAddr
    ) internal {
        if (amount == 0) revert AmountIsZero();
        if (asset == address(0)) revert ZeroAddress();
        
        // 价格/健康检查下沉到 LE + View 层
        
        // 提取抵押物
        _settlementTokenAddr; // silence unused (签名兼容)
        safeWithdrawCollateral(collateralManager, user, asset, amount);
        
        // 释放保证金（如果需要）
        safeReleaseGuarantee(guaranteeManager, user, asset, amount);
        // 同步统计视图的保证金聚合
        safeUpdateGuarantee(vaultStatistics, user, asset, amount, false);
        
        // 转移代币给用户
        IERC20(asset).safeTransfer(user, amount);
        
        // 更新统计
        safeUpdateStats(vaultStatistics, user, 0, amount, 0, 0);
        
        emit BusinessOperation("withdraw", user, asset, amount);
    }

    /* ============ 事件发出函数 ============ */
    
    /// @notice 发出业务操作事件和标准化动作事件
    /// @param operation 操作类型
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 金额
    /// @param actionKey 动作键
    function emitBusinessEvents(
        string memory operation,
        address user,
        address asset,
        uint256 amount,
        bytes32 actionKey
    ) internal {
        emit BusinessOperation(operation, user, asset, amount);
        
        emit VaultTypes.ActionExecuted(
            actionKey,
            ActionKeys.getActionKeyString(actionKey),
            msg.sender,
            block.timestamp
        );
    }

    /* ============ 优雅降级函数 ============ */
    
    /// @notice 优雅降级处理函数
    /// @param asset 资产地址
    /// @param reason 降级原因
    /// @param config 降级配置
    /// @return fallbackValue 降级后的价值
    function _gracefulDegradation(
        address asset,
        string memory reason,
        GracefulDegradation.DegradationConfig memory config
    ) internal returns (uint256 fallbackValue) {
        // 使用GracefulDegradation库的默认策略
        GracefulDegradation.PriceResult memory result =
            GracefulDegradation.getAssetValueWithFallback(asset, asset, 0, config);
        
        if (result.usedFallback) {
            emit VaultBusinessLogicGracefulDegradation(asset, reason, result.value, true);
        }
        
        return result.value;
    }
}
