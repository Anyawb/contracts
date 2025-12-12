// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IPriceOracleAdapter 价格预言机适配器接口
/// @notice 提供统一的预言机接口，支持多种预言机实现（Chainlink、Uniswap TWAP、Redstone等）
/// @dev 设计遵循 docs/SmartContractStandard.md 中的命名及错误规范
interface IPriceOracleAdapter {
    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/
    
    error PriceOracleAdapter__UnsupportedOracle();
    error PriceOracleAdapter__InvalidOracleAddress();
    error PriceOracleAdapter__OracleCallFailed();

    /*━━━━━━━━━━━━━━━ STRUCTS ━━━━━━━━━━━━━━━*/

    /// @notice 价格数据结构
    struct PriceData {
        uint256 price;        // 价格（以 8 位小数表示，如 1 USDT = 100000000）
        uint256 timestamp;    // 价格更新时间戳
        uint256 decimals;     // 价格精度
        bool isValid;         // 价格是否有效
        string oracleType;    // 预言机类型（如 "chainlink", "uniswap", "redstone"）
    }

    /*━━━━━━━━━━━━━━━ EVENTS ━━━━━━━━━━━━━━━*/
    
    /// @notice 预言机调用事件
    event OracleCall(address indexed asset, address indexed oracle, string oracleType, bool success);

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
     * @notice 获取支持的预言机类型
     * @return oracleTypes 支持的预言机类型数组
     */
    function getSupportedOracleTypes() external view returns (string[] memory oracleTypes);

    /**
     * @notice 检查预言机类型是否支持
     * @param oracleType 预言机类型
     * @return isSupported 是否支持
     */
    function isOracleTypeSupported(string calldata oracleType) external view returns (bool isSupported);

    /**
     * @notice 获取指定资产的预言机类型
     * @param asset 资产地址
     * @return oracleType 预言机类型
     */
    function getAssetOracleType(address asset) external view returns (string memory oracleType);

    /*━━━━━━━━━━━━━━━ ADMIN FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice 注册预言机实现（仅授权地址可调用）
     * @param oracleType 预言机类型
     * @param oracleAddress 预言机地址
     */
    function registerOracle(string calldata oracleType, address oracleAddress) external;

    /**
     * @notice 配置资产的预言机类型（仅授权地址可调用）
     * @param asset 资产地址
     * @param oracleType 预言机类型
     */
    function configureAssetOracle(address asset, string calldata oracleType) external;

    /**
     * @notice 批量配置资产的预言机类型（仅授权地址可调用）
     * @param assets 资产地址数组
     * @param oracleTypes 预言机类型数组
     */
    function configureAssetOracles(
        address[] calldata assets,
        string[] calldata oracleTypes
    ) external;
}
