// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";

import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ICollateralManager } from "../../../interfaces/ICollateralManager.sol";
import { ILendingEngineBasic } from "../../../interfaces/ILendingEngineBasic.sol";
import { ILiquidationManager } from "../../../interfaces/ILiquidationManager.sol";
import { ILiquidationRiskManager } from "../../../interfaces/ILiquidationRiskManager.sol";
import { ILoanNFT } from "../../../interfaces/ILoanNFT.sol";
import { ISettlementManager } from "../../../interfaces/ISettlementManager.sol";
import { ZeroAddress, AmountIsZero } from "../../../errors/StandardErrors.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice 订单引擎最小只读适配：用于按 orderId 获取 borrower/debtAsset/maturity 等信息
/// @dev 注意：当前 LendingEngine 将查询函数暴露为 *_ForView 并受 ACL 约束；部署时需为 SettlementManager 授权相应只读权限
interface IOrderEngineViewAdapter {
    struct LoanOrder {
        uint256 principal;
        uint256 rate;       // bps
        uint256 term;       // 秒
        address borrower;
        address lender;
        address asset;      // ERC20 地址
        uint256 startTimestamp;
        uint256 maturity;
        uint256 repaidAmount;
    }

    function _getLoanOrderForView(uint256 orderId) external view returns (LoanOrder memory order);
}

/// @notice 订单引擎最小还款接口：按 orderId 进行还款（包含费用/利息/同步账本等）
interface IOrderEngineRepayAdapter {
    function repay(uint256 orderId, uint256 repayAmount) external;
}

/// @title SettlementManager
/// @notice 统一结算/清算写入口（SSOT）：唯一对外写入口，统一承接按时还款、提前还款、到期未还、被动清算
/// @dev 安全审计要点：
///     - 权限控制：repayAndSettle 仅允许 VaultCore 调用（onlyVaultCore），settleOrLiquidate 需要 ACTION_LIQUIDATE 权限
///     - 重入保护：所有外部函数均使用 nonReentrant 修饰符，遵循 CEI 模式（Checks-Effects-Interactions）
///     - 输入验证：所有地址参数检查零地址，金额参数检查非零，orderId 与 user/debtAsset 交叉验证
///     - 状态一致性：还款后检查总债务价值，确保抵押返还逻辑正确；清算前验证触发条件和抵押资产存在性
///     - 边界条件：orderId 可为 0（LoanNFT minting 从 0 开始）；处理用户无抵押、无债务、抵押价值为 0 等边界情况
///     - 紧急暂停：支持 whenNotPaused，供治理在紧急情况下暂停所有操作
///     - 升级安全：UUPS 升级模式，升级权限通过 ACTION_UPGRADE_MODULE 控制，升级前验证新实现地址非零
/// @dev 业务逻辑要点：
///     - 状态机分支：根据到期时间、健康因子、风控判定自动决定结算（还款）或清算（被动清算）
///     - 资金流向：还款时抵押返还给 B（borrower）；清算时抵押扣押/划转，残值通过 LiquidationPayoutManager 分配
///     - 仓位主键：统一使用 orderId 作为仓位主键，全链路复用，避免数据不一致
///     - 直达账本：清算写入直达 CollateralManager.withdrawCollateralTo 和 LendingEngine.forceReduceDebt，不经过 View 层
/// @dev 潜在风险与缓解措施：
///     - 风险：Registry 模块地址解析失败导致 revert
///     - 缓解：使用 getModuleOrRevert，失败时立即 revert，避免状态不一致
///     - 风险：外部合约调用失败（ORDER_ENGINE.repay、LiquidationManager.liquidate）
///     - 缓解：外部调用失败会 revert，确保状态原子性；LoanNFT 验证采用 best-effort，不阻断主流程
///     - 风险：循环中 gas 耗尽（用户抵押资产数量过多）
///     - 缓解：抵押返还循环有明确上限（用户资产列表长度），实际场景中资产种类有限
///     - 风险：价格预言机异常导致清算价值计算错误
///     - 缓解：清算价值计算由 CollateralManager.getAssetValue 提供，其内部应包含预言机异常处理
/// @dev Gas 优化：
///     - 使用 unchecked 块优化循环计数器（i++）
///     - 缓存外部调用结果（如 assets.length、ord.borrower）
///     - 清算时选择价值最大的单一抵押资产，避免多资产循环清算带来的 gas 开销
contract SettlementManager is Initializable, UUPSUpgradeable, ReentrancyGuardUpgradeable, PausableUpgradeable, ISettlementManager {
    using SafeERC20 for IERC20;
    /// @notice Registry address for module resolution and access control.
    /// @dev Stored privately; exposed via explicit getter `registryAddrVar()` (no public state variable).
    address private _registryAddr;

    /// @notice Get Registry address.
    function registryAddrVar() external view returns (address) {
        return _registryAddr;
    }

    error SettlementManager__OnlyVaultCore();
    error SettlementManager__InvalidOrderId();
    error SettlementManager__NotLiquidatable();
    error SettlementManager__NoCollateral();
    error SettlementManager__OrderMismatch();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    modifier onlyVaultCore() {
        address vaultCore = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);
        if (msg.sender != vaultCore) revert SettlementManager__OnlyVaultCore();
        _;
    }

    /*━━━━━━━━━━━━━━━ External: User entry ━━━━━━━━━━━━━━━*/

    /// @notice 用户还款并结算（统一结算入口）
    /// @dev 安全审计要点：
    ///     - 权限：仅允许 VaultCore 调用（onlyVaultCore），防止未授权还款操作
    ///     - 重入保护：使用 nonReentrant 修饰符，防止重入攻击
    ///     - 输入验证：user、debtAsset 非零地址，repayAmount 非零，orderId 与 user/debtAsset 交叉验证
    ///     - 状态一致性：还款前验证订单归属（ord.borrower == user && ord.asset == debtAsset），防止订单篡改
    ///     - 资金安全：VaultCore 已将资金转入本合约，使用 forceApprove 授权给 ORDER_ENGINE，避免资金丢失
    ///     - 边界条件：orderId 可为 0；用户无债务时自动返还所有抵押资产，避免资金锁定
    /// @dev 业务逻辑：
    ///     1. 交叉验证：验证 orderId 属于 user，且 debtAsset 与订单一致
    ///     2. 订单级还款：调用 ORDER_ENGINE.repay 完成减债（包含费用/利息/同步账本）
    ///     3. 抵押返还：若用户总债务价值为 0，自动返还其全部抵押资产给 B（borrower）
    /// @dev 潜在风险：
    ///     - 风险：ORDER_ENGINE.repay 失败导致状态不一致
    ///     - 缓解：外部调用失败会 revert，确保状态原子性
    ///     - 风险：循环中 gas 耗尽（用户抵押资产种类过多）
    ///     - 缓解：实际场景中用户抵押资产种类有限，且循环有明确上限
    /// @param user 借款人地址（必须非零）
    /// @param debtAsset 债务资产地址（必须非零）
    /// @param repayAmount 还款金额（必须大于 0）
    /// @param orderId 订单 ID（仓位主键，可为 0）
    function repayAndSettle(address user, address debtAsset, uint256 repayAmount, uint256 orderId)
        external
        override
        whenNotPaused
        nonReentrant
        onlyVaultCore
    {
        if (user == address(0) || debtAsset == address(0)) revert ZeroAddress();
        if (repayAmount == 0) revert AmountIsZero();
        // NOTE: orderId can be 0 (current ORDER_ENGINE / LoanNFT minting starts from 0).
        // Existence is validated below via ORDER_ENGINE._getLoanOrderForView(orderId).

        address le = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        address orderEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ORDER_ENGINE);

        // 0) 交叉验证：orderId 必须属于该 user，且 debtAsset 必须与订单一致
        IOrderEngineViewAdapter.LoanOrder memory ord = IOrderEngineViewAdapter(orderEngine)._getLoanOrderForView(orderId);
        if (ord.borrower == address(0) || ord.asset == address(0)) revert ZeroAddress();
        if (ord.borrower != user || ord.asset != debtAsset) revert SettlementManager__OrderMismatch();

        // 1) 订单级还款（资金流：VaultCore 已将资金转入本合约；本合约再授权给 ORDER_ENGINE 拉取）
        // 架构要求（Architecture-Guide.md §640-646）：还款统一进入 SettlementManager，由 LendingEngine 更新债务账本
        IERC20(debtAsset).forceApprove(orderEngine, repayAmount);
        IOrderEngineRepayAdapter(orderEngine).repay(orderId, repayAmount);

        // 2) 若用户已无任何债务，则自动返还其全部抵押资产给 B（borrower）
        // 架构要求（Architecture-Guide.md §640-646）：按时还款/提前还款时，抵押直接返还给 B（borrower），无需用户二次 withdraw
        // 注意：这里采用“总债务价值==0”的口径，避免依赖 debtAssets 列表的维护细节
        if (ILendingEngineBasic(le).getUserTotalDebtValue(user) == 0) {
            address[] memory assets = ICollateralManager(cm).getUserCollateralAssets(user);
            for (uint256 i; i < assets.length; ) {
                uint256 bal = ICollateralManager(cm).getCollateral(user, assets[i]);
                if (bal > 0) {
                    // 统一出池入口：receiver==user 表示返还给用户（Architecture-Guide.md §640-646）
                    ICollateralManager(cm).withdrawCollateralTo(user, assets[i], bal, user);
                }
                unchecked { ++i; }
            }
        }
    }

    /*━━━━━━━━━━━━━━━ External: Keeper entry ━━━━━━━━━━━━━━━*/

    /// @notice Keeper/机器人触发的结算或清算（统一清算入口）
    /// @dev 遵循架构指南（Architecture-Guide.md §647-652, §696-713）：作为唯一对外写入口，统一承接到期未还、被动清算
    /// @dev 流程：
    ///     1. 触发条件判定：到期未还 或 风控判定可清算（LiquidationRiskManager.isLiquidatable）
    ///     2. 清算参数计算：选择价值最大的抵押资产，计算所需抵押数量
    ///     3. 清算执行：调用 LiquidationManager.liquidate 完成扣押/减债（直达账本）
    ///     4. 事件推送：由 LiquidationManager 通过 LiquidatorView 触发 DataPush（best-effort）
    /// @dev 权限：需要 ACTION_LIQUIDATE 权限（keeper/机器人）
    /// @param orderId 订单 ID（仓位主键，SSOT）
    function settleOrLiquidate(uint256 orderId) external override whenNotPaused nonReentrant {
        // NOTE: orderId can be 0 (current ORDER_ENGINE / LoanNFT minting starts from 0).
        // Existence is validated below via ORDER_ENGINE._getLoanOrderForView(orderId).
        _requireRole(ActionKeys.ACTION_LIQUIDATE, msg.sender);

        address le = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        address risk = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        address orderEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ORDER_ENGINE);
        address loanNft = Registry(_registryAddr).getModule(ModuleKeys.KEY_LOAN_NFT);

        IOrderEngineViewAdapter.LoanOrder memory ord = IOrderEngineViewAdapter(orderEngine)._getLoanOrderForView(orderId);
        if (ord.borrower == address(0) || ord.asset == address(0)) revert ZeroAddress();

        address targetUser = ord.borrower;
        address debtAsset = ord.asset;

        // Best-effort: 通过 LoanNFT 交叉验证订单存在性/状态（不作为强依赖，避免 NFT 铸造降级导致主流程失败）
        if (loanNft != address(0) && loanNft.code.length > 0) {
            _bestEffortCheckLoanNft(orderId, targetUser, loanNft);
        }

        // 触发条件：到期未还 或 风控判定可清算
        // 架构要求（Architecture-Guide.md §647-652）：清算不再作为独立对外入口，由 SettlementManager 在满足触发条件时进入清算分支
        bool overdue = (block.timestamp > ord.maturity) && (ILendingEngineBasic(le).getDebt(targetUser, debtAsset) > 0);
        bool riskLiquidatable = ILiquidationRiskManager(risk).isLiquidatable(targetUser);
        if (!overdue && !riskLiquidatable) revert SettlementManager__NotLiquidatable();

        uint256 totalDebt = ILendingEngineBasic(le).getDebt(targetUser, debtAsset);
        uint256 debtAmount = ILendingEngineBasic(le).getReducibleDebtAmount(targetUser, debtAsset);
        if (debtAmount == 0) revert AmountIsZero();
        if (totalDebt == 0) revert SettlementManager__NotLiquidatable();

        // 将 debtValue 按 reducible/total 比例缩放到本次清算目标价值（以结算币计价）
        uint256 debtValueTotal = ILendingEngineBasic(le).calculateDebtValue(targetUser, debtAsset);
        uint256 targetDebtValue = (debtValueTotal * debtAmount) / totalDebt;

        // 选择“价值最大”的抵押资产进行单笔清算（全自动、确定性、gas 可控）
        address[] memory assets = ICollateralManager(cm).getUserCollateralAssets(targetUser);
        uint256 len = assets.length;
        address bestAsset;
        uint256 bestBal;
        uint256 bestValue;
        for (uint256 i; i < len; ) {
            address a = assets[i];
            uint256 bal = ICollateralManager(cm).getCollateral(targetUser, a);
            if (bal > 0) {
                uint256 v = ICollateralManager(cm).getAssetValue(a, bal);
                if (v > bestValue) {
                    bestValue = v;
                    bestAsset = a;
                    bestBal = bal;
                }
            }
            unchecked { ++i; }
        }
        if (bestAsset == address(0) || bestBal == 0) revert SettlementManager__NoCollateral();

        // 线性估算：所需抵押数量 = bestBal * targetDebtValue / bestValue （向上取整，且不超过 bestBal）
        uint256 collateralAmount;
        if (bestValue == 0 || targetDebtValue == 0) {
            collateralAmount = bestBal;
        } else {
            collateralAmount = (bestBal * targetDebtValue + bestValue - 1) / bestValue;
            if (collateralAmount == 0) collateralAmount = 1;
            if (collateralAmount > bestBal) collateralAmount = bestBal;
        }

        // bonus 仅用于事件/统计口径；最小实现置 0
        uint256 bonus = 0;

        // 清算执行：调用 LiquidationManager 作为清算执行器
        // 架构要求（Architecture-Guide.md §696-713）：清算写入直达账本（CollateralManager.withdrawCollateralTo + LendingEngine.forceReduceDebt）
        // LiquidationManager 内部完成扣押/减债，并通过 LiquidatorView 触发 DataPush（best-effort，不回滚账本写入）
        address liquidationManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_MANAGER);
        ILiquidationManager(liquidationManager).liquidate(
            targetUser,
            bestAsset,
            debtAsset,
            collateralAmount,
            debtAmount,
            bonus
        );
    }

    /// @notice 尽力而为：从 LoanNFT(user→tokenIds) 中查找 loanId==orderId 的凭证；若找不到则不阻断主流程
    /// @dev Best-effort 验证：不作为强依赖，避免 NFT 铸造降级导致主流程失败
    /// @param orderId 订单 ID
    /// @param borrower 借款人地址
    /// @param loanNft LoanNFT 合约地址
    function _bestEffortCheckLoanNft(uint256 orderId, address borrower, address loanNft) internal view {
        // 为避免 DoS（用户持有大量 NFT），只检查前 N 个 token
        uint256 maxScan = 32;
        try ILoanNFT(loanNft).getUserTokens(borrower) returns (uint256[] memory tokenIds) {
            uint256 len = tokenIds.length;
            uint256 cap = len > maxScan ? maxScan : len;
            for (uint256 i; i < cap; ) {
                uint256 tokenId = tokenIds[i];
                try ILoanNFT(loanNft).getLoanMetadata(tokenId) returns (ILoanNFT.LoanMetadata memory meta) {
                    if (meta.loanId == orderId) {
                        // 若已标记为 Repaid，则不应进入清算入口（best-effort）
                        if (meta.status == ILoanNFT.LoanStatus.Repaid) revert SettlementManager__NotLiquidatable();
                        return;
                    }
                } catch {
                    // ignore single token failure
                }
                unchecked { ++i; }
            }
        } catch {
            // ignore loanNFT failures
        }
    }

    /*━━━━━━━━━━━━━━━ Internal ━━━━━━━━━━━━━━━*/

    /// @notice 权限校验：要求调用者具有指定 actionKey 权限
    /// @dev 通过 AccessControlManager 进行权限校验
    /// @param actionKey 操作键
    /// @param caller 调用者地址
    function _requireRole(bytes32 actionKey, address caller) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, caller);
    }

    /// @notice UUPS 升级授权：校验升级权限
    /// @dev 架构要求（Architecture-Guide.md §58）：升级权限通过 ACTION_UPGRADE_MODULE 控制
    /// @param newImplementation 新实现合约地址
    function _authorizeUpgrade(address newImplementation) internal view override {
        // 沿用全局升级权限：ACTION_UPGRADE_MODULE
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }
}

