// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { RiskUtils } from "../../utils/RiskUtils.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/// @notice PositionView 只读接口
/// @dev 用于从 PositionView 模块读取用户仓位数据，避免循环依赖
interface IPositionViewRead {
    /// @notice 获取用户指定资产的仓位信息
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return 抵押数量和债务数量
    function getUserPosition(address user, address asset) external view returns (uint256, uint256);
}

/// @title PreviewView
/// @notice 预览类查询门面，基于 PositionView 读到的仓位做只读估算
/// @dev 不存业务状态，仅持有 Registry 指针；权威结果仍以 UserView/PositionView 为准
/// @dev 作为前端入口，提供 deposit/withdraw/borrow/repay 操作的预估接口
/// @dev 遵循双架构设计标准，提供 0-gas 查询接口
/// @custom:security-contact security@example.com
contract PreviewView is Initializable, UUPSUpgradeable, ViewVersioned {
    // ============ Errors ============
    /// @notice 未授权访问错误
    /// @dev 当调用者不是用户本人且不具有管理员或查看者角色时触发
    error PreviewView__Unauthorized();
    
    /// @notice 无效输入参数错误
    /// @dev 当资产地址为零地址时触发
    error PreviewView__InvalidInput();

    // ============ Storage ============
    /// @notice Registry 合约地址，用于模块解析和权限验证
    address private _registryAddr;

    // ============ Constants ============
    /// @notice 最小健康因子阈值（基点），10000 = 100%
    /// @dev 健康因子低于此值时，操作将被标记为不安全
    uint256 private constant MIN_HF_BPS = 10_000;
    
    /// @notice 最大贷款价值比（基点），7500 = 75%
    /// @dev 用于计算最大可借额度
    uint256 private constant MAX_LTV_BPS = 7_500;

    // ============ Modifiers ============
    /// @notice Registry 有效性验证修饰符
    /// @dev 确保 Registry 地址不为零地址，防止无效调用
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    /// @notice 用户或查看者权限验证修饰符
    /// @dev 允许用户本人、管理员或具有 VIEW_USER_DATA 角色的地址访问
    /// @param user 要查询的用户地址
    modifier onlyUserOrViewer(address user) {
        if (
            msg.sender != user &&
            !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender) &&
            !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, msg.sender)
        ) {
            revert PreviewView__Unauthorized();
        }
        _;
    }

    // ============ Initializer ============
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice 初始化合约并设置 Registry 地址
    /// @param initialRegistryAddr Registry 合约地址
    /// @dev 初始化 UUPS 可升级合约，设置 Registry 地址用于模块解析
    /// @custom:security 确保 Registry 地址不为零地址
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    // ============ Preview Functions ============
    
    /// @notice 预览抵押操作后的健康因子
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 抵押数量
    /// @return hfAfter 抵押后的健康因子（基点）
    /// @return ok 是否满足最小健康因子要求
    /// @dev 基于当前仓位计算增加抵押后的健康因子，用于前端预览
    /// @dev 健康因子计算公式：HF = (collateral * 10000) / debt
    /// @dev 当债务为 0 时，健康因子返回最大值
    function previewDeposit(address user, address asset, uint256 amount)
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (uint256 hfAfter, bool ok)
    {
        if (asset == address(0)) revert PreviewView__InvalidInput();
        (uint256 collateral, uint256 debt) = _getPosition(user, asset);
        uint256 newCollateral = collateral + amount;
        hfAfter = _calcHF(newCollateral, debt);
        ok = hfAfter >= MIN_HF_BPS;
    }

    /// @notice 预览提取抵押物后的健康因子
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 提取数量
    /// @return hfAfter 提取后的健康因子（基点）
    /// @return ok 是否满足最小健康因子要求
    /// @dev 基于当前仓位计算减少抵押后的健康因子
    /// @dev 如果提取数量超过抵押品，新抵押品将归零
    function previewWithdraw(address user, address asset, uint256 amount)
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (uint256 hfAfter, bool ok)
    {
        if (asset == address(0)) revert PreviewView__InvalidInput();
        (uint256 collateral, uint256 debt) = _getPosition(user, asset);
        uint256 newCollateral = collateral > amount ? collateral - amount : 0;
        hfAfter = _calcHF(newCollateral, debt);
        ok = hfAfter >= MIN_HF_BPS;
    }

    /// @notice 预览借款操作后的健康因子、贷款价值比和最大可借额度
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param collateralAdd 新增抵押数量
    /// @param borrowAmount 借款数量
    /// @return newHF 借款后的健康因子（基点）
    /// @return newLTV 借款后的贷款价值比（基点）
    /// @return maxBorrowable 最大可借额度（如果已达到最大 LTV 则返回 0）
    /// @dev 计算新增抵押和借款后的健康因子和 LTV
    /// @dev 最大可借额度 = (新抵押品 * MAX_LTV_BPS / 10000) - 新债务
    /// @dev 注意：函数签名中包含预留参数 collateralIn（当前未使用），用于未来扩展
    function previewBorrow(
        address user,
        address asset,
        uint256 /*collateralIn*/,
        uint256 collateralAdd,
        uint256 borrowAmount
    )
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (uint256 newHF, uint256 newLTV, uint256 maxBorrowable)
    {
        if (asset == address(0)) revert PreviewView__InvalidInput();
        (uint256 collateral, uint256 debt) = _getPosition(user, asset);

        uint256 newCollateral = collateral + collateralAdd;
        uint256 newDebt = debt + borrowAmount;

        newHF = _calcHF(newCollateral, newDebt);
        newLTV = _calcLTV(newCollateral, newDebt);

        uint256 maxDebt = (newCollateral * MAX_LTV_BPS) / 10_000;
        if (newDebt >= maxDebt) {
            maxBorrowable = 0;
        } else {
            maxBorrowable = maxDebt - newDebt;
        }
    }

    /// @notice 预览还款操作后的健康因子和贷款价值比
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 还款数量
    /// @return newHF 还款后的健康因子（基点）
    /// @return newLTV 还款后的贷款价值比（基点）
    /// @dev 如果还款数量大于等于债务，债务将归零
    /// @dev 当债务归零时，健康因子返回最大值，LTV 返回 0
    function previewRepay(address user, address asset, uint256 amount)
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (uint256 newHF, uint256 newLTV)
    {
        if (asset == address(0)) revert PreviewView__InvalidInput();
        (uint256 collateral, uint256 debt) = _getPosition(user, asset);
        uint256 newDebt = amount >= debt ? 0 : debt - amount;
        newHF = _calcHF(collateral, newDebt);
        newLTV = _calcLTV(collateral, newDebt);
    }

    // ============ Internal Functions ============
    
    /// @notice 获取 PositionView 模块实例
    /// @return PositionView 模块接口实例
    /// @dev 从 Registry 动态解析 PositionView 模块地址
    function _positionView() internal view returns (IPositionViewRead) {
        return IPositionViewRead(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_POSITION_VIEW));
    }

    /// @notice 获取用户指定资产的仓位信息
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return collateral 抵押数量
    /// @return debt 债务数量
    /// @dev 委托调用 PositionView 获取用户仓位数据
    function _getPosition(address user, address asset) internal view returns (uint256 collateral, uint256 debt) {
        return _positionView().getUserPosition(user, asset);
    }

    /// @notice 计算健康因子
    /// @param collateral 抵押数量
    /// @param debt 债务数量
    /// @return 健康因子（基点），债务为 0 时返回最大值，抵押为 0 时返回 0
    /// @dev 健康因子计算公式：HF = (collateral * 10000) / debt
    function _calcHF(uint256 collateral, uint256 debt) internal pure returns (uint256) {
        if (debt == 0) return type(uint256).max;
        if (collateral == 0) return 0;
        return (collateral * 10_000) / debt;
    }

    /// @notice 计算贷款价值比
    /// @param collateral 抵押数量
    /// @param debt 债务数量
    /// @return 贷款价值比（基点），抵押或债务为 0 时返回 0
    /// @dev 委托调用 RiskUtils.calculateLTV 进行计算
    function _calcLTV(uint256 collateral, uint256 debt) internal pure returns (uint256) {
        if (collateral == 0) return 0;
        if (debt == 0) return 0;
        return RiskUtils.calculateLTV(debt, collateral);
    }

    // ============ UUPS Upgrade Functions ============
    
    /// @notice UUPS 升级授权函数
    /// @param newImplementation 新实现合约地址
    /// @dev 仅允许具有 ACTION_ADMIN 角色的地址执行升级
    /// @dev 确保新实现地址不为零地址
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    // ============ Public Getters ============
    
    /// @notice 获取 Registry 合约地址
    /// @return Registry 合约地址
    /// @dev 兼容旧版接口的 getter 函数
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

    /// @notice Storage gap for future upgrades
    uint256[50] private __gap;
} 