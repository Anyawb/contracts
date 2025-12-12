// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { IAssetWhitelist } from "../interfaces/IAssetWhitelist.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { IRegistryUpgradeEvents } from "../interfaces/IRegistryUpgradeEvents.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { VaultTypes } from "../Vault/VaultTypes.sol";
import { ZeroAddress, AmountIsZero } from "../errors/StandardErrors.sol";
import { Registry } from "../registry/Registry.sol";

/// @title AssetWhitelist
/// @notice 资产白名单管理合约，用于管理支持的 ERC20 资产
/// @dev 提供资产白名单的查询和管理功能，仅治理地址可修改白名单
/// @dev 使用标准化的 ActionKeys 和 ModuleKeys 进行权限管理
/// @dev 支持批量操作和详细的事件记录
/// @dev 使用ACM进行权限控制，确保系统安全性
/// @dev 支持Registry升级事件监听，实现模块化架构
/// @custom:security-contact security@example.com
contract AssetWhitelist is Initializable, UUPSUpgradeable, IAssetWhitelist, IRegistryUpgradeEvents {
    /* ============ Storage ============ */
    /// @notice Registry合约地址
    address private _registryAddr;

    /* ============ Modifiers ============ */
    /// @notice 验证Registry地址有效性
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }
    
    /// @notice 资产白名单映射
    mapping(address => bool) private _allowedAssets;
    
    /// @notice 支持的资产地址列表
    address[] private _assetList;
    
    /// @notice 资产索引映射：asset → index - 优化数组操作
    mapping(address => uint256) private _assetIndex;
    
    /// @notice 资产数量计数器
    uint256 private _assetCount;
    
    /// @notice 资产详细信息映射：asset → AssetInfo
    mapping(address => AssetInfo) private _assetInfo;

    /* ============ Structs ============ */
    /// @notice 资产详细信息结构
    /// @param isActive 是否激活
    /// @param addedAt 添加时间戳
    /// @param addedBy 添加者地址
    /// @param lastUpdated 最后更新时间戳
    /// @param updateCount 更新次数
    struct AssetInfo {
        bool isActive;
        uint256 addedAt;
        address addedBy;
        uint256 lastUpdated;
        uint256 updateCount;
    }

    /* ============ Events ============ */
    /// @notice 资产添加到白名单事件
    /// @param actionKey 动作标识符
    /// @param asset 资产地址
    /// @param addedBy 添加者地址
    /// @param timestamp 添加时间戳
    event AssetAdded(
        bytes32 indexed actionKey,
        address indexed asset, 
        address indexed addedBy,
        uint256 timestamp
    );

    /// @notice 资产从白名单移除事件
    /// @param actionKey 动作标识符
    /// @param asset 资产地址
    /// @param removedBy 移除者地址
    /// @param timestamp 移除时间戳
    event AssetRemoved(
        bytes32 indexed actionKey,
        address indexed asset, 
        address indexed removedBy,
        uint256 timestamp
    );

    /// @notice 批量资产添加事件
    /// @param actionKey 动作标识符
    /// @param assets 资产地址数组
    /// @param addedBy 添加者地址
    /// @param addedCount 成功添加数量
    /// @param totalCount 总操作数量
    event AssetsBatchAdded(
        bytes32 indexed actionKey,
        address[] assets, 
        address indexed addedBy,
        uint256 addedCount,
        uint256 totalCount
    );

    /// @notice 批量资产移除事件
    /// @param actionKey 动作标识符
    /// @param assets 资产地址数组
    /// @param removedBy 移除者地址
    /// @param removedCount 成功移除数量
    /// @param totalCount 总操作数量
    event AssetsBatchRemoved(
        bytes32 indexed actionKey,
        address[] assets, 
        address indexed removedBy,
        uint256 removedCount,
        uint256 totalCount
    );

    /// @notice 资产信息更新事件
    /// @param actionKey 动作标识符
    /// @param asset 资产地址
    /// @param updatedBy 更新者地址
    /// @param timestamp 更新时间戳
    event AssetInfoUpdated(
        bytes32 indexed actionKey,
        address indexed asset, 
        address indexed updatedBy,
        uint256 timestamp
    );

    /* ============ Constructor ============ */
    /// @dev 禁用实现合约的初始化器
    constructor() {
        _disableInitializers();
    }

    /* ============ Initializer ============ */
    /// @notice 初始化资产白名单合约
    /// @param initialRegistryAddr Registry合约地址
    /// @dev 使用 StandardErrors 进行错误处理
    function initialize(address initialRegistryAddr) external initializer {
        __UUPSUpgradeable_init();
        
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        
        _registryAddr = initialRegistryAddr;
        
        // 记录初始化动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /* ============ External View Functions ============ */
    
    /// @inheritdoc IAssetWhitelist
    function isAssetAllowed(address asset) external view override onlyValidRegistry returns (bool) {
        return _allowedAssets[asset];
    }

    /// @inheritdoc IAssetWhitelist
    function getAllowedAssets() external view override onlyValidRegistry returns (address[] memory) {
        return _assetList;
    }

    /// @notice 获取支持的资产数量
    /// @return 支持的资产数量
    function getAssetCount() external view onlyValidRegistry returns (uint256) {
        return _assetCount;
    }

    /// @notice 获取资产详细信息
    /// @param asset 资产地址
    /// @return 资产详细信息
    function getAssetInfo(address asset) external view onlyValidRegistry returns (AssetInfo memory) {
        return _assetInfo[asset];
    }

    /// @notice 根据索引获取资产地址
    /// @param index 索引
    /// @return 资产地址
    function getAssetAtIndex(uint256 index) external view onlyValidRegistry returns (address) {
        if (index >= _assetList.length) revert("Index out of bounds");
        return _assetList[index];
    }

    /* ============ External Admin Functions ============ */
    
    /// @notice 添加资产到白名单
    /// @param asset 资产地址
    /// @dev 仅治理角色可调用
    function addAllowedAsset(address asset) external override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_ADD_WHITELIST, msg.sender);
        if (asset == address(0)) revert ZeroAddress();
        if (_allowedAssets[asset]) revert AmountIsZero(); // 已存在
        
        _allowedAssets[asset] = true;
        _assetList.push(asset);
        _assetIndex[asset] = _assetList.length - 1;
        _assetCount++;
        
        _assetInfo[asset] = AssetInfo({
            isActive: true,
            addedAt: block.timestamp,
            addedBy: msg.sender,
            lastUpdated: block.timestamp,
            updateCount: 1
        });
        
        emit AssetAdded(ActionKeys.ACTION_ADD_WHITELIST, asset, msg.sender, block.timestamp);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_ADD_WHITELIST,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_ADD_WHITELIST),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 从白名单移除资产
    /// @param asset 资产地址
    /// @dev 仅治理角色可调用
    function removeAllowedAsset(address asset) external override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_REMOVE_WHITELIST, msg.sender);
        if (asset == address(0)) revert ZeroAddress();
        if (!_allowedAssets[asset]) revert AmountIsZero(); // 不存在
        
        _allowedAssets[asset] = false;
        _assetCount--;
        
        // 更新资产信息
        _assetInfo[asset].isActive = false;
        _assetInfo[asset].lastUpdated = block.timestamp;
        _assetInfo[asset].updateCount++;
        
        // 从数组中移除（优化实现）
        uint256 index = _assetIndex[asset];
        if (index < _assetList.length - 1) {
            address lastAsset = _assetList[_assetList.length - 1];
            _assetList[index] = lastAsset;
            _assetIndex[lastAsset] = index;
        }
        _assetList.pop();
        delete _assetIndex[asset];
        
        emit AssetRemoved(
            ActionKeys.ACTION_REMOVE_WHITELIST,
            asset, 
            msg.sender,
            block.timestamp
        );
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_REMOVE_WHITELIST,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_REMOVE_WHITELIST),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 批量添加资产到白名单
    /// @param assets 资产地址数组
    /// @dev 仅治理角色可调用
    function batchAddAllowedAssets(address[] calldata assets) external override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_ADD_WHITELIST, msg.sender);
        if (assets.length == 0) revert AmountIsZero();
        
        uint256 addedCount = 0;
        for (uint256 i = 0; i < assets.length; i++) {
            address asset = assets[i];
            if (asset != address(0) && !_allowedAssets[asset]) {
                _allowedAssets[asset] = true;
                _assetList.push(asset);
                _assetIndex[asset] = _assetList.length - 1;
                _assetCount++;
                
                _assetInfo[asset] = AssetInfo({
                    isActive: true,
                    addedAt: block.timestamp,
                    addedBy: msg.sender,
                    lastUpdated: block.timestamp,
                    updateCount: 1
                });
                
                addedCount++;
            }
        }
        
        emit AssetsBatchAdded(
            ActionKeys.ACTION_ADD_WHITELIST,
            assets, 
            msg.sender,
            addedCount,
            assets.length
        );
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_ADD_WHITELIST,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_ADD_WHITELIST),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 批量从白名单移除资产
    /// @param assets 资产地址数组
    /// @dev 仅治理角色可调用
    function batchRemoveAllowedAssets(address[] calldata assets) external override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_REMOVE_WHITELIST, msg.sender);
        if (assets.length == 0) revert AmountIsZero();
        
        uint256 removedCount = 0;
        for (uint256 i = 0; i < assets.length; i++) {
            address asset = assets[i];
            if (asset != address(0) && _allowedAssets[asset]) {
                _allowedAssets[asset] = false;
                _assetCount--;
                
                // 更新资产信息
                _assetInfo[asset].isActive = false;
                _assetInfo[asset].lastUpdated = block.timestamp;
                _assetInfo[asset].updateCount++;
                
                // 从数组中移除（优化实现）
                uint256 index = _assetIndex[asset];
                if (index < _assetList.length - 1) {
                    address lastAsset = _assetList[_assetList.length - 1];
                    _assetList[index] = lastAsset;
                    _assetIndex[lastAsset] = index;
                }
                _assetList.pop();
                delete _assetIndex[asset];
                
                removedCount++;
            }
        }
        
        emit AssetsBatchRemoved(
            ActionKeys.ACTION_REMOVE_WHITELIST,
            assets, 
            msg.sender,
            removedCount,
            assets.length
        );
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_REMOVE_WHITELIST,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_REMOVE_WHITELIST),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 更新资产信息
    /// @param asset 资产地址
    /// @dev 仅治理角色可调用
    function updateAssetInfo(address asset) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (asset == address(0)) revert ZeroAddress();
        if (!_allowedAssets[asset]) revert AmountIsZero();
        
        _assetInfo[asset].lastUpdated = block.timestamp;
        _assetInfo[asset].updateCount++;
        
        emit AssetInfoUpdated(
            ActionKeys.ACTION_SET_PARAMETER,
            asset, 
            msg.sender,
            block.timestamp
        );
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 更新Registry地址
    /// @param newRegistryAddr 新的Registry地址
    /// @dev Registry地址不能为零地址
    function setRegistry(address newRegistryAddr) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        
        address oldRegistry = _registryAddr;
        _registryAddr = newRegistryAddr;
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
        
        // 发出模块地址更新事件
        emit VaultTypes.ModuleAddressUpdated(
            ModuleKeys.getModuleKeyString(ModuleKeys.KEY_REGISTRY),
            oldRegistry,
            newRegistryAddr,
            block.timestamp
        );
    }

    /* ============ Internal Functions ============ */
    
    /// @notice 获取Registry地址
    /// @return Registry合约地址
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }
    
    /// @notice 内部权限验证函数
    /// @param actionKey 动作标识符
    /// @param user 用户地址
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
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

    /* ============ Storage Gap ============ */
    
    /// @dev 为可升级合约预留存储空间
    uint256[50] private __gap;
} 