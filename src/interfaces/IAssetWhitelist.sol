// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IAssetWhitelist
/// @notice 资产白名单管理接口，用于管理支持的 ERC20 资产
/// @dev 提供资产白名单的查询和管理功能
interface IAssetWhitelist {
    /// @notice 检查指定资产是否在白名单中
    /// @param asset 资产地址
    /// @return allowed 是否允许
    function isAssetAllowed(address asset) external view returns (bool allowed);

    /// @notice 获取所有支持的资产列表
    /// @return assets 支持的资产地址数组
    function getAllowedAssets() external view returns (address[] memory assets);

    /// @notice 添加资产到白名单（仅治理可调用）
    /// @param asset 资产地址
    function addAllowedAsset(address asset) external;

    /// @notice 从白名单移除资产（仅治理可调用）
    /// @param asset 资产地址
    function removeAllowedAsset(address asset) external;

    /// @notice 批量添加资产到白名单（仅治理可调用）
    /// @param assets 资产地址数组
    function batchAddAllowedAssets(address[] calldata assets) external;

    /// @notice 批量从白名单移除资产（仅治理可调用）
    /// @param assets 资产地址数组
    function batchRemoveAllowedAssets(address[] calldata assets) external;
} 