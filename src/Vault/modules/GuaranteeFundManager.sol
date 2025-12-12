// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { AmountIsZero, ZeroAddress } from "../../errors/StandardErrors.sol";
import { ActionKeys } from "../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../constants/ModuleKeys.sol";
import { VaultTypes } from "../VaultTypes.sol";
import { Registry } from "../../registry/Registry.sol";
import { IAccessControlManager } from "../../interfaces/IAccessControlManager.sol";
import { DataPushLibrary } from "../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../constants/DataPushTypes.sol";

/// @notice 最小化 VaultCore 接口（用于解析 View/Statistics 地址）
interface IVaultCoreMinimal { function viewContractAddrVar() external view returns (address); }
/// @notice 最小化 StatisticsView 接口（用于推送保证金统计）
interface IStatisticsViewMinimal { function pushGuaranteeUpdate(address user, address asset, uint256 amount, bool isLocked) external; }

/// @notice 最小化 UserView 接口（用于推送用户保证金状态）
interface IUserViewMinimal { function pushGuaranteeStatus(address user, address asset, uint256 amount, bool isLocked) external; }

/// @notice 最小化 SystemView 接口（用于推送系统保证金统计）
interface ISystemViewMinimal { function pushGuaranteeStats(address asset, uint256 totalAmount, bool isIncrease) external; }

/// @title GuaranteeFundManager
/// @notice 保证金管理模块，负责锁定、释放和没收用户的借款保证金
/// @dev 使用 SafeERC20 确保安全的 ERC20 操作，仅 VaultCore 可调用核心功能
/// @dev 与 ActionKeys 和 ModuleKeys 集成，提供标准化的权限和模块管理
/// @dev 支持批量操作，提高 Gas 效率
/// @dev 支持升级功能，可升级实现合约
/// @dev 使用 ReentrancyGuard 防止重入攻击
/// @dev 使用Registry系统进行权限控制和模块管理，确保系统安全性
/// @custom:security-contact security@example.com
contract GuaranteeFundManager is 
    Initializable, 
    UUPSUpgradeable, 
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    /* ============ Storage ============ */
    /// @notice 用户各资产保证金映射：user → asset → guaranteeAmount
    mapping(address => mapping(address => uint256)) private _userGuarantees;
    
    /// @notice 各资产总保证金：asset → totalGuaranteeAmount
    mapping(address => uint256) private _totalGuaranteesByAsset;
    
    /// @notice VaultCore 合约地址（私有存储，遵循命名规范）
    address private _vaultCoreAddr;
    
    /// @notice Registry 合约地址（私有存储，遵循命名规范）
    address private _registryAddr;
    
    /// @notice 最大批量操作数量限制
    uint256 private constant MAX_BATCH_SIZE = 50;

    // 说明：本模块已移除“模块地址缓存”和“Registry 升级编排”相关存储，保持业务单一职责

    /// @notice Storage gap for upgrade safety  
    uint256[35] private __gap;

    /* ============ Errors ============ */
    error GuaranteeFundManager__OnlyVaultCore();
    error GuaranteeFundManager__LengthMismatch();
    error GuaranteeFundManager__EmptyArrays();
    error GuaranteeFundManager__BatchTooLarge();
    error GuaranteeFundManager__InvalidImplementation();

    /* ============ Events ============ */
    /// @notice 保证金锁定事件
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 保证金金额
    /// @param timestamp 时间戳
    event GuaranteeLocked(address indexed user, address indexed asset, uint256 amount, uint256 timestamp);

    /// @notice 保证金释放事件
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 释放金额
    /// @param timestamp 时间戳
    event GuaranteeReleased(address indexed user, address indexed asset, uint256 amount, uint256 timestamp);

    /// @notice 保证金没收事件
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 没收金额
    /// @param feeReceiver 费用接收者
    /// @param timestamp 时间戳
    event GuaranteeForfeited(address indexed user, address indexed asset, uint256 amount, address indexed feeReceiver, uint256 timestamp);

    // 说明：移除与“缓存/权限事件/注册表更新事件”相关的非业务事件，统一由 View/Registry 层处理

    // ============ Removed: Registry Upgrade Events moved to Registry/Governance ============

    /* ============ Modifiers ============ */
    /// @notice 仅限 VaultCore 合约调用
    modifier onlyVaultCore() {
        if (msg.sender != _vaultCoreAddr) revert GuaranteeFundManager__OnlyVaultCore();
        _;
    }

    /// @notice 验证Registry地址有效性
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    // ============ Removed: Registry Upgrade Modifiers moved to Registry/Governance ============

    // 说明：移除 owner() 解析（权限/owner 相关由 AccessControl/Registry 层统一提供）

    /* ============ Initializer ============ */
    /// @notice 初始化保证金管理模块
    /// @param initialVaultCoreAddr VaultCore 合约地址
    /// @param initialRegistryAddr Registry合约地址
    function initialize(
        address initialVaultCoreAddr, 
        address initialRegistryAddr,
        address /* upgradeAdmin */
    ) external initializer {
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        
        if (initialVaultCoreAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        // 注意：升级编排职责已迁移，保留参数以维持向后兼容，但不再存储使用
        
        _vaultCoreAddr = initialVaultCoreAddr;
        _registryAddr = initialRegistryAddr;
        
        // 升级编排相关参数不再在本模块持有
        
        // 发出标准化动作事件（统一数据推送架构）
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /* ============ Internal Functions ============ */
    /// @notice 权限校验（通过 Registry -> AccessControlManager）
    function _requireRole(bytes32 actionKey, address user) internal view {
        // 只做最小化职责：直接调用 ACM，异常上抛
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /// @notice 获取Registry地址
    /// @return Registry合约地址
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    // 说明：移除模块地址缓存与失败降级逻辑，避免模块承担缓存/降级职责

    /// @notice 安全获取模块地址（view版本，用于view函数）
    /// @param moduleKey 模块键
    /// @return 模块地址
    function _safeGetModuleView(bytes32 moduleKey) internal view returns (address) {
        try Registry(_registryAddr).getModuleOrRevert(moduleKey) returns (address moduleAddr) {
            return moduleAddr;
        } catch {
            return address(0);
        }
    }

    /// @notice 解析 StatisticsView 或聚合 View 地址（优先 KEY_STATS，其次通过 VaultCore 暴露的 view 合约）
    function _resolveStatisticsViewAddr() internal view returns (address) {
        // 主路径：通过 VaultCore 暴露的视图地址（统一解析策略）
        address vaultCore = _safeGetModuleView(ModuleKeys.KEY_VAULT_CORE);
        if (vaultCore != address(0)) {
            try IVaultCoreMinimal(vaultCore).viewContractAddrVar() returns (address v) {
                if (v != address(0)) return v;
            } catch {}
        }
        // 回退：KEY_STATS → 统计视图（迁移期保留）
        try Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_STATS) returns (address stats) {
            if (stats != address(0)) {
                return stats;
            }
        } catch {}
        return address(0);
    }

    /// @notice 推送保证金统计到 View 层（失败静默）
    function _pushGuaranteeUpdateToView(address user, address asset, uint256 amount, bool isLocked) internal {
        // 推送到 StatisticsView
        address stats = _resolveStatisticsViewAddr();
        if (stats != address(0)) {
            try IStatisticsViewMinimal(stats).pushGuaranteeUpdate(user, asset, amount, isLocked) { } catch { }
        }
        
        // 推送到 UserView 进行用户状态缓存
        address userView = _safeGetModuleView(ModuleKeys.KEY_USER_VIEW);
        if (userView != address(0)) {
            try IUserViewMinimal(userView).pushGuaranteeStatus(user, asset, amount, isLocked) { } catch { }
        }
        
        // 推送到 SystemView 进行系统统计
        address systemView = _safeGetModuleView(ModuleKeys.KEY_SYSTEM_VIEW);
        if (systemView != address(0)) {
            try ISystemViewMinimal(systemView).pushGuaranteeStats(asset, amount, isLocked) { } catch { }
        }
    }

    // 说明：地址校验与模块升级在 Registry/VaultCore 层处理

    /// @notice 获取VaultCore地址
    /// @return VaultCore合约地址
    function vaultCoreAddr() external view returns (address) {
        return _vaultCoreAddr;
    }

    /// @notice 获取Registry地址（别名）
    /// @return Registry合约地址
    function registryAddr() external view returns (address) {
        return _registryAddr;
    }



    /* ============ View Functions ============ */
    /// @notice 查询用户指定资产的锁定保证金
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return amount 锁定保证金金额
    function getLockedGuarantee(address user, address asset) external view returns (uint256 amount) {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        return _userGuarantees[user][asset];
    }

    /// @notice 查询指定资产的总保证金
    /// @param asset 资产地址
    /// @return totalAmount 总保证金金额
    function getTotalGuaranteeByAsset(address asset) external view returns (uint256 totalAmount) {
        if (asset == address(0)) revert ZeroAddress();
        return _totalGuaranteesByAsset[asset];
    }

    /// @notice 查询用户所有保证金资产列表
    /// @param user 用户地址
    /// @return assets 用户保证金的资产地址数组
    function getUserGuaranteeAssets(address user) external pure returns (address[] memory assets) {
        if (user == address(0)) revert ZeroAddress();
        // 这里简化实现，实际项目中可能需要维护用户资产列表
        // 暂时返回空数组，后续可以优化
        return new address[](0);
    }

    /// @notice 查询用户是否已支付（当前持有）保证金
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return paid 是否已支付
    function isGuaranteePaid(address user, address asset) external view returns (bool paid) {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        return _userGuarantees[user][asset] > 0;
    }



    /* ============ Core Functions ============ */
    /// @notice 锁定用户保证金
    /// @dev 仅 VaultCore 可调用
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 保证金金额
    function lockGuarantee(address user, address asset, uint256 amount) external onlyVaultCore onlyValidRegistry nonReentrant {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();
        
        // 先将资金从用户转入托管池
        IERC20(asset).safeTransferFrom(user, address(this), amount);

        // 更新用户保证金
        _userGuarantees[user][asset] += amount;
        _totalGuaranteesByAsset[asset] += amount;
        
        emit GuaranteeLocked(user, asset, amount, block.timestamp);
        
        // 发出标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_DEPOSIT,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_DEPOSIT),
            msg.sender,
            block.timestamp
        );

        // 统一数据推送 + View 层缓存更新
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_GUARANTEE_LOCKED,
            abi.encode(user, asset, amount, block.timestamp)
        );
        _pushGuaranteeUpdateToView(user, asset, amount, true);
    }

    /// @notice 释放用户保证金
    /// @dev 仅 VaultCore 可调用
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 释放金额
    function releaseGuarantee(address user, address asset, uint256 amount) external onlyVaultCore onlyValidRegistry nonReentrant {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();
        
        uint256 currentGuarantee = _userGuarantees[user][asset];
        if (currentGuarantee < amount) {
            amount = currentGuarantee; // 释放全部可用保证金
        }
        
        if (amount > 0) {
            _userGuarantees[user][asset] -= amount;
            _totalGuaranteesByAsset[asset] -= amount;
            
            // 安全转账给用户
            IERC20(asset).safeTransfer(user, amount);
            
            emit GuaranteeReleased(user, asset, amount, block.timestamp);
            
            // 发出标准化动作事件
            emit VaultTypes.ActionExecuted(
                ActionKeys.ACTION_WITHDRAW,
                ActionKeys.getActionKeyString(ActionKeys.ACTION_WITHDRAW),
                msg.sender,
                block.timestamp
            );

            // 统一数据推送 + View 层缓存更新
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_GUARANTEE_RELEASED,
                abi.encode(user, asset, amount, block.timestamp)
            );
            _pushGuaranteeUpdateToView(user, asset, amount, false);
        }
    }

    /// @notice 没收用户保证金
    /// @dev 仅 VaultCore 可调用
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param feeReceiver 费用接收者地址
    function forfeitGuarantee(address user, address asset, address feeReceiver) external onlyVaultCore onlyValidRegistry nonReentrant {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        if (feeReceiver == address(0)) revert ZeroAddress();
        
        uint256 currentGuarantee = _userGuarantees[user][asset];
        if (currentGuarantee > 0) {
            _userGuarantees[user][asset] = 0;
            _totalGuaranteesByAsset[asset] -= currentGuarantee;
            
            // 安全转账给费用接收者
            IERC20(asset).safeTransfer(feeReceiver, currentGuarantee);
            
            emit GuaranteeForfeited(user, asset, currentGuarantee, feeReceiver, block.timestamp);
            
            // 发出标准化动作事件
            emit VaultTypes.ActionExecuted(
                ActionKeys.ACTION_LIQUIDATE,
                ActionKeys.getActionKeyString(ActionKeys.ACTION_LIQUIDATE),
                msg.sender,
                block.timestamp
            );

            // 统一数据推送 + View 层缓存更新
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_GUARANTEE_FORFEITED,
                abi.encode(user, asset, currentGuarantee, feeReceiver, block.timestamp)
            );
            _pushGuaranteeUpdateToView(user, asset, currentGuarantee, false);
        }
    }

    /// @notice 早偿三方结算：一次性完成返还、罚金与平台手续费的分发
    /// @dev 仅由 VaultCore/业务编排模块调用；本函数执行真实转账
    function settleEarlyRepayment(
        address user,
        address asset,
        address lender,
        address platform,
        uint256 refundToBorrower,
        uint256 penaltyToLender,
        uint256 platformFee
    ) external onlyVaultCore onlyValidRegistry nonReentrant {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        uint256 total = _userGuarantees[user][asset];
        uint256 sum;
        unchecked { sum = refundToBorrower + penaltyToLender + platformFee; }
        if (sum != total) revert AmountIsZero(); // 使用统一错误以节约gas：表示分配总额与余额不匹配

        // 清零后再转账（CEI）
        _userGuarantees[user][asset] = 0;
        _totalGuaranteesByAsset[asset] -= total;

        if (refundToBorrower > 0) {
            IERC20(asset).safeTransfer(user, refundToBorrower);
            emit GuaranteeReleased(user, asset, refundToBorrower, block.timestamp);
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_GUARANTEE_RELEASED,
                abi.encode(user, asset, refundToBorrower, block.timestamp)
            );
            _pushGuaranteeUpdateToView(user, asset, refundToBorrower, false);
        }

        if (penaltyToLender > 0) {
            if (lender == address(0)) revert ZeroAddress();
            IERC20(asset).safeTransfer(lender, penaltyToLender);
            emit GuaranteeForfeited(user, asset, penaltyToLender, lender, block.timestamp);
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_GUARANTEE_FORFEITED,
                abi.encode(user, asset, penaltyToLender, lender, block.timestamp)
            );
            _pushGuaranteeUpdateToView(user, asset, penaltyToLender, false);
        }

        if (platformFee > 0) {
            if (platform == address(0)) revert ZeroAddress();
            IERC20(asset).safeTransfer(platform, platformFee);
            emit GuaranteeForfeited(user, asset, platformFee, platform, block.timestamp);
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_GUARANTEE_FORFEITED,
                abi.encode(user, asset, platformFee, platform, block.timestamp)
            );
            _pushGuaranteeUpdateToView(user, asset, platformFee, false);
        }

        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_REPAY,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_REPAY),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 部分没收：将指定金额的保证金没收给某个接收者
    function forfeitPartial(
        address user,
        address asset,
        address receiver,
        uint256 amount
    ) external onlyVaultCore onlyValidRegistry nonReentrant {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        if (receiver == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();
        uint256 bal = _userGuarantees[user][asset];
        if (amount > bal) revert AmountIsZero();

        _userGuarantees[user][asset] = bal - amount;
        _totalGuaranteesByAsset[asset] -= amount;

        IERC20(asset).safeTransfer(receiver, amount);
        emit GuaranteeForfeited(user, asset, amount, receiver, block.timestamp);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_GUARANTEE_FORFEITED,
            abi.encode(user, asset, amount, receiver, block.timestamp)
        );
        _pushGuaranteeUpdateToView(user, asset, amount, false);

        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_LIQUIDATE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_LIQUIDATE),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 多接收人没收：按数组一次性分发（默认要求全额分配）
    function settleDefault(
        address user,
        address asset,
        address[] calldata receivers,
        uint256[] calldata amounts
    ) external onlyVaultCore onlyValidRegistry nonReentrant {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        uint256 len = receivers.length;
        if (len == 0 || len != amounts.length) revert GuaranteeFundManager__LengthMismatch();
        if (len > MAX_BATCH_SIZE) revert GuaranteeFundManager__BatchTooLarge();

        uint256 bal = _userGuarantees[user][asset];
        uint256 sum;
        unchecked {
            for (uint256 i = 0; i < len; i++) {
                sum += amounts[i];
            }
        }
        if (sum != bal) revert AmountIsZero();

        // 清零后再转账
        _userGuarantees[user][asset] = 0;
        _totalGuaranteesByAsset[asset] -= bal;

        for (uint256 i = 0; i < len; i++) {
            address recv = receivers[i];
            uint256 amt = amounts[i];
            if (amt == 0) continue;
            if (recv == address(0)) revert ZeroAddress();
            IERC20(asset).safeTransfer(recv, amt);
            emit GuaranteeForfeited(user, asset, amt, recv, block.timestamp);
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_GUARANTEE_FORFEITED,
                abi.encode(user, asset, amt, recv, block.timestamp)
            );
            _pushGuaranteeUpdateToView(user, asset, amt, false);
        }

        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_LIQUIDATE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_LIQUIDATE),
            msg.sender,
            block.timestamp
        );
    }

    /* ============ Batch Operations ============ */
    /// @notice 批量锁定保证金
    /// @dev 仅 VaultCore 可调用
    /// @param user 用户地址
    /// @param assets 资产地址数组
    /// @param amounts 金额数组
    function batchLockGuarantees(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external onlyVaultCore onlyValidRegistry nonReentrant {
        if (user == address(0)) revert ZeroAddress();
        uint256 length = assets.length;
        if (length != amounts.length) revert GuaranteeFundManager__LengthMismatch();
        if (length == 0) revert GuaranteeFundManager__EmptyArrays();
        if (length > MAX_BATCH_SIZE) revert GuaranteeFundManager__BatchTooLarge();
        
        for (uint256 i = 0; i < length; i++) {
            address asset = assets[i];
            uint256 amount = amounts[i];
            
            if (amount == 0) continue;
            if (asset == address(0)) revert ZeroAddress();
            
            _userGuarantees[user][asset] += amount;
            _totalGuaranteesByAsset[asset] += amount;
            
            emit GuaranteeLocked(user, asset, amount, block.timestamp);

            // View 缓存更新（逐条），避免聚合不一致
            _pushGuaranteeUpdateToView(user, asset, amount, true);
        }
        
        // 发出标准化批量动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_BATCH_DEPOSIT,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_BATCH_DEPOSIT),
            msg.sender,
            block.timestamp
        );

        // 统一数据推送（批量）
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_BATCH_GUARANTEE_LOCKED,
            abi.encode(user, length, block.timestamp)
        );
    }

    /// @notice 批量释放保证金
    /// @dev 仅 VaultCore 可调用
    /// @param user 用户地址
    /// @param assets 资产地址数组
    /// @param amounts 金额数组
    function batchReleaseGuarantees(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external onlyVaultCore onlyValidRegistry nonReentrant {
        if (user == address(0)) revert ZeroAddress();
        uint256 length = assets.length;
        if (length != amounts.length) revert GuaranteeFundManager__LengthMismatch();
        if (length == 0) revert GuaranteeFundManager__EmptyArrays();
        if (length > MAX_BATCH_SIZE) revert GuaranteeFundManager__BatchTooLarge();
        
        for (uint256 i = 0; i < length; i++) {
            address asset = assets[i];
            uint256 amount = amounts[i];
            
            if (amount == 0) continue;
            if (asset == address(0)) revert ZeroAddress();
            
            uint256 currentGuarantee = _userGuarantees[user][asset];
            if (currentGuarantee < amount) {
                amount = currentGuarantee;
            }
            
            if (amount > 0) {
                _userGuarantees[user][asset] -= amount;
                _totalGuaranteesByAsset[asset] -= amount;
                
                // 安全转账给用户
                IERC20(asset).safeTransfer(user, amount);
                
                emit GuaranteeReleased(user, asset, amount, block.timestamp);

                // View 缓存更新（逐条）
                _pushGuaranteeUpdateToView(user, asset, amount, false);
            }
        }
        
        // 发出标准化批量动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_BATCH_WITHDRAW,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_BATCH_WITHDRAW),
            msg.sender,
            block.timestamp
        );

        // 统一数据推送（批量）
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_BATCH_GUARANTEE_RELEASED,
            abi.encode(user, length, block.timestamp)
        );
    }

    /* ============ Admin Functions ============ */
    // 说明：模块不再承担 VaultCore/Registry 地址更新与系统级暂停职责，这些由 Registry/Governance 统一处理

    // ============ Removed: Registry Upgrade Functions & Views moved to Registry/Governance ============

    /* ============ Upgrade Auth ============ */
    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal view override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        
        // 验证新实现合约
        if (newImplementation.code.length == 0) revert GuaranteeFundManager__InvalidImplementation();
        
        // 可以在这里添加更多的实现合约验证逻辑
        // 例如验证合约是否实现了必要的接口
        // 或者验证合约的存储布局是否兼容
    }
} 