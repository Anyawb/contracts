// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IVaultView (Slimmed)
/// @notice 协调器接口，仅负责事件路由与业务模块数据推送
/// @dev 所有只读查询接口已移至各独立 View 模块（UserView / SystemView / AccessControlView / ViewCache）
interface IVaultView {
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
    /// @notice 业务模块推送用户位置更新
    function pushUserPositionUpdate(address user, address asset, uint256 collateral, uint256 debt) external;

    // 已移除：健康因子推送接口由 HealthView 承担

    /// @notice 统计模块推送资产聚合数据
    function pushAssetStatsUpdate(address asset, uint256 totalCollateral, uint256 totalDebt, uint256 price) external;
} 