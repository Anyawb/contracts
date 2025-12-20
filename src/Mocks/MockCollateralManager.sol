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
    mapping(address => uint256) private _userTotalValue;
    uint256 private _totalValue;
    
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
        _userTotalValue[user] += amount;
        _totalValue += amount;
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
        _userTotalValue[user] = _userTotalValue[user] > amount ? _userTotalValue[user] - amount : 0;
        _totalValue = _totalValue > amount ? _totalValue - amount : 0;
        emit CollateralWithdrawn(user, asset, amount);
    }
    
    /// @notice 获取用户抵押物数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return 抵押物数量
    function getCollateral(address user, address asset) external view override returns (uint256) {
        if (shouldFail) revert("MockCollateralManager: getCollateral failed");
        return _userCollateral[user][asset];
    }
    
    /// @notice 获取用户总抵押物价值
    /// @param user 用户地址
    /// @return 总抵押物价值
    function getUserTotalCollateralValue(address user) external view override returns (uint256) {
        return _userTotalValue[user];
    }
    
    /// @notice 获取资产总抵押物数量
    /// @param asset 资产地址
    /// @return 总抵押物数量
    function getTotalCollateralByAsset(address asset) external view override returns (uint256) {
        return _totalByAsset[asset];
    }
    
    /// @notice 获取总抵押物价值
    /// @return 总抵押物价值
    function getTotalCollateralValue() external view override returns (uint256) {
        return _totalValue;
    }
    
    /// @notice 获取用户抵押物资产列表
    /// @param _user 用户地址
    /// @return 资产地址数组
    function getUserCollateralAssets(address _user) external pure override returns (address[] memory) {
        // 触发读取以消除未使用参数告警
        _user;
        // 简化实现，返回空数组
        return new address[](0);
    }
    
    /// @notice 获取资产价值
    /// @param _asset 资产地址
    /// @param amount 数量
    /// @return 价值
    function getAssetValue(address _asset, uint256 amount) external pure override returns (uint256) {
        // 触发读取以消除未使用参数告警
        _asset;
        // Mock实现：1:1比例
        return amount;
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
            _userTotalValue[user] = _userTotalValue[user] > seizedAmount ? _userTotalValue[user] - seizedAmount : 0;
            _totalValue = _totalValue > seizedAmount ? _totalValue - seizedAmount : 0;
            
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