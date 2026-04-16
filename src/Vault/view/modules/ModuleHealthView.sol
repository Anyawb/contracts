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
import { ViewConstants } from "../ViewConstants.sol";

/**
 * @title ModuleHealthView
 * @notice Lightweight module health checks and cached status for off-chain monitoring.
 * @dev Reverts if:
 *      - registry is zero / not a contract (ZeroAddress / NotAContract)
 *      - caller lacks required role for system health reads (MissingRole)
 *      - module is zero address for push flow (ZeroAddress)
 *
 * Security:
    * - Role-gated: only system health viewers can run checks and read cached results.
    * - UUPS upgradeability is role-gated via ACTION_ADMIN.
    * - Health checks are intentionally lightweight and code-size based to keep gas bounded.
 */
contract ModuleHealthView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    /// @notice Registry contract address (internal use only).
    address private _registryAddr;

    uint256 private constant _CACHE_DURATION_BLOCKS = ViewConstants.CACHE_DURATION_BLOCKS;

    /*━━━━━━━━━━━━━━━ Pre-defined health detail hashes ━━━━━━━━━━━━━━━*/

    /// @notice Pre-defined detail hashes (keep in sync with the canonical degradation storage, if any).
    bytes32 private constant _DETAILS_HEALTHY_HASH = keccak256("Module is healthy");
    bytes32 private constant _DETAILS_NO_CODE_HASH = keccak256("Module has no code");

    /*━━━━━━━━━━━━━━━ Legacy-compatible data structs ━━━━━━━━━━━━━━━*/

    /**
     * @notice Cached module health snapshot (legacy-compatible struct).
     * @dev Field meanings are preserved for backward compatibility with older integrations.
     * @param module Module address
     * @param isHealthy Whether the module is considered healthy
     * @param detailsHash Detail hash describing the latest status
     * @param lastCheckTime Last check block (block.number)
     * @param consecutiveFailures Consecutive failure count (implementation-defined)
     * @param totalChecks Total checks executed (local cache)
     * @param successRate Success rate percentage (0-100)
     */
    struct ModuleHealthStatus {
        address module;
        bool isHealthy;
        bytes32 detailsHash;
        uint256 lastCheckTime;
        uint256 consecutiveFailures;
        uint256 totalChecks;
        uint256 successRate; // percentage (0–100)
    }

    /**
     * @notice Lightweight module health tuple kept ABI-compatible with BatchView.
     * @dev Mirrors the smaller struct expected by BatchView's internal interface.
     */
    struct ModuleHealth {
        bool isHealthy;
        bytes32 detailsHash;
        uint32 lastCheckTime;
        uint32 consecutiveFailures;
    }

    /// @notice Latest cached health status: module => status.
    mapping(address => ModuleHealthStatus) private _moduleHealth;

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the ModuleHealthView (UUPS).
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (ZeroAddress)
     *      - initialRegistryAddr is not a contract (NotAContract)
     *
     * Security:
     * - initializer (UUPS)
     *
     * @param initialRegistryAddr Registry contract address
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /// @dev Gate: only system status viewers or admins.
    modifier onlySystemHealthViewer() {
        if (
            !_hasRole(ActionKeys.ACTION_VIEW_SYSTEM_STATUS, msg.sender) &&
            !_hasRole(ActionKeys.ACTION_ADMIN, msg.sender)
        ) revert MissingRole();
        _;
    }

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/

    /**
     * @notice Emitted after a module health check is pushed to HealthView.
     * @dev BlockNumber is intentionally not included; off-chain consumers should use the log's block number.
     * @dev IMPORTANT (Workguide alignment): this module MUST NOT emit `DataPushTypes.DATA_TYPE_MODULE_HEALTH`
     *      to avoid duplicate DataPush consumption. `HealthView.pushModuleHealth` is the single DataPush emitter.
     * @param module Module address checked
     * @param isHealthy Whether the module is considered healthy
     * @param failures Consecutive failure count (implementation-defined)
     */
    event ModuleHealthChecked(address indexed module, bool isHealthy, uint32 failures);

    /*━━━━━━━━━━━━━━━ Push APIs ━━━━━━━━━━━━━━━*/

    /**
     * @notice Run a lightweight health check and push the result to HealthView.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks required role (MissingRole via onlySystemHealthViewer)
     *      - module is zero address (ZeroAddress)
     *
     * Security:
     * - Role-gated (system health viewer)
     * - Pushes module health into HealthView (which emits unified DataPushed)
     *
    * @param module Module address to check.
    * @return isHealthy True if the module is considered healthy.
     */
    function checkAndPushModuleHealth(address module)
        external
        onlyValidRegistry
        onlySystemHealthViewer
        returns (bool isHealthy)
    {
        if (module == address(0)) revert ZeroAddress();

        bytes32 details;

        // Lightweight check: code size.
        uint256 size = module.code.length;
        if (size == 0) {
            isHealthy = false;
            details = _DETAILS_NO_CODE_HASH;
        } else {
            // Future: add interface ping / custom checks here
            isHealthy = true;
            details = _DETAILS_HEALTHY_HASH;
        }

        // Example failure count: 0 when healthy, 1 otherwise (can be expanded).
        uint32 failures = isHealthy ? 0 : 1;

        // Push to HealthView.
        address hvAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_HEALTH_VIEW);
        IHealthViewPush(hvAddr).pushModuleHealth(module, isHealthy, details, failures);

        emit ModuleHealthChecked(module, isHealthy, failures);

        // Cache result locally.
        ModuleHealthStatus storage s = _moduleHealth[module];
        s.module = module;
        s.isHealthy = isHealthy;
        s.detailsHash = details;
        uint256 blockNumber = block.number;
        s.lastCheckTime = blockNumber;
        s.consecutiveFailures = failures;
        s.totalChecks += 1;
        s.successRate = s.totalChecks == 0
            ? 0
            : (
                (s.successRate * (s.totalChecks - 1) + (isHealthy ? 100 : 0))
                    / s.totalChecks
            );
    }

    /*━━━━━━━━━━━━━━━ Read APIs ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get the cached module health status with validity metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks required role (MissingRole via onlySystemHealthViewer)
     *
     * Security:
    * - View-only.
     *
    * @param module Module address to query.
    * @return healthStatus Cached status struct.
    * @return blockNumber Last cache-write block number.
    * @return isValid True if the cache is valid under the configured TTL.
     */
    function getModuleHealthStatus(address module)
        external
        view
        onlyValidRegistry
        onlySystemHealthViewer
        returns (ModuleHealthStatus memory healthStatus, uint256 blockNumber, bool isValid)
    {
        healthStatus = _moduleHealth[module];
        blockNumber = healthStatus.lastCheckTime;
        isValid = _isCacheValid(blockNumber);
    }

    /**
     * @notice Get the cached module health status with validity metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks required role (MissingRole via onlySystemHealthViewer)
     *
     * Security:
    * - View-only.
     *
    * @param module Module address to query.
    * @return healthStatus Cached status struct.
    * @return blockNumber Last cache-write block number.
    * @return isValid True if the cache is valid under the configured TTL.
     */
    function getModuleHealthStatusWithMeta(address module)
        external
        view
        onlyValidRegistry
        onlySystemHealthViewer
        returns (ModuleHealthStatus memory healthStatus, uint256 blockNumber, bool isValid)
    {
        healthStatus = _moduleHealth[module];
        blockNumber = healthStatus.lastCheckTime;
        isValid = _isCacheValid(blockNumber);
    }

    /**
     * @notice Compatibility getter for BatchView-style module health aggregation.
     * @dev Returns the compact health struct together with validity metadata in
     *      the order expected by BatchView's IHealthViewBatch interface.
     *
     * @param module Module address to query.
     * @return moduleHealth Compact cached status struct.
     * @return isValid True if the cache is valid under the configured TTL.
     * @return blockNumber Last cache-write block number.
     */
    function getModuleHealthWithMeta(address module)
        external
        view
        onlyValidRegistry
        onlySystemHealthViewer
        returns (ModuleHealth memory moduleHealth, bool isValid, uint256 blockNumber)
    {
        ModuleHealthStatus storage s = _moduleHealth[module];
        moduleHealth = ModuleHealth({
            isHealthy: s.isHealthy,
            detailsHash: s.detailsHash,
            lastCheckTime: uint32(s.lastCheckTime),
            consecutiveFailures: uint32(s.consecutiveFailures)
        });
        blockNumber = s.lastCheckTime;
        isValid = _isCacheValid(blockNumber);
    }

    /**
     * @notice Run a lightweight health check without mutating state (legacy-compatible).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks required role (MissingRole via onlySystemHealthViewer)
     *
     * Security:
    * - View-only.
    * - Does not push results to HealthView.
     *
    * @param module Module address to check.
    * @return isHealthy True if the module is considered healthy.
    * @return details Human-readable detail string.
     */
    function checkModuleHealth(address module)
        external
        view
        onlyValidRegistry
        onlySystemHealthViewer
        returns (bool isHealthy, string memory details)
    {
        if (module == address(0)) {
            return (false, "Module address is zero");
        }

        uint256 size = module.code.length;

        if (size == 0) {
            return (false, "Module has no code");
        }

        return (true, "Module is healthy");
    }

    /**
    * @notice Return the Registry address used by this module.
     * @dev This getter may return address(0) if the contract is not initialized.
     *
     * Security:
    * - View-only.
     *
    * @return registryAddrVar Registry contract address.
     */
    function getRegistry() external view returns (address registryAddrVar) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/

    function _hasRole(bytes32 actionKey, address user) internal view returns (bool) {
        return ViewAccessLib.hasRole(_registryAddr, actionKey, user);
    }

    function _isCacheValid(uint256 updateBlock) internal view returns (bool) {
        // TTL validity is metadata for off-chain UX; it is not used for business-critical decisions.
        if (updateBlock == 0 || updateBlock > block.number) return false;
        return block.number - updateBlock <= _CACHE_DURATION_BLOCKS;
    }

    /*━━━━━━━━━━━━━━━ UUPS upgradeability ━━━━━━━━━━━━━━━*/

    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            revert MissingRole();
        }
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ Versioning (C+B baseline) ━━━━━━━━━━━━━━━*/

    function apiVersion() public pure override returns (uint256) {
        // API change: add canonical meta-read (blockNumber/isValid) and align to single DataPush emitter:
        // HealthView.pushModuleHealth emits DataPushed(DATA_TYPE_MODULE_HEALTH); ModuleHealthView MUST NOT emit it.
        return 2;
    }

    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/

    uint256[50] private __gap;
}

/**
 * @title IHealthViewPush
 * @notice Minimal interface for pushing module health into HealthView.
 * @dev Avoids circular dependencies between view modules.
 */
interface IHealthViewPush {
    /**
     * @notice Push module health status into HealthView.
     * @dev Reverts if:
     *      - HealthView rejects the call (module-specific)
     *
     * Security:
    * - Called by ModuleHealthView after role-gated checks.
     *
    * @param module Module address.
    * @param ok True if the module is healthy.
    * @param detailsHash Detail hash describing the status.
    * @param failures Consecutive failure count.
     */
    function pushModuleHealth(address module, bool ok, bytes32 detailsHash, uint32 failures) external;
}
