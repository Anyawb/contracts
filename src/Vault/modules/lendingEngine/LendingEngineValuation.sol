// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {GracefulDegradation} from "../../../libraries/GracefulDegradation.sol";
import {LendingEngineStorage} from "./LendingEngineStorage.sol";
import {AssetDecimalMath} from "../../../libraries/AssetDecimalMath.sol";
import {IPriceOracleRead} from "../../../interfaces/IPriceOracleRead.sol";

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

    uint8 internal constant SYSTEM_VALUATION_DECIMALS = 18;
    uint8 internal constant MAX_ASSET_DECIMALS = 77;

    /*━━━━━━━━━━━━━━━ Custom Errors ━━━━━━━━━━━━━━━*/
    /// @dev Reverts when the price oracle is not configured for a strict valuation path.
    ///      Reserved for strict callers.
    error LendingEngineValuation__PriceOracleNotConfigured();
    /// @dev Reverts when synchronizing user debt value would underflow the system total debt value.
    ///      Used by {updateUserTotalDebtValue}.
    error LendingEngineValuation__TotalDebtValueUnderflow();
    /// @dev Reverts when the authoritative oracle returns an invalid zero price for strict valuation.
    error LendingEngineValuation__InvalidOraclePrice(address asset);
    /// @dev Reverts when the authoritative oracle returns unsupported decimals for strict valuation.
    error LendingEngineValuation__InvalidOracleDecimals(address asset, uint256 decimals);

    /// @notice Emitted when a user's cached total debt value is updated.
    /// @param user Borrower address.
    /// @param oldValue Previous cached total debt value normalized to 18 decimals.
    /// @param newValue New cached total debt value normalized to 18 decimals.
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
    /// @param fallbackPrice Fallback value produced by the degradation strategy normalized to 18 decimals.
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

                totalValue += _normalizeDebtValue(
                    result.value,
                    _resultAssetDecimals(s._priceOracleAddr, asset)
                );
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
    * @notice Computes the debt value for a user's single-asset debt in the normalized system valuation unit.
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
    * @return value Current debt value normalized to 18 decimals.
     */
    function calculateDebtValue(
        LendingEngineStorage.Layout storage s,
        address user,
        address asset
    ) internal view returns (uint256 value) {
        return calculateDebtValueBestEffort(s, user, asset);
    }

    function calculateUserTotalDebtValueBestEffort(
        LendingEngineStorage.Layout storage s,
        address user
    ) internal view returns (uint256 totalValue) {
        uint256 count = s._userDebtAssetCount[user];
        for (uint256 i; i < count; ++i) {
            address asset = s._userDebtAssets[user][i];
            if (asset == address(0)) continue;
            totalValue += calculateDebtValueBestEffort(s, user, asset);
        }
    }

    function calculateUserTotalDebtValueStrict(
        LendingEngineStorage.Layout storage s,
        address user
    ) internal view returns (uint256 totalValue) {
        uint256 count = s._userDebtAssetCount[user];
        for (uint256 i; i < count; ++i) {
            address asset = s._userDebtAssets[user][i];
            if (asset == address(0)) continue;
            totalValue += calculateDebtValueStrict(s, user, asset);
        }
    }

    function calculateDebtValueBestEffort(
        LendingEngineStorage.Layout storage s,
        address user,
        address asset
    ) internal view returns (uint256 value) {
        uint256 amount = s._userDebt[user][asset];
        if (amount == 0) return 0;
        if (s._priceOracleAddr == address(0) || s._settlementTokenAddr == address(0)) {
            return 0;
        }

        GracefulDegradation.DegradationConfig memory cfg = GracefulDegradation
            .createDefaultConfig(s._settlementTokenAddr);
        GracefulDegradation.PriceResult memory pr = GracefulDegradation
            .getAssetValueWithFallback(s._priceOracleAddr, asset, amount, cfg);
        return _normalizeDebtValue(pr.value, _resultAssetDecimals(s._priceOracleAddr, asset));
    }

    function calculateDebtValueStrict(
        LendingEngineStorage.Layout storage s,
        address user,
        address asset
    ) internal view returns (uint256 value) {
        uint256 amount = s._userDebt[user][asset];
        if (amount == 0) return 0;
        if (s._priceOracleAddr == address(0)) {
            revert LendingEngineValuation__PriceOracleNotConfigured();
        }

        (uint256 price, , uint256 assetDecimalsRaw) = IPriceOracleRead(s._priceOracleAddr).getPrice(asset);
        if (price == 0) {
            revert LendingEngineValuation__InvalidOraclePrice(asset);
        }
        if (assetDecimalsRaw > MAX_ASSET_DECIMALS) {
            revert LendingEngineValuation__InvalidOracleDecimals(asset, assetDecimalsRaw);
        }

        uint8 assetDecimals = uint8(assetDecimalsRaw);
        uint256 rawValue = AssetDecimalMath.calcValue(amount, price, assetDecimals);
        return _normalizeDebtValue(rawValue, assetDecimals);
    }

    function _normalizeDebtValue(
        uint256 rawValue,
        uint8 assetDecimals
    ) private pure returns (uint256 normalizedValue) {
        if (rawValue == 0) return 0;
        return
            AssetDecimalMath.normalizeValueUp(
                rawValue,
                assetDecimals,
                SYSTEM_VALUATION_DECIMALS
            );
    }

    function _resultAssetDecimals(
        address oracle,
        address asset
    ) private view returns (uint8 decimals) {
        try IPriceOracleRead(oracle).getPrice(asset) returns (
            uint256,
            uint256,
            uint256 d
        ) {
            if (d > 77) return SYSTEM_VALUATION_DECIMALS;
            return uint8(d);
        } catch {
            return SYSTEM_VALUATION_DECIMALS;
        }
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
