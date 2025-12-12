// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IGuaranteeFundManager } from "../interfaces/IGuaranteeFundManager.sol";

/// @title MockGuaranteeFundManager
/// @notice 保证金管理器的Mock实现，用于测试
contract MockGuaranteeFundManager is IGuaranteeFundManager {
    // 用户保证金映射
    mapping(address => mapping(address => uint256)) private _userGuarantees;
    mapping(address => uint256) private _totalByAsset;
    
    // 测试控制标志
    bool public mockSuccess = true;
    
    // 事件
    event GuaranteeLocked(address indexed user, address indexed asset, uint256 amount);
    event GuaranteeReleased(address indexed user, address indexed asset, uint256 amount);
    event GuaranteeForfeited(address indexed user, address indexed asset, uint256 amount, address indexed feeReceiver);
    
    /// @notice 锁定保证金
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 保证金金额
    function lockGuarantee(address user, address asset, uint256 amount) external override {
        if (!mockSuccess) revert("MockGuaranteeFundManager: lock failed");
        _userGuarantees[user][asset] += amount;
        _totalByAsset[asset] += amount;
        emit GuaranteeLocked(user, asset, amount);
    }
    
    /// @notice 释放保证金
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 释放金额
    function releaseGuarantee(address user, address asset, uint256 amount) external override {
        if (!mockSuccess) revert("MockGuaranteeFundManager: release failed");
        require(_userGuarantees[user][asset] >= amount, "Insufficient guarantee");
        _userGuarantees[user][asset] -= amount;
        _totalByAsset[asset] -= amount;
        emit GuaranteeReleased(user, asset, amount);
    }
    
    /// @notice 没收保证金
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param feeReceiver 费用接收者
    function forfeitGuarantee(address user, address asset, address feeReceiver) external override {
        uint256 amount = _userGuarantees[user][asset];
        if (amount > 0) {
            _userGuarantees[user][asset] = 0;
            _totalByAsset[asset] -= amount;
            emit GuaranteeForfeited(user, asset, amount, feeReceiver);
        }
    }
    
    /// @notice 获取锁定保证金数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return 保证金数量
    function getLockedGuarantee(address user, address asset) external view override returns (uint256) {
        return _userGuarantees[user][asset];
    }
    
    /// @notice 获取资产总保证金数量
    /// @param asset 资产地址
    /// @return 总保证金数量
    function getTotalGuaranteeByAsset(address asset) external view override returns (uint256) {
        return _totalByAsset[asset];
    }
    
    /// @notice 获取用户保证金资产列表
    /// @return 资产地址数组
    function getUserGuaranteeAssets(address) external pure override returns (address[] memory) {
        // 简化实现，返回空数组
        // 注意：user参数在此Mock实现中未使用，但保留以符合接口规范
        return new address[](0);
    }
    
    /// @notice 检查保证金是否已支付
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return 是否已支付
    function isGuaranteePaid(address user, address asset) external view override returns (bool) {
        return _userGuarantees[user][asset] > 0;
    }
    
    /// @notice 批量锁定保证金
    /// @param user 用户地址
    /// @param assets 资产地址数组
    /// @param amounts 金额数组
    function batchLockGuarantees(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external override {
        require(assets.length == amounts.length, "Array length mismatch");
        for (uint256 i = 0; i < assets.length; i++) {
            _userGuarantees[user][assets[i]] += amounts[i];
            _totalByAsset[assets[i]] += amounts[i];
            emit GuaranteeLocked(user, assets[i], amounts[i]);
        }
    }
    
    /// @notice 批量释放保证金
    /// @param user 用户地址
    /// @param assets 资产地址数组
    /// @param amounts 金额数组
    function batchReleaseGuarantees(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external override {
        require(assets.length == amounts.length, "Array length mismatch");
        for (uint256 i = 0; i < assets.length; i++) {
            require(_userGuarantees[user][assets[i]] >= amounts[i], "Insufficient guarantee");
            _userGuarantees[user][assets[i]] -= amounts[i];
            _totalByAsset[assets[i]] -= amounts[i];
            emit GuaranteeReleased(user, assets[i], amounts[i]);
        }
    }
    
    /// @notice 获取用户保证金数量（兼容性方法）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return 保证金数量
    function getUserGuarantee(address user, address asset) external view returns (uint256) {
        return _userGuarantees[user][asset];
    }
    
    /// @notice 检查用户是否有足够的保证金
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 所需金额
    /// @return 是否有足够保证金
    function hasSufficientGuarantee(address user, address asset, uint256 amount) external view returns (bool) {
        return _userGuarantees[user][asset] >= amount;
    }

    /// @notice 设置成功标志（测试用）
    /// @param success 是否成功
    function setMockSuccess(bool success) external {
        mockSuccess = success;
    }
}


