// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { IPriceOracle } from "../../../interfaces/IPriceOracle.sol";
import { ILiquidationRiskManager } from "../../../interfaces/ILiquidationRiskManager.sol";
import { IRewardManager } from "../../../interfaces/IRewardManager.sol";
import { PositionView } from "./PositionView.sol";
import { HealthView }   from "./HealthView.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { RiskUtils }    from "../../utils/RiskUtils.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";

/// @title DashboardView
/// @notice 综合仪表盘查询：聚合 Position/Health/奖励等只读数据，供前端 0 gas 查询
/// @dev 本合约仅做只读聚合，不写入业务状态；健康因子/仓位等来源于各自 View 模块
/// @custom:security-contact security@example.com
contract DashboardView is Initializable, UUPSUpgradeable {
    // ============ Structures (不可减少字段) ============
    struct UserStats {
        uint256 collateral;
        uint256 debt;
        uint256 ltv; // bps
        uint256 hf;  // bps
    }
    struct UserFullView {
        uint256 collateral;
        uint256 debt;
        uint256 ltv;
        uint256 hf;
        uint256 maxBorrowable;
        bool isRisky;
    }
    struct UserDashboardView {
        // Position
        uint256 collateral;
        uint256 debt;
        uint256 collateralValue;
        uint256 debtValue;
        uint256 assetPrice;
        uint256 utilization; // bps
        // Risk
        uint256 ltv;
        uint256 hf;
        uint256 liquidationThreshold;
        uint256 maxBorrowable;
        bool    isRisky;
        uint256 healthFactorAfterWithdraw;
        uint256 daysToLiquidation;
        // Reward / Activity
        uint256 rewardPoints;
        uint8   userLevel;
        uint256 lastActiveTime;
        uint256 pendingGuarantee;
        // Cache meta
        uint256 cacheTimestamp;
        bool    cacheValid;
    }

    // ============ State ============
    /// @notice Registry 合约地址 (私有，仅内部使用)
    address private _registryAddr;
    uint256 private constant BASIS_POINTS = 10000;

    // ============ Modifiers & ACL ============
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }
    modifier onlyUserOrStrictAdmin(address user) {
        require(
            msg.sender == user || ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender),
            "DashboardView: unauthorized"
        );
        _;
    }

    // ============ Init ============
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    // ============ Public APIs ============
    /// @notice 返回用户简要统计（抵押/债务/LTV/HF）
    function getUserStats(address user, address asset) external view onlyUserOrStrictAdmin(user) returns (UserStats memory stats) {
        (uint256 collateral, uint256 debt) = _positionV().getUserPosition(user, asset);
        (uint256 hf, ) = _healthV().getUserHealthFactor(user);
        uint256 ltv = RiskUtils.calculateLTV(debt, collateral);
        stats = UserStats({ collateral: collateral, debt: debt, ltv: ltv, hf: hf });
    }

    /// @notice 返回用户完整视图（包含最大可借与风险标识）
    function getUserFullView(address user, address asset) external view onlyUserOrStrictAdmin(user) returns (UserFullView memory fv) {
        (uint256 collateral, uint256 debt) = _positionV().getUserPosition(user, asset);
        (uint256 hf, ) = _healthV().getUserHealthFactor(user);
        uint256 ltv = RiskUtils.calculateLTV(debt, collateral);
        uint256 maxBorrowable = RiskUtils.calculateMaxBorrowable(collateral, debt, 8000); // 80% 默认阈值
        bool isRisky = hf < 11000; // 110% 默认阈值
        fv = UserFullView({ collateral: collateral, debt: debt, ltv: ltv, hf: hf, maxBorrowable: maxBorrowable, isRisky: isRisky });
    }

    /// @notice 返回仪表盘聚合视图
    function getUserDashboardView(address user, address asset) external view onlyUserOrStrictAdmin(user) returns (UserDashboardView memory dv) {
        PositionView pv = _positionV();
        HealthView   hv = _healthV();

        (uint256 collateral, uint256 debt) = pv.getUserPosition(user, asset);
        (uint256 hf, bool cacheValid)     = hv.getUserHealthFactor(user);

        // price
        uint256 price;
        address oracle = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_PRICE_ORACLE);
        if (oracle != address(0)) {
            try IPriceOracle(oracle).getPrice(asset) returns (uint256 p, uint256, uint256) { price = p; } catch {}
        }

        uint256 collateralValue = collateral * price / 1e18;
        uint256 debtValue       = debt * price / 1e18;
        uint256 ltv            = RiskUtils.calculateLTV(debt, collateral);
        uint256 maxBorrowable  = RiskUtils.calculateMaxBorrowable(collateral, debt, 8000);
        bool isRisky           = hf < 11000;

        // liquidation threshold
        uint256 liqThreshold;
        address riskMgr = Registry(_registryAddr).getModule(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        if (riskMgr != address(0)) {
            try ILiquidationRiskManager(riskMgr).getLiquidationThreshold() returns (uint256 th) { liqThreshold = th; } catch {}
        }
        if (liqThreshold == 0) liqThreshold = 8000;

        // reward info（占位：积分与等级来源于 Reward 模块）
        uint256 rewardPoints; uint8 level;
        address rm = Registry(_registryAddr).getModule(ModuleKeys.KEY_RM);
        if (rm != address(0)) {
            try IRewardManager(rm).getUserReward(user) returns (uint256 pts) { rewardPoints = pts; } catch {}
        }

        dv = UserDashboardView({
            collateral: collateral,
            debt: debt,
            collateralValue: collateralValue,
            debtValue: debtValue,
            assetPrice: price,
            utilization: collateralValue == 0 ? 0 : (debtValue * BASIS_POINTS) / collateralValue,
            ltv: ltv,
            hf: hf,
            liquidationThreshold: liqThreshold,
            maxBorrowable: maxBorrowable,
            isRisky: isRisky,
            healthFactorAfterWithdraw: debt == 0 ? type(uint256).max : 0,
            daysToLiquidation: 0,
            rewardPoints: rewardPoints,
            userLevel: level,
            lastActiveTime: pv.isUserCacheValid(user) ? block.timestamp : 0,
            pendingGuarantee: 0,
            cacheTimestamp: block.timestamp,
            cacheValid: cacheValid
        });

        // 说明：链下刷新触发由业务合约统一发出（DataPush），View 层不主动发事件
    }

    // ============ Internal views ============
    function _positionV() internal view returns (PositionView) {
        return PositionView(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_POSITION_VIEW));
    }
    function _healthV() internal view returns (HealthView) {
        return HealthView(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_HEALTH_VIEW));
    }

    // ============ UUPS ============
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        require(newImplementation != address(0), "DashboardView: zero impl");
    }
}
