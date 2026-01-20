// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { GracefulDegradation } from "../../../libraries/GracefulDegradation.sol";
import { LendingEngineStorage } from "./LendingEngineStorage.sol";

/// @notice Valuation and graceful degradation helpers for VaultLendingEngine.
library LendingEngineValuation {
    using LendingEngineStorage for LendingEngineStorage.Layout;

    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/
    /// @notice Price oracle is not configured.
    error LendingEngineValuation__PriceOracleNotConfigured();
    /// @notice Settlement token is not configured.
    error LendingEngineValuation__SettlementTokenNotConfigured();
    /// @notice User total debt value invariant violated (system total underflow).
    error LendingEngineValuation__TotalDebtValueUnderflow();

    /// @notice Emitted when a user's cached total debt value is updated.
    /// @param user Borrower address.
    /// @param oldValue Previous cached total debt value (valuation-denominated).
    /// @param newValue New cached total debt value (valuation-denominated).
    event UserTotalDebtValueUpdated(address indexed user, uint256 oldValue, uint256 newValue);

    /// @notice Emitted when valuation falls back to a degraded pricing path (observability).
    /// @dev `fallbackPrice` is the computed value output from `GracefulDegradation`, where value is derived as:
    ///      `amount * price / 10**oracleDecimals`
    ///      (see `IPriceOracleAdapter.getPrice` for `price` and `decimals` semantics).
    /// @param asset Asset being valued.
    /// @param reason Human-readable reason for degradation.
    /// @param fallbackPrice Fallback value produced by the degradation strategy (valuation-denominated).
    /// @param usedFallback True if a fallback strategy was used; false if the primary path was healthy.
    event VaultLendingEngineGracefulDegradation(
        address indexed asset,
        string reason,
        uint256 fallbackPrice,
        bool usedFallback
    );

    /// @notice Emitted when a price oracle health check is performed for an asset (observability).
    /// @param asset Asset being checked.
    /// @param isHealthy True if the oracle path is considered healthy.
    /// @param details Human-readable details for observability.
    event VaultLendingEnginePriceOracleHealthCheck(address indexed asset, bool isHealthy, string details);

    /**
     * @notice Update a user's cached total debt value and synchronize the system total (best-effort).
     * @dev Reverts if:
     *      - system total debt value underflows on delta update (LendingEngineValuation__TotalDebtValueUnderflow)
     *
     * Security:
     * - Best-effort valuation: missing priceOracle / settlementToken configuration MUST NOT block ledger writes.
     *   In such cases, this function emits observability events and returns without changing cached values.
     * - Uses `GracefulDegradation.getAssetValueWithFallback` to avoid reverting on oracle failures.
     *
     * @param s LendingEngine storage layout.
     * @param user Borrower address.
     */
    function updateUserTotalDebtValue(LendingEngineStorage.Layout storage s, address user) internal {
        // Architecture-Guide: valuation must not block ledger writes.
        // If configuration is missing, keep the previous cached values (best-effort) and emit observability events.
        if (s._priceOracleAddr == address(0)) {
            emit VaultLendingEnginePriceOracleHealthCheck(address(0), false, "priceOracle not configured");
            return;
        }
        if (s._settlementTokenAddr == address(0)) {
            emit VaultLendingEngineGracefulDegradation(address(0), "settlementToken not configured", 0, true);
            return;
        }
        
        uint256 totalValue = 0;
        uint256 count = s._userDebtAssetCount[user];

        unchecked {
            for (uint256 i = 0; i < count; i++) {
                address asset = s._userDebtAssets[user][i];
                // Best-effort valuation: skip invalid entries instead of blocking the ledger.
                if (asset == address(0)) {
                    emit VaultLendingEngineGracefulDegradation(asset, "asset zero in updateDebtValue", 0, true);
                    continue;
                }
                uint256 amount = s._userDebt[user][asset];
                if (amount == 0) continue;

                GracefulDegradation.DegradationConfig memory config =
                    GracefulDegradation.createDefaultConfig(s._settlementTokenAddr);
                GracefulDegradation.PriceResult memory result =
                    GracefulDegradation.getAssetValueWithFallback(s._priceOracleAddr, asset, amount, config);

                // Architecture-Guide: graceful degradation must not block business paths.
                // If the oracle path returns an invalid/zero value, we keep valuation best-effort
                // and do not revert; we record observability via events.
                if (!result.isValid) {
                    emit VaultLendingEngineGracefulDegradation(asset, result.reason, result.value, true);
                    continue;
                }

                if (result.usedFallback) {
                    emit VaultLendingEngineGracefulDegradation(asset, result.reason, result.value, true);
                } else {
                    emit VaultLendingEnginePriceOracleHealthCheck(asset, true, "Price calculation successful");
                }

                totalValue += result.value;
            }
        }

        uint256 oldValue = s._userTotalDebtValue[user];
        s._userTotalDebtValue[user] = totalValue;
        // Update system total debt value by delta; underflow must not happen.
        if (totalValue >= oldValue) {
            s._totalDebtValue += (totalValue - oldValue);
        } else {
            uint256 diff = oldValue - totalValue;
            if (s._totalDebtValue < diff) revert LendingEngineValuation__TotalDebtValueUnderflow();
            unchecked {
                s._totalDebtValue -= diff;
            }
        }

        emit UserTotalDebtValueUpdated(user, oldValue, totalValue);
    }

    /**
     * @notice Compute valuation-denominated debt value for a user's single asset debt.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only; calls `GracefulDegradation.getAssetValueWithFallback` which is designed to be best-effort.
     *
     * @param s LendingEngine storage layout.
     * @param user Borrower address.
     * @param asset Debt asset address.
     * @return value Valuation-denominated debt value (see `VaultLendingEngineGracefulDegradation` @dev for formula).
     */
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

    /**
     * @notice Check whether the price oracle path is healthy for an asset (best-effort helper).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only; used for observability and diagnostics.
     *
     * @param oracle Price oracle adapter address.
     * @param asset Asset address.
     * @return isHealthy True if considered healthy.
     * @return details Human-readable details.
     */
    function checkPriceOracleHealth(address oracle, address asset)
        internal
        view
        returns (bool isHealthy, string memory details)
    {
        if (oracle == address(0)) {
            return (false, "No oracle configured");
        }
        return GracefulDegradation.checkPriceOracleHealth(oracle, asset);
    }
}

