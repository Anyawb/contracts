// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {LiquidationConfigManager} from "./LiquidationConfigManager.sol";

import {LiquidationTypes} from "../types/LiquidationTypes.sol";
import {ActionKeys} from "../../../constants/ActionKeys.sol";
import {ModuleKeys} from "../../../constants/ModuleKeys.sol";
import {Registry} from "../../../registry/Registry.sol";
import {IAccessControlManager} from "../../../interfaces/IAccessControlManager.sol";

/// @title LiquidationConfigModule
/// @notice Concrete config module for liquidation parameters (SSOT for thresholds)
/// @dev Exists to make LiquidationConfigManager deployable and to provide a safe proxy-update path
///      from LiquidationRiskManager while preserving original caller role checks.
contract LiquidationConfigModule is LiquidationConfigManager {
    /**
     * @notice Initialize the liquidation config module (SSOT for thresholds).
     * @dev Reverts if:
     *      - initialRegistryAddr is zero address
     *      - initialAccessControl is zero address
     *
     * Security:
     * - Initializer pattern (only callable once)
     *
     * @param initialRegistryAddr Registry address
     * @param initialAccessControl AccessControlManager address
     */
    function initialize(address initialRegistryAddr, address initialAccessControl) public override initializer {
        _initializeLiquidationConfigManager(initialRegistryAddr, initialAccessControl);
    }

    /// @notice Unauthorized caller for proxied updates
    error LiquidationConfigModule__UnauthorizedCaller();

    /// @notice Invalid liquidation threshold
    error LiquidationConfigModule__InvalidLiquidationThreshold();

    /**
     * @notice Liquidation threshold updated.
     * @param oldThreshold Old liquidation threshold (bps=1e4)
     * @param newThreshold New liquidation threshold (bps=1e4)
     * @param timestamp Update timestamp (in seconds)
     */
    event LiquidationThresholdUpdated(uint256 oldThreshold, uint256 newThreshold, uint256 timestamp);

    /**
     * @notice Update liquidation threshold via LiquidationRiskManager (compatibility path).
     * @dev Reverts if:
     *      - msg.sender is not the Registry-registered LiquidationRiskManager
     *      - caller does not have ACTION_SET_PARAMETER role in ACM
     *      - newThreshold is outside [MIN_LIQUIDATION_THRESHOLD, MAX_LIQUIDATION_THRESHOLD]
     *
     * Security:
     * - Proxied caller semantics preserved: `caller` is role-checked, not msg.sender
     * - Only callable by RiskManager module (Registry.KEY_LIQUIDATION_RISK_MANAGER)
     *
     * @param newThreshold New liquidation threshold (bps=1e4)
     * @param caller Original caller (EOA/governance) that initiated the update
     */
    function updateLiquidationThresholdFromRiskManager(uint256 newThreshold, address caller) external {
        address rm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        if (msg.sender != rm) revert LiquidationConfigModule__UnauthorizedCaller();

        // Preserve original caller semantics: validate the EOA/governance caller via global ACM.
        address acm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acm).requireRole(ActionKeys.ACTION_SET_PARAMETER, caller);
        if (!LiquidationTypes.isValidLiquidationThreshold(newThreshold)) {
            revert LiquidationConfigModule__InvalidLiquidationThreshold();
        }

        uint256 old = liquidationThresholdVar;
        liquidationThresholdVar = newThreshold;
        // solhint-disable-next-line not-rely-on-time
        emit LiquidationThresholdUpdated(old, newThreshold, block.timestamp);
    }

    /**
     * @notice Update minimum health factor via LiquidationRiskManager (compatibility path).
     * @dev Reverts if:
     *      - msg.sender is not the Registry-registered LiquidationRiskManager
     *      - caller does not have ACTION_SET_PARAMETER role in ACM
     *      - newMinHealthFactor is zero
     *      - newMinHealthFactor < liquidationThresholdVar
     *
     * Security:
     * - Proxied caller semantics preserved: `caller` is role-checked, not msg.sender
     * - Only callable by RiskManager module (Registry.KEY_LIQUIDATION_RISK_MANAGER)
     *
     * @param newMinHealthFactor New minimum health factor (bps=1e4)
     * @param caller Original caller (EOA/governance) that initiated the update
     */
    function updateMinHealthFactorFromRiskManager(uint256 newMinHealthFactor, address caller) external {
        address rm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        if (msg.sender != rm) revert LiquidationConfigModule__UnauthorizedCaller();

        // Preserve original caller semantics: validate the EOA/governance caller via global ACM.
        address acm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acm).requireRole(ActionKeys.ACTION_SET_PARAMETER, caller);
        if (newMinHealthFactor == 0 || newMinHealthFactor < liquidationThresholdVar) {
            revert LiquidationConfigManager__InvalidMinHealthFactor();
        }

        uint256 old = minHealthFactorVar;
        minHealthFactorVar = newMinHealthFactor;
        // solhint-disable-next-line not-rely-on-time
        emit MinHealthFactorUpdated(old, newMinHealthFactor, block.timestamp);
    }
}

