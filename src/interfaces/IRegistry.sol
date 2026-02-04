// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IRegistry
 * @notice External interface for the Registry (canonical module-address registry entrypoint).
 * @dev Reverts if:
 *      - (see the implementation for exact revert conditions)
 *
 * Security:
 * - This interface describes a privileged governance module (writes are owner/admin gated).
 * - Events are emitted via the canonical `RegistryEvents` library (see `RegistryEventsLibrary.sol`).
 * - Reverts use custom errors and/or `StandardErrors` in the implementation (no string reverts).
 */
interface IRegistry {

    /*━━━━━━━━━━━━━━━ Structs ━━━━━━━━━━━━━━━*/
    /**
     * @notice Module upgrade history record.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Returned from view methods; values are for off-chain attribution/auditing.
     */
    struct UpgradeHistory {
        /// @notice Previous module address.
        address oldAddress;
        /// @notice New module address.
        address newAddress;
        /// @notice Upgrade block number (block.number time axis).
        uint256 blockNumber;
        /// @notice Upgrade executor address.
        address executor;
    }

    /*━━━━━━━━━━━━━━━ View Functions ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Returns the module address for a module key (zero if unset).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only.
     *
     * @param key Module key (bytes32; see ModuleKeys).
     * @return moduleAddress Module address (zero if unset).
     */
    function getModule(bytes32 key) external view returns (address moduleAddress);
    
    /**
     * @notice Returns the module address for a module key, reverting if unset.
     * @dev Reverts if:
     *      - module is not registered for key (ModuleNotRegistered)
     *
     * Security:
     * - Read-only.
     *
     * @param key Module key (bytes32; see ModuleKeys).
     * @return moduleAddress Module address.
     */
    function getModuleOrRevert(bytes32 key) external view returns (address moduleAddress);

    /**
     * @notice Returns whether a module key is registered (non-zero address).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only.
     *
     * @param key Module key (bytes32).
     * @return registered True if registered.
     */
    function isModuleRegistered(bytes32 key) external view returns (bool registered);
    
    /**
     * @notice Returns the current minimum timelock delay window.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only.
     *
     * @return minDelaySeconds Delay window (blocks; block.number time axis).
     */
    function minDelay() external view returns (uint256 minDelaySeconds);
    
    /**
     * @notice Returns the maximum allowed delay window.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only (pure in the implementation).
     *
     * @return maxDelaySeconds Maximum delay window (blocks; block.number time axis).
     */
    function MAX_DELAY() external view returns (uint256 maxDelaySeconds);

    /**
     * @notice Returns the governance admin address (owner).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only.
     *
     * @return admin Governance admin address.
     */
    function getAdmin() external view returns (address admin);

    /**
     * @notice Returns the pending admin address (compat governance handover).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only.
     *
     * @return pendingAdmin Pending admin address (zero if none).
     */
    function getPendingAdmin() external view returns (address pendingAdmin);

    /**
     * @notice Returns whether the Registry is paused.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only.
     *
     * @return paused True if paused.
     */
    function isPaused() external view returns (bool paused);

    /**
     * @notice Returns whether an address is the governance admin (owner) under compat rules.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only.
     *
     * @param addr Address to check.
     * @return isAdmin_ True if admin.
     */
    function isAdmin(address addr) external view returns (bool isAdmin_);

    /**
     * @notice Returns the current Registry storageVersion marker.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only.
     *
     * @return storageVersion Storage version marker.
     */
    function getStorageVersion() external view returns (uint256 storageVersion);

    /**
     * @notice Returns whether the Registry storage has been initialized.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only.
     *
     * @return initialized True if initialized.
     */
    function isInitialized() external view returns (bool initialized);

    /**
     * @notice Returns the owner (governance) address.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only.
     *
     * @return owner_ Owner address.
     */
    function owner() external view returns (address owner_);

    /*━━━━━━━━━━━━━━━ Admin Functions ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Sets a module address for a module key.
     * @dev Reverts if:
     *      - caller is not owner (onlyOwner)
     *      - Registry is paused
     *      - moduleAddr == address(0)
     *      - storage layout/version is incompatible (compat gate in implementation)
     *      - module already exists and replacement is not allowed (implementation-defined)
     *
     * Security:
     * - onlyOwner
     * - whenNotPaused
     *
     * @param key Module key (bytes32).
     * @param moduleAddr Module contract address.
     */
    function setModule(bytes32 key, address moduleAddr) external;
    
    /**
     * @notice Sets a module address and returns whether it changed.
     * @dev Reverts if:
     *      - caller is not owner (onlyOwner)
     *      - Registry is paused
     *      - moduleAddr == address(0)
     *      - storage layout/version is incompatible (compat gate in implementation)
     *
     * Security:
     * - onlyOwner
     * - whenNotPaused
     *
     * @param key Module key (bytes32).
     * @param moduleAddr Module contract address.
     * @return changed True if the stored address changed.
     */
    function setModuleWithStatus(bytes32 key, address moduleAddr) external returns (bool changed);

    /**
     * @notice Batch sets module addresses.
     * @dev Reverts if:
     *      - caller is not owner (onlyOwner)
     *      - Registry is paused
     *      - keys.length != addresses.length
     *      - keys.length exceeds implementation batch cap
     *      - any module address is zero
     *      - storage layout/version is incompatible (compat gate in implementation)
     *
     * Security:
     * - onlyOwner
     * - whenNotPaused
     *
     * @param keys Module keys array.
     * @param addresses Module addresses array.
     */
    function setModules(bytes32[] calldata keys, address[] calldata addresses) external;

    /**
     * @notice Batch sets module addresses and returns which keys changed.
     * @dev Reverts if:
     *      - caller is not owner (onlyOwner)
     *      - Registry is paused
     *      - keys.length != addresses.length
     *      - keys.length exceeds implementation batch cap
     *      - any module address is zero
     *      - storage layout/version is incompatible (compat gate in implementation)
     *
     * Security:
     * - onlyOwner
     * - whenNotPaused
     *
     * @param keys Module keys array.
     * @param addresses Module addresses array.
     * @return changedCount Number of keys that changed.
     * @return changedKeys Keys that changed (implementation-defined population convention).
     */
    function setModulesWithStatus(bytes32[] calldata keys, address[] calldata addresses) external 
        returns (uint256 changedCount, bytes32[] memory changedKeys);

    /**
     * @notice Batch sets module addresses with event emission controls (compat).
     * @dev Reverts if:
     *      - caller is not owner (onlyOwner)
     *      - Registry is paused
     *      - keys.length != addresses.length
     *      - keys.length exceeds implementation batch cap
     *      - any module address is zero
     *      - storage layout/version is incompatible (compat gate in implementation)
     *
     * Security:
     * - onlyOwner
     * - whenNotPaused
     *
     * @param keys Module keys array.
     * @param addresses Module addresses array.
     * @param emitIndividualEvents Whether to emit per-key ModuleChanged events in addition to the batch event.
     */
    function setModulesWithEvents(
        bytes32[] calldata keys,
        address[] calldata addresses,
        bool emitIndividualEvents
    ) external;

    /**
     * @notice Upgrades the Registry storageVersion marker (must be strictly increasing).
     * @dev Reverts if:
     *      - caller is not owner (onlyOwner)
     *      - Registry storage is not initialized
     *      - newVersion <= currentVersion
     *
     * Security:
     * - onlyOwner
     *
     * @param newVersion Target storage version.
     */
    function upgradeStorageVersion(uint256 newVersion) external;
    
    /**
     * @notice Executes a fixed STORAGE_SLOT migration via an external migrator contract.
     * @dev Reverts if:
     *      - caller is not owner (onlyOwner)
     *      - migrator == address(0)
     *      - migrator is not a deployed contract
     *      - currentVersion != fromVersion
     *      - toVersion is not strictly increasing vs current
     *      - migrator execution reverts (wrapped)
     *
     * Security:
     * - onlyOwner
     * - Delegatecall to migrator is high privilege; migrator MUST be reviewed/audited.
     *
     * @param fromVersion Expected current storage version.
     * @param toVersion Target storage version.
     * @param migrator Migrator contract address.
     */
    function migrateStorage(uint256 fromVersion, uint256 toVersion, address migrator) external;

    /**
     * @notice Pauses the Registry (disables whenNotPaused write paths).
     * @dev Reverts if:
     *      - caller is not authorized (owner or emergencyAdmin in implementation)
     *      - storage layout/version is incompatible (compat gate in implementation)
     *
     * Security:
     * - Emergency action (owner/emergency admin gated in implementation)
     */
    function pause() external;

    /**
     * @notice Unpauses the Registry (re-enables whenNotPaused write paths).
     * @dev Reverts if:
     *      - caller is not owner (onlyOwner in implementation)
     *      - storage layout/version is incompatible (compat gate in implementation)
     *
     * Security:
     * - onlyOwner
     */
    function unpause() external;

    /**
     * @notice Sets the pending admin (compat governance handover).
     * @dev Reverts if:
     *      - caller is not owner (onlyOwner)
     *      - storage layout/version is incompatible (compat gate)
     *
     * Security:
     * - onlyOwner
     *
     * @param newPendingAdmin Pending admin address (can be zero to clear).
     */
    function setPendingAdmin(address newPendingAdmin) external;

    /**
     * @notice Accepts governance admin rights (compat governance handover).
     * @dev Reverts if:
     *      - caller is not the pending admin
     *      - pending admin is invalid (zero)
     *      - storage layout/version is incompatible (compat gate)
     *
     * Security:
     * - One-step takeover by the configured pending admin.
     */
    function acceptAdmin() external;
    
    /**
     * @notice Schedules a timelocked module upgrade for a module key.
     * @dev Reverts if:
     *      - caller is not owner (onlyOwner)
     *      - Registry is paused
     *      - newAddr == address(0)
     *      - storage layout/version is incompatible (compat gate)
     *
     * Security:
     * - onlyOwner
     * - whenNotPaused
     *
     * @param key Module key.
     * @param newAddr Proposed new module address.
     */
    function scheduleModuleUpgrade(bytes32 key, address newAddr) external;
    
    /**
     * @notice Cancels a scheduled module upgrade.
     * @dev Reverts if:
     *      - Registry is paused
     *      - caller is not authorized (owner or emergencyAdmin in implementation)
     *      - no pending upgrade exists for key
     *      - storage layout/version is incompatible (compat gate)
     *
     * Security:
     * - whenNotPaused
     * - Emergency-capable (owner/emergency admin in implementation)
     *
     * @param key Module key.
     */
    function cancelModuleUpgrade(bytes32 key) external;
    
    /**
     * @notice Executes a scheduled module upgrade after the delay window has elapsed.
     * @dev Reverts if:
     *      - caller is not owner (onlyOwner)
     *      - Registry is paused
     *      - no pending upgrade exists for key
     *      - upgrade is not ready (block.number < executeAfter)
     *      - storage layout/version is incompatible (compat gate)
     *
     * Security:
     * - onlyOwner
     * - whenNotPaused
     *
     * @param key Module key.
     */
    function executeModuleUpgrade(bytes32 key) external;
    
    /**
     * @notice Sets the minimum timelock delay window.
     * @dev Reverts if:
     *      - caller is not owner (onlyOwner)
     *      - newDelay exceeds implementation max delay
     *      - storage layout/version is incompatible (compat gate)
     *
     * Security:
     * - onlyOwner
     *
     * @param newDelay New delay window (blocks).
     */
    function setMinDelay(uint256 newDelay) external;
    
    /**
     * @notice Transfers ownership (governance) to a new address.
     * @dev Reverts if:
     *      - caller is not owner (onlyOwner)
     *      - newOwner == address(0)
     *      - storage layout/version is incompatible (compat gate)
     *
     * Security:
     * - onlyOwner
     *
     * @param newOwner New owner address.
     */
    function transferOwnership(address newOwner) external;

    /**
     * @notice Validates the Registry storage layout integrity.
     * @dev Reverts if:
     *      - storage layout is invalid/inconsistent (implementation-defined)
     *
     * Security:
     * - Read-only.
     */
    function validateStorageLayout() external view;

    /**
     * @notice Returns all stored upgrade history entries for a module key.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only.
     *
     * @param key Module key.
     * @return history Upgrade history array.
     */
    function getAllUpgradeHistory(bytes32 key) external view returns (UpgradeHistory[] memory history);

    /*━━━━━━━━━━━━━━━ Upgrade Authority (UUPS) ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Sets the upgrade admin address (UUPS authority).
     * @dev Reverts if:
     *      - caller is not owner (onlyOwner)
     *      - newAdmin is invalid (e.g., zero address)
     *
     * Security:
     * - onlyOwner
     *
     * @param newAdmin New upgrade admin address.
     */
    function setUpgradeAdmin(address newAdmin) external;
    
    /**
     * @notice Sets the emergency admin address.
     * @dev Reverts if:
     *      - caller is not owner (onlyOwner)
     *      - newAdmin == address(0)
     *
     * Security:
     * - onlyOwner
     *
     * @param newAdmin New emergency admin address.
     */
    function setEmergencyAdmin(address newAdmin) external;
    
    /**
     * @notice Returns the upgrade admin address.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only.
     *
     * @return upgradeAdmin Upgrade admin address.
     */
    function getUpgradeAdmin() external view returns (address upgradeAdmin);
    
    /**
     * @notice Returns the emergency admin address.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only.
     *
     * @return emergencyAdmin Emergency admin address.
     */
    function getEmergencyAdmin() external view returns (address emergencyAdmin);
    
    /*━━━━━━━━━━━━━━━ Upgrade Query Helpers ━━━━━━━━━━━━━━━*/

    /**
     * @notice Returns pending upgrade info for a module key.
     * @dev Reverts if:
     *      - (none) (returns hasPendingUpgrade=false if none)
     *
     * Security:
     * - Read-only.
     *
     * @param key Module key.
     * @return newAddr Proposed new module address.
     * @return executeAfter Earliest execution block (block.number).
     * @return hasPendingUpgrade True if a pending upgrade exists.
     */
    function getPendingUpgrade(bytes32 key) external view returns (
        address newAddr,
        uint256 executeAfter,
        bool hasPendingUpgrade
    );
    
    /**
     * @notice Returns whether a pending upgrade is ready to execute for a module key.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only.
     * - Uses block.number for readiness checks by design (timelock mechanism).
     *
     * @param key Module key.
     * @return ready True if ready.
     */
    function isUpgradeReady(bytes32 key) external view returns (bool ready);
    
    /**
     * @notice Returns the number of stored upgrade history entries for a module key.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only.
     *
     * @param key Module key.
     * @return count Upgrade history entry count.
     */
    function getUpgradeHistoryCount(bytes32 key) external view returns (uint256 count);
    
    /**
     * @notice Returns an upgrade history record by index.
     * @dev Reverts if:
     *      - index is out of bounds
     *
     * Security:
     * - Read-only.
     *
     * @param key Module key.
     * @param index History index (0-based).
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
    );
    
    /**
     * @notice Sets a module address with an explicit allowReplace flag.
     * @dev Reverts if:
     *      - caller is not owner (onlyOwner)
     *      - Registry is paused
     *      - moduleAddr == address(0)
     *      - allowReplace == false and a different module is already set
     *      - storage layout/version is incompatible (compat gate)
     *
     * Security:
     * - onlyOwner
     * - whenNotPaused
     *
     * @param key Module key.
     * @param moduleAddr Module address.
     * @param allowReplace Whether to allow replacing an existing module address.
     */
    function setModuleWithReplaceFlag(bytes32 key, address moduleAddr, bool allowReplace) external;
} 