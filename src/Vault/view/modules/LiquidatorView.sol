// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { Registry } from "../../../registry/Registry.sol";
import {
    ZeroAddress,
    EmptyArray,
    ArrayLengthMismatch,
    MissingRole,
    InvalidCaller
} from "../../../errors/StandardErrors.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { ILiquidationEventsView } from "../../../interfaces/ILiquidationEventsView.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../../constants/DataPushTypes.sol";
import { ICollateralManager } from "../../../interfaces/ICollateralManager.sol";
import { IPositionViewValuation } from "../../../interfaces/IPositionViewValuation.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/// @title LiquidatorView
/// @notice 清算人监控模块 - 提供清算人收益和统计查询功能
/// @dev 专门处理清算人相关的查询操作，监控清算活动
/// @dev 已完全迁移到Registry系统，使用标准化的模块管理方式
/// @dev Uses Registry system for module management
/// @custom:security-contact security@example.com
contract LiquidatorView is Initializable, UUPSUpgradeable, ILiquidationEventsView, ViewVersioned {
    
    // ============ Errors ============
    error LiquidatorView__BatchTooLarge();
    error LiquidatorView__InvalidLimit();

    /// @notice Registry地址 - 用于模块管理
    address private _registryAddr;
    
    /// @notice 兼容历史：保留旧 SystemView 地址占位（可选）
    address private _legacySystemViewAddr;

    // ============ Local Types (formerly LiquidationViewTypes) ============
    struct LiquidatorProfitView {
        address liquidator;
        uint256 totalProfit;
        uint256 totalLiquidations;
        uint256 lastLiquidationTime;
        uint256 totalProfitValue;
        uint256 averageProfitPerLiquidation;
        uint256 daysSinceLastLiquidation;
    }

    struct GlobalLiquidationView {
        uint256 totalLiquidations;
        uint256 totalProfitDistributed;
        uint256 totalLiquidators;
        uint256 averageProfitPerLiquidation;
        uint256 lastLiquidationTime;
        uint256 liquidationSuccessRate;
    }
    
    // ============ DataPush Types ============
    // NOTE: Prefer centralized DataPushTypes to avoid duplicated keccak256 constants across modules.
    bytes32 public constant DATA_TYPE_LIQUIDATION_UPDATE = DataPushTypes.DATA_TYPE_LIQUIDATION_UPDATE;
    bytes32 public constant DATA_TYPE_LIQUIDATION_BATCH_UPDATE = DataPushTypes.DATA_TYPE_LIQUIDATION_BATCH_UPDATE;
    bytes32 public constant DATA_TYPE_LIQUIDATION_PAYOUT = DataPushTypes.DATA_TYPE_LIQUIDATION_PAYOUT;
    
    /// @notice Registry 有效性验证修饰符
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }
    
    /// @notice 系统数据访问验证修饰符
    modifier onlySystemViewer() {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender);
        _;
    }

    /// @notice 仅允许清算业务模块推送
    modifier onlyBusinessModule() {
        address lm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_MANAGER);
        if (msg.sender != lm) revert InvalidCaller();
        _;
    }

    /// @notice 仅允许清算执行器或残值分配模块推送（payout 专用）
    modifier onlyLiquidationOrPayoutModule() {
        address lm = Registry(_registryAddr).getModule(ModuleKeys.KEY_LIQUIDATION_MANAGER);
        address pm = Registry(_registryAddr).getModule(ModuleKeys.KEY_LIQUIDATION_PAYOUT_MANAGER);
        if (msg.sender != lm && msg.sender != pm) revert InvalidCaller();
        _;
    }

    /// @notice 清算数据访问验证修饰符
    modifier onlyLiquidationViewer() {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_LIQUIDATION_DATA, msg.sender);
        _;
    }

    /// @notice 用户数据访问验证修饰符
    modifier onlyUserData(address user) {
        _checkUserAccess(user);
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice 初始化清算人视图模块
    /// @param initialRegistryAddr Registry合约地址
    /// @param initialSystemView 兼容历史参数（可为0）
    function initialize(
        address initialRegistryAddr,
        address initialSystemView
    ) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
        _legacySystemViewAddr = initialSystemView;
    }

    /// @notice 显式暴露系统视图模块地址（兼容外部读取）
    function systemViewVar() external view returns (address) { return _legacySystemViewAddr; }

    /* ============ Push from Business (Single Point) ============ */
    function pushLiquidationUpdate(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        address liquidator,
        uint256 bonus,
        uint256 timestamp
    ) external override onlyValidRegistry onlyBusinessModule {
        DataPushLibrary._emitData(
            DATA_TYPE_LIQUIDATION_UPDATE,
            abi.encode(user, collateralAsset, debtAsset, collateralAmount, debtAmount, liquidator, bonus, timestamp)
        );
    }

    function pushBatchLiquidationUpdate(
        address[] calldata users,
        address[] calldata collateralAssets,
        address[] calldata debtAssets,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts,
        address liquidator,
        uint256[] calldata bonuses,
        uint256 timestamp
    ) external override onlyValidRegistry onlyBusinessModule {
        DataPushLibrary._emitData(
            DATA_TYPE_LIQUIDATION_BATCH_UPDATE,
            abi.encode(
                users,
                collateralAssets,
                debtAssets,
                collateralAmounts,
                debtAmounts,
                liquidator,
                bonuses,
                timestamp
            )
        );
    }

    function pushLiquidationPayout(
        address user,
        address collateralAsset,
        address platform,
        address reserve,
        address lender,
        address liquidator,
        uint256 platformShare,
        uint256 reserveShare,
        uint256 lenderShare,
        uint256 liquidatorShare,
        uint256 timestamp
    ) external override onlyValidRegistry onlyLiquidationOrPayoutModule {
        DataPushLibrary._emitData(
            DATA_TYPE_LIQUIDATION_PAYOUT,
            abi.encode(
                user,
                collateralAsset,
                platform,
                reserve,
                lender,
                liquidator,
                platformShare,
                reserveShare,
                lenderShare,
                liquidatorShare,
                timestamp
            )
        );
    }

    function _resolvePositionViewAddr() internal view returns (address) {
        return Registry(_registryAddr).getModule(ModuleKeys.KEY_POSITION_VIEW);
    }

    // ============ Registry 模块获取函数 ============
    
    /// @notice 从Registry获取模块地址
    /// @param moduleKey 模块键值
    /// @return 模块地址
    function _getModuleFromRegistry(bytes32 moduleKey) internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(moduleKey);
    }

    /// @notice 检查模块是否在Registry中注册
    /// @param moduleKey 模块键值
    /// @return 是否已注册
    function _isModuleRegistered(bytes32 moduleKey) internal view returns (bool) {
        return Registry(_registryAddr).isModuleRegistered(moduleKey);
    }

    /* ============ 清算人收益监控查询函数 ============ */

    /// @notice 获取清算人收益统计视图
    /// @param liquidator 清算人地址
    /// @return profitView 清算人收益统计视图
    function getLiquidatorProfitView(address liquidator)
        external
        view
        onlyValidRegistry
        onlySystemViewer
        returns (LiquidatorProfitView memory profitView)
    {
        // 方案A：链上不维护清算收益/次数统计；链下通过 DataPushed 事件聚合。
        // 这里返回 0 占位，避免依赖旧模块族（ProfitStatsManager / RecordManager）。
        (uint256 totalProfit, uint256 liquidationCount, uint256 lastTs) = (0, 0, 0);
        uint256 avg = liquidationCount > 0 ? totalProfit / liquidationCount : 0;
        // solhint-disable-next-line not-rely-on-time
        uint256 daysSince = lastTs > 0 && block.timestamp > lastTs ? (block.timestamp - lastTs) / 1 days : 0;

        profitView = LiquidatorProfitView({
            liquidator: liquidator,
            totalProfit: totalProfit,
            totalLiquidations: liquidationCount,
            lastLiquidationTime: lastTs,
            totalProfitValue: totalProfit,
            averageProfitPerLiquidation: avg,
            daysSinceLastLiquidation: daysSince
        });
    }

    /// @notice 获取全局清算统计视图
    /// @return globalView 全局清算统计视图
    function getGlobalLiquidationView()
        external
        view
        onlyValidRegistry
        onlySystemViewer
        returns (GlobalLiquidationView memory globalView)
    {
        // 方案A：全局统计由链下聚合；链上返回 0 占位
        uint256 totalLiquidations = 0;
        uint256 totalProfit = 0;
        uint256 activeLiquidators = 0;
        uint256 lastUpdateTime = 0;

        uint256 avg = totalLiquidations > 0 ? totalProfit / totalLiquidations : 0;

        globalView = GlobalLiquidationView({
            totalLiquidations: totalLiquidations,
            totalProfitDistributed: totalProfit,
            totalLiquidators: activeLiquidators,
            averageProfitPerLiquidation: avg,
            lastLiquidationTime: lastUpdateTime,
            liquidationSuccessRate: 0
        });
    }

    /// @notice 批量获取清算人收益统计
    /// @param liquidators 清算人地址数组
    /// @return views 清算人收益统计视图数组
    function batchGetLiquidatorProfitViews(address[] calldata liquidators)
        external
        view
        onlyValidRegistry
        onlySystemViewer
        returns (LiquidatorProfitView[] memory views)
    {
        uint256 len = liquidators.length;
        if (len == 0) revert EmptyArray();
        if (len > ViewConstants.MAX_BATCH_SIZE) revert LiquidatorView__BatchTooLarge();
        views = new LiquidatorProfitView[](len);
        for (uint256 i = 0; i < len; i++) {
            // 方案A：链下聚合统计；链上返回 0 占位
            (uint256 totalProfit, uint256 count, uint256 lastTs) = (0, 0, 0);
            uint256 avg = count > 0 ? totalProfit / count : 0;
            // solhint-disable-next-line not-rely-on-time
            uint256 daysSince = lastTs > 0 && block.timestamp > lastTs ? (block.timestamp - lastTs) / 1 days : 0;
            views[i] = LiquidatorProfitView({
                liquidator: liquidators[i],
                totalProfit: totalProfit,
                totalLiquidations: count,
                lastLiquidationTime: lastTs,
                totalProfitValue: totalProfit,
                averageProfitPerLiquidation: avg,
                daysSinceLastLiquidation: daysSince
            });
        }
    }

    /// @notice 获取清算人排行榜（按收益排序）
    /// @param limit 返回数量限制
    /// @return liquidators 清算人地址数组
    /// @return profits 收益金额数组
    /// @return liquidations 清算次数数组
    function getLiquidatorLeaderboard(uint256 limit) external view onlyValidRegistry onlySystemViewer returns (
        address[] memory liquidators,
        uint256[] memory profits,
        uint256[] memory liquidations
    ) {
        if (limit == 0) revert LiquidatorView__InvalidLimit();
        if (limit > ViewConstants.MAX_BATCH_SIZE) revert LiquidatorView__BatchTooLarge();
        // 方案B：链下聚合排行榜；链上返回空数组占位
        liquidators = new address[](0);
        profits = new uint256[](0);
        liquidations = new uint256[](0);
    }

    /// @notice 获取清算人临时债务信息
    /// @param liquidator 清算人地址
    /// @param asset 资产地址
    /// @return tempDebtAmount 临时债务数量
    function getLiquidatorTempDebt(address liquidator, address asset)
        external
        view
        onlyValidRegistry
        onlySystemViewer
        returns (uint256 tempDebtAmount)
    {
        // 方案B：不保留链上清算债务统计；链下聚合
        liquidator; asset;
        tempDebtAmount = 0;
    }

    /// @notice 获取清算人收益比例
    /// @return profitRate 收益比例（基点）
    function getLiquidatorProfitRate()
        external
        view
        onlyValidRegistry
        onlySystemViewer
        returns (uint256 profitRate)
    {
        // 方案B：利润分配/奖励口径由链下聚合；链上返回 0
        profitRate = 0;
    }

    /* ============ 清算人分析功能 ============ */

    /// @notice 获取清算人活动统计
    /// @param liquidator 清算人地址
    /// @return totalLiquidations 总清算次数
    /// @return totalProfit 总收益
    /// @return averageProfit 平均收益
    /// @return lastActivity 最后活动时间
    function getLiquidatorActivityStats(
        address liquidator,
        uint256 /* timeRange */
    ) external view onlyValidRegistry onlySystemViewer returns (
        uint256 totalLiquidations,
        uint256 totalProfit,
        uint256 averageProfit,
        uint256 lastActivity
    ) {
        liquidator; // silence unused (Scheme A: off-chain aggregation)
        // 方案A：链下聚合；链上占位
        totalProfit = 0;
        totalLiquidations = 0;
        lastActivity = 0;
        averageProfit = totalLiquidations > 0 ? totalProfit / totalLiquidations : 0;
    }

    /// @notice 获取清算人效率排名
    /// @param limit 返回数量限制
    /// @return liquidators 清算人地址数组
    /// @return efficiencyScores 效率分数数组
    /// @return avgResponseTime 平均响应时间数组
    function getLiquidatorEfficiencyRanking(uint256 limit) external view onlyValidRegistry onlySystemViewer returns (
        address[] memory liquidators,
        uint256[] memory efficiencyScores,
        uint256[] memory avgResponseTime
    ) {
        if (limit == 0) revert LiquidatorView__InvalidLimit();
        if (limit > ViewConstants.MAX_BATCH_SIZE) revert LiquidatorView__BatchTooLarge();
        
        // 这里可以实现清算人效率排名逻辑
        // 暂时返回空数组
        liquidators = new address[](0);
        efficiencyScores = new uint256[](0);
        avgResponseTime = new uint256[](0);
    }

    /// @notice 获取清算人风险分析
    /// @return riskScore 风险分数
    /// @return riskLevel 风险级别
    /// @return riskFactors 风险因素
    function getLiquidatorRiskAnalysis(address /* liquidator */)
        external
        view
        onlyValidRegistry
        onlySystemViewer
        returns (uint256 riskScore, uint8 riskLevel, string[] memory riskFactors)
    {
        // 这里可以实现清算人风险分析逻辑
        // 暂时返回默认值
        riskScore = 0;
        riskLevel = 0;
        riskFactors = new string[](0);
    }

    /* ============ 清算市场分析 ============ */

    /// @notice 获取清算市场概况
    /// @return totalLiquidations 总清算次数
    /// @return totalVolume 总清算量
    /// @return activeLiquidators 活跃清算人数
    /// @return avgLiquidationSize 平均清算规模
    function getLiquidationMarketOverview() external view onlyValidRegistry onlySystemViewer returns (
        uint256 totalLiquidations,
        uint256 totalVolume,
        uint256 activeLiquidators,
        uint256 avgLiquidationSize
    ) {
        totalLiquidations = 0;
        totalVolume = 0;
        activeLiquidators = 0;
        avgLiquidationSize = 0;
    }

    /// @notice 获取清算趋势分析
    /// @return liquidationCount 清算次数
    /// @return liquidationVolume 清算量
    /// @return avgResponseTime 平均响应时间
    function getLiquidationTrends(uint256 /* timeRange */) external view onlyValidRegistry onlySystemViewer returns (
        uint256 liquidationCount,
        uint256 liquidationVolume,
        uint256 avgResponseTime
    ) {
        liquidationCount = 0;
        liquidationVolume = 0;
        avgResponseTime = 0;
    }

    /* ============ 统计占位（代理 SystemView） ============ */
    struct UserLiquidationStats {
        uint256 totalLiquidations;
        uint256 totalSeizedValue;
        uint256 lastLiquidationTime;
    }

    struct SystemLiquidationSnapshot {
        uint256 totalLiquidations;
        uint256 totalProfitDistributed;
        uint256 totalLiquidators;
        uint256 lastUpdateTime;
    }

    // 资产/期间统计改由链下聚合与前端展示，不在链上提供接口

    /// @notice 获取用户清算统计（占位：当前从 SystemView 推断）
    function getUserLiquidationStats(address user)
        external
        view
        onlyValidRegistry
        onlyUserData(user)
        returns (UserLiquidationStats memory s)
    {
        s = _buildUserLiquidationStats(user);
    }

    /// @notice 批量获取用户清算统计（占位）
    function batchGetLiquidationStats(address[] calldata users)
        external
        view
        onlyValidRegistry
        onlyLiquidationViewer
        returns (UserLiquidationStats[] memory list)
    {
        if (users.length > ViewConstants.MAX_BATCH_SIZE) revert LiquidatorView__BatchTooLarge();
        list = new UserLiquidationStats[](users.length);
        for (uint256 i = 0; i < users.length; ) {
            _checkUserAccess(users[i]);
            list[i] = _buildUserLiquidationStats(users[i]);
            unchecked { ++i; }
        }
    }

    /// @notice 获取系统清算统计快照（代理 SystemView）
    function getSystemLiquidationSnapshot()
        external
        view
        onlyValidRegistry
        onlySystemViewer
        returns (SystemLiquidationSnapshot memory snap)
    {
        snap = SystemLiquidationSnapshot({
            totalLiquidations: 0,
            totalProfitDistributed: 0,
            totalLiquidators: 0,
            lastUpdateTime: 0
        });
    }

    

    /* ============ 抵押清算只读查询（并入自 LiquidationCollateralView） ============ */
    /// @notice 获取用户可清算的抵押物数量
    function getSeizableCollateralAmount(address user, address asset)
        external
        view
        onlyValidRegistry
        onlyUserData(user)
        returns (uint256 seizableAmount)
    {
        if (user == address(0) || asset == address(0)) return 0;
        // 直接委托 CollateralManager；若未注册则返回 0（不回滚）
        address cm = Registry(_registryAddr).getModule(ModuleKeys.KEY_CM);
        if (cm == address(0)) return 0;
        try ICollateralManager(cm).getCollateral(user, asset) returns (uint256 amt) {
            return amt;
        } catch { return 0; }
    }

    /// @notice 获取用户所有可清算抵押物
    function getSeizableCollaterals(address user)
        external
        view
        onlyValidRegistry
        onlyUserData(user)
        returns (address[] memory assets, uint256[] memory amounts)
    {
        if (user == address(0)) return (new address[](0), new uint256[](0));
        // 通过 CollateralManager 组装（若未注册则返回空）
        address cm = Registry(_registryAddr).getModule(ModuleKeys.KEY_CM);
        if (cm == address(0)) return (new address[](0), new uint256[](0));
        address[] memory assetsList = ICollateralManager(cm).getUserCollateralAssets(user);
        uint256[] memory amountsList = new uint256[](assetsList.length);
        for (uint256 i = 0; i < assetsList.length; ) {
            try ICollateralManager(cm).getCollateral(user, assetsList[i]) returns (uint256 bal) {
                amountsList[i] = bal;
            } catch { amountsList[i] = 0; }
            unchecked { ++i; }
        }
        return (assetsList, amountsList);
    }

    /// @notice 计算抵押物价值（简版）
    function calculateCollateralValue(address asset, uint256 amount)
        external
        view
        onlyValidRegistry
        onlyLiquidationViewer
        returns (uint256 value)
    {
        if (asset == address(0) || amount == 0) return 0;
        address pv = _resolvePositionViewAddr();
        if (pv == address(0)) return 0;
        try IPositionViewValuation(pv).getAssetValue(asset, amount) returns (uint256 v) {
            return v;
        } catch {
            return 0;
        }
    }

    /// @notice 获取用户总抵押物价值
    function getUserTotalCollateralValue(address user)
        external
        view
        onlyValidRegistry
        onlyUserData(user)
        returns (uint256 totalValue)
    {
        if (user == address(0)) return 0;
        address pv = _resolvePositionViewAddr();
        if (pv == address(0)) return 0;
        try IPositionViewValuation(pv).getUserTotalCollateralValue(user) returns (uint256 v) {
            return v;
        } catch {
            return 0;
        }
    }

    /// @notice 批量获取可清算抵押物数量
    function batchGetSeizableAmounts(address[] calldata users, address[] calldata assets)
        external
        view
        onlyValidRegistry
        onlyLiquidationViewer
        returns (uint256[] memory seizableAmounts)
    {
        if (users.length != assets.length) revert ArrayLengthMismatch(users.length, assets.length);
        if (users.length > ViewConstants.MAX_BATCH_SIZE) revert LiquidatorView__BatchTooLarge();

        address cm = Registry(_registryAddr).getModule(ModuleKeys.KEY_CM);
        seizableAmounts = new uint256[](users.length);
        if (cm == address(0)) return seizableAmounts;
        for (uint256 i = 0; i < users.length; ) {
            if (users[i] != address(0) && assets[i] != address(0)) {
                try ICollateralManager(cm).getCollateral(users[i], assets[i]) returns (uint256 amt) {
                    seizableAmounts[i] = amt;
                } catch { seizableAmounts[i] = 0; }
            }
            unchecked { ++i; }
        }
    }

    /// @notice 批量计算抵押物价值
    function batchCalculateCollateralValues(address[] calldata assets, uint256[] calldata amounts)
        external
        view
        onlyValidRegistry
        onlyLiquidationViewer
        returns (uint256[] memory values)
    {
        if (assets.length != amounts.length) revert ArrayLengthMismatch(assets.length, amounts.length);
        if (assets.length > ViewConstants.MAX_BATCH_SIZE) revert LiquidatorView__BatchTooLarge();

        address pv = _resolvePositionViewAddr();
        values = new uint256[](assets.length);
        if (pv == address(0)) return values;
        for (uint256 i = 0; i < assets.length; ) {
            if (assets[i] != address(0) && amounts[i] > 0) {
                try IPositionViewValuation(pv).getAssetValue(assets[i], amounts[i]) returns (uint256 v) {
                    values[i] = v;
                } catch { values[i] = 0; }
            }
            unchecked { ++i; }
        }
    }

    /// @notice 批量获取用户总抵押物价值
    function batchGetUserTotalCollateralValues(address[] calldata users)
        external
        view
        onlyValidRegistry
        onlyLiquidationViewer
        returns (uint256[] memory totalValues)
    {
        if (users.length > ViewConstants.MAX_BATCH_SIZE) revert LiquidatorView__BatchTooLarge();
        address pv = _resolvePositionViewAddr();
        totalValues = new uint256[](users.length);
        if (pv == address(0)) return totalValues;
        for (uint256 i = 0; i < users.length; ) {
            if (users[i] != address(0)) {
                try IPositionViewValuation(pv).getUserTotalCollateralValue(users[i]) returns (uint256 v) {
                    totalValues[i] = v;
                } catch { totalValues[i] = 0; }
            }
            unchecked { ++i; }
        }
    }

    /* ============ Registry 管理功能 ============ */
    
    /// @notice 获取Registry地址
    /// @return Registry合约地址
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }
    
    /// @notice 兼容旧版 getter
    function registryAddr() external view returns(address){return _registryAddr;}
    
    /// @notice 升级模块
    /// @param moduleKey 模块键
    /// @param newAddress 新模块地址
    /// @dev 需要管理员权限
    /// @notice DEPRECATED: Governance/write ops should be performed via Registry/VaultCore governance flow,
    /// not via View modules. Kept for backwards compatibility (minimal break).
    /// Prefer removing in a future major release.
    function upgradeModule(bytes32 moduleKey, address newAddress) external onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        Registry(_registryAddr).scheduleModuleUpgrade(moduleKey, newAddress);
    }
    
    /// @notice 执行模块升级
    /// @param moduleKey 模块键
    /// @dev 需要管理员权限
    /// @notice DEPRECATED: see upgradeModule().
    function executeModuleUpgrade(bytes32 moduleKey) external onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        Registry(_registryAddr).executeModuleUpgrade(moduleKey);
    }
    
    /// @notice 取消模块升级
    /// @param moduleKey 模块键
    /// @dev 需要管理员权限
    /// @notice DEPRECATED: see upgradeModule().
    function cancelModuleUpgrade(bytes32 moduleKey) external onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        Registry(_registryAddr).cancelModuleUpgrade(moduleKey);
    }

    /* ============ 升级控制 ============ */

    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    /* ============ Internal helpers ============ */
    function _buildUserLiquidationStats(address /* user */) internal pure returns (UserLiquidationStats memory s) {
        // 方案A：链上不维护用户清算统计；链下通过 DataPushed 聚合。
        // 这里返回 0 占位，避免依赖旧模块族。
        s = UserLiquidationStats({
            totalLiquidations: 0,
            totalSeizedValue: 0,
            lastLiquidationTime: 0
        });
    }

    function _checkUserAccess(address user) internal view {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, msg.sender);
        if (user != address(0) && msg.sender != user) {
            bool isAdmin = ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
            if (!isAdmin) revert MissingRole();
        }
    }
    
    /* ---------- Storage Gap for Upgradeable Contracts ---------- */
    /// @dev 为可升级合约预留存储空间，防止存储布局冲突
    // ============ Versioning (C+B baseline) ============
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    uint256[50] private __gap;
} 