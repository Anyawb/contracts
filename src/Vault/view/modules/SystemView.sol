// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { IAssetWhitelist } from "../../../interfaces/IAssetWhitelist.sol";
import { IGuaranteeFundManager } from "../../../interfaces/IGuaranteeFundManager.sol";
import { ILiquidationRiskManager } from "../../../interfaces/ILiquidationRiskManager.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/**
 * @title SystemView
 * @notice 统一只读门面：聚合 Registry/StatisticsView/ViewCache 等模块的查询能力。
 * @dev 不持久化业务数据，不做缓存；所有数据均来源于已有模块。
 */
contract SystemView is Initializable, UUPSUpgradeable, ViewVersioned {
    struct GlobalStatisticsView {
        uint256 totalUsers;
        uint256 activeUsers;
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 lastUpdateTime;
    }

    struct RewardSystemView {
        uint256 rewardRate;
        uint256 totalRewardPoints;
    }

    struct GuaranteeSystemView {
        uint256 totalGuarantee;
    }

    address private _registryAddr;
    address private _viewCache;

    uint256 private constant MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;

    error SystemView__UnknownModuleName();
    error SystemView__ZeroImplementation();

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    modifier onlyViewRole() {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender);
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
        // 尝试解析 ViewCache，如果未配置则保持为零地址（仅存储，不写缓存）
        _viewCache = Registry(initialRegistryAddr).getModule(ModuleKeys.KEY_VIEW_CACHE);
    }

    /*==================== 基础元信息 ====================*/
    function registry() external view returns (address) { return _registryAddr; }
    function registryAddr() external view returns (address) { return _registryAddr; }
    function registryAddrVar() external view returns (address) { return _registryAddr; }
    function acm() external view returns (address) { return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL); }
    /// @notice ViewCache 模块地址（动态从 Registry 读取，避免升级后 stale）
    /// @dev 保留 `_viewCache` 存储字段以保持 UUPS 存储布局兼容，但 getter 不再依赖该字段。
    function viewCache() external view returns (address) { return Registry(_registryAddr).getModule(ModuleKeys.KEY_VIEW_CACHE); }
    function viewCacheAddrVar() external view returns (address) { return Registry(_registryAddr).getModule(ModuleKeys.KEY_VIEW_CACHE); }

    function getModule(bytes32 key) external view onlyValidRegistry onlyViewRole returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(key);
    }

    function getNamedModule(string calldata name) external view onlyValidRegistry onlyViewRole returns (address) {
        // 优先走标准映射（ModuleKeys 内置的兼容字符串）
        bytes32 key = ModuleKeys.getModuleKeyFromString(name);
        if (key != bytes32(0)) {
            return Registry(_registryAddr).getModuleOrRevert(key);
        }

        // legacy 回退：部分测试/历史脚本会直接用 keccak256(name) 作为 moduleKey 写入 Registry
        address legacy = Registry(_registryAddr).getModule(keccak256(bytes(name)));
        if (legacy == address(0)) revert SystemView__UnknownModuleName();
        return legacy;
    }

    /*==================== 资产与债务 ====================*/
    function getVaultParams() external view onlyValidRegistry onlyViewRole returns (uint256, uint256, uint256) {
        // 兼容旧版 VaultRouter 的“系统参数”读取：
        // - minHealthFactor：对外通过 LiquidationRiskManager 暴露（SSOT：KEY_LIQUIDATION_CONFIG_MANAGER → LiquidationConfigModule）
        // - vaultCap：历史上存于 VaultStorage（可能未在 Registry 注册/或读取受限）
        // - liquidationThreshold：对外通过 LiquidationRiskManager 暴露（SSOT：KEY_LIQUIDATION_CONFIG_MANAGER → LiquidationConfigModule）
        uint256 minHF = _tryGetMinHealthFactor();
        uint256 cap = _tryGetVaultCap();
        uint256 liqTh = _tryGetLiquidationThreshold();
        return (minHF, cap, liqTh);
    }

    function getVaultCap() external view onlyValidRegistry onlyViewRole returns (uint256) { return _tryGetVaultCap(); }
    function getVaultCapRemaining(address) external view onlyValidRegistry onlyViewRole returns (uint256) { return 0; } // 暂无权威来源，保留兼容位

    function getMaxBorrowable(address user, address asset) external view onlyValidRegistry onlyViewRole returns (uint256) {
        // 统一入口：优先走 PositionView 的权威实现（若存在）
        address pv = Registry(_registryAddr).getModule(ModuleKeys.KEY_POSITION_VIEW);
        if (pv == address(0)) return 0;
        (bool ok, bytes memory data) = pv.staticcall(abi.encodeWithSignature("getMaxBorrowable(address,address)", user, asset));
        if (!ok || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }

    function getSettlementToken() external view onlyValidRegistry onlyViewRole returns (address) {
        address token = Registry(_registryAddr).getModule(ModuleKeys.KEY_SETTLEMENT_TOKEN);
        return token == address(0) ? _registryAddr : token;
    }

    function getMinHealthFactor() external view onlyValidRegistry onlyViewRole returns (uint256) { return _tryGetMinHealthFactor(); }
    function governance() external view onlyValidRegistry onlyViewRole returns (address) {
        address gov = Registry(_registryAddr).getModule(ModuleKeys.KEY_CROSS_CHAIN_GOV);
        return gov == address(0) ? _registryAddr : gov;
    }

    function getTotalCollateral(address) public pure returns (uint256) {
        revert("SystemView: use StatisticsView.getTotalCollateral");
    }

    function getTotalDebt(address) public pure returns (uint256) {
        revert("SystemView: use StatisticsView.getTotalDebt");
    }

    function getAssetPrice(address) public pure returns (uint256) {
        revert("SystemView: use ValuationOracleView.getAssetPrice");
    }

    /*==================== 系统统计与健康度 ====================*/
    function getGlobalStatisticsView() external view onlyValidRegistry onlyViewRole returns (GlobalStatisticsView memory g) {
        address stats = Registry(_registryAddr).getModule(ModuleKeys.KEY_STATS);
        if (stats != address(0)) {
            (bool ok, bytes memory data) = stats.staticcall(abi.encodeWithSignature("getGlobalStatistics()"));
            if (ok && data.length >= 160) {
                (g.totalUsers, g.activeUsers, g.totalCollateral, g.totalDebt, g.lastUpdateTime) = abi.decode(data, (uint256, uint256, uint256, uint256, uint256));
            }
        }
    }

    function getRewardSystemView() external pure returns (RewardSystemView memory) {
        revert("SystemView: use RewardView.getRewardStats");
    }

    function getGuaranteeSystemView() external pure returns (GuaranteeSystemView memory) {
        revert("SystemView: use StatisticsView.getTotalGuarantee");
    }

    function getGracefulDegradationStats() external view onlyValidRegistry onlyViewRole returns (bytes memory stats) {
        address statsView = Registry(_registryAddr).getModule(ModuleKeys.KEY_STATS);
        if (statsView != address(0)) {
            (bool ok, bytes memory data) = statsView.staticcall(abi.encodeWithSignature("getDegradationStats()"));
            if (ok) return data;
        }
        return "";
    }

    function checkModuleHealth(address module) external view onlyValidRegistry onlyViewRole returns (bool healthy, string memory details) {
        if (module == address(0)) return (false, "Module not configured");
        uint256 codeSize;
        assembly { codeSize := extcodesize(module) }
        if (codeSize == 0) return (false, "Module has no code");
        return (true, "OK");
    }

    /*==================== UUPS ====================*/
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert SystemView__ZeroImplementation();
    }

    /*==================== Internal helpers (best-effort) ====================*/
    function _readUint(bytes32 moduleKey, bytes memory callData) private view returns (uint256) {
        (bool ok, bytes memory data) = _staticCall(moduleKey, callData);
        if (!ok || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }

    function _staticCall(bytes32 moduleKey, bytes memory callData) private view returns (bool, bytes memory) {
        address module = Registry(_registryAddr).getModuleOrRevert(moduleKey);
        return module.staticcall(callData);
    }

    function _readUintOptional(bytes32 moduleKey, bytes memory callData) private view returns (uint256) {
        (bool ok, bytes memory data) = _staticCallOptional(moduleKey, callData);
        if (!ok || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }

    function _staticCallOptional(bytes32 moduleKey, bytes memory callData) private view returns (bool, bytes memory) {
        address module = Registry(_registryAddr).getModule(moduleKey);
        if (module == address(0)) return (false, bytes(""));
        return module.staticcall(callData);
    }

    function _tryGetMinHealthFactor() internal view returns (uint256) {
        address rm = Registry(_registryAddr).getModule(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        if (rm == address(0)) return 0;
        try ILiquidationRiskManager(rm).getMinHealthFactor() returns (uint256 v) { return v; } catch { return 0; }
    }

    function _tryGetLiquidationThreshold() internal view returns (uint256) {
        address rm = Registry(_registryAddr).getModule(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        if (rm == address(0)) return 0;
        try ILiquidationRiskManager(rm).getLiquidationThreshold() returns (uint256 v) { return v; } catch { return 0; }
    }

    function _tryGetVaultCap() internal view returns (uint256) {
        // VaultStorage 目前未纳入 ModuleKeys 常量；这里按脚本约定尝试用 keccak256("VAULT_STORAGE") 读取
        address vs = Registry(_registryAddr).getModule(keccak256("VAULT_STORAGE"));
        if (vs == address(0)) return 0;

        // 兼容多种命名：vaultCap()/getVaultCap()
        (bool ok1, bytes memory d1) = vs.staticcall(abi.encodeWithSignature("vaultCap()"));
        if (ok1 && d1.length >= 32) return abi.decode(d1, (uint256));

        (bool ok2, bytes memory d2) = vs.staticcall(abi.encodeWithSignature("getVaultCap()"));
        if (ok2 && d2.length >= 32) return abi.decode(d2, (uint256));

        return 0;
    }

    /// @notice Storage gap for future upgrades
    uint256[50] private __gap;

    // ============ Versioning (C+B baseline) ============
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }
}
