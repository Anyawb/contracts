// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IRegistry } from "../../interfaces/IRegistry.sol";
import { ModuleKeys } from "../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../constants/ActionKeys.sol";
import { RewardModuleBase } from "../internal/RewardModuleBase.sol";
import { SystemEvents } from "../../Vault/SystemEvents.sol";
import { NotAContract, ZeroAddress, InvalidCaller } from "../../errors/StandardErrors.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/*━━━━━━━━━━━━━━━ EarnConfig ━━━━━━━━━━━━━━━*/

/// @title EarnConfig
/// @notice Earn-side governance parameters (SSOT via RewardConfig).
/// @dev Write-path SSOT: only Registry[KEY_REWARD_CONFIG] may update (strong constraint).
///      Break-glass: allow callers with ACTION_REWARD_CONFIG_EMERGENCY (revocable).
///      Frontends should prefer RewardView for cached reads.
contract EarnConfig is Initializable, UUPSUpgradeable, RewardModuleBase {
    /// @notice Registry address (private storage).
    address private _registryAddr;

    /// @notice Dynamic reward configuration.
    /// @dev If dynamicMultiplierBps == 0, dynamic reward is disabled.
    ///      If enabled, dynamicThresholdEasy must be > 0.
    uint256 private _dynamicThresholdEasy;
    uint256 private _dynamicMultiplierBps;
    uint256 private _dynamicConfigUpdateBlock;

    /// @notice Level multipliers (BPS, 10000 = 1x). Valid level range: 1..5.
    mapping(uint8 => uint256) private _levelMultiplierBps;
    uint256 private _levelConfigUpdateBlock;

    /// @notice Emitted when dynamic reward params are updated.
    /// @dev Emitted by setDynamicRewardParams. thresholdEasy/multiplierBps may be 0 when disabling.
    event DynamicRewardParamsUpdated(uint256 thresholdEasy, uint256 multiplierBps, uint256 blockNumber);

    /// @notice Emitted when a level multiplier is updated.
    /// @dev Emitted by setLevelMultiplier. level is indexed for filtering.
    event LevelMultiplierUpdated(uint8 indexed level, uint256 multiplierBps, uint256 blockNumber);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the EarnConfig with the given Registry address.
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (see {ZeroAddress})
     *      - initialRegistryAddr is not a contract (see {NotAContract})
     *
     * Security:
     * - One-time init via initializer modifier; sets default multipliers for levels 1..5 (1x each).
     *
     * @param initialRegistryAddr Registry contract address.
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;

        // Default: 1x multiplier for levels 1..5 (explicit).
        _levelMultiplierBps[1] = 10_000;
        _levelMultiplierBps[2] = 10_000;
        _levelMultiplierBps[3] = 10_000;
        _levelMultiplierBps[4] = 10_000;
        _levelMultiplierBps[5] = 10_000;

        _dynamicConfigUpdateBlock = block.number;
        _levelConfigUpdateBlock = block.number;

        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /*━━━━━━━━━━━━━━━ Write Gating ━━━━━━━━━━━━━*/

    /// @dev Strong constraint for EarnConfig writes (SSOT):
    ///      Default: only Registry[KEY_REWARD_CONFIG] may call.
    ///      Break-glass: allow callers with ACTION_REWARD_CONFIG_EMERGENCY (revocable).
    function _requireEarnConfigWriter(address caller) internal view onlyValidRegistry {
        address rewardConfigAddr = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_CONFIG);
        if (caller == rewardConfigAddr) return;
        _requireRole(ActionKeys.ACTION_REWARD_CONFIG_EMERGENCY, caller);
    }

    /*━━━━━━━━━━━━━━━ Governance Writes ━━━━━━━━━━━━━*/

    /**
     * @notice Sets dynamic reward params (threshold and multiplier in BPS).
     * @dev Reverts if:
     *      - Registry is zero or not a contract (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - Registry missing KEY_REWARD_CONFIG or KEY_ACCESS_CONTROL (reverts in getModuleOrRevert)
     *      - Caller is not RewardConfig and lacks ACTION_REWARD_CONFIG_EMERGENCY (ACM MissingRole)
    *      - multiplierBps != 0 and thresholdEasy == 0 (see {InvalidCaller})
     *      - multiplierBps > 100_000 (see {InvalidCaller})
     *
     * Security:
     * - Role-gated via _requireEarnConfigWriter.
     * - multiplierBps = 0 disables dynamic reward (threshold ignored).
     *
     * @param thresholdEasy EasyToken threshold for dynamic reward. Ignored when multiplierBps = 0.
     * @param multiplierBps Multiplier in BPS (10000 = 1x). Max 100000. 0 disables.
     */
    function setDynamicRewardParams(uint256 thresholdEasy, uint256 multiplierBps) external onlyValidRegistry {
        _requireEarnConfigWriter(msg.sender);

        // Allow disabling via multiplierBps=0 (threshold ignored).
        if (multiplierBps == 0) {
            _dynamicThresholdEasy = 0;
            _dynamicMultiplierBps = 0;
            _dynamicConfigUpdateBlock = block.number;
            emit DynamicRewardParamsUpdated(0, 0, block.number);
            return;
        }

        if (thresholdEasy == 0) revert InvalidCaller();
        if (multiplierBps > 100_000) revert InvalidCaller(); // hard cap to avoid overflowy/absurd configs

        _dynamicThresholdEasy = thresholdEasy;
        _dynamicMultiplierBps = multiplierBps;
        _dynamicConfigUpdateBlock = block.number;
        emit DynamicRewardParamsUpdated(thresholdEasy, multiplierBps, block.number);
    }

    /**
     * @notice Sets the level multiplier for a given level.
     * @dev Reverts if:
     *      - Registry is zero or not a contract (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - Registry missing KEY_REWARD_CONFIG or KEY_ACCESS_CONTROL (reverts in getModuleOrRevert)
     *      - Caller is not RewardConfig and lacks ACTION_REWARD_CONFIG_EMERGENCY (ACM MissingRole)
     *      - level not in [1, 5] (see {InvalidCaller})
     *      - multiplierBps is 0 or > 100_000 (see {InvalidCaller})
     *
     * Security:
     * - Role-gated via _requireEarnConfigWriter.
     *
     * @param level User level (1..5).
     * @param multiplierBps Multiplier in BPS (10000 = 1x). Range: (0, 100000].
     */
    function setLevelMultiplier(uint8 level, uint256 multiplierBps) external onlyValidRegistry {
        _requireEarnConfigWriter(msg.sender);
        if (level < 1 || level > 5) revert InvalidCaller();
        if (multiplierBps == 0 || multiplierBps > 100_000) revert InvalidCaller();
        _levelMultiplierBps[level] = multiplierBps;
        _levelConfigUpdateBlock = block.number;
        emit LevelMultiplierUpdated(level, multiplierBps, block.number);
    }

    /*━━━━━━━━━━━━━━━ Views ━━━━━━━━━━━━━*/

    /**
     * @notice Returns current dynamic reward params and last update block.
     * @dev Reverts if:
     *      - Registry is zero or not a contract (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - Registry missing required modules (reverts in getModuleOrRevert)
     *
     * Security:
     * - View-only; no state mutation.
     *
     * @return thresholdEasy EasyToken threshold. 0 when dynamic reward disabled.
     * @return multiplierBps Multiplier in BPS. 0 when disabled.
     * @return updateBlock Block number of last config update.
     */
    function getDynamicRewardParams()
        external
        view
        onlyValidRegistry
        returns (uint256 thresholdEasy, uint256 multiplierBps, uint256 updateBlock)
    {
        return (_dynamicThresholdEasy, _dynamicMultiplierBps, _dynamicConfigUpdateBlock);
    }

    /**
     * @notice Returns the level multiplier in BPS for a given level.
     * @dev Reverts if:
     *      - Registry is zero or not a contract (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - level not in [1, 5] (see {InvalidCaller})
     *
     * Security:
     * - View-only; no state mutation.
     *
     * @param level User level (1..5).
     * @return multiplierBps Multiplier in BPS (10000 = 1x).
     */
    function getLevelMultiplierBps(uint8 level) external view onlyValidRegistry returns (uint256 multiplierBps) {
        if (level < 1 || level > 5) revert InvalidCaller();
        return _levelMultiplierBps[level];
    }

    /**
     * @notice Returns the block number of last level config update.
     * @dev Reverts if:
     *      - Registry is zero or not a contract (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - Registry missing required modules (reverts in getModuleOrRevert)
     *
     * Security:
     * - View-only; no state mutation.
     *
     * @return Block number of last setLevelMultiplier call.
     */
    function getLevelConfigUpdateBlock() external view onlyValidRegistry returns (uint256) {
        return _levelConfigUpdateBlock;
    }

    /*━━━━━━━━━━━━━━━ RewardModuleBase ━━━━━━━━━━━━━*/

    function _getRegistryAddr() internal view override returns (address) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ UUPS ━━━━━━━━━━━━━*/

    /// @dev Reverts if: caller lacks ACTION_UPGRADE_MODULE; newImplementation is zero (see {ZeroAddress}).
    function _authorizeUpgrade(address newImplementation) internal view override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    uint256[50] private __gap;
}
