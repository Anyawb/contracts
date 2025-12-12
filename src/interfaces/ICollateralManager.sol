// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ICollateralManager 多资产抵押物管理模块接口
/// @notice 提供存入、提取多资产抵押物及余额查询的统一入口
/// @dev 支持多种 ERC20 资产作为抵押物，每种资产独立记账
interface ICollateralManager {
    /**
     * @notice 向指定用户仓位存入指定资产的抵押物
     * @param user 用户地址
     * @param asset 抵押资产地址
     * @param amount 抵押物数量
     */
    function depositCollateral(address user, address asset, uint256 amount) external;

    /**
     * @notice 从指定用户仓位提取指定资产的抵押物
     * @param user 用户地址
     * @param asset 抵押资产地址
     * @param amount 提取数量
     */
    function withdrawCollateral(address user, address asset, uint256 amount) external;

    /**
     * @notice 查询用户指定资产的当前抵押物数量
     * @param user 用户地址
     * @param asset 抵押资产地址
     * @return balance 抵押物数量
     */
    function getCollateral(address user, address asset) external view returns (uint256 balance);

    /**
     * @notice 查询指定资产的总抵押量
     * @param asset 抵押资产地址
     * @return total 该资产的总抵押量
     */
    function getTotalCollateralByAsset(address asset) external view returns (uint256 total);

    /**
     * @notice 查询用户总抵押物价值（以结算币计价）
     * @param user 用户地址
     * @return totalValue 用户总抵押价值
     */
    function getUserTotalCollateralValue(address user) external view returns (uint256 totalValue);

    /**
     * @notice 查询系统总抵押物价值（以结算币计价）
     * @return totalValue 系统总抵押价值
     */
    function getTotalCollateralValue() external view returns (uint256 totalValue);

    /**
     * @notice 查询用户所有抵押资产列表
     * @param user 用户地址
     * @return assets 用户抵押的资产地址数组
     */
    function getUserCollateralAssets(address user) external view returns (address[] memory assets);

    /**
     * @notice 计算指定数量资产的价值（以结算币计价）
     * @param asset 资产地址
     * @param amount 资产数量
     * @return value 资产价值
     */
    function getAssetValue(address asset, uint256 amount) external view returns (uint256 value);
} 