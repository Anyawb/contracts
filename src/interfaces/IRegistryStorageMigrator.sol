// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IRegistryStorageMigrator
 * @notice Interface for Registry storage migrators operating on the shared Registry storage slot.
 * @dev Reverts if:
 *      - the implementation rejects the provided version transition
 *      - the implementation detects an invalid storage layout or migration precondition
 *
 * Security:
 * - Governance-only operational surface intended for timelocked or multisig-controlled upgrades.
 * - Implementations must preserve the Registry storage slot and perform only in-place data migrations.
 * - Expected flow:
 *   1. Deploy a migrator that implements this interface.
 *   2. Call `Registry.migrateStorage(fromVersion, toVersion, migrator)` via governance.
 *   3. Run post-migration validation off-chain when applicable.
 */
interface IRegistryStorageMigrator {
    /**
     * @notice Executes an in-place storage migration for Registry state.
     * @dev Reverts if:
     *      - `fromVersion` does not match the current storage version
     *      - the migration cannot be completed safely under implementation checks
     *
     * Security:
     * - Must not change the shared storage slot identifier.
     * - Must not bump `storageVersion`; the Registry performs that step after a successful migration.
     *
     * @param fromVersion Expected current storage version before migration.
     * @param toVersion Target storage version after migration.
     */
    function migrate(uint256 fromVersion, uint256 toVersion) external;
}
