// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title SystemEvents
 * @notice Protocol-wide standardized events used for cross-module indexing.
 * @dev Reverts if: (never)
 *
 * Security:
 * - Library-only event namespace: declares shared events and performs no state changes.
 * - Prefer module-local events for business flows; keep only truly shared events here to avoid duplication.
 */
library SystemEvents {
    /*━━━━━━━━━━━━━━━ REGISTRY EVENTS ━━━━━━━━━━━━━━━*/

    /// @notice Emitted when a module address is updated in the Registry.
    /// @dev Event only. `moduleName` is a human-readable label for off-chain indexing and is not a Registry key.
    /// @param moduleName Human-readable module name.
    /// @param oldModuleAddr Previous module address.
    /// @param newModuleAddr New module address.
    /// @param blockNumber On-chain block marker, typically `block.number` at emit time.
    event ModuleAddressUpdated(
        string indexed moduleName,
        address oldModuleAddr,
        address newModuleAddr,
        uint256 blockNumber
    );

    /*━━━━━━━━━━━━━━━ ACTION & GOVERNANCE EVENTS ━━━━━━━━━━━━━━━*/
    /// @notice Emitted when an ActionKeys-governed operation is executed.
    /// @dev Event only. `actionName` is optional, and emitters may pass an empty string to reduce gas.
    /// @param actionKey The action key defined in `ActionKeys`.
    /// @param actionName Human-readable label. May be empty.
    /// @param executor Executor address.
    /// @param blockNumber On-chain block marker, typically `block.number` at emit time.
    event ActionExecuted(
        bytes32 indexed actionKey,
        string actionName,
        address indexed executor,
        uint256 blockNumber
    );

    /*━━━━━━━━━━━━━━━ BEST-EFFORT EXTERNAL CALL EVENTS ━━━━━━━━━━━━━━━*/
    /// @notice Emitted when a best-effort external module call reverts.
    /// @dev Event only. Intended for try/catch call sites that swallow reverts but still record diagnostics.
    /// @param moduleName Human-readable module name.
    /// @param revertData Raw revert data returned by the failed call. May be empty.
    /// @param blockNumber On-chain block marker, typically `block.number` at emit time.
    event ExternalModuleReverted(
        string moduleName,
        bytes revertData,
        uint256 blockNumber
    );
}
