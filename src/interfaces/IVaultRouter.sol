// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IVaultRouter (Slimmed)
/// @notice 协调器接口，仅负责事件路由与业务模块数据推送
/// @dev 所有只读查询接口已移至各独立 View 模块（UserView / SystemView / AccessControlView / ViewCache）
interface IVaultRouter {
    /* ============ Core Routing ============ */
    /// @notice 处理用户操作（事件驱动 + 路由）
    /// @param user          用户地址
    /// @param operationType 操作类型（参见 ActionKeys）
    /// @param asset         资产地址
    /// @param amount        操作金额
    /// @param timestamp     操作时间戳
    function processUserOperation(
        address user,
        bytes32 operationType,
        address asset,
        uint256 amount,
        uint256 timestamp
    ) external;

    /* ============ Data Push from Business Modules ============ */
    /// @notice 业务模块推送用户位置更新（兼容版本，不带上下文）
    /// @dev 兼容旧接口；requestId/seq 将在路由层填充为 0
    function pushUserPositionUpdate(address user, address asset, uint256 collateral, uint256 debt) external;

    /// @notice 业务模块推送用户位置更新（携带上下文，用于幂等/排序）
    /// @param requestId 上游生成的请求ID（可为0表示未提供）
    /// @param seq       上游生成的序列号（可为0表示未提供）
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq
    ) external;

    /// @notice 业务模块推送用户位置更新（携带 nextVersion）
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        uint64 nextVersion
    ) external;

    /// @notice 业务模块推送用户位置更新（携带上下文 + nextVersion）
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external;

    /// @notice 业务模块推送用户位置增量更新（兼容版本，不带上下文）
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta
    ) external;

    /// @notice 业务模块推送用户位置增量更新（携带上下文，用于幂等/排序）
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        bytes32 requestId,
        uint64 seq
    ) external;

    /// @notice 业务模块推送用户位置增量更新（携带 nextVersion）
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        uint64 nextVersion
    ) external;

    /// @notice 业务模块推送用户位置增量更新（携带上下文 + nextVersion）
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external;

    // 已移除：健康因子推送接口由 HealthView 承担

    /// @notice 统计模块推送资产聚合数据（兼容版本，不带上下文）
    function pushAssetStatsUpdate(address asset, uint256 totalCollateral, uint256 totalDebt, uint256 price) external;

    /// @notice 统计模块推送资产聚合数据（携带上下文，用于幂等/排序）
    function pushAssetStatsUpdate(
        address asset,
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 price,
        bytes32 requestId,
        uint64 seq
    ) external;
}


