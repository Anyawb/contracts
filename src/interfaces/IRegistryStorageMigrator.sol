// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Interface for Registry storage migrators that operate on the shared Registry storage slot.
/// @dev A migrator should assume the RegistryStorage.STORAGE_SLOT is unchanged and perform in-place
///      migrations (copy/add/initialize fields) before version bump.
/// @dev Governance is expected to:
///      1) Deploy a migrator contract implementing this interface.
///      2) Call Registry.migrateStorage(fromVersion, toVersion, migrator) via timelock/multisig.
///      3) (Optional) Run post-check scripts off-chain.
interface IRegistryStorageMigrator {
    /// @notice Execute a storage migration in-place.
    /// @param fromVersion Expected current storageVersion before migration.
    /// @param toVersion Target storageVersion after migration.
    /// @dev Implementations should:
    ///      - Validate `fromVersion` matches RegistryStorage.getStorageVersion().
    ///      - Perform data moves / initializations safely.
    ///      - NOT change the storage slot itself.
    ///      - NOT set the storageVersion; Registry will bump after successful migration.
    function migrate(uint256 fromVersion, uint256 toVersion) external;
}


