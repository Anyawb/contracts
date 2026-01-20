// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ICollateralManager } from "../interfaces/ICollateralManager.sol";

interface IPositionViewPush {
    function pushUserPositionUpdate(address user, address asset, uint256 collateral, uint256 debt) external;
}

/// @title MockCollateralManager
/// @notice 抵押物管理器的Mock实现，用于测试
contract MockCollateralManager is ICollateralManager {
    // 用户抵押物映射
    mapping(address => mapping(address => uint256)) private _userCollateral;
    mapping(address => uint256) private _totalByAsset;
    mapping(address => address[]) private _userAssets;
    
    // 测试控制标志
    bool public shouldFail;
    
    // 事件
    event CollateralDeposited(address indexed user, address indexed asset, uint256 amount);
    event CollateralWithdrawn(address indexed user, address indexed asset, uint256 amount);
    
    /// @notice 存入抵押物
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 存入金额
    function depositCollateral(address user, address asset, uint256 amount) external override {
        if (shouldFail) revert("MockCollateralManager: deposit failed");
        _userCollateral[user][asset] += amount;
        _totalByAsset[asset] += amount;
        _addAsset(user, asset);
        emit CollateralDeposited(user, asset, amount);
    }
    
    /// @notice 提取抵押物
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 提取金额
    function withdrawCollateral(address user, address asset, uint256 amount) external override {
        if (shouldFail) revert("MockCollateralManager: withdraw failed");
        require(_userCollateral[user][asset] >= amount, "Insufficient collateral");
        _userCollateral[user][asset] -= amount;
        _totalByAsset[asset] -= amount;
        emit CollateralWithdrawn(user, asset, amount);
    }

    function withdrawCollateralTo(address user, address asset, uint256 amount, address receiver) external override {
        receiver; // mock: ignore receiver (no real ERC20 transfer)
        if (shouldFail) revert("MockCollateralManager: withdraw failed");
        require(_userCollateral[user][asset] >= amount, "Insufficient collateral");
        _userCollateral[user][asset] -= amount;
        _totalByAsset[asset] -= amount;
        emit CollateralWithdrawn(user, asset, amount);
    }

    /// @notice 清算扣押（方案A接口）
    /// @dev Mock 只做账本扣减与事件记录，不做真实 ERC20 转账
    function seizeCollateralForLiquidation(
        address targetUser,
        address collateralAsset,
        uint256 collateralAmount,
        address liquidator
    ) external override {
        if (shouldFail) revert("MockCollateralManager: seize failed");
        require(_userCollateral[targetUser][collateralAsset] >= collateralAmount, "Insufficient collateral");
        _userCollateral[targetUser][collateralAsset] -= collateralAmount;
        _totalByAsset[collateralAsset] -= collateralAmount;
        emit CollateralSeized(liquidator, targetUser, collateralAsset, collateralAmount, block.timestamp);
    }
    
    /// @notice 获取用户抵押物数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return 抵押物数量
    function getCollateral(address user, address asset) external view override returns (uint256) {
        if (shouldFail) revert("MockCollateralManager: getCollateral failed");
        return _userCollateral[user][asset];
    }
    
    /// @notice 获取资产总抵押物数量
    /// @param asset 资产地址
    /// @return 总抵押物数量
    function getTotalCollateralByAsset(address asset) external view override returns (uint256) {
        return _totalByAsset[asset];
    }
    
    /// @notice 测试辅助：直接设置资产总抵押
    function setTotalCollateralByAsset(address asset, uint256 amount) external {
        _totalByAsset[asset] = amount;
    }
    
    /// @notice 获取用户抵押物资产列表
    /// @param _user 用户地址
    /// @return 资产地址数组
    function getUserCollateralAssets(address _user) external view override returns (address[] memory) {
        return _userAssets[_user];
    }
    
    /// @notice 获取用户抵押物数量（兼容性方法）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return 抵押物数量
    function getUserCollateral(address user, address asset) external view returns (uint256) {
        return _userCollateral[user][asset];
    }
    
    /// @notice 检查用户是否有足够的抵押物
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 所需金额
    /// @return 是否有足够的抵押物
    function hasSufficientCollateral(address user, address asset, uint256 amount) external view returns (bool) {
        return _userCollateral[user][asset] >= amount;
    }

    /// @notice 扣押用户抵押物（清算时使用）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 扣押金额
    /// @param liquidator 清算人地址
    /// @return seizedAmount 实际扣押金额
    function seizeCollateral(address user, address asset, uint256 amount, address liquidator) external returns (uint256 seizedAmount) {
        require(user != address(0), "Invalid user address");
        require(asset != address(0), "Invalid asset address");
        require(amount > 0, "Invalid amount");
        require(liquidator != address(0), "Invalid liquidator address");
        
        uint256 availableCollateral = _userCollateral[user][asset];
        seizedAmount = amount > availableCollateral ? availableCollateral : amount;
        
        if (seizedAmount > 0) {
            _userCollateral[user][asset] -= seizedAmount;
            _totalByAsset[asset] -= seizedAmount;
            
            // 发出扣押事件
            emit CollateralSeized(liquidator, user, asset, seizedAmount, block.timestamp);
        }
        
        return seizedAmount;
    }

    /// @notice 获取用户可扣押的抵押物数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return seizableAmount 可扣押数量
    function getSeizableCollateralAmount(address user, address asset) external view returns (uint256 seizableAmount) {
        return _userCollateral[user][asset];
    }

    /// @notice 测试辅助：直接设置用户抵押
    function setUserCollateral(address user, address asset, uint256 amount) external {
        _userCollateral[user][asset] = amount;
        _totalByAsset[asset] = amount;
        _addAsset(user, asset);
    }

    function _addAsset(address user, address asset) private {
        address[] storage assets = _userAssets[user];
        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i] == asset) {
                return;
            }
        }
        assets.push(asset);
    }

    // 事件
    event CollateralSeized(
        address indexed liquidator,
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 timestamp
    );

    /// @notice 设置失败标志（测试用）
    /// @param fail 是否失败
    function setShouldFail(bool fail) external {
        shouldFail = fail;
    }

    /// @notice 测试辅助：以本合约身份调用 PositionView 推送缓存
    function pushToPositionView(address positionView, address user, address asset, uint256 collateral, uint256 debt) external {
        IPositionViewPush(positionView).pushUserPositionUpdate(user, asset, collateral, debt);
    }
}