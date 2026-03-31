// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { MissingRole, NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/**
 * @title SystemView
 * @notice Unified view facade for registry discovery and cross-module view routing.
 * @dev Reverts if:
 *      - registry is zero / not a contract (ZeroAddress / NotAContract)
 *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via ViewAccessLib / ACM)
 *      - a requested module is missing when using a strict resolver (Registry.getModuleOrRevert)
 *      - a named module is unknown (SystemView__UnknownModuleName)
 *      - UUPS upgrade is unauthorized (MissingRole via ACM)
 *
 * Security:
 * - View-only facade: does not write business state and does not emit DataPush events.
 * - Access control is enforced via ACTION_VIEW_SYSTEM_DATA for discovery endpoints.
 * - UUPS upgradeability is role-gated (ACTION_ADMIN via ACM).
 */
contract SystemView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Types ━━━━━━━━━━━━━━━*/

    struct RouteInfo {
        bytes32 moduleKey;
        address moduleAddr;
    }

    struct RouteHint {
        RouteInfo primaryRoute;
        RouteInfo fallbackRoute;
    }

    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/

    /// @notice Thrown when a module name cannot be resolved via ModuleKeys mapping nor legacy Registry fallback.
    /// @dev Reverts when `name` is unknown. Used by {getNamedModule}.
    error SystemView__UnknownModuleName();

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    /**
     * @notice Registry address used for module discovery and access control.
     * @dev Reverts if: (never)
     *
     * Security:
        * - SystemView is a view-only routing facade and MUST NOT store any business caches.
     */
    address private _registryAddr;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    modifier onlyViewRole() {
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender)) {
            revert MissingRole();
        }
        _;
    }

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the SystemView (UUPS).
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (ZeroAddress)
     *      - initialRegistryAddr is not a contract (NotAContract)
     *
     * Security:
    * - Initializer: callable once.
     *
    * @param initialRegistryAddr Registry contract address.
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Basic metadata ━━━━━━━━━━━━━━━*/

    /**
    * @notice Return the Registry contract address using the preferred frontend-facing name.
    * @dev Reverts if: (never)
     *
     * Security:
    * - View-only.
     *
    * @return registryAddr_ Registry contract address.
     */
    function registryAddrVar() external view returns (address registryAddr_) {
        return _registryAddr;
    }

    /**
    * @notice Return the AccessControlManager contract address resolved from Registry.
     * @dev Reverts if:
     *      - Registry has no module for KEY_ACCESS_CONTROL (via Registry.getModuleOrRevert)
     *
     * Security:
    * - View-only.
     *
    * @return accessControlManagerAddr AccessControlManager module address.
     */
    function acm() external view returns (address accessControlManagerAddr) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
    }

    /**
    * @notice Return the ViewCache module address resolved from Registry.
    * @dev Reverts if: (never). Returns address(0) if not configured.
     *
     * Security:
    * - View-only.
     *
    * @return viewCacheAddr ViewCache module address, or address(0) if not configured.
     */
    function viewCache() external view returns (address viewCacheAddr) {
        return Registry(_registryAddr).getModule(ModuleKeys.KEY_VIEW_CACHE);
    }

    /**
    * @notice Return the ViewCache module address using the preferred frontend-facing name.
    * @dev Reverts if: (never). Returns address(0) if not configured.
     *
     * Security:
    * - View-only.
     *
    * @return viewCacheAddr ViewCache module address, or address(0) if not configured.
     */
    function viewCacheAddrVar() external view returns (address viewCacheAddr) {
        return Registry(_registryAddr).getModule(ModuleKeys.KEY_VIEW_CACHE);
    }

    /**
     * @notice Resolve a module address by its key (strict).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *      - module is not configured (via Registry.getModuleOrRevert)
     *
     * Security:
    * - Role-gated via ACTION_VIEW_SYSTEM_DATA.
     *
     * @param key Module key (bytes32)
    * @return moduleAddr Module address resolved from Registry.
     */
    function getModule(bytes32 key) external view onlyValidRegistry onlyViewRole returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(key);
    }

    /**
     * @notice Resolve a module address by its key (optional).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
    * - Role-gated via ACTION_VIEW_SYSTEM_DATA.
     *
     * @param key Module key (bytes32)
    * @return moduleAddr Module address, or address(0) if not configured.
     */
    function getModuleOptional(bytes32 key) external view onlyValidRegistry onlyViewRole returns (address) {
        return Registry(_registryAddr).getModule(key);
    }

    /**
     * @notice Resolve a module address by its legacy string name (strict).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *      - `name` is not recognized by ModuleKeys mapping and no legacy Registry entry exists
     *        (SystemView__UnknownModuleName)
     *
     * Security:
    * - Role-gated via ACTION_VIEW_SYSTEM_DATA.
     *
     * @param name Module name (string); first resolved via ModuleKeys.getModuleKeyFromString(name),
     *             then falls back to Registry.getModule(keccak256(bytes(name))).
    * @return moduleAddr Module address resolved from the canonical or legacy name path.
     */
    function getNamedModule(string calldata name) external view onlyValidRegistry onlyViewRole returns (address) {
        // Prefer the canonical mapping (ModuleKeys legacy string compatibility).
        bytes32 key = ModuleKeys.getModuleKeyFromString(name);
        if (key != bytes32(0)) {
            return Registry(_registryAddr).getModuleOrRevert(key);
        }

        // Legacy fallback: some historical scripts stored keccak256(name) directly as the module key.
        address legacyModuleAddr = Registry(_registryAddr).getModule(keccak256(bytes(name)));
        if (legacyModuleAddr == address(0)) revert SystemView__UnknownModuleName();
        return legacyModuleAddr;
    }

    /**
     * @notice Resolve a module address by its legacy string name (optional).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
    * - Role-gated via ACTION_VIEW_SYSTEM_DATA.
     *
     * @param name Module name (string); first resolved via ModuleKeys.getModuleKeyFromString(name),
     *             then falls back to Registry.getModule(keccak256(bytes(name))).
    * @return moduleAddr Module address, or address(0) if not configured.
     */
    function getNamedModuleOptional(string calldata name)
        external
        view
        onlyValidRegistry
        onlyViewRole
        returns (address)
    {
        bytes32 key = ModuleKeys.getModuleKeyFromString(name);
        if (key != bytes32(0)) {
            return Registry(_registryAddr).getModule(key);
        }
        return Registry(_registryAddr).getModule(keccak256(bytes(name)));
    }

    /*━━━━━━━━━━━━━━━ Routing / discovery ━━━━━━━━━━━━━━━*/

    /**
    * @notice Return the canonical price-view route, including primary and fallback modules.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
    * - Role-gated via ACTION_VIEW_SYSTEM_DATA.
     *
    * @return routeHint_ Price-route hint with primary and fallback module addresses.
     */
    function routePrice() external view onlyValidRegistry onlyViewRole returns (RouteHint memory routeHint_) {
        routeHint_.primaryRoute = RouteInfo({
            moduleKey: ModuleKeys.KEY_VALUATION_ORACLE_VIEW,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_VALUATION_ORACLE_VIEW)
        });
        routeHint_.fallbackRoute = RouteInfo({
            moduleKey: ModuleKeys.KEY_PRICE_ORACLE,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_PRICE_ORACLE)
        });
    }

    /**
    * @notice Return the StatisticsView route.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
    * - Role-gated via ACTION_VIEW_SYSTEM_DATA.
     *
    * @return routeInfo_ Route info for StatisticsView.
     */
    function routeStatistics() external view onlyValidRegistry onlyViewRole returns (RouteInfo memory routeInfo_) {
        routeInfo_ = RouteInfo({
            moduleKey: ModuleKeys.KEY_STATS,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_STATS)
        });
    }

    /**
    * @notice Return the RewardView route.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
    * - Role-gated via ACTION_VIEW_SYSTEM_DATA.
     *
    * @return routeInfo_ Route info for RewardView.
     */
    function routeReward() external view onlyValidRegistry onlyViewRole returns (RouteInfo memory routeInfo_) {
        routeInfo_ = RouteInfo({
            moduleKey: ModuleKeys.KEY_REWARD_VIEW,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_REWARD_VIEW)
        });
    }

    /**
    * @notice Return the LiquidatorView route.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
    * - Role-gated via ACTION_VIEW_SYSTEM_DATA.
     *
    * @return routeInfo_ Route info for LiquidatorView.
     */
    function routeLiquidation() external view onlyValidRegistry onlyViewRole returns (RouteInfo memory routeInfo_) {
        routeInfo_ = RouteInfo({
            moduleKey: ModuleKeys.KEY_LIQUIDATION_VIEW,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_LIQUIDATION_VIEW)
        });
    }

    /**
    * @notice Return the RiskView route.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
    * - Role-gated via ACTION_VIEW_SYSTEM_DATA.
     *
    * @return routeInfo_ Route info for RiskView.
     */
    function routeRisk() external view onlyValidRegistry onlyViewRole returns (RouteInfo memory routeInfo_) {
        routeInfo_ = RouteInfo({
            moduleKey: ModuleKeys.KEY_RISK_VIEW,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_RISK_VIEW)
        });
    }

    /**
    * @notice Return the SystemRiskView route.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
    * - Role-gated via ACTION_VIEW_SYSTEM_DATA.
     *
    * @return routeInfo_ Route info for SystemRiskView.
     */
    function routeSystemRisk() external view onlyValidRegistry onlyViewRole returns (RouteInfo memory routeInfo_) {
        routeInfo_ = RouteInfo({
            moduleKey: ModuleKeys.KEY_SYSTEM_RISK_VIEW,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_SYSTEM_RISK_VIEW)
        });
    }

    /**
    * @notice Return the UserView route.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
    * - Role-gated via ACTION_VIEW_SYSTEM_DATA.
     *
    * @return routeInfo_ Route info for UserView.
     */
    function routeUser() external view onlyValidRegistry onlyViewRole returns (RouteInfo memory routeInfo_) {
        routeInfo_ = RouteInfo({
            moduleKey: ModuleKeys.KEY_USER_VIEW,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_USER_VIEW)
        });
    }

    /**
    * @notice Return the PositionView route.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
    * - Role-gated via ACTION_VIEW_SYSTEM_DATA.
     *
    * @return routeInfo_ Route info for PositionView.
     */
    function routePosition() external view onlyValidRegistry onlyViewRole returns (RouteInfo memory routeInfo_) {
        routeInfo_ = RouteInfo({
            moduleKey: ModuleKeys.KEY_POSITION_VIEW,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_POSITION_VIEW)
        });
    }

    /**
    * @notice Return the BatchView route.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
    * - Role-gated via ACTION_VIEW_SYSTEM_DATA.
     *
    * @return routeInfo_ Route info for BatchView.
     */
    function routeBatch() external view onlyValidRegistry onlyViewRole returns (RouteInfo memory routeInfo_) {
        routeInfo_ = RouteInfo({
            moduleKey: ModuleKeys.KEY_BATCH_VIEW,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_BATCH_VIEW)
        });
    }

    /**
    * @notice Return the DashboardView route.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
    * - Role-gated via ACTION_VIEW_SYSTEM_DATA.
     *
    * @return routeInfo_ Route info for DashboardView.
     */
    function routeDashboard() external view onlyValidRegistry onlyViewRole returns (RouteInfo memory routeInfo_) {
        routeInfo_ = RouteInfo({
            moduleKey: ModuleKeys.KEY_DASHBOARD_VIEW,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_DASHBOARD_VIEW)
        });
    }

    /**
    * @notice Return the PreviewView route.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
    * - Role-gated via ACTION_VIEW_SYSTEM_DATA.
     *
    * @return routeInfo_ Route info for PreviewView.
     */
    function routePreview() external view onlyValidRegistry onlyViewRole returns (RouteInfo memory routeInfo_) {
        routeInfo_ = RouteInfo({
            moduleKey: ModuleKeys.KEY_PREVIEW_VIEW,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_PREVIEW_VIEW)
        });
    }

    /*━━━━━━━━━━━━━━━ UUPS upgradeability ━━━━━━━━━━━━━━━*/

    /**
     * @notice Authorize UUPS upgrade (internal, called by upgradeTo/upgradeToAndCall).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADMIN role (MissingRole via ACM)
     *      - newImplementation is zero (ZeroAddress)
     *      - newImplementation is not a contract (NotAContract)
     *
     * Security:
    * - onlyValidRegistry modifier.
    * - ACTION_ADMIN role-gated via ACM.
     *
    * @param newImplementation New implementation contract address.
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            revert MissingRole();
        }
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ Versioning (C+B baseline) ━━━━━━━━━━━━━━━*/

    /**
    * @notice Return the API semantic version for this module.
    * @dev Reverts if: (never)
     *
     * Security:
    * - Pure function.
     *
    * @return apiVersion_ API semantic version.
     */
    function apiVersion() public pure override returns (uint256 apiVersion_) {
        return 1;
    }

    /**
    * @notice Return the output/schema version for this module.
    * @dev Reverts if: (never)
     *
     * Security:
    * - Pure function.
     *
    * @return schemaVersion_ Schema version.
     */
    function schemaVersion() public pure override returns (uint256 schemaVersion_) {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/

    /// @notice Storage gap for future upgrades.
    uint256[50] private __gap;
}
