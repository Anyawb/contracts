// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IPriceOracle 价格预言机接口
/// @notice 提供多资产价格查询服务，支持 Coingecko API 集成
/// @dev 设计遵循 docs/SmartContractStandard.md 中的命名及错误规范
interface IPriceOracle {
    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/
    
    error PriceOracle__AssetAlreadySupported();
    error PriceOracle__AssetNotSupported();
    error PriceOracle__StalePrice();
    error PriceOracle__InvalidPrice();
    error PriceOracle__Unauthorized();

    /*━━━━━━━━━━━━━━━ STRUCTS ━━━━━━━━━━━━━━━*/

    /// @notice 价格数据结构
    struct PriceData {
        uint256 price;        // 价格（以 8 位小数表示，如 1 USDT = 100000000）
        uint256 timestamp;    // 价格更新时间戳
        uint256 decimals;     // 价格精度
        bool isValid;         // 价格是否有效
    }

    /// @notice 资产配置结构
    struct AssetConfig {
        string coingeckoId;   // Coingecko 资产 ID
        uint256 decimals;     // 资产精度
        bool isActive;        // 资产是否激活
        uint256 maxPriceAge;  // 最大价格年龄（秒）
    }

    /*━━━━━━━━━━━━━━━ EVENTS ━━━━━━━━━━━━━━━*/
    
    /// @notice 价格更新事件
    event PriceUpdated(address indexed asset, uint256 price, uint256 timestamp);
    
    /// @notice 资产配置更新事件
    event AssetConfigUpdated(address indexed asset, string coingeckoId, bool isActive);

    /*━━━━━━━━━━━━━━━ EXTERNAL API ━━━━━━━━━━━━━━━*/

    /**
     * @notice 获取指定资产的最新价格
     * @param asset 资产地址
     * @return price 价格（以 8 位小数表示）
     * @return timestamp 价格更新时间戳
     * @return decimals 价格精度
     */
    function getPrice(address asset) external view returns (uint256 price, uint256 timestamp, uint256 decimals);

    /**
     * @notice 获取指定资产的完整价格数据
     * @param asset 资产地址
     * @return priceData 价格数据结构
     */
    function getPriceData(address asset) external view returns (PriceData memory priceData);

    /**
     * @notice 批量获取多个资产的价格
     * @param assets 资产地址数组
     * @return prices 价格数组
     * @return timestamps 时间戳数组
     * @return decimalsArray 精度数组
     */
    function getPrices(address[] calldata assets) external view returns (
        uint256[] memory prices,
        uint256[] memory timestamps,
        uint256[] memory decimalsArray
    );

    /**
     * @notice 检查价格是否有效（非过期且非零）
     * @param asset 资产地址
     * @return isValid 价格是否有效
     */
    function isPriceValid(address asset) external view returns (bool isValid);

    /**
     * @notice 获取资产的 Coingecko ID
     * @param asset 资产地址
     * @return coingeckoId Coingecko 资产 ID
     */
    function getAssetCoingeckoId(address asset) external view returns (string memory coingeckoId);

    /**
     * @notice 获取资产配置信息
     * @param asset 资产地址
     * @return config 资产配置结构
     */
    function getAssetConfig(address asset) external view returns (AssetConfig memory config);

    /**
     * @notice 获取支持的资产列表
     * @return assets 支持的资产地址数组
     */
    function getSupportedAssets() external view returns (address[] memory assets);

    /**
     * @notice 获取资产数量
     * @return count 支持的资产数量
     */
    function getAssetCount() external view returns (uint256 count);

    /*━━━━━━━━━━━━━━━ ADMIN FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice 更新资产价格（仅授权地址可调用）
     * @param asset 资产地址
     * @param price 价格（以 8 位小数表示）
     * @param timestamp 价格时间戳
     */
    function updatePrice(address asset, uint256 price, uint256 timestamp) external;

    /**
     * @notice 批量更新资产价格（仅授权地址可调用）
     * @param assets 资产地址数组
     * @param prices 价格数组
     * @param timestamps 时间戳数组
     */
    function updatePrices(
        address[] calldata assets,
        uint256[] calldata prices,
        uint256[] calldata timestamps
    ) external;

    /**
     * @notice 配置资产（仅治理可调用）
     * @param asset 资产地址
     * @param coingeckoId Coingecko 资产 ID
     * @param decimals 资产精度
     * @param maxPriceAge 最大价格年龄（秒）
     */
    function configureAsset(
        address asset,
        string calldata coingeckoId,
        uint256 decimals,
        uint256 maxPriceAge
    ) external;

    /**
     * @notice 激活/停用资产（仅治理可调用）
     * @param asset 资产地址
     * @param isActive 是否激活
     */
    function setAssetActive(address asset, bool isActive) external;
} 