// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

import { Registry } from "../../registry/Registry.sol";
import { ModuleKeys } from "../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../constants/ActionKeys.sol";
import { IVaultView } from "../../interfaces/IVaultView.sol";
import { ICollateralManager } from "../../interfaces/ICollateralManager.sol";
import { ILendingEngineBasic } from "../../interfaces/ILendingEngineBasic.sol";
import { DataPushLibrary } from "../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../constants/DataPushTypes.sol";
import { IAccessControlManager } from "../../interfaces/IAccessControlManager.sol";
import { IPriceOracle } from "../../interfaces/IPriceOracle.sol";

/// @notice 最小化 VaultCore 接口（用于解析 View 地址）
interface IVaultCoreMinimal {
    function viewContractAddrVar() external view returns (address);
}

/// @title CollateralManager
/// @notice 纯业务逻辑模块 - 抵押物管理
/// @dev 双架构设计：纯业务逻辑，通过数据推送接口更新View层缓存
/// @dev 移除复杂逻辑：权限验证、重复事件发出、缓存管理
/// @dev 专注核心功能：抵押物存取、价值计算、业务验证
/// @custom:security-contact security@example.com
contract CollateralManager is 
    Initializable, 
    UUPSUpgradeable, 
    ReentrancyGuardUpgradeable,
    ICollateralManager 
{
    /*━━━━━━━━━━━━━━━ 基础配置 ━━━━━━━━━━━━━━━*/
    
    /// @notice Registry 合约地址（私有存储，遵循命名规范）
    address private _registryAddr;

    /// @notice 统一数据推送类型常量已迁移至 DataPushTypes

    /*━━━━━━━━━━━━━━━ 业务数据存储 ━━━━━━━━━━━━━━━*/
    
    /// @notice 用户多资产抵押物余额映射：user → asset → amount
    mapping(address => mapping(address => uint256)) private _userCollateral;
    
    /// @notice 各资产抵押物总量：asset → totalAmount
    mapping(address => uint256) private _totalCollateralByAsset;
    
    /// @notice 用户资产列表：user → asset[]
    mapping(address => address[]) private _userAssets;
    
    /// @notice 用户资产索引：user → asset → index
    mapping(address => mapping(address => uint256)) private _userAssetIndex;
    
    /// @notice 用户资产数量：user → count
    mapping(address => uint256) private _userAssetCount;

    /*━━━━━━━━━━━━━━━ 错误定义 ━━━━━━━━━━━━━━━*/
    
    error CollateralManager__ZeroAddress();
    error CollateralManager__InvalidAmount();
    error CollateralManager__LengthMismatch();
    error CollateralManager__InsufficientCollateral();
    error CollateralManager__UnauthorizedAccess();
    // 保留：如需强制引导到 View 模块时可使用
    error CollateralManager__UseViewModule();

    /*━━━━━━━━━━━━━━━ 权限控制 ━━━━━━━━━━━━━━━*/

    /// @notice 只允许 Registry 中登记的 VaultView 调用
    modifier onlyVaultView() {
        if (msg.sender != _resolveVaultViewAddr()) revert CollateralManager__UnauthorizedAccess();
        _;
    }

    /// @notice 允许 VaultView 或 LiquidationManager（清算路径）调用
    modifier onlyVaultViewOrLiquidationManager() {
        address viewAddr = _resolveVaultViewAddr();
        address liquidationManager = _resolveLiquidationManagerAddr();
        if (msg.sender != viewAddr && msg.sender != liquidationManager) {
            revert CollateralManager__UnauthorizedAccess();
        }
        _;
    }

    /*━━━━━━━━━━━━━━━ 构造和初始化 ━━━━━━━━━━━━━━━*/
    
    /// @notice 初始化函数
    /// @param initialRegistryAddr Registry合约地址
    function initialize(
        address initialRegistryAddr
    ) external initializer {
        if (initialRegistryAddr == address(0)) revert CollateralManager__ZeroAddress();

        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        _registryAddr = initialRegistryAddr;
    }
    
    /*━━━━━━━━━━━━━━━ 核心业务逻辑 ━━━━━━━━━━━━━━━*/
    
    /// @notice 处理抵押物存入 - 纯业务逻辑
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 存入金额
    /// @dev 纯业务逻辑：处理抵押物存入，更新View层缓存
    function processDeposit(address user, address asset, uint256 amount) public onlyVaultView nonReentrant {
        if (user == address(0)) revert CollateralManager__ZeroAddress();
        if (asset == address(0)) revert CollateralManager__ZeroAddress();
        if (amount == 0) revert CollateralManager__InvalidAmount();
        
        // 1. 更新业务数据
        uint256 oldBalance = _userCollateral[user][asset];
        _userCollateral[user][asset] = oldBalance + amount;
        _totalCollateralByAsset[asset] = _totalCollateralByAsset[asset] + amount;
        
        // 2. 如果是新资产，添加到用户资产列表
        if (oldBalance == 0) {
            _addUserAsset(user, asset);
        }
        
        // 2.1 价格获取降级检测（示例：价格不可用时，推送用户级降级事件）
        {
            address oracle = _getPriceOracleAddr();
            // try/catch 防止外部依赖影响主流程
            try IPriceOracle(oracle).getPrice(asset) returns (uint256 price, uint256 /* ts */, uint256 /* decimals */) {
                if (price == 0) {
                    DataPushLibrary._emitData(
                        DataPushTypes.DATA_TYPE_USER_DEGRADATION,
                        abi.encode(user, address(this), asset, "Price is zero", true, uint256(0), block.timestamp)
                    );
                }
            } catch {
                DataPushLibrary._emitData(
                    DataPushTypes.DATA_TYPE_USER_DEGRADATION,
                    abi.encode(user, address(this), asset, "Price oracle unavailable", true, uint256(0), block.timestamp)
                );
            }
        }
        
        // 3. 更新 View 层缓存（携带真实债务）
        {
            address lendingEngine = _getLendingEngineAddr();
            uint256 debt = _safeGetDebt(lendingEngine, user, asset);
            IVaultView(_resolveVaultViewAddr()).pushUserPositionUpdate(
                user,
                asset,
                _userCollateral[user][asset],
                debt
            );
        }
        
        // 4. 发出业务事件
        emit DepositProcessed(user, asset, amount, block.timestamp);
        
        // 5. 数据推送（统一数据推送接口）
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_DEPOSIT_PROCESSED,
            abi.encode(user, asset, amount, block.timestamp)
        );
    }
    
    /// @notice 处理抵押物提取 - 纯业务逻辑
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 提取金额
    /// @dev 纯业务逻辑：处理抵押物提取，更新View层缓存
    function processWithdraw(address user, address asset, uint256 amount) public onlyVaultViewOrLiquidationManager nonReentrant {
        if (user == address(0)) revert CollateralManager__ZeroAddress();
        if (asset == address(0)) revert CollateralManager__ZeroAddress();
        if (amount == 0) revert CollateralManager__InvalidAmount();
        
        uint256 currentBalance = _userCollateral[user][asset];
        if (currentBalance < amount) revert CollateralManager__InsufficientCollateral();
        
        // 1. 更新业务数据
        _userCollateral[user][asset] = currentBalance - amount;
        _totalCollateralByAsset[asset] = _totalCollateralByAsset[asset] - amount;
        
        // 2. 如果余额为0，从用户资产列表中移除
        if (_userCollateral[user][asset] == 0) {
            _removeUserAsset(user, asset);
        }
        
        // 2.1 价格获取降级检测（示例：价格不可用时，推送用户级降级事件）
        {
            address oracle = _getPriceOracleAddr();
            try IPriceOracle(oracle).getPrice(asset) returns (uint256 price, uint256 /* ts */, uint256 /* decimals */) {
                if (price == 0) {
                    DataPushLibrary._emitData(
                        DataPushTypes.DATA_TYPE_USER_DEGRADATION,
                        abi.encode(user, address(this), asset, "Price is zero", true, uint256(0), block.timestamp)
                    );
                }
            } catch {
                DataPushLibrary._emitData(
                    DataPushTypes.DATA_TYPE_USER_DEGRADATION,
                    abi.encode(user, address(this), asset, "Price oracle unavailable", true, uint256(0), block.timestamp)
                );
            }
        }
        
        // 3. 更新 View 层缓存（携带真实债务）
        {
            address lendingEngine = _getLendingEngineAddr();
            uint256 debt = _safeGetDebt(lendingEngine, user, asset);
            IVaultView(_resolveVaultViewAddr()).pushUserPositionUpdate(
                user,
                asset,
                _userCollateral[user][asset],
                debt
            );
        }
        
        // 4. 发出业务事件
        emit WithdrawProcessed(user, asset, amount, block.timestamp);
        
        // 5. 数据推送（统一数据推送接口）
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_WITHDRAW_PROCESSED,
            abi.encode(user, asset, amount, block.timestamp)
        );
    }
    
    /// @notice 批量处理抵押物存入 - 纯业务逻辑
    /// @param user 用户地址
    /// @param assets 资产地址数组
    /// @param amounts 数量数组
    /// @dev 纯业务逻辑：批量处理抵押物存入
    function batchProcessDeposit(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external onlyVaultView nonReentrant {
        if (user == address(0)) revert CollateralManager__ZeroAddress();
        if (assets.length != amounts.length) revert CollateralManager__LengthMismatch();
        if (assets.length == 0) revert CollateralManager__InvalidAmount();
        
        address lendingEngine = _getLendingEngineAddr();
        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i] == address(0)) revert CollateralManager__ZeroAddress();
            if (amounts[i] == 0) continue;
            
            // 处理单个存入
            uint256 oldBalance = _userCollateral[user][assets[i]];
            _userCollateral[user][assets[i]] = oldBalance + amounts[i];
            _totalCollateralByAsset[assets[i]] = _totalCollateralByAsset[assets[i]] + amounts[i];
            
            if (oldBalance == 0) {
                _addUserAsset(user, assets[i]);
            }
            
            // 更新 View 层缓存（携带真实债务）
            {
                uint256 debt = _safeGetDebt(lendingEngine, user, assets[i]);
                IVaultView(_resolveVaultViewAddr()).pushUserPositionUpdate(
                    user,
                    assets[i],
                    _userCollateral[user][assets[i]],
                    debt
                );
            }
        }
        
        // 发出批量处理事件
        emit BatchDepositProcessed(user, assets.length, block.timestamp);
        
        // 数据推送
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_BATCH_DEPOSIT_PROCESSED,
            abi.encode(user, assets.length, block.timestamp)
        );
    }
    
    /// @notice 批量处理抵押物提取 - 纯业务逻辑
    /// @param user 用户地址
    /// @param assets 资产地址数组
    /// @param amounts 数量数组
    /// @dev 纯业务逻辑：批量处理抵押物提取
    function batchProcessWithdraw(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external onlyVaultViewOrLiquidationManager nonReentrant {
        if (user == address(0)) revert CollateralManager__ZeroAddress();
        if (assets.length != amounts.length) revert CollateralManager__LengthMismatch();
        if (assets.length == 0) revert CollateralManager__InvalidAmount();
        
        address lendingEngine = _getLendingEngineAddr();
        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i] == address(0)) revert CollateralManager__ZeroAddress();
            if (amounts[i] == 0) continue;
            
            uint256 currentBalance = _userCollateral[user][assets[i]];
            if (currentBalance < amounts[i]) revert CollateralManager__InsufficientCollateral();
            
            // 处理单个提取
            _userCollateral[user][assets[i]] = currentBalance - amounts[i];
            _totalCollateralByAsset[assets[i]] = _totalCollateralByAsset[assets[i]] - amounts[i];
            
            if (_userCollateral[user][assets[i]] == 0) {
                _removeUserAsset(user, assets[i]);
            }
            
            // 更新 View 层缓存（携带真实债务）
            {
                uint256 debt = _safeGetDebt(lendingEngine, user, assets[i]);
                IVaultView(_resolveVaultViewAddr()).pushUserPositionUpdate(
                    user,
                    assets[i],
                    _userCollateral[user][assets[i]],
                    debt
                );
            }
        }
        
        // 发出批量处理事件
        emit BatchWithdrawProcessed(user, assets.length, block.timestamp);
        
        // 数据推送
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_BATCH_WITHDRAW_PROCESSED,
            abi.encode(user, assets.length, block.timestamp)
                 );
     }
     
     /*━━━━━━━━━━━━━━━ 兼容性接口 ━━━━━━━━━━━━━━━*/
     
     /// @notice 兼容性接口：depositCollateral
     /// @param user 用户地址
     /// @param asset 资产地址
     /// @param amount 存入金额
     /// @dev 双架构设计：重定向到 processDeposit
     function depositCollateral(address user, address asset, uint256 amount) external onlyVaultView {
         processDeposit(user, asset, amount);
     }
     
     /// @notice 兼容性接口：withdrawCollateral
     /// @param user 用户地址
     /// @param asset 资产地址
     /// @param amount 提取金额
     /// @dev 双架构设计：重定向到 processWithdraw
    function withdrawCollateral(address user, address asset, uint256 amount) external onlyVaultViewOrLiquidationManager {
         processWithdraw(user, asset, amount);
     }
     
     /*━━━━━━━━━━━━━━━ 查询接口（兼容性）━━━━━━━━━━━━━━━*/
    
    /// @notice 获取用户抵押物余额（兼容接口）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return amount 抵押物数量
    function getCollateral(address user, address asset) external view returns (uint256 amount) {
        return _userCollateral[user][asset];
    }
    
    /// @notice 获取资产总抵押量（仍由业务模块维护总量，供 View 层读取）
    /// @param _asset 资产地址
    /// @return totalCollateral 总抵押量
    function getTotalCollateralByAsset(address _asset) external view returns (uint256 totalCollateral) {
        return _totalCollateralByAsset[_asset];
    }
    
    /// @notice 获取用户所有抵押资产（兼容接口）
    /// @param user 用户地址
    /// @return assets 资产地址数组
    function getUserCollateralAssets(address user) external view returns (address[] memory assets) {
        uint256 count = _userAssetCount[user];
        assets = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            assets[i] = _userAssets[user][i];
        }
    }
    
    /// @notice 获取用户总抵押物价值（兼容接口）
    /// @param user 用户地址
    /// @return totalValue 用户总抵押价值（按预言机价格与精度计算）
    function getUserTotalCollateralValue(address user) external view returns (uint256 totalValue) {
        address oracle = _getPriceOracleAddr();
        uint256 count = _userAssetCount[user];
        for (uint256 i = 0; i < count; i++) {
            address asset = _userAssets[user][i];
            uint256 amount = _userCollateral[user][asset];
            if (amount == 0) continue;
            (uint256 price,, uint256 decimals) = IPriceOracle(oracle).getPrice(asset);
            if (price == 0) continue;
            uint256 scale = 10 ** decimals;
            totalValue += (amount * price) / scale;
        }
    }
    
    /// @notice 获取系统总抵押物价值（兼容接口）
    /// @return totalValue 系统总抵押价值
    function getTotalCollateralValue() external view returns (uint256 totalValue) {
        address oracle = _getPriceOracleAddr();
        address[] memory assets = IPriceOracle(oracle).getSupportedAssets();
        for (uint256 i = 0; i < assets.length; i++) {
            address asset = assets[i];
            uint256 totalAmount = _totalCollateralByAsset[asset];
            if (totalAmount == 0) continue;
            (uint256 price,, uint256 decimals) = IPriceOracle(oracle).getPrice(asset);
            if (price == 0) continue;
            uint256 scale = 10 ** decimals;
            totalValue += (totalAmount * price) / scale;
        }
    }
    
    /// @notice 计算指定数量资产的价值（兼容接口）
    /// @param asset 资产地址
    /// @param amount 资产数量
    /// @return value 资产价值
    function getAssetValue(address asset, uint256 amount) external view returns (uint256 value) {
        if (amount == 0 || asset == address(0)) return 0;
        address oracle = _getPriceOracleAddr();
        (uint256 price,, uint256 decimals) = IPriceOracle(oracle).getPrice(asset);
        if (price == 0) return 0;
        uint256 scale = 10 ** decimals;
        return (amount * price) / scale;
    }
    
    /*━━━━━━━━━━━━━━━ 内部辅助函数 ━━━━━━━━━━━━━━━*/
    
    /// @notice 添加用户资产到列表
    /// @param user 用户地址
    /// @param asset 资产地址
    function _addUserAsset(address user, address asset) internal {
        uint256 index = _userAssetIndex[user][asset];
        if (index == 0) {
            _userAssets[user].push(asset);
            _userAssetIndex[user][asset] = _userAssets[user].length;
            _userAssetCount[user]++;
        }
    }
    
    /// @notice 从用户资产列表中移除资产
    /// @param user 用户地址
    /// @param asset 资产地址
    function _removeUserAsset(address user, address asset) internal {
        uint256 index = _userAssetIndex[user][asset];
        if (index > 0) {
            uint256 lastIndex = _userAssets[user].length - 1;
            address lastAsset = _userAssets[user][lastIndex];
            
            _userAssets[user][index - 1] = lastAsset;
            _userAssetIndex[user][lastAsset] = index;
            
            _userAssets[user].pop();
            delete _userAssetIndex[user][asset];
            _userAssetCount[user]--;
        }
    }
    
    /*━━━━━━━━━━━━━━━ 事件定义 ━━━━━━━━━━━━━━━*/
    
    /// @notice 抵押物存入处理完成事件
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 存入金额
    /// @param timestamp 时间戳
    event DepositProcessed(
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 timestamp
    );
    
    /// @notice 抵押物提取处理完成事件
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 提取金额
    /// @param timestamp 时间戳
    event WithdrawProcessed(
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 timestamp
    );
    
    /// @notice 批量抵押物存入处理完成事件
    /// @param user 用户地址
    /// @param operationCount 操作数量
    /// @param timestamp 时间戳
    event BatchDepositProcessed(
        address indexed user,
        uint256 operationCount,
        uint256 timestamp
    );
    
    /// @notice 批量抵押物提取处理完成事件
    /// @param user 用户地址
    /// @param operationCount 操作数量
    /// @param timestamp 时间戳
    event BatchWithdrawProcessed(
        address indexed user,
        uint256 operationCount,
        uint256 timestamp
    );
    
    /*━━━━━━━━━━━━━━━ 合约升级 ━━━━━━━━━━━━━━━*/
    
    /// @notice 升级授权函数
    /// @param newImplementation 新实现地址
    function _authorizeUpgrade(address newImplementation) internal view override {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        if (!IAccessControlManager(acmAddr).hasRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender)) {
            revert CollateralManager__UnauthorizedAccess();
        }
        if (newImplementation == address(0)) revert CollateralManager__ZeroAddress();
    }

    /*━━━━━━━━━━━━━━━ 内部工具 ━━━━━━━━━━━━━━━*/
    
    /// @notice 解析当前有效的 VaultView 地址（通过 Registry -> VaultCore）
    function _resolveVaultViewAddr() internal view returns (address) {
        address vaultCore = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);
        return IVaultCoreMinimal(vaultCore).viewContractAddrVar();
    }

    /// @notice 解析当前有效的 LiquidationManager 地址（通过 Registry）
    function _resolveLiquidationManagerAddr() internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_MANAGER);
    }

    /// @notice 获取价格预言机地址
    function _getPriceOracleAddr() internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_PRICE_ORACLE);
    }

    /// @notice 获取 LendingEngine 地址
    function _getLendingEngineAddr() internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
    }

    /// @notice 安全读取用户债务（失败时返回0，不影响主流程）
    function _safeGetDebt(address lendingEngine, address user, address asset) internal view returns (uint256 debt) {
        if (lendingEngine == address(0)) return 0;
        try ILendingEngineBasic(lendingEngine).getDebt(user, asset) returns (uint256 d) {
            return d;
        } catch {
            return 0;
        }
    }
} 