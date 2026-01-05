// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { IPriceOracle } from "../../../interfaces/IPriceOracle.sol";
import { VaultTypes } from "../../VaultTypes.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/// @dev 本地最小接口：仅用于健康检查，避免接口不匹配导致的编译错误
interface IPriceOracleHealth {
    function checkPriceOracleHealth(address asset) external view returns (bool isHealthy, string memory details);
}

/// @title ValuationOracleView
/// @notice 价格预言机视图模块 - 专门提供价格预言机相关的查询功能
/// @dev 提供价格查询、健康检查、预言机状态等功能的统一接口
/// @dev 已迁移到Registry系统，使用标准化的模块管理方式
/// @dev 增强权限隔离：细粒度权限控制、数据访问审计
/// @custom:security-contact security@example.com
contract ValuationOracleView is Initializable, UUPSUpgradeable, ViewVersioned {
    uint256 private constant MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;
    string private constant ORACLE_CALL_FAILED = "oracle call failed";

    /// @notice Registry 合约地址
    address private _registryAddr;

    error ValuationOracleView__EmptyAssets();
    error ValuationOracleView__BatchTooLarge(uint256 length, uint256 max);
    error ValuationOracleView__ZeroImplementation();
    
    /// @notice Registry 有效性验证修饰符
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }
    
    /// @notice 权限验证逻辑改由 ViewAccessLib 统一提供
    /// @notice 价格数据查看权限修饰符
    modifier onlyPriceViewer() {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender);
        _;
    }

    /// @notice 防止逻辑合约被直接初始化
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice 初始化 ValuationOracleView 模块
    /// @param initialRegistryAddr Registry合约地址
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();

        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /// @notice Registry 地址（推荐 getter）
    function registryAddrVar() external view returns (address) {
        return _registryAddr;
    }

    /// @notice Registry 地址（兼容旧命名）
    function registryAddr() external view returns (address) {
        return _registryAddr;
    }

    /* ============ 价格查询功能 ============ */

    /// @notice 获取单个资产价格
    /// @param asset 资产地址
    /// @return price 价格
    /// @return timestamp 时间戳
    function getAssetPrice(address asset) external view onlyValidRegistry onlyPriceViewer returns (uint256 price, uint256 timestamp) {
        address priceOracle = _priceOracle();

        try IPriceOracle(priceOracle).getPrice(asset) returns (uint256 p, uint256 ts, uint256) {
            return (p, ts);
        } catch {
            return (0, 0);
        }
    }

    /// @notice 批量获取资产价格
    /// @param assets 资产地址数组
    /// @return prices 价格数组
    /// @return timestamps 时间戳数组
    function getAssetPrices(address[] calldata assets) external view onlyValidRegistry onlyPriceViewer returns (uint256[] memory prices, uint256[] memory timestamps) {
        uint256 length = assets.length;
        if (length == 0) revert ValuationOracleView__EmptyAssets();
        if (length > MAX_BATCH_SIZE) revert ValuationOracleView__BatchTooLarge(length, MAX_BATCH_SIZE);

        prices = new uint256[](length);
        timestamps = new uint256[](length);

        address priceOracle = _priceOracle();
        try IPriceOracle(priceOracle).getPrices(assets) returns (uint256[] memory p, uint256[] memory ts, uint256[] memory) {
            prices = p;
            timestamps = ts;
        } catch {
            // best-effort fallback：保持默认零值
        }
    }

    /// @notice 检查价格是否有效
    /// @param asset 资产地址
    /// @return isValid 价格是否有效
    function isPriceValid(address asset) external view onlyValidRegistry onlyPriceViewer returns (bool isValid) {
        address priceOracle = _priceOracle();

        try IPriceOracle(priceOracle).isPriceValid(asset) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    /* ============ 预言机状态查询 ============ */

    /// @notice 获取资产的预言机地址
    /// @param asset 资产地址
    /// @return oracle 预言机地址
    // NOTE: 旧接口 getAssetOracle 移除

    /// @notice 检查价格预言机健康状态
    /// @param asset 资产地址
    /// @return isHealthy 是否健康
    /// @return details 详细信息
    function checkPriceOracleHealth(address asset) external view onlyValidRegistry onlyPriceViewer returns (bool isHealthy, string memory details) {
        address priceOracle = _priceOracle();

        try IPriceOracleHealth(priceOracle).checkPriceOracleHealth(asset) returns (bool healthy, string memory info) {
            return (healthy, info);
        } catch {
            return (false, ORACLE_CALL_FAILED);
        }
    }

    /// @notice 获取默认预言机地址
    /// @return 默认预言机地址
    // NOTE: 旧接口 getDefaultOracle 移除

    /// @notice 获取结算币地址
    /// @return 结算币地址
    // NOTE: 旧接口 getSettlementToken 移除

    /* ============ 批量健康检查 ============ */

    /// @notice 批量检查价格预言机健康状态
    /// @param assets 资产地址数组
    /// @return healthStatuses 健康状态数组
    /// @return details 详细信息数组
    function batchCheckPriceOracleHealth(
        address[] calldata assets
    ) external view onlyValidRegistry onlyPriceViewer returns (bool[] memory healthStatuses, string[] memory details) {
        uint256 length = assets.length;
        if (length == 0) revert ValuationOracleView__EmptyAssets();
        if (length > MAX_BATCH_SIZE) revert ValuationOracleView__BatchTooLarge(length, MAX_BATCH_SIZE);

        healthStatuses = new bool[](length);
        details = new string[](length);

        address priceOracle = _priceOracle();

        for (uint256 i = 0; i < length; ++i) {
            try IPriceOracleHealth(priceOracle).checkPriceOracleHealth(assets[i]) returns (bool healthy, string memory info) {
                healthStatuses[i] = healthy;
                details[i] = info;
            } catch {
                healthStatuses[i] = false;
                details[i] = ORACLE_CALL_FAILED;
            }
        }
    }

    /* ============ 管理功能 ============ */

    /// @notice 获取Registry地址（仅管理员）
    /// @return Registry地址
    function getRegistry() external view onlyValidRegistry returns (address) {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        return _registryAddr;
    }

    /// @notice 更新Registry地址
    /// @param newRegistryAddr 新的Registry地址
    function setRegistry(address newRegistryAddr) external onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newRegistryAddr == address(0)) revert ZeroAddress();

        address oldRegistry = _registryAddr;
        _registryAddr = newRegistryAddr;

        emit VaultTypes.ModuleAddressUpdated(
            ModuleKeys.getModuleKeyString(ModuleKeys.KEY_REGISTRY),
            oldRegistry,
            newRegistryAddr,
            block.timestamp
        );
    }

    // ============ Versioning (C+B baseline) ============
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /// @notice 检查升级权限
    /// @param user 用户地址
    /// @return hasUpgradePermission 是否有升级权限
    function hasUpgradePermission(address user) external view onlyValidRegistry returns (bool) {
        // 通过Registry系统检查用户是否有升级权限
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        return IAccessControlManager(acmAddr).hasRole(ActionKeys.ACTION_UPGRADE_MODULE, user);
    }

    /* ============ Internal helpers ============ */
    function _priceOracle() internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_PRICE_ORACLE);
    }

    /* ============ UUPS Upgradeable ============ */
    /// @notice 升级授权函数
    /// @dev 只有具有升级权限的用户可以升级
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);

        if (newImplementation == address(0)) revert ValuationOracleView__ZeroImplementation();
    }

    /// @notice Storage gap for future upgrades
    uint256[50] private __gap;
}
