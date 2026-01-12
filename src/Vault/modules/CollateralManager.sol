// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ReentrancyGuardSlimUpgradeable } from "../../utils/ReentrancyGuardSlimUpgradeable.sol";

import { Registry } from "../../registry/Registry.sol";
import { ModuleKeys } from "../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../constants/ActionKeys.sol";
import { ICollateralManager } from "../../interfaces/ICollateralManager.sol";
import { DataPushLibrary } from "../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../constants/DataPushTypes.sol";
import { IAccessControlManager } from "../../interfaces/IAccessControlManager.sol";
import { IPositionView } from "../../interfaces/IPositionView.sol";
import { ViewConstants } from "../view/ViewConstants.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice 最小化 VaultCore 接口（用于解析 View 地址）
interface IVaultCoreMinimal {
    function viewContractAddrVar() external view returns (address);
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external;
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external;
}

/// @title CollateralManager
/// @notice 纯业务逻辑模块 - 抵押物管理
/// @dev 双架构设计：纯业务逻辑，通过数据推送接口更新View层缓存
/// @dev 移除复杂逻辑：权限验证、重复事件发出、缓存管理
/// @dev 专注核心功能：抵押物存取、价值计算、业务验证
/// @custom:security-contact security@example.com
contract CollateralManager is 
    Initializable, 
    UUPSUpgradeable, 
    ReentrancyGuardSlimUpgradeable,
    ICollateralManager 
{
    using SafeERC20 for IERC20;

    uint256 private constant MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;
    /*━━━━━━━━━━━━━━━ 基础配置 ━━━━━━━━━━━━━━━*/
    
    /// @notice Registry 合约地址（私有存储，遵循命名规范）
    address private _registryAddr;

    /// @notice 统一数据推送类型常量已迁移至 DataPushTypes

    /*━━━━━━━━━━━━━━━ 业务数据存储 ━━━━━━━━━━━━━━━*/
    
    /// @notice 用户多资产抵押物余额映射：user → asset → amount
    mapping(address => mapping(address => uint256)) private _userCollateral;
    
    /// @notice 各资产抵押物总量：asset → totalAmount
    mapping(address => uint256) private _totalCollateralByAsset;
    
    /// @notice 用户资产列表：user → asset[]
    mapping(address => address[]) private _userAssets;
    
    /// @notice 用户资产索引：user → asset → index
    mapping(address => mapping(address => uint256)) private _userAssetIndex;
    
    /// @notice 用户资产数量：user → count
    mapping(address => uint256) private _userAssetCount;

    /*━━━━━━━━━━━━━━━ 事件定义 ━━━━━━━━━━━━━━━*/
    
    /// @notice 抵押物存入处理完成事件
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 存入金额
    /// @param timestamp 时间戳
    event DepositProcessed(
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 timestamp
    );
    
    /// @notice 抵押物提取处理完成事件
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 提取金额
    /// @param timestamp 时间戳
    event WithdrawProcessed(
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 timestamp
    );
    
    /// @notice 批量抵押物存入处理完成事件
    /// @param user 用户地址
    /// @param operationCount 操作数量
    /// @param timestamp 时间戳
    event BatchDepositProcessed(
        address indexed user,
        uint256 operationCount,
        uint256 timestamp
    );
    
    /// @notice 批量抵押物提取处理完成事件
    /// @param user 用户地址
    /// @param operationCount 操作数量
    /// @param timestamp 时间戳
    event BatchWithdrawProcessed(
        address indexed user,
        uint256 operationCount,
        uint256 timestamp
    );

    /*━━━━━━━━━━━━━━━ 错误定义 ━━━━━━━━━━━━━━━*/
    
    error CollateralManager__ZeroAddress();
    error CollateralManager__InvalidAmount();
    error CollateralManager__LengthMismatch();
    error CollateralManager__InsufficientCollateral();
    error CollateralManager__UnauthorizedAccess();
    // 保留：如需强制引导到 View 模块时可使用
    error CollateralManager__UseViewModule();

    /*━━━━━━━━━━━━━━━ 权限控制 ━━━━━━━━━━━━━━━*/

    /// @notice 只允许 Registry 中登记的 VaultRouter 调用
    /// @notice 允许 VaultRouter 或 VaultCore 调用（兼容旧测试）
    modifier onlyVaultRouterOrCore() {
        address router = _resolveVaultRouterAddr();
        address core = _resolveVaultCoreAddr();
        if (msg.sender != router && msg.sender != core) revert CollateralManager__UnauthorizedAccess();
        _;
    }

    /// @notice 允许 VaultRouter / LiquidationManager / SettlementManager 调用
    /// @dev SettlementManager 用于“还款结算后自动释放抵押到用户”与“统一入口触发清算分支”
    modifier onlyVaultRouterOrLiquidationManager() {
        address viewAddr = _resolveVaultRouterAddr();
        address liquidationManager = _resolveLiquidationManagerAddr();
        address settlementManager = _resolveSettlementManagerAddr();
        if (msg.sender != viewAddr && msg.sender != liquidationManager && msg.sender != settlementManager) {
            revert CollateralManager__UnauthorizedAccess();
        }
        _;
    }

    /*━━━━━━━━━━━━━━━ 构造和初始化 ━━━━━━━━━━━━━━━*/
    
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize CollateralManager with Registry address.
     * @dev Reverts if:
     *      - initialRegistryAddr is zero
     *
     * Security:
     * - initializer protected (single run)
     * - sets UUPS + ReentrancyGuard baselines
     *
     * @param initialRegistryAddr Registry address (non-zero)
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert CollateralManager__ZeroAddress();

        __UUPSUpgradeable_init();
        __ReentrancyGuardSlim_init();

        _registryAddr = initialRegistryAddr;
    }

    /**
     * @notice Legacy initializer overload (kept for backward compatibility in tests).
     * @dev Reverts if:
     *      - initialRegistryAddr is zero
     *
     * Security:
     * - initializer protected (single run)
     * - sets UUPS + ReentrancyGuard baselines
     *
     * @param initialRegistryAddr Registry address (non-zero)
     */
    function initialize(
        address /*priceOracle*/,
        address /*settlementToken*/,
        address initialRegistryAddr,
        address /*acm*/
    ) external initializer {
        if (initialRegistryAddr == address(0)) revert CollateralManager__ZeroAddress();
        __UUPSUpgradeable_init();
        __ReentrancyGuardSlim_init();
        _registryAddr = initialRegistryAddr;
    }
    
    /*━━━━━━━━━━━━━━━ 核心业务逻辑 ━━━━━━━━━━━━━━━*/

    /// @notice View 层缓存推送失败（不回滚主流程，链下可监听重试）
    event ViewCachePushFailed(address indexed user, address indexed asset, bytes reason);
    
    /**
     * @notice Handle collateral deposit (authority path).
     * @dev Reverts if:
     *      - user is zero
     *      - asset is zero
     *      - amount is zero
     *
     * Security:
     * - Non-reentrant
     * - Pulls tokens from user (requires prior approve to CM)
     *
     * @param user User address (non-zero)
     * @param asset Collateral asset address (non-zero)
     * @param amount Collateral amount (token decimals)
     */
    function processDeposit(address user, address asset, uint256 amount) public onlyVaultRouterOrCore {
        _reentrancyGuardEnter();
        if (user == address(0)) revert CollateralManager__ZeroAddress();
        if (asset == address(0)) revert CollateralManager__ZeroAddress();
        if (amount == 0) revert CollateralManager__InvalidAmount();

        // 0) 真实资金入池：将抵押资产从用户转入本合约（CollateralManager 作为资金池/托管者）
        // NOTE: 需要用户提前 approve 本合约为 spender
        uint256 received = _pullTokenIntoPool(user, asset, amount);
        if (received == 0) revert CollateralManager__InvalidAmount();
        
        // 1. 更新业务数据
        uint256 oldBalance = _userCollateral[user][asset];
        _userCollateral[user][asset] = oldBalance + received;
        _totalCollateralByAsset[asset] = _totalCollateralByAsset[asset] + received;
        
        // 2. 如果是新资产，添加到用户资产列表
        if (oldBalance == 0) {
            _addUserAsset(user, asset);
        }
        
        // 2. 更新 View 层缓存（携带真实债务）
        {
            uint64 nextVersion = _getNextVersion(user, asset);
            try IVaultCoreMinimal(_resolveVaultCoreAddr()).pushUserPositionUpdateDelta(
                user,
                asset,
                _toInt(received),
                int256(0),
                bytes32(0),
                0,
                nextVersion
            ) {
                // ok
            } catch (bytes memory reason) {
                emit ViewCachePushFailed(user, asset, reason);
            }
        }
        
        // 3. 发出业务事件
        emit DepositProcessed(user, asset, received, block.timestamp);
        
        // 4. 数据推送（统一数据推送接口）
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_DEPOSIT_PROCESSED,
            abi.encode(user, asset, received, block.timestamp)
        );
        _reentrancyGuardExit();
    }
    
    /**
     * @notice Handle collateral withdrawal to user (authority path).
     * @dev Reverts if:
     *      - user is zero
     *      - asset is zero
     *      - amount is zero
     *
     * Security:
     * - Non-reentrant
     * - Withdraws only to user (receiver=user)
     *
     * @param user User address (non-zero)
     * @param asset Collateral asset address (non-zero)
     * @param amount Withdraw amount (token decimals)
     */
    function processWithdraw(address user, address asset, uint256 amount) public onlyVaultRouterOrCore {
        _reentrancyGuardEnter();
        // 用户提现：receiver 必须为 user
        _withdrawCollateralTo(user, asset, amount, user);
        _reentrancyGuardExit();
    }

    /**
     * @notice Unified collateral exit (withdraw to user or liquidation to receiver).
     * @dev Reverts if:
     *      - receiver is zero
     *      - (receiver==user) and caller not VaultRouter/SettlementManager
     *
     * Security:
     * - Non-reentrant
     * - Only VaultRouter/LiquidationManager/SettlementManager may call
     * - Receiver==user constrained to VaultRouter/SettlementManager
     *
     * @param user Collateral owner
     * @param asset Collateral asset
     * @param amount Amount to withdraw (token decimals)
     * @param receiver Recipient of real tokens (user or liquidator)
     */
    function withdrawCollateralTo(
        address user,
        address asset,
        uint256 amount,
        address receiver
    ) external onlyVaultRouterOrLiquidationManager {
        _reentrancyGuardEnter();
        if (receiver == address(0)) revert CollateralManager__ZeroAddress();
        // 若是“提到用户”的语义，强制只能由 VaultRouter 或 SettlementManager 发起
        // - VaultRouter：用户主动 withdraw
        // - SettlementManager：用户 repay 后自动释放抵押
        address vaultRouter = _resolveVaultRouterAddr();
        address settlementManager = _resolveSettlementManagerAddr();
        if (receiver == user && msg.sender != vaultRouter && msg.sender != settlementManager) {
            revert CollateralManager__UnauthorizedAccess();
        }
        _withdrawCollateralTo(user, asset, amount, receiver);
        _reentrancyGuardExit();
    }
    
    /**
     * @notice Batch deposit collateral (authority path).
     * @dev Reverts if:
     *      - user is zero
     *      - assets/amounts length mismatch
     *      - batch size is zero or exceeds MAX_BATCH_SIZE
     *
     * Security:
     * - Non-reentrant
     * - Pulls tokens per asset from user (requires approve to CM)
     *
     * @param user User address (non-zero)
     * @param assets Collateral asset list (non-zero, len<=MAX_BATCH_SIZE)
     * @param amounts Amount list (token decimals)
     */
    function batchProcessDeposit(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) public onlyVaultRouterOrCore {
        _reentrancyGuardEnter();
        if (user == address(0)) revert CollateralManager__ZeroAddress();
        if (assets.length != amounts.length) revert CollateralManager__LengthMismatch();
        if (assets.length == 0 || assets.length > MAX_BATCH_SIZE) revert CollateralManager__InvalidAmount();

        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i] == address(0)) revert CollateralManager__ZeroAddress();
            if (amounts[i] == 0) continue;
            
            // 真实资金入池（逐资产）
            uint256 received = _pullTokenIntoPool(user, assets[i], amounts[i]);
            if (received == 0) continue;

            // 处理单个存入
            uint256 oldBalance = _userCollateral[user][assets[i]];
            _userCollateral[user][assets[i]] = oldBalance + received;
            _totalCollateralByAsset[assets[i]] = _totalCollateralByAsset[assets[i]] + received;
            
            if (oldBalance == 0) {
                _addUserAsset(user, assets[i]);
            }
            
            // 更新 View 层缓存（使用增量，减少覆盖风险）
            uint64 nextVersion = _getNextVersion(user, assets[i]);
            try IVaultCoreMinimal(_resolveVaultCoreAddr()).pushUserPositionUpdateDelta(
                user,
                assets[i],
                _toInt(received),
                int256(0),
                bytes32(0),
                0,
                nextVersion
            ) {
                // ok
            } catch (bytes memory reason) {
                emit ViewCachePushFailed(user, assets[i], reason);
            }
        }
        
        // 发出批量处理事件
        emit BatchDepositProcessed(user, assets.length, block.timestamp);
        
        // 数据推送
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_BATCH_DEPOSIT_PROCESSED,
            abi.encode(user, assets.length, block.timestamp)
        );
        _reentrancyGuardExit();
    }
    
    /**
     * @notice Batch withdraw collateral (authority path).
     * @dev Reverts if:
     *      - user is zero
     *      - assets/amounts length mismatch
     *      - batch size is zero or exceeds MAX_BATCH_SIZE
     *
     * Security:
     * - Non-reentrant
     * - Receiver fixed to user in batch
     *
     * @param user User address (non-zero)
     * @param assets Collateral asset list (non-zero, len<=MAX_BATCH_SIZE)
     * @param amounts Amount list (token decimals)
     */
    function batchProcessWithdraw(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) public onlyVaultRouterOrCore {
        _reentrancyGuardEnter();
        if (user == address(0)) revert CollateralManager__ZeroAddress();
        if (assets.length != amounts.length) revert CollateralManager__LengthMismatch();
        if (assets.length == 0 || assets.length > MAX_BATCH_SIZE) revert CollateralManager__InvalidAmount();

        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i] == address(0)) revert CollateralManager__ZeroAddress();
            if (amounts[i] == 0) continue;
            // 批量提现：receiver 必须为 user
            _withdrawCollateralTo(user, assets[i], amounts[i], user);
        }
        
        // 发出批量处理事件
        emit BatchWithdrawProcessed(user, assets.length, block.timestamp);
        
        // 数据推送
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_BATCH_WITHDRAW_PROCESSED,
            abi.encode(user, assets.length, block.timestamp)
                 );
        _reentrancyGuardExit();
     }
     
     /*━━━━━━━━━━━━━━━ 兼容性接口 ━━━━━━━━━━━━━━━*/
     
    /**
     * @notice Compatibility deposit entry (legacy interface).
     * @dev Reverts if:
     *      - user/asset is zero
     *      - amount is zero
     *
     * Security:
     * - Only VaultRouter/VaultCore
     * - Non-reentrant (in callee)
     *
     * @param user User address
     * @param asset Asset address
     * @param amount Amount to deposit
     */
    function depositCollateral(address user, address asset, uint256 amount) external onlyVaultRouterOrCore {
        processDeposit(user, asset, amount);
    }
     
    /**
     * @notice Compatibility withdraw entry (legacy interface).
     * @dev Reverts if:
     *      - user/asset is zero
     *      - amount is zero
     *
     * Security:
     * - Only VaultRouter/VaultCore
     * - Non-reentrant (in callee)
     *
     * @param user User address
     * @param asset Asset address
     * @param amount Amount to withdraw
     */
    function withdrawCollateral(address user, address asset, uint256 amount) external onlyVaultRouterOrCore {
        processWithdraw(user, asset, amount);
    }

    /**
     * @notice Compatibility batch deposit (testing).
     * @dev Reverts if:
     *      - user is zero
     *      - length mismatch or size 0/over MAX_BATCH_SIZE
     *
     * Security:
     * - Only VaultRouter/VaultCore
     * - Non-reentrant (in callee)
     */
    function batchDepositCollateral(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external onlyVaultRouterOrCore {
        batchProcessDeposit(user, assets, amounts);
    }

    /**
     * @notice Compatibility batch withdraw (testing).
     * @dev Reverts if:
     *      - user is zero
     *      - length mismatch or size 0/over MAX_BATCH_SIZE
     *
     * Security:
     * - Only VaultRouter/VaultCore
     * - Non-reentrant (in callee)
     */
    function batchWithdrawCollateral(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external onlyVaultRouterOrCore {
        batchProcessWithdraw(user, assets, amounts);
    }

    /**
     * @notice Compatibility liquidation entry (deprecated).
     * @dev Reverts to enforce unified liquidation via SettlementManager/LiquidationManager using withdrawCollateralTo.
     */
    function seizeCollateralForLiquidation(
        address,
        address,
        uint256,
        address
    ) external pure override {
        revert CollateralManager__UseViewModule();
    }

    /// @dev 内部实现：扣减账本 + best-effort 推送 View + 真实转账到 receiver
    function _withdrawCollateralTo(address user, address asset, uint256 amount, address receiver) internal {
        if (user == address(0)) revert CollateralManager__ZeroAddress();
        if (asset == address(0)) revert CollateralManager__ZeroAddress();
        if (receiver == address(0)) revert CollateralManager__ZeroAddress();
        if (amount == 0) revert CollateralManager__InvalidAmount();

        uint256 currentBalance = _userCollateral[user][asset];
        if (currentBalance < amount) revert CollateralManager__InsufficientCollateral();

        // 1) 更新账本
        _userCollateral[user][asset] = currentBalance - amount;
        _totalCollateralByAsset[asset] = _totalCollateralByAsset[asset] - amount;
        if (_userCollateral[user][asset] == 0) {
            _removeUserAsset(user, asset);
        }

        // 2) best-effort 推送 View（增量，减少覆盖风险）
        {
            uint64 nextVersion = _getNextVersion(user, asset);
            try IVaultCoreMinimal(_resolveVaultCoreAddr()).pushUserPositionUpdateDelta(
                user,
                asset,
                -_toInt(amount),
                int256(0),
                bytes32(0),
                0,
                nextVersion
            ) {
                // ok
            } catch (bytes memory reason) {
                emit ViewCachePushFailed(user, asset, reason);
            }
        }

        // 3) 真实资金出池：资金池直接转给 receiver
        IERC20(asset).safeTransfer(receiver, amount);

        // 4) 事件与 DataPush（对齐“写入直达账本 + 链下聚合”）
        emit WithdrawProcessed(user, asset, amount, block.timestamp);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_WITHDRAW_PROCESSED,
            abi.encode(user, asset, amount, block.timestamp)
        );
    }
     
     /*━━━━━━━━━━━━━━━ 查询接口（兼容性）━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Get user collateral balance.
     * @dev Reverts if:
     *      - none (view)
     *
     * Security:
     * - View only
     *
     * @param user User address
     * @param asset Asset address
     * @return amount Collateral amount
     */
    function getCollateral(address user, address asset) external view returns (uint256 amount) {
        return _userCollateral[user][asset];
    }
    
    /**
     * @notice Get total collateral for an asset.
     * @dev Reverts if:
     *      - none (view)
     *
     * Security:
     * - View only
     *
     * @param _asset Asset address
     * @return totalCollateral Total collateral amount
     */
    function getTotalCollateralByAsset(address _asset) external view returns (uint256 totalCollateral) {
        return _totalCollateralByAsset[_asset];
    }
    
    /**
     * @notice Get all collateral assets for a user.
     * @dev Reverts if:
     *      - none (view)
     *
     * Security:
     * - View only
     *
     * @param user User address
     * @return assets Asset list
     */
    function getUserCollateralAssets(address user) external view returns (address[] memory assets) {
        uint256 count = _userAssetCount[user];
        assets = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            assets[i] = _userAssets[user][i];
        }
    }
    
    /*━━━━━━━━━━━━━━━ 内部辅助函数 ━━━━━━━━━━━━━━━*/
    
    /// @notice 添加用户资产到列表
    /// @param user 用户地址
    /// @param asset 资产地址
    function _addUserAsset(address user, address asset) internal {
        uint256 index = _userAssetIndex[user][asset];
        if (index == 0) {
            _userAssets[user].push(asset);
            _userAssetIndex[user][asset] = _userAssets[user].length;
            _userAssetCount[user]++;
        }
    }
    
    /// @notice 从用户资产列表中移除资产
    /// @param user 用户地址
    /// @param asset 资产地址
    function _removeUserAsset(address user, address asset) internal {
        uint256 index = _userAssetIndex[user][asset];
        if (index > 0) {
            uint256 lastIndex = _userAssets[user].length - 1;
            address lastAsset = _userAssets[user][lastIndex];
            
            _userAssets[user][index - 1] = lastAsset;
            _userAssetIndex[user][lastAsset] = index;
            
            _userAssets[user].pop();
            delete _userAssetIndex[user][asset];
            _userAssetCount[user]--;
        }
    }
    
    /*━━━━━━━━━━━━━━━ 合约升级 ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice UUPS upgrade authorization.
     * @dev Reverts if:
     *      - caller missing ACTION_UPGRADE_MODULE
     *      - newImplementation is zero
     *
     * Security:
     * - Delegates to ACM.requireRole
     *
     * @param newImplementation New implementation address
     */
    function _authorizeUpgrade(address newImplementation) internal view override {
        if (newImplementation == address(0)) revert CollateralManager__ZeroAddress();
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
    }

    uint256[50] private __gap;

    /*━━━━━━━━━━━━━━━ 内部工具 ━━━━━━━━━━━━━━━*/
    
    /// @notice 解析当前有效的 VaultCore 地址
    function _resolveVaultCoreAddr() internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);
    }

    /// @notice 解析当前有效的 VaultRouter 地址（通过 VaultCore 暴露的 viewContractAddrVar）
    function _resolveVaultRouterAddr() internal view returns (address) {
        return IVaultCoreMinimal(_resolveVaultCoreAddr()).viewContractAddrVar();
    }

    /// @notice 解析 PositionView 并返回下一个 nextVersion（失败返回 0，自增模式）
    function _getNextVersion(address user, address asset) internal view returns (uint64) {
        address positionView = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_POSITION_VIEW);
        try IPositionView(positionView).getPositionVersion(user, asset) returns (uint64 version) {
            unchecked {
                return version + 1;
            }
        } catch {
            return 0;
        }
    }

    /// @notice 解析当前有效的 LiquidationManager 地址（通过 Registry）
    function _resolveLiquidationManagerAddr() internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_MANAGER);
    }

    /// @notice 解析当前有效的 SettlementManager 地址（通过 Registry）
    /// @dev 使用 getModule（非 revert），避免在未部署 SettlementManager 时影响 VaultRouter 正常路径
    function _resolveSettlementManagerAddr() internal view returns (address) {
        return Registry(_registryAddr).getModule(ModuleKeys.KEY_SETTLEMENT_MANAGER);
    }

    /// @notice 将 uint256 安全转换为 int256，防止溢出
    function _toInt(uint256 value) internal pure returns (int256) {
        if (value > uint256(type(int256).max)) revert CollateralManager__InvalidAmount();
        return int256(value);
    }

    /// @notice 将 token 从用户拉入资金池，并返回实际到账数量（兼容 fee-on-transfer）
    function _pullTokenIntoPool(address user, address asset, uint256 amount) internal returns (uint256 received) {
        IERC20 token = IERC20(asset);
        uint256 beforeBal = token.balanceOf(address(this));
        token.safeTransferFrom(user, address(this), amount);
        uint256 afterBal = token.balanceOf(address(this));
        unchecked {
            received = afterBal - beforeBal;
        }
    }
} 