// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {IRegistry} from "../interfaces/IRegistry.sol";
import {IRegistryStorageMigrator} from "../interfaces/IRegistryStorageMigrator.sol";
import {
    IndexOutOfBounds,
    ModuleAlreadyExists,
    ModuleCapExceeded,
    ModuleUpgradeNotFound,
    ModuleUpgradeNotReady,
    NotAContract
} from "../errors/StandardErrors.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {RegistryStorage} from "./RegistryStorageLibrary.sol";
import {RegistryEvents} from "./RegistryEventsLibrary.sol";
import {RegistryQuery} from "./RegistryQueryLibrary.sol";
import {RegistryCompatQuery} from "./RegistryCompatQueryLibrary.sol";

/**
 * @title Registry
 * @notice Unified module-address registry entrypoint for governance and upgrades.
 * @dev Reverts if:
 *      - storage layout is incompatible with CURRENT_STORAGE_VERSION (in compat-gated methods)
 *
 * Security:
 * - UUPS upgrade authorization is gated by upgradeAdmin / emergencyAdmin / owner
 * - Governance and module writes are owner-gated and pause-aware
 * - Timelocked module upgrades rely on block.number by design (for scheduling/execution)
 */
contract Registry is 
    IRegistry,
    Initializable, 
    OwnableUpgradeable, 
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    PausableUpgradeable
{
    // ============ Custom Errors ============
    /**
     * @notice The caller is not authorized to perform an upgrade.
     * @param caller The caller attempting to upgrade.
     */
    error Registry__NotUpgradeAdmin(address caller);

    /**
     * @notice The provided delay exceeds the maximum allowed delay.
     * @param provided The provided delay (blocks).
     * @param max The maximum allowed delay (blocks).
     */
    error Registry__DelayTooLong(uint256 provided, uint256 max);

    /**
     * @notice The provided delay value is invalid.
     * @param delay The provided delay (blocks).
     */
    error Registry__InvalidDelayValue(uint256 delay);

    /**
     * @notice A compat-path module is not configured.
     * @param moduleName Human-readable module name.
     */
    error Registry__ModuleNotSet(string moduleName);

    /**
     * @notice The caller is not the pending admin.
     * @param caller The caller attempting to accept admin.
     * @param pendingAdmin The currently configured pending admin.
     */
    error Registry__NotPendingAdmin(address caller, address pendingAdmin);

    /**
     * @notice The pending admin address is invalid.
     * @param pendingAdmin The provided/loaded pending admin.
     */
    error Registry__InvalidPendingAdmin(address pendingAdmin);

    /**
     * @notice The caller is not authorized as emergency admin.
     * @param caller The caller attempting the emergency action.
     * @param emergencyAdmin The configured emergency admin.
     */
    error Registry__EmergencyAdminNotAuthorized(address caller, address emergencyAdmin);

    /**
     * @notice A zero address was provided where it is not allowed.
     */
    error Registry__ZeroAddress();

    /**
     * @notice The upgrade admin address is invalid.
     * @param newAdmin The proposed upgrade admin address.
     */
    error Registry__InvalidUpgradeAdmin(address newAdmin);

    /**
     * @notice An input parameter is invalid (tests/compat only).
     * @param reason A human-readable reason string.
     */
    error Registry__InvalidParameter(string reason);

    /**
     * @notice Array lengths mismatch in a batch operation.
     * @param keysLength Length of the keys array.
     * @param addressesLength Length of the addresses array.
     */
    error Registry__MismatchedArrayLengths(uint256 keysLength, uint256 addressesLength);

    /**
     * @notice The migrator must be a deployed contract (EOA / empty-code is forbidden).
     * @param migrator The migrator address.
     */
    error Registry__MigratorNotContract(address migrator);

    /**
     * @notice Storage version mismatch.
     * @param expected The expected storage version.
     * @param actual The actual storage version.
     */
    error Registry__StorageVersionMismatch(uint256 expected, uint256 actual);

    /**
     * @notice The migration target is invalid (must be strictly increasing).
     * @param fromVersion The current/expected storage version.
     * @param toVersion The target storage version.
     */
    error Registry__InvalidMigrationTarget(uint256 fromVersion, uint256 toVersion);

    /**
     * @notice The migrator execution failed.
     * @param migrator The migrator contract address.
     * @param reason Low-level revert reason bytes.
     */
    error Registry__MigratorFailed(address migrator, bytes reason);

    // ============ Constants ============
    /// @notice Maximum delay window (blocks, ~7 days with ~2s blocks).
    uint256 private constant _MAX_DELAY = 7 days / 2 seconds;
    /// @notice Upgrade history ring size cap.
    uint256 private constant _MAX_UPGRADE_HISTORY = 100;
    /// @notice Batch size cap (tests/safety).
    uint256 private constant _MAX_BATCH_SIZE = 50;

    // ============ Upgrade Admin ============
    /// @notice Upgrade admin address.
    address private _upgradeAdmin;
    /// @notice Emergency admin address.
    address private _emergencyAdmin;

    // ============ Optional integrations ============
    /// @notice Dynamic module key registry address.
    address private _dynamicModuleKeyRegistry;

    // ============ Constructor ============
    /**
     * @notice Constructs the implementation contract and disables initializers.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Disables Initializable initializers on the implementation instance
     *
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor() {
        _disableInitializers();
    }

    // ============ Initializer ============
    /**
     * @notice Initializes the Registry and configures governance and upgrade authority.
     * @dev Reverts if:
     *      - minDelayBlocks > MAX_DELAY()
     *      - upgradeAdmin == address(0)
     *      - emergencyAdmin == address(0)
     *      - initialOwner == address(0)
     *
     * Security:
     * - Single-use initializer (Initializable)
     * - Sets governance owner/admin to initialOwner (not msg.sender)
     *
     * @param minDelayBlocks Minimum delay window for timelocked module upgrades (blocks).
     * @param upgradeAdmin Address authorized to perform UUPS upgrades.
     * @param emergencyAdmin Address authorized to pause/cancel upgrades in emergencies.
     * @param initialOwner Initial governance owner/admin address.
     */
    function initialize(uint256 minDelayBlocks, address upgradeAdmin, address emergencyAdmin, address initialOwner)
        external
        initializer
    {
        if (minDelayBlocks > _MAX_DELAY) revert Registry__DelayTooLong(minDelayBlocks, _MAX_DELAY);
        if (upgradeAdmin == address(0)) revert Registry__ZeroAddress();
        if (emergencyAdmin == address(0)) revert Registry__ZeroAddress();
        if (initialOwner == address(0)) revert Registry__ZeroAddress();
        
        __Ownable_init(initialOwner);
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
        __Pausable_init();
        
        RegistryStorage.initializeStorageVersion();
        
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        // Governance/admin (compat) should follow the explicit initial owner, not the initializer caller.
        layout.admin = initialOwner;
        layout.pendingAdmin = address(0);
        layout.minDelay = uint64(minDelayBlocks);
        
        _upgradeAdmin = upgradeAdmin;
        _emergencyAdmin = emergencyAdmin;
        
        emit RegistryEvents.RegistryInitialized(
            initialOwner,
            minDelayBlocks,
            msg.sender
        );
    }

    // ============ UUPS Upgrade Authorization ============
    /**
     * @notice Authorizes a UUPS upgrade to a new implementation.
     * @dev Reverts if:
     *      - newImplementation == address(0)
     *      - newImplementation has no code (EOA / empty-code)
     *      - msg.sender is not upgradeAdmin, emergencyAdmin, or owner
     *
     * Security:
     * - UUPS upgrade gate (UUPSUpgradeable)
     *
     * @param newImplementation The new implementation address.
     */
    function _authorizeUpgrade(address newImplementation) internal view override {
        if (newImplementation == address(0)) revert Registry__ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
        if (msg.sender == _upgradeAdmin || msg.sender == _emergencyAdmin || msg.sender == owner()) {
            return;
        }
        revert Registry__NotUpgradeAdmin(msg.sender);
    }

    // ============ Optional integrations ============

    /**
     * @notice Sets (or clears) the dynamic module key registry integration address.
     * @dev Reverts if:
     *      - dynamicModuleKeyRegistryAddr is non-zero and has no code
     *
     * Security:
     * - onlyOwner
     *
     * @param dynamicModuleKeyRegistryAddr Dynamic module key registry contract address (or zero to disable).
     */
    function setDynamicModuleKeyRegistry(address dynamicModuleKeyRegistryAddr) external onlyOwner {
        if (dynamicModuleKeyRegistryAddr != address(0) && dynamicModuleKeyRegistryAddr.code.length == 0) {
            revert NotAContract(dynamicModuleKeyRegistryAddr);
        }
        
        address oldAddr = _dynamicModuleKeyRegistry;
        _dynamicModuleKeyRegistry = dynamicModuleKeyRegistryAddr;
        emit RegistryEvents.DynamicModuleKeyRegistryChanged(oldAddr, dynamicModuleKeyRegistryAddr, msg.sender);
    }

    // ============ Interface overrides ============
    /**
     * @notice Returns the governance owner of the Registry.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @return The owner address.
     */
    function owner() public view override(IRegistry, OwnableUpgradeable) returns (address) {
        return super.owner();
    }

    /**
     * @notice Transfers governance ownership to a new owner.
     * @dev Reverts if:
     *      - storage version is incompatible (compat gate)
     *      - newOwner == address(0)
     *
     * Security:
     * - onlyOwner
     *
     * @param newOwner The new owner address.
     */
    function transferOwnership(address newOwner) public override(IRegistry, OwnableUpgradeable) onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (newOwner == address(0)) revert Registry__ZeroAddress();
        RegistryStorage.Layout storage layout = RegistryStorage.layout();

        address oldAdmin = owner();
        address oldPending = layout.pendingAdmin;

        super.transferOwnership(newOwner);
        layout.admin = newOwner;

        if (oldPending != address(0)) {
            layout.pendingAdmin = address(0);
            emit RegistryEvents.PendingAdminChanged(oldPending, address(0));
        }
        emit RegistryEvents.AdminChanged(oldAdmin, newOwner);
    }

    /**
     * @notice Renounces governance ownership.
     * @dev Reverts if:
     *      - storage version is incompatible (compat gate)
     *
     * Security:
     * - onlyOwner
     *
     * Notes:
     * - Keeps RegistryStorage.admin/pendingAdmin consistent with Ownable owner.
     */
    function renounceOwnership() public override(OwnableUpgradeable) onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        RegistryStorage.Layout storage layout = RegistryStorage.layout();

        address oldAdmin = owner();
        address oldPending = layout.pendingAdmin;

        super.renounceOwnership();
        layout.admin = address(0);

        if (oldPending != address(0)) {
            layout.pendingAdmin = address(0);
            emit RegistryEvents.PendingAdminChanged(oldPending, address(0));
        }
        emit RegistryEvents.AdminChanged(oldAdmin, address(0));
    }

    // ============ Read-only queries (via RegistryQuery) ============
    /**
     * @notice Returns the module address for a given module key.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @param key The module key.
     * @return The module address (zero if not set).
     */
    function getModule(bytes32 key) external view override returns (address) {
        return RegistryQuery.getModule(key);
    }

    /**
     * @notice Returns the module address for a key, reverting if it is not registered.
     * @dev Reverts if:
     *      - module is not registered for key (via RegistryQuery)
     *
     * Security:
     * - Read-only
     *
     * @param key The module key.
     * @return The module address.
     */
    function getModuleOrRevert(bytes32 key) external view override returns (address) {
        return RegistryQuery.getModuleOrRevert(key);
    }

    /**
     * @notice Returns whether a module is registered for the given key.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @param key The module key.
     * @return True if registered.
     */
    function isModuleRegistered(bytes32 key) external view override returns (bool) {
        return RegistryQuery.isModuleRegistered(key);
    }

    /**
     * @notice Returns the current minimum delay window for timelocked module upgrades.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @return The minimum delay window (blocks).
     */
    function minDelay() external view override returns (uint256) {
        return RegistryStorage.layout().minDelay;
    }

    // ============ Upgrade admin management ============
    /**
     * @notice Sets the upgrade admin address (UUPS upgrade authority).
     * @dev Reverts if:
     *      - newAdmin == address(0)
     *
     * Security:
     * - onlyOwner
     *
     * @param newAdmin The new upgrade admin address.
     */
    function setUpgradeAdmin(address newAdmin) external onlyOwner {
        if (newAdmin == address(0)) revert Registry__InvalidUpgradeAdmin(newAdmin);
        address oldAdmin = _upgradeAdmin;
        _upgradeAdmin = newAdmin;
        emit RegistryEvents.UpgradeAdminChanged(oldAdmin, newAdmin);
    }

    /**
     * @notice Sets the emergency admin address (pause/cancel authority).
     * @dev Reverts if:
     *      - newAdmin == address(0)
     *
     * Security:
     * - onlyOwner
     *
     * @param newAdmin The new emergency admin address.
     */
    function setEmergencyAdmin(address newAdmin) external onlyOwner {
        if (newAdmin == address(0)) revert Registry__ZeroAddress();
        address oldAdmin = _emergencyAdmin;
        _emergencyAdmin = newAdmin;
        emit RegistryEvents.EmergencyAdminChanged(oldAdmin, newAdmin);
    }

    /**
     * @notice Returns the configured upgrade admin address.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @return The upgrade admin address.
     */
    function getUpgradeAdmin() external view returns (address) {
        return _upgradeAdmin;
    }

    /**
     * @notice Returns the configured emergency admin address.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @return The emergency admin address.
     */
    function getEmergencyAdmin() external view returns (address) {
        return _emergencyAdmin;
    }

    /**
     * @notice Returns the dynamic module key registry integration address.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @return The dynamic module key registry address (zero if disabled).
     */
    function getDynamicModuleKeyRegistry() external view returns (address) {
        return _dynamicModuleKeyRegistry;
    }

    // ============ Governance (compat) ============
    /**
     * @notice Returns the governance admin address (compat path).
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @return The governance admin (owner) address.
     */
    function getAdmin() external view override returns (address) {
        return owner();
    }

    /**
     * @notice Returns the pending admin address (compat path).
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @return The pending admin address (zero if none).
     */
    function getPendingAdmin() external view override returns (address) {
        return RegistryStorage.layout().pendingAdmin;
    }

    /**
     * @notice Returns whether the Registry is paused.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @return True if paused.
     */
    function isPaused() external view override returns (bool) {
        return paused();
    }

    /**
     * @notice Sets a new governance admin (compat path) by transferring ownership.
     * @dev Reverts if:
     *      - storage version is incompatible (compat gate)
     *      - newAdmin == address(0)
     *
     * Security:
     * - onlyOwner
     *
     * @param newAdmin The new governance admin/owner address.
     */
    function setAdmin(address newAdmin) external onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (newAdmin == address(0)) revert Registry__ZeroAddress();
        address oldAdmin = owner();
        _transferOwnership(newAdmin);
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        address oldPending = layout.pendingAdmin;
        layout.admin = newAdmin;
        if (oldPending != address(0)) {
            layout.pendingAdmin = address(0);
            emit RegistryEvents.PendingAdminChanged(oldPending, address(0));
        }
        emit RegistryEvents.AdminChanged(oldAdmin, newAdmin);
    }

    /**
     * @notice Sets the pending admin address (compat path).
     * @dev Reverts if:
     *      - storage version is incompatible (compat gate)
     *
     * Security:
     * - onlyOwner
     *
     * @param newPendingAdmin The new pending admin address (can be zero to clear).
     */
    function setPendingAdmin(address newPendingAdmin) external override onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        address oldPending = layout.pendingAdmin;
        layout.pendingAdmin = newPendingAdmin;
        emit RegistryEvents.PendingAdminChanged(oldPending, newPendingAdmin);
    }

    /**
     * @notice Accepts the pending admin role (compat path) and becomes owner/admin.
     * @dev Reverts if:
     *      - storage version is incompatible (compat gate)
     *      - msg.sender != pendingAdmin
     *      - pendingAdmin == address(0)
     *
     * Security:
     * - Caller must be the configured pending admin
     */
    function acceptAdmin() external override {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        if (msg.sender != layout.pendingAdmin) revert Registry__NotPendingAdmin(msg.sender, layout.pendingAdmin);
        if (layout.pendingAdmin == address(0)) revert Registry__InvalidPendingAdmin(layout.pendingAdmin);
        
        address oldAdmin = owner();
        address oldPending = layout.pendingAdmin;
        _transferOwnership(msg.sender);
        layout.admin = msg.sender;
        layout.pendingAdmin = address(0);
        emit RegistryEvents.PendingAdminChanged(oldPending, address(0));
        emit RegistryEvents.AdminChanged(oldAdmin, msg.sender);
    }

    /**
     * @notice Pauses the Registry (blocks whenNotPaused module/governance write paths).
     * @dev Reverts if:
     *      - msg.sender is not owner and not emergencyAdmin
     *      - storage version is incompatible (compat gate)
     *
     * Security:
     * - Emergency action; callable by owner or emergencyAdmin
     */
    function pause() external override {
        if (msg.sender != owner() && msg.sender != _emergencyAdmin) {
            revert Registry__EmergencyAdminNotAuthorized(msg.sender, _emergencyAdmin);
        }
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        _pause();
        RegistryStorage.layout().paused = 1;
        emit RegistryEvents.EmergencyActionExecuted(
            uint8(RegistryEvents.EmergencyAction.PAUSE),
            msg.sender,
            // Block number is emitted for off-chain auditing; not used for business decisions.
            block.number
        );
    }

    /**
     * @notice Unpauses the Registry (re-enables whenNotPaused write paths).
     * @dev Reverts if:
     *      - storage version is incompatible (compat gate)
     *
     * Security:
     * - onlyOwner
     */
    function unpause() external override onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        _unpause();
        RegistryStorage.layout().paused = 0;
        emit RegistryEvents.EmergencyActionExecuted(
            uint8(RegistryEvents.EmergencyAction.UNPAUSE),
            msg.sender,
            // Block number is emitted for off-chain auditing; not used for business decisions.
            block.number
        );
    }

    // ============ Module management (writes to RegistryStorage) ============
    /**
     * @notice Sets a module address for a given module key.
     * @dev Reverts if:
     *      - storage version is incompatible (compat gate)
     *      - moduleAddr == address(0)
     *      - module already exists and replacement is not allowed (in internal logic)
     *      - Registry is paused
     *
     * Security:
     * - onlyOwner
     * - whenNotPaused
     *
     * @param key The module key.
     * @param moduleAddr The module contract address.
     */
    function setModule(bytes32 key, address moduleAddr) external override onlyOwner whenNotPaused {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        _setModuleInternal(key, moduleAddr, true, true);
    }

    /**
     * @notice Sets a module address and returns whether it changed.
     * @dev Reverts if:
     *      - storage version is incompatible (compat gate)
     *      - moduleAddr == address(0)
     *      - Registry is paused
     *
     * Security:
     * - onlyOwner
     * - whenNotPaused
     *
     * @param key The module key.
     * @param moduleAddr The module contract address.
     * @return changed True if the stored address changed.
     */
    function setModuleWithStatus(bytes32 key, address moduleAddr)
        external
        override
        onlyOwner
        whenNotPaused
        returns (bool changed)
    {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        changed = _setModuleInternal(key, moduleAddr, true, true);
    }

    /**
     * @notice Sets a module address with an explicit allowReplace flag.
     * @dev Reverts if:
     *      - storage version is incompatible (compat gate)
     *      - moduleAddr == address(0)
     *      - allowReplace == false and a different module is already set
     *      - Registry is paused
     *
     * Security:
     * - onlyOwner
     * - whenNotPaused
     *
     * @param key The module key.
     * @param moduleAddr The module contract address.
     * @param allowReplace Whether to allow replacing an existing module address.
     */
    function setModuleWithReplaceFlag(bytes32 key, address moduleAddr, bool allowReplace)
        external
        override
        onlyOwner
        whenNotPaused
    {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        _setModuleInternal(key, moduleAddr, allowReplace, true);
    }

    /**
     * @notice Batch sets module addresses and returns which keys changed.
     * @dev Reverts if:
     *      - storage version is incompatible (compat gate)
     *      - keys.length != addresses.length
     *      - keys.length > _MAX_BATCH_SIZE
     *      - any moduleAddr == address(0)
     *      - Registry is paused
     *
     * Security:
     * - onlyOwner
     * - whenNotPaused
     *
     * @param keys Module keys.
     * @param addresses Module addresses.
     * @return changedCount Number of keys that changed.
     * @return changedKeys Keys that changed (only first changedCount entries are populated).
     */
    function setModulesWithStatus(bytes32[] calldata keys, address[] calldata addresses)
        external
        override
        onlyOwner
        whenNotPaused
        returns (uint256 changedCount, bytes32[] memory changedKeys)
    {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (keys.length != addresses.length) revert Registry__MismatchedArrayLengths(keys.length, addresses.length);
        if (keys.length > _MAX_BATCH_SIZE) revert ModuleCapExceeded(keys.length, _MAX_BATCH_SIZE);
        // Emit only the batch event (avoid duplicate per-item events).
        address[] memory oldAddresses = new address[](keys.length);
        changedKeys = new bytes32[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            oldAddresses[i] = RegistryStorage.layout().modules[keys[i]];
            bool changed = _setModuleInternal(keys[i], addresses[i], true, false);
            if (changed) {
                changedKeys[changedCount] = keys[i];
                changedCount++;
            }
        }
        emit RegistryEvents.BatchModuleChanged(keys, oldAddresses, addresses, msg.sender);
    }

    /**
     * @notice Compat: batch sets modules with an allowReplace flag (tests/compat).
     * @dev Reverts if:
     *      - storage version is incompatible (compat gate)
     *      - keys.length != addresses.length
     *      - keys.length > _MAX_BATCH_SIZE
     *      - any moduleAddr == address(0)
     *      - allowReplace == false and a different module is already set
     *      - Registry is paused
     *
     * Security:
     * - onlyOwner
     * - whenNotPaused
     *
     * @param keys Module keys.
     * @param addresses Module addresses.
     * @param allowReplace Whether to allow replacing existing module addresses.
     */
    function batchSetModules(bytes32[] calldata keys, address[] calldata addresses, bool allowReplace)
        external
        onlyOwner
        whenNotPaused
    {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (keys.length != addresses.length) revert Registry__MismatchedArrayLengths(keys.length, addresses.length);
        if (keys.length > _MAX_BATCH_SIZE) revert ModuleCapExceeded(keys.length, _MAX_BATCH_SIZE);
        address[] memory oldAddresses = new address[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            oldAddresses[i] = RegistryStorage.layout().modules[keys[i]];
            _setModuleInternal(keys[i], addresses[i], allowReplace, false);
        }
        emit RegistryEvents.BatchModuleChanged(keys, oldAddresses, addresses, msg.sender);
    }

    /**
     * @notice Batch sets module addresses (event control; compat).
     * @dev Reverts if:
     *      - storage version is incompatible (compat gate)
     *      - keys.length != addresses.length
     *      - keys.length > _MAX_BATCH_SIZE
     *      - any moduleAddr == address(0)
     *      - Registry is paused
     *
     * Security:
     * - onlyOwner
     * - whenNotPaused
     *
     * @param keys Module keys.
     * @param addresses Module addresses.
     * @param emitIndividualEvents Ignored (kept for interface compatibility).
     */
    function setModulesWithEvents(bytes32[] calldata keys, address[] calldata addresses, bool emitIndividualEvents)
        external
        override
        onlyOwner
        whenNotPaused
    {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (keys.length != addresses.length) revert Registry__MismatchedArrayLengths(keys.length, addresses.length);
        if (keys.length > _MAX_BATCH_SIZE) revert ModuleCapExceeded(keys.length, _MAX_BATCH_SIZE);
        if (emitIndividualEvents) {
            for (uint256 i = 0; i < keys.length; i++) {
                _setModuleInternal(keys[i], addresses[i], true, true);
            }
            return;
        }

        address[] memory oldAddresses = new address[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            oldAddresses[i] = RegistryStorage.layout().modules[keys[i]];
            _setModuleInternal(keys[i], addresses[i], true, false);
        }
        emit RegistryEvents.BatchModuleChanged(keys, oldAddresses, addresses, msg.sender);
    }

    /**
     * @notice Batch sets module addresses without emitting per-item events (compat).
     * @dev Reverts if:
     *      - storage version is incompatible (compat gate)
     *      - keys.length != addresses.length
     *      - keys.length > _MAX_BATCH_SIZE
     *      - any moduleAddr == address(0)
     *      - Registry is paused
     *
     * Security:
     * - onlyOwner
     * - whenNotPaused
     *
     * @param keys Module keys.
     * @param addresses Module addresses.
     */
    function setModules(bytes32[] calldata keys, address[] calldata addresses)
        external
        override
        onlyOwner
        whenNotPaused
    {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (keys.length != addresses.length) revert Registry__MismatchedArrayLengths(keys.length, addresses.length);
        if (keys.length > _MAX_BATCH_SIZE) revert ModuleCapExceeded(keys.length, _MAX_BATCH_SIZE);
        address[] memory oldAddresses = new address[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            oldAddresses[i] = RegistryStorage.layout().modules[keys[i]];
            _setModuleInternal(keys[i], addresses[i], true, false);
        }
        emit RegistryEvents.BatchModuleChanged(keys, oldAddresses, addresses, msg.sender);
    }

    /// @dev Internal module write; supports allowReplace and per-item event emission.
    function _setModuleInternal(bytes32 key, address moduleAddr, bool allowReplace, bool emitEvent)
        internal
        returns (bool changed)
    {
        if (moduleAddr == address(0)) revert Registry__ZeroAddress();

        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        address old = layout.modules[key];

        if (!allowReplace && old != address(0) && old != moduleAddr) {
            revert ModuleAlreadyExists(key);
        }

        if (old == moduleAddr) {
            return false;
        }

        layout.modules[key] = moduleAddr;
        if (emitEvent) {
            emit RegistryEvents.ModuleChanged(key, old, moduleAddr);
        }
        // Record upgrade history (write order; 0 is the first change).
        _recordUpgradeHistory(key, old, moduleAddr, msg.sender);
        return true;
    }

    function _recordUpgradeHistory(bytes32 key, address oldAddr, address newAddr, address executor) internal {
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        RegistryStorage.UpgradeHistory memory history = RegistryStorage.UpgradeHistory({
            oldAddress: oldAddr,
            newAddress: newAddr,
            // Block number is stored for off-chain auditing/forensics; not used for business decisions.
            blockNumber: block.number,
            executor: executor
        });
        uint256 currentIndex = layout.historyIndex[key];
        uint256 ringIndex = currentIndex % _MAX_UPGRADE_HISTORY;
        if (layout.upgradeHistory[key].length < _MAX_UPGRADE_HISTORY) {
            layout.upgradeHistory[key].push(history);
        } else {
            layout.upgradeHistory[key][ringIndex] = history;
        }
        layout.historyIndex[key] = currentIndex + 1;
    }

    // ============ Upgrade scheduling/execution ============
    /**
     * @notice Schedules a timelocked module upgrade for a given key.
     * @dev Reverts if:
     *      - storage version is incompatible (compat gate)
     *      - newAddr == address(0)
     *      - Registry is paused
     *
     * Security:
     * - onlyOwner
     * - whenNotPaused
     * - Uses block.number for timelock scheduling by design
     *
     * @param key The module key.
     * @param newAddr The new module address.
     */
    function scheduleModuleUpgrade(bytes32 key, address newAddr) external override onlyOwner whenNotPaused {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (newAddr == address(0)) revert Registry__ZeroAddress();
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        address oldAddress = layout.modules[key];
        // Timelock scheduling relies on block.number by design.
        uint256 executeAfter = block.number + uint256(layout.minDelay);
        layout.pendingUpgrades[key] = RegistryStorage.PendingUpgrade({
            newAddr: newAddr,
            executeAfter: executeAfter,
            proposer: msg.sender,
            minDelaySnapshot: uint256(layout.minDelay)
        });
        emit RegistryEvents.ModuleUpgradeScheduled(key, oldAddress, newAddr, executeAfter, msg.sender);
    }

    /**
     * @notice Cancels a scheduled module upgrade for a key.
     * @dev Reverts if:
     *      - storage version is incompatible (compat gate)
     *      - msg.sender is not owner and not emergencyAdmin
     *      - Registry is paused
     *
     * Security:
     * - whenNotPaused
     * - Callable by owner or emergencyAdmin
     *
     * @param key The module key.
     */
    function cancelModuleUpgrade(bytes32 key) external override whenNotPaused {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (msg.sender != owner() && msg.sender != _emergencyAdmin) {
            revert Registry__EmergencyAdminNotAuthorized(msg.sender, _emergencyAdmin);
        }
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        RegistryStorage.PendingUpgrade memory p = layout.pendingUpgrades[key];
        if (p.newAddr == address(0)) return;
        address oldAddress = layout.modules[key];
        delete layout.pendingUpgrades[key];
        emit RegistryEvents.ModuleUpgradeCancelled(key, oldAddress, p.newAddr, msg.sender);
    }

    /**
     * @notice Executes a scheduled timelocked module upgrade for a key.
     * @dev Reverts if:
     *      - storage version is incompatible (compat gate)
     *      - no pending upgrade exists for key
     *      - block.number < executeAfter (timelock not elapsed)
     *      - Registry is paused
     *
     * Security:
     * - onlyOwner
     * - whenNotPaused
     * - nonReentrant
     * - Uses block.number for timelock checks by design
     *
     * @param key The module key.
     */
    function executeModuleUpgrade(bytes32 key) external override onlyOwner whenNotPaused nonReentrant {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        RegistryStorage.PendingUpgrade memory p = layout.pendingUpgrades[key];
        if (p.newAddr == address(0)) revert ModuleUpgradeNotFound(key);
        // Timelock execution relies on block.number by design.
        if (block.number < p.executeAfter) revert ModuleUpgradeNotReady(key, p.executeAfter, block.number);
        address oldAddress = layout.modules[key];
        address newAddr = p.newAddr;
        layout.modules[key] = newAddr;
        delete layout.pendingUpgrades[key];
        emit RegistryEvents.ModuleUpgraded(key, oldAddress, newAddr, msg.sender);
        _recordUpgradeHistory(key, oldAddress, newAddr, msg.sender);
    }

    /**
     * @notice Emergency admin cancels all pending upgrades across known module keys.
     * @dev Reverts if:
     *      - storage version is incompatible (compat gate)
     *      - msg.sender != emergencyAdmin
     *
     * Security:
     * - Callable while paused (pause-then-cancel workflow)
     *
     * Notes:
     * - Iterates over ModuleKeys.getAllKeys().
     */
    function emergencyCancelAllUpgrades() external {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (msg.sender != _emergencyAdmin) {
            revert Registry__EmergencyAdminNotAuthorized(msg.sender, _emergencyAdmin);
        }
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        bytes32[] memory keys = ModuleKeys.getAllKeys();
        for (uint256 i = 0; i < keys.length; i++) {
            RegistryStorage.PendingUpgrade memory p = layout.pendingUpgrades[keys[i]];
            if (p.newAddr == address(0)) continue;
            address oldAddress = layout.modules[keys[i]];
            delete layout.pendingUpgrades[keys[i]];
            emit RegistryEvents.ModuleUpgradeCancelled(keys[i], oldAddress, p.newAddr, msg.sender);
        }
    }

    /**
     * @notice Emergency admin recovers upgrade authority by setting upgradeAdmin = emergencyAdmin.
     * @dev Reverts if:
     *      - msg.sender != emergencyAdmin
     *
     * Security:
     * - Emergency-only path
     */
    function emergencyRecoverUpgrade() external {
        if (msg.sender != _emergencyAdmin) {
            revert Registry__EmergencyAdminNotAuthorized(msg.sender, _emergencyAdmin);
        }
        address oldAdmin = _upgradeAdmin;
        _upgradeAdmin = _emergencyAdmin;
        emit RegistryEvents.UpgradeAdminChanged(oldAdmin, _upgradeAdmin);
        emit RegistryEvents.EmergencyActionExecuted(
            uint8(RegistryEvents.EmergencyAction.EMERGENCY_RECOVERY),
            msg.sender,
            // Block number is emitted for off-chain auditing; not used for business decisions.
            block.number
        );
    }

    // ============ Query helpers ============
    /**
     * @notice Returns pending upgrade information for a module key.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @param key The module key.
     * @return newAddr The pending new module address.
     * @return executeAfter The earliest execution block (block.number).
     * @return hasPendingUpgrade True if a pending upgrade exists.
     */
    function getPendingUpgrade(bytes32 key) external view override returns (
        address newAddr,
        uint256 executeAfter,
        bool hasPendingUpgrade
    ) {
        RegistryStorage.PendingUpgrade memory p = RegistryStorage.layout().pendingUpgrades[key];
        return (p.newAddr, p.executeAfter, p.newAddr != address(0));
    }

    /**
     * @notice Returns whether a pending upgrade is ready to execute for a module key.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     * - Uses block.number for readiness checks by design
     *
     * @param key The module key.
     * @return True if ready.
     */
    function isUpgradeReady(bytes32 key) external view override returns (bool) {
        RegistryStorage.PendingUpgrade memory p = RegistryStorage.layout().pendingUpgrades[key];
        // Timelock readiness check relies on block.number by design.
        return p.newAddr != address(0) && block.number >= p.executeAfter;
    }

    /* ============ Query helpers (tests/compat) ============ */

    /**
     * @notice Returns all known module keys (including those not currently registered).
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only (pure)
     *
     * @return All module keys.
     */
    function getAllModuleKeys() external pure returns (bytes32[] memory) {
        return ModuleKeys.getAllKeys();
    }

    /**
     * @notice Returns all currently registered module keys (compat query).
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @return Registered module keys.
     */
    function getAllRegisteredModuleKeys() external view returns (bytes32[] memory) {
        return RegistryCompatQuery.getAllRegisteredModuleKeys();
    }

    /**
     * @notice Returns all registered module keys and their addresses (compat query).
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @return keys Registered module keys.
     * @return addresses Registered module addresses (aligned with keys).
     */
    function getAllRegisteredModules() external view returns (bytes32[] memory keys, address[] memory addresses) {
        keys = RegistryCompatQuery.getAllRegisteredModuleKeys();
        addresses = new address[](keys.length);
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        for (uint256 i = 0; i < keys.length; i++) {
            addresses[i] = layout.modules[keys[i]];
        }
        return (keys, addresses);
    }

    /**
     * @notice Returns registered module keys using pagination (compat query).
     * @dev Reverts if:
     *      - offset is out of bounds (handled in compat query library)
     *
     * Security:
     * - Read-only
     *
     * @param offset Start index in the registered keys list.
     * @param limit Maximum number of keys to return.
     * @return keys Page of registered keys.
     * @return totalCount Total number of registered keys.
     */
    function getRegisteredModuleKeysPaginated(uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory keys, uint256 totalCount)
    {
        return RegistryCompatQuery.getRegisteredModuleKeysPaginated(offset, limit);
    }

    /**
     * @notice Returns the number of stored upgrade history entries for a module key.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @param key The module key.
     * @return Upgrade history entry count.
     */
    function getUpgradeHistoryCount(bytes32 key) external view returns (uint256) {
        return RegistryStorage.layout().upgradeHistory[key].length;
    }

    /**
     * @notice Returns an upgrade history record by index.
     * @dev Reverts if:
     *      - index is out of bounds
     *
     * Security:
     * - Read-only
     *
     * @param key The module key.
     * @param index The history index (0-based).
     * @return oldAddress Old module address.
     * @return newAddress New module address.
     * @return blockNumber Upgrade block number (block.number).
     * @return executor Upgrade executor address.
     */
    function getUpgradeHistory(bytes32 key, uint256 index) external view returns (
        address oldAddress,
        address newAddress,
        uint256 blockNumber,
        address executor
    ) {
        RegistryStorage.UpgradeHistory[] storage history = RegistryStorage.layout().upgradeHistory[key];
        if (index >= history.length) revert IndexOutOfBounds(index, history.length);
        RegistryStorage.UpgradeHistory storage h = history[index];
        return (h.oldAddress, h.newAddress, h.blockNumber, h.executor);
    }

    /**
     * @notice Returns all upgrade history records for a module key.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @param key The module key.
     * @return Upgrade history records.
     */
    function getAllUpgradeHistory(bytes32 key) external view override returns (IRegistry.UpgradeHistory[] memory) {
        RegistryStorage.UpgradeHistory[] storage history = RegistryStorage.layout().upgradeHistory[key];
        IRegistry.UpgradeHistory[] memory out = new IRegistry.UpgradeHistory[](history.length);
        for (uint256 i = 0; i < history.length; i++) {
            RegistryStorage.UpgradeHistory storage h = history[i];
            out[i] = IRegistry.UpgradeHistory({
                oldAddress: h.oldAddress,
                newAddress: h.newAddress,
                blockNumber: h.blockNumber,
                executor: h.executor
            });
        }
        return out;
    }

    // ============ Utils ============
    /**
     * @notice Sets the minimum delay window for timelocked module upgrades.
     * @dev Reverts if:
     *      - storage version is incompatible (compat gate)
     *      - newDelay > MAX_DELAY()
     *      - newDelay == 0
     *
     * Security:
     * - onlyOwner
     *
     * @param newDelay New delay window (blocks).
     */
    function setMinDelay(uint256 newDelay) external override onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (newDelay > _MAX_DELAY) revert Registry__DelayTooLong(newDelay, _MAX_DELAY);
        if (newDelay == 0) revert Registry__InvalidDelayValue(newDelay);
        uint256 oldDelay = RegistryStorage.layout().minDelay;
        RegistryStorage.layout().minDelay = uint64(newDelay);
        emit RegistryEvents.MinDelayChanged(oldDelay, newDelay);
    }

    /**
     * @notice Executes a storage migration via an external migrator (keeps STORAGE_SLOT).
     * @dev Reverts if:
     *      - migrator == address(0)
     *      - migrator has no code (EOA / empty-code)
     *      - current storage version != fromVersion
     *      - toVersion <= current storage version
     *      - migrator delegatecall fails
     *
     * Security:
     * - onlyOwner
     * - Uses delegatecall to keep fixed STORAGE_SLOT (upgrade-safe migration pattern)
     *
     * Flow:
     * - Validate currentVersion == fromVersion and toVersion is increasing
     * - validateStorageLayout() before migration
     * - delegatecall migrator.migrate(fromVersion,toVersion) (keep slot)
     * - bump storageVersion to toVersion
     * - validateStorageLayout() after migration
     *
     * @param fromVersion Expected current storage version.
     * @param toVersion Target storage version (must be greater than current).
     * @param migrator Migrator contract address.
     * @custom:oz-upgrades-unsafe-allow delegatecall
     */
    function migrateStorage(uint256 fromVersion, uint256 toVersion, address migrator) external override onlyOwner {
        if (migrator == address(0)) revert Registry__ZeroAddress();
        // Safety: forbid delegatecall to EOA / empty-code address.
        if (migrator.code.length == 0) revert Registry__MigratorNotContract(migrator);

        uint256 cur = RegistryStorage.getStorageVersion();
        if (cur != fromVersion) revert Registry__StorageVersionMismatch(fromVersion, cur);
        if (toVersion <= cur) revert Registry__InvalidMigrationTarget(fromVersion, toVersion);

        // Pre-migration validation (ensure critical fields are intact).
        RegistryStorage.validateStorageLayout();

        // Perform migration (data move/init) via delegatecall; keep STORAGE_SLOT unchanged.
        bytes memory data = abi.encodeWithSelector(IRegistryStorageMigrator.migrate.selector, fromVersion, toVersion);
        // delegatecall is required for storage migration with a fixed STORAGE_SLOT.
        (bool ok, bytes memory reason) = migrator.delegatecall(data);
        if (!ok) revert Registry__MigratorFailed(migrator, reason);

        // Bump version and run post-migration validation.
        RegistryStorage.upgradeStorageVersion(toVersion);
        RegistryStorage.validateStorageLayout();

        emit RegistryEvents.StorageMigrated(fromVersion, toVersion, migrator);
    }

    /**
     * @notice Upgrades the storage version marker.
     * @dev Reverts if:
     *      - storage upgrade rules fail in RegistryStorageLibrary
     *
     * Security:
     * - onlyOwner
     *
     * @param newVersion New storage version.
     */
    function upgradeStorageVersion(uint256 newVersion) external override onlyOwner {
        uint256 oldVersion = RegistryStorage.getStorageVersion();
        RegistryStorage.upgradeStorageVersion(newVersion);
        emit RegistryEvents.StorageVersionUpgraded(oldVersion, newVersion);
    }

    /**
     * @notice Validates the current storage layout invariants.
     * @dev Reverts if:
     *      - storage invariants fail (RegistryStorageLibrary)
     *
     * Security:
     * - Read-only
     */
    function validateStorageLayout() external view override {
        RegistryStorage.validateStorageLayout();
    }

    /**
     * @notice Returns the maximum delay window allowed for setMinDelay/initialize.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only (pure)
     *
     * @return Maximum delay window (blocks).
     */
    // Interface requires MAX_DELAY() (legacy UPPER_SNAKE_CASE naming).
    function MAX_DELAY() external pure override returns (uint256) {
        return _MAX_DELAY;
    }

    /**
     * @notice Returns whether an address is an admin (compat check).
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @param addr Address to check.
     * @return True if admin.
     */
    function isAdmin(address addr) external view override returns (bool) {
        return RegistryStorage.isAdmin(addr);
    }

    /**
     * @notice Returns the current storage version marker.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @return Storage version.
     */
    function getStorageVersion() external view override returns (uint256) {
        return RegistryStorage.getStorageVersion();
    }

    /**
     * @notice Returns whether the Registry storage has been initialized.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @return True if initialized.
     */
    function isInitialized() external view override returns (bool) {
        return RegistryStorage.isInitialized();
    }

    // ============ Storage Gap ============
    uint256[50] private __gap;
}
