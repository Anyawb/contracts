// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IVaultRouter } from "../interfaces/IVaultRouter.sol";

/// @title MockVaultRouter
/// @notice 供测试使用的VaultRouter模拟合约
contract MockVaultRouter is IVaultRouter {
    // 用户位置映射
    mapping(address => mapping(address => uint256)) private _userCollateral;
    mapping(address => mapping(address => uint256)) private _userDebt;
    
    // 事件
    event UserPositionUpdated(address indexed user, address indexed asset, uint256 collateral, uint256 debt);
    event UserOperationProcessed(address indexed user, bytes32 operation, address indexed asset, uint256 amount, uint256 timestamp);
    event CollateralSeized(address indexed user, address indexed asset, uint256 amount, address indexed liquidator);
    event DebtReduced(address indexed user, address indexed asset, uint256 amount, address indexed liquidator);
    
    /// @notice 处理用户操作（模拟IVaultRouter接口）
    function processUserOperation(
        address user,
        bytes32 operationType,
        address asset,
        uint256 amount,
        uint256 timestamp
    ) external override {
        // 根据操作类型更新用户位置
        if (operationType == keccak256(abi.encodePacked("DEPOSIT"))) {
            _userCollateral[user][asset] += amount;
        } else if (operationType == keccak256(abi.encodePacked("BORROW"))) {
            _userDebt[user][asset] += amount;
        } else if (operationType == keccak256(abi.encodePacked("REPAY"))) {
            if (_userDebt[user][asset] >= amount) {
                _userDebt[user][asset] -= amount;
            }
        } else if (operationType == keccak256(abi.encodePacked("WITHDRAW"))) {
            if (_userCollateral[user][asset] >= amount) {
                _userCollateral[user][asset] -= amount;
            }
        }
        
        emit UserOperationProcessed(user, operationType, asset, amount, timestamp);
    }
    
    /// @notice 推送用户位置更新（严格版本：携带上下文 + nextVersion）
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external override {
        requestId; seq; nextVersion; // mock: ignore context/version
        require(user != address(0), "MockVaultRouter: user is zero");
        require(asset != address(0), "MockVaultRouter: asset is zero");
        _userCollateral[user][asset] = collateral;
        _userDebt[user][asset] = debt;

        emit UserPositionUpdated(user, asset, collateral, debt);
    }

    /// @notice 推送用户位置增量更新（严格版本：携带上下文 + nextVersion）
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external override {
        requestId; seq; nextVersion; // mock: ignore context/version
        _applyDeltaUpdate(user, asset, collateralDelta, debtDelta);
    }

    function _applyDelta(uint256 base, int256 delta) internal pure returns (uint256) {
        if (delta >= 0) {
            return base + uint256(delta);
        }
        uint256 absDelta = uint256(-delta);
        require(base >= absDelta, "MockVaultRouter: delta underflow");
        return base - absDelta;
    }

    function _applyDeltaUpdate(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta
    ) internal {
        _userCollateral[user][asset] = _applyDelta(_userCollateral[user][asset], collateralDelta);
        _userDebt[user][asset] = _applyDelta(_userDebt[user][asset], debtDelta);
        emit UserPositionUpdated(user, asset, _userCollateral[user][asset], _userDebt[user][asset]);
    }

    /// @notice 推送资产统计更新（严格版本：带上下文）
    function pushAssetStatsUpdate(
        address asset,
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 price,
        bytes32 requestId,
        uint64 seq
    ) external pure override {
        asset; totalCollateral; totalDebt; price; requestId; seq;
    }

    /// @notice 转发扣押抵押物操作
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 扣押数量
    /// @param liquidator 清算人地址
    function forwardSeizeCollateral(
        address user,
        address asset,
        uint256 amount,
        address liquidator
    ) external {
        if (_userCollateral[user][asset] >= amount) {
            _userCollateral[user][asset] -= amount;
        }
        
        emit CollateralSeized(user, asset, amount, liquidator);
    }

    /// @notice 转发减少债务操作
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 减少数量
    /// @param liquidator 清算人地址
    function forwardReduceDebt(
        address user,
        address asset,
        uint256 amount,
        address liquidator
    ) external {
        if (_userDebt[user][asset] >= amount) {
            _userDebt[user][asset] -= amount;
        }
        
        emit DebtReduced(user, asset, amount, liquidator);
    }
    
    /// @notice 获取用户抵押物数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return 抵押物数量
    function getUserCollateral(address user, address asset) external view returns (uint256) {
        return _userCollateral[user][asset];
    }
    
    /// @notice 获取用户债务数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return 债务数量
    function getUserDebt(address user, address asset) external view returns (uint256) {
        return _userDebt[user][asset];
    }
}


