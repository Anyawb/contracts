// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { IRegistry } from "../interfaces/IRegistry.sol";
import { SystemEvents } from "./SystemEvents.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { InvalidHealthFactor, ZeroAddress } from "../errors/StandardErrors.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";

/* -------------------------------------------------------------------------- */
/*                                Interfaces                                 */
/* -------------------------------------------------------------------------- */
/// @dev Minimal governance interface; keeps this file decoupled from full implementations.
import { ILiquidationConfigManager } from "../interfaces/ILiquidationConfigManager.sol";

/**
 * @title VaultAdmin
 * @notice Minimal governance entrypoint for Vault-level parameter dispatch.
 * @dev Architecture SSOT:
 * - Parameter SSOT is owned by dedicated modules (e.g., LiquidationConfigManager).
 * - VaultAdmin exists to provide a stable, governance-gated dispatch surface.
 *
 * Security:
 * - UUPS upgradeable (implementation disables initializers).
 * - All governance methods are role-gated via ACM (ActionKeys).
 */
contract VaultAdmin is 
    Initializable,
    UUPSUpgradeable
{
    /* ============ Errors ============ */
    
    error VaultAdmin__InvalidImplementation();
    /* ============ Constructor ============ */
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /* ============ Storage ============ */
    /// @dev Registry address (authoritative module registry).
    address private _adminRegistryAddr;

    /* ============ Modifiers ============ */
    
    /// @notice Ensure Registry is configured.
    modifier onlyValidRegistry() {
        if (_adminRegistryAddr == address(0)) revert ZeroAddress();
        _;
    }

    /// @notice Enforce that caller has a required role in ACM.
    modifier onlyRole(bytes32 actionKey) {
        _requireRole(actionKey, msg.sender);
        _;
    }

    /* ============ Events ============ */
    

    /* ============ Initializer ============ */
    /**
     * @notice Initialize VaultAdmin.
     * @dev Reverts if:
     *      - initialRegistryAddr == address(0)
     *
     * Security:
     * - initializer (callable once)
     *
     * @param initialRegistryAddr Registry contract address
     */
    function initialize(
        address initialRegistryAddr
    ) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        
        __UUPSUpgradeable_init();
        
        _adminRegistryAddr = initialRegistryAddr;
    }

    /* ============ Registry resolution helpers ============ */
    /// @dev Resolve a module address via Registry (reverts if not registered).
    function _getModule(bytes32 moduleKey) internal view returns (address) {
        return IRegistry(_adminRegistryAddr).getModuleOrRevert(moduleKey);
    }

    /// @dev Require that `user` has `actionKey` role in ACM.
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = _getModule(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /// @dev Emit a standardized ActionExecuted event (audit trail).
    function _emitActionExecuted(bytes32 actionKey) internal {
        emit SystemEvents.ActionExecuted(
            actionKey,
            "",
            msg.sender,
            // solhint-disable-next-line not-rely-on-time
            block.timestamp
        );
    }

    /* ============ 只读 Getter 函数 ============ */
    /**
     * @notice Get Registry address.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only function.
     *
     * @return registryAddr Registry contract address
     */
    function getRegistryAddr() external view returns (address) {
        return _adminRegistryAddr;
    }

    /* ============ 核心业务函数 ============ */
    /**
     * @notice Set the minimum health factor (bps).
     * @dev Reverts if:
     *      - Registry is not configured
     *      - caller does not have ACTION_SET_PARAMETER role
     *      - hf is zero or out of allowed range
     *      - LiquidationConfigManager is not registered
     *      - LiquidationConfigManager.updateMinHealthFactor reverts
     *
     * Security:
     * - Role-gated via ACM (ActionKeys.ACTION_SET_PARAMETER)
     *
     * @param hf New minimum health factor in basis points (bps, 10000 = 100%)
     */
    function setMinHealthFactor(uint256 hf) external onlyValidRegistry onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (!(hf > 0 && hf <= 20_000)) revert InvalidHealthFactor();

        // 1) SSOT: parameter lives in LiquidationConfigManager
        address cfg = _getModule(ModuleKeys.KEY_LIQUIDATION_CONFIG_MANAGER);
        if (cfg == address(0)) revert ZeroAddress();
        ILiquidationConfigManager(cfg).updateMinHealthFactor(hf);

        // 2) Audit trail: standardized action event
        _emitActionExecuted(ActionKeys.ACTION_SET_PARAMETER);
    }

    // Intentionally minimal: other parameters should be managed by their SSOT modules.

    /* ============ Upgrade Auth ============ */
    /**
     * @notice UUPS upgrade authorization hook.
     * @dev Reverts if:
     *      - caller does not have ACTION_UPGRADE_MODULE role
     *      - newImplementation == address(0)
     *      - newImplementation has no code
     *
     * Security:
     * - Role-gated via ACM (ActionKeys.ACTION_UPGRADE_MODULE)
     *
     * @param newImplementation New implementation address
     */
    function _authorizeUpgrade(address newImplementation) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        
        if (newImplementation.code.length == 0) revert VaultAdmin__InvalidImplementation();
        
        _emitActionExecuted(ActionKeys.ACTION_UPGRADE_MODULE);
    }

    /* ============ Storage Gap ============ */
    uint256[50] private __gap;
} 