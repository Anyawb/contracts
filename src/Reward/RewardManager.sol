// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { RewardManagerCore } from "./RewardManagerCore.sol";
import { IRewardManager, IRewardManagerV2 } from "../interfaces/IRewardManager.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { VaultTypes } from "../Vault/VaultTypes.sol";
import { Registry } from "../registry/Registry.sol";
import { ViewConstants } from "../Vault/view/ViewConstants.sol";
import {
    ZeroAddress,
    MissingRole
} from "../errors/StandardErrors.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { ReentrancyGuardSlimUpgradeable } from "../utils/ReentrancyGuardSlimUpgradeable.sol";

/// @dev RewardManagerCore 的 V2 最小接口（用于让 IDE/静态分析器稳定识别 onLoanEventV2）
interface IRewardManagerCoreV2 {
    function onLoanEventV2(address user, uint256 orderId, uint256 amount, uint256 maturity, uint8 outcome) external;
}

/// @title RewardManager - 积分管理统一入口
/// @notice 奖励系统的**写入口与治理入口**（只读查询统一走 RewardView）
/// @dev 遵循 docs/SmartContractStandard.md 注释规范
/// @dev 使用 ActionKeys 进行标准化动作标识
/// @dev 使用 ModuleKeys 进行模块地址管理
/// @dev 使用 VaultTypes 进行标准化事件记录
/// @dev 使用 StandardErrors 进行统一错误处理
/// @dev 通过 Registry 进行模块地址获取
contract RewardManager is Initializable, UUPSUpgradeable, ReentrancyGuardSlimUpgradeable, IRewardManager {
    // ========== Custom Errors (gas efficient) ==========
    /// @notice 参数非法：等级不在 1-5
    error RewardManager__InvalidLevel(uint8 level);
    /// @notice 参数非法：等级倍数超出允许范围
    error RewardManager__InvalidLevelMultiplier(uint256 newMultiplier);
    /// @notice 参数非法：批量输入长度不一致或超过上限
    error RewardManager__InvalidBatch();

    uint256 private constant MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Registry 合约地址（私有存储；不对外提供只读 getter，避免入口分裂）
    address private _registryAddr;

    /// @notice 惩罚执行事件（用于审计与监控：明确 executor + user + points）
    event PenaltyApplied(address indexed executor, address indexed user, uint256 points, uint256 timestamp);

    /// @notice 初始化合约
    /// @param initialRegistryAddr Registry 合约地址
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        
        __UUPSUpgradeable_init();
        __ReentrancyGuardSlim_init();
        _registryAddr = initialRegistryAddr;
    }

    // ========== 修饰符 ==========

    /// @dev 验证Registry地址有效性
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    // ========== 权限管理 ==========

    /// @dev 权限校验内部函数
    /// @param actionKey 动作键
    /// @param user 用户地址
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    // ========== 内部模块获取 ==========

    /// @dev 获取核心业务合约
    function _getRewardManagerCore() internal view returns (RewardManagerCore) {
        return RewardManagerCore(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_MANAGER_CORE));
    }

    // ========== 公共接口 ==========

    /// @notice ORDER_ENGINE(core/LendingEngine) 在 borrow 或 repay 后调用此函数
    /// @param user 用户地址
    /// @param amount 金额（以最小单位；USDT/USDC 按 6 位，ETH 按 18 位）
    /// @param duration 借款时长（秒）：borrow 推荐传订单 term（用于锁定/计算奖励）；若上游无法提供期限可传 0（表示未知/不计分/不锁定）；repay 固定传 0
    /// @param hfHighEnough 历史遗留命名：由 LendingEngine 传入；当前实现中用于“按期且足额还清”的判定 flag（主要在 repay 场景有意义）
    function onLoanEvent(address user, uint256 amount, uint256 duration, bool hfHighEnough) external onlyValidRegistry {
        _reentrancyGuardEnter();
        // 按 Architecture-Guide：Reward 的唯一路径为 ORDER_ENGINE 落账后触发
        address orderEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ORDER_ENGINE);
        if (msg.sender != orderEngine) revert MissingRole();
        
        _getRewardManagerCore().onLoanEvent(user, amount, duration, hfHighEnough);
        _reentrancyGuardExit();
    }

    /// @notice ORDER_ENGINE(core/LendingEngine) 在 borrow/repay(足额) 后调用此函数（V2：按订单锁定/释放/扣罚）
    /// @dev 与 IRewardManagerV2 保持一致；旧版 LendingEngine 可继续调用 onLoanEvent
    function onLoanEventV2(
        address user,
        uint256 orderId,
        uint256 amount,
        uint256 maturity,
        IRewardManagerV2.LoanEventOutcome outcome
    ) external onlyValidRegistry {
        _reentrancyGuardEnter();
        address orderEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ORDER_ENGINE);
        if (msg.sender != orderEngine) revert MissingRole();

        IRewardManagerCoreV2(address(_getRewardManagerCore())).onLoanEventV2(user, orderId, amount, maturity, uint8(outcome));
        _reentrancyGuardExit();
    }

    /// @notice 批量处理借贷事件 - 大幅提升性能
    /// @param users 用户地址数组
    /// @param amounts 借款金额数组
    /// @param durations 借款时长数组
    /// @param hfHighEnoughs 提前还款标志数组
    function onBatchLoanEvents(
        address[] calldata users,
        uint256[] calldata amounts,
        uint256[] calldata durations,
        bool[] calldata hfHighEnoughs
    ) external onlyValidRegistry {
        // 通过 Registry 获取 ORDER_ENGINE 地址进行权限验证
        address orderEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ORDER_ENGINE);
        if (msg.sender != orderEngine) revert MissingRole();
        if (users.length == 0 || users.length > MAX_BATCH_SIZE) revert RewardManager__InvalidBatch();
        if (users.length != amounts.length || users.length != durations.length || users.length != hfHighEnoughs.length) revert RewardManager__InvalidBatch();
        
        _getRewardManagerCore().onBatchLoanEvents(users, amounts, durations, hfHighEnoughs);
    }

    /// @notice 惩罚用户积分（清算模块调用）
    /// @param user 用户地址
    /// @param points 扣除积分数量
    function applyPenalty(address user, uint256 points) external onlyValidRegistry {
        // 通过 Registry 获取清算相关模块地址进行权限验证
        address guaranteeFundManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_GUARANTEE_FUND);
        if (msg.sender != guaranteeFundManager) revert MissingRole();
        
        // 调用核心合约的惩罚功能
        _getRewardManagerCore().deductPoints(user, points);
        
        emit PenaltyApplied(msg.sender, user, points, block.timestamp);

        // 使用标准化事件记录惩罚（executor 必须为真实执行者：清算模块）
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_LIQUIDATE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_LIQUIDATE),
            msg.sender,
            block.timestamp
        );
    }

    // ========== 管理接口 ==========

    /// @notice 更新奖励参数
    /// @param baseEth 基础分/ETH
    /// @param perDay 每天积分
    /// @param bonus 提前还款奖励
    /// @param baseUsd 基础分/100 USD
    function updateRewardParameters(
        uint256 baseEth,
        uint256 perDay,
        uint256 bonus,
        uint256 baseUsd
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // 调用核心合约更新参数
        _getRewardManagerCore().updateRewardParameters(baseUsd, perDay, bonus, baseEth);
    }

    /// @notice 更新等级倍数
    /// @param level 等级
    /// @param newMultiplier 倍数 (BPS)
    function setLevelMultiplier(uint8 level, uint256 newMultiplier) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (level == 0 || level > 5) revert RewardManager__InvalidLevel(level);
        if (newMultiplier < 10000 || newMultiplier > 50000) revert RewardManager__InvalidLevelMultiplier(newMultiplier);
        
        // 调用核心合约更新等级倍数
        _getRewardManagerCore().updateLevelMultiplier(level, newMultiplier);
    }

    /// @notice 更新动态奖励参数
    /// @param newThreshold 阈值
    /// @param newMultiplier 倍数 (BPS)
    function setDynamicRewardParams(uint256 newThreshold, uint256 newMultiplier) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // 调用核心合约更新动态奖励参数
        _getRewardManagerCore().updateDynamicRewardParameters(newThreshold, newMultiplier);
    }

    /// @notice 设置缓存过期时间
    /// @param newExpirationTime 过期时间 (秒)
    function setCacheExpirationTime(uint256 newExpirationTime) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // 调用核心合约设置缓存过期时间
        _getRewardManagerCore().updateCacheExpirationTime(newExpirationTime);
    }

    /// @notice 清除用户缓存
    /// @param user 用户地址
    function clearUserCache(address user) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // 调用核心合约清除用户缓存
        _getRewardManagerCore().clearUserCache(user);
    }

    /// @notice 更新用户等级
    /// @param user 用户地址
    /// @param newLevel 新等级 (1-5)
    function updateUserLevel(address user, uint8 newLevel) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // 调用核心合约更新用户等级
        _getRewardManagerCore().updateUserLevel(user, newLevel);
    }

    /// @notice 设置健康因子奖励
    /// @param newBonus 健康因子奖励 (BPS, 500 = 5%)
    function setHealthFactorBonus(uint256 newBonus) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // 调用核心合约设置健康因子奖励
        _getRewardManagerCore().setHealthFactorBonus(newBonus);
    }

    /// @notice 重置动态奖励时间
    function resetDynamicRewardTime() external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // 调用核心合约重置动态奖励时间
        _getRewardManagerCore().resetDynamicRewardTime();
    }

    /// @notice 设置按期窗口（秒）
    function setOnTimeWindow(uint256 newWindow) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        _getRewardManagerCore().setOnTimeWindow(newWindow);
    }

    /// @notice 设置提前/逾期扣罚（BPS）
    function setPenaltyBps(uint256 earlyBps, uint256 lateBps) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        _getRewardManagerCore().setPenaltyBps(earlyBps, lateBps);
    }

    /// @notice 隐私增强：设置 RMCore read-gate 是否开启（开启后 RMCore 的 get* 仅允许 RewardView/白名单读取）
    function setReadGateEnabled(bool enabled) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        _getRewardManagerCore().setReadGateEnabled(enabled);
    }

    /// @notice 隐私增强：设置 RMCore 额外 reader 白名单（可选：运维/风控模块）
    function setRewardManagerCoreExtraReader(address reader, bool allowed) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        _getRewardManagerCore().setExtraReader(reader, allowed);
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