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
     * @notice 统一的抵押出池入口：提现/清算均使用同一语义（扣减账本 + 真实转账到 receiver）
     * @dev 当 receiver == user 时表示用户提现语义，应仅允许 VaultRouter 调用（由实现合约强制）
     * @param user 被扣减抵押的用户
     * @param asset 抵押资产地址
     * @param amount 扣减数量
     * @param receiver 接收真实 ERC20 的地址（用户提现=用户自身；清算扣押=清算人/接收者）
     */
    function withdrawCollateralTo(address user, address asset, uint256 amount, address receiver) external;

    /**
     * @notice 清算扣押：从被清算用户的抵押仓位扣减，并将对应抵押资产从资金池直接转给清算人
     * @dev 方案A：CollateralManager 作为抵押资金池（真实 ERC20 托管者），该函数必须在链上完成真实转账
     * @param targetUser 被清算用户地址
     * @param collateralAsset 抵押资产地址
     * @param collateralAmount 扣押数量
     * @param liquidator 清算人地址（接收抵押资产）
     */
    function seizeCollateralForLiquidation(
        address targetUser,
        address collateralAsset,
        uint256 collateralAmount,
        address liquidator
    ) external;

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
     * @notice 查询用户所有抵押资产列表
     * @param user 用户地址
     * @return assets 用户抵押的资产地址数组
     */
    function getUserCollateralAssets(address user) external view returns (address[] memory assets);

} 