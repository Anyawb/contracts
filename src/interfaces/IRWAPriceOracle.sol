// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { VaultTypes } from "../Vault/VaultTypes.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";

/// @title IRWAPriceOracle
/// @notice 提供 RWA 资产的美元价格查询接口
/// @dev 与 ActionKeys 和 ModuleKeys 集成，提供标准化的模块管理
/// @dev 与 VaultTypes 集成，提供标准化的事件记录
/// @dev 使用 StandardErrors 进行统一的错误处理
/// @custom:security-contact security@example.com
interface IRWAPriceOracle {
    /*━━━━━━━━━━━━━━━ EVENTS ━━━━━━━━━━━━━━━*/

    /// @notice 价格更新事件
    /// @param token    资产地址
    /// @param price    最新价格（USD 定价）
    /// @param timestamp 更新时间戳
    event PriceUpdated(address indexed token, uint256 price, uint256 timestamp);

    /// @notice RWA 资产配置更新事件
    /// @param token 资产地址
    /// @param isActive 是否激活
    /// @param maxPriceAge 最大价格年龄
    event RWAAssetConfigUpdated(address indexed token, bool isActive, uint256 maxPriceAge);

    /// @notice RWA 预言机参数更新事件
    /// @param paramName 参数名称
    /// @param oldValue 旧值
    /// @param newValue 新值
    event RWAParameterUpdated(string indexed paramName, uint256 oldValue, uint256 newValue);

    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/

    /// @notice 零地址参数
    error RWAPriceOracle__ZeroAddress();

    /// @notice 资产不支持
    error RWAPriceOracle__AssetNotSupported();

    /// @notice 价格无效
    error RWAPriceOracle__InvalidPrice();

    /// @notice 价格过期
    error RWAPriceOracle__StalePrice();

    /// @notice 未授权操作
    error RWAPriceOracle__Unauthorized();

    /*━━━━━━━━━━━━━━━ STRUCTS ━━━━━━━━━━━━━━━*/

    /// @notice RWA 价格数据结构
    struct RWAPriceData {
        uint256 price;        // 价格（USD 定价，8位小数）
        uint256 timestamp;    // 价格更新时间戳
        uint8 decimals;       // 价格精度
        bool isValid;         // 价格是否有效
        string assetType;     // 资产类型（如：real-estate, commodities, etc.）
    }

    /// @notice RWA 资产配置结构
    struct RWAAssetConfig {
        string assetType;     // 资产类型
        uint8 decimals;       // 资产精度
        bool isActive;        // 资产是否激活
        uint256 maxPriceAge;  // 最大价格年龄（秒）
        string description;   // 资产描述
    }

    /*━━━━━━━━━━━━━━━ EXTERNAL API ━━━━━━━━━━━━━━━*/

    /**
     * @notice 获取指定 RWA 资产的美元价格
     * @param token 目标资产地址
     * @return price   当前价格（定价单位为 USD，decimals 精度）
     * @return decimals 价格精度
     */
    function getPriceUSD(address token) external view returns (uint256 price, uint8 decimals);

    /**
     * @notice 获取指定 RWA 资产的完整价格数据
     * @param token 目标资产地址
     * @return priceData 价格数据结构
     */
    function getPriceData(address token) external view returns (RWAPriceData memory priceData);

    /**
     * @notice 批量获取多个 RWA 资产的价格
     * @param tokens 资产地址数组
     * @return prices 价格数组
     * @return decimalsArray 精度数组
     */
    function getPricesUSD(address[] calldata tokens) external view returns (
        uint256[] memory prices,
        uint8[] memory decimalsArray
    );

    /**
     * @notice 检查 RWA 资产价格是否有效
     * @param token 资产地址
     * @return isValid 价格是否有效
     */
    function isPriceValid(address token) external view returns (bool isValid);

    /**
     * @notice 获取 RWA 资产配置信息
     * @param token 资产地址
     * @return config 资产配置结构
     */
    function getAssetConfig(address token) external view returns (RWAAssetConfig memory config);

    /**
     * @notice 获取支持的 RWA 资产列表
     * @return tokens 支持的资产地址数组
     */
    function getSupportedAssets() external view returns (address[] memory tokens);

    /**
     * @notice 获取 RWA 资产数量
     * @return count 支持的资产数量
     */
    function getAssetCount() external view returns (uint256 count);

    /*━━━━━━━━━━━━━━━ ADMIN FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice 更新 RWA 资产价格（仅授权地址可调用）
     * @param token 资产地址
     * @param price 价格（USD 定价，8位小数）
     * @param timestamp 价格时间戳
     */
    function updatePrice(address token, uint256 price, uint256 timestamp) external;

    /**
     * @notice 批量更新 RWA 资产价格（仅授权地址可调用）
     * @param tokens 资产地址数组
     * @param prices 价格数组
     * @param timestamps 时间戳数组
     */
    function updatePrices(
        address[] calldata tokens,
        uint256[] calldata prices,
        uint256[] calldata timestamps
    ) external;

    /**
     * @notice 配置 RWA 资产（仅治理可调用）
     * @param token 资产地址
     * @param assetType 资产类型
     * @param decimals 资产精度
     * @param maxPriceAge 最大价格年龄（秒）
     * @param description 资产描述
     */
    function configureAsset(
        address token,
        string calldata assetType,
        uint8 decimals,
        uint256 maxPriceAge,
        string calldata description
    ) external;

    /**
     * @notice 激活/停用 RWA 资产（仅治理可调用）
     * @param token 资产地址
     * @param isActive 是否激活
     */
    function setAssetActive(address token, bool isActive) external;

    /**
     * @notice 更新 RWA 预言机参数（仅治理可调用）
     * @param paramName 参数名称
     * @param newValue 新值
     */
    function updateParameter(string calldata paramName, uint256 newValue) external;
} 