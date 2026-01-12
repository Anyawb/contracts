// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { IPriceOracle } from "../interfaces/IPriceOracle.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { IRegistry } from "../interfaces/IRegistry.sol";
import { IRegistryUpgradeEvents } from "../interfaces/IRegistryUpgradeEvents.sol";
import { VaultTypes } from "../Vault/VaultTypes.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ZeroAddress, ExternalModuleRevertedRaw, EmptyArray, ArrayLengthMismatch } from "../errors/StandardErrors.sol";
import { GracefulDegradation } from "../libraries/GracefulDegradation.sol";
import { DataPushLibrary } from "../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../constants/DataPushTypes.sol";

/// @title CoinGeckoPriceUpdater
/// @notice 从 CoinGecko API 获取价格并更新预言机的合约
/// @dev 支持批量价格更新和自动重试机制
/// @dev 与 Registry 系统集成，使用标准化的模块管理
/// @dev 与 ACM 权限模块集成，使用 ActionKeys 进行标准化权限管理
/// @dev 与 ActionKeys 和 ModuleKeys 集成，提供标准化的模块管理
/// @dev 与 VaultTypes 集成，提供标准化的事件记录
/// @dev 使用 StandardErrors 进行统一的错误处理
/// @dev 集成 GracefulDegradation 库进行价格验证和健康检查
/// @custom:security-contact security@example.com
contract CoinGeckoPriceUpdater is Initializable, UUPSUpgradeable, IRegistryUpgradeEvents {
    using GracefulDegradation for *;

    /* ============ Constants ============ */
    
    /// @notice 最大重试次数
    uint256 private constant MAX_RETRY_COUNT = 3;
    
    /// @notice 价格更新间隔（秒）
    uint256 private constant UPDATE_INTERVAL = 300; // 5分钟
    
    /// @notice 价格验证阈值（百分比）
    uint256 private constant PRICE_VALIDATION_THRESHOLD = 5000; // 50%
    
    /// @notice 最大价格偏差（百分比）
    uint256 private constant MAX_PRICE_DEVIATION = 1000; // 10%

    /* ============ Storage ============ */
    
    /// @notice Registry 合约地址
    address private _registryAddr;
    
    /// @notice 资产到 CoinGecko ID 的映射
    mapping(address => string) private _assetToCoingeckoId;
    
    /// @notice 支持的资产列表
    address[] private _supportedAssets;
    
    /// @notice 最后更新时间映射
    mapping(address => uint256) private _lastUpdateTime;
    
    /// @notice 价格更新失败计数
    mapping(address => uint256) private _updateFailureCount;
    
    /// @notice 资产最后有效价格
    mapping(address => uint256) private _lastValidPrice;
    
    /// @notice 是否启用自动更新
    bool private _autoUpdateEnabled;
    
    /// @notice 是否启用价格验证
    bool private _priceValidationEnabled;
    
    /// @notice 动态注册的监控合约映射
    mapping(bytes32 => address) private _dynamicMonitors;
    
    /// @notice 已注册的监控键列表
    bytes32[] private _registeredMonitorKeys;
    
    /// @notice 备用价格源映射
    mapping(bytes32 => address) private _backupPriceSources;
    
    /// @notice 已注册的备用价格源键列表
    bytes32[] private _registeredBackupKeys;
    
    /// @notice 监控服务状态映射
    mapping(address => bool) private _monitoringStatus;
    
    /// @dev Storage gap for future upgrades
    uint256[42] private __gap;

    /* ============ Errors ============ */
    error CoinGeckoPriceUpdater__InvalidPrice();
    error CoinGeckoPriceUpdater__InvalidTimestamp();
    error CoinGeckoPriceUpdater__AssetNotConfigured();
    error CoinGeckoPriceUpdater__InvalidMonitorContract();
    error CoinGeckoPriceUpdater__MonitorNotAContract(address monitorContract);

    /* ============ Events ============ */
    
    /// @notice 价格更新成功事件
    /// @param coingeckoId CoinGecko ID
    event PriceUpdated(
        address indexed asset,
        string indexed coingeckoId,
        uint256 price,
        uint256 timestamp
    );
    
    /// @notice 价格更新失败事件
    /// @param coingeckoId CoinGecko ID
    /// @param reasonCode 失败原因代码
    event PriceUpdateFailed(
        address indexed asset,
        string indexed coingeckoId,
        bytes32 reasonCode
    );
    
    /// @notice 资产配置更新事件
    event AssetConfigUpdated(address indexed asset, string indexed coingeckoId, bool isActive);
    
    /// @notice 自动更新状态变更事件
    event AutoUpdateToggled(bool enabled);

    /// @notice 价格验证失败事件
    event PriceValidationFailed(address indexed asset, uint256 price, bytes32 reasonCode);

    /// @notice 价格验证开关切换事件
    event PriceValidationToggled(bool enabled);

    /// @notice Registry 地址更新事件
    /// @param oldRegistry 旧 Registry 地址
    /// @param newRegistry 新 Registry 地址
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);

    /// @notice 监控服务注册事件
    event MonitoringRegistered(bytes32 indexed monitorKey, address indexed monitorContract, string monitorName);
    
    /// @notice 备用价格源注册事件
    event BackupSourceRegistered(bytes32 indexed backupKey, address indexed backupSource, string sourceName);

    /// @notice 健康检查失败事件
    /// @param reasonCode 失败原因代码
    event HealthCheckFailed(
        address indexed asset,
        bytes32 reasonCode
    );

    // ============ Reason codes ============
    bytes32 private constant REASON_VALIDATION_FAILED = bytes32("VALIDATION_FAILED");
    bytes32 private constant REASON_EXCEEDS_MAX_VALUE = bytes32("EXCEEDS_MAX_VALUE");
    bytes32 private constant REASON_MONITOR_CALL_FAILED = bytes32("MONITOR_CALL_FAILED");
    bytes32 private constant REASON_ORACLE_UNAVAILABLE = bytes32("ORACLE_UNAVAILABLE");
    bytes32 private constant REASON_ORACLE_UPDATE_FAILED = bytes32("ORACLE_UPDATE_FAILED");

    /* ============ DataPush: Unified data types moved to DataPushTypes ============ */
    
    /* ============ Modifiers ============ */
    
    /// @notice 验证 Registry 地址
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }
    
    /// @notice 验证监控合约
    modifier validMonitorContract(address monitorContract) {
        if (monitorContract == address(0)) revert ZeroAddress();
        if (monitorContract.code.length == 0) revert CoinGeckoPriceUpdater__MonitorNotAContract(monitorContract);
        _;
    }

    /* ============ Initializer ============ */
    
    /// @notice 初始化合约
    /// @param initialRegistryAddr Registry 合约地址
    function initialize(
        address initialRegistryAddr
    ) external initializer {
        __UUPSUpgradeable_init();
        
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        
        _registryAddr = initialRegistryAddr;
        _autoUpdateEnabled = true;
        _priceValidationEnabled = true;
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /* ============ External Functions ============ */
    
    /// @notice 更新单个资产价格
    /// @dev 价格为 8 位小数
    /// @dev 需要 ACTION_UPDATE_PRICE 权限，使用 ActionKeys 进行标准化事件记录
    function updateAssetPrice(
        address asset,
        uint256 price,
        uint256 timestamp
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UPDATE_PRICE, msg.sender);
        
        if (asset == address(0)) revert ZeroAddress();
        if (price == 0) revert CoinGeckoPriceUpdater__InvalidPrice();
        if (timestamp > block.timestamp) revert CoinGeckoPriceUpdater__InvalidTimestamp();
        
        string memory coingeckoId = _assetToCoingeckoId[asset];
        if (bytes(coingeckoId).length == 0) revert CoinGeckoPriceUpdater__AssetNotConfigured();
        
        // 价格验证
        if (_priceValidationEnabled && !_validatePrice(asset, price)) {
            emit PriceValidationFailed(asset, price, REASON_VALIDATION_FAILED);
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_PRICE_VALIDATION_FAILED,
                abi.encode(asset, price, block.timestamp)
            );
            return;
        }
        
        // 使用优雅降级进行价格更新（完全内联，零gas开销）
        _updatePriceWithGracefulDegradation(asset, price, timestamp, coingeckoId);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPDATE_PRICE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPDATE_PRICE),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 批量更新资产价格
    /// @dev 需要 ACTION_UPDATE_PRICE 权限，使用 ActionKeys 进行标准化事件记录
    function updateAssetPrices(
        address[] calldata assets,
        uint256[] calldata prices,
        uint256[] calldata timestamps
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UPDATE_PRICE, msg.sender);
        
        uint256 length = assets.length;
        if (length == 0) revert EmptyArray();
        if (length != prices.length) revert ArrayLengthMismatch(length, prices.length);
        if (length != timestamps.length) revert ArrayLengthMismatch(length, timestamps.length);
        
        // 使用优雅降级批量更新（完全内联，零gas开销）
        _batchUpdatePriceWithGracefulDegradation(assets, prices, timestamps);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPDATE_PRICE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPDATE_PRICE),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 配置资产
    /// @param coingeckoId CoinGecko ID
    /// @dev 需要 ACTION_SET_PARAMETER 权限，使用 ActionKeys 进行标准化事件记录
    function configureAsset(address asset, string calldata coingeckoId) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        if (asset == address(0)) revert ZeroAddress();
        if (bytes(coingeckoId).length == 0) revert("Invalid CoinGecko ID");
        
        _assetToCoingeckoId[asset] = coingeckoId;
        // 移除 _supportedAssets 维护，改由映射判断是否配置
        
        emit AssetConfigUpdated(asset, coingeckoId, true);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 移除资产配置
    /// @dev 需要 ACTION_SET_PARAMETER 权限，使用 ActionKeys 进行标准化事件记录
    function removeAsset(address asset) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        if (asset == address(0)) revert ZeroAddress();
        
        string memory coingeckoId = _assetToCoingeckoId[asset];
        if (bytes(coingeckoId).length == 0) revert("Asset not configured");
        
        delete _assetToCoingeckoId[asset];
        
        // 不再维护支持列表数组，仅清除映射配置
        
        emit AssetConfigUpdated(asset, coingeckoId, false);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 切换自动更新状态
    /// @param enabled 是否启用
    /// @dev 需要 ACTION_SET_PARAMETER 权限，使用 ActionKeys 进行标准化事件记录
    function toggleAutoUpdate(bool enabled) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        _autoUpdateEnabled = enabled;
        emit AutoUpdateToggled(enabled);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_AUTO_UPDATE_TOGGLED,
            abi.encode(enabled, msg.sender, block.timestamp)
        );
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 切换价格验证状态
    /// @param enabled 是否启用
    /// @dev 需要 ACTION_SET_PARAMETER 权限，使用 ActionKeys 进行标准化事件记录
    function togglePriceValidation(bool enabled) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        _priceValidationEnabled = enabled;
        emit PriceValidationToggled(enabled);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_PRICE_VALIDATION_TOGGLED,
            abi.encode(enabled, msg.sender, block.timestamp)
        );
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 更新 Registry 地址
    /// @param newRegistryAddr 新 Registry 地址
    function updateRegistry(address newRegistryAddr) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        
        address oldRegistry = _registryAddr;
        
        // 更新Registry地址
        _registryAddr = newRegistryAddr;
        
        emit RegistryUpdated(oldRegistry, newRegistryAddr);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_REGISTRY_UPDATED,
            abi.encode(oldRegistry, newRegistryAddr, msg.sender, block.timestamp)
        );
        
        // 通知监控服务Registry升级（传送合约地址给优雅降级监控）
        _notifyMonitors(address(0), "REGISTRY_UPGRADE", abi.encode(oldRegistry, newRegistryAddr, block.timestamp));
    }

    /* ============ Dynamic Registry Functions ============ */
    
    /// @notice 注册监控服务
    function registerMonitoring(address monitorContract, string calldata monitorName) 
        external onlyValidRegistry validMonitorContract(monitorContract) {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // 模块键生成：保持确定性（不做链上缓存，避免额外存储与 stale 语义）
        bytes32 monitorKey = _makeModuleKey("MONITOR", monitorName);
        _dynamicMonitors[monitorKey] = monitorContract;
        _registeredMonitorKeys.push(monitorKey);
        _monitoringStatus[monitorContract] = true;
        
        emit MonitoringRegistered(monitorKey, monitorContract, monitorName);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_MONITORING_REGISTERED,
            abi.encode(monitorKey, monitorContract, monitorName, msg.sender, block.timestamp)
        );
    }
    
    /// @notice 注册备用价格源
    function registerBackupPriceSource(address backupSource, string calldata sourceName) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (backupSource == address(0)) revert ZeroAddress();
        
        bytes32 backupKey = _makeModuleKey("BACKUP_SOURCE", sourceName);
        _backupPriceSources[backupKey] = backupSource;
        _registeredBackupKeys.push(backupKey);
        
        emit BackupSourceRegistered(backupKey, backupSource, sourceName);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_BACKUP_SOURCE_REGISTERED,
            abi.encode(backupKey, backupSource, sourceName, msg.sender, block.timestamp)
        );
    }
    
    /// @notice 通知所有监控服务
    /// @param eventType 事件类型
    /// @param eventData 事件数据
    /// @dev 内部函数，在价格更新时调用
    function _notifyMonitors(
        address asset, 
        string memory eventType, 
        bytes memory eventData
    ) private {
        for (uint256 i = 0; i < _registeredMonitorKeys.length; i++) {
            bytes32 monitorKey = _registeredMonitorKeys[i];
            address monitorContract = _dynamicMonitors[monitorKey];
            if (monitorContract != address(0)) {
                (bool success, ) = monitorContract.call(
                    abi.encodeWithSignature(
                        "onPriceUpdate(address,string,bytes)", 
                        asset, 
                        eventType, 
                        eventData
                    )
                );
                if (!success) {
                    emit HealthCheckFailed(asset, REASON_MONITOR_CALL_FAILED);
                }
            }
        }
    }

    /* ============ 基础查询功能 (保留在主文件) ============ */
    
    /// @notice 检查资产是否需要更新
    /// @return needsUpdate 是否需要更新
    function needsUpdate(address asset) external view returns (bool) {
        if (asset == address(0)) return false;
        if (!_autoUpdateEnabled) return false;
        
        uint256 lastUpdate = _lastUpdateTime[asset];
        return block.timestamp - lastUpdate > UPDATE_INTERVAL;
    }
    
    // 查询接口已下沉到 View 层（ValuationOracleView）。如需资产信息、健康检查、批量查询等，请使用 View 模块。

    /* ============ 复杂查询功能 (委托View合约) ============ */
    
    /// @notice 批量检查价格预言机健康状态
    /// @return healthStatus 健康状态数组
    /// @dev 委托给View合约处理复杂批量查询
    // 批量健康检查等复杂查询功能请直接调用 View 层。

    /* ============ Registry查询功能 (通过Registry调用) ============ */
    
    /// @notice 获取模块地址
    /// @param moduleKey 模块键
    /// @return 模块地址
    // Registry 相关的通用查询，请通过专用 View/Registry 管理模块进行。

    /* ============ Internal Functions ============ */
    
    /// @notice 验证价格是否合理（使用GracefulDegradation库，完全内联）
    /// @return isValid 价格是否有效
    function _validatePrice(address asset, uint256 price) internal view returns (bool isValid) {
        if (price == 0) return false;
        
        // 使用 GracefulDegradation 库的价格验证标准（完全内联，零gas开销）
        if (price > GracefulDegradation.MAX_REASONABLE_PRICE) return false;
        
        uint256 lastPrice = _lastValidPrice[asset];
        if (lastPrice == 0) return true; // 首次更新
        
        // Solidity 0.8+ 自带溢出/下溢检查：直接使用运算符即可
        uint256 diff = price > lastPrice ? (price - lastPrice) : (lastPrice - price);
        uint256 deviation = diff * 10000 / lastPrice;
        
        return deviation <= MAX_PRICE_DEVIATION;
    }
    
    /// @notice 验证用户权限（带优雅降级）
    /// @param actionKey 动作键
    /// @param user 用户地址
    function _requireRole(bytes32 actionKey, address user) internal view {
        if (_registryAddr == address(0)) revert ZeroAddress();
        address acmAddr = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }
    
    /// @notice 正常价格更新流程
    /// @param coingeckoId CoinGecko ID
    function _normalPriceUpdate(
        address asset,
        uint256 price,
        uint256 timestamp,
        string memory coingeckoId
    ) external {
        if (msg.sender != address(this)) revert CoinGeckoPriceUpdater__InvalidMonitorContract();
        
        // 通过 Registry 获取 PriceOracle 地址
        address priceOracleAddr = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_PRICE_ORACLE);
        
        // 确保PriceOracle中已配置该资产
        try IPriceOracle(priceOracleAddr).configureAsset(asset, coingeckoId, 8, 3600) {
            // 配置成功，继续更新价格
        } catch {
            // 如果配置失败，可能是已经配置过了，继续尝试更新价格
        }
        
        IPriceOracle(priceOracleAddr).updatePrice(asset, price, timestamp);
        _lastUpdateTime[asset] = block.timestamp;
        _updateFailureCount[asset] = 0;
        _lastValidPrice[asset] = price;
        
        emit PriceUpdated(asset, coingeckoId, price, timestamp);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_PRICE_UPDATED,
            abi.encode(asset, price, timestamp, coingeckoId, msg.sender, block.timestamp)
        );
        
        // 通知监控服务
        _notifyMonitors(
            asset, 
            "PRICE_UPDATE_SUCCESS", 
            abi.encode(price, timestamp, coingeckoId)
        );
    }
    
    /// @notice 应急价格更新流程（当Registry或PriceOracle失败时）
    /// @param coingeckoId CoinGecko ID
    function _emergencyPriceUpdate(
        address asset,
        uint256 price,
        uint256 timestamp,
        string memory coingeckoId
    ) external {
        if (msg.sender != address(this)) revert CoinGeckoPriceUpdater__InvalidMonitorContract();
        
        // 应急模式：只更新本地记录，不依赖外部模块
        _lastUpdateTime[asset] = block.timestamp;
        _updateFailureCount[asset] = 0;
        _lastValidPrice[asset] = price;
        
        emit PriceUpdated(asset, coingeckoId, price, timestamp);
        emit HealthCheckFailed(asset, REASON_ORACLE_UNAVAILABLE);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_PRICE_UPDATED,
            abi.encode(asset, price, timestamp, coingeckoId, msg.sender, block.timestamp)
        );
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_MODULE_HEALTH,
            abi.encode(address(this), "PriceOracle", false, "Emergency mode: Oracle unavailable", block.timestamp)
        );
        
        // 在应急模式下不通知监控服务，避免级联失败
    }
    
    /// @notice 价格更新带优雅降级（使用internal library，零gas开销）
    /// @param coingeckoId CoinGecko ID
    function _updatePriceWithGracefulDegradation(
        address asset,
        uint256 price,
        uint256 timestamp,
        string memory coingeckoId
    ) internal {
        // 使用GracefulDegradation库验证价格合理性（完全内联）
        if (price > GracefulDegradation.MAX_REASONABLE_PRICE) {
            emit PriceValidationFailed(asset, price, REASON_EXCEEDS_MAX_VALUE);
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_PRICE_VALIDATION_FAILED,
                abi.encode(asset, price, block.timestamp)
            );
            return;
        }
        
        // 尝试正常价格更新
        if (_registryAddr != address(0)) {
            try IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_PRICE_ORACLE) returns (address priceOracleAddr) {
                // 使用GracefulDegradation库检查预言机健康状态（完全内联）
                (bool isHealthy, string memory healthDetails) = GracefulDegradation.checkPriceOracleHealth(priceOracleAddr, asset);
                
                if (isHealthy) {
                    if (_executeSingleNormalPriceUpdate(priceOracleAddr, asset, price, timestamp, coingeckoId)) {
                        // 通知监控服务
                        _notifyMonitors(
                            asset, 
                            "PRICE_UPDATE_SUCCESS", 
                            abi.encode(price, timestamp, coingeckoId)
                        );
                        return; // 正常更新成功
                    }
                } else {
                    emit HealthCheckFailed(asset, REASON_ORACLE_UNAVAILABLE);
                    DataPushLibrary._emitData(
                        DataPushTypes.DATA_TYPE_MODULE_HEALTH,
                        abi.encode(priceOracleAddr, "PriceOracle", false, healthDetails, block.timestamp)
                    );
                }
            } catch {
                // Registry失败，继续到应急模式
            }
        }
        
        // 应急模式：只更新本地记录
        _executeSingleEmergencyPriceUpdate(asset, price, timestamp, coingeckoId);
    }
    
    /// @notice 批量价格更新带优雅降级（使用internal library，零gas开销）
    function _batchUpdatePriceWithGracefulDegradation(
        address[] calldata assets,
        uint256[] calldata prices,
        uint256[] calldata timestamps
    ) internal {
        uint256 length = assets.length;
        address priceOracleAddr;
        bool oracleAvailable = false;
        
        // 一次性检查Oracle可用性，优化gas消耗
        if (_registryAddr != address(0)) {
            try IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_PRICE_ORACLE) returns (address oracle) {
                priceOracleAddr = oracle;
                oracleAvailable = true;
            } catch {
                // Registry失败，使用应急模式
            }
        }
        
        for (uint256 i = 0; i < length; i++) {
            address asset = assets[i];
            uint256 price = prices[i];
            uint256 timestamp = timestamps[i];
            
            // 基本验证
            if (asset == address(0) || price == 0 || timestamp > block.timestamp) continue;
            
            string memory coingeckoId = _assetToCoingeckoId[asset];
            if (bytes(coingeckoId).length == 0) continue;
            
            // 使用GracefulDegradation库验证价格合理性（完全内联）
            if (price > GracefulDegradation.MAX_REASONABLE_PRICE) {
                emit PriceValidationFailed(asset, price, REASON_EXCEEDS_MAX_VALUE);
                DataPushLibrary._emitData(
                    DataPushTypes.DATA_TYPE_PRICE_VALIDATION_FAILED,
                    abi.encode(asset, price, block.timestamp)
                );
                continue;
            }
            
            // 尝试正常更新
            if (oracleAvailable) {
                // 使用GracefulDegradation库检查预言机健康状态（完全内联）
                (bool isHealthy,) = GracefulDegradation.checkPriceOracleHealth(priceOracleAddr, asset);
                
                if (isHealthy && _executeSingleNormalPriceUpdate(priceOracleAddr, asset, price, timestamp, coingeckoId)) {
                    continue; // 正常更新成功
                }
            }
            
            // 应急模式更新
            _executeSingleEmergencyPriceUpdate(asset, price, timestamp, coingeckoId);
        }
    }
    
    /// @notice 单个资产的正常价格更新（内联版本）
    function _executeSingleNormalPriceUpdate(
        address priceOracleAddr,
        address asset,
        uint256 price,
        uint256 timestamp,
        string memory coingeckoId
    ) internal returns (bool success) {
        try IPriceOracle(priceOracleAddr).configureAsset(asset, coingeckoId, 8, 3600) {
            // 配置成功
        } catch {
            // 可能已配置，继续
        }
        
        try IPriceOracle(priceOracleAddr).updatePrice(asset, price, timestamp) {
            _lastUpdateTime[asset] = block.timestamp;
            _updateFailureCount[asset] = 0;
            _lastValidPrice[asset] = price;
            
            emit PriceUpdated(asset, coingeckoId, price, timestamp);
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_PRICE_UPDATED,
                abi.encode(asset, price, timestamp, coingeckoId, msg.sender, block.timestamp)
            );
            return true;
        } catch (bytes memory error) {
            emit VaultTypes.ExternalModuleReverted("PriceOracle", error, block.timestamp);
            _updateFailureCount[asset]++;
            emit PriceUpdateFailed(asset, coingeckoId, REASON_ORACLE_UPDATE_FAILED);
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_PRICE_UPDATE_FAILED,
                abi.encode(asset, coingeckoId, error, block.timestamp)
            );
            return false;
        }
    }
    
    /// @notice 单个资产的应急价格更新（内联版本）
    function _executeSingleEmergencyPriceUpdate(
        address asset,
        uint256 price,
        uint256 timestamp,
        string memory coingeckoId
    ) internal {
        _lastUpdateTime[asset] = block.timestamp;
        _updateFailureCount[asset] = 0;
        _lastValidPrice[asset] = price;
        
        emit PriceUpdated(asset, coingeckoId, price, timestamp);
        emit HealthCheckFailed(asset, REASON_ORACLE_UNAVAILABLE);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_PRICE_UPDATED,
            abi.encode(asset, price, timestamp, coingeckoId, msg.sender, block.timestamp)
        );
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_MODULE_HEALTH,
            abi.encode(address(this), "PriceOracle", false, "Emergency mode: Oracle unavailable", block.timestamp)
        );
    }

    /// @notice 验证用户是否有查看权限（VIEWER级别或更高）
    /// @param user 用户地址
    /// @dev 普通用户需要至少VIEWER权限，管理员及以上可查看所有信息
    // Removed _requireViewerOrAdmin to reduce size; viewers should use View modules

    // ============ Internal helpers ============
    /// @notice 生成确定性的模块键
    /// @dev 注意：历史上 key 使用 `keccak256(abi.encodePacked(prefix, name))`（不含 "_"），保持兼容。
    function _makeModuleKey(string memory prefix, string memory name) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(prefix, name));
    }
    
    
    
    /// @notice 获取模块地址（通过Registry）
    /// @param moduleKey 模块键
    /// @return 模块地址
    function _getModule(bytes32 moduleKey) internal view returns (address) {
        if (_registryAddr == address(0)) return address(0);
        
        try IRegistry(_registryAddr).getModuleOrRevert(moduleKey) returns (address moduleAddr) {
            return moduleAddr;
        } catch {
            return address(0);
        }
    }

    /* ============ UUPS Upgradeable ============ */
    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address /* newImplementation */) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.timestamp
        );
    }
} 