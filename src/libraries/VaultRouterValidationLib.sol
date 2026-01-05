// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IAssetWhitelist } from "../interfaces/IAssetWhitelist.sol";
import { 
    ZeroAddress, 
    AmountIsZero,
    AssetNotAllowed
} from "../errors/StandardErrors.sol";

/// @title VaultRouterValidationLib
/// @notice VaultRouter 验证函数库，提取纯验证逻辑以减小合约大小
/// @dev 所有验证函数都是 pure 或 view，不修改状态
library VaultRouterValidationLib {
    /// @notice 校验资产是否在白名单中
    /// @param asset 资产地址
    /// @param assetWhitelistAddr 资产白名单合约地址
    /// @dev 如果资产地址为零或不在白名单中，会revert
    function validateAsset(address asset, address assetWhitelistAddr) internal view {
        if (asset == address(0)) revert ZeroAddress();
        if (!IAssetWhitelist(assetWhitelistAddr).isAssetAllowed(asset)) {
            revert AssetNotAllowed();
        }
    }

    /// @notice 校验金额是否大于0
    /// @param amount 金额
    /// @dev 如果金额为0，会revert AmountIsZero
    function validateAmount(uint256 amount) internal pure {
        if (amount == 0) revert AmountIsZero();
    }

    /// @notice 校验借款期限
    /// @param termDays 借款期限（天）
    /// @param minTermDays 最小期限（天）
    /// @param maxTermDays 最大期限（天）
    /// @dev 借款期限必须在minTermDays和maxTermDays之间
    function validateTermDays(uint16 termDays, uint16 minTermDays, uint16 maxTermDays) internal pure {
        if (termDays < minTermDays || termDays > maxTermDays) {
            revert VaultRouterValidationLib__InvalidTermDays();
        }
    }

    /// @notice 校验订单ID
    /// @param orderId 订单ID
    /// @dev 订单ID不能为0
    function validateOrderId(uint256 orderId) internal pure {
        if (orderId == 0) {
            revert VaultRouterValidationLib__InvalidOrderId();
        }
    }

    /// @notice 校验用户余额（基础验证）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 所需金额
    /// @dev 简化实现，仅做基础验证（地址非零、金额非零）
    /// @dev 实际余额检查应在调用方通过 ERC20.balanceOf 完成
    function validateUserBalance(address user, address asset, uint256 amount) internal pure {
        if (amount == 0) revert AmountIsZero();
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
    }

    /// @notice 校验借款限额（基础验证）
    /// @param user 用户地址
    /// @param amount 借款金额
    /// @dev 简化实现，仅做基础验证（地址非零、金额非零）
    /// @dev 实际限额检查应在调用方通过 LendingEngine 完成
    function validateBorrowLimit(address user, uint256 amount) internal pure {
        if (amount == 0) revert AmountIsZero();
        if (user == address(0)) revert ZeroAddress();
    }

    /// @notice 校验订单归属权（基础验证）
    /// @param orderId 订单ID
    /// @param user 用户地址
    /// @dev 简化实现，仅做基础验证（订单ID非零、用户地址非零）
    /// @dev 实际归属权检查应在调用方通过 LendingEngine.getLoanOrder 完成
    function validateOrderOwnership(uint256 orderId, address user) internal pure {
        if (orderId == 0) {
            revert VaultRouterValidationLib__InvalidOrderId();
        }
        if (user == address(0)) revert ZeroAddress();
    }

    // ----------------- 自定义错误 -----------------
    error VaultRouterValidationLib__InvalidTermDays();
    error VaultRouterValidationLib__InvalidOrderId();
}

