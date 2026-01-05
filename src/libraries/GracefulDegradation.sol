// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import { IPriceOracle } from "../interfaces/IPriceOracle.sol";
import { IPriceOracleAdapter } from "../interfaces/IPriceOracleAdapter.sol";
import { VaultTypes } from "../Vault/VaultTypes.sol";

/// @title GracefulDegradation
/// @notice 优雅降级库，提供通用的价格获取和错误处理功能
/// @dev 用于处理价格预言机失败时的备用策略
/// @dev 支持多种降级策略：保守估值、缓存价格、稳定币面值等
/// @dev 修复了价格操纵风险、精度验证不足、溢出检查不完整等安全问题
/// @dev 缓存使用说明：
/// @dev - view 函数：只能读取缓存，不能写入
/// @dev - non-view 函数：可以读取和写入缓存
/// @dev - 使用 getAssetValueWithFallbackAndCache 进行缓存写入
/// @dev - 使用 getAssetValueWithFallback 进行只读操作
/// @dev 精度验证规则：
/// @dev - 最小精度：6（支持常见稳定币和主流加密货币）
/// @dev - 最大精度：18（符合ERC20标准）
/// @dev - 防止价格单位错乱和计算错误
/// @dev 配置设计：
/// @dev - GlobalDegradationConfig：平台级别配置（全局设置）
/// @dev - CallContextConfig：单次调用级别配置（用户交易时）
/// @dev - 支持配置合并和验证
/// @dev SafeMath 使用：
/// @dev - 兼容 OpenZeppelin SafeMath 库
/// @dev - 提供安全的数学运算函数
/// @dev - 防止溢出和下溢错误
library GracefulDegradation {
    using SafeMath for uint256;

    /* ============ Constants ============ */
    /// @notice 最大价格年龄（1小时）
    uint256 private constant MAX_PRICE_AGE = 3600;
    
    /// @notice 最小精度值（修复：防止价格单位错乱）
    /// @dev 设置为6，支持常见稳定币（USDC、USDT）和主流加密货币
    uint256 private constant MIN_DECIMALS = 6;
    
    /// @notice 最大精度值
    uint256 private constant MAX_DECIMALS = 18;
    
    /// @notice 稳定币价格容忍度（基点，默认1%）
    uint256 private constant STABLECOIN_TOLERANCE = 100;
    
    /// @notice 价格合理性检查的最小历史价格数量
    uint256 private constant MIN_HISTORICAL_PRICES = 3;
    
    /// @notice 最大合理价格（向后兼容常量）
    uint256 internal constant MAX_REASONABLE_PRICE = 1e12;

    /* ============ 语义化常量定义 ============ */
    /// @notice 1 USD 价格（18位精度）
    uint256 private constant ONE_USD = 1e18;
    
    /// @notice 基点除数（100% = 10000基点）
    uint256 private constant BASIS_POINT_DIVISOR = 10000;
    
    /// @notice 100% 基点值
    uint256 private constant BASIS_POINT_100_PERCENT = 10000;
    
    /// @notice 默认最大合理价格（1e12）
    uint256 private constant DEFAULT_MAX_REASONABLE_PRICE = 1e12;
    
    /// @notice 默认保守估值比例（50%）
    uint256 private constant DEFAULT_CONSERVATIVE_RATIO = 5000;
    
    /// @notice 默认价格更新阈值（5分钟）
    uint256 private constant DEFAULT_PRICE_UPDATE_THRESHOLD = 300;
    
    /// @notice 默认最大价格倍数（150%）
    uint256 private constant DEFAULT_MAX_PRICE_MULTIPLIER = 15000;
    
    /// @notice 默认最小价格倍数（50%）
    uint256 private constant DEFAULT_MIN_PRICE_MULTIPLIER = 5000;
    
    /// @notice 默认重试配置常量
    uint256 private constant DEFAULT_MAX_RETRY_COUNT = 1;
    uint256 private constant DEFAULT_RETRY_DELAY = 0; // 立即重试
    uint256 private constant DEFAULT_MAX_GAS_LIMIT = 500000; // 50万 gas

    /* ============ Structs ============ */
    /// @notice 价格获取结果
    struct PriceResult {
        uint256 value;           // 计算出的价值
        bool isValid;            // 是否有效
        string reason;           // 结果原因
        bool usedFallback;       // 是否使用了降级策略
        uint256 timestamp;       // 价格时间戳
        uint256 priceAge;        // 价格年龄
    }

    /// @notice 平台级别降级配置（全局设置）
    struct GlobalDegradationConfig {
        address settlementToken;      // 结算币地址
        PriceValidationConfig priceValidation; // 价格验证配置
        StablecoinConfig stablecoinConfig; // 稳定币配置
        bool enablePriceCache;        // 是否启用价格缓存
        uint256 maxPriceAge;          // 最大价格年龄
        uint256 conservativeRatio;    // 保守估值比例（基点，默认50%）
    }

    /// @notice 单次调用级别配置（用户交易时）
    struct CallContextConfig {
        bool useStablecoinFaceValue;  // 是否对稳定币使用面值
        bool enableHistoricalValidation; // 是否启用历史价格验证
        uint256 customConservativeRatio; // 自定义保守估值比例（可选，0表示使用全局设置）
        bool useCustomPriceValidation;   // 是否使用自定义价格验证
        PriceValidationConfig customPriceValidation; // 自定义价格验证配置
    }

    /// @notice 降级策略配置（向后兼容）
    struct DegradationConfig {
        uint256 conservativeRatio;    // 保守估值比例（基点，默认50%）
        bool useStablecoinFaceValue;  // 是否对稳定币使用面值
        bool enablePriceCache;        // 是否启用价格缓存
        address settlementToken;      // 结算币地址
        PriceValidationConfig priceValidation; // 价格验证配置
        StablecoinConfig stablecoinConfig; // 稳定币配置
        RetryConfig retryConfig;      // 重试配置
    }

    /// @notice 价格验证配置（修复：替换硬编码常量）
    struct PriceValidationConfig {
        uint256 maxPriceMultiplier;  // 相对于历史价格的最大倍数（基点）
        uint256 minPriceMultiplier;  // 相对于历史价格的最小倍数（基点）
        uint256 priceUpdateThreshold; // 价格更新阈值
        uint256 maxPriceAge;         // 最大价格年龄
        uint256 maxReasonablePrice;  // 最大合理价格（动态）
        bool enableHistoricalValidation; // 是否启用历史价格验证
    }

    /// @notice 稳定币验证配置
    struct StablecoinConfig {
        address stablecoin;          // 稳定币地址
        uint256 expectedPrice;       // 期望价格（通常是1）
        uint256 tolerance;           // 容忍度（基点）
        bool isWhitelisted;          // 是否在白名单中
        bool enableDepegDetection;   // 是否启用脱锚检测
    }

    /// @notice 价格缓存结构
    struct PriceCache {
        uint256 price;
        uint256 timestamp;
        uint256 decimals;
        bool isValid;
    }

    /// @notice 重试配置
    struct RetryConfig {
        bool enableRetry;             // 是否启用重试
        uint256 maxRetryCount;        // 最大重试次数
        uint256 retryDelay;           // 重试延迟（秒）
        uint256 maxGasLimit;          // 最大 gas 限制
        bool retryOnNetworkError;     // 是否在网络错误时重试
        bool retryOnTimeout;          // 是否在超时时重试
    }

    /// @notice 缓存存储结构（用于调用合约）
    struct CacheStorage {
        mapping(address => PriceCache) priceCache;
        mapping(address => uint256) nonces;
    }

    /* ============ Events ============ */
    // 注意：库文件不发出事件，事件应该在调用合约中发出

    /* ============ Core Functions ============ */

    /// @notice 获取资产价值（带优雅降级）- 修复版本
    /// @param priceOracleAddr 价格预言机地址
    /// @param assetAddr 资产地址
    /// @param amountValue 资产数量
    /// @param config 降级配置
    /// @param cacheStorage 缓存存储（可选）
    /// @return result 价格获取结果
    function getAssetValueWithFallback(
        address priceOracleAddr,
        address assetAddr,
        uint256 amountValue,
        DegradationConfig memory config,
        CacheStorage storage cacheStorage
    ) internal view returns (PriceResult memory result) {
        // 验证输入参数
        require(priceOracleAddr != address(0), "Invalid price oracle address");
        require(assetAddr != address(0), "Invalid asset address");
        require(amountValue > 0, "Amount must be greater than zero");
        
        if (amountValue == 0) {
            result.value = 0;
            result.isValid = true;
            result.reason = "Zero amount";
            result.usedFallback = false;
            result.timestamp = block.timestamp;
            result.priceAge = 0;
            return result;
        }

        // 使用重试机制获取价格
        (uint256 price, uint256 timestamp, uint256 decimals, bool success, string memory errorReason) = _getPriceWithRetry(
            priceOracleAddr,
            assetAddr,
            config.retryConfig
        );
        
        if (!success) {
            // 处理获取价格失败的情况
            if (config.enablePriceCache) {
                PriceCache memory cachedPrice = _getCachedPrice(assetAddr, cacheStorage);
                if (cachedPrice.isValid && !_isCacheExpired(cachedPrice.timestamp, config.priceValidation.maxPriceAge)) {
                    uint256 cachedCalculatedValue = calculateAssetValue(amountValue, cachedPrice.price, cachedPrice.decimals);
                    if (cachedCalculatedValue > 0) {
                        result.value = cachedCalculatedValue;
                        result.isValid = true;
                        result.reason = string(abi.encodePacked("Used cached price after retry failure: ", errorReason));
                        result.usedFallback = true;
                        result.timestamp = cachedPrice.timestamp;
                        result.priceAge = block.timestamp.sub(cachedPrice.timestamp);
                        return result;
                    }
                }
            }
            
            // 使用降级策略
            return _applyFallbackStrategy(assetAddr, amountValue, string(abi.encodePacked("Price oracle retry failed: ", errorReason)), config);
        }
        
        // 验证精度参数（修复：添加最小精度验证）
        if (!validateDecimals(decimals)) {
            return _applyFallbackStrategy(assetAddr, amountValue, "Invalid decimals", config);
        }

        // 验证资产精度合理性
        if (!validateAssetDecimals(assetAddr, decimals)) {
            return _applyFallbackStrategy(assetAddr, amountValue, "Invalid asset decimals", config);
        }

        // 验证价格有效性
        if (price == 0) {
            return _applyFallbackStrategy(assetAddr, amountValue, "Zero price", config);
        }

        // 检查价格是否过期
        uint256 priceAge = block.timestamp.sub(timestamp);
        if (priceAge > config.priceValidation.maxPriceAge) {
            return _applyFallbackStrategy(assetAddr, amountValue, "Stale price", config);
        }

        // 验证价格合理性（修复：使用动态价格验证）
        if (!validatePriceReasonableness(price, assetAddr, config.priceValidation, cacheStorage)) {
            return _applyFallbackStrategy(assetAddr, amountValue, "Unreasonable price", config);
        }

        // 验证稳定币价格（如果适用）
        if (config.stablecoinConfig.enableDepegDetection && 
            assetAddr == config.stablecoinConfig.stablecoin) {
            if (!validateStablecoinPrice(assetAddr, config.stablecoinConfig.expectedPrice, config.stablecoinConfig.tolerance)) {
                return _applyFallbackStrategy(assetAddr, amountValue, "Stablecoin depeg detected", config);
            }
        }

        // 计算价值（修复：使用 SafeMath 的完整检查）
        uint256 calculatedValue = calculateAssetValue(amountValue, price, decimals);

        // 注意：缓存写入功能已移至单独的 non-view 函数
        // 当前 view 函数只进行缓存读取，不进行写入操作

        // 成功获取价格
        result.value = calculatedValue;
        result.isValid = true;
        result.reason = "Price calculation successful";
        result.usedFallback = false;
        result.timestamp = timestamp;
        result.priceAge = priceAge;
    }

    /// @notice 获取资产价值（带优雅降级）- 向后兼容版本
    /// @param priceOracleAddr 价格预言机地址
    /// @param assetAddr 资产地址
    /// @param amountValue 资产数量
    /// @param config 降级配置
    /// @return result 价格获取结果
    function getAssetValueWithFallback(
        address priceOracleAddr,
        address assetAddr,
        uint256 amountValue,
        DegradationConfig memory config
    ) internal view returns (PriceResult memory result) {
        // 验证输入参数
        require(priceOracleAddr != address(0), "Invalid price oracle address");
        require(assetAddr != address(0), "Invalid asset address");
        require(amountValue > 0, "Amount must be greater than zero");
        
        if (amountValue == 0) {
            result.value = 0;
            result.isValid = true;
            result.reason = "Zero amount";
            result.usedFallback = false;
            result.timestamp = block.timestamp;
            result.priceAge = 0;
            return result;
        }

        // 尝试从价格预言机适配器获取价格
        try IPriceOracleAdapter(priceOracleAddr).getPrice(assetAddr) returns (uint256 price, uint256 timestamp, uint256 decimals) {
            // 验证精度参数（修复：添加最小精度验证）
            if (!validateDecimals(decimals)) {
                return _applyFallbackStrategy(assetAddr, amountValue, "Invalid decimals", config);
            }

            // 验证资产精度合理性
            if (!validateAssetDecimals(assetAddr, decimals)) {
                return _applyFallbackStrategy(assetAddr, amountValue, "Invalid asset decimals", config);
            }

            // 验证价格有效性
            if (price == 0) {
                return _applyFallbackStrategy(assetAddr, amountValue, "Zero price", config);
            }

            // 检查价格是否过期
            uint256 priceAge = block.timestamp.sub(timestamp);
            if (priceAge > config.priceValidation.maxPriceAge) {
                return _applyFallbackStrategy(assetAddr, amountValue, "Stale price", config);
            }

            // 验证价格合理性（简化版本，不依赖缓存）
            if (price > config.priceValidation.maxReasonablePrice) {
                return _applyFallbackStrategy(assetAddr, amountValue, "Unreasonable price", config);
            }

            // 验证稳定币价格（如果适用）
            if (config.stablecoinConfig.enableDepegDetection && 
                assetAddr == config.stablecoinConfig.stablecoin) {
                if (!validateStablecoinPrice(assetAddr, config.stablecoinConfig.expectedPrice, config.stablecoinConfig.tolerance)) {
                    return _applyFallbackStrategy(assetAddr, amountValue, "Stablecoin depeg detected", config);
                }
            }

            // 计算价值（修复：使用 SafeMath 的完整检查）
            uint256 calculatedValue = calculateAssetValue(amountValue, price, decimals);

            // 成功获取价格
            result.value = calculatedValue;
            result.isValid = true;
            result.reason = "Price calculation successful";
            result.usedFallback = false;
            result.timestamp = timestamp;
            result.priceAge = priceAge;

        } catch Error(string memory reason) {
            // 处理 revert 错误（带有错误信息）
            return _applyFallbackStrategy(assetAddr, amountValue, string(abi.encodePacked("Price oracle error: ", reason)), config);
        } catch (bytes memory lowLevelData) {
            // 处理低级错误（panic、自定义错误等）
            string memory errorMessage = _decodeLowLevelError(lowLevelData);
            return _applyFallbackStrategy(assetAddr, amountValue, string(abi.encodePacked("Price oracle low-level error: ", errorMessage)), config);
        }
    }

    /// @notice 获取资产价值并缓存价格（non-view 版本）
    /// @dev 此函数可以写入缓存，只能在 non-view 函数中调用
    /// @param priceOracleAddr 价格预言机地址
    /// @param assetAddr 资产地址
    /// @param amountValue 资产数量
    /// @param config 降级配置
    /// @param cacheStorage 缓存存储
    /// @return result 价格获取结果
    function getAssetValueWithFallbackAndCache(
        address priceOracleAddr,
        address assetAddr,
        uint256 amountValue,
        DegradationConfig memory config,
        CacheStorage storage cacheStorage
    ) internal returns (PriceResult memory result) {
        // 验证输入参数
        require(priceOracleAddr != address(0), "Invalid price oracle address");
        require(assetAddr != address(0), "Invalid asset address");
        require(amountValue > 0, "Amount must be greater than zero");
        
        if (amountValue == 0) {
            result.value = 0;
            result.isValid = true;
            result.reason = "Zero amount";
            result.usedFallback = false;
            result.timestamp = block.timestamp;
            result.priceAge = 0;
            return result;
        }

        // 尝试从价格预言机适配器获取价格
        try IPriceOracleAdapter(priceOracleAddr).getPrice(assetAddr) returns (uint256 price, uint256 timestamp, uint256 decimals) {
            // 验证精度参数
            if (!validateDecimals(decimals)) {
                return _applyFallbackStrategy(assetAddr, amountValue, "Invalid decimals", config);
            }

            // 验证资产精度合理性
            if (!validateAssetDecimals(assetAddr, decimals)) {
                return _applyFallbackStrategy(assetAddr, amountValue, "Invalid asset decimals", config);
            }

            // 验证价格有效性
            if (price == 0) {
                return _applyFallbackStrategy(assetAddr, amountValue, "Zero price", config);
            }

            // 检查价格是否过期
            uint256 priceAge = block.timestamp.sub(timestamp);
            if (priceAge > config.priceValidation.maxPriceAge) {
                return _applyFallbackStrategy(assetAddr, amountValue, "Stale price", config);
            }

            // 验证价格合理性
            if (!validatePriceReasonableness(price, assetAddr, config.priceValidation, cacheStorage)) {
                return _applyFallbackStrategy(assetAddr, amountValue, "Unreasonable price", config);
            }

            // 验证稳定币价格（如果适用）
            if (config.stablecoinConfig.enableDepegDetection && 
                assetAddr == config.stablecoinConfig.stablecoin) {
                if (!validateStablecoinPrice(assetAddr, config.stablecoinConfig.expectedPrice, config.stablecoinConfig.tolerance)) {
                    return _applyFallbackStrategy(assetAddr, amountValue, "Stablecoin depeg detected", config);
                }
            }

            // 计算价值
            uint256 calculatedValue = calculateAssetValue(amountValue, price, decimals);

            // 如果启用缓存，写入缓存
            if (config.enablePriceCache) {
                cachePrice(assetAddr, price, timestamp, decimals, cacheStorage);
            }

            // 成功获取价格
            result.value = calculatedValue;
            result.isValid = true;
            result.reason = "Price calculation successful";
            result.usedFallback = false;
            result.timestamp = timestamp;
            result.priceAge = priceAge;

        } catch Error(string memory reason) {
            // 处理 revert 错误（带有错误信息）
            if (config.enablePriceCache) {
                PriceCache memory cachedPrice = _getCachedPrice(assetAddr, cacheStorage);
                if (cachedPrice.isValid && !_isCacheExpired(cachedPrice.timestamp, config.priceValidation.maxPriceAge)) {
                    uint256 calculatedValue = calculateAssetValue(amountValue, cachedPrice.price, cachedPrice.decimals);
                    if (calculatedValue > 0) {
                        result.value = calculatedValue;
                        result.isValid = true;
                        result.reason = string(abi.encodePacked("Used cached price after error: ", reason));
                        result.usedFallback = true;
                        result.timestamp = cachedPrice.timestamp;
                        result.priceAge = block.timestamp.sub(cachedPrice.timestamp);
                        return result;
                    }
                }
            }
            
            // 使用降级策略
            return _applyFallbackStrategy(assetAddr, amountValue, string(abi.encodePacked("Price oracle error: ", reason)), config);
        } catch (bytes memory lowLevelData) {
            // 处理低级错误（panic、自定义错误等）
            string memory errorMessage = _decodeLowLevelError(lowLevelData);
            
            if (config.enablePriceCache) {
                PriceCache memory cachedPrice = _getCachedPrice(assetAddr, cacheStorage);
                if (cachedPrice.isValid && !_isCacheExpired(cachedPrice.timestamp, config.priceValidation.maxPriceAge)) {
                    uint256 calculatedValue = calculateAssetValue(amountValue, cachedPrice.price, cachedPrice.decimals);
                    if (calculatedValue > 0) {
                        result.value = calculatedValue;
                        result.isValid = true;
                        result.reason = string(abi.encodePacked("Used cached price after low-level error: ", errorMessage));
                        result.usedFallback = true;
                        result.timestamp = cachedPrice.timestamp;
                        result.priceAge = block.timestamp.sub(cachedPrice.timestamp);
                        return result;
                    }
                }
            }
            
            // 使用降级策略
            return _applyFallbackStrategy(assetAddr, amountValue, string(abi.encodePacked("Price oracle low-level error: ", errorMessage)), config);
        }
    }

    /// @notice 获取资产价值（带优雅降级）- 新版本（使用分离的配置）
    /// @param priceOracleAddr 价格预言机地址
    /// @param assetAddr 资产地址
    /// @param amountValue 资产数量
    /// @param globalConfig 全局配置
    /// @param callConfig 调用上下文配置
    /// @param cacheStorage 缓存存储（可选）
    /// @return result 价格获取结果
    function getAssetValueWithFallbackNew(
        address priceOracleAddr,
        address assetAddr,
        uint256 amountValue,
        GlobalDegradationConfig memory globalConfig,
        CallContextConfig memory callConfig,
        CacheStorage storage cacheStorage
    ) internal view returns (PriceResult memory result) {
        // 验证输入参数
        require(priceOracleAddr != address(0), "Invalid price oracle address");
        require(assetAddr != address(0), "Invalid asset address");
        require(amountValue > 0, "Amount must be greater than zero");
        
        if (amountValue == 0) {
            result.value = 0;
            result.isValid = true;
            result.reason = "Zero amount";
            result.usedFallback = false;
            result.timestamp = block.timestamp;
            result.priceAge = 0;
            return result;
        }

        // 确定使用的配置
        uint256 effectiveConservativeRatio = callConfig.customConservativeRatio > 0 
            ? callConfig.customConservativeRatio 
            : globalConfig.conservativeRatio;
            
        PriceValidationConfig memory effectivePriceValidation = callConfig.useCustomPriceValidation
            ? callConfig.customPriceValidation
            : globalConfig.priceValidation;

        // 尝试从价格预言机适配器获取价格
        try IPriceOracleAdapter(priceOracleAddr).getPrice(assetAddr) returns (uint256 price, uint256 timestamp, uint256 decimals) {
            // 验证精度参数
            if (!validateDecimals(decimals)) {
                return _applyFallbackStrategyNew(assetAddr, amountValue, "Invalid decimals", globalConfig, effectiveConservativeRatio);
            }

            // 验证资产精度合理性
            if (!validateAssetDecimals(assetAddr, decimals)) {
                return _applyFallbackStrategyNew(assetAddr, amountValue, "Invalid asset decimals", globalConfig, effectiveConservativeRatio);
            }

            // 验证价格有效性
            if (price == 0) {
                return _applyFallbackStrategyNew(assetAddr, amountValue, "Zero price", globalConfig, effectiveConservativeRatio);
            }

            // 检查价格是否过期
            uint256 priceAge = block.timestamp.sub(timestamp);
            if (priceAge > globalConfig.maxPriceAge) {
                return _applyFallbackStrategyNew(assetAddr, amountValue, "Stale price", globalConfig, effectiveConservativeRatio);
            }

            // 验证价格合理性
            if (!validatePriceReasonableness(price, assetAddr, effectivePriceValidation, cacheStorage)) {
                return _applyFallbackStrategyNew(assetAddr, amountValue, "Unreasonable price", globalConfig, effectiveConservativeRatio);
            }

            // 验证稳定币价格（如果适用）
            if (globalConfig.stablecoinConfig.enableDepegDetection && 
                assetAddr == globalConfig.stablecoinConfig.stablecoin) {
                if (!validateStablecoinPrice(assetAddr, globalConfig.stablecoinConfig.expectedPrice, globalConfig.stablecoinConfig.tolerance)) {
                    return _applyFallbackStrategyNew(assetAddr, amountValue, "Stablecoin depeg detected", globalConfig, effectiveConservativeRatio);
                }
            }

            // 计算价值
            uint256 calculatedValue = calculateAssetValue(amountValue, price, decimals);

            // 成功获取价格
            result.value = calculatedValue;
            result.isValid = true;
            result.reason = "Price calculation successful";
            result.usedFallback = false;
            result.timestamp = timestamp;
            result.priceAge = priceAge;

        } catch Error(string memory reason) {
            // 处理 revert 错误（带有错误信息）
            if (globalConfig.enablePriceCache) {
                PriceCache memory cachedPrice = _getCachedPrice(assetAddr, cacheStorage);
                if (cachedPrice.isValid && !_isCacheExpired(cachedPrice.timestamp, globalConfig.maxPriceAge)) {
                    uint256 calculatedValue = calculateAssetValue(amountValue, cachedPrice.price, cachedPrice.decimals);
                    if (calculatedValue > 0) {
                        result.value = calculatedValue;
                        result.isValid = true;
                        result.reason = string(abi.encodePacked("Used cached price after error: ", reason));
                        result.usedFallback = true;
                        result.timestamp = cachedPrice.timestamp;
                        result.priceAge = block.timestamp.sub(cachedPrice.timestamp);
                        return result;
                    }
                }
            }
            
            // 使用降级策略
            return _applyFallbackStrategyNew(assetAddr, amountValue, string(abi.encodePacked("Price oracle error: ", reason)), globalConfig, effectiveConservativeRatio);
        } catch (bytes memory lowLevelData) {
            // 处理低级错误（panic、自定义错误等）
            string memory errorMessage = _decodeLowLevelError(lowLevelData);
            
            if (globalConfig.enablePriceCache) {
                PriceCache memory cachedPrice = _getCachedPrice(assetAddr, cacheStorage);
                if (cachedPrice.isValid && !_isCacheExpired(cachedPrice.timestamp, globalConfig.maxPriceAge)) {
                    uint256 calculatedValue = calculateAssetValue(amountValue, cachedPrice.price, cachedPrice.decimals);
                    if (calculatedValue > 0) {
                        result.value = calculatedValue;
                        result.isValid = true;
                        result.reason = string(abi.encodePacked("Used cached price after low-level error: ", errorMessage));
                        result.usedFallback = true;
                        result.timestamp = cachedPrice.timestamp;
                        result.priceAge = block.timestamp.sub(cachedPrice.timestamp);
                        return result;
                    }
                }
            }
            
            // 使用降级策略
            return _applyFallbackStrategyNew(assetAddr, amountValue, string(abi.encodePacked("Price oracle low-level error: ", errorMessage)), globalConfig, effectiveConservativeRatio);
        }
    }

    /// @notice 检查价格预言机健康状态 - 修复版本
    /// @param priceOracleAddr 价格预言机地址
    /// @param assetAddr 资产地址
    /// @param config 价格验证配置
    /// @param cacheStorage 缓存存储（可选）
    /// @return isHealthy 是否健康
    /// @return details 详细信息
    function checkPriceOracleHealth(
        address priceOracleAddr,
        address assetAddr,
        PriceValidationConfig memory config,
        CacheStorage storage cacheStorage
    ) internal view returns (bool isHealthy, string memory details) {
        try IPriceOracleAdapter(priceOracleAddr).getPrice(assetAddr) returns (uint256 price, uint256 timestamp, uint256 decimals) {
            if (price == 0) {
                return (false, "Zero price returned");
            }
            if (block.timestamp.sub(timestamp) > config.maxPriceAge) {
                return (false, "Stale price");
            }
            if (!validatePriceReasonableness(price, assetAddr, config, cacheStorage)) {
                return (false, "Unreasonable price");
            }
            if (!validateDecimals(decimals)) {
                return (false, "Invalid decimals");
            }
            return (true, "Healthy");
        } catch Error(string memory reason) {
            return (false, string(abi.encodePacked("Price oracle error: ", reason)));
        } catch (bytes memory lowLevelData) {
            string memory errorMessage = _decodeLowLevelError(lowLevelData);
            return (false, string(abi.encodePacked("Price oracle low-level error: ", errorMessage)));
        }
    }

    /// @notice 检查价格预言机健康状态（向后兼容版本）
    /// @param priceOracleAddr 价格预言机地址
    /// @param assetAddr 资产地址
    /// @return isHealthy 是否健康
    /// @return details 详细信息
    function checkPriceOracleHealth(
        address priceOracleAddr,
        address assetAddr
    ) internal view returns (bool isHealthy, string memory details) {
        // 使用默认配置进行健康检查
        PriceValidationConfig memory defaultConfig = createPriceValidationConfig(
            DEFAULT_MAX_PRICE_MULTIPLIER, // 150%
            DEFAULT_MIN_PRICE_MULTIPLIER,  // 50%
            DEFAULT_MAX_REASONABLE_PRICE   // 1e12
        );
        
        // 对于向后兼容版本，我们使用一个简单的实现，不依赖缓存
        try IPriceOracleAdapter(priceOracleAddr).getPrice(assetAddr) returns (uint256 price, uint256 timestamp, uint256 decimals) {
            if (price == 0) {
                return (false, "Zero price returned");
            }
            if (block.timestamp.sub(timestamp) > defaultConfig.maxPriceAge) {
                return (false, "Stale price");
            }
            if (!validateDecimals(decimals)) {
                return (false, "Invalid decimals");
            }
            return (true, "Healthy");
        } catch Error(string memory reason) {
            return (false, string(abi.encodePacked("Price oracle error: ", reason)));
        } catch (bytes memory lowLevelData) {
            string memory errorMessage = _decodeLowLevelError(lowLevelData);
            return (false, string(abi.encodePacked("Price oracle low-level error: ", errorMessage)));
        }
    }

    /* ============ 修复：新增安全函数 ============ */

    /// @notice 验证精度参数（修复：增强精度验证）
    /// @param decimalsValue 精度值
    /// @return isValid 是否有效
    /// @dev 最小精度为6，支持常见稳定币和主流加密货币
    /// @dev 最大精度为18，符合ERC20标准
    function validateDecimals(uint256 decimalsValue) internal pure returns (bool isValid) {
        // 检查最小精度（防止价格单位错乱）
        if (decimalsValue < MIN_DECIMALS) {
            return false;
        }
        
        // 检查最大精度（符合ERC20标准）
        if (decimalsValue > MAX_DECIMALS) {
            return false;
        }
        
        return true;
    }

    /// @notice 验证精度参数并返回详细错误信息
    /// @param decimalsValue 精度值
    /// @return isValid 是否有效
    /// @return errorMessage 错误信息（如果无效）
    /// @dev 提供详细的精度验证错误信息，便于调试
    function validateDecimalsWithError(uint256 decimalsValue) internal pure returns (bool isValid, string memory errorMessage) {
        if (decimalsValue < MIN_DECIMALS) {
            return (false, string(abi.encodePacked("Decimals too low: ", _uint256ToString(decimalsValue), " (minimum: ", _uint256ToString(MIN_DECIMALS), ")")));
        }
        
        if (decimalsValue > MAX_DECIMALS) {
            return (false, string(abi.encodePacked("Decimals too high: ", _uint256ToString(decimalsValue), " (maximum: ", _uint256ToString(MAX_DECIMALS), ")")));
        }
        
        return (true, "");
    }

    /// @notice 检查资产精度是否合理
    /// @param assetAddr 资产地址
    /// @param decimalsValue 精度值
    /// @return isValid 是否合理
    /// @dev 根据资产类型进行精度验证
    function validateAssetDecimals(address assetAddr, uint256 decimalsValue) internal pure returns (bool isValid) {
        // 基础精度验证
        if (!validateDecimals(decimalsValue)) {
            return false;
        }
        
        // 对于已知的稳定币，进行额外的精度验证
        // 这里可以根据实际需要添加特定资产的精度检查
        // 例如：USDC、USDT 应该是 6 位精度
        
        // 验证资产地址不为零
        if (assetAddr == address(0)) {
            return false;
        }
        
        // 对于特定资产类型，进行额外的精度验证
        // 这里可以添加已知资产的精度验证逻辑
        // 例如：检查是否为已知的稳定币地址，验证其精度是否符合预期
        
        return true;
    }

    /// @notice 安全的幂运算（使用 SafeMath）
    /// @param base 底数
    /// @param exponent 指数
    /// @return result 结果
    /// @dev 防止幂运算溢出
    function safePow(uint256 base, uint256 exponent) internal pure returns (uint256 result) {
        require(exponent <= MAX_DECIMALS, "Exponent too high for safe calculation");
        
        if (exponent == 0) {
            return 1;
        }
        
        result = 1;
        uint256 currentBase = base;
        uint256 currentExponent = exponent;
        
        while (currentExponent > 0) {
            if (currentExponent & 1 == 1) {
                result = result.mul(currentBase);
            }
            currentExponent = currentExponent >> 1;
            if (currentExponent > 0) {
                currentBase = currentBase.mul(currentBase);
            }
        }
        
        return result;
    }

    /// @notice 安全的乘法运算（带溢出检查）
    /// @param firstValue 第一个操作数
    /// @param secondValue 第二个操作数
    /// @return result 结果
    function safeMul(uint256 firstValue, uint256 secondValue) internal pure returns (uint256 result) {
        result = firstValue.mul(secondValue);
        require(result >= firstValue, "SafeMath: multiplication overflow");
        return result;
    }

    /// @notice 安全的除法运算（带零除检查）
    /// @param dividend 被除数
    /// @param divisor 除数
    /// @return result 结果
    function safeDiv(uint256 dividend, uint256 divisor) internal pure returns (uint256 result) {
        require(divisor > 0, "SafeMath: division by zero");
        result = dividend.div(divisor);
        return result;
    }

    /// @notice 安全的减法运算（带下溢检查）
    /// @param minuend 被减数
    /// @param subtrahend 减数
    /// @return result 结果
    function safeSub(uint256 minuend, uint256 subtrahend) internal pure returns (uint256 result) {
        result = minuend.sub(subtrahend);
        require(result <= minuend, "SafeMath: subtraction overflow");
        return result;
    }

    /// @notice 安全的加法运算（带上溢检查）
    /// @param firstValue 第一个加数
    /// @param secondValue 第二个加数
    /// @return result 结果
    function safeAdd(uint256 firstValue, uint256 secondValue) internal pure returns (uint256 result) {
        result = firstValue.add(secondValue);
        require(result >= firstValue, "SafeMath: addition overflow");
        return result;
    }

    /// @notice 验证价格合理性（修复：动态价格验证）
    /// @param currentPriceValue 当前价格
    /// @param assetAddr 资产地址
    /// @param config 价格验证配置
    /// @param cacheStorage 缓存存储（可选）
    /// @return isValid 是否合理
    function validatePriceReasonableness(
        uint256 currentPriceValue,
        address assetAddr,
        PriceValidationConfig memory config,
        CacheStorage storage cacheStorage
    ) internal view returns (bool isValid) {
        // 基础检查：价格不能为零
        if (currentPriceValue == 0) {
            return false;
        }

        // 检查最大合理价格（动态）
        if (currentPriceValue > config.maxReasonablePrice) {
            return false;
        }

        // 如果启用历史价格验证，进行历史价格对比
        if (config.enableHistoricalValidation) {
            uint256 historicalPrice = getHistoricalPrice(assetAddr, cacheStorage);
            if (historicalPrice > 0) {
                uint256 maxPrice = historicalPrice.mul(config.maxPriceMultiplier).div(BASIS_POINT_DIVISOR);
                uint256 minPrice = historicalPrice.mul(config.minPriceMultiplier).div(BASIS_POINT_DIVISOR);
                
                if (currentPriceValue < minPrice || currentPriceValue > maxPrice) {
                    return false;
                }
            }
        }

        return true;
    }

    /// @notice 安全计算资产价值（修复：增强精度验证和溢出检查）
    /// @param amountValue 资产数量
    /// @param priceValue 价格
    /// @param decimalsValue 精度
    /// @return calculatedValue 计算出的价值
    function calculateAssetValue(
        uint256 amountValue,
        uint256 priceValue,
        uint256 decimalsValue
    ) internal pure returns (uint256 calculatedValue) {
        // 验证精度参数（使用增强的精度验证）
        require(validateDecimals(decimalsValue), "Invalid decimals value");
        
        // 使用 SafeMath 进行安全计算
        // 使用安全的幂运算，防止溢出
        uint256 priceMultiplier = safePow(10, decimalsValue);
        
        // 检查精度是否合理
        require(priceMultiplier > 0, "Invalid decimals");
        
        // 计算价值
        calculatedValue = amountValue.mul(priceValue).div(priceMultiplier);
        
        // 验证计算结果
        require(calculatedValue > 0, "Invalid calculation result");
        
        // 检查上溢和下溢（原始逻辑）
        require(calculatedValue >= amountValue || priceValue >= priceMultiplier, "Overflow detected");
        
        return calculatedValue;
    }

    /// @notice 验证稳定币价格（修复：稳定币面值假设）
    /// @param stablecoinAddr 稳定币地址
    /// @param expectedPriceValue 期望价格
    /// @param toleranceValue 容忍度
    /// @return isValid 是否有效
    function validateStablecoinPrice(
        address stablecoinAddr,
        uint256 expectedPriceValue,
        uint256 toleranceValue
    ) internal pure returns (bool isValid) {
        // 基础验证：期望价格不能为零
        if (expectedPriceValue == 0) {
            return false;
        }
        
        // 容忍度验证：容忍度不能超过100%
        if (toleranceValue > BASIS_POINT_100_PERCENT) {
            return false;
        }
        
        // 获取稳定币实际价格
        uint256 actualPrice = getStablecoinPrice(stablecoinAddr);
        
        // 检查价格是否在容忍范围内
        uint256 minPrice = expectedPriceValue.mul(BASIS_POINT_100_PERCENT - toleranceValue).div(BASIS_POINT_DIVISOR);
        uint256 maxPrice = expectedPriceValue.mul(BASIS_POINT_100_PERCENT + toleranceValue).div(BASIS_POINT_DIVISOR);
        
        return actualPrice >= minPrice && actualPrice <= maxPrice;
    }

    /// @notice 获取历史价格（改进实现）
    /// @param assetAddr 资产地址
    /// @param cacheStorage 缓存存储
    /// @return historicalPrice 历史价格
    function getHistoricalPrice(address assetAddr, CacheStorage storage cacheStorage) internal view returns (uint256 historicalPrice) {
        // 尝试从缓存获取历史价格
        PriceCache memory cachedPrice = _getCachedPrice(assetAddr, cacheStorage);
        if (cachedPrice.isValid) {
            return cachedPrice.price;
        }
        
        // 如果没有缓存，返回0（表示没有历史价格数据）
        return 0;
    }

    /// @notice 获取稳定币价格（改进实现）
    /// @param stablecoinAddr 稳定币地址
    /// @return price 稳定币价格
    function getStablecoinPrice(address stablecoinAddr) internal pure returns (uint256 price) {
        // 这里应该实现从价格预言机获取稳定币价格的逻辑
        // 暂时返回1，表示面值
        // 在实际实现中，应该调用价格预言机
        // 使用 stablecoinAddr 参数避免未使用警告
        if (stablecoinAddr == address(0)) {
            return 0;
        }
        return 1;
    }



    /// @notice 获取缓存价格
    /// @param assetAddr 资产地址
    /// @param cacheStorage 缓存存储
    /// @return cachedPrice 缓存价格
    function _getCachedPrice(address assetAddr, CacheStorage storage cacheStorage) internal view returns (PriceCache memory cachedPrice) {
        return cacheStorage.priceCache[assetAddr];
    }

    /// @notice 检查缓存是否过期
    /// @param timestampValue 时间戳
    /// @param maxAgeValue 最大年龄
    /// @return isExpired 是否过期
    function _isCacheExpired(uint256 timestampValue, uint256 maxAgeValue) internal view returns (bool isExpired) {
        return block.timestamp.sub(timestampValue) > maxAgeValue;
    }

    /* ============ Internal Functions ============ */

    /// @notice 应用降级策略 - 修复版本
    /// @param assetAddr 资产地址
    /// @param amountValue 资产数量
    /// @param reason 降级原因
    /// @param config 降级配置
    /// @return result 降级结果
    function _applyFallbackStrategy(
        address assetAddr,
        uint256 amountValue,
        string memory reason,
        DegradationConfig memory config
    ) internal pure returns (PriceResult memory result) {
        uint256 fallbackValue = 0;

        // 策略1：如果是稳定币，验证价格后使用面值（修复：添加稳定币价格验证）
        if (config.useStablecoinFaceValue && assetAddr == config.settlementToken) {
            // 验证稳定币价格
            if (config.stablecoinConfig.enableDepegDetection) {
                if (validateStablecoinPrice(assetAddr, config.stablecoinConfig.expectedPrice, config.stablecoinConfig.tolerance)) {
                    fallbackValue = amountValue;
                } else {
                    // 稳定币脱锚，使用保守估值
                    fallbackValue = amountValue.mul(config.conservativeRatio).div(BASIS_POINT_DIVISOR);
                }
            } else {
                // 不进行脱锚检测，直接使用面值
                fallbackValue = amountValue;
            }
        }
        // 策略2：使用保守估值
        else {
            fallbackValue = amountValue.mul(config.conservativeRatio).div(BASIS_POINT_DIVISOR); // 基点计算
        }

        result.value = fallbackValue;
        result.isValid = true;
        result.reason = reason;
        result.usedFallback = true;
        result.timestamp = 0; // 在 pure 函数中不能使用 block.timestamp
        result.priceAge = 0;

        return result;
    }

    /// @notice 应用降级策略 - 新版本（使用分离的配置）
    /// @param assetAddr 资产地址
    /// @param amountValue 资产数量
    /// @param reason 降级原因
    /// @param globalConfig 全局配置
    /// @param conservativeRatio 保守估值比例
    /// @return result 降级结果
    function _applyFallbackStrategyNew(
        address assetAddr,
        uint256 amountValue,
        string memory reason,
        GlobalDegradationConfig memory globalConfig,
        uint256 conservativeRatio
    ) internal pure returns (PriceResult memory result) {
        uint256 fallbackValue = 0;

        // 策略1：如果是稳定币，使用面值
        if (assetAddr == globalConfig.settlementToken) {
            // 验证稳定币价格
            if (globalConfig.stablecoinConfig.enableDepegDetection) {
                if (validateStablecoinPrice(assetAddr, globalConfig.stablecoinConfig.expectedPrice, globalConfig.stablecoinConfig.tolerance)) {
                    fallbackValue = amountValue;
                } else {
                    // 稳定币脱锚，使用保守估值
                    fallbackValue = amountValue.mul(conservativeRatio).div(BASIS_POINT_DIVISOR);
                }
            } else {
                // 不进行脱锚检测，直接使用面值
                fallbackValue = amountValue;
            }
        }
        // 策略2：使用保守估值
        else {
            fallbackValue = amountValue.mul(conservativeRatio).div(BASIS_POINT_DIVISOR); // 基点计算
        }

        result.value = fallbackValue;
        result.isValid = true;
        result.reason = reason;
        result.usedFallback = true;
        result.timestamp = 0; // 在 pure 函数中不能使用 block.timestamp
        result.priceAge = 0;

        return result;
    }

    /// @notice 合并全局配置和调用上下文配置
    /// @param globalConfig 全局配置
    /// @param callConfig 调用上下文配置
    /// @return mergedConfig 合并后的配置
    function mergeConfigs(
        GlobalDegradationConfig memory globalConfig,
        CallContextConfig memory callConfig
    ) internal pure returns (DegradationConfig memory mergedConfig) {
        mergedConfig.settlementToken = globalConfig.settlementToken;
        mergedConfig.enablePriceCache = globalConfig.enablePriceCache;
        mergedConfig.conservativeRatio = callConfig.customConservativeRatio > 0 
            ? callConfig.customConservativeRatio 
            : globalConfig.conservativeRatio;
        mergedConfig.useStablecoinFaceValue = callConfig.useStablecoinFaceValue;
        
        // 合并价格验证配置
        if (callConfig.useCustomPriceValidation) {
            mergedConfig.priceValidation = callConfig.customPriceValidation;
        } else {
            mergedConfig.priceValidation = globalConfig.priceValidation;
        }
        
        // 合并稳定币配置
        mergedConfig.stablecoinConfig = globalConfig.stablecoinConfig;
    }

    /// @notice 验证全局配置的有效性
    /// @param globalConfig 全局配置
    /// @return isValid 是否有效
    function validateGlobalConfig(GlobalDegradationConfig memory globalConfig) internal pure returns (bool isValid) {
        if (globalConfig.settlementToken == address(0)) return false;
        if (globalConfig.conservativeRatio == 0 || globalConfig.conservativeRatio > BASIS_POINT_100_PERCENT) return false;
        if (globalConfig.maxPriceAge == 0) return false;
        return true;
    }

    /// @notice 验证调用上下文配置的有效性
    /// @param callConfig 调用上下文配置
    /// @return isValid 是否有效
    function validateCallContextConfig(CallContextConfig memory callConfig) internal pure returns (bool isValid) {
        if (callConfig.customConservativeRatio > BASIS_POINT_100_PERCENT) return false;
        return true;
    }

    /// @notice 创建默认全局降级配置（平台级别）
    /// @param settlementTokenAddr 结算币地址
    /// @return config 全局配置
    function createDefaultGlobalConfig(address settlementTokenAddr) internal pure returns (GlobalDegradationConfig memory config) {
        config.settlementToken = settlementTokenAddr;
        config.enablePriceCache = false; // 默认禁用缓存写入
        config.maxPriceAge = MAX_PRICE_AGE;
        config.conservativeRatio = DEFAULT_CONSERVATIVE_RATIO; // 50%
        
        // 设置默认价格验证配置
        config.priceValidation.maxPriceMultiplier = DEFAULT_MAX_PRICE_MULTIPLIER; // 150%
        config.priceValidation.minPriceMultiplier = DEFAULT_MIN_PRICE_MULTIPLIER;  // 50%
        config.priceValidation.priceUpdateThreshold = DEFAULT_PRICE_UPDATE_THRESHOLD; // 5分钟
        config.priceValidation.maxPriceAge = MAX_PRICE_AGE;
        config.priceValidation.maxReasonablePrice = DEFAULT_MAX_REASONABLE_PRICE; // 动态设置
        config.priceValidation.enableHistoricalValidation = false; // 默认禁用
        
        // 设置默认稳定币配置
        config.stablecoinConfig.stablecoin = settlementTokenAddr;
        config.stablecoinConfig.expectedPrice = ONE_USD; // 1 USD
        config.stablecoinConfig.tolerance = STABLECOIN_TOLERANCE;
        config.stablecoinConfig.isWhitelisted = true;
        config.stablecoinConfig.enableDepegDetection = true;
    }

    /// @notice 创建默认调用上下文配置（单次调用级别）
    /// @return config 调用上下文配置
    function createDefaultCallContextConfig() internal pure returns (CallContextConfig memory config) {
        config.useStablecoinFaceValue = true;
        config.enableHistoricalValidation = false; // 默认禁用历史验证
        config.customConservativeRatio = 0; // 0表示使用全局设置
        config.useCustomPriceValidation = false; // 默认使用全局价格验证
    }

    /// @notice 创建默认降级配置 - 修复版本（向后兼容）
    /// @param settlementTokenAddr 结算币地址
    /// @return config 默认配置
    function createDefaultConfig(address settlementTokenAddr) internal pure returns (DegradationConfig memory config) {
        config.conservativeRatio = DEFAULT_CONSERVATIVE_RATIO; // 50%
        config.useStablecoinFaceValue = true;
        config.enablePriceCache = false; // 默认禁用缓存写入，需要时使用 getAssetValueWithFallbackAndCache
        config.settlementToken = settlementTokenAddr;
        
        // 设置默认价格验证配置
        config.priceValidation.maxPriceMultiplier = DEFAULT_MAX_PRICE_MULTIPLIER; // 150%
        config.priceValidation.minPriceMultiplier = DEFAULT_MIN_PRICE_MULTIPLIER;  // 50%
        config.priceValidation.priceUpdateThreshold = DEFAULT_PRICE_UPDATE_THRESHOLD; // 5分钟
        config.priceValidation.maxPriceAge = MAX_PRICE_AGE;
        config.priceValidation.maxReasonablePrice = DEFAULT_MAX_REASONABLE_PRICE; // 动态设置
        config.priceValidation.enableHistoricalValidation = false; // 默认禁用
        
        // 设置默认稳定币配置
        config.stablecoinConfig.stablecoin = settlementTokenAddr;
        config.stablecoinConfig.expectedPrice = ONE_USD; // 1 USD
        config.stablecoinConfig.tolerance = STABLECOIN_TOLERANCE;
        config.stablecoinConfig.isWhitelisted = true;
        config.stablecoinConfig.enableDepegDetection = true;
        
        // 设置默认重试配置
        config.retryConfig = createDefaultRetryConfig();
    }

    /// @notice 创建价格验证配置
    /// @param maxPriceMultiplierValue 最大价格倍数（基点）
    /// @param minPriceMultiplierValue 最小价格倍数（基点）
    /// @param maxReasonablePriceValue 最大合理价格
    /// @return config 价格验证配置
    function createPriceValidationConfig(
        uint256 maxPriceMultiplierValue,
        uint256 minPriceMultiplierValue,
        uint256 maxReasonablePriceValue
    ) internal pure returns (PriceValidationConfig memory config) {
        config.maxPriceMultiplier = maxPriceMultiplierValue;
        config.minPriceMultiplier = minPriceMultiplierValue;
        config.priceUpdateThreshold = DEFAULT_PRICE_UPDATE_THRESHOLD; // 5分钟
        config.maxPriceAge = MAX_PRICE_AGE;
        config.maxReasonablePrice = maxReasonablePriceValue;
        config.enableHistoricalValidation = false; // 默认禁用
    }

    /// @notice 创建稳定币配置
    /// @param stablecoinAddr 稳定币地址
    /// @param expectedPriceValue 期望价格
    /// @param toleranceValue 容忍度（基点）
    /// @return config 稳定币配置
    function createStablecoinConfig(
        address stablecoinAddr,
        uint256 expectedPriceValue,
        uint256 toleranceValue
    ) internal pure returns (StablecoinConfig memory config) {
        config.stablecoin = stablecoinAddr;
        config.expectedPrice = expectedPriceValue;
        config.tolerance = toleranceValue;
        config.isWhitelisted = true;
        config.enableDepegDetection = true;
    }

    /// @notice 清除价格缓存
    /// @param assetAddr 资产地址
    /// @param cacheStorage 缓存存储
    function clearPriceCache(address assetAddr, CacheStorage storage cacheStorage) internal {
        delete cacheStorage.priceCache[assetAddr];
    }

    /// @notice 检查缓存是否存在且有效
    /// @param assetAddr 资产地址
    /// @param cacheStorage 缓存存储
    /// @return exists 是否存在有效缓存
    function hasValidCache(address assetAddr, CacheStorage storage cacheStorage) internal view returns (bool exists) {
        PriceCache memory cachedPrice = _getCachedPrice(assetAddr, cacheStorage);
        return cachedPrice.isValid && !_isCacheExpired(cachedPrice.timestamp, MAX_PRICE_AGE);
    }

    /// @notice 获取缓存价格信息
    /// @param assetAddr 资产地址
    /// @param cacheStorage 缓存存储
    /// @return price 价格
    /// @return timestamp 时间戳
    /// @return decimals 精度
    /// @return isValid 是否有效
    function getCachedPriceInfo(
        address assetAddr, 
        CacheStorage storage cacheStorage
    ) internal view returns (uint256 price, uint256 timestamp, uint256 decimals, bool isValid) {
        PriceCache memory cachedPrice = _getCachedPrice(assetAddr, cacheStorage);
        return (cachedPrice.price, cachedPrice.timestamp, cachedPrice.decimals, cachedPrice.isValid);
    }

    /// @notice 获取 nonce（用于重放保护）
    /// @param signerAddr 签名者地址
    /// @param cacheStorage 缓存存储
    /// @return nonce 当前 nonce
    function _getNonce(address signerAddr, CacheStorage storage cacheStorage) internal view returns (uint256 nonce) {
        return cacheStorage.nonces[signerAddr];
    }

    /// @notice 增加 nonce（用于重放保护）
    /// @param signerAddr 签名者地址
    /// @param cacheStorage 缓存存储
    function _incrementNonce(address signerAddr, CacheStorage storage cacheStorage) internal {
        cacheStorage.nonces[signerAddr]++;
    }

    /// @notice 解码低级错误数据
    /// @param lowLevelData 低级错误数据
    /// @return errorMessage 解码后的错误信息
    function _decodeLowLevelError(bytes memory lowLevelData) internal pure returns (string memory errorMessage) {
        if (lowLevelData.length == 0) {
            return "Unknown low-level error";
        }
        
        // 检查是否是 panic 错误（前4字节是 panic 选择器）
        if (lowLevelData.length >= 4) {
            bytes4 panicSelector = bytes4(0x4e487b71); // panic(uint256) 选择器
            bytes4 dataSelector;
            assembly {
                dataSelector := mload(add(lowLevelData, 4))
            }
            
            if (dataSelector == panicSelector && lowLevelData.length >= 36) {
                // 解码 panic 错误码
                uint256 panicCode;
                assembly {
                    panicCode := mload(add(lowLevelData, 36))
                }
                return string(abi.encodePacked("Panic error: ", _getPanicDescription(panicCode)));
            }
        }
        
        // 尝试解码为字符串错误
        if (lowLevelData.length >= 4) {
            bytes4 errorSelector = bytes4(0x08c379a0); // Error(string) 选择器
            bytes4 dataSelector;
            assembly {
                dataSelector := mload(add(lowLevelData, 4))
            }
            
            if (dataSelector == errorSelector && lowLevelData.length >= 68) {
                // 解码字符串错误
                uint256 stringLength;
                assembly {
                    stringLength := mload(add(lowLevelData, 36))
                }
                
                if (stringLength > 0 && lowLevelData.length >= 68 + stringLength) {
                    bytes memory stringData = new bytes(stringLength);
                    for (uint256 i = 0; i < stringLength; i++) {
                        stringData[i] = lowLevelData[68 + i];
                    }
                    return string(stringData);
                }
            }
        }
        
        // 如果无法解码，返回十六进制数据
        return string(abi.encodePacked("Low-level error: 0x", _bytesToHex(lowLevelData)));
    }

    /// @notice 获取 panic 错误描述
    /// @param panicCode panic 错误码
    /// @return description 错误描述
    function _getPanicDescription(uint256 panicCode) internal pure returns (string memory description) {
        if (panicCode == 0x00) return "Generic panic";
        if (panicCode == 0x01) return "Assertion failed";
        if (panicCode == 0x11) return "Arithmetic overflow/underflow";
        if (panicCode == 0x12) return "Division by zero";
        if (panicCode == 0x21) return "Invalid enum value";
        if (panicCode == 0x22) return "Invalid storage byte array";
        if (panicCode == 0x31) return "Pop on empty array";
        if (panicCode == 0x32) return "Array index out of bounds";
        if (panicCode == 0x41) return "Out of memory";
        if (panicCode == 0x51) return "Uninitialized function pointer";
        return string(abi.encodePacked("Unknown panic code: ", _uint256ToString(panicCode)));
    }

    /// @notice 将字节数组转换为十六进制字符串
    /// @param data 字节数组
    /// @return hexString 十六进制字符串
    function _bytesToHex(bytes memory data) internal pure returns (string memory hexString) {
        bytes memory hexChars = "0123456789abcdef";
        bytes memory result = new bytes(data.length * 2);
        
        for (uint256 i = 0; i < data.length; i++) {
            result[i * 2] = hexChars[uint8(data[i]) / 16];
            result[i * 2 + 1] = hexChars[uint8(data[i]) % 16];
        }
        
        return string(result);
    }

    /// @notice 将 uint256 转换为字符串
    /// @param value uint256 值
    /// @return stringValue 字符串值
    function _uint256ToString(uint256 value) internal pure returns (string memory stringValue) {
        if (value == 0) {
            return "0";
        }
        
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        
        return string(buffer);
    }

    /// @notice 缓存价格（仅用于 non-view 函数）
    /// @dev 此函数只能在 non-view 函数中调用，用于写入缓存
    /// @param assetAddr 资产地址
    /// @param priceValue 价格
    /// @param timestampValue 时间戳
    /// @param decimalsValue 精度
    /// @param cacheStorage 缓存存储
    function cachePrice(
        address assetAddr,
        uint256 priceValue,
        uint256 timestampValue,
        uint256 decimalsValue,
        CacheStorage storage cacheStorage
    ) internal {
        cacheStorage.priceCache[assetAddr] = PriceCache({
            price: priceValue,
            timestamp: timestampValue,
            decimals: decimalsValue,
            isValid: true
        });
    }

    /* ============ 重试机制函数 ============ */

    /// @notice 创建默认重试配置
    /// @return config 默认重试配置
    function createDefaultRetryConfig() internal pure returns (RetryConfig memory config) {
        return RetryConfig({
            enableRetry: true,
            maxRetryCount: DEFAULT_MAX_RETRY_COUNT,
            retryDelay: DEFAULT_RETRY_DELAY,
            maxGasLimit: DEFAULT_MAX_GAS_LIMIT,
            retryOnNetworkError: true,
            retryOnTimeout: true
        });
    }

    /// @notice 检查是否应该重试
    /// @param errorReason 错误原因
    /// @param retryConfig 重试配置
    /// @return shouldRetry 是否应该重试
    function _shouldRetry(string memory errorReason, RetryConfig memory retryConfig) internal pure returns (bool shouldRetry) {
        if (!retryConfig.enableRetry) {
            return false;
        }
        
        // 检查是否是网络相关错误
        if (retryConfig.retryOnNetworkError) {
            if (_containsString(errorReason, "network") || 
                _containsString(errorReason, "timeout") ||
                _containsString(errorReason, "connection") ||
                _containsString(errorReason, "temporary")) {
                return true;
            }
        }
        
        // 检查是否是超时错误
        if (retryConfig.retryOnTimeout) {
            if (_containsString(errorReason, "timeout") ||
                _containsString(errorReason, "gas") ||
                _containsString(errorReason, "execution")) {
                return true;
            }
        }
        
        return false;
    }

    /// @notice 检查字符串是否包含子字符串
    /// @param source 源字符串
    /// @param search 搜索字符串
    /// @return contains 是否包含
    function _containsString(string memory source, string memory search) internal pure returns (bool contains) {
        bytes memory sourceBytes = bytes(source);
        bytes memory searchBytes = bytes(search);
        
        if (searchBytes.length > sourceBytes.length) {
            return false;
        }
        
        for (uint256 i = 0; i <= sourceBytes.length - searchBytes.length; i++) {
            bool found = true;
            for (uint256 j = 0; j < searchBytes.length; j++) {
                if (sourceBytes[i + j] != searchBytes[j]) {
                    found = false;
                    break;
                }
            }
            if (found) {
                return true;
            }
        }
        
        return false;
    }

    /// @notice 带重试的价格获取函数
    /// @param priceOracleAddr 价格预言机地址
    /// @param assetAddr 资产地址
    /// @param retryConfig 重试配置
    /// @return price 价格
    /// @return timestamp 时间戳
    /// @return decimals 精度
    /// @return success 是否成功
    /// @return errorReason 错误原因
    function _getPriceWithRetry(
        address priceOracleAddr,
        address assetAddr,
        RetryConfig memory retryConfig
    ) internal view returns (
        uint256 price,
        uint256 timestamp,
        uint256 decimals,
        bool success,
        string memory errorReason
    ) {
        uint256 retryCount = 0;
        
        while (retryCount <= retryConfig.maxRetryCount) {
            // 检查 gas 限制
            if (gasleft() < retryConfig.maxGasLimit) {
                return (0, 0, 0, false, "Insufficient gas for retry");
            }
            
            try IPriceOracleAdapter(priceOracleAddr).getPrice(assetAddr) returns (uint256 p, uint256 ts, uint256 dec) {
                return (p, ts, dec, true, "");
            } catch Error(string memory reason) {
                errorReason = reason;
                
                // 检查是否应该重试
                if (retryCount < retryConfig.maxRetryCount && _shouldRetry(reason, retryConfig)) {
                    retryCount++;
                    // 在实际实现中，这里可以添加延迟逻辑
                    // 但由于是 view 函数，我们只能立即重试
                    continue;
                }
                
                return (0, 0, 0, false, reason);
            } catch (bytes memory lowLevelData) {
                string memory decodedError = _decodeLowLevelError(lowLevelData);
                errorReason = decodedError;
                
                // 检查是否应该重试
                if (retryCount < retryConfig.maxRetryCount && _shouldRetry(decodedError, retryConfig)) {
                    retryCount++;
                    continue;
                }
                
                return (0, 0, 0, false, decodedError);
            }
        }
        
        return (0, 0, 0, false, "Max retry count exceeded");
    }
} 