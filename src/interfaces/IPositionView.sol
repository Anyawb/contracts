// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IPositionView
/// @notice Minimal PositionView interface used by routing/业务模块
interface IPositionView {
    /// @notice 推送用户仓位（兼容版本，自增 version）
    function pushUserPositionUpdate(address user, address asset, uint256 collateral, uint256 debt) external;

    /// @notice 推送用户仓位（携带幂等/顺序上下文）
    /// @dev requestId/seq 由上游生成；若 requestId 重复则应幂等（不重复写入）
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq
    ) external;

    /// @notice 推送用户仓位（指定 nextVersion）
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        uint64 nextVersion
    ) external;

    /// @notice 推送用户仓位（携带幂等/顺序上下文 + nextVersion）
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external;

    /// @notice 推送用户仓位增量（兼容版本，自增 version）
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta
    ) external;

    /// @notice 推送用户仓位增量（携带幂等/顺序上下文）
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        bytes32 requestId,
        uint64 seq
    ) external;

    /// @notice 推送用户仓位增量（指定 nextVersion）
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        uint64 nextVersion
    ) external;

    /// @notice 推送用户仓位增量（携带幂等/顺序上下文 + nextVersion）
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external;

    /// @notice 读取当前版本号（0 表示未写入）
    function getPositionVersion(address user, address asset) external view returns (uint64);

    /// @notice 读取用户指定资产的仓位（抵押与债务）
    function getUserPosition(address user, address asset) external view returns (uint256 collateral, uint256 debt);
}




