// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title EventLibrary
/// @notice Shared event definitions and constants.
/// @dev Contracts can reference these events to avoid duplication.
/// @dev Reduces gas and improves maintainability by centralizing event signatures.
/// @custom:security-contact security@example.com
library EventLibrary {
    
    /*━━━━━━━━━━━━━━━ Module Access Events ━━━━━━━━━━━━━━━*/
    /// @notice Emitted when a module is accessed.
    /// @param moduleKey Module key.
    /// @param moduleAddress Module address.
    /// @param caller Caller address.
    /// @param blockNumber Block number (implementation-defined).
    /// @param operationType Operation type.
    /// @param data Operation data.
    event ModuleAccessed(
        bytes32 indexed moduleKey,
        address indexed moduleAddress,
        address indexed caller,
        uint256 blockNumber,
        bytes32 operationType,
        bytes data
    );

    /*━━━━━━━━━━━━━━━ User Operation Events ━━━━━━━━━━━━━━━*/
    /// @notice Emitted for user operations.
    /// @param user User address.
    /// @param operationType Operation type.
    /// @param asset Asset address.
    /// @param amount Amount.
    /// @param blockNumber Block number (implementation-defined).
    /// @param moduleKey Related module key.
    /// @param additionalData Additional data.
    event UserOperation(
        address indexed user,
        bytes32 indexed operationType,
        address indexed asset,
        uint256 amount,
        uint256 blockNumber,
        bytes32 moduleKey,
        bytes additionalData
    );

    /*━━━━━━━━━━━━━━━ System State Events ━━━━━━━━━━━━━━━*/
    /// @notice Emitted when system state changes.
    /// @param stateType State type.
    /// @param asset Related asset.
    /// @param oldValue Previous value.
    /// @param newValue New value.
    /// @param blockNumber Block number (implementation-defined).
    /// @param executor Executor address.
    event SystemStateChange(
        bytes32 indexed stateType,
        address indexed asset,
        uint256 oldValue,
        uint256 newValue,
        uint256 blockNumber,
        address indexed executor
    );

    /*━━━━━━━━━━━━━━━ Query Events ━━━━━━━━━━━━━━━*/
    /// @notice Emitted when user data is queried.
    /// @param user User address.
    /// @param asset Asset address.
    /// @param queryType Query type.
    /// @param blockNumber Block number (implementation-defined).
    /// @param querier Querier address.
    event UserDataQueried(
        address indexed user,
        address indexed asset,
        bytes32 indexed queryType,
        uint256 blockNumber,
        address querier
    );

    /*━━━━━━━━━━━━━━━ Error Events ━━━━━━━━━━━━━━━*/
    /// @notice Emitted when a module call fails.
    /// @param moduleKey Module key.
    /// @param reason Failure reason.
    /// @param fallbackUsed Whether fallback was used.
    /// @param blockNumber Block number (implementation-defined).
    event ModuleCallFailure(
        bytes32 indexed moduleKey,
        string reason,
        bool fallbackUsed,
        uint256 blockNumber
    );

    /*━━━━━━━━━━━━━━━ Permission Events ━━━━━━━━━━━━━━━*/
    /// @notice Emitted when permission is verified.
    /// @param caller Caller address.
    /// @param actionKey Action key.
    /// @param hasPermission Whether permission is granted.
    /// @param blockNumber Block number (implementation-defined).
    event PermissionVerified(
        address indexed caller,
        bytes32 indexed actionKey,
        bool hasPermission,
        uint256 blockNumber
    );

    /*━━━━━━━━━━━━━━━ Cache Events (Migration) ━━━━━━━━━━━━━━━*/
    /// @notice Emitted on cache data access.
    /// @param caller Caller address.
    /// @param user User address.
    /// @param operation Operation label.
    /// @param blockNumber Block number (implementation-defined).
    event CacheDataAccess(
        address indexed caller,
        address indexed user,
        string operation,
        uint256 blockNumber
    );

    /*━━━━━━━━━━━━━━━ Operation Type Constants ━━━━━━━━━━━━━━━*/
    /// @notice Operation type constants.
    bytes32 constant OPERATION_DEPOSIT = keccak256("DEPOSIT");
    bytes32 constant OPERATION_WITHDRAW = keccak256("WITHDRAW");
    bytes32 constant OPERATION_BORROW = keccak256("BORROW");
    bytes32 constant OPERATION_REPAY = keccak256("REPAY");
    bytes32 constant OPERATION_LIQUIDATE = keccak256("LIQUIDATE");
    bytes32 constant OPERATION_QUERY = keccak256("QUERY");
    bytes32 constant OPERATION_UPDATE = keccak256("UPDATE");
    bytes32 constant OPERATION_DELETE = keccak256("DELETE");

    /*━━━━━━━━━━━━━━━ State Type Constants ━━━━━━━━━━━━━━━*/
    /// @notice State type constants.
    bytes32 constant STATE_PARAMETER_UPDATE = keccak256("PARAMETER_UPDATE");
    bytes32 constant STATE_ASSET_ADDED = keccak256("ASSET_ADDED");
    bytes32 constant STATE_ASSET_REMOVED = keccak256("ASSET_REMOVED");
    bytes32 constant STATE_MODULE_UPGRADED = keccak256("MODULE_UPGRADED");
    bytes32 constant STATE_SYSTEM_PAUSED = keccak256("SYSTEM_PAUSED");
    bytes32 constant STATE_SYSTEM_RESUMED = keccak256("SYSTEM_RESUMED");

    /*━━━━━━━━━━━━━━━ Query Type Constants ━━━━━━━━━━━━━━━*/
    /// @notice Query type constants.
    bytes32 constant QUERY_POSITION = keccak256("POSITION_QUERY");
    bytes32 constant QUERY_HISTORY = keccak256("HISTORY_QUERY");
    bytes32 constant QUERY_SYSTEM_STATUS = keccak256("SYSTEM_STATUS_QUERY");
    bytes32 constant QUERY_RISK_ASSESSMENT = keccak256("RISK_ASSESSMENT_QUERY");
}
