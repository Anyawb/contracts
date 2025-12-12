// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title EventLibrary
/// @notice 统一的事件定义库
/// @dev 所有合约通过继承或引用使用统一的事件定义
/// @dev 避免重复定义，节省Gas，提高维护性
/// @custom:security-contact security@example.com
library EventLibrary {
    
    // ============ 模块访问事件 ============
    /// @notice 模块访问事件
    /// @param moduleKey 模块键
    /// @param moduleAddress 模块地址
    /// @param caller 调用者地址
    /// @param timestamp 时间戳
    /// @param operationType 操作类型
    /// @param data 操作数据
    event ModuleAccessed(
        bytes32 indexed moduleKey,
        address indexed moduleAddress,
        address indexed caller,
        uint256 timestamp,
        bytes32 operationType,
        bytes data
    );

    // ============ 用户操作事件 ============
    /// @notice 用户操作事件
    /// @param user 用户地址
    /// @param operationType 操作类型
    /// @param asset 资产地址
    /// @param amount 操作金额
    /// @param timestamp 时间戳
    /// @param moduleKey 相关模块
    /// @param additionalData 附加数据
    event UserOperation(
        address indexed user,
        bytes32 indexed operationType,
        address indexed asset,
        uint256 amount,
        uint256 timestamp,
        bytes32 moduleKey,
        bytes additionalData
    );

    // ============ 系统状态变化事件 ============
    /// @notice 系统状态变化事件
    /// @param stateType 状态类型
    /// @param asset 相关资产
    /// @param oldValue 旧值
    /// @param newValue 新值
    /// @param timestamp 时间戳
    /// @param executor 执行者
    event SystemStateChange(
        bytes32 indexed stateType,
        address indexed asset,
        uint256 oldValue,
        uint256 newValue,
        uint256 timestamp,
        address indexed executor
    );

    // ============ 数据查询事件 ============
    /// @notice 数据查询事件
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param queryType 查询类型
    /// @param timestamp 时间戳
    /// @param querier 查询者
    event UserDataQueried(
        address indexed user,
        address indexed asset,
        bytes32 indexed queryType,
        uint256 timestamp,
        address querier
    );

    // ============ 错误和异常事件 ============
    /// @notice 模块调用失败事件
    /// @param moduleKey 模块键
    /// @param reason 失败原因
    /// @param fallbackUsed 是否使用降级方案
    /// @param timestamp 时间戳
    event ModuleCallFailure(
        bytes32 indexed moduleKey,
        string reason,
        bool fallbackUsed,
        uint256 timestamp
    );

    // ============ 权限相关事件 ============
    /// @notice 权限验证事件
    /// @param caller 调用者
    /// @param actionKey 动作键
    /// @param hasPermission 是否有权限
    /// @param timestamp 时间戳
    event PermissionVerified(
        address indexed caller,
        bytes32 indexed actionKey,
        bool hasPermission,
        uint256 timestamp
    );

    // ============ 缓存相关事件（用于迁移期间） ============
    /// @notice 缓存数据访问事件
    /// @param caller 调用者
    /// @param user 用户地址
    /// @param operation 操作类型
    /// @param timestamp 时间戳
    event CacheDataAccess(
        address indexed caller,
        address indexed user,
        string operation,
        uint256 timestamp
    );

    // ============ 操作类型常量 ============
    /// @notice 操作类型常量
    bytes32 constant OPERATION_DEPOSIT = keccak256("DEPOSIT");
    bytes32 constant OPERATION_WITHDRAW = keccak256("WITHDRAW");
    bytes32 constant OPERATION_BORROW = keccak256("BORROW");
    bytes32 constant OPERATION_REPAY = keccak256("REPAY");
    bytes32 constant OPERATION_LIQUIDATE = keccak256("LIQUIDATE");
    bytes32 constant OPERATION_QUERY = keccak256("QUERY");
    bytes32 constant OPERATION_UPDATE = keccak256("UPDATE");
    bytes32 constant OPERATION_DELETE = keccak256("DELETE");

    // ============ 状态类型常量 ============
    /// @notice 状态类型常量
    bytes32 constant STATE_PARAMETER_UPDATE = keccak256("PARAMETER_UPDATE");
    bytes32 constant STATE_ASSET_ADDED = keccak256("ASSET_ADDED");
    bytes32 constant STATE_ASSET_REMOVED = keccak256("ASSET_REMOVED");
    bytes32 constant STATE_MODULE_UPGRADED = keccak256("MODULE_UPGRADED");
    bytes32 constant STATE_SYSTEM_PAUSED = keccak256("SYSTEM_PAUSED");
    bytes32 constant STATE_SYSTEM_RESUMED = keccak256("SYSTEM_RESUMED");

    // ============ 查询类型常量 ============
    /// @notice 查询类型常量
    bytes32 constant QUERY_POSITION = keccak256("POSITION_QUERY");
    bytes32 constant QUERY_HISTORY = keccak256("HISTORY_QUERY");
    bytes32 constant QUERY_SYSTEM_STATUS = keccak256("SYSTEM_STATUS_QUERY");
    bytes32 constant QUERY_RISK_ASSESSMENT = keccak256("RISK_ASSESSMENT_QUERY");
}
