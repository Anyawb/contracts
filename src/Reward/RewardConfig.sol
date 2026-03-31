// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IRegistry} from "../interfaces/IRegistry.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {RewardTypes} from "./RewardTypes.sol";
import {ActionKeys} from "../constants/ActionKeys.sol";
import {SystemEvents} from "../Vault/SystemEvents.sol";
import {ZeroAddress, NotAContract} from "../errors/StandardErrors.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {RewardModuleBase} from "./internal/RewardModuleBase.sol";

/// @title IEarnConfigGovernance
/// @notice Minimal governance write interface for EarnConfig.
/// @dev Used by {RewardConfig} to call the earn-configuration SSOT without importing the full implementation.
interface IEarnConfigGovernance {
    /// @notice Updates dynamic reward parameters in EarnConfig.
    /// @dev Reverts if the downstream EarnConfig implementation rejects the governance write.
    function setDynamicRewardParams(
        uint256 thresholdEasy,
        uint256 multiplierBps
    ) external;

    /// @notice Updates one level multiplier in EarnConfig.
    /// @dev Reverts if the downstream EarnConfig implementation rejects the governance write.
    function setLevelMultiplier(uint8 level, uint256 multiplierBps) external;
}

/// @title IFeatureRegistryGovernance
/// @notice Minimal governance write interface for FeatureRegistry.
/// @dev Used by {RewardConfig} to write feature access metadata through the Registry-resolved SSOT module.
interface IFeatureRegistryGovernance {
    /// @notice Sets one feature definition.
    /// @dev Reverts if the downstream FeatureRegistry implementation rejects the governance write.
    function setFeature(
        bytes32 featureKey,
        uint8 minLevel,
        bool enabled,
        string calldata nameOrUri
    ) external;

    /// @notice Sets multiple feature definitions in one governance call.
    /// @dev Reverts if the downstream FeatureRegistry implementation rejects the batch write.
    function batchSetFeatures(
        bytes32[] calldata keys,
        uint8[] calldata minLevels,
        bool[] calldata enableds,
        string[] calldata uris
    ) external;
}

/// @title IGovernanceGateGovernance
/// @notice Minimal governance write interface for GovernanceGate.
/// @dev Used by {RewardConfig} to update governance eligibility thresholds without importing the full implementation.
interface IGovernanceGateGovernance {
    /// @notice Updates governance gate thresholds and vote requirements.
    /// @dev Reverts if the downstream GovernanceGate implementation rejects the governance write.
    function setGovernanceGateParams(
        bool enabled,
        uint8 minLevelToVote,
        uint8 minLevelToPropose,
        uint256 minVotesToVote,
        uint256 minVotesToPropose
    ) external;
}

/// @title RewardConfig
/// @notice Aggregated governance write entry for Reward subsystem configuration.
/// @dev Routes Reward governance writes to downstream SSOT modules such as
///      EarnConfig, FeatureRegistry, and GovernanceGate.
contract RewardConfig is
    Initializable,
    UUPSUpgradeable,
    RewardTypes,
    RewardModuleBase
{
    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    /// @notice Registry contract address stored as the module root.
    address private _registryAddr;

    /// @dev Module key literal for EarnConfig.
    /// IMPORTANT: Must match `ModuleKeys.KEY_REWARD_EARN_CONFIG`
    /// (keccak256("REWARD_EARN_CONFIG")).
    /// We keep a local literal here to avoid editor/LSP symbol drift while preserving the canonical key value.
    bytes32 private constant _KEY_REWARD_EARN_CONFIG =
        keccak256("REWARD_EARN_CONFIG");

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/

    /// @notice Emitted when Reward earn parameters are updated through this gateway.
    /// @dev kind differentiates the parameter family; values are emitted in raw storage units for off-chain auditing.
    event EarnConfigUpdated(
        bytes32 indexed kind,
        uint256 v0,
        uint256 v1,
        uint256 blockNumber
    );

    /// @notice Emitted when the Registry address used by this module is updated.
    /// @dev Records the module-root change for governance auditing.
    event RegistryUpdated(
        address indexed oldRegistry,
        address indexed newRegistry
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the module.
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (see {ZeroAddress})
     *      - initialRegistryAddr is not a contract (see {NotAContract})
     *
     * Security:
     * - One-time initializer.
     * - Emits the standard ACTION_SET_PARAMETER marker for initialization observability.
     *
     * @param initialRegistryAddr Registry contract address.
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);

        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;

        // Emit the standardized initialization action marker.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /*━━━━━━━━━━━━━━━ Views ━━━━━━━━━━━━━━━*/

    /**
     * @notice Returns the Registry address used by this module.
     * @dev View-only helper; does not perform Registry validation.
     *
     * Security:
     * - Read-only helper for governance tooling.
     *
     * @return Registry contract address.
     */
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ EarnConfig Governance ━━━━━━━━━━━━━━━*/

    /**
     * @notice Updates dynamic reward parameters for the earn path.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - caller is neither RewardManager nor ACTION_SET_PARAMETER holder
     *      - Registry missing KEY_REWARD_EARN_CONFIG
     *      - downstream {IEarnConfigGovernance.setDynamicRewardParams} reverts
     *
     * Security:
     * - RewardManager is the primary gateway after its own governance check.
     * - Direct governance callers remain available via ACTION_SET_PARAMETER.
     *
     * @param thresholdEasy Easy threshold for enabling the dynamic reward boost.
     * @param multiplierBps Dynamic multiplier in BPS.
     */
    function setDynamicRewardParams(
        uint256 thresholdEasy,
        uint256 multiplierBps
    ) external onlyValidRegistry {
        _requireEarnGovernanceCaller(msg.sender);
        address earnCfg = IRegistry(_registryAddr).getModuleOrRevert(
            _KEY_REWARD_EARN_CONFIG
        );
        IEarnConfigGovernance(earnCfg).setDynamicRewardParams(
            thresholdEasy,
            multiplierBps
        );
        emit EarnConfigUpdated(
            keccak256("DYNAMIC_REWARD_PARAMS"),
            thresholdEasy,
            multiplierBps,
            block.number
        );
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /**
     * @notice Updates one earn-side level multiplier.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - caller is neither RewardManager nor ACTION_SET_PARAMETER holder
     *      - Registry missing KEY_REWARD_EARN_CONFIG
     *      - downstream {IEarnConfigGovernance.setLevelMultiplier} reverts
     *
     * Security:
     * - RewardManager is the primary gateway after its own governance check.
     * - Direct governance callers remain available via ACTION_SET_PARAMETER.
     *
     * @param level User level whose multiplier is updated.
     * @param multiplierBps Multiplier in BPS, where 10000 = 1x.
     */
    function setLevelMultiplier(
        uint8 level,
        uint256 multiplierBps
    ) external onlyValidRegistry {
        _requireEarnGovernanceCaller(msg.sender);
        address earnCfg = IRegistry(_registryAddr).getModuleOrRevert(
            _KEY_REWARD_EARN_CONFIG
        );
        IEarnConfigGovernance(earnCfg).setLevelMultiplier(level, multiplierBps);
        emit EarnConfigUpdated(
            keccak256("LEVEL_MULTIPLIER"),
            uint256(level),
            multiplierBps,
            block.number
        );
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /// @dev Allows RewardManager as the primary gateway.
    ///      ACTION_SET_PARAMETER holders remain a direct governance fallback.
    function _requireEarnGovernanceCaller(address caller) internal view {
        address rm = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_RM
        );
        if (caller == rm) return;
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, caller);
    }

    /*━━━━━━━━━━━━━━━ FeatureRegistry Governance ━━━━━━━━━━━━━━━*/

    /**
     * @notice Sets one feature definition in FeatureRegistry.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - caller lacks ACTION_SET_PARAMETER
     *      - Registry missing KEY_FEATURE_REGISTRY
     *      - downstream {IFeatureRegistryGovernance.setFeature} reverts
     *
     * Security:
     * - Governance-only write.
     * - Delegates validation of featureKey and level bounds to FeatureRegistry.
     *
     * @param featureKey Feature identifier.
     * @param minLevel Minimum ServiceLevel required for the feature.
     * @param enabled Whether the feature is enabled.
     * @param nameOrUri Human-readable name or metadata URI.
     */
    function setFeature(
        bytes32 featureKey,
        ServiceLevel minLevel,
        bool enabled,
        string calldata nameOrUri
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        address fr = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_FEATURE_REGISTRY
        );
        IFeatureRegistryGovernance(fr).setFeature(
            featureKey,
            uint8(minLevel),
            enabled,
            nameOrUri
        );
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /**
     * @notice Sets multiple feature definitions in FeatureRegistry.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - caller lacks ACTION_SET_PARAMETER
     *      - Registry missing KEY_FEATURE_REGISTRY
     *      - downstream {IFeatureRegistryGovernance.batchSetFeatures} reverts
     *
     * Security:
     * - Governance-only batched write.
     * - Converts local ServiceLevel enums into raw uint8 ordinals before delegation.
     *
     * @param keys Feature identifiers.
     * @param minLevels Minimum ServiceLevel required for each feature.
     * @param enableds Enabled flags for each feature.
     * @param uris Human-readable names or metadata URIs for each feature.
     */
    function batchSetFeatures(
        bytes32[] calldata keys,
        ServiceLevel[] calldata minLevels,
        bool[] calldata enableds,
        string[] calldata uris
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        address fr = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_FEATURE_REGISTRY
        );
        uint8[] memory levels = new uint8[](minLevels.length);
        for (uint256 i = 0; i < minLevels.length; i++) {
            levels[i] = uint8(minLevels[i]);
        }
        IFeatureRegistryGovernance(fr).batchSetFeatures(
            keys,
            levels,
            enableds,
            uris
        );
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /*━━━━━━━━━━━━━━━ GovernanceGate Governance ━━━━━━━━━━━━━━━*/

    /**
     * @notice Updates governance gate thresholds.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - caller lacks ACTION_SET_PARAMETER
     *      - Registry missing KEY_GOVERNANCE_GATE
     *      - downstream {IGovernanceGateGovernance.setGovernanceGateParams} reverts
     *
     * Security:
     * - Governance-only write.
     * - Converts local ServiceLevel enums into raw uint8 ordinals before delegation.
     *
     * @param enabled_ Whether the governance gate is enabled.
     * @param minLevelToVote_ Minimum ServiceLevel required to vote.
     * @param minLevelToPropose_ Minimum ServiceLevel required to create proposals.
     * @param minVotesToVote_ Minimum voting power required to vote.
     * @param minVotesToPropose_ Minimum voting power required to create proposals.
     */
    function setGovernanceGateParams(
        bool enabled_,
        ServiceLevel minLevelToVote_,
        ServiceLevel minLevelToPropose_,
        uint256 minVotesToVote_,
        uint256 minVotesToPropose_
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        address gg = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_GOVERNANCE_GATE
        );
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

    /*━━━━━━━━━━━━━━━ RewardModuleBase ━━━━━━━━━━━━━━━*/

    function _getRegistryAddr() internal view override returns (address) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ UUPS And Registry Management ━━━━━━━━━━━━━━━*/

    /// @dev Reverts if caller lacks ACTION_UPGRADE_MODULE or newImplementation is zero (see {ZeroAddress}).
    function _authorizeUpgrade(address newImplementation) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();

        // Emit the standardized upgrade action marker.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.number
        );
    }

    /**
     * @notice Updates the Registry address used by this module.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - caller lacks ACTION_SET_PARAMETER
     *      - newRegistryAddr is zero (see {ZeroAddress})
     *      - newRegistryAddr is not a contract (see {NotAContract})
     *
     * Security:
     * - Governance-only root update.
     * - Changes all future module and ACL lookups performed by RewardConfig.
     *
     * @param newRegistryAddr New Registry contract address.
     */
    function updateRegistry(address newRegistryAddr) public onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);

        if (newRegistryAddr == address(0)) revert ZeroAddress();
        if (newRegistryAddr.code.length == 0)
            revert NotAContract(newRegistryAddr);

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

        // Emit the standardized registry-update action marker.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /*━━━━━━━━━━━━━━━ Storage Gap ━━━━━━━━━━━━━━━*/
    uint256[50] private __gap;
}
