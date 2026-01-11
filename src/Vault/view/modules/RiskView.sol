// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { HealthFactorLib } from "../../../libraries/HealthFactorLib.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewVersioned } from "../ViewVersioned.sol";
import { ILendingEngineBasic } from "../../../interfaces/ILendingEngineBasic.sol";
import { IPositionViewValuation } from "../../../interfaces/IPositionViewValuation.sol";

/// @dev 轻量接口，读取 HealthView 缓存，避免循环依赖
interface IHealthViewLite {
    function getUserHealthFactor(address user) external view returns (uint256 healthFactor, bool isValid);
}

/**
 * @title RiskView
 * @notice 只读风险视图：基于 HealthView 缓存提供风险评估（健康因子、可清算、预警级别）
 * @dev 无状态，只做查询；模块地址实时从 Registry 解析；批量接口受 MAX_BATCH_SIZE 限制
 * @custom:security-contact security@example.com
 */
contract RiskView is Initializable, UUPSUpgradeable, ViewVersioned {
    // ============ Types ============
    enum WarningLevel { NONE, WARNING, CRITICAL }

    struct RiskAssessment {
        bool liquidatable;
        uint256 healthFactor; // 使用 HealthView 的格式（WAD / bps 由 HealthView 定义）
        WarningLevel warningLevel;
    }

    // ============ Storage ============
    address private _registryAddr;
    uint256 private constant MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;

    // ============ Errors ============
    error RiskView__BatchTooLarge();

    // ============ Modifiers ============
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    // ============ Init ============
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice 初始化 RiskView
    /// @param initialRegistryAddr Registry 地址
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    // ============ Public Views ============
    /// @notice 获取单个用户风险评估
    function getUserRiskAssessment(address user) external view onlyValidRegistry returns (RiskAssessment memory a) {
        uint256 hf = _healthFactor(user);
        a.healthFactor = hf;
        // HealthView 的健康因子单位为 bps（10_000 = 100%）。
        a.liquidatable = hf < 10_000;
        a.warningLevel = hf < 10_000 ? WarningLevel.CRITICAL : (hf < 11_000 ? WarningLevel.WARNING : WarningLevel.NONE);
    }

    /// @notice 计算排除保证金后的健康因子
    function calculateHealthFactorExcludingGuarantee(address user, address asset) external view onlyValidRegistry returns (uint256) {
        (uint256 totalCol, uint256 totalDebt) = _getUserTotals(user);
        uint256 guarantee = _getUserGuarantee(user, asset);
        uint256 effectiveCol = HealthFactorLib.effectiveCollateral(totalCol, guarantee);
        return HealthFactorLib.calcHealthFactor(effectiveCol, totalDebt);
    }

    /// @notice 批量获取风险评估
    function batchGetRiskAssessments(address[] calldata users) external view onlyValidRegistry returns (RiskAssessment[] memory arr) {
        if (users.length > MAX_BATCH_SIZE) revert RiskView__BatchTooLarge();
        uint256 len = users.length;
        arr = new RiskAssessment[](len);
        for (uint256 i; i < len; ) {
            arr[i] = _buildRisk(users[i]);
            unchecked { ++i; }
        }
    }

    /// @notice 当前 Registry 地址
    function registryAddr() external view returns (address) { return _registryAddr; }

    // ============ Internal helpers ============
    function _buildRisk(address user) internal view returns (RiskAssessment memory a) {
        uint256 hf = _healthFactor(user);
        a.healthFactor = hf;
        a.liquidatable = hf < 10_000;
        a.warningLevel = hf < 10_000 ? WarningLevel.CRITICAL : (hf < 11_000 ? WarningLevel.WARNING : WarningLevel.NONE);
    }

    function _healthFactor(address user) internal view returns (uint256) {
        address hv = _getModule(ModuleKeys.KEY_HEALTH_VIEW);
        if (hv != address(0)) {
            try IHealthViewLite(hv).getUserHealthFactor(user) returns (uint256 hf, bool valid) {
                return valid ? hf : 10_000;
            } catch {}
        }
        return 10_000;
    }

    function _getUserTotals(address user) internal view returns (uint256 totalCollateral, uint256 totalDebt) {
        address le = _getModule(ModuleKeys.KEY_LE);
        address pv = _getModule(ModuleKeys.KEY_POSITION_VIEW);
        if (le != address(0)) {
            try ILendingEngineBasic(le).getUserTotalDebtValue(user) returns (uint256 v) {
                totalDebt = v;
            } catch {
                totalDebt = 0;
            }
        }
        if (pv != address(0)) {
            try IPositionViewValuation(pv).getUserTotalCollateralValue(user) returns (uint256 v) {
                totalCollateral = v;
            } catch {
                totalCollateral = 0;
            }
        }
    }

    function _getUserGuarantee(address user, address asset) internal view returns (uint256 amount) {
        address gfm = _getModule(ModuleKeys.KEY_GUARANTEE_FUND);
        if (gfm != address(0)) {
            (bool success, bytes memory data) = gfm.staticcall(abi.encodeWithSignature("getLockedGuarantee(address,address)", user, asset));
            if (success && data.length >= 32) amount = abi.decode(data, (uint256));
        }
    }

    function _getModule(bytes32 key) internal view returns (address moduleAddr) {
        moduleAddr = Registry(_registryAddr).getModule(key);
    }

    // ============ UUPS ============
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    // ============ Versioning (C+B baseline) ============
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    uint256[50] private __gap;
}