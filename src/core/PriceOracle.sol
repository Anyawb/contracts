// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { IPriceOracle } from "../interfaces/IPriceOracle.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { IRegistry } from "../interfaces/IRegistry.sol";
import { IRegistryUpgradeEvents } from "../interfaces/IRegistryUpgradeEvents.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { VaultTypes } from "../Vault/VaultTypes.sol";
import { ZeroAddress, AmountMismatch } from "../errors/StandardErrors.sol";

// Error definitions
error PriceOracle__AssetAlreadySupported();
error PriceOracle__AssetNotSupported();
error PriceOracle__StalePrice();
error PriceOracle__InvalidPrice();
error PriceOracle__Unauthorized();

/// @title PriceOracle 价格预言机实现
/// @notice 基于 Coingecko API 的多资产价格预言机
/// @dev 支持实时价格更新和批量操作，遵循安全标准
/// @dev 与 Registry 系统集成，使用标准化的模块管理
/// @dev 与 ActionKeys 和 ModuleKeys 集成，提供标准化的模块管理
/// @dev 使用 StandardErrors 进行统一的错误处理
/// @dev 使用ACM进行权限控制，确保系统安全性
/// @dev 集成 GracefulDegradation 库进行价格验证和健康检查
/// @custom:security-contact security@example.com
contract PriceOracle is Initializable, UUPSUpgradeable, IPriceOracle, IRegistryUpgradeEvents {

    /* ============ Constants ============ */
    
    /// @notice 价格精度（8 位小数）
    uint256 internal constant PRICE_DECIMALS_VALUE = 8;
    
    /// @notice 默认最大价格年龄（1 小时）
    uint256 internal constant DEFAULT_MAX_PRICE_AGE_VALUE = 3600;
    /// @notice 兼容：原 public 常量 PRICE_DECIMALS 的显式 getter
    function PRICE_DECIMALS() external pure returns (uint256) { return PRICE_DECIMALS_VALUE; }

    /// @notice 兼容：原 public 常量 DEFAULT_MAX_PRICE_AGE 的显式 getter
    function DEFAULT_MAX_PRICE_AGE() external pure returns (uint256) { return DEFAULT_MAX_PRICE_AGE_VALUE; }

    /* ============ Storage ============ */
    
    /// @notice Registry 合约地址（私有存储，外部通过 getRegistry 查询）
    address private _registryAddr;
    
    /// @notice 资产价格映射：asset => PriceData
    mapping(address => PriceData) private _prices;
    
    /// @notice 资产配置映射：asset => AssetConfig
    mapping(address => AssetConfig) private _assetConfigs;
    
    /// @notice 支持的资产列表
    address[] private _supportedAssets;

    /// @notice 资产索引映射（值为索引+1，0 表示不存在），用于 O(1) 移除
    mapping(address => uint256) private _assetIndexPlus1;

    /// @dev Storage gap for future upgrades
    uint256[50] private __gap;

    /* ============ Modifiers ============ */
    
    /// @notice 验证 Registry 地址
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    /* ============ Initializer ============ */
    
    /// @notice 初始化价格预言机
    /// @param initialRegistryAddr Registry 合约地址
    /// @dev 使用 Registry 进行模块管理，使用 StandardErrors 进行错误处理
    function initialize(address initialRegistryAddr) external initializer {
        __UUPSUpgradeable_init();
        
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        
        _registryAddr = initialRegistryAddr;
        
        // 设置默认资产配置
        _setupDefaultAssets();
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /* ============ External View Functions ============ */
    
    /// @inheritdoc IPriceOracle
    function getPrice(address asset) external view override returns (uint256 price, uint256 timestamp, uint256 decimals) {
        if (asset == address(0)) revert ZeroAddress();
        if (!_assetConfigs[asset].isActive) revert PriceOracle__AssetNotSupported();
        
        PriceData memory priceData = _prices[asset];
        if (!priceData.isValid) revert PriceOracle__InvalidPrice();
        if (block.timestamp - priceData.timestamp > _assetConfigs[asset].maxPriceAge) {
            revert PriceOracle__StalePrice();
        }
        
        return (priceData.price, priceData.timestamp, priceData.decimals);
    }

    /// @inheritdoc IPriceOracle
    function getPriceData(address asset) external view override returns (PriceData memory priceData) {
        if (asset == address(0)) revert ZeroAddress();
        if (!_assetConfigs[asset].isActive) revert PriceOracle__AssetNotSupported();
        
        priceData = _prices[asset];
        if (!priceData.isValid) revert PriceOracle__InvalidPrice();
    }

    /// @inheritdoc IPriceOracle
    function getAssetConfig(address asset) external view override returns (AssetConfig memory config) {
        if (asset == address(0)) revert ZeroAddress();
        config = _assetConfigs[asset];
    }

    /// @inheritdoc IPriceOracle
    function getSupportedAssets() external view returns (address[] memory) {
        return _supportedAssets;
    }

    /// @notice 检查资产是否被支持
    /// @param asset 资产地址
    /// @return 是否支持该资产
    function isAssetSupported(address asset) external view returns (bool) {
        return _assetConfigs[asset].isActive;
    }

    /// @inheritdoc IPriceOracle
    function getPrices(address[] calldata assets) external view override returns (
        uint256[] memory prices,
        uint256[] memory timestamps,
        uint256[] memory decimalsArray
    ) {
        uint256 length = assets.length;
        prices = new uint256[](length);
        timestamps = new uint256[](length);
        decimalsArray = new uint256[](length);
        
        for (uint256 i = 0; i < length; i++) {
            if (assets[i] == address(0)) revert ZeroAddress();
            if (!_assetConfigs[assets[i]].isActive) revert PriceOracle__AssetNotSupported();
            
            PriceData memory priceData = _prices[assets[i]];
            if (!priceData.isValid) revert PriceOracle__InvalidPrice();
            if (block.timestamp - priceData.timestamp > _assetConfigs[assets[i]].maxPriceAge) {
                revert PriceOracle__StalePrice();
            }
            
            prices[i] = priceData.price;
            timestamps[i] = priceData.timestamp;
            decimalsArray[i] = priceData.decimals;
        }
    }

    /// @inheritdoc IPriceOracle
    function isPriceValid(address asset) external view override returns (bool isValid) {
        if (asset == address(0)) return false;
        if (!_assetConfigs[asset].isActive) return false;
        
        PriceData memory priceData = _prices[asset];
        return priceData.isValid && 
               (block.timestamp - priceData.timestamp <= _assetConfigs[asset].maxPriceAge);
    }

    /// @inheritdoc IPriceOracle
    function getAssetCoingeckoId(address asset) external view override returns (string memory coingeckoId) {
        if (asset == address(0)) revert ZeroAddress();
        if (!_assetConfigs[asset].isActive) revert PriceOracle__AssetNotSupported();
        return _assetConfigs[asset].coingeckoId;
    }

    /// @inheritdoc IPriceOracle
    function getAssetCount() external view override returns (uint256 count) {
        return _supportedAssets.length;
    }

    /* ============ Optional Helper (Phase 2) ============ */
    /// @notice 统一价格信息查询（不revert，返回有效性标记）
    function getPriceInfo(address asset) external view returns (
        uint256 price,
        uint256 timestamp,
        uint256 decimals,
        bool isValid
    ) {
        if (asset == address(0)) return (0, 0, 0, false);
        AssetConfig memory cfg = _assetConfigs[asset];
        if (!cfg.isActive) return (0, 0, 0, false);
        PriceData memory pd = _prices[asset];
        bool valid = pd.isValid && (block.timestamp - pd.timestamp <= cfg.maxPriceAge);
        return (pd.price, pd.timestamp, pd.decimals, valid);
    }

    /// @inheritdoc IPriceOracle
    function configureAsset(
        address asset,
        string calldata coingeckoId,
        uint256 decimals,
        uint256 maxPriceAge
    ) external override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (asset == address(0)) revert ZeroAddress();
        _configureAssetInternal(asset, coingeckoId, decimals, maxPriceAge, true, true);
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @inheritdoc IPriceOracle
    function setAssetActive(address asset, bool isActive) external override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (asset == address(0)) revert ZeroAddress();
        
        _assetConfigs[asset].isActive = isActive;
        emit AssetConfigUpdated(
            asset,
            _assetConfigs[asset].coingeckoId,
            isActive
        );
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /* ============ External Admin Functions ============ */
    
    /// @notice 更新资产价格
    /// @param asset 资产地址
    /// @param price 新价格
    /// @param timestamp 价格时间戳
    /// @dev 仅价格更新者角色可调用
    function updatePrice(address asset, uint256 price, uint256 timestamp) external override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UPDATE_PRICE, msg.sender);
        if (asset == address(0)) revert ZeroAddress();
        if (!_assetConfigs[asset].isActive) revert PriceOracle__AssetNotSupported();
        if (price == 0) revert PriceOracle__InvalidPrice();
        
        _prices[asset] = PriceData({
            price: price,
            timestamp: timestamp,
            decimals: _assetConfigs[asset].decimals > 0 ? _assetConfigs[asset].decimals : PRICE_DECIMALS_VALUE,
            isValid: true
        });
        
        emit PriceUpdated(asset, price, timestamp);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPDATE_PRICE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPDATE_PRICE),
            msg.sender,
            block.timestamp
        );
    }

    /// @inheritdoc IPriceOracle
    function updatePrices(
        address[] calldata assets,
        uint256[] calldata prices,
        uint256[] calldata timestamps
    ) external override onlyValidRegistry {
        // Same implementation as batchUpdatePrices
        _requireRole(ActionKeys.ACTION_UPDATE_PRICE, msg.sender);
        if (assets.length != prices.length || assets.length != timestamps.length) {
            revert AmountMismatch();
        }
        
        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i] == address(0)) revert ZeroAddress();
            if (!_assetConfigs[assets[i]].isActive) revert PriceOracle__AssetNotSupported();
            if (prices[i] == 0) revert PriceOracle__InvalidPrice();
            
            _prices[assets[i]] = PriceData({
                price: prices[i],
                timestamp: timestamps[i],
                decimals: _assetConfigs[assets[i]].decimals > 0 ? _assetConfigs[assets[i]].decimals : PRICE_DECIMALS_VALUE,
                isValid: true
            });
            
            emit PriceUpdated(assets[i], prices[i], timestamps[i]);
        }
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPDATE_PRICE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPDATE_PRICE),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 添加支持的资产
    /// @param asset 资产地址
    /// @param maxPriceAge 最大价格年龄
    /// @dev 仅治理角色可调用
    function addAsset(address asset, uint256 maxPriceAge) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_ADD_WHITELIST, msg.sender);
        if (asset == address(0)) revert ZeroAddress();
        if (_assetConfigs[asset].isActive) revert PriceOracle__AssetAlreadySupported();
        _configureAssetInternal(asset, "", PRICE_DECIMALS_VALUE, maxPriceAge, true, false);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_ADD_WHITELIST,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_ADD_WHITELIST),
            msg.sender,
            block.timestamp
        );
        
        // emit AssetAdded(asset, msg.sender, block.timestamp); // 需要定义相应事件
    }

    /// @notice 移除支持的资产
    /// @param asset 资产地址
    /// @dev 仅治理角色可调用
    function removeAsset(address asset) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_REMOVE_WHITELIST, msg.sender);
        if (asset == address(0)) revert ZeroAddress();
        if (!_assetConfigs[asset].isActive) revert PriceOracle__AssetNotSupported();
        
        _assetConfigs[asset].isActive = false;
        
        // 从支持列表中 O(1) 移除
        uint256 idxPlus1 = _assetIndexPlus1[asset];
        if (idxPlus1 != 0) {
            uint256 idx = idxPlus1 - 1;
            uint256 lastIdx = _supportedAssets.length - 1;
            if (idx != lastIdx) {
                address lastAsset = _supportedAssets[lastIdx];
                _supportedAssets[idx] = lastAsset;
                _assetIndexPlus1[lastAsset] = idx + 1;
            }
            _supportedAssets.pop();
            _assetIndexPlus1[asset] = 0;
        }
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_REMOVE_WHITELIST,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_REMOVE_WHITELIST),
            msg.sender,
            block.timestamp
        );
        
        // emit AssetRemoved(asset, msg.sender, block.timestamp); // 需要定义相应事件
    }

    /// @notice 更新资产配置
    /// @param asset 资产地址
    /// @param maxPriceAge 新的最大价格年龄
    /// @dev 仅治理角色可调用
    function updateAssetConfig(address asset, uint256 maxPriceAge) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (asset == address(0)) revert ZeroAddress();
        if (!_assetConfigs[asset].isActive) revert PriceOracle__AssetNotSupported();
        
        _assetConfigs[asset].maxPriceAge = maxPriceAge;
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /* ============ Internal Helpers (Phase 3) ============ */
    /// @dev 统一的资产配置内部实现
    /// @param asset 资产地址
    /// @param coingeckoId CoinGecko ID（可为空）
    /// @param decimals 精度（默认 8）
    /// @param maxPriceAge 最大价格年龄（0 则用默认值）
    /// @param setActive 是否激活
    /// @param emitConfigEvent 是否发出 AssetConfigUpdated 事件
    function _configureAssetInternal(
        address asset,
        string memory coingeckoId,
        uint256 decimals,
        uint256 maxPriceAge,
        bool setActive,
        bool emitConfigEvent
    ) internal {
        _assetConfigs[asset] = AssetConfig({
            coingeckoId: coingeckoId,
            decimals: decimals,
            isActive: setActive,
            maxPriceAge: maxPriceAge > 0 ? maxPriceAge : DEFAULT_MAX_PRICE_AGE_VALUE
        });
        // 若为新资产则加入列表
        if (_assetIndexPlus1[asset] == 0) {
            _supportedAssets.push(asset);
            _assetIndexPlus1[asset] = _supportedAssets.length;
        }
        if (emitConfigEvent) {
            emit AssetConfigUpdated(asset, coingeckoId, setActive);
        }
    }

    /// @notice 更新 Registry 地址
    /// @param newRegistryAddr 新的 Registry 地址
    /// @dev 需要 ACTION_UPGRADE_MODULE 权限
    function updateRegistry(address newRegistryAddr) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        
        address oldRegistry = _registryAddr;
        _registryAddr = newRegistryAddr;
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.timestamp
        );
        
        // 发出模块地址更新事件
        emit VaultTypes.ModuleAddressUpdated(
            ModuleKeys.getModuleKeyString(ModuleKeys.KEY_PRICE_ORACLE),
            oldRegistry,
            newRegistryAddr,
            block.timestamp
        );

    }

    /* ============ View Functions ============ */
    
    /// @notice 获取 Registry 地址
    /// @return registry 当前 Registry 地址
    function getRegistry() external view returns (address registry) {
        return _registryAddr;
    }

    /* ============ Internal Functions ============ */
    
    /// @notice 验证用户权限
    /// @param actionKey 动作键
    /// @param user 用户地址
    function _requireRole(bytes32 actionKey, address user) internal view {
        if (_registryAddr == address(0)) revert ZeroAddress();
        
        address acmAddr = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }
    
    /// @dev 设置默认资产配置
    function _setupDefaultAssets() internal {
        // 这里可以设置一些默认支持的资产
        // 例如：USDC, USDT, WETH等
    }

    /* ============ Upgrade Functions ============ */
    
    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        
        // 记录升级动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.timestamp
        );
    }

} 