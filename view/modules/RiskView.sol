// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
// 使用 HealthView 缓存替代计算器
import { ViewConstants } from "../ViewConstants.sol";
import { HealthFactorLib } from "../../../libraries/HealthFactorLib.sol";

/// @dev 轻量接口，读取 HealthView 缓存，避免循环依赖
interface IHealthViewLite {
    function getUserHealthFactor(address user) external view returns (uint256 healthFactor, bool isValid);
}

/**
 * @title RiskView 风险视图模块 / Risk Assessment View
 * @notice 依赖 HealthFactorCalculator，提供简化的风险评估（可清算、警告级别等），全部为 0 gas 查询接口。
 * @dev 仅做读取，不保存任何业务状态；批量接口受 ViewConstants.MAX_BATCH_SIZE 限制。
 * @custom:security-contact security@example.com
 */
contract RiskView is Initializable, UUPSUpgradeable {
    using HealthFactorLib for *;
    // ======== Types ========
    enum WarningLevel { NONE, WARNING, CRITICAL }

    struct RiskAssessment {
        bool liquidatable;
        uint256 healthFactor; // WAD
        WarningLevel warningLevel;
    }

    // ======== Storage ========
    // Registry contract address (private per §340-348 naming standard)
    address private _registryAddr;

    // ======== Modifiers ========
    modifier onlyValidRegistry() {
        require(_registryAddr != address(0), "RiskView: registry");
        _;
    }

    // ======== Init ========
    /**
     * @notice 初始化 RiskView
     * @param initialRegistryAddr Registry 合约地址
     */
    function initialize(address initialRegistryAddr) external initializer {
        require(initialRegistryAddr != address(0), "RiskView: zero reg");
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    // ======== Public APIs ========

    /**
     * @notice 获取单个用户风险评估 / Get risk assessment for a user
     * @param user 用户地址 / target user address
     * @return a RiskAssessment 结构体（含 liquidatable、healthFactor、warningLevel）
     */
    function getUserRiskAssessment(address user) external view returns (RiskAssessment memory a) {
        uint256 hf = _healthFactor(user);
        a.healthFactor  = hf;
        a.liquidatable  = hf < 1e18;
        a.warningLevel  = hf < 1e18 ? WarningLevel.CRITICAL : (hf < 11e17 ? WarningLevel.WARNING : WarningLevel.NONE);
    }

    /**
     * @notice 计算排除保证金后的健康因子（WAD）。
     * @dev 读取 CollateralManager / LendingEngine 聚合值与 GuaranteeFundManager 的保证金，进行派生计算；不修改状态。
     */
    function calculateHealthFactorExcludingGuarantee(address user, address asset) external view returns (uint256 healthFactorExcludingGuarantee) {
        // 读取聚合总额
        (uint256 totalCol, uint256 totalDebt) = _getUserTotals(user);
        // 读取用户保证金
        uint256 guarantee = _getUserGuarantee(user, asset);
        // 计算有效抵押
        uint256 effectiveCol = HealthFactorLib.effectiveCollateral(totalCol, guarantee);
        // 计算健康因子（WAD）
        return HealthFactorLib.calcHealthFactor(effectiveCol, totalDebt);
    }

    /**
     * @notice 批量获取风险评估 / Batch risk assessments
     * @param users 用户地址数组
     * @return arr RiskAssessment 数组，顺序与输入一致
     */
    function batchGetRiskAssessments(address[] calldata users) external view returns (RiskAssessment[] memory arr) {
        require(users.length <= ViewConstants.MAX_BATCH_SIZE, "RiskView: batch too large");
        uint256 len = users.length;
        arr = new RiskAssessment[](len);
        for (uint256 i; i < len; ++i) {
            arr[i] = this.getUserRiskAssessment(users[i]);
        }
    }

    // ======== Internal ========
    /**
     * @dev 内部辅助函数：通过 HealthFactorCalculator 获取用户健康因子。
     *      捕获异常并返回安全默认值 1e18（100%）。
     * @param user 用户地址。
     * @return 用户健康因子 (WAD)。
     */
    function _healthFactor(address user) internal view returns (uint256) {
        address hv = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_HEALTH_VIEW);
        try IHealthViewLite(hv).getUserHealthFactor(user) returns (uint256 hf, bool valid) {
            return valid ? hf : 1e18; // fallback safe default
        } catch {
            return 1e18; // safe default
        }
    }

    function _getUserTotals(address user) internal view returns (uint256 totalCollateral, uint256 totalDebt) {
        address le = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        (bool dsuccess, bytes memory ddata) = le.staticcall(abi.encodeWithSignature("getUserTotalDebtValue(address)", user));
        if (dsuccess && ddata.length >= 32) {
            totalDebt = abi.decode(ddata, (uint256));
        }
        (bool csuccess, bytes memory cdata) = cm.staticcall(abi.encodeWithSignature("getUserTotalCollateralValue(address)", user));
        if (csuccess && cdata.length >= 32) {
            totalCollateral = abi.decode(cdata, (uint256));
        }
    }

    function _getUserGuarantee(address user, address asset) internal view returns (uint256 amount) {
        address gfm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_GUARANTEE_FUND);
        (bool success, bytes memory data) = gfm.staticcall(abi.encodeWithSignature("getLockedGuarantee(address,address)", user, asset));
        if (success && data.length >= 32) {
            amount = abi.decode(data, (uint256));
        }
    }

    

    // ======== UUPS ========
    /**
     * @dev UUPS 升级授权
     * @param newImplementation 新实现地址
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        address acm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acm).requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        require(newImplementation != address(0), "RiskView: zero impl");
    }
} 