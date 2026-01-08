// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

import { Registry } from "../../registry/Registry.sol";
import { ModuleKeys } from "../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../constants/ActionKeys.sol";
import { ICollateralManager } from "../../interfaces/ICollateralManager.sol";
import { ILendingEngineBasic } from "../../interfaces/ILendingEngineBasic.sol";
import { DataPushLibrary } from "../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../constants/DataPushTypes.sol";
import { IAccessControlManager } from "../../interfaces/IAccessControlManager.sol";
import { IPriceOracle } from "../../interfaces/IPriceOracle.sol";
import { IPositionView } from "../../interfaces/IPositionView.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice 最小化 VaultCore 接口（用于解析 View 地址）
interface IVaultCoreMinimal {
    function viewContractAddrVar() external view returns (address);
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external;
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external;
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
    using SafeERC20 for IERC20;
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

    /// @notice 只允许 Registry 中登记的 VaultRouter 调用
    modifier onlyVaultRouter() {
        if (msg.sender != _resolveVaultRouterAddr()) revert CollateralManager__UnauthorizedAccess();
        _;
    }

    /// @notice 允许 VaultRouter / LiquidationManager / SettlementManager 调用
    /// @dev SettlementManager 用于“还款结算后自动释放抵押到用户”与“统一入口触发清算分支”
    modifier onlyVaultRouterOrLiquidationManager() {
        address viewAddr = _resolveVaultRouterAddr();
        address liquidationManager = _resolveLiquidationManagerAddr();
        address settlementManager = _resolveSettlementManagerAddr();
        if (msg.sender != viewAddr && msg.sender != liquidationManager && msg.sender != settlementManager) {
            revert CollateralManager__UnauthorizedAccess();
        }
        _;
    }

    /// @notice 仅允许 Registry 中登记的 LiquidationManager 调用（清算扣押路径）
    modifier onlyLiquidationManager() {
        if (msg.sender != _resolveLiquidationManagerAddr()) revert CollateralManager__UnauthorizedAccess();
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

    /// @notice View 层缓存推送失败（不回滚主流程，链下可监听重试）
    event ViewCachePushFailed(address indexed user, address indexed asset, bytes reason);
    
    /// @notice 处理抵押物存入 - 纯业务逻辑
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 存入金额
    /// @dev 纯业务逻辑：处理抵押物存入，更新View层缓存
    function processDeposit(address user, address asset, uint256 amount) public onlyVaultRouter nonReentrant {
        if (user == address(0)) revert CollateralManager__ZeroAddress();
        if (asset == address(0)) revert CollateralManager__ZeroAddress();
        if (amount == 0) revert CollateralManager__InvalidAmount();

        // 0) 真实资金入池：将抵押资产从用户转入本合约（CollateralManager 作为资金池/托管者）
        // NOTE: 需要用户提前 approve 本合约为 spender
        uint256 received = _pullTokenIntoPool(user, asset, amount);
        if (received == 0) revert CollateralManager__InvalidAmount();
        
        // 1. 更新业务数据
        uint256 oldBalance = _userCollateral[user][asset];
        _userCollateral[user][asset] = oldBalance + received;
        _totalCollateralByAsset[asset] = _totalCollateralByAsset[asset] + received;
        
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
            uint64 nextVersion = _getNextVersion(user, asset);
            try IVaultCoreMinimal(_resolveVaultCoreAddr()).pushUserPositionUpdateDelta(
                user,
                asset,
                _toInt(amount),
                int256(0),
                bytes32(0),
                0,
                nextVersion
            ) {
                // ok
            } catch (bytes memory reason) {
                emit ViewCachePushFailed(user, asset, reason);
            }
        }
        
        // 4. 发出业务事件
        emit DepositProcessed(user, asset, received, block.timestamp);
        
        // 5. 数据推送（统一数据推送接口）
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_DEPOSIT_PROCESSED,
            abi.encode(user, asset, received, block.timestamp)
        );
    }
    
    /// @notice 处理抵押物提取 - 纯业务逻辑
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 提取金额
    /// @dev 纯业务逻辑：处理抵押物提取，更新View层缓存
    function processWithdraw(address user, address asset, uint256 amount) public onlyVaultRouter nonReentrant {
        // 用户提现：receiver 必须为 user
        _withdrawCollateralTo(user, asset, amount, user);
    }

    /// @notice 统一的抵押出池入口：可用于用户提现（receiver=user）与清算扣押（receiver=liquidator）
    /// @dev 写入直达账本：扣减账本 + 真实转账；并 best-effort 推送 View
    /// @dev 安全约束：当 receiver==user 时，仅允许 VaultRouter 调用，防止清算模块误走“提到用户”的语义
    function withdrawCollateralTo(
        address user,
        address asset,
        uint256 amount,
        address receiver
    ) external onlyVaultRouterOrLiquidationManager nonReentrant {
        if (receiver == address(0)) revert CollateralManager__ZeroAddress();
        // 若是“提到用户”的语义，强制只能由 VaultRouter 或 SettlementManager 发起
        // - VaultRouter：用户主动 withdraw
        // - SettlementManager：用户 repay 后自动释放抵押
        address vaultRouter = _resolveVaultRouterAddr();
        address settlementManager = _resolveSettlementManagerAddr();
        if (receiver == user && msg.sender != vaultRouter && msg.sender != settlementManager) {
            revert CollateralManager__UnauthorizedAccess();
        }
        _withdrawCollateralTo(user, asset, amount, receiver);
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
    ) external onlyVaultRouter nonReentrant {
        if (user == address(0)) revert CollateralManager__ZeroAddress();
        if (assets.length != amounts.length) revert CollateralManager__LengthMismatch();
        if (assets.length == 0) revert CollateralManager__InvalidAmount();

        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i] == address(0)) revert CollateralManager__ZeroAddress();
            if (amounts[i] == 0) continue;
            
            // 真实资金入池（逐资产）
            uint256 received = _pullTokenIntoPool(user, assets[i], amounts[i]);
            if (received == 0) continue;

            // 处理单个存入
            uint256 oldBalance = _userCollateral[user][assets[i]];
            _userCollateral[user][assets[i]] = oldBalance + received;
            _totalCollateralByAsset[assets[i]] = _totalCollateralByAsset[assets[i]] + received;
            
            if (oldBalance == 0) {
                _addUserAsset(user, assets[i]);
            }
            
            // 更新 View 层缓存（使用增量，减少覆盖风险）
            uint64 nextVersion = _getNextVersion(user, assets[i]);
            try IVaultCoreMinimal(_resolveVaultCoreAddr()).pushUserPositionUpdateDelta(
                user,
                assets[i],
                _toInt(received),
                int256(0),
                bytes32(0),
                0,
                nextVersion
            ) {
                // ok
            } catch (bytes memory reason) {
                emit ViewCachePushFailed(user, assets[i], reason);
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
    ) external onlyVaultRouter nonReentrant {
        if (user == address(0)) revert CollateralManager__ZeroAddress();
        if (assets.length != amounts.length) revert CollateralManager__LengthMismatch();
        if (assets.length == 0) revert CollateralManager__InvalidAmount();

        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i] == address(0)) revert CollateralManager__ZeroAddress();
            if (amounts[i] == 0) continue;
            // 批量提现：receiver 必须为 user
            _withdrawCollateralTo(user, assets[i], amounts[i], user);
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
     function depositCollateral(address user, address asset, uint256 amount) external onlyVaultRouter {
         processDeposit(user, asset, amount);
     }
     
     /// @notice 兼容性接口：withdrawCollateral
     /// @param user 用户地址
     /// @param asset 资产地址
     /// @param amount 提取金额
     /// @dev 双架构设计：重定向到 processWithdraw
    function withdrawCollateral(address user, address asset, uint256 amount) external onlyVaultRouter {
         processWithdraw(user, asset, amount);
     }

    /*━━━━━━━━━━━━━━━ Liquidation (Scheme A) ━━━━━━━━━━━━━━━*/
    /// @notice 清算扣押：扣减用户抵押并把真实抵押资产转给清算人
    function seizeCollateralForLiquidation(
        address targetUser,
        address collateralAsset,
        uint256 collateralAmount,
        address liquidator
    ) external onlyLiquidationManager nonReentrant {
        // Defense-in-depth: 账本模块内部也必须校验 ACTION_LIQUIDATE
        // NOTE: msg.sender 为 LiquidationManager，因此部署/治理时需授予 LiquidationManager 该角色
        _requireRole(ActionKeys.ACTION_LIQUIDATE, msg.sender);

        if (targetUser == address(0)) revert CollateralManager__ZeroAddress();
        if (collateralAsset == address(0)) revert CollateralManager__ZeroAddress();
        if (liquidator == address(0)) revert CollateralManager__ZeroAddress();
        if (collateralAmount == 0) revert CollateralManager__InvalidAmount();

        // 统一语义：清算扣押 = withdraw to liquidator
        _withdrawCollateralTo(targetUser, collateralAsset, collateralAmount, liquidator);
    }

    /// @dev 内部实现：扣减账本 + best-effort 推送 View + 真实转账到 receiver
    function _withdrawCollateralTo(address user, address asset, uint256 amount, address receiver) internal {
        if (user == address(0)) revert CollateralManager__ZeroAddress();
        if (asset == address(0)) revert CollateralManager__ZeroAddress();
        if (receiver == address(0)) revert CollateralManager__ZeroAddress();
        if (amount == 0) revert CollateralManager__InvalidAmount();

        uint256 currentBalance = _userCollateral[user][asset];
        if (currentBalance < amount) revert CollateralManager__InsufficientCollateral();

        // 1) 更新账本
        _userCollateral[user][asset] = currentBalance - amount;
        _totalCollateralByAsset[asset] = _totalCollateralByAsset[asset] - amount;
        if (_userCollateral[user][asset] == 0) {
            _removeUserAsset(user, asset);
        }

        // 2) 价格获取降级检测（示例：价格不可用时，推送用户级降级事件）
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

        // 3) best-effort 推送 View（增量，减少覆盖风险）
        {
            uint64 nextVersion = _getNextVersion(user, asset);
            try IVaultCoreMinimal(_resolveVaultCoreAddr()).pushUserPositionUpdateDelta(
                user,
                asset,
                -_toInt(amount),
                int256(0),
                bytes32(0),
                0,
                nextVersion
            ) {
                // ok
            } catch (bytes memory reason) {
                emit ViewCachePushFailed(user, asset, reason);
            }
        }

        // 4) 真实资金出池：资金池直接转给 receiver
        IERC20(asset).safeTransfer(receiver, amount);

        // 5) 事件与 DataPush（对齐“写入直达账本 + 链下聚合”）
        emit WithdrawProcessed(user, asset, amount, block.timestamp);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_WITHDRAW_PROCESSED,
            abi.encode(user, asset, amount, block.timestamp)
        );
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
    
    /// @notice 解析当前有效的 VaultCore 地址
    function _resolveVaultCoreAddr() internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);
    }

    /// @notice 解析当前有效的 VaultRouter 地址（通过 VaultCore 暴露的 viewContractAddrVar）
    function _resolveVaultRouterAddr() internal view returns (address) {
        return IVaultCoreMinimal(_resolveVaultCoreAddr()).viewContractAddrVar();
    }

    /// @notice 解析 PositionView 并返回下一个 nextVersion（失败返回 0，自增模式）
    function _getNextVersion(address user, address asset) internal view returns (uint64) {
        address positionView = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_POSITION_VIEW);
        try IPositionView(positionView).getPositionVersion(user, asset) returns (uint64 version) {
            unchecked {
                return version + 1;
            }
        } catch {
            return 0;
        }
    }

    /// @notice 解析当前有效的 LiquidationManager 地址（通过 Registry）
    function _resolveLiquidationManagerAddr() internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_MANAGER);
    }

    /// @notice 解析当前有效的 SettlementManager 地址（通过 Registry）
    /// @dev 使用 getModule（非 revert），避免在未部署 SettlementManager 时影响 VaultRouter 正常路径
    function _resolveSettlementManagerAddr() internal view returns (address) {
        return Registry(_registryAddr).getModule(ModuleKeys.KEY_SETTLEMENT_MANAGER);
    }

    /// @notice 权限校验内部函数
    function _requireRole(bytes32 actionKey, address caller) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, caller);
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

    /// @notice 将 uint256 安全转换为 int256，防止溢出
    function _toInt(uint256 value) internal pure returns (int256) {
        if (value > uint256(type(int256).max)) revert CollateralManager__InvalidAmount();
        return int256(value);
    }

    /// @notice 将 token 从用户拉入资金池，并返回实际到账数量（兼容 fee-on-transfer）
    function _pullTokenIntoPool(address user, address asset, uint256 amount) internal returns (uint256 received) {
        IERC20 token = IERC20(asset);
        uint256 beforeBal = token.balanceOf(address(this));
        token.safeTransferFrom(user, address(this), amount);
        uint256 afterBal = token.balanceOf(address(this));
        unchecked {
            received = afterBal - beforeBal;
        }
    }
} 