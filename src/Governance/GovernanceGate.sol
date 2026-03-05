// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

import {IRegistry} from "../interfaces/IRegistry.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {ActionKeys} from "../constants/ActionKeys.sol";
import {RewardTypes} from "../Reward/RewardTypes.sol";
import {RewardModuleBase} from "../Reward/internal/RewardModuleBase.sol";
import {ZeroAddress, NotAContract} from "../errors/StandardErrors.sol";

/**
 * @title GovernanceGate
 * @notice SSOT module for governance eligibility checks (min level + EasyToken votes threshold).
 *
 * Writers:
 * - User level: RewardConfig only; optional break-glass: ACTION_REWARD_CONFIG_EMERGENCY.
 * - Params: RewardConfig only; optional break-glass: ACTION_REWARD_CONFIG_EMERGENCY.
 *
 * Snapshot semantics (口径 A):
 * - Votes power is checked via IVotes.getPastVotes(user, snapshotBlock).
 */
contract GovernanceGate is Initializable, UUPSUpgradeable, RewardTypes, RewardModuleBase {
    // ============ reason codes ============
    bytes32 public constant REASON_OK = keccak256("REASON_OK");
    bytes32 public constant REASON_GATE_DISABLED = keccak256("REASON_GATE_DISABLED");
    bytes32 public constant REASON_LEVEL_INSUFFICIENT = keccak256("REASON_LEVEL_INSUFFICIENT");
    bytes32 public constant REASON_VOTES_TOKEN_ZERO = keccak256("REASON_VOTES_TOKEN_ZERO");
    bytes32 public constant REASON_VOTES_INSUFFICIENT = keccak256("REASON_VOTES_INSUFFICIENT");

    // ============ Errors ============
    error GovernanceGate__InvalidServiceLevel(uint8 level);

    // ============ Storage ============
    address private _registryAddr;

    bool public enabled;
    uint8 public minLevelToVote;
    uint8 public minLevelToPropose;
    uint256 public minVotesToVote;
    uint256 public minVotesToPropose;

    mapping(address => uint8) private _userLevel;

    // ============ Events ============
    event GovernanceGateParamsUpdated(
        bool enabled,
        uint8 minLevelToVote,
        uint8 minLevelToPropose,
        uint256 minVotesToVote,
        uint256 minVotesToPropose,
        address indexed updatedBy,
        uint256 blockNumber
    );

    event UserGovernanceAccessUpdated(
        address indexed user,
        uint8 level,
        address indexed updatedBy,
        uint256 blockNumber
    );

    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;

        // Defaults (policy: VIP only)
        enabled = true;
        minLevelToVote = uint8(ServiceLevel.VIP);
        minLevelToPropose = uint8(ServiceLevel.VIP);
        minVotesToVote = 0;
        minVotesToPropose = 0;
    }

    // ============ Views ============

    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    function getUserGovernanceAccess(address user) external view returns (uint8 level) {
        return _userLevel[user];
    }

    function isEligibleToVote(address user, uint256 snapshotBlock, address votesToken)
        external
        view
        returns (bool ok, bytes32 reason)
    {
        return _isEligible(user, snapshotBlock, votesToken, minLevelToVote, minVotesToVote);
    }

    function isEligibleToPropose(address user, uint256 snapshotBlock, address votesToken)
        external
        view
        returns (bool ok, bytes32 reason)
    {
        return _isEligible(user, snapshotBlock, votesToken, minLevelToPropose, minVotesToPropose);
    }

    // ============ Writes ============

    /// @notice SSOT push for user level (used by off-chain ops/governance).
    /// @dev Writer: RewardConfig only (or break-glass role).
    function pushUserGovernanceAccess(address user, uint8 level) external onlyValidRegistry {
        _requireParamWriter(msg.sender);
        if (level > uint8(ServiceLevel.VIP)) revert GovernanceGate__InvalidServiceLevel(level);
        _userLevel[user] = level;
        emit UserGovernanceAccessUpdated(user, level, msg.sender, block.number);
    }

    /// @notice Update gate parameters (SSOT: RewardConfig).
    function setGovernanceGateParams(
        bool enabled_,
        uint8 minLevelToVote_,
        uint8 minLevelToPropose_,
        uint256 minVotesToVote_,
        uint256 minVotesToPropose_
    ) external onlyValidRegistry {
        _requireParamWriter(msg.sender);
        if (minLevelToVote_ > uint8(ServiceLevel.VIP)) revert GovernanceGate__InvalidServiceLevel(minLevelToVote_);
        if (minLevelToPropose_ > uint8(ServiceLevel.VIP)) revert GovernanceGate__InvalidServiceLevel(minLevelToPropose_);

        enabled = enabled_;
        minLevelToVote = minLevelToVote_;
        minLevelToPropose = minLevelToPropose_;
        minVotesToVote = minVotesToVote_;
        minVotesToPropose = minVotesToPropose_;

        emit GovernanceGateParamsUpdated(
            enabled_,
            minLevelToVote_,
            minLevelToPropose_,
            minVotesToVote_,
            minVotesToPropose_,
            msg.sender,
            block.number
        );
    }

    // ============ Internals ============

    function _isEligible(
        address user,
        uint256 snapshotBlock,
        address votesToken,
        uint8 requiredLevel,
        uint256 requiredVotes
    ) internal view returns (bool ok, bytes32 reason) {
        if (!enabled) return (true, REASON_GATE_DISABLED);

        // Strict mode (policy): votesToken MUST be configured (non-zero) when gate is enabled.
        // This avoids accidentally running governance with a misconfigured IVotes token.
        if (votesToken == address(0)) {
            return (false, REASON_VOTES_TOKEN_ZERO);
        }

        if (_userLevel[user] < requiredLevel) return (false, REASON_LEVEL_INSUFFICIENT);

        if (requiredVotes == 0) return (true, REASON_OK);

        uint256 vp = IVotes(votesToken).getPastVotes(user, snapshotBlock);
        if (vp < requiredVotes) return (false, REASON_VOTES_INSUFFICIENT);

        return (true, REASON_OK);
    }

    function _requireParamWriter(address caller) internal view {
        address rewardConfig = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_CONFIG);
        if (caller == rewardConfig) return;
        _requireRole(ActionKeys.ACTION_REWARD_CONFIG_EMERGENCY, caller);
    }

    // ============ Base Overrides ============

    function _getRegistryAddr() internal view override returns (address) {
        return _registryAddr;
    }

    // ============ UUPS Upgrade & Registry Management ============

    function _authorizeUpgrade(address newImplementation) internal view override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    function updateRegistry(address newRegistryAddr) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        if (newRegistryAddr.code.length == 0) revert NotAContract(newRegistryAddr);
        address old = _registryAddr;
        _registryAddr = newRegistryAddr;
        emit RegistryUpdated(old, newRegistryAddr);
    }

    // ============ Storage Gap ============
    uint256[50] private __gap;
}

