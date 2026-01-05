// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../registry/Registry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { IVaultRouter } from "../interfaces/IVaultRouter.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { ILendingEngineBasic } from "../interfaces/ILendingEngineBasic.sol";

/// @title VaultCore
/// @notice 双架构设计的极简入口合约 - 事件驱动 + View层缓存
/// @dev 遵循双架构设计：极简入口，传送数据至View层，支持Registry升级
/// @dev 移除复杂逻辑：权限验证、业务委托、资产白名单验证、暂停/恢复功能
/// @dev 只保留核心功能：用户操作传送、Registry升级能力、基础传送合约地址能力
/// @custom:security-contact security@example.com
contract VaultCore is Initializable, UUPSUpgradeable {
    
    /*━━━━━━━━━━━━━━━ 基础配置 ━━━━━━━━━━━━━━━*/
    
    /// @notice Registry 合约地址
    address private _registryAddr;
    
    /// @notice View层合约地址
    address private _viewContractAddr;
    
    /*━━━━━━━━━━━━━━━ 错误定义 ━━━━━━━━━━━━━━━*/
    
    error VaultCore__ZeroAddress();
    error VaultCore__InvalidAmount();
    error VaultCore__UnauthorizedModule();
    
    /*━━━━━━━━━━━━━━━ 权限控制 ━━━━━━━━━━━━━━━*/
    
    /// @notice 管理员权限验证修饰符
    modifier onlyAdmin() {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        require(IAccessControlManager(acmAddr).hasRole(ActionKeys.ACTION_ADMIN, msg.sender), "Not admin");
        _;
    }

    /// @notice 仅允许登记的业务模块（CM/LE/清算/VBL）调用
    modifier onlyBusinessModule() {
        if (!_isBusinessModule(msg.sender)) revert VaultCore__UnauthorizedModule();
        _;
    }

    /*━━━━━━━━━━━━━━━ 构造和初始化 ━━━━━━━━━━━━━━━*/
    
    /// @notice 初始化函数
    /// @param initialRegistryAddr Registry合约地址
    /// @param initialViewContractAddr View层合约地址
    function initialize(address initialRegistryAddr, address initialViewContractAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert VaultCore__ZeroAddress();
        if (initialViewContractAddr == address(0)) revert VaultCore__ZeroAddress();
        
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
        _viewContractAddr = initialViewContractAddr;
    }
    
    /// @notice 显式暴露 Registry 合约地址
    function registryAddrVar() external view returns (address) {
        return _registryAddr;
    }

    /// @notice 获取 View 层合约地址
    /// @dev 供各业务/清算模块解析 VaultRouter 地址使用
    function viewContractAddrVar() external view returns (address) {
        return _viewContractAddr;
    }
    
    /*━━━━━━━━━━━━━━━ 用户操作（传送数据至 View 层）━━━━━━━━━━━━━━━*/
    
    /// @notice 存款操作 - 传送数据至View层
    /// @param asset 资产地址
    /// @param amount 存款金额
    /// @dev 极简实现：只验证基础参数，传送数据至View层
    function deposit(address asset, uint256 amount) external {
        require(amount > 0, "Amount must be positive");
        IVaultRouter(_viewContractAddr).processUserOperation(msg.sender, ActionKeys.ACTION_DEPOSIT, asset, amount, block.timestamp);
    }
    
    /// @notice 借款操作 - 传送数据至View层
    /// @param asset 资产地址
    /// @param amount 借款金额
    /// @dev 极简实现：直接调用借贷引擎进行账本写入，遵循单一入口
    function borrow(address asset, uint256 amount) external {
        require(amount > 0, "Amount must be positive");
        address lendingEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        ILendingEngineBasic(lendingEngine).borrow(msg.sender, asset, amount, 0, 0);
    }

    /// @notice 为指定借款人记账借款（撮合/结算路径使用）
    /// @dev 仅允许登记的业务模块调用（如 VaultBusinessLogic）
    /// @param borrower 借款人地址
    /// @param asset 债务资产地址
    /// @param amount 借款金额
    /// @param termDays 借款期限（天）
    function borrowFor(address borrower, address asset, uint256 amount, uint16 termDays) external onlyBusinessModule {
        if (borrower == address(0) || asset == address(0)) revert VaultCore__ZeroAddress();
        if (amount == 0) revert VaultCore__InvalidAmount();
        address lendingEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        ILendingEngineBasic(lendingEngine).borrow(borrower, asset, amount, 0, termDays);
    }

    /// @notice 为指定用户记账还款（订单引擎还款路径使用，用于同步 VaultLendingEngine 账本）
    /// @dev 仅允许登记的业务模块调用（如 ORDER_ENGINE / VaultBusinessLogic 等）
    function repayFor(address user, address asset, uint256 amount) external onlyBusinessModule {
        if (user == address(0) || asset == address(0)) revert VaultCore__ZeroAddress();
        if (amount == 0) revert VaultCore__InvalidAmount();
        address lendingEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        ILendingEngineBasic(lendingEngine).repay(user, asset, amount);
    }
    
    /// @notice 还款操作 - 传送数据至View层
    /// @param asset 资产地址
    /// @param amount 还款金额
    /// @dev 极简实现：直接调用借贷引擎进行账本写入，遵循单一入口
    function repay(address asset, uint256 amount) external {
        require(amount > 0, "Amount must be positive");
        address lendingEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        ILendingEngineBasic(lendingEngine).repay(msg.sender, asset, amount);
    }
    
    /// @notice 提款操作 - 传送数据至View层
    /// @param asset 资产地址
    /// @param amount 提款金额
    /// @dev 极简实现：只验证基础参数，传送数据至View层
    function withdraw(address asset, uint256 amount) external {
        require(amount > 0, "Amount must be positive");
        IVaultRouter(_viewContractAddr).processUserOperation(msg.sender, ActionKeys.ACTION_WITHDRAW, asset, amount, block.timestamp);
    }

    /*━━━━━━━━━━━━━━━ 数据推送统一入口（VaultCore → VaultRouter）━━━━━━━━━━━━━━━*/

    /// @notice 业务模块推送用户头寸更新（兼容版本，不带上下文）
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt
    ) external onlyBusinessModule {
        _forwardUserPositionUpdate(user, asset, collateral, debt, bytes32(0), 0, 0);
    }

    /// @notice 业务模块推送用户头寸更新（携带 requestId/seq）
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq
    ) external onlyBusinessModule {
        _forwardUserPositionUpdate(user, asset, collateral, debt, requestId, seq, 0);
    }

    /// @notice 业务模块推送用户头寸更新（指定 nextVersion）
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        uint64 nextVersion
    ) external onlyBusinessModule {
        _forwardUserPositionUpdate(user, asset, collateral, debt, bytes32(0), 0, nextVersion);
    }

    /// @notice 业务模块推送用户头寸更新（携带 requestId/seq + nextVersion）
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external onlyBusinessModule {
        _forwardUserPositionUpdate(user, asset, collateral, debt, requestId, seq, nextVersion);
    }

    /// @notice 业务模块推送用户头寸增量更新（兼容版本，不带上下文）
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta
    ) external onlyBusinessModule {
        _forwardUserPositionUpdateDelta(user, asset, collateralDelta, debtDelta, bytes32(0), 0, 0);
    }

    /// @notice 业务模块推送用户头寸增量更新（携带 requestId/seq）
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        bytes32 requestId,
        uint64 seq
    ) external onlyBusinessModule {
        _forwardUserPositionUpdateDelta(user, asset, collateralDelta, debtDelta, requestId, seq, 0);
    }

    /// @notice 业务模块推送用户头寸增量更新（指定 nextVersion）
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        uint64 nextVersion
    ) external onlyBusinessModule {
        _forwardUserPositionUpdateDelta(user, asset, collateralDelta, debtDelta, bytes32(0), 0, nextVersion);
    }

    /// @notice 业务模块推送用户头寸增量更新（携带 requestId/seq + nextVersion）
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external onlyBusinessModule {
        _forwardUserPositionUpdateDelta(user, asset, collateralDelta, debtDelta, requestId, seq, nextVersion);
    }

    /// @notice 业务模块推送资产统计更新（兼容版本，不带上下文）
    function pushAssetStatsUpdate(
        address asset,
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 price
    ) external onlyBusinessModule {
        _forwardAssetStatsUpdate(asset, totalCollateral, totalDebt, price, bytes32(0), 0);
    }

    /// @notice 业务模块推送资产统计更新（携带 requestId/seq）
    function pushAssetStatsUpdate(
        address asset,
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 price,
        bytes32 requestId,
        uint64 seq
    ) external onlyBusinessModule {
        _forwardAssetStatsUpdate(asset, totalCollateral, totalDebt, price, requestId, seq);
    }
    
    /*━━━━━━━━━━━━━━━ Registry 基础升级能力 ━━━━━━━━━━━━━━━*/
    
    /// @notice 升级模块 - Registry基础升级能力
    /// @param moduleKey 模块键
    /// @param newAddress 新模块地址
    /// @dev 保留Registry升级能力，支持模块动态升级
    function upgradeModule(bytes32 moduleKey, address newAddress) external onlyAdmin {
        Registry(_registryAddr).setModuleWithReplaceFlag(moduleKey, newAddress, true);
    }
    
    /// @notice 执行模块升级 - Registry基础升级能力
    /// @param moduleKey 模块键
    /// @dev 保留Registry升级能力，支持模块升级执行
    function executeModuleUpgrade(bytes32 moduleKey) external onlyAdmin {
        Registry(_registryAddr).executeModuleUpgrade(moduleKey);
    }
    
    /*━━━━━━━━━━━━━━━ 基础传送合约地址的能力 ━━━━━━━━━━━━━━━*/
    
    /// @notice 获取模块地址 - 基础传送合约地址能力
    /// @param moduleKey 模块键
    /// @return moduleAddress 模块地址
    /// @dev 保留基础传送合约地址能力，支持动态模块访问
    function getModule(bytes32 moduleKey) external view returns (address moduleAddress) {
        return Registry(_registryAddr).getModuleOrRevert(moduleKey);
    }
    
    /// @notice 获取Registry地址 - 基础传送合约地址能力
    /// @return registryAddress Registry地址
    /// @dev 保留基础传送合约地址能力
    function getRegistry() external view returns (address registryAddress) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ 内部工具 ━━━━━━━━━━━━━━━*/

    function _isBusinessModule(address caller) internal view returns (bool) {
        address cm = _getModuleOrZero(ModuleKeys.KEY_CM);
        if (caller == cm && caller != address(0)) return true;

        address le = _getModuleOrZero(ModuleKeys.KEY_LE);
        if (caller == le && caller != address(0)) return true;

        address orderEngine = _getModuleOrZero(ModuleKeys.KEY_ORDER_ENGINE);
        if (caller == orderEngine && caller != address(0)) return true;

        address liquidation = _getModuleOrZero(ModuleKeys.KEY_LIQUIDATION_MANAGER);
        if (caller == liquidation && caller != address(0)) return true;

        address vbl = _getModuleOrZero(ModuleKeys.KEY_VAULT_BUSINESS_LOGIC);
        if (caller == vbl && caller != address(0)) return true;

        return false;
    }

    function _getModuleOrZero(bytes32 moduleKey) internal view returns (address moduleAddress) {
        try Registry(_registryAddr).getModuleOrRevert(moduleKey) returns (address moduleAddr) {
            moduleAddress = moduleAddr;
        } catch {}
    }

    function _forwardUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) internal {
        if (_viewContractAddr == address(0)) revert VaultCore__ZeroAddress();
        IVaultRouter(_viewContractAddr).pushUserPositionUpdate(user, asset, collateral, debt, requestId, seq, nextVersion);
    }

    function _forwardUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) internal {
        if (_viewContractAddr == address(0)) revert VaultCore__ZeroAddress();
        IVaultRouter(_viewContractAddr).pushUserPositionUpdateDelta(
            user,
            asset,
            collateralDelta,
            debtDelta,
            requestId,
            seq,
            nextVersion
        );
    }

    function _forwardAssetStatsUpdate(
        address asset,
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 price,
        bytes32 requestId,
        uint64 seq
    ) internal {
        if (_viewContractAddr == address(0)) revert VaultCore__ZeroAddress();
        IVaultRouter(_viewContractAddr).pushAssetStatsUpdate(asset, totalCollateral, totalDebt, price, requestId, seq);
    }
    
    /*━━━━━━━━━━━━━━━ 合约升级 ━━━━━━━━━━━━━━━*/
    
    /// @notice 升级授权函数
    /// @param newImplementation 新实现地址
    function _authorizeUpgrade(address newImplementation) internal view override {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        require(IAccessControlManager(acmAddr).hasRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender), "Not authorized");
        
        // 确保新实现地址不为零
        if (newImplementation == address(0)) revert VaultCore__ZeroAddress();
    }
}

 