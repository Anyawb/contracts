// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title SystemEvents
/// @notice Protocol-wide standardized events (single source of truth for cross-module events).
/// @dev Architecture-Guide alignment:
///      - Prefer module-local events + DataPush for business flows.
///      - Keep only truly shared, cross-module events here to avoid duplication.
library SystemEvents {
    /* ============ Events ============ */

    /// @notice Emitted when a module address is updated in the Registry.
    /// @dev Related action key: ActionKeys.ACTION_UPGRADE_MODULE.
    /// @param moduleName Module name (human-readable).
    /// @param oldModuleAddr Previous module address.
    /// @param newModuleAddr New module address.
    /// @param timestamp Block timestamp when the update is recorded.
    event ModuleAddressUpdated(
        string indexed moduleName,
        address oldModuleAddr,
        address newModuleAddr,
        uint256 timestamp
    );

    // ---------- Action & Governance Events ----------
    /// @notice Emitted when an ActionKeys-governed operation is executed.
    /// @dev Designed for uniform off-chain indexing across modules.
    /// @param actionKey Action key (see ActionKeys constants).
    /// @param actionName Human-readable action name (e.g. ActionKeys.getActionKeyString(actionKey)).
    /// @param executor Executor address.
    /// @param timestamp Block timestamp when the action is recorded.
    event ActionExecuted(
        bytes32 indexed actionKey,
        string actionName,
        address indexed executor,
        uint256 timestamp
    );

    // ---------- External Module & Error Events ----------
    /// @notice Emitted when a best-effort external module call reverts.
    /// @param moduleName Module name (human-readable).
    /// @param revertData Raw revert data returned by the call.
    /// @param timestamp Block timestamp when the failure is recorded.
    event ExternalModuleReverted(string moduleName, bytes revertData, uint256 timestamp);
}

