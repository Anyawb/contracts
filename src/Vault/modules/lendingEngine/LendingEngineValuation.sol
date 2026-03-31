// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {GracefulDegradation} from "../../../libraries/GracefulDegradation.sol";
import {LendingEngineStorage} from "./LendingEngineStorage.sol";

/**
 * @title LendingEngineValuation
 * @notice Provides valuation and graceful-degradation helpers for VaultLendingEngine.
 * @dev Reverts if:
 *      - see individual functions
 *
 * Security:
 * - This library keeps valuation best-effort so oracle issues do not block ledger writes.
 * - GracefulDegradation is the canonical fallback path for asset valuation.
 */
library LendingEngineValuation {
    using LendingEngineStorage for LendingEngineStorage.Layout;

    /*━━━━━━━━━━━━━━━ Custom Errors ━━━━━━━━━━━━━━━*/
    /// @dev Reverts when the price oracle is not configured for a strict valuation path.
    ///      Reserved for strict callers.
    error LendingEngineValuation__PriceOracleNotConfigured();
    /// @dev Reverts when the settlement token is not configured for a strict valuation path.
    ///      Reserved for strict callers.
    error LendingEngineValuation__SettlementTokenNotConfigured();
    /// @dev Reverts when synchronizing user debt value would underflow the system total debt value.
    ///      Used by {updateUserTotalDebtValue}.
    error LendingEngineValuation__TotalDebtValueUnderflow();

    /// @notice Emitted when a user's cached total debt value is updated.
    /// @param user Borrower address.
    /// @param oldValue Previous cached total debt value (valuation-denominated).
    /// @param newValue New cached total debt value (valuation-denominated).
    event UserTotalDebtValueUpdated(
        address indexed user,
        uint256 oldValue,
        uint256 newValue
    );

    /// @notice Emitted when valuation falls back to a degraded pricing path.
    /// @dev `fallbackPrice` is the computed value output from `GracefulDegradation`, where value is derived as:
    ///      `amount * price / 10**oracleDecimals`
    ///      (see `IPriceOracleAdapterRead.getPrice` for `price` and `decimals` semantics).
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

    /// @notice Emitted when a price-oracle health check is performed for an asset.
    /// @param asset Asset being checked.
    /// @param isHealthy True if the oracle path is considered healthy.
    /// @param details Human-readable health-check details.
    event VaultLendingEnginePriceOracleHealthCheck(
        address indexed asset,
        bool isHealthy,
        string details
    );

    /**
     * @notice Updates a user's cached total debt value and synchronizes the system total.
     * @dev Reverts if:
     *      - system total debt value underflows on delta update (LendingEngineValuation__TotalDebtValueUnderflow)
     *
     * Security:
     * - Missing priceOracle or settlementToken configuration must not block ledger writes.
     * - In those cases, the function emits diagnostic events and returns without changing cached values.
     * - Uses GracefulDegradation.getAssetValueWithFallback to avoid reverting on oracle failures.
     *
     * @param s LendingEngine storage layout.
     * @param user Borrower address.
     */
    function updateUserTotalDebtValue(
        LendingEngineStorage.Layout storage s,
        address user
    ) internal {
        // Architecture-Guide: valuation must not block ledger writes.
        // If configuration is missing, keep the previous cached values and emit diagnostic events.
        if (s._priceOracleAddr == address(0)) {
            emit VaultLendingEnginePriceOracleHealthCheck(
                address(0),
                false,
                "priceOracle not configured"
            );
            return;
        }
        if (s._settlementTokenAddr == address(0)) {
            emit VaultLendingEngineGracefulDegradation(
                address(0),
                "settlementToken not configured",
                0,
                true
            );
            return;
        }

        uint256 totalValue = 0;
        uint256 count = s._userDebtAssetCount[user];

        unchecked {
            for (uint256 i = 0; i < count; i++) {
                address asset = s._userDebtAssets[user][i];
                // Best-effort valuation: skip invalid entries instead of blocking the ledger.
                if (asset == address(0)) {
                    emit VaultLendingEngineGracefulDegradation(
                        asset,
                        "asset zero in updateDebtValue",
                        0,
                        true
                    );
                    continue;
                }
                uint256 amount = s._userDebt[user][asset];
                if (amount == 0) continue;

                GracefulDegradation.DegradationConfig
                    memory config = GracefulDegradation.createDefaultConfig(
                        s._settlementTokenAddr
                    );
                GracefulDegradation.PriceResult
                    memory result = GracefulDegradation
                        .getAssetValueWithFallback(
                            s._priceOracleAddr,
                            asset,
                            amount,
                            config
                        );

                // Architecture-Guide: graceful degradation must not block business paths.
                // If the oracle path returns an invalid or zero value, keep valuation best-effort,
                // do not revert, and emit diagnostic events.
                if (!result.isValid) {
                    emit VaultLendingEngineGracefulDegradation(
                        asset,
                        result.reason,
                        result.value,
                        true
                    );
                    continue;
                }

                if (result.usedFallback) {
                    emit VaultLendingEngineGracefulDegradation(
                        asset,
                        result.reason,
                        result.value,
                        true
                    );
                } else {
                    emit VaultLendingEnginePriceOracleHealthCheck(
                        asset,
                        true,
                        "Price calculation successful"
                    );
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
            if (s._totalDebtValue < diff)
                revert LendingEngineValuation__TotalDebtValueUnderflow();
            unchecked {
                s._totalDebtValue -= diff;
            }
        }

        emit UserTotalDebtValueUpdated(user, oldValue, totalValue);
    }

    /**
     * @notice Computes the valuation-denominated debt value for a user's single-asset debt.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only helper.
     * - Uses GracefulDegradation.getAssetValueWithFallback for best-effort pricing.
     *
     * @param s LendingEngine storage layout.
     * @param user Borrower address.
     * @param asset Debt asset address.
     * @return value Current debt value in valuation units.
     */
    function calculateDebtValue(
        LendingEngineStorage.Layout storage s,
        address user,
        address asset
    ) internal view returns (uint256 value) {
        uint256 amount = s._userDebt[user][asset];
        if (amount == 0) return 0;

        GracefulDegradation.DegradationConfig memory cfg = GracefulDegradation
            .createDefaultConfig(s._settlementTokenAddr);
        GracefulDegradation.PriceResult memory pr = GracefulDegradation
            .getAssetValueWithFallback(s._priceOracleAddr, asset, amount, cfg);
        return pr.value;
    }

    /**
     * @notice Checks whether the price-oracle path is healthy for an asset.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only helper used for diagnostics and off-chain monitoring.
     *
     * @param oracle Price oracle adapter address.
     * @param asset Asset address.
     * @return isHealthy True if the oracle path is considered healthy.
     * @return details Human-readable health-check details.
     */
    function checkPriceOracleHealth(
        address oracle,
        address asset
    ) internal view returns (bool isHealthy, string memory details) {
        if (oracle == address(0)) {
            return (false, "No oracle configured");
        }
        return GracefulDegradation.checkPriceOracleHealth(oracle, asset);
    }
}
