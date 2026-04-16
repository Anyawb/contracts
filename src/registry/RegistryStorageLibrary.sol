// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {
    ZeroAddress,
    AlreadyInitialized,
    MinDelayOverflow,
    NotInitialized,
    InvalidStorageVersion,
    NotGovernance
} from "../errors/StandardErrors.sol";

/// @title RegistryStorage
/// @notice Diamond-storage layout for the Registry family.
/// @dev Reverts if:
///      - (see individual helpers)
///
/// Security:
/// - Uses a fixed STORAGE_SLOT (diamond storage) to keep state stable across upgrades.
/// - Storage migrations should keep STORAGE_SLOT unchanged and use explicit migrators.
/// - Preferred migration flow keeps STORAGE_SLOT stable and bumps storageVersion after reviewed data migration.
/// - Change STORAGE_SLOT only for destructive resets or full-redeploy semantics.
library RegistryStorage {
    /// @dev Reverts when a compat-gated call observes an unexpected storageVersion. Used by {requireCompatibleVersion}.
    error RegistryStorage__IncompatibleStorageVersion(
        uint256 expected,
        uint256 actual
    );

    /*━━━━━━━━━━━━━━━ Constants ━━━━━━━━━━━━━━━*/
    // NOTE (Time-Dependency-Refactor / Strategy A):
    // - This library intentionally does NOT hardcode "days/seconds" conversions (e.g., `X days / Y seconds`).
    // - Any policy cap for `minDelay` MUST be enforced by the Registry contract via an explicit `maxDelayBlocks`
    //   configuration (deployment/governance), not by embedding a per-block-seconds assumption in Solidity.
    struct Layout {
        /*━━━━━━━━━━━━━━━ Storage Versioning ━━━━━━━━━━━━━━━*/
        uint256 storageVersion; // Storage layout version marker (prevents incompatible upgrades)
        /*━━━━━━━━━━━━━━━ Governance And Admin ━━━━━━━━━━━━━━━*/
        address admin; // Governance/admin address (legacy compat mirror of Ownable owner)
        address pendingAdmin; // Pending admin address (compat; Ownable has no pending-owner concept)
        /*━━━━━━━━━━━━━━━ Timelock Configuration ━━━━━━━━━━━━━━━*/
        uint8 paused; // Emergency pause flag (compat mirror of Pausable)
        uint64 minDelay; // Minimum timelock delay (blocks); stored as uint64 for packing
        // Storage packing notes:
        // - paused(uint8) + minDelay(uint64) share one storage slot (gas-efficient).
        // - Although uint64 supports extremely large values, protocol policy SHOULD cap minDelay in Registry logic.

        /*━━━━━━━━━━━━━━━ Module Mapping ━━━━━━━━━━━━━━━*/
        mapping(bytes32 => address) modules; // moduleKey => moduleAddress
        /*━━━━━━━━━━━━━━━ Timelocked Upgrades ━━━━━━━━━━━━━━━*/
        mapping(bytes32 => PendingUpgrade) pendingUpgrades;
        /*━━━━━━━━━━━━━━━ Upgrade History ━━━━━━━━━━━━━━━*/
        mapping(bytes32 => UpgradeHistory[]) upgradeHistory;
        mapping(bytes32 => uint256) historyIndex;
        // Gas notes:
        // - UpgradeHistory[] is an on-chain ring buffer capped by Registry.sol; writes still cost gas.
        // - If upgrades become extremely frequent, prefer relying on events + off-chain indexing for deep history.

        /*━━━━━━━━━━━━━━━ Signature And Nonce ━━━━━━━━━━━━━━━*/
        mapping(address => uint256) nonces; // signer => nonce (anti-replay)
        // Anti-replay notes:
        // - Current approach is monotonic ++nonce per signer (simple and safe).
        // - A bitmap nonce scheme could enable parallel nonces but increases complexity.

        /*━━━━━━━━━━━━━━━ Storage Gap ━━━━━━━━━━━━━━━*/
        uint256[50] __gap;
    }

    struct PendingUpgrade {
        address newAddr; // Proposed new module address
        uint256 executeAfter; // Earliest execution block (block.number)
        address proposer; // Proposal submitter (for audit attribution)
        uint256 minDelaySnapshot; // Snapshot of minDelay at scheduling time (stability across governance changes)
    }

    struct UpgradeHistory {
        address oldAddress; // Previous address
        address newAddress; // New address
        uint256 blockNumber; // Block number (block.number)
        address executor; // Executor address (caller)
    }

    /*━━━━━━━━━━━━━━━ Storage Slot ━━━━━━━━━━━━━━━*/
    /// @dev Fixed diamond storage slot for the Registry family.
    ///      Do NOT change this slot unless performing a destructive reset.
    bytes32 internal constant STORAGE_SLOT = keccak256("registry.storage.v1");

    /*━━━━━━━━━━━━━━━ Storage Version ━━━━━━━━━━━━━━━*/
    uint256 internal constant CURRENT_STORAGE_VERSION = 1;

    /*━━━━━━━━━━━━━━━ Layout Access ━━━━━━━━━━━━━━━*/
    /// @notice Returns the diamond storage layout pointer.
    /// @dev Returns the shared Registry diamond-storage pointer for the fixed STORAGE_SLOT.
    ///
    /// Security:
    /// - Uses a fixed STORAGE_SLOT for upgrade-safe state sharing.
    ///
    /// @return layout_ Diamond-storage layout pointer for the fixed Registry storage slot.
    function layout() internal pure returns (Layout storage layout_) {
        bytes32 slot = STORAGE_SLOT;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            layout_.slot := slot
        }
    }

    /*━━━━━━━━━━━━━━━ Storage Version Helpers ━━━━━━━━━━━━━━━*/
    /**
     * @notice Requires the Registry storageVersion to match exactly.
     * @dev Reverts if:
     *      - storageVersion != expectedVersion (RegistryStorage__IncompatibleStorageVersion)
     *
     * Security:
     * - Used as a compat gate to prevent calling logic against an incompatible storage layout.
     *
     * @param expectedVersion Expected storage version.
     */
    function requireCompatibleVersion(uint256 expectedVersion) internal view {
        uint256 actual = layout().storageVersion;
        if (actual != expectedVersion) {
            revert RegistryStorage__IncompatibleStorageVersion(
                expectedVersion,
                actual
            );
        }
    }

    /**
     * @notice Initializes the Registry diamond storage layout (single-use).
     * @dev Reverts if:
     *      - admin_ == address(0) (ZeroAddress)
     *      - storageVersion != 0 (AlreadyInitialized)
     *      - minDelay_ > type(uint64).max (MinDelayOverflow)
     *
     * Security:
     * - Intended to run exactly once on the shared STORAGE_SLOT.
     * - Callers should apply any policy cap in Registry before persisting minDelay.
     *
     * @param admin_ Governance/admin address.
     * @param minDelay_ Minimum timelock delay (blocks).
     */
    function initializeRegistryStorage(
        address admin_,
        uint256 minDelay_
    ) internal {
        if (admin_ == address(0)) revert ZeroAddress();
        Layout storage layout_ = layout();
        if (layout_.storageVersion != 0) revert AlreadyInitialized();

        // Prevent uint64 truncation on assignment.
        if (minDelay_ > type(uint64).max) revert MinDelayOverflow(minDelay_);

        layout_.storageVersion = CURRENT_STORAGE_VERSION;
        layout_.admin = admin_;
        layout_.pendingAdmin = address(0);
        layout_.paused = 0; // uint8 0 = false
        layout_.minDelay = uint64(minDelay_);
        // nonces default to 0 (no explicit initialization required)
    }

    /**
     * @notice Initializes only the storageVersion marker (single-use).
     * @dev Reverts if:
     *      - storageVersion != 0 (AlreadyInitialized)
     *
     * Security:
     * - This is used by the current Registry initializer to claim the shared STORAGE_SLOT.
     */
    function initializeStorageVersion() internal {
        if (layout().storageVersion != 0) revert AlreadyInitialized();
        layout().storageVersion = CURRENT_STORAGE_VERSION;
    }

    /**
     * @notice Bumps the storageVersion marker (must be strictly increasing).
     * @dev Reverts if:
     *      - storageVersion == 0 (NotInitialized)
     *      - newVersion <= currentVersion (InvalidStorageVersion)
     *
     * Security:
     * - Should be called only as part of a reviewed migration flow (see Registry.migrateStorage).
     *
     * @param newVersion Target storage version.
     */
    function upgradeStorageVersion(uint256 newVersion) internal {
        uint256 cur = layout().storageVersion;
        if (cur == 0) revert NotInitialized();
        if (newVersion <= cur) revert InvalidStorageVersion(newVersion);
        layout().storageVersion = newVersion;
    }

    /**
     * @notice Returns the current storageVersion marker.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only.
     *
     * @return storageVersion Current storage version marker.
     */
    function getStorageVersion() internal view returns (uint256) {
        return layout().storageVersion;
    }

    /**
     * @notice Returns whether the Registry storage has been initialized.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only.
     *
     * @return initialized True if the Registry storage has been initialized.
     */
    function isInitialized() internal view returns (bool) {
        return layout().storageVersion != 0;
    }

    /*━━━━━━━━━━━━━━━ Admin And Config Getters ━━━━━━━━━━━━━━━*/
    /**
     * @notice Returns the stored governance admin (compat mirror).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only.
     *
     * @return admin Stored governance admin address.
     */
    function getAdmin() internal view returns (address) {
        return layout().admin;
    }

    /**
     * @notice Returns whether the Registry is paused (compat mirror).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only.
     *
     * @return paused_ True if the compatibility pause flag is set.
     */
    function isPaused() internal view returns (bool) {
        return layout().paused != 0;
    }

    /**
     * @notice Returns the current minimum timelock delay.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only.
     *
     * @return minDelay Current minimum timelock delay in blocks.
     */
    function getMinDelay() internal view returns (uint256) {
        return layout().minDelay;
    }

    /**
     * @notice Returns true if addr is non-zero.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure helper.
     *
     * @param addr Address to check.
     * @return isNonZero True if addr != address(0).
     */
    function isNonZeroAddress(address addr) internal pure returns (bool) {
        return addr != address(0);
    }

    /**
     * @notice Returns whether addr equals the stored admin (compat mirror).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only helper.
     *
     * @param addr Address to check.
     * @return isAdmin_ True if addr matches the stored governance admin.
     */
    function isAdmin(address addr) internal view returns (bool) {
        return layout().admin == addr;
    }

    /**
     * @notice Reverts unless addr is the stored admin (compat mirror).
     * @dev Reverts if:
     *      - addr is not admin (NotGovernance)
     *
     * Security:
     * - Read-only check.
     *
     * @param addr Address to validate.
     */
    function requireAdmin(address addr) internal view {
        if (!isAdmin(addr)) revert NotGovernance();
    }

    /**
     * @notice Reverts unless msg.sender is the stored admin (compat mirror).
     * @dev Reverts if:
     *      - msg.sender is not admin (NotGovernance)
     *
     * Security:
     * - Read-only check.
     */
    function requireAdminMsgSender() internal view {
        if (!isAdmin(msg.sender)) revert NotGovernance();
    }

    /**
     * @notice Validates critical storage invariants for the Registry family.
     * @dev Reverts if:
     *      - storageVersion == 0 (NotInitialized)
     *      - admin == address(0) (ZeroAddress)
     *
     * Security:
     * - Used before and after migrations to ensure core invariants remain intact.
     * - This function must remain conservative because new checks can block upgrades or migrations.
     */
    function validateStorageLayout() internal view {
        Layout storage layout_ = layout();
        if (layout_.storageVersion == 0) revert NotInitialized();
        if (layout_.admin == address(0)) revert ZeroAddress();

        // If you want to enforce presence of critical modules, add checks here.
        // Be careful: enabling such checks can break deployment flows where modules are registered later.
    }
}
