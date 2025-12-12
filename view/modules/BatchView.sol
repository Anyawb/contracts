// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { HealthView } from "./HealthView.sol";
import { RiskView } from "./RiskView.sol";
import { IPriceOracle } from "../../../interfaces/IPriceOracle.sol";
import { DegradationMonitor } from "../../../monitor/DegradationMonitor.sol";
import { DegradationStorage } from "../../../monitor/DegradationStorage.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";

/// @title BatchView
/// @notice 轻量级批量只读聚合器：聚合调用各 View 模块以减少 RPC 次数
contract BatchView is Initializable, UUPSUpgradeable {
    uint256 private constant MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;

    address private _registryAddr;

    // ======== Structs ========
    struct HealthFactorItem { address user; uint256 healthFactor; bool isValid; }
    struct RiskItem { address user; bool liquidatable; uint256 healthFactor; uint8 warningLevel; }
    struct AssetPriceItem { address asset; uint256 price; }
    struct ModuleHealthItem {
        address module;
        bool    isHealthy;
        bytes32 detailsHash;
        uint32  lastCheckTime;
        uint32  consecutiveFailures;
    }

    // ======== Modifiers ========
    modifier onlyValidRegistry() { require(_registryAddr!=address(0),"BatchView: registry"); _; }

    // ======== Init ========
    function initialize(address initialRegistryAddr) external initializer {
        require(initialRegistryAddr!=address(0),"BatchView: zero reg");
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    // ======== Batch helpers ========
    /// @notice 批量获取用户健康因子
    function batchGetHealthFactors(address[] calldata users) external view onlyValidRegistry returns (HealthFactorItem[] memory arr) {
        require(users.length<=MAX_BATCH_SIZE, "BatchView: batch");
        HealthView hv = HealthView(_getModule(ModuleKeys.KEY_HEALTH_VIEW));
        uint256 len = users.length;
        arr = new HealthFactorItem[](len);
        for (uint256 i;i<len;++i){ (uint256 hf,bool ok)=hv.getUserHealthFactor(users[i]); arr[i]=HealthFactorItem(users[i],hf,ok);} }

    /// @notice 批量获取风险评估（含可清算标记、健康因子、预警级别）
    function batchGetRiskAssessments(address[] calldata users) external view onlyValidRegistry returns (RiskItem[] memory arr) {
        require(users.length<=MAX_BATCH_SIZE, "BatchView: batch");
        RiskView rv = RiskView(_getModule(ModuleKeys.KEY_RISK_VIEW));
        uint256 len = users.length; arr = new RiskItem[](len);
        for (uint256 i;i<len;++i){ (RiskView.RiskAssessment memory a)=rv.getUserRiskAssessment(users[i]); arr[i]=RiskItem(users[i],a.liquidatable,a.healthFactor,uint8(a.warningLevel)); }
    }

    /// @notice 批量获取资产价格
    function batchGetAssetPrices(address[] calldata assets) external view onlyValidRegistry returns (AssetPriceItem[] memory arr) {
        require(assets.length<=MAX_BATCH_SIZE,"BatchView: batch");
        address oracle = _getModule(ModuleKeys.KEY_PRICE_ORACLE);
        uint256 len=assets.length; arr=new AssetPriceItem[](len);
        for(uint256 i;i<len;++i){ (uint256 price,,) = IPriceOracle(oracle).getPrice(assets[i]); arr[i]=AssetPriceItem(assets[i],price);} }

    /// @notice 批量获取模块健康缓存
    function batchGetModuleHealth(address[] calldata modules) external view onlyValidRegistry returns (ModuleHealthItem[] memory arr) {
        require(modules.length <= MAX_BATCH_SIZE, "BatchView: batch");
        HealthView hv = HealthView(_getModule(ModuleKeys.KEY_HEALTH_VIEW));
        uint256 len = modules.length;
        arr = new ModuleHealthItem[](len);
        for (uint256 i; i < len; ++i) {
            HealthView.ModuleHealth memory mh = hv.getModuleHealth(modules[i]);
            arr[i] = ModuleHealthItem(modules[i], mh.isHealthy, mh.detailsHash, mh.lastCheckTime, mh.consecutiveFailures);
        }
    }

    /// @notice 批量获取系统降级历史（按时间倒序）
    function getDegradationHistory(uint256 limit) external view onlyValidRegistry returns (DegradationStorage.DegradationEvent[] memory history){
        require(limit>0 && limit<=MAX_BATCH_SIZE, "BatchView: limit");
        address mon = _getModule(ModuleKeys.KEY_DEGRADATION_MONITOR);
        if(mon==address(0)){
            return new DegradationStorage.DegradationEvent[](0);
        }
        history = DegradationMonitor(mon).getSystemDegradationHistory(limit);
    }

    // ======== Internal ========
    function _getModule(bytes32 key) internal view returns (address) { return Registry(_registryAddr).getModuleOrRevert(key);} 

    // ======== UUPS ========
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        require(newImplementation!=address(0),"BatchView: zero impl");
    }

    /// @notice 兼容旧版 getter
    function registryAddr() external view returns(address){return _registryAddr;}
    /// @notice 统一风格 getter（推荐）
    function registryAddrVar() external view returns(address){return _registryAddr;}
}