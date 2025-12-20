// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { GracefulDegradation } from "../../../libraries/GracefulDegradation.sol";
import { LendingEngineStorage } from "./LendingEngineStorage.sol";

/// @notice Valuation and graceful degradation helpers for VaultLendingEngine
library LendingEngineValuation {
    using LendingEngineStorage for LendingEngineStorage.Layout;

    /// @notice 用户总债务价值更新事件
    event UserTotalDebtValueUpdated(address indexed user, uint256 oldValue, uint256 newValue);
    /// @notice 优雅降级事件 - 价格获取失败时使用备用策略
    event VaultLendingEngineGracefulDegradation(address indexed asset, string reason, uint256 fallbackPrice, bool usedFallback);
    /// @notice 价格预言机健康状态事件
    event VaultLendingEnginePriceOracleHealthCheck(address indexed asset, bool isHealthy, string details);

    /// @notice 更新用户总债务价值并同步系统总债务值
    function updateUserTotalDebtValue(LendingEngineStorage.Layout storage s, address user) internal {
        require(s._priceOracleAddr != address(0), "priceOracle zero in updateDebtValue");
        require(s._settlementTokenAddr != address(0), "settlementToken zero in updateDebtValue");
        
        uint256 totalValue = 0;
        uint256 count = s._userDebtAssetCount[user];

        unchecked {
            for (uint256 i = 0; i < count; i++) {
                address asset = s._userDebtAssets[user][i];
                require(asset != address(0), "asset zero in updateDebtValue");
                uint256 amount = s._userDebt[user][asset];
                if (amount == 0) continue;

                GracefulDegradation.DegradationConfig memory config =
                    GracefulDegradation.createDefaultConfig(s._settlementTokenAddr);
                GracefulDegradation.PriceResult memory result =
                    GracefulDegradation.getAssetValueWithFallback(s._priceOracleAddr, asset, amount, config);

                require(result.value > 0, "price result value is zero");

                if (result.usedFallback) {
                    emit VaultLendingEngineGracefulDegradation(asset, result.reason, result.value, true);
                } else {
                    emit VaultLendingEnginePriceOracleHealthCheck(asset, true, "Price calculation successful");
                }

                totalValue += result.value;
            }
        }

        uint256 oldValue = s._userTotalDebtValue[user];
        // 防止系统总债务在减少路径下出现下溢
        require(oldValue <= s._totalDebtValue, "totalDebtValue underflow");
        s._userTotalDebtValue[user] = totalValue;
        // 防止溢出和下溢：使用 unchecked 块进行安全的算术运算
        unchecked {
            if (totalValue > oldValue) {
                uint256 diff = totalValue - oldValue;
                require(s._totalDebtValue + diff >= s._totalDebtValue, "totalDebtValue overflow");
                s._totalDebtValue = s._totalDebtValue + diff;
            } else {
                uint256 diff = oldValue - totalValue;
                require(s._totalDebtValue >= diff, "totalDebtValue underflow");
                s._totalDebtValue = s._totalDebtValue - diff;
            }
        }

        emit UserTotalDebtValueUpdated(user, oldValue, totalValue);
    }

    /// @notice 计算单资产债务价值（以结算币计价）
    function calculateDebtValue(LendingEngineStorage.Layout storage s, address user, address asset)
        internal
        view
        returns (uint256 value)
    {
        uint256 amount = s._userDebt[user][asset];
        if (amount == 0) return 0;

        GracefulDegradation.DegradationConfig memory cfg =
            GracefulDegradation.createDefaultConfig(s._settlementTokenAddr);
        GracefulDegradation.PriceResult memory pr =
            GracefulDegradation.getAssetValueWithFallback(s._priceOracleAddr, asset, amount, cfg);
        return pr.value;
    }

    /// @notice 检查价格预言机健康状态
    function checkPriceOracleHealth(address oracle, address asset) internal view returns (bool isHealthy, string memory details) {
        if (oracle == address(0)) {
            return (false, "No oracle configured");
        }
        return GracefulDegradation.checkPriceOracleHealth(oracle, asset);
    }
}

