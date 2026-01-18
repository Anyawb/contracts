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
    // ============ Enums ============
    
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
        PAUSE,              // 0: Pause the system
        UNPAUSE,            // 1: Unpause the system
        EMERGENCY_UPGRADE,  // 2: Emergency upgrade action
        EMERGENCY_RECOVERY, // 3: Emergency recovery action
        EMERGENCY_WITHDRAW  // 4: Emergency withdraw action
    }

    // ============ Initialization events ============
    
    /**
     * @notice Emitted when the Registry is initialized.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Emitted by the Registry initializer path.
     *
     * @param admin Governance/admin address configured at initialization.
     * @param minDelay Minimum upgrade delay window (seconds).
     * @param initializer Initializer caller address (e.g., deployer/EOA/contract).
     */
    event RegistryInitialized(
        address indexed admin,
        uint256 minDelay,
        address indexed initializer
    );

    // ============ Storage management events ============
    
    /**
     * @notice Emitted when the Registry storage version is upgraded.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Emitted by storage layout/version management logic.
     *
     * @param oldVersion Previous storage version identifier.
     * @param newVersion New storage version identifier.
     */
    event StorageVersionUpgraded(uint256 oldVersion, uint256 newVersion);
    
    /**
     * @notice Emitted when a storage migration is executed (fixed STORAGE_SLOT layout migration).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Emitted by migration logic after successful migrator execution.
     *
     * @param fromVersion Source storage version identifier.
     * @param toVersion Target storage version identifier.
     * @param migrator Migrator contract address used for the migration.
     */
    event StorageMigrated(uint256 fromVersion, uint256 toVersion, address indexed migrator);

    // ============ Governance events ============
    
    /**
     * @notice Emitted when the governance admin address changes.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Emitted by governance ownership/admin update logic.
     *
     * @param oldAdmin Previous governance admin address.
     * @param newAdmin New governance admin address.
     */
    event AdminChanged(
        address indexed oldAdmin, 
        address indexed newAdmin
    );

    /**
     * @notice Emitted when the pending admin address changes.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Emitted by governance/pending-admin management logic.
     *
     * @param oldPendingAdmin Previous pending admin address.
     * @param newPendingAdmin New pending admin address.
     */
    event PendingAdminChanged(address indexed oldPendingAdmin, address indexed newPendingAdmin);

    /**
     * @notice Emitted when the upgrade admin address changes.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Emitted by upgrade-authority management logic.
     *
     * @param oldAdmin Previous upgrade admin address.
     * @param newAdmin New upgrade admin address.
     */
    event UpgradeAdminChanged(
        address indexed oldAdmin, 
        address indexed newAdmin
    );

    /**
     * @notice Emitted when the emergency admin address changes.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Emitted by emergency-authority management logic.
     *
     * @param oldAdmin Previous emergency admin address.
     * @param newAdmin New emergency admin address.
     */
    event EmergencyAdminChanged(
        address indexed oldAdmin, 
        address indexed newAdmin
    );

    // ============ Module management events ============
    
    /**
     * @notice Emitted when a module address is set directly (no timelock upgrade flow).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Emitted by direct module write entrypoints (e.g., governance write).
     *
     * @param key Module key (bytes32; see ModuleKeys).
     * @param oldAddress Previous module address (may be zero if unset).
     * @param newAddress New module address (non-zero).
     */
    event ModuleChanged(
        bytes32 indexed key, 
        address indexed oldAddress, 
        address indexed newAddress
    );

    /**
     * @notice Emitted when a module upgrade is scheduled (timelocked upgrade flow).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Scheduling relies on block.timestamp by design (timelock mechanism).
     *
     * @param key Module key (bytes32; see ModuleKeys).
     * @param oldAddress Current module address at scheduling time.
     * @param newAddress Proposed new module address.
     * @param executeAfter Earliest execution time (unix timestamp, seconds).
     * @param proposer Proposal submitter address.
     */
    event ModuleUpgradeScheduled(
        bytes32 indexed key, 
        address indexed oldAddress, 
        address indexed newAddress, 
        uint256 executeAfter,
        address proposer
    );

    /**
     * @notice Emitted when a scheduled module upgrade is executed.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Emitted by the timelocked execution path after delay requirements are met.
     *
     * @param key Module key (bytes32; see ModuleKeys).
     * @param oldAddress Previous module address (pre-upgrade).
     * @param newAddress New module address (post-upgrade).
     * @param executor Caller/executor address.
     */
    event ModuleUpgraded(
        bytes32 indexed key, 
        address indexed oldAddress, 
        address indexed newAddress,
        address executor
    );

    /**
     * @notice Emitted when a scheduled module upgrade is cancelled.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Emitted by cancellation logic (e.g., governance/emergency paths).
     *
     * @param key Module key (bytes32; see ModuleKeys).
     * @param oldAddress Module address at scheduling time.
     * @param newAddress Proposed module address at scheduling time.
     * @param canceller Caller/canceller address.
     */
    event ModuleUpgradeCancelled(
        bytes32 indexed key, 
        address indexed oldAddress, 
        address indexed newAddress,
        address canceller
    );

    /**
     * @notice Emitted when module addresses are changed in batch (no timelock upgrade flow).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Large arrays increase gas and may approach block gas limits; callers should cap sizes.
     *
     * @param keys Module keys array (bytes32[]; see ModuleKeys).
     * @param oldAddresses Previous module addresses array (same length as keys).
     * @param newAddresses New module addresses array (same length as keys).
     * @param executor Caller/executor address (for off-chain attribution).
     */
    event BatchModuleChanged(
        bytes32[] keys,
        address[] oldAddresses,
        address[] newAddresses,
        address executor
    );

    /**
     * @notice Emitted when a module-address cache entry is refreshed/updated.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Emitted by cache-refresh logic (typically CacheMaintenanceManager-gated).
     *
     * @param key Module key (bytes32; see ModuleKeys).
     * @param oldAddress Previous cached module address (may be zero).
     * @param newAddress New cached module address (may be zero if cleared/disabled).
     */
    event ModuleCacheUpdated(
        bytes32 indexed key,
        address indexed oldAddress,
        address indexed newAddress
    );

    // ============ Emergency action events ============
    
    /**
     * @notice Emitted when an emergency action is executed.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Emergency actions must be authority-gated by the emitting contract.
     *
     * @param action Emergency action enum value encoded as uint8:
     *        - 0: PAUSE
     *        - 1: UNPAUSE
     *        - 2: EMERGENCY_UPGRADE
     *        - 3: EMERGENCY_RECOVERY
     *        - 4: EMERGENCY_WITHDRAW
     * @param executor Caller/executor address.
     * @param timestamp Action timestamp (unix timestamp, seconds).
     */
    event EmergencyActionExecuted(
        uint8 indexed action, 
        address indexed executor,
        uint256 timestamp
    );

    // ============ Configuration change events ============
    
    /**
     * @notice Emitted when the minimum delay window changes.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Delay window changes should be governance-gated by the emitting contract.
     *
     * @param oldDelay Previous delay window (seconds).
     * @param newDelay New delay window (seconds).
     */
    event MinDelayChanged(
        uint256 oldDelay, 
        uint256 newDelay
    );

    // ============ Optional integrations events ============

    /**
     * @notice Emitted when the dynamic module key registry integration address changes.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Emitted by governance-only config setter (Registry.setDynamicModuleKeyRegistry)
     *
     * @param oldAddress Previous integration address (may be zero).
     * @param newAddress New integration address (may be zero to disable).
     * @param executor Caller/executor address.
     */
    event DynamicModuleKeyRegistryChanged(
        address indexed oldAddress,
        address indexed newAddress,
        address executor
    );

    // ============ Dynamic module key registry events ============

    /**
     * @notice Emitted when a new dynamic module key is registered.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Emitted by the dynamic module key registry (RegistryDynamicModuleKey).
     *
     * @param moduleKey The registered module key.
     * @param nameHash The keccak256 hash of the normalized name.
     * @param registrant The caller that performed the registration.
     */
    event ModuleKeyRegistered(bytes32 indexed moduleKey, bytes32 indexed nameHash, address indexed registrant);

    /**
     * @notice Emitted when a dynamic module key is unregistered.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Emitted by the dynamic module key registry (RegistryDynamicModuleKey).
     *
     * @param moduleKey The unregistered module key.
     * @param name The normalized name associated with the key.
     * @param unregistrant The caller that performed the unregistration.
     */
    event ModuleKeyUnregistered(bytes32 indexed moduleKey, string name, address indexed unregistrant);

    /**
     * @notice Emitted when the registration admin is updated.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Emitted by the dynamic module key registry (RegistryDynamicModuleKey).
     *
     * @param oldAdmin Previous registration admin address.
     * @param newAdmin New registration admin address.
     */
    event RegistrationAdminChanged(address indexed oldAdmin, address indexed newAdmin);

    /**
     * @notice Emitted when the system admin is updated.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Emitted by the dynamic module key registry (RegistryDynamicModuleKey).
     *
     * @param oldAdmin Previous system admin address.
     * @param newAdmin New system admin address.
     */
    event SystemAdminChanged(address indexed oldAdmin, address indexed newAdmin);

}