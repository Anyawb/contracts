// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;



import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IAssetWhitelist } from "../../interfaces/IAssetWhitelist.sol";
import { ICollateralManager } from "../../interfaces/ICollateralManager.sol";
import { ILendingEngineBasic } from "../../interfaces/ILendingEngineBasic.sol";
import { ILiquidationRiskManager } from "../../interfaces/ILiquidationRiskManager.sol";
import { VaultTypes } from "../VaultTypes.sol";
import { ExternalModuleRevertedRaw, AmountIsZero, AssetNotAllowed, ZeroAddress } from "../../errors/StandardErrors.sol";
import { ModuleKeys } from "../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../interfaces/IAccessControlManager.sol";
import { VaultBusinessLogicLibrary } from "../../libraries/VaultBusinessLogicLibrary.sol";
import { SettlementReserveLib } from "../../libraries/SettlementReserveLib.sol";
import { SettlementIntentLib } from "../../libraries/SettlementIntentLib.sol";
import { SettlementMatchLib } from "../../libraries/SettlementMatchLib.sol";
import { Registry } from "../../registry/Registry.sol";
import { IVaultRouter } from "../../interfaces/IVaultRouter.sol";
import { ILenderPoolVault } from "../../interfaces/ILenderPoolVault.sol";

/// @title VaultBusinessLogic
/// @notice 业务逻辑模块（纯业务 + 基础 Registry 能力）；数据推送与事件聚合由 VaultRouter 统一负责
/// @dev 使用 VaultBusinessLogicLibrary 提取重复逻辑，提升可读性与复用性
/// @dev 支持 UUPS 升级模式；集成 ReentrancyGuardUpgradeable、PausableUpgradeable
/// @dev 与 ActionKeys/ModuleKeys 集成；权限由 AccessControlManager 校验
/// @dev 通过 Registry 模块化管理按需解析模块地址
/// @dev 集成 GracefulDegradation 库，提供价格预言机异常时的优雅降级路径
/// @dev View 地址解析策略：优先 KEY_VAULT_CORE.viewContractAddrVar()，迁移期回退 KEY_STATS
/// @dev 不包含 Registry 升级/状态查询等辅助接口（该职责归属 VaultCore/Registry），保持职责单一
/// @custom:security-contact security@example.com

/// @notice 最小化 VaultCore 接口（用于解析 View 地址）
interface IVaultCoreMinimal {
    function viewContractAddrVar() external view returns (address);
}

contract VaultBusinessLogic is 
    Initializable, 
    UUPSUpgradeable, 
    ReentrancyGuardUpgradeable,
    PausableUpgradeable 
{
    using SafeERC20 for IERC20;
    using SettlementReserveLib for mapping(bytes32 => SettlementReserveLib.LendReserve);

    /* ============ Storage ============ */
    /// @notice Registry合约地址，用于获取各模块地址
    address private _registryAddr;
    
    /// @notice 结算币地址，用于优雅降级配置
    address private _settlementTokenAddr;

    /// @notice 出借资金保留账本：intentHash → 资金保留记录
    mapping(bytes32 => SettlementReserveLib.LendReserve) private _lendReserves;

    /// @notice 意向撮合状态：intentHash → 是否已匹配
    mapping(bytes32 => bool) private _matchedIntents;

    /// @notice Storage gap for upgrade safety
    uint256[48] private __gap;

    /* ============ Modifiers ============ */
    /// @notice 验证Registry地址有效性
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    /// @notice 仅限清算角色
    modifier onlyLiquidator() {
        _requireRole(ActionKeys.ACTION_LIQUIDATE, msg.sender);
        _;
    }

    /* ============ Events ============ */
    /// @notice Registry地址更新事件
    /// @param oldRegistry 旧Registry地址
    /// @param newRegistry 新Registry地址
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);

    /// @notice 撮合完成事件（供前端订阅）
    event OrderMatched(
        uint256 indexed orderId,
        address indexed borrower,
        address indexed lender,
        address asset,
        uint256 amount,
        uint16 termDays,
        uint256 rateBps
    );

    // 业务层不再发健康相关事件，统一由 LE + View 层处理

    /* ============ Constructor ============ */
    /// @dev 禁用实现合约的初始化器，防止直接调用
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /* ============ Internal Functions ============ */
    
    /// @notice 获取模块地址（直接从 Registry 获取，保持职责单一）
    /// @param moduleKey 模块键
    /// @return 模块地址
    function _getModuleAddress(bytes32 moduleKey) internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(moduleKey);
    }

    /// @notice 解析 Router 地址：仅通过 KEY_VAULT_CORE → viewContractAddrVar（去除 KEY_STATS 回退）
    function _resolveVaultRouterAddr() internal view returns (address) {
        address vaultCore = _getModuleAddress(ModuleKeys.KEY_VAULT_CORE);
        if (vaultCore == address(0)) return address(0);
        try IVaultCoreMinimal(vaultCore).viewContractAddrVar() returns (address v) {
            return v;
        } catch { return address(0); }
    }
    
    // 删除模块地址缓存相关逻辑（迁移至 View 层或由 Registry 统一管理）
    
    /// @notice 权限校验内部函数
    /// @param actionKey 动作键
    /// @param user 用户地址
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = _getModuleAddress(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    // 业务层不再进行价格预言机健康检查与风控推送，统一由 LE 估值路径与 View 层处理

    /// @notice 检查资产是否在白名单中
    /// @param asset 资产地址
    /// @dev 如果资产不在白名单中，会revert
    function _checkAssetWhitelist(address asset) internal view {
        address assetWhitelist = _getModuleAddress(ModuleKeys.KEY_ASSET_WHITELIST);
        if (assetWhitelist != address(0)) {
            if (!IAssetWhitelist(assetWhitelist).isAssetAllowed(asset)) revert AssetNotAllowed();
        }
    }

    /* ============ Initializer ============ */
    /// @notice 初始化业务逻辑模块
    /// @param initialRegistryAddr Registry合约地址
    /// @param initialSettlementTokenAddr 结算币地址
    function initialize(address initialRegistryAddr, address initialSettlementTokenAddr) external initializer {
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialSettlementTokenAddr == address(0)) revert ZeroAddress();
        
        _registryAddr = initialRegistryAddr;
        _settlementTokenAddr = initialSettlementTokenAddr;
        
        // 发出标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /* ============ Core Business Logic Functions ============ */
    
    /// @notice 用户存入资产
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 存入金额
    function deposit(address user, address asset, uint256 amount) external pure {
        // 收敛：deposit 统一入口为 VaultCore.deposit → VaultRouter → CollateralManager（CM 托管 ERC20）
        // 为避免业务层“托管抵押 token”的旧假设回流，此入口永久下线。
        user; asset; amount; // silence
        revert VaultBusinessLogic__UseVaultCoreEntry();
    }

    /* ============ Liquidation Orchestration (Single Path) ============ */
    /// @notice DEPRECATED: 清算入口已收敛到 LiquidationManager（方案A 唯一入口）
    /// @dev 为避免“双入口/双语义/资金托管假设冲突”，此函数永久下线。
    error VaultBusinessLogic__UseLiquidationManagerEntry();
    /// @notice DEPRECATED: 存取抵押入口已收敛到 VaultCore（用户入口）+ VaultRouter（路由）+ CollateralManager（托管）
    error VaultBusinessLogic__UseVaultCoreEntry();

    function liquidate(
        address /*targetUser*/,
        address /*collateralAsset*/,
        address /*debtAsset*/,
        uint256 /*collateralAmount*/,
        uint256 /*debtAmount*/,
        uint256 /*bonus*/
    ) external pure {
        revert VaultBusinessLogic__UseLiquidationManagerEntry();
    }

    /* ============ Settlement: Reserve & Match ============ */
    /// @notice 出借资金保留（进入资金池并标记可用于撮合）
    /// @param lenderSigner 出借意向签名者（资金提供者）
    /// @param asset 资产
    /// @param amount 金额
    /// @param lendIntentHash 出借意向哈希（链下签名对应的哈希）
    function reserveForLending(
        address lenderSigner,
        address asset,
        uint256 amount,
        bytes32 lendIntentHash
    ) external onlyValidRegistry whenNotPaused nonReentrant {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();
        _checkAssetWhitelist(asset);
        // 资金入池：将资金转入 LenderPoolVault 托管（线上流动性推荐放置处）
        address pool = _getModuleAddress(ModuleKeys.KEY_LENDER_POOL_VAULT);
        IERC20(asset).safeTransferFrom(lenderSigner, pool, amount);
        // 标记保留
        _lendReserves.reserve(lenderSigner, asset, amount, lendIntentHash);
        VaultBusinessLogicLibrary.emitBusinessEvents("reserveForLending", lenderSigner, asset, amount, ActionKeys.ACTION_SET_PARAMETER);
    }

    /// @notice 取消资金保留（未撮合前可撤回）
    function cancelReserve(bytes32 lendIntentHash) external onlyValidRegistry whenNotPaused nonReentrant {
        (address asset, uint256 amount) = _lendReserves.cancel(lendIntentHash, msg.sender);
        if (amount > 0) {
            address pool = _getModuleAddress(ModuleKeys.KEY_LENDER_POOL_VAULT);
            ILenderPoolVault(pool).transferOut(asset, msg.sender, amount);
        }
        VaultBusinessLogicLibrary.emitBusinessEvents("cancelReserve", msg.sender, asset, amount, ActionKeys.ACTION_SET_PARAMETER);
    }

    /// @notice 成交落地（先到先得）：校验意向并原子完成拨付/记账/订单创建/费用分发（净额发放）
    function finalizeMatch(
        SettlementIntentLib.BorrowIntent calldata borrowIntent,
        SettlementIntentLib.LendIntent[] calldata lendIntents,
        bytes calldata sigBorrower,
        bytes[] calldata sigLenders
    ) external onlyValidRegistry whenNotPaused nonReentrant {
        // EIP-712 域值
        bytes32 domain = SettlementIntentLib.buildDomainSeparator(
            "RwaLending",
            "1",
            block.chainid,
            address(this)
        );
        // 校验借款意向状态（过期/已匹配）
        bytes32 bHash = SettlementIntentLib.hashBorrowIntent(borrowIntent);
        SettlementIntentLib.validateOpen(_matchedIntents, bHash, borrowIntent.expireAt);
        // 校验 borrower 签名（EOA or ERC-1271）
        bytes32 bDigest = SettlementIntentLib.toTypedDataHash(domain, bHash);
        if (!SettlementIntentLib.verifySignature(borrowIntent.borrower, bDigest, sigBorrower)) {
            revert SettlementIntentLib.Settlement__InvalidSignature();
        }

        uint256 total;
        for (uint256 i = 0; i < lendIntents.length; i++) {
            bytes32 lHash = SettlementIntentLib.hashLendIntent(lendIntents[i]);
            SettlementIntentLib.validateOpen(_matchedIntents, lHash, lendIntents[i].expireAt);
            // 校验 lender 签名
            bytes32 lDigest = SettlementIntentLib.toTypedDataHash(domain, lHash);
            if (!SettlementIntentLib.verifySignature(lendIntents[i].lenderSigner, lDigest, sigLenders[i])) {
                revert SettlementIntentLib.Settlement__InvalidSignature();
            }
            // 消耗对应的保留额度并累加
            (address lenderSigner, address asset, uint256 amount) = _lendReserves.consume(lHash, lendIntents[i].lenderSigner);
            lenderSigner; // silence
            require(asset == borrowIntent.borrowAsset, "asset mismatch");
            total += amount;
        }

        require(total >= borrowIntent.amount, "insufficient reserved sum");

        // 抵押充足性校验（不从钱包扣抵押，只校验）
        address cm = _getModuleAddress(ModuleKeys.KEY_CM);
        uint256 currentCollateral = 0;
        if (borrowIntent.collateralAsset != address(0) && borrowIntent.collateralAmount > 0) {
            currentCollateral = ICollateralManager(cm).getCollateral(borrowIntent.borrower, borrowIntent.collateralAsset);
            require(currentCollateral >= borrowIntent.collateralAmount, "insufficient collateral");
        }

        // 原子落地：账本 → 订单 → 手续费 → 净额发放（库内部不发业务事件）
        // 注意：CollateralManager 仅允许 VaultRouter 调用；撮合编排合约不应直接调用 depositCollateral。
        // 因此这里不在撮合落地时“补充抵押”，抵押应由借款人提前通过 VaultCore/VaultRouter 路径完成。
        // lender 字段口径：写入“资金池合约地址”（LenderPoolVault），而非 lender EOA
        address pool = _getModuleAddress(ModuleKeys.KEY_LENDER_POOL_VAULT);
        SettlementMatchLib.finalizeAtomicFull(
            _registryAddr,
            borrowIntent.borrower,
            pool,
            address(0),
            0,
            borrowIntent.borrowAsset,
            borrowIntent.amount,
            borrowIntent.termDays,
            borrowIntent.rateBps
        );

        // 标记匹配成功（借/贷意向都置位）
        _matchedIntents[bHash] = true;
        for (uint256 i = 0; i < lendIntents.length; i++) {
            bytes32 lHash = SettlementIntentLib.hashLendIntent(lendIntents[i]);
            SettlementIntentLib.markMatched(_matchedIntents, lHash);
        }
        // 事件与数据推送统一由 LendingEngine + LoanNFT 完成；业务层不再发撮合事件
    }

    /// @notice 用户借款
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 借款金额
    function borrow(address user, address asset, uint256 amount) external onlyValidRegistry whenNotPaused nonReentrant {
        if (amount == 0) revert AmountIsZero();
        if (asset == address(0)) revert ZeroAddress();
        
        // 检查资产是否在白名单中
        _checkAssetWhitelist(asset);
        
        // Gas优化：获取模块地址（使用缓存）
        _getModuleAddress(ModuleKeys.KEY_RM);
        // 统计视图（可选）
        address statsView = Registry(_registryAddr).getModule(ModuleKeys.KEY_STATS);
        
        // 不再在业务层直接调用 LE 计算利息与记账；如需锁保，请使用 borrowWithRate 提供利率

        // 转移代币给用户
        IERC20(asset).safeTransfer(user, amount);
        
        // 积分奖励统一以 LendingEngine 落账后触发
        
        // 推送统计视图
        if (statsView != address(0)) {
            VaultBusinessLogicLibrary.safeUpdateStats(statsView, user, 0, 0, amount, 0);
        }

        VaultBusinessLogicLibrary.emitBusinessEvents("borrow", user, asset, amount, ActionKeys.ACTION_BORROW);
    }

    /* ============ Liquidation Orchestration removed: use LiquidationManager ============ */

    /// @notice 用户借款（上游提供年化利率bps与期限天数，避免二次读取，进一步省gas）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 借款金额
    /// @param annualRateBps 年化利率（bps，1e4=100%）
    /// @param termDays 期限天数
    function borrowWithRate(
        address user,
        address /*lender*/,
        address asset,
        uint256 amount,
        uint256 annualRateBps,
        uint16 termDays
    ) external onlyValidRegistry whenNotPaused nonReentrant returns (uint256 orderId) {
        // 迁移：改由撮合结算 finalizeMatch 调度，避免业务层直接放款与锁保
        // 保留函数签名以兼容旧脚本；直接转调更安全的结算路径
        // lender 字段口径：写入“资金池合约地址”（LenderPoolVault），而非外部传入地址
        address pool = _getModuleAddress(ModuleKeys.KEY_LENDER_POOL_VAULT);
        orderId = SettlementMatchLib.finalizeAtomic(
            _registryAddr,
            user,
            pool,
            address(0),
            0,
            asset,
            amount,
            termDays,
            annualRateBps
        );
        VaultBusinessLogicLibrary.emitBusinessEvents("borrowWithRate", user, asset, amount, ActionKeys.ACTION_BORROW);
    }

    /// @notice 用户还款
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 还款金额
    function repay(address user, address asset, uint256 amount) external onlyValidRegistry whenNotPaused nonReentrant {
        if (amount == 0) revert AmountIsZero();
        if (asset == address(0)) revert ZeroAddress();
        
        // Gas优化：获取模块地址（使用缓存）
        _getModuleAddress(ModuleKeys.KEY_RM);
        // 统计视图（可选）
        address statsView = Registry(_registryAddr).getModule(ModuleKeys.KEY_STATS);
        
        // 转移代币到合约
        IERC20(asset).safeTransferFrom(user, address(this), amount);
        
        // 积分奖励统一以 LendingEngine 落账后触发
        
        // 推送统计视图
        if (statsView != address(0)) {
            VaultBusinessLogicLibrary.safeUpdateStats(statsView, user, 0, 0, 0, amount);
        }

        // 早偿结算触发应由上游/LE 路径统一协调；业务层不再依据账本状态自行判断

        VaultBusinessLogicLibrary.emitBusinessEvents("repay", user, asset, amount, ActionKeys.ACTION_REPAY);
    }

    /// @notice 显式关单还款：在还款完成后触发早偿结算（或自动条件也成立时）
    function repayWithStop(address user, address asset, uint256 amount, bool stop) external onlyValidRegistry whenNotPaused nonReentrant {
        if (amount == 0) revert AmountIsZero();
        if (asset == address(0)) revert ZeroAddress();

        // 模块地址
        address earlyRepayGM = _getModuleAddress(ModuleKeys.KEY_EARLY_REPAYMENT_GUARANTEE);

        // 执行还款
        IERC20(asset).safeTransferFrom(user, address(this), amount);
        // 账本更新由 VaultCore → LE 统一触发；业务层不再直连

        // 若 stop=true 或 债务为0，则触发早偿结算
        bool shouldClose = stop;
        if (!shouldClose) {
            // 不再在业务层读取账本进行判断
        }
        if (shouldClose) {
            (bool ok2, bytes memory data2) = earlyRepayGM.call(
                abi.encodeWithSignature(
                    "settleEarlyRepayment(address,address,uint256)",
                    user,
                    asset,
                    amount // 预留参数，不参与分配
                )
            );
            if (!ok2) revert ExternalModuleRevertedRaw("EarlyRepaymentGuaranteeManager", data2);
        }

        VaultBusinessLogicLibrary.emitBusinessEvents("repayWithStop", user, asset, amount, ActionKeys.ACTION_REPAY);
    }

    /// @notice 用户提取抵押物
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 提取金额
    function withdraw(address user, address asset, uint256 amount) external pure {
        // 收敛：withdraw 统一入口为 VaultCore.withdraw → VaultRouter → CollateralManager（CM 托管 ERC20）
        user; asset; amount; // silence
        revert VaultBusinessLogic__UseVaultCoreEntry();
    }

    /* ============ Batch Operations ============ */
    
    /// @notice 批量存入
    /// @param user 用户地址
    /// @param assets 资产地址数组
    /// @param amounts 金额数组
    function batchDeposit(address user, address[] calldata assets, uint256[] calldata amounts) external pure {
        // 收敛：批量存取抵押应由 BatchView/前端拆分为多次 VaultCore.deposit 调用（或后续新增 VaultCore.batchDeposit）
        user; assets; amounts; // silence
        revert VaultBusinessLogic__UseVaultCoreEntry();
    }

    /// @notice 批量借款
    /// @param user 用户地址
    /// @param assets 资产地址数组
    /// @param amounts 金额数组
    function batchBorrow(address user, address[] calldata assets, uint256[] calldata amounts) external onlyValidRegistry whenNotPaused nonReentrant {
        VaultBusinessLogicLibrary.validateBatchParams(assets, amounts);
        address pool = _getModuleAddress(ModuleKeys.KEY_LENDER_POOL_VAULT);

        unchecked {
            for (uint256 i = 0; i < assets.length; i++) {
                address asset = assets[i];
                uint256 amount = amounts[i];
                if (amount == 0) continue;
                if (asset == address(0)) revert ZeroAddress();
                // 使用原子撮合路径；此处仅演示直接落地（无抵押/无利率），真实场景建议走 finalizeMatch
                SettlementMatchLib.finalizeAtomic(
                    _registryAddr,
                    user,
                    pool,
                    address(0),
                    0,
                    asset,
                    amount,
                    0,
                    0
                );
            }
        }

        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_BATCH_BORROW,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_BATCH_BORROW),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 批量还款
    /// @param user 用户地址
    /// @param assets 资产地址数组
    /// @param amounts 金额数组
    function batchRepay(address user, address[] calldata assets, uint256[] calldata amounts) external onlyValidRegistry whenNotPaused nonReentrant {
        VaultBusinessLogicLibrary.validateBatchParams(assets, amounts);
        
        _getModuleAddress(ModuleKeys.KEY_RM);
        
        unchecked {
            for (uint256 i = 0; i < assets.length; i++) {
                address asset = assets[i];
                uint256 amount = amounts[i];
                if (amount == 0) continue;
                if (asset == address(0)) revert ZeroAddress();
                
                IERC20(asset).safeTransferFrom(user, address(this), amount);
                // 积分奖励统一以 LendingEngine 落账后触发
            }
        }
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_BATCH_REPAY,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_BATCH_REPAY),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 批量提取
    /// @param user 用户地址
    /// @param assets 资产地址数组
    /// @param amounts 金额数组
    function batchWithdraw(address user, address[] calldata assets, uint256[] calldata amounts) external pure {
        // 收敛：批量存取抵押应由 BatchView/前端拆分为多次 VaultCore.withdraw 调用（或后续新增 VaultCore.batchWithdraw）
        user; assets; amounts; // silence
        revert VaultBusinessLogic__UseVaultCoreEntry();
    }

    /* ============ Upgrade Auth ============ */
    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.timestamp
        );
    }
} 