// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IRegistry } from "../interfaces/IRegistry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { RewardTypes } from "./RewardTypes.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { SystemEvents } from "../Vault/SystemEvents.sol";
import { ZeroAddress, NotAContract } from "../errors/StandardErrors.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { RewardModuleBase } from "./internal/RewardModuleBase.sol";

interface IEarnConfigGovernance {
    function setDynamicRewardParams(uint256 thresholdEasy, uint256 multiplierBps) external;
    function setLevelMultiplier(uint8 level, uint256 multiplierBps) external;
}

interface IFeatureRegistryGovernance {
    function setFeature(bytes32 featureKey, uint8 minLevel, bool enabled, string calldata nameOrUri) external;
    function batchSetFeatures(
        bytes32[] calldata keys,
        uint8[] calldata minLevels,
        bool[] calldata enableds,
        string[] calldata uris
    ) external;
}

interface IGovernanceGateGovernance {
    function setGovernanceGateParams(
        bool enabled,
        uint8 minLevelToVote,
        uint8 minLevelToPropose,
        uint256 minVotesToVote,
        uint256 minVotesToPropose
    ) external;
}

/// @title RewardConfig - Reward 子系统配置管理
/// @notice Reward 子系统的治理写入口聚合：Earn 参数、FeatureRegistry、GovernanceGate 等
/// @dev 遵循 docs/SmartContractStandard.md 注释规范
/// @dev 与 Registry 系统完全集成，使用标准化的模块管理
contract RewardConfig is 
    Initializable, 
    UUPSUpgradeable,
    RewardTypes,
    RewardModuleBase
{
    // ============ Errors ============
    
    /// @notice Registry 合约地址（私有存储）
    address private _registryAddr;

    /* ============ Modifiers ============ */
    // onlyValidRegistry 由基类提供
    
    /// @dev Module key literal for EarnConfig.
    /// IMPORTANT: Must match `ModuleKeys.KEY_REWARD_EARN_CONFIG` (keccak256("REWARD_EARN_CONFIG")).
    /// We keep a local literal here to avoid editor/LSP symbol drift while preserving the canonical key value.
    bytes32 private constant _KEY_REWARD_EARN_CONFIG = keccak256("REWARD_EARN_CONFIG");

    event EarnConfigUpdated(bytes32 indexed kind, uint256 v0, uint256 v1, uint256 blockNumber);
    
    /// @notice Registry 地址更新事件
    /// @dev 记录 Registry 地址的变更
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice 初始化合约
    /// @param initialRegistryAddr Registry 合约地址
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
        
        // 记录初始化动作
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    // ========== 内部函数 ==========
    
    /// @notice 获取Registry地址
    /// @return Registry合约地址
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    // 权限验证由基类 _requireRole 提供

    // ========== Earn config governance (SSOT: RewardConfig -> EarnConfig module) ==========

    /// @notice Update dynamic reward parameters (earn path governance).
    /// @dev Writes go through EarnConfig (Registry[KEY_REWARD_EARN_CONFIG]).
    function setDynamicRewardParams(uint256 thresholdEasy, uint256 multiplierBps) external onlyValidRegistry {
        _requireEarnGovernanceCaller(msg.sender);
        address earnCfg = IRegistry(_registryAddr).getModuleOrRevert(_KEY_REWARD_EARN_CONFIG);
        IEarnConfigGovernance(earnCfg).setDynamicRewardParams(thresholdEasy, multiplierBps);
        emit EarnConfigUpdated(keccak256("DYNAMIC_REWARD_PARAMS"), thresholdEasy, multiplierBps, block.number);
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /// @notice Update a level multiplier (BPS, 10000=1x).
    /// @dev Writes go through EarnConfig (Registry[KEY_REWARD_EARN_CONFIG]).
    function setLevelMultiplier(uint8 level, uint256 multiplierBps) external onlyValidRegistry {
        _requireEarnGovernanceCaller(msg.sender);
        address earnCfg = IRegistry(_registryAddr).getModuleOrRevert(_KEY_REWARD_EARN_CONFIG);
        IEarnConfigGovernance(earnCfg).setLevelMultiplier(level, multiplierBps);
        emit EarnConfigUpdated(keccak256("LEVEL_MULTIPLIER"), uint256(level), multiplierBps, block.number);
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /// @dev Governance caller for earn-side parameters.
    ///      Primary path: RewardManager (gateway) calls into RewardConfig after role check.
    ///      Optional fallback: allow direct governance callers with ACTION_SET_PARAMETER.
    function _requireEarnGovernanceCaller(address caller) internal view {
        address rm = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (caller == rm) return;
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, caller);
    }

    // ============ Feature registry (SSOT: RewardConfig -> FeatureRegistry) ============

    function setFeature(bytes32 featureKey, ServiceLevel minLevel, bool enabled, string calldata nameOrUri)
        external
        onlyValidRegistry
    {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        address fr = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_FEATURE_REGISTRY);
        IFeatureRegistryGovernance(fr).setFeature(featureKey, uint8(minLevel), enabled, nameOrUri);
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    function batchSetFeatures(
        bytes32[] calldata keys,
        ServiceLevel[] calldata minLevels,
        bool[] calldata enableds,
        string[] calldata uris
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        address fr = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_FEATURE_REGISTRY);
        uint8[] memory levels = new uint8[](minLevels.length);
        for (uint256 i = 0; i < minLevels.length; i++) {
            levels[i] = uint8(minLevels[i]);
        }
        IFeatureRegistryGovernance(fr).batchSetFeatures(keys, levels, enableds, uris);
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    // ============ Governance gate params (SSOT: RewardConfig -> GovernanceGate) ============

    function setGovernanceGateParams(
        bool enabled_,
        ServiceLevel minLevelToVote_,
        ServiceLevel minLevelToPropose_,
        uint256 minVotesToVote_,
        uint256 minVotesToPropose_
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        address gg = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_GOVERNANCE_GATE);
        IGovernanceGateGovernance(gg).setGovernanceGateParams(
            enabled_,
            uint8(minLevelToVote_),
            uint8(minLevelToPropose_),
            minVotesToVote_,
            minVotesToPropose_
        );
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    // ============ 基类抽象实现 ============
    function _getRegistryAddr() internal view override returns (address) {
        return _registryAddr;
    }

    // ============ UUPS Upgrade & Registry Management (keep at bottom) ============

    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        
        // 记录升级动作
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.number
        );
    }

    /// @notice 更新 Registry 地址
    /// @param newRegistryAddr 新的 Registry 地址
    /// @dev 需要 ACTION_SET_PARAMETER 权限
    function updateRegistry(address newRegistryAddr) public onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        if (newRegistryAddr.code.length == 0) revert NotAContract(newRegistryAddr);
        
        address oldRegistry = _registryAddr;
        _registryAddr = newRegistryAddr;
        
        emit RegistryUpdated(oldRegistry, newRegistryAddr);

        // Keep a standardized module-address update marker for off-chain consumers.
        emit SystemEvents.ModuleAddressUpdated(
            ModuleKeys.getModuleKeyString(ModuleKeys.KEY_REGISTRY),
            oldRegistry,
            newRegistryAddr,
            block.number
        );
        
        // 记录标准化动作事件
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    // ============ UUPS storage gap (must be last) ============
    uint256[50] private __gap;


} 