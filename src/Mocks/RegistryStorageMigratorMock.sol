// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IRegistryStorageMigrator } from "../interfaces/IRegistryStorageMigrator.sol";
import { RegistryStorage } from "../registry/RegistryStorageLibrary.sol";

/// @notice Stateless migrator for testing Registry.migrateStorage via delegatecall (fixed STORAGE_SLOT).
/// @dev Uses only RegistryStorage layout; no contract storage is touched (immutable is code-only).
contract RegistryStorageMigratorMock is IRegistryStorageMigrator {
    address public immutable pendingAdminToSet;

    event MigrationRan(address adminBefore, address pendingAdminAfter);

    constructor(address pendingAdminAfter) {
        pendingAdminToSet = pendingAdminAfter;
    }

    /// @inheritdoc IRegistryStorageMigrator
    function migrate(uint256 fromVersion, uint256 /* toVersion */) external override {
        // Ensures the caller passed the expected storage version.
        RegistryStorage.requireCompatibleVersion(fromVersion);

        RegistryStorage.Layout storage l = RegistryStorage.layout();
        address adminBefore = l.admin;

        // Example data mutation during migration: set pendingAdmin.
        l.pendingAdmin = pendingAdminToSet;

        emit MigrationRan(adminBefore, pendingAdminToSet);
        // storageVersion bump is done by Registry after successful migration.
    }
}

/// @notice Reverting migrator used to test failure handling.
contract RegistryStorageMigratorReverter is IRegistryStorageMigrator {
    error MockMigrationFailed();

    function migrate(uint256 /* fromVersion */, uint256 /* toVersion */) external pure override {
        revert MockMigrationFailed();
    }
}

/// @notice Migrator that tries to maliciously modify storageVersion; Registry should override after call.
/// @dev Sets version to a value between fromVersion and toVersion to test that Registry enforces toVersion.
contract RegistryStorageMigratorVersionBump is IRegistryStorageMigrator {
    function migrate(uint256 fromVersion, uint256 toVersion) external override {
        // Try to set version to an intermediate value (fromVersion + 1 if possible, else toVersion - 1)
        // Registry should override this and set it to toVersion
        uint256 intermediateVersion = toVersion > fromVersion + 1 ? fromVersion + 1 : toVersion - 1;
        if (intermediateVersion > fromVersion) {
            RegistryStorage.upgradeStorageVersion(intermediateVersion);
        }
    }
}

/// @notice Migrator that maliciously tries to overwrite admin/pendingAdmin to a zero/attacker value.
contract RegistryStorageMigratorAdminWiper is IRegistryStorageMigrator {
    function migrate(uint256 /* fromVersion */, uint256 /* toVersion */) external override {
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        l.admin = address(0);
        l.pendingAdmin = address(0);
    }
}

/// @notice Migrator that attempts to modify ERC1967 implementation slot (should have no effect on proxy).
contract RegistryStorageMigratorImplementationHijack is IRegistryStorageMigrator {
    // EIP-1967 implementation slot: bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1)
    bytes32 internal constant IMPLEMENTATION_SLOT = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);

    function migrate(uint256 /* fromVersion */, uint256 /* toVersion */) external override {
        bytes32 slot = IMPLEMENTATION_SLOT;
        address fakeImpl = address(0xBEEF);
        assembly {
            sstore(slot, fakeImpl)
        }
    }
}

/// @notice Migrator that performs an external call during migration (to test side-effects).
contract RegistryStorageMigratorExternalCall is IRegistryStorageMigrator {
    function migrate(uint256 /* fromVersion */, uint256 /* toVersion */) external override {
        // Emit via an external mock (delegatecall context uses Registry's msg.sender)
        (bool ok, ) = msg.sender.call(abi.encodeWithSignature("fallback()"));
        ok; // silence warning
    }
}

/// @notice Migrator that attempts reentrancy into Registry.migrateStorage (should fail on guards/logic).
contract RegistryStorageMigratorReentrant is IRegistryStorageMigrator {
    address public registry;
    constructor(address registry_) {
        registry = registry_;
    }
    function migrate(uint256 fromVersion, uint256 toVersion) external override {
        // Attempt reentrancy; should fail due to onlyOwner/version checks
        (bool ok, ) = registry.call(abi.encodeWithSignature("migrateStorage(uint256,uint256,address)", fromVersion, toVersion, address(this)));
        ok; // silence warning
    }
}

