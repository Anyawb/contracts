// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title SystemEvents
/// @notice Protocol-wide standardized events (SSOT for cross-module indexing).
/// @dev Architecture alignment:
///      - Prefer module-local events for business flows.
///      - Keep only truly shared, cross-module events here to avoid duplication.
library SystemEvents {
    /*━━━━━━━━━━━━━━━ Registry events ━━━━━━━━━━━━━━━*/

    /// @notice Emitted when a module address is updated in the Registry.
    /// @dev
    /// - Expected to be emitted by the Registry when updating module wiring.
    /// - `moduleName` is a human-readable label intended for off-chain indexing; it is not a key.
    /// - Time-Dependency-Refactor: `blockNumber` is treated as an onchain time axis marker (preferred: `block.number`).
    ///
    /// Related permission: typically gated by `ActionKeys.ACTION_UPGRADE_MODULE` in governance flows.
    ///
    /// @param moduleName Human-readable module name.
    /// @param oldModuleAddr Previous module address.
    /// @param newModuleAddr New module address.
    /// @param blockNumber Onchain blockNumber marker (recommended: block.number at emit time).
    event ModuleAddressUpdated(
        string indexed moduleName,
        address oldModuleAddr,
        address newModuleAddr,
        uint256 blockNumber
    );

    /*━━━━━━━━━━━━━━━ Action & governance events ━━━━━━━━━━━━━━━*/
    /// @notice Emitted when an ActionKeys-governed operation is executed.
    /// @dev
    /// - Designed for uniform off-chain indexing across modules and governance entrypoints.
    /// - `actionName` is optional; emitters MAY pass an empty string to reduce gas.
    /// - Time-Dependency-Refactor: `blockNumber` is treated as an onchain time axis marker (preferred: `block.number`).
    ///
    /// @param actionKey The action key (see `ActionKeys` constants).
    /// @param actionName A human-readable label (optional; may be empty).
    /// @param executor The executor address.
    /// @param blockNumber Onchain blockNumber marker (recommended: block.number at emit time).
    event ActionExecuted(
        bytes32 indexed actionKey,
        string actionName,
        address indexed executor,
        uint256 blockNumber
    );

    /*━━━━━━━━━━━━━━━ Best-effort external call events ━━━━━━━━━━━━━━━*/
    /// @notice Emitted when a best-effort external module call reverts.
    /// @dev
    /// - Intended for try/catch call sites that swallow reverts but still record diagnostics.
    /// - `revertData` is the raw returndata from the failed call; it may be empty.
    /// - Time-Dependency-Refactor: `blockNumber` is treated as an onchain time axis marker (preferred: `block.number`).
    ///
    /// @param moduleName Human-readable module name.
    /// @param revertData Raw revert data returned by the call.
    /// @param blockNumber Onchain blockNumber marker (recommended: block.number at emit time).
    event ExternalModuleReverted(
        string moduleName,
        bytes revertData,
        uint256 blockNumber
    );
}

