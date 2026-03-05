// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { RewardManagerCore } from "./RewardManagerCore.sol";
import { IRewardManager, IRewardManagerByOrder } from "../interfaces/IRewardManager.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { SystemEvents } from "../Vault/SystemEvents.sol";
import { Registry } from "../registry/Registry.sol";
import { RewardModuleBase } from "./internal/RewardModuleBase.sol";
import {
    ZeroAddress,
    NotAContract,
    MissingRole
} from "../errors/StandardErrors.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

/// @dev RewardManagerCore 的“按订单维度”最小接口（用于让 IDE/静态分析器稳定识别入口）
interface IRewardManagerCoreByOrder {
    function onLoanEventByOrder(address user, uint256 orderId, uint256 amount, uint256 maturity, uint8 outcome) external;
}

interface IEasyEmissionControllerByOrder {
    function onLoanEventByOrderWithLender(
        address borrower,
        address lender,
        address asset,
        uint256 orderId,
        uint256 amount,
        uint256 maturity,
        uint8 outcome
    ) external;
}

interface IRewardConfigEarnGovernance {
    function setDynamicRewardParams(uint256 thresholdEasy, uint256 multiplierBps) external;
    function setLevelMultiplier(uint8 level, uint256 multiplierBps) external;
}

/// @title RewardManager - 积分管理统一入口
/// @notice 奖励系统的**写入口与治理入口**（只读查询统一走 RewardView）
/// @dev 遵循 docs/SmartContractStandard.md 注释规范
/// @dev 使用 ActionKeys 进行标准化动作标识
/// @dev 使用 ModuleKeys 进行模块地址管理
/// @dev 使用 SystemEvents 进行标准化事件记录
/// @dev 使用 StandardErrors 进行统一错误处理
/// @dev 通过 Registry 进行模块地址获取
contract RewardManager is Initializable, UUPSUpgradeable, ReentrancyGuardUpgradeable, RewardModuleBase, IRewardManager {
    // ========== Custom Errors (gas efficient) ==========
    /// @notice 参数非法：等级不在 1-5
    error RewardManager__InvalidLevel(uint8 level);
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Registry 合约地址（私有存储；不对外提供只读 getter，避免入口分裂）
    address private _registryAddr;

    /// @notice 惩罚执行事件（用于审计与监控：明确 executor + user + easyAmount）
    event PenaltyApplied(address indexed executor, address indexed user, uint256 easyAmount, uint256 blockNumber);

    /// @notice 初始化合约
    /// @param initialRegistryAddr Registry 合约地址
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        _registryAddr = initialRegistryAddr;
    }

    // ========== 内部模块获取 ==========

    /// @dev 获取核心业务合约
    function _getRewardManagerCore() internal view returns (RewardManagerCore) {
        return RewardManagerCore(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_MANAGER_CORE));
    }

    // ========== RewardModuleBase ==========

    function _getRegistryAddr() internal view override returns (address) {
        return _registryAddr;
    }

    // ========== 公共接口 ==========

    /// @notice ORDER_ENGINE(core/LendingEngine) 在 borrow 或 repay 后调用此函数
    /// @param user 用户地址
    /// @param amount 金额（以最小单位；USDT/USDC 按 6 位，ETH 按 18 位）
    /// @param duration 借款时长（区块数）：borrow 推荐传订单 term（用于锁定/计算奖励）；若上游无法提供期限可传 0（表示未知/不计分/不锁定）；repay 固定传 0
    /// @param hfHighEnough 历史遗留命名；当前语义为 `isOnTimeAndFullyRepaid`（按期且足额还清，由 LendingEngine 计算并传入；主要在 repay 场景有意义）。
    ///        注意：**不要**将其按旧名误解为“健康因子足够（HealthFactor）”。
    function onLoanEvent(address user, uint256 amount, uint256 duration, bool hfHighEnough)
        external
        onlyValidRegistry
        nonReentrant
    {
        // 按 Architecture-Guide：Reward 的唯一路径为 ORDER_ENGINE 落账后触发
        address orderEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ORDER_ENGINE);
        if (msg.sender != orderEngine) revert MissingRole();
        
        _getRewardManagerCore().onLoanEvent(user, amount, duration, hfHighEnough);
    }

    /// @notice ORDER_ENGINE(core/LendingEngine) 在 borrow/repay(足额) 后调用此函数（按订单维度：锁定/释放/扣罚）
    /// @dev 与 IRewardManagerByOrder 保持一致；旧版 LendingEngine 可继续调用 legacy 的 onLoanEvent
    function onLoanEventByOrder(
        address user,
        uint256 orderId,
        uint256 amount,
        uint256 maturity,
        IRewardManagerByOrder.LoanEventOutcome outcome
    ) external onlyValidRegistry nonReentrant {
        address orderEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ORDER_ENGINE);
        if (msg.sender != orderEngine) revert MissingRole();

        IRewardManagerCoreByOrder(address(_getRewardManagerCore())).onLoanEventByOrder(
            user, orderId, amount, maturity, uint8(outcome)
        );
    }

    /// @notice ORDER_ENGINE 在 borrow/repay(足额) 后调用（按订单维度，含 lender/asset）
    /// @dev 该入口会同步触发 RMCore（积分锁定/释放）与 EasyEmissionController（Easy 发行）
    function onLoanEventByOrderWithLender(
        address borrower,
        address lender,
        address asset,
        uint256 orderId,
        uint256 amount,
        uint256 maturity,
        IRewardManagerByOrder.LoanEventOutcome outcome
    ) external onlyValidRegistry nonReentrant {
        address orderEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ORDER_ENGINE);
        if (msg.sender != orderEngine) revert MissingRole();

        IRewardManagerCoreByOrder(address(_getRewardManagerCore())).onLoanEventByOrder(
            borrower, orderId, amount, maturity, uint8(outcome)
        );

        address controller = Registry(_registryAddr).getModule(ModuleKeys.KEY_EASY_EMISSION_CONTROLLER);
        if (controller != address(0) && controller.code.length != 0) {
            IEasyEmissionControllerByOrder(controller).onLoanEventByOrderWithLender(
                borrower,
                lender,
                asset,
                orderId,
                amount,
                maturity,
                uint8(outcome)
            );
        }
    }

    /// @notice 惩罚用户 EasyToken（清算模块调用）
    /// @param user 用户地址
    /// @param easyAmount 扣除 Easy 数量（reward units, 18 decimals）
    function applyPenalty(address user, uint256 easyAmount) external onlyValidRegistry {
        // 通过 Registry 获取清算相关模块地址进行权限验证
        address guaranteeFundManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_GUARANTEE_FUND);
        if (msg.sender != guaranteeFundManager) revert MissingRole();
        
        // 调用核心合约的惩罚功能
        _getRewardManagerCore().deductEasy(user, easyAmount);
        
        emit PenaltyApplied(msg.sender, user, easyAmount, block.number);

        // 使用标准化事件记录惩罚（executor 必须为真实执行者：清算模块）
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_LIQUIDATE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_LIQUIDATE),
            msg.sender,
            block.number
        );
    }

    // ========== 管理接口 ==========

    /// @notice Update earn-side dynamic reward parameters (governance).
    /// @dev SSOT: RewardConfig -> EarnConfig. Observability cache is pushed best-effort via RewardManagerCore -> RewardView.
    function setDynamicRewardParams(uint256 thresholdEasy, uint256 multiplierBps) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        address rewardConfig = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_CONFIG);
        IRewardConfigEarnGovernance(rewardConfig).setDynamicRewardParams(thresholdEasy, multiplierBps);
        _getRewardManagerCore().pushDynamicRewardParamsToView(thresholdEasy, multiplierBps);
    }

    /// @notice Update earn-side level multiplier (BPS, 10000=1x).
    /// @dev SSOT: RewardConfig -> EarnConfig. Observability cache is pushed best-effort via RewardManagerCore -> RewardView.
    function setLevelMultiplier(uint8 level, uint256 multiplierBps) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        address rewardConfig = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_CONFIG);
        IRewardConfigEarnGovernance(rewardConfig).setLevelMultiplier(level, multiplierBps);
        _getRewardManagerCore().pushLevelMultiplierToView(level, multiplierBps);
    }

    /// @notice 更新用户等级
    /// @param user 用户地址
    /// @param newLevel 新等级 (1-5)
    function updateUserLevel(address user, uint8 newLevel) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (newLevel == 0 || newLevel > 5) revert RewardManager__InvalidLevel(newLevel);
        
        // 调用核心合约更新用户等级
        _getRewardManagerCore().updateUserLevel(user, newLevel);
    }

    /// @notice 设置按期窗口（区块数）
    function setOnTimeWindow(uint256 newWindow) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        _getRewardManagerCore().setOnTimeWindow(newWindow);
    }

    /// @notice 设置提前/逾期扣罚（BPS）
    function setPenaltyBps(uint256 earlyBps, uint256 lateBps) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        _getRewardManagerCore().setPenaltyBps(earlyBps, lateBps);
    }

    // ========== 查询接口（与架构一致：仅保留入口职责；只读查询迁移至 RewardView） ==========

    /// @notice 升级授权函数
    /// @dev 通过 ACM(ActionKeys.ACTION_UPGRADE_MODULE) 校验升级权限
    /// @dev 若后续接入 Timelock/Multisig，应在 ACM 层或此处增加“仅 Timelock/Multisig 执行”的约束
    function _authorizeUpgrade(address newImplementation) internal view override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    // ============ UUPS storage gap ============
    uint256[50] private __gap;
} 