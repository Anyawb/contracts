// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ILiquidationRiskRead } from "../../../interfaces/ILiquidationRiskRead.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { MissingRole, NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/**
 * @title SystemRiskView
 * @notice System-only risk view for global thresholds and parameters.
 * @dev Reverts if:
 *      - registry is not configured or not a contract (ZeroAddress, NotAContract)
 *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
 *
 * Security:
 * - Role-gated reads (`ACTION_VIEW_RISK_DATA`) to control access to system-scoped risk parameters
 * - Admin bypass is allowed via `ACTION_ADMIN`
 * - Upgrade authorization is role-gated (ACTION_ADMIN)
 */
contract SystemRiskView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/
    address private _registryAddr;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    modifier onlyRiskViewerOrAdmin() {
        if (
            !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)
                && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_RISK_DATA, msg.sender)
        ) {
            revert MissingRole();
        }
        _;
    }

    /*━━━━━━━━━━━━━━━ Constructor / Initializer ━━━━━━━━━━━━━━━*/
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the SystemRiskView module with a Registry address.
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (ZeroAddress)
     *      - initialRegistryAddr is not a contract (NotAContract)
     *
     * Security:
     * - Callable once via proxy initializer
     *
    * @param initialRegistryAddr Registry address used for module resolution.
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Read APIs ━━━━━━━━━━━━━━━*/
    /**
     * @notice Returns the liquidation threshold as defined by the RiskManager.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (ZeroAddress, NotAContract)
     *      - caller lacks `ACTION_VIEW_RISK_DATA` and is not an admin (MissingRole)
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated read: `ACTION_VIEW_RISK_DATA` or `ACTION_ADMIN`
     *
    * @return threshold Liquidation threshold in implementation-defined scale.
     */
    function getLiquidationThreshold() external view onlyValidRegistry onlyRiskViewerOrAdmin returns (uint256 threshold) {
        return _rm().getLiquidationThreshold();
    }

    /**
     * @notice Returns the minimum health factor as defined by the RiskManager.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (ZeroAddress, NotAContract)
     *      - caller lacks `ACTION_VIEW_RISK_DATA` and is not an admin (MissingRole)
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated read: `ACTION_VIEW_RISK_DATA` or `ACTION_ADMIN`
     *
    * @return minHealthFactor Minimum health factor in implementation-defined scale.
     */
    function getMinHealthFactor() external view onlyValidRegistry onlyRiskViewerOrAdmin returns (uint256 minHealthFactor) {
        return _rm().getMinHealthFactor();
    }

    /**
     * @notice Returns the maximum LTV as defined by the RiskManager (system-scoped SSOT).
     * @dev Reverts if:
     *      - registry is not configured or not a contract (ZeroAddress, NotAContract)
     *      - caller lacks `ACTION_VIEW_RISK_DATA` and is not an admin (MissingRole)
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated read: `ACTION_VIEW_RISK_DATA` or `ACTION_ADMIN`
     *
    * @return maxLtvBps Maximum LTV in basis points.
     */
    function getMaxLtvBps() external view onlyValidRegistry onlyRiskViewerOrAdmin returns (uint256 maxLtvBps) {
        return _rm().getMaxLtvBps();
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/
    function _rm() internal view returns (ILiquidationRiskRead) {
        address rm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        return ILiquidationRiskRead(rm);
    }

    /*━━━━━━━━━━━━━━━ UUPS ━━━━━━━━━━━━━━━*/
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            revert MissingRole();
        }
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ Versioning (C+B baseline) ━━━━━━━━━━━━━━━*/
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/
    uint256[50] private __gap;
}
