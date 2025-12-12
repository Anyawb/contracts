// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { VaultTypes } from "../Vault/VaultTypes.sol";

/// @title HealthFactorLib
/// @notice 健康因子与相关判定的纯函数库（无状态、可内联）
/// @dev 仅提供最小必要API，供业务/清算模块高频直调（节省外部调用gas）
///      约定：健康因子以基点（bps, 10000）表示
library HealthFactorLib {
    /// @notice 触发清算判定（推荐主路径使用：避免除法）
    /// @param totalCollateral 抵押物总价值
    /// @param totalDebt 债务总价值
    /// @param minHealthFactor 最小健康因子阈值（bps）
    /// @return undercollateralized 是否低于阈值（应触发清算）
    function isUnderCollateralized(
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 minHealthFactor
    ) internal pure returns (bool undercollateralized) {
        if (totalDebt == 0) return false;
        unchecked {
            // collateral * 1e4 < debt * minHF 视为不健康
            return totalCollateral * VaultTypes.HUNDRED_PERCENT < totalDebt * minHealthFactor;
        }
    }

    /// @notice 计算健康因子（仅在需要展示/缓存具体数值时调用）
    function calcHealthFactor(uint256 totalCollateral, uint256 totalDebt) internal pure returns (uint256) {
        if (totalDebt == 0) return type(uint256).max;
        return (totalCollateral * VaultTypes.HUNDRED_PERCENT) / totalDebt;
    }

    /// @notice 计算贷款价值比（LTV）
    function calcLtv(uint256 debt, uint256 collateral) internal pure returns (uint256) {
        if (collateral == 0) return 0;
        return (debt * VaultTypes.HUNDRED_PERCENT) / collateral;
    }

    /// @notice 计算排除保证金后的有效抵押
    function effectiveCollateral(uint256 totalCollateral, uint256 guaranteeAmount) internal pure returns (uint256) {
        return totalCollateral > guaranteeAmount ? totalCollateral - guaranteeAmount : 0;
    }
}


