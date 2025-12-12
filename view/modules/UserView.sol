// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { Registry } from "../../../registry/Registry.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";
import { HealthView } from "./HealthView.sol";
import { PositionView } from "./PositionView.sol";
import { DashboardView } from "./DashboardView.sol";
import { RiskUtils } from "../../utils/RiskUtils.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";

/// @title UserView
/// @notice 用户视图模块 - 轻量级外观（Facade）模式，委托调用到专业子模块
/// @dev 采用外观（Facade）模式重构，委托调用到 HealthView、PositionView 和 DashboardView
/// @dev 遵循双架构设计标准，提供0-gas查询接口
/// @dev 保留原有API兼容性，确保其他模块引用不受影响
/// @custom:security-contact security@example.com
contract UserView is Initializable, UUPSUpgradeable {
    
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
    
    /// @notice 权限验证内部函数
    /// @param actionKey 动作键
    /// @param user 用户地址
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }
    
    /// @notice 角色检查内部函数
    /// @param actionKey 动作键
    /// @param user 用户地址
    /// @return 是否具有角色
    function _hasRole(bytes32 actionKey, address user) internal view returns (bool) {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        return IAccessControlManager(acmAddr).hasRole(actionKey, user);
    }
    
    /// @notice 用户数据访问验证修饰符 - 严格模式
    modifier onlyUserOrStrictAdmin(address user) {
        require(
            msg.sender == user || 
            _hasRole(ActionKeys.ACTION_ADMIN, msg.sender),
            "UserView: unauthorized access"
        );
        _;
    }
    
    /// @notice 用户数据访问验证修饰符 - 宽松模式（包含前端服务）
    modifier onlyUserOrServiceAdmin(address user) {
        require(
            msg.sender == user || 
            _hasRole(ActionKeys.ACTION_ADMIN, msg.sender) ||
            _hasRole(ActionKeys.ACTION_VIEW_USER_DATA, msg.sender),
            "UserView: unauthorized access"
        );
        _;
    }
    
    /// @notice 批量操作权限验证修饰符
    modifier onlyBatchOperator() {
        require(
            _hasRole(ActionKeys.ACTION_ADMIN, msg.sender) ||
            _hasRole(ActionKeys.ACTION_VIEW_USER_DATA, msg.sender),
            "UserView: unauthorized batch operation"
        );
        _;
    }
    
    /// @notice 初始化用户视图模块
    /// @param initialRegistryAddr Registry合约地址
    /// @custom:security 确保所有地址参数不为零地址
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
        
        // 发出数据推送事件
        DataPushLibrary._emitData(keccak256("USER_VIEW_INITIALIZED"), abi.encode(initialRegistryAddr, block.timestamp));
    }
    
    /* ============ 内部辅助函数：获取子模块 ============ */
    
    /// @notice 获取HealthView模块
    /// @return HealthView模块实例
    function _healthView() internal view returns (HealthView) {
        return HealthView(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_HEALTH_VIEW));
    }
    
    /// @notice 获取PositionView模块
    /// @return PositionView模块实例
    function _positionView() internal view returns (PositionView) {
        return PositionView(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_POSITION_VIEW));
    }
    
    /// @notice 获取DashboardView模块
    /// @return DashboardView模块实例
    function _dashboardView() internal view returns (DashboardView) {
        return DashboardView(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_DASHBOARD_VIEW));
    }
    
    /* ============ 用户状态查询 - 委托到PositionView ============ */
    
    /// @notice 查询指定用户指定资产的抵押和借款余额（严格权限）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return collateral 抵押数量
    /// @return debt 债务数量
    function getUserPosition(address user, address asset) external view onlyUserOrStrictAdmin(user) returns (uint256 collateral, uint256 debt) {
        return _positionView().getUserPosition(user, asset);
    }
    
    /// @notice 查询指定用户指定资产的抵押和借款余额（服务权限）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return collateral 抵押数量
    /// @return debt 债务数量
    function getUserPositionService(address user, address asset) external view onlyUserOrServiceAdmin(user) returns (uint256 collateral, uint256 debt) {
        return _positionView().getUserPosition(user, asset);
    }
    
    /// @notice 查询用户持有的指定代币余额
    /// @param user 用户地址
    /// @param token 代币地址
    /// @return balance 代币余额
    function getUserTokenBalance(address user, address token) external view onlyUserOrStrictAdmin(user) returns (uint256 balance) {
        // 直接调用ERC20合约，无需委托
        (bool success, bytes memory data) = token.staticcall(
            abi.encodeWithSignature("balanceOf(address)", user)
        );
        require(success, "UserView: token balance query failed");
        return abi.decode(data, (uint256));
    }
    
    /// @notice 查询用户持有的结算代币余额
    /// @param user 用户地址
    /// @return balance 结算代币余额
    function getUserSettlementBalance(address user) external view onlyUserOrStrictAdmin(user) returns (uint256 balance) {
        // 暂时返回0，后续可从Registry系统获取结算代币地址
        return 0;
    }
    
    /// @notice 查询用户总抵押价值（以结算币计价）
    /// @param user 用户地址
    /// @return totalValue 用户总抵押价值
    function getUserTotalCollateral(address user) external view onlyUserOrStrictAdmin(user) returns (uint256 totalValue) {
        DashboardView.UserDashboardView memory dashView = _dashboardView().getUserDashboardView(user, address(0));
        return dashView.collateralValue;
    }
    
    /// @notice 查询用户总债务价值（以结算币计价）
    /// @param user 用户地址
    /// @return totalValue 用户总债务价值
    function getUserTotalDebt(address user) external view onlyUserOrStrictAdmin(user) returns (uint256 totalValue) {
        DashboardView.UserDashboardView memory dashView = _dashboardView().getUserDashboardView(user, address(0));
        return dashView.debtValue;
    }
    
    /// @notice 查询指定用户指定资产的抵押数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return collateral 抵押数量
    function getUserCollateral(address user, address asset) external view onlyUserOrStrictAdmin(user) returns (uint256 collateral) {
        (collateral, ) = _positionView().getUserPosition(user, asset);
    }
    
    /// @notice 查询指定用户指定资产的债务数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return debt 债务数量
    function getUserDebt(address user, address asset) external view onlyUserOrStrictAdmin(user) returns (uint256 debt) {
        (, debt) = _positionView().getUserPosition(user, asset);
    }
    
    /* ============ 健康因子查询 - 委托到HealthView ============ */
    
    /// @notice 查询指定用户当前健康因子（bps）
    /// @param user 用户地址
    /// @return hf 健康因子
    function getHealthFactor(address user) external view onlyUserOrStrictAdmin(user) returns (uint256 hf) {
        (hf, ) = _healthView().getUserHealthFactor(user);
    }
    
    /// @notice 查询用户健康因子（简化版本，不指定资产）
    /// @param user 用户地址
    /// @return hf 健康因子
    function getUserHealthFactor(address user) external view onlyUserOrStrictAdmin(user) returns (uint256 hf) {
        return this.getHealthFactor(user);
    }
    
    /// @notice 聚合查询用户指定资产统计信息
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return stats 用户统计信息
    function getUserStats(address user, address asset) external view onlyUserOrStrictAdmin(user) returns (UserStats memory stats) {
        (uint256 collateral, uint256 debt) = _positionView().getUserPosition(user, asset);
        (uint256 hf, ) = _healthView().getUserHealthFactor(user);
        
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
    ) external view onlyUserOrStrictAdmin(user) returns (uint256 newHF, uint256 newLTV, uint256 maxBorrowable) {
        address previewViewAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_PREVIEW_VIEW);
        (bool success, bytes memory data) = previewViewAddr.staticcall(
            abi.encodeWithSignature(
                "previewBorrow(address,address,uint256,uint256,uint256)",
                user, asset, collateralIn, collateralAdded, borrowAmount
            )
        );
        require(success, "UserView: previewBorrow call failed");
        return abi.decode(data, (uint256, uint256, uint256));
    }
    
    /// @notice 预估增加抵押后健康因子
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 抵押数量
    /// @return hfAfter 抵押后健康因子
    /// @return ok 是否满足最小健康因子要求
    function previewDeposit(address user, address asset, uint256 amount) external view onlyUserOrStrictAdmin(user) returns (uint256 hfAfter, bool ok) {
        address previewViewAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_PREVIEW_VIEW);
        (bool success, bytes memory data) = previewViewAddr.staticcall(
            abi.encodeWithSignature(
                "previewDeposit(address,address,uint256)",
                user, asset, amount
            )
        );
        require(success, "UserView: previewDeposit call failed");
        return abi.decode(data, (uint256, bool));
    }
    
    /// @notice 预估还款操作后的状态
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 还款数量
    /// @return newHF 还款后健康因子
    /// @return newLTV 还款后贷款价值比
    function previewRepay(address user, address asset, uint256 amount) external view onlyUserOrStrictAdmin(user) returns (uint256 newHF, uint256 newLTV) {
        address previewViewAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_PREVIEW_VIEW);
        (bool success, bytes memory data) = previewViewAddr.staticcall(
            abi.encodeWithSignature(
                "previewRepay(address,address,uint256)",
                user, asset, amount
            )
        );
        require(success, "UserView: previewRepay call failed");
        return abi.decode(data, (uint256, uint256));
    }
    
    /// @notice 预估提取抵押物后的状态
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 提取数量
    /// @return newHF 提取后健康因子
    /// @return ok 是否安全
    function previewWithdraw(address user, address asset, uint256 amount) external view onlyUserOrStrictAdmin(user) returns (uint256 newHF, bool ok) {
        address previewViewAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_PREVIEW_VIEW);
        (bool success, bytes memory data) = previewViewAddr.staticcall(
            abi.encodeWithSignature(
                "previewWithdraw(address,address,uint256)",
                user, asset, amount
            )
        );
        require(success, "UserView: previewWithdraw call failed");
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
    ) external view onlyBatchOperator returns (uint256[] memory collaterals, uint256[] memory debts) {
        return _positionView().batchGetUserPositions(users, assets);
    }
    
    /// @notice 批量查询用户健康因子
    /// @param users 用户地址数组
    /// @return healthFactors 健康因子数组
    function batchGetUserHealthFactors(
        address[] calldata users
    ) external view onlyBatchOperator returns (uint256[] memory healthFactors) {
        (healthFactors, ) = _healthView().batchGetHealthFactors(users);
        return healthFactors;
    }
    
    /* ============ 升级控制 ============ */
    
    function _authorizeUpgrade(address) internal view override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
    }

    /// @notice 外部只读：获取 Registry 地址（向后兼容）
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    /// @notice 兼容旧版自动 getter
    function registryAddr() external view returns (address) {
        return _registryAddr;
    }
}