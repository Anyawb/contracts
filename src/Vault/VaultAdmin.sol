// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IRegistry} from "../interfaces/IRegistry.sol";
import {SystemEvents} from "./SystemEvents.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {ActionKeys} from "../constants/ActionKeys.sol";
import {
    InvalidHealthFactor,
    NotAContract,
    ZeroAddress
} from "../errors/StandardErrors.sol";
import {IAccessControlManager} from "../interfaces/IAccessControlManager.sol";

/*━━━━━━━━━━━━━━━ Interfaces ━━━━━━━━━━━━━━━*/
/// @dev Minimal governance interface; keeps this file decoupled from full implementations.
import {ILiquidationConfigManager} from "../interfaces/ILiquidationConfigManager.sol";

/**
 * @title VaultAdmin
 * @notice Governance-gated dispatch surface for Vault-level parameter updates.
 * @dev Reverts if:
 *      - Registry is unset or invalid when a Registry-dependent path is invoked (ZeroAddress / NotAContract)
 *      - caller lacks the required governance role for the invoked action (via ACM)
 *      - downstream SSOT module resolution or parameter update calls revert
 *
 * Security:
 * - UUPS upgradeable (implementation disables initializers).
 * - Governance methods are role-gated via ACM `ActionKeys` (resolved through `Registry`).
 * - Parameter SSOT remains in dedicated modules such as LiquidationConfigManager; this contract only forwards.
 */
contract VaultAdmin is Initializable, UUPSUpgradeable {
    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/

    /// @dev Reverts when `newImplementation` is not a deployed contract (code length is zero).
    ///      Used by {_authorizeUpgrade}.
    error VaultAdmin__InvalidImplementation();

    /*━━━━━━━━━━━━━━━ Constructor ━━━━━━━━━━━━━━━*/
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/
    /// @dev Registry address (authoritative module registry). Set once in {initialize}.
    address private _adminRegistryAddr;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    /// @notice Ensures the Registry is configured and is a contract.
    /// @dev Reverts if:
    ///      - Registry is unset (see {ZeroAddress})
    ///      - Registry has no code (see {NotAContract})
    modifier onlyValidRegistry() {
        if (_adminRegistryAddr == address(0)) revert ZeroAddress();
        if (_adminRegistryAddr.code.length == 0)
            revert NotAContract(_adminRegistryAddr);
        _;
    }

    /// @notice Ensures the caller has `actionKey` in the ACM.
    /// @dev Reverts if:
    ///      - Registry is unset or invalid (see notes in {onlyValidRegistry})
    ///      - Registry missing `ModuleKeys.KEY_ACCESS_CONTROL` (reverts in {IRegistry.getModuleOrRevert})
    ///      - caller lacks `actionKey` (reverts in {IAccessControlManager.requireRole})
    modifier onlyRole(bytes32 actionKey) {
        _requireRole(actionKey, msg.sender);
        _;
    }

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/
    // NOTE: This contract emits {SystemEvents.ActionExecuted} for auditability.

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/
    /**
     * @notice Initializes the VaultAdmin with an authoritative Registry address.
     * @dev Reverts if:
     *      - called more than once (initializer)
     *      - `initialRegistryAddr` is zero (see {ZeroAddress})
     *      - `initialRegistryAddr` has no code (see {NotAContract})
     *
     * Security:
     * - Initializer: callable once.
     * - Sets the Registry used to resolve ACM and SSOT modules.
     *
     * @param initialRegistryAddr The Registry contract address.
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);

        __UUPSUpgradeable_init();

        _adminRegistryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Registry resolution helpers ━━━━━━━━━━━━━━━*/
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
            block.number
        );
    }

    /*━━━━━━━━━━━━━━━ View functions ━━━━━━━━━━━━━━━*/
    /**
     * @notice Returns the configured Registry address.
     * @dev Reverts if:
     *      - (never)
     *
     * Security:
     * - View-only getter.
     *
     * @return registryAddr_ The Registry contract address.
     */
    function getRegistryAddr() external view returns (address registryAddr_) {
        return _adminRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Governance actions ━━━━━━━━━━━━━━━*/
    /**
     * @notice Updates the system-wide minimum health factor, in basis points.
     * @dev Reverts if:
     *      - Registry is unset (see {ZeroAddress}) or has no code (see {NotAContract})
     *      - caller lacks `ActionKeys.ACTION_SET_PARAMETER` (reverts in {IAccessControlManager.requireRole})
     *      - Registry missing `ModuleKeys.KEY_ACCESS_CONTROL` (reverts in {IRegistry.getModuleOrRevert})
     *      - `hf` is outside \(1..20000\) bps (see {InvalidHealthFactor})
     *      - Registry missing `ModuleKeys.KEY_LIQUIDATION_CONFIG_MANAGER` (reverts in {IRegistry.getModuleOrRevert})
     *      - Registry resolves `ModuleKeys.KEY_LIQUIDATION_CONFIG_MANAGER` to zero (see {ZeroAddress})
     *      - SSOT module call reverts in {ILiquidationConfigManager.updateMinHealthFactor}
     *
     * Security:
     * - Role-gated via ACM (`ActionKeys.ACTION_SET_PARAMETER`) resolved through `Registry`.
     * - Emits {SystemEvents.ActionExecuted} for auditability.
     *
     * @param hf The new minimum health factor in basis points (bps). \(10000 = 100%\).
     */
    function setMinHealthFactor(
        uint256 hf
    ) external onlyValidRegistry onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (!(hf > 0 && hf <= 20_000)) revert InvalidHealthFactor();

        // 1) SSOT: parameter lives in LiquidationConfigManager
        address cfg = _getModule(ModuleKeys.KEY_LIQUIDATION_CONFIG_MANAGER);
        if (cfg == address(0)) revert ZeroAddress();
        ILiquidationConfigManager(cfg).updateMinHealthFactor(hf);

        // 2) Audit trail: standardized action event
        _emitActionExecuted(ActionKeys.ACTION_SET_PARAMETER);
    }

    // Intentionally minimal: other parameters should be managed by their SSOT modules.

    /*━━━━━━━━━━━━━━━ Upgrade auth ━━━━━━━━━━━━━━━*/
    /**
     * @notice Authorizes an implementation upgrade (UUPS).
     * @dev Reverts if:
     *      - Registry is unset/invalid, or missing `ModuleKeys.KEY_ACCESS_CONTROL`
     *        (reverts in {IRegistry.getModuleOrRevert})
     *      - caller lacks `ActionKeys.ACTION_UPGRADE_MODULE` (reverts in {IAccessControlManager.requireRole})
     *      - `newImplementation` is zero (see {ZeroAddress})
     *      - `newImplementation` has no code (see {VaultAdmin__InvalidImplementation})
     *
     * Security:
     * - Role-gated via ACM (`ActionKeys.ACTION_UPGRADE_MODULE`) resolved through `Registry`.
     * - Emits {SystemEvents.ActionExecuted} on success.
     *
     * @param newImplementation The new implementation contract address.
     */
    function _authorizeUpgrade(address newImplementation) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();

        if (newImplementation.code.length == 0)
            revert VaultAdmin__InvalidImplementation();

        _emitActionExecuted(ActionKeys.ACTION_UPGRADE_MODULE);
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/
    uint256[50] private __gap;
}
