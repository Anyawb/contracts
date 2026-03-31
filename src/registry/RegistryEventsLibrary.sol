// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title RegistryEvents
 * @notice Canonical event definitions for the Registry system.
 * @dev Reverts if:
 *      - (none)
 *
 * Security:
 * - This is an event-only library; it does not read or write state
 * - Events are emitted by Registry entrypoints and related modules
 */
library RegistryEvents {
    /*━━━━━━━━━━━━━━━ ENUMS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Emergency action type enum.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Off-chain consumers should treat this as an enum-to-uint8 mapping.
     * - If adding a new action, update all related event docs/consumers.
     */
    enum EmergencyAction {
        PAUSE, // 0: Pause the system
        UNPAUSE, // 1: Unpause the system
        EMERGENCY_UPGRADE, // 2: Emergency upgrade action
        EMERGENCY_RECOVERY, // 3: Emergency recovery action
        EMERGENCY_WITHDRAW // 4: Emergency withdraw action
    }

    /*━━━━━━━━━━━━━━━ INITIALIZATION EVENTS ━━━━━━━━━━━━━━━*/

    /// @notice Emitted when the Registry is initialized.
    /// @dev Emitted by {Registry.initialize} after owner, delay, and upgrade-admin state are configured.
    event RegistryInitialized(
        address indexed admin,
        uint256 minDelay,
        address indexed initializer
    );

    /*━━━━━━━━━━━━━━━ STORAGE MANAGEMENT EVENTS ━━━━━━━━━━━━━━━*/

    /// @notice Emitted when the Registry storage version marker changes.
    /// @dev Emitted by storage-version management paths after a successful version bump.
    event StorageVersionUpgraded(uint256 oldVersion, uint256 newVersion);

    /// @notice Emitted when a storage migration completes.
    /// @dev Emitted by {Registry.migrateStorage} after delegatecall migration
    ///      succeeds and the storageVersion is updated.
    event StorageMigrated(
        uint256 fromVersion,
        uint256 toVersion,
        address indexed migrator
    );

    /*━━━━━━━━━━━━━━━ GOVERNANCE EVENTS ━━━━━━━━━━━━━━━*/

    /// @notice Emitted when the governance admin changes.
    /// @dev Emitted by ownership or compat-admin flows that synchronize Registry governance state.
    event AdminChanged(address indexed oldAdmin, address indexed newAdmin);

    /// @notice Emitted when the pending admin changes.
    /// @dev Emitted by compatibility admin-management flows whenever pendingAdmin is set or cleared.
    event PendingAdminChanged(
        address indexed oldPendingAdmin,
        address indexed newPendingAdmin
    );

    /// @notice Emitted when the UUPS upgrade admin changes.
    /// @dev Emitted by upgrade-authority management or emergency recovery flows.
    event UpgradeAdminChanged(
        address indexed oldAdmin,
        address indexed newAdmin
    );

    /// @notice Emitted when the emergency admin changes.
    /// @dev Emitted by emergency-authority management flows after the configured responder account is updated.
    event EmergencyAdminChanged(
        address indexed oldAdmin,
        address indexed newAdmin
    );

    /*━━━━━━━━━━━━━━━ MODULE MANAGEMENT EVENTS ━━━━━━━━━━━━━━━*/

    /// @notice Emitted when a module address is changed directly.
    /// @dev Emitted by direct Registry write paths that set a module without the timelock scheduling flow.
    event ModuleChanged(
        bytes32 indexed key,
        address indexed oldAddress,
        address indexed newAddress
    );

    /// @notice Emitted when a timelocked module upgrade is scheduled.
    /// @dev Emitted by {Registry.scheduleModuleUpgrade} with the current
    ///      module address, proposed target, and executeAfter block.
    event ModuleUpgradeScheduled(
        bytes32 indexed key,
        address indexed oldAddress,
        address indexed newAddress,
        uint256 executeAfter,
        address proposer
    );

    /// @notice Emitted when a scheduled module upgrade is executed.
    /// @dev Emitted by {Registry.executeModuleUpgrade} after the timelock has elapsed and storage is updated.
    event ModuleUpgraded(
        bytes32 indexed key,
        address indexed oldAddress,
        address indexed newAddress,
        address executor
    );

    /// @notice Emitted when a scheduled module upgrade is cancelled.
    /// @dev Emitted by governance or emergency cancellation paths after the pending-upgrade entry is cleared.
    event ModuleUpgradeCancelled(
        bytes32 indexed key,
        address indexed oldAddress,
        address indexed newAddress,
        address canceller
    );

    /// @notice Emitted when multiple module addresses are changed in one operation.
    /// @dev Emitted by batch Registry write paths, with aligned arrays
    ///      preserving old and new addresses for off-chain attribution.
    event BatchModuleChanged(
        bytes32[] keys,
        address[] oldAddresses,
        address[] newAddresses,
        address executor
    );

    /// @notice Emitted when a cached module address is refreshed.
    /// @dev Emitted by cache-maintenance logic when a module-address cache entry is updated or cleared.
    event ModuleCacheUpdated(
        bytes32 indexed key,
        address indexed oldAddress,
        address indexed newAddress
    );

    /*━━━━━━━━━━━━━━━ EMERGENCY ACTION EVENTS ━━━━━━━━━━━━━━━*/

    /// @notice Emitted when an emergency action is executed.
    /// @dev Emitted by authority-gated emergency paths, with action encoded as the uint8 value of {EmergencyAction}.
    event EmergencyActionExecuted(
        uint8 indexed action,
        address indexed executor,
        uint256 blockNumber
    );

    /*━━━━━━━━━━━━━━━ CONFIGURATION CHANGE EVENTS ━━━━━━━━━━━━━━━*/

    /// @notice Emitted when the minimum timelock delay changes.
    /// @dev Emitted by governance-controlled delay configuration flows after the stored minDelay is updated.
    event MinDelayChanged(uint256 oldDelay, uint256 newDelay);

    /*━━━━━━━━━━━━━━━ OPTIONAL INTEGRATION EVENTS ━━━━━━━━━━━━━━━*/

    /// @notice Emitted when the dynamic module key registry integration changes.
    /// @dev Emitted by {Registry.setDynamicModuleKeyRegistry} after the
    ///      optional integration address is updated or cleared.
    event DynamicModuleKeyRegistryChanged(
        address indexed oldAddress,
        address indexed newAddress,
        address executor
    );

    /*━━━━━━━━━━━━━━━ DYNAMIC MODULE KEY REGISTRY EVENTS ━━━━━━━━━━━━━━━*/

    /// @notice Emitted when a dynamic module key is registered.
    /// @dev Emitted by {RegistryDynamicModuleKey.registerModuleKey} and
    ///      batch registration flows after name normalization and key
    ///      derivation succeed.
    event ModuleKeyRegistered(
        bytes32 indexed moduleKey,
        bytes32 indexed nameHash,
        address indexed registrant
    );

    /// @notice Emitted when a dynamic module key is unregistered.
    /// @dev Emitted by {RegistryDynamicModuleKey.unregisterModuleKey} after
    ///      the key, name, and list membership are removed.
    event ModuleKeyUnregistered(
        bytes32 indexed moduleKey,
        string name,
        address indexed unregistrant
    );

    /// @notice Emitted when the registration admin changes.
    /// @dev Emitted by dynamic-module-key admin-management flows after the registrationAdmin address is updated.
    event RegistrationAdminChanged(
        address indexed oldAdmin,
        address indexed newAdmin
    );

    /// @notice Emitted when the system admin changes.
    /// @dev Emitted by dynamic-module-key admin-management flows after the systemAdmin address is updated.
    event SystemAdminChanged(
        address indexed oldAdmin,
        address indexed newAdmin
    );
}
