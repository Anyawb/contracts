// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
// Types moved inline to reduce file count
import { Registry } from "../../../registry/Registry.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { ILiquidationEventsView } from "../../../interfaces/ILiquidationEventsView.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { ILiquidationCollateralManager } from "../../../interfaces/ILiquidationCollateralManager.sol";
import { ICollateralManager } from "../../../interfaces/ICollateralManager.sol";
import { ILiquidationRecordManager } from "../../../interfaces/ILiquidationRecordManager.sol";
import { ILiquidationProfitStatsManager } from "../../../interfaces/ILiquidationProfitStatsManager.sol";
import { ILiquidationDebtManager } from "../../../interfaces/ILiquidationDebtManager.sol";
import { ILiquidationRewardManager } from "../../../interfaces/ILiquidationRewardManager.sol";

/// @title LiquidatorView
/// @notice 清算人监控模块 - 提供清算人收益和统计查询功能
/// @dev 专门处理清算人相关的查询操作，监控清算活动
/// @dev 已完全迁移到Registry系统，使用标准化的模块管理方式
/// @dev Uses Registry system for module management
/// @custom:security-contact security@example.com
contract LiquidatorView is Initializable, UUPSUpgradeable, ILiquidationEventsView {
    
    // =================== Gas 优化常量 ===================
    /// @notice 清算人批量操作最大长度限制
    uint256 private constant MAX_LIQUIDATOR_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;
    
    /// @notice Registry地址 - 用于模块管理
    /// @notice Registry address - For module management
    address private _registryAddr;
    
    /// @notice 兼容历史：保留旧 SystemView 地址占位（不再使用）
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
    bytes32 public constant DATA_TYPE_LIQUIDATION_UPDATE = keccak256("LIQUIDATION_UPDATE");
    bytes32 public constant DATA_TYPE_LIQUIDATION_BATCH_UPDATE = keccak256("LIQUIDATION_BATCH_UPDATE");
    
    /// @notice Registry 有效性验证修饰符
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }
    
    /// @notice 权限校验内部函数
    /// @param actionKey 动作键
    /// @param user 用户地址
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /// @notice 角色检查内部函数
    function _hasRole(bytes32 actionKey, address user) internal view returns (bool) {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        return IAccessControlManager(acmAddr).hasRole(actionKey, user);
    }
    
    /// @notice 系统数据访问验证修饰符
    modifier onlySystemViewer() {
        _requireRole(ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender);
        _;
    }

    /// @notice 仅允许清算业务模块推送
    modifier onlyBusinessModule() {
        address lm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_MANAGER);
        require(msg.sender == lm, "LiquidatorView: only liquidation manager");
        _;
    }

    /// @notice 清算数据访问验证修饰符
    modifier onlyLiquidationViewer() {
        _requireRole(ActionKeys.ACTION_VIEW_LIQUIDATION_DATA, msg.sender);
        _;
    }

    /// @notice 用户数据访问验证修饰符
    modifier onlyUserData(address user) {
        _requireRole(ActionKeys.ACTION_VIEW_USER_DATA, msg.sender);
        if (user != address(0)) {
            require(
                msg.sender == user || _hasRole(ActionKeys.ACTION_ADMIN, msg.sender),
                "LiquidatorView: unauthorized"
            );
        }
        _;
    }

    /// @notice 初始化清算人视图模块
    /// @param initialRegistryAddr Registry合约地址
    /// @param initialSystemView 历史参数（保留兼容，不再使用）
    /// @custom:security 确保所有地址参数不为零地址
    function initialize(
        address initialRegistryAddr,
        address initialSystemView
    ) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialSystemView == address(0)) revert ZeroAddress();
        
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
            abi.encode(users, collateralAssets, debtAssets, collateralAmounts, debtAmounts, liquidator, bonuses, timestamp)
        );
    }

    // ============ Registry 模块获取函数 ============
    
    /// @notice 从Registry获取模块地址
    /// @param moduleKey 模块键值
    /// @return 模块地址
    function getModuleFromRegistry(bytes32 moduleKey) internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(moduleKey);
    }

    /// @notice 检查模块是否在Registry中注册
    /// @param moduleKey 模块键值
    /// @return 是否已注册
    function isModuleRegistered(bytes32 moduleKey) internal view returns (bool) {
        return Registry(_registryAddr).isModuleRegistered(moduleKey);
    }

    /* ============ 清算人收益监控查询函数 ============ */

    /// @notice 获取清算人收益统计视图
    /// @param liquidator 清算人地址
    /// @return profitView 清算人收益统计视图
    function getLiquidatorProfitView(address liquidator) external view onlyValidRegistry onlySystemViewer returns (LiquidatorProfitView memory profitView) {
        address statsMgr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_PROFIT_STATS_MANAGER);
        if (statsMgr != address(0)) {
            try ILiquidationProfitStatsManager(statsMgr).getLiquidatorProfitStats(liquidator) returns (
                uint256 totalProfit,
                uint256 totalLiquidations,
                uint256 lastLiquidationTime
            ) {
                profitView = LiquidatorProfitView({
                    liquidator: liquidator,
                    totalProfit: totalProfit,
                    totalLiquidations: totalLiquidations,
                    lastLiquidationTime: lastLiquidationTime,
                    totalProfitValue: totalProfit,
                    averageProfitPerLiquidation: totalLiquidations > 0 ? totalProfit / totalLiquidations : 0,
                    daysSinceLastLiquidation: lastLiquidationTime > 0 ? (block.timestamp - lastLiquidationTime) / 1 days : 0
                });
            } catch {
                profitView = LiquidatorProfitView({
                    liquidator: liquidator,
                    totalProfit: 0,
                    totalLiquidations: 0,
                    lastLiquidationTime: 0,
                    totalProfitValue: 0,
                    averageProfitPerLiquidation: 0,
                    daysSinceLastLiquidation: 0
                });
            }
        } else {
            profitView = LiquidatorProfitView({
                liquidator: liquidator,
                totalProfit: 0,
                totalLiquidations: 0,
                lastLiquidationTime: 0,
                totalProfitValue: 0,
                averageProfitPerLiquidation: 0,
                daysSinceLastLiquidation: 0
            });
        }
    }

    /// @notice 获取全局清算统计视图
    /// @return globalView 全局清算统计视图
    function getGlobalLiquidationView() external view onlyValidRegistry onlySystemViewer returns (GlobalLiquidationView memory globalView) {
        address statsMgr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_PROFIT_STATS_MANAGER);
        if (statsMgr != address(0)) {
            try ILiquidationProfitStatsManager(statsMgr).getGlobalLiquidationStats() returns (
                uint256 totalLiquidations,
                uint256 totalProfit,
                uint256 activeLiquidators,
                uint256 lastUpdateTime
            ) {
                globalView = GlobalLiquidationView({
                    totalLiquidations: totalLiquidations,
                    totalProfitDistributed: totalProfit,
                    totalLiquidators: activeLiquidators,
                    averageProfitPerLiquidation: totalLiquidations > 0 ? totalProfit / totalLiquidations : 0,
                    lastLiquidationTime: lastUpdateTime,
                    liquidationSuccessRate: totalLiquidations > 0 ? 100 : 0
                });
            } catch {
                globalView = GlobalLiquidationView({
                    totalLiquidations: 0,
                    totalProfitDistributed: 0,
                    totalLiquidators: 0,
                    averageProfitPerLiquidation: 0,
                    lastLiquidationTime: 0,
                    liquidationSuccessRate: 0
                });
            }
        } else {
            globalView = GlobalLiquidationView({
                totalLiquidations: 0,
                totalProfitDistributed: 0,
                totalLiquidators: 0,
                averageProfitPerLiquidation: 0,
                lastLiquidationTime: 0,
                liquidationSuccessRate: 0
            });
        }
    }

    /// @notice 批量获取清算人收益统计
    /// @param liquidators 清算人地址数组
    /// @return views 清算人收益统计视图数组
    function batchGetLiquidatorProfitViews(address[] calldata liquidators) external view onlyValidRegistry onlySystemViewer returns (LiquidatorProfitView[] memory views) {
        require(liquidators.length > 0, unicode"LiquidatorView: 列表为空");
        require(liquidators.length <= MAX_LIQUIDATOR_BATCH_SIZE, unicode"LiquidatorView: 批量过大");
        views = new LiquidatorProfitView[](liquidators.length);
        for (uint256 i = 0; i < liquidators.length; i++) {
            views[i] = this.getLiquidatorProfitView(liquidators[i]);
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
        require(limit > 0, unicode"LiquidatorView: limit 必须大于 0");
        require(limit <= ViewConstants.MAX_BATCH_SIZE, unicode"LiquidatorView: limit 过大");
        address statsMgr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_PROFIT_STATS_MANAGER);
        if (statsMgr != address(0)) {
            try ILiquidationProfitStatsManager(statsMgr).getLiquidatorLeaderboard(limit) returns (
                address[] memory _liquidators,
                uint256[] memory _profits
            ) {
                liquidators = _liquidators;
                profits = _profits;
                liquidations = new uint256[](_liquidators.length);
            } catch {
                liquidators = new address[](0);
                profits = new uint256[](0);
                liquidations = new uint256[](0);
            }
        } else {
            liquidators = new address[](0);
            profits = new uint256[](0);
            liquidations = new uint256[](0);
        }
    }

    /// @notice 获取清算人临时债务信息
    /// @param liquidator 清算人地址
    /// @param asset 资产地址
    /// @return tempDebtAmount 临时债务数量
    function getLiquidatorTempDebt(address liquidator, address asset) external view onlyValidRegistry onlySystemViewer returns (uint256 tempDebtAmount) {
        address debtMgr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_DEBT_MANAGER);
        if (debtMgr != address(0)) {
            try ILiquidationDebtManager(debtMgr).getLiquidatorTempDebt(liquidator, asset) returns (uint256 tempDebt) {
                tempDebtAmount = tempDebt;
            } catch {
                tempDebtAmount = 0;
            }
        } else {
            tempDebtAmount = 0;
        }
    }

    /// @notice 获取清算人收益比例
    /// @return profitRate 收益比例（基点）
    function getLiquidatorProfitRate() external view onlyValidRegistry onlySystemViewer returns (uint256 profitRate) {
        address rewardMgr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_REWARD_MANAGER);
        if (rewardMgr != address(0)) {
            (bool success, bytes memory data) = rewardMgr.staticcall(abi.encodeWithSignature("getLiquidatorProfitRate()"));
            if (success && data.length >= 32) {
                profitRate = abi.decode(data, (uint256));
            } else {
                profitRate = 0;
            }
        } else {
            profitRate = 0;
        }
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
        // 这里可以实现更详细的清算人活动统计
        // 暂时委托给系统视图模块
        LiquidatorProfitView memory profitView = this.getLiquidatorProfitView(liquidator);
        
        totalLiquidations = profitView.totalLiquidations;
        totalProfit = profitView.totalProfit;
        averageProfit = totalLiquidations > 0 ? totalProfit / totalLiquidations : 0;
        lastActivity = profitView.lastLiquidationTime;
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
        require(limit > 0, unicode"LiquidatorView: limit 必须大于 0");
        require(limit <= ViewConstants.MAX_BATCH_SIZE, unicode"LiquidatorView: limit 过大");
        
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
    function getLiquidatorRiskAnalysis(address /* liquidator */) external view onlyValidRegistry onlySystemViewer returns (
        uint256 riskScore,
        uint8 riskLevel,
        string[] memory riskFactors
    ) {
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
        GlobalLiquidationView memory globalView = this.getGlobalLiquidationView();
        
        totalLiquidations = globalView.totalLiquidations;
        totalVolume = globalView.totalProfitDistributed;
        activeLiquidators = globalView.totalLiquidators;
        avgLiquidationSize = totalLiquidations > 0 ? totalVolume / totalLiquidations : 0;
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
        // 先用全局视图的统计做占位，后续可替换为正式趋势数据
        GlobalLiquidationView memory gv = this.getGlobalLiquidationView();
        liquidationCount = gv.totalLiquidations;
        liquidationVolume = gv.totalProfitDistributed;
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
        // 聚合来源：RecordManager（次数/时间） + ProfitStatsManager（价值）
        address rm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_RECORD_MANAGER);
        address pm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_PROFIT_STATS_MANAGER);
        uint256 count = 0;
        uint256 lastTs = 0;
        uint256 seizedValue = 0;
        if (rm != address(0)) {
            try ILiquidationRecordManager(rm).getUserLiquidationCount(user) returns (uint256 c) { count = c; } catch {}
            if (count > 0) {
                // 获取最后一次清算时间（索引 count-1）；失败则忽略
                try ILiquidationRecordManager(rm).getUserLiquidationTimestampAtIndex(user, count - 1) returns (uint256 ts) { lastTs = ts; } catch {}
            }
        }
        if (pm != address(0)) {
            // 利用 profit stats 的 totalProfit 作为被扣押价值的近似（后续可替换为更准确口径）
            try ILiquidationProfitStatsManager(pm).getLiquidatorProfitStats(user) returns (uint256 totalProfit, uint256, uint256) {
                seizedValue = totalProfit;
            } catch {}
        }
        s = UserLiquidationStats({ totalLiquidations: count, totalSeizedValue: seizedValue, lastLiquidationTime: lastTs });
    }

    /// @notice 批量获取用户清算统计（占位）
    function batchGetLiquidationStats(address[] calldata users)
        external
        view
        onlyValidRegistry
        onlyLiquidationViewer
        returns (UserLiquidationStats[] memory list)
    {
        require(users.length <= ViewConstants.MAX_BATCH_SIZE, unicode"LiquidatorView: 批量查询过大");
        list = new UserLiquidationStats[](users.length);
        address rm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_RECORD_MANAGER);
        address pm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_PROFIT_STATS_MANAGER);
        for (uint256 i = 0; i < users.length; ) {
            address u = users[i];
            uint256 count = 0; uint256 lastTs = 0; uint256 seizedValue = 0;
            if (u != address(0)) {
                if (rm != address(0)) {
                    try ILiquidationRecordManager(rm).getUserLiquidationCount(u) returns (uint256 c) { count = c; } catch {}
                    if (count > 0) { try ILiquidationRecordManager(rm).getUserLiquidationTimestampAtIndex(u, count - 1) returns (uint256 ts) { lastTs = ts; } catch {} }
                }
                if (pm != address(0)) {
                    try ILiquidationProfitStatsManager(pm).getLiquidatorProfitStats(u) returns (uint256 totalProfit, uint256, uint256) {
                        seizedValue = totalProfit;
                    } catch {}
                }
            }
            list[i] = UserLiquidationStats({ totalLiquidations: count, totalSeizedValue: seizedValue, lastLiquidationTime: lastTs });
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
        GlobalLiquidationView memory gv = this.getGlobalLiquidationView();
        snap = SystemLiquidationSnapshot({
            totalLiquidations: gv.totalLiquidations,
            totalProfitDistributed: gv.totalProfitDistributed,
            totalLiquidators: gv.totalLiquidators,
            lastUpdateTime: gv.lastLiquidationTime
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
        // 直接委托 CollateralManager，避免依赖未部署的清算专用查询管理器
        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
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
        // 通过 CollateralManager 组装（如需更高效可在后续优化为批量接口）
        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
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
        // 直接委托 CollateralManager（或保留到专门 View），这里按原实现简单代理
        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        return ICollateralManager(cm).getAssetValue(asset, amount);
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
        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        return ICollateralManager(cm).getUserTotalCollateralValue(user);
    }

    /// @notice 批量获取可清算抵押物数量
    function batchGetSeizableAmounts(address[] calldata users, address[] calldata assets)
        external
        view
        onlyValidRegistry
        onlyLiquidationViewer
        returns (uint256[] memory seizableAmounts)
    {
        require(users.length == assets.length, unicode"LiquidatorView: 输入数组长度不一致");
        require(users.length <= ViewConstants.MAX_BATCH_SIZE, unicode"LiquidatorView: 批量查询过大");

        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        seizableAmounts = new uint256[](users.length);
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
        require(assets.length == amounts.length, unicode"LiquidatorView: 输入数组长度不一致");
        require(assets.length <= ViewConstants.MAX_BATCH_SIZE, unicode"LiquidatorView: 批量查询过大");

        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        values = new uint256[](assets.length);
        for (uint256 i = 0; i < assets.length; ) {
            if (assets[i] != address(0) && amounts[i] > 0) {
                try ICollateralManager(cm).getAssetValue(assets[i], amounts[i]) returns (uint256 v) {
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
        require(users.length <= ViewConstants.MAX_BATCH_SIZE, unicode"LiquidatorView: 批量查询过大");
        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        totalValues = new uint256[](users.length);
        for (uint256 i = 0; i < users.length; ) {
            if (users[i] != address(0)) {
                try ICollateralManager(cm).getUserTotalCollateralValue(users[i]) returns (uint256 v) {
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
    function upgradeModule(bytes32 moduleKey, address newAddress) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        Registry(_registryAddr).scheduleModuleUpgrade(moduleKey, newAddress);
    }
    
    /// @notice 执行模块升级
    /// @param moduleKey 模块键
    /// @dev 需要管理员权限
    function executeModuleUpgrade(bytes32 moduleKey) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        Registry(_registryAddr).executeModuleUpgrade(moduleKey);
    }
    
    /// @notice 取消模块升级
    /// @param moduleKey 模块键
    /// @dev 需要管理员权限
    function cancelModuleUpgrade(bytes32 moduleKey) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        Registry(_registryAddr).cancelModuleUpgrade(moduleKey);
    }

    /* ============ 升级控制 ============ */

    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal view override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager acm = IAccessControlManager(acmAddr);
        require(
            !acm.getContractStatus(),
            "LiquidatorView: contract is paused"
        );
    }
    
    /* ---------- Storage Gap for Upgradeable Contracts ---------- */
    /// @dev 为可升级合约预留存储空间，防止存储布局冲突
    uint256[50] private __gap;
} 