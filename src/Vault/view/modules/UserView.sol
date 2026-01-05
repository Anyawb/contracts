// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { Registry } from "../../../registry/Registry.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";
import { RiskUtils } from "../../utils/RiskUtils.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../../constants/DataPushTypes.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/// @title UserView
/// @notice 用户视图模块 - 轻量级外观（Facade）模式，委托调用到专业子模块
/// @dev 采用外观（Facade）模式重构，委托调用到 HealthView、PositionView 等专业视图
/// @dev 遵循双架构设计标准，提供0-gas查询接口
/// @dev 保留原有API兼容性，确保其他模块引用不受影响
/// @custom:security-contact security@example.com
contract UserView is Initializable, UUPSUpgradeable, ViewVersioned {
    /// @notice 批量过大错误
    error UserView__BatchTooLarge(uint256 size);

    /// @notice 输入数组长度不匹配
    error UserView__LengthMismatch();
    
    /// @notice Registry 合约地址 (私有)
    address private _registryAddr;

    /// @notice 用户统计信息结构体
    struct UserStats {
        uint256 collateral; // 抵押数量
        uint256 debt;       // 债务数量
        uint256 ltv;        // 贷款价值比，单位bps
        uint256 hf;         // 健康因子，单位bps
    }
    
    /// @notice 用户完整视图数据结构体
    struct UserFullView {
        uint256 collateral;
        uint256 debt;
        uint256 ltv;
        uint256 hf;
        uint256 maxBorrowable;
        bool isRisky;
    }
    
    /// @notice 用户统计视图结构体
    struct UserStatisticsView {
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 healthFactor;
        uint256 lastActiveTime;
        bool isActive;
        uint256 guaranteeBalance;
        uint256 rewardPoints;
        uint8 userLevel;
        uint256 activityScore;
    }
    
    /// @notice 批量操作限制常量
    uint256 private constant MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;
    
    /// @notice Registry 有效性验证修饰符
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }
    
    /// @notice 初始化用户视图模块
    /// @param initialRegistryAddr Registry合约地址
    /// @custom:security 确保所有地址参数不为零地址
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
        
        // 发出数据推送事件
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_USER_VIEW_INITIALIZED, abi.encode(initialRegistryAddr, block.timestamp));
    }
    
    /* ============ 内部辅助函数：获取子模块 ============ */
    
    /// @notice 获取指定模块地址，失败时返回零地址
    function _getModule(bytes32 key) internal view returns (address module) {
        if (_registryAddr == address(0)) return address(0);
        try Registry(_registryAddr).getModule(key) returns (address m) {
            return m;
        } catch {
            return address(0);
        }
    }
    
    /// @notice 获取HealthView模块
    /// @return HealthView模块地址
    function _healthView() internal view returns (address) {
        return _getModule(ModuleKeys.KEY_HEALTH_VIEW);
    }
    
    /// @notice 获取PositionView模块
    /// @return PositionView模块地址
    function _positionView() internal view returns (address) {
        return _getModule(ModuleKeys.KEY_POSITION_VIEW);
    }
    
    /* ============ 用户状态查询 - 委托到PositionView ============ */
    
    /// @notice 查询指定用户指定资产的抵押和借款余额（严格权限）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return collateral 抵押数量
    /// @return debt 债务数量
    function getUserPosition(address user, address asset) external view onlyValidRegistry returns (uint256 collateral, uint256 debt) {
        address pv = _positionView();
        if (pv == address(0)) return (0, 0);
        (bool ok, bytes memory data) = pv.staticcall(abi.encodeWithSignature("getUserPosition(address,address)", user, asset));
        if (!ok || data.length < 64) return (0, 0);
        return abi.decode(data, (uint256, uint256));
    }
    
    /// @notice 查询指定用户指定资产的抵押和借款余额（服务权限）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return collateral 抵押数量
    /// @return debt 债务数量
    function getUserPositionService(address user, address asset) external view onlyValidRegistry returns (uint256 collateral, uint256 debt) {
        return this.getUserPosition(user, asset);
    }
    
    /// @notice 查询用户持有的指定代币余额
    /// @param user 用户地址
    /// @param token 代币地址
    /// @return balance 代币余额
    function getUserTokenBalance(address user, address token) external view onlyValidRegistry returns (uint256 balance) {
        // 直接调用ERC20合约，无需委托
        (bool success, bytes memory data) = token.staticcall(
            abi.encodeWithSignature("balanceOf(address)", user)
        );
        if (!success || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }
    
    /// @notice 查询用户持有的结算代币余额（占位接口）
    /// @dev 暂时返回 0；后续可从 Registry 获取结算代币地址后实现真正查询
    /// @param user 用户地址
    /// @return balance 结算代币余额
    function getUserSettlementBalance(address user) external pure returns (uint256 balance) {
        // silence unused param warning in a placeholder implementation
        user;
        return 0;
    }
    
    /// @notice 查询用户总抵押价值（以结算币计价）
    /// @param user 用户地址
    /// @return totalValue 用户总抵押价值
    function getUserTotalCollateral(address user) external view onlyValidRegistry returns (uint256 totalValue) {
        (totalValue, ) = this.getUserPosition(user, address(0));
    }
    
    /// @notice 查询用户总债务价值（以结算币计价）
    /// @param user 用户地址
    /// @return totalValue 用户总债务价值
    function getUserTotalDebt(address user) external view onlyValidRegistry returns (uint256 totalValue) {
        (, totalValue) = this.getUserPosition(user, address(0));
    }
    
    /// @notice 查询指定用户指定资产的抵押数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return collateral 抵押数量
    function getUserCollateral(address user, address asset) external view onlyValidRegistry returns (uint256 collateral) {
        (collateral, ) = this.getUserPosition(user, asset);
    }
    
    /// @notice 查询指定用户指定资产的债务数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return debt 债务数量
    function getUserDebt(address user, address asset) external view onlyValidRegistry returns (uint256 debt) {
        (, debt) = this.getUserPosition(user, asset);
    }
    
    /* ============ 健康因子查询 - 委托到HealthView ============ */
    
    /// @notice 查询指定用户当前健康因子（bps）
    /// @param user 用户地址
    /// @return hf 健康因子
    function getHealthFactor(address user) external view onlyValidRegistry returns (uint256 hf) {
        address hv = _healthView();
        if (hv == address(0)) return 0;
        (bool ok, bytes memory data) = hv.staticcall(abi.encodeWithSignature("getUserHealthFactor(address)", user));
        if (!ok || data.length < 64) return 0;
        (hf, ) = abi.decode(data, (uint256, bool));
    }
    
    /// @notice 查询用户健康因子（简化版本，不指定资产）
    /// @param user 用户地址
    /// @return hf 健康因子
    function getUserHealthFactor(address user) external view onlyValidRegistry returns (uint256 hf) {
        return this.getHealthFactor(user);
    }
    
    /// @notice 聚合查询用户指定资产统计信息
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return stats 用户统计信息
    function getUserStats(address user, address asset) external view onlyValidRegistry returns (UserStats memory stats) {
        (uint256 collateral, uint256 debt) = this.getUserPosition(user, asset);
        uint256 hf = this.getHealthFactor(user);
        
        // 计算 LTV (Loan-to-Value ratio)
        uint256 ltv = RiskUtils.calculateLTV(debt, collateral);
        
        stats = UserStats({
            collateral: collateral,
            debt: debt,
            ltv: ltv,
            hf: hf
        });
    }
    
    /* ============ 预览功能 - 委托到PreviewView ============ */
    
    /// @notice 预估借款操作后健康因子、LTV和最大可借额度
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param collateralIn 当前抵押数量
    /// @param collateralAdded 新增抵押数量
    /// @param borrowAmount 借款数量
    /// @return newHF 新的健康因子
    /// @return newLTV 新的贷款价值比
    /// @return maxBorrowable 最大可借额度
    function previewBorrow(
        address user,
        address asset,
        uint256 collateralIn,
        uint256 collateralAdded,
        uint256 borrowAmount
    ) external view onlyValidRegistry returns (uint256 newHF, uint256 newLTV, uint256 maxBorrowable) {
        address previewViewAddr = _getModule(ModuleKeys.KEY_PREVIEW_VIEW);
        if (previewViewAddr == address(0)) return (0, 0, 0);
        (bool success, bytes memory data) = previewViewAddr.staticcall(
            abi.encodeWithSignature(
                "previewBorrow(address,address,uint256,uint256,uint256)",
                user, asset, collateralIn, collateralAdded, borrowAmount
            )
        );
        if (!success || data.length < 96) return (0, 0, 0);
        return abi.decode(data, (uint256, uint256, uint256));
    }
    
    /// @notice 预估增加抵押后健康因子
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 抵押数量
    /// @return hfAfter 抵押后健康因子
    /// @return ok 是否满足最小健康因子要求
    function previewDeposit(address user, address asset, uint256 amount) external view onlyValidRegistry returns (uint256 hfAfter, bool ok) {
        address previewViewAddr = _getModule(ModuleKeys.KEY_PREVIEW_VIEW);
        if (previewViewAddr == address(0)) return (0, false);
        (bool success, bytes memory data) = previewViewAddr.staticcall(
            abi.encodeWithSignature(
                "previewDeposit(address,address,uint256)",
                user, asset, amount
            )
        );
        if (!success || data.length < 64) return (0, false);
        return abi.decode(data, (uint256, bool));
    }
    
    /// @notice 预估还款操作后的状态
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 还款数量
    /// @return newHF 还款后健康因子
    /// @return newLTV 还款后贷款价值比
    function previewRepay(address user, address asset, uint256 amount) external view onlyValidRegistry returns (uint256 newHF, uint256 newLTV) {
        address previewViewAddr = _getModule(ModuleKeys.KEY_PREVIEW_VIEW);
        if (previewViewAddr == address(0)) return (0, 0);
        (bool success, bytes memory data) = previewViewAddr.staticcall(
            abi.encodeWithSignature(
                "previewRepay(address,address,uint256)",
                user, asset, amount
            )
        );
        if (!success || data.length < 64) return (0, 0);
        return abi.decode(data, (uint256, uint256));
    }
    
    /// @notice 预估提取抵押物后的状态
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 提取数量
    /// @return newHF 提取后健康因子
    /// @return ok 是否安全
    function previewWithdraw(address user, address asset, uint256 amount) external view onlyValidRegistry returns (uint256 newHF, bool ok) {
        address previewViewAddr = _getModule(ModuleKeys.KEY_PREVIEW_VIEW);
        if (previewViewAddr == address(0)) return (0, false);
        (bool success, bytes memory data) = previewViewAddr.staticcall(
            abi.encodeWithSignature(
                "previewWithdraw(address,address,uint256)",
                user, asset, amount
            )
        );
        if (!success || data.length < 64) return (0, false);
        return abi.decode(data, (uint256, bool));
    }
    
    /* ============ 批量操作 - 委托到子模块 ============ */
    
    /// @notice 批量查询用户位置信息
    /// @param users 用户地址数组
    /// @param assets 资产地址数组
    /// @return collaterals 抵押数量数组
    /// @return debts 债务数量数组
    function batchGetUserPositions(
        address[] calldata users,
        address[] calldata assets
    ) external view onlyValidRegistry returns (uint256[] memory collaterals, uint256[] memory debts) {
        uint256 len = users.length;
        if (len != assets.length) revert UserView__LengthMismatch();
        if (len > MAX_BATCH_SIZE) revert UserView__BatchTooLarge(len);
        address pv = _positionView();
        if (pv == address(0)) {
            collaterals = new uint256[](len);
            debts = new uint256[](len);
            return (collaterals, debts);
        }
        (bool ok, bytes memory data) = pv.staticcall(abi.encodeWithSignature("batchGetUserPositions(address[],address[])", users, assets));
        if (!ok || data.length < 64) {
            collaterals = new uint256[](len);
            debts = new uint256[](len);
            return (collaterals, debts);
        }
        return abi.decode(data, (uint256[], uint256[]));
    }
    
    /// @notice 批量查询用户健康因子
    /// @param users 用户地址数组
    /// @return healthFactors 健康因子数组
    function batchGetUserHealthFactors(
        address[] calldata users
    ) external view onlyValidRegistry returns (uint256[] memory healthFactors) {
        uint256 len = users.length;
        if (len > MAX_BATCH_SIZE) revert UserView__BatchTooLarge(len);
        address hv = _healthView();
        if (hv == address(0)) {
            return new uint256[](len);
        }
        (bool ok, bytes memory data) = hv.staticcall(abi.encodeWithSignature("batchGetHealthFactors(address[])", users));
        if (!ok || data.length < 64) {
            return new uint256[](len);
        }
        (healthFactors, ) = abi.decode(data, (uint256[], bool[]));
        return healthFactors;
    }
    
    /* ============ 升级控制 ============ */
    
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    /// @notice 外部只读：获取 Registry 地址（向后兼容）
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    /// @notice 兼容旧版自动 getter
    function registryAddr() external view returns (address) {
        return _registryAddr;
    }

    // ============ Versioning (C+B baseline) ============
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /// @dev UUPS 升级预留插槽，避免存储冲突
    uint256[50] private __gap;
}