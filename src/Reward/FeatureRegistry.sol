// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {IRegistry} from "../interfaces/IRegistry.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {ActionKeys} from "../constants/ActionKeys.sol";
import {RewardTypes} from "./RewardTypes.sol";
import {RewardModuleBase} from "./internal/RewardModuleBase.sol";
import {
    ZeroAddress,
    NotAContract,
    IndexOutOfBounds,
    ArrayLengthMismatch
} from "../errors/StandardErrors.sol";

/**
 * @title FeatureRegistry
 * @notice Chain-level SSOT for "what features exist" and their required ServiceLevel.
 *
 * SSOT / Permissions:
 * - Primary writer: Registry[KEY_REWARD_CONFIG] (RewardConfig) only.
 * - Optional break-glass: ACTION_REWARD_CONFIG_EMERGENCY.
 *
 * Time:
 * - Uses block.number for event auditing only.
 */
contract FeatureRegistry is
    Initializable,
    UUPSUpgradeable,
    RewardTypes,
    RewardModuleBase
{
    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/

    /// @dev Reverts when a feature update uses a level above
    ///      {ServiceLevel.VIP}. Used by {setFeature} and {batchSetFeatures}.
    error FeatureRegistry__InvalidServiceLevel(uint8 level);
    /// @dev Reverts when a feature key is zero. Used by {setFeature} and {batchSetFeatures}.
    error FeatureRegistry__InvalidFeatureKey();

    /*━━━━━━━━━━━━━━━ Types ━━━━━━━━━━━━━━━*/
    struct Feature {
        uint8 minLevel; // RewardTypes.ServiceLevel
        bool enabled;
        string nameOrUri;
    }

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/
    address private _registryAddr;

    mapping(bytes32 => Feature) private _features;

    bytes32[] private _featureKeys;
    mapping(bytes32 => uint256) private _indexPlus1; // 0 => not present; else index+1 in _featureKeys

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/

    /// @notice Emitted when one feature definition is created or updated.
    /// @dev URI hashes are emitted instead of full strings for compact change
    ///      tracking; updatedBy is indexed for governance auditing.
    event FeatureSet(
        bytes32 indexed featureKey,
        uint8 oldMinLevel,
        uint8 newMinLevel,
        bool oldEnabled,
        bool newEnabled,
        bytes32 oldUriHash,
        bytes32 newUriHash,
        address indexed updatedBy,
        uint256 blockNumber
    );

    /// @notice Emitted when the Registry address is updated.
    /// @dev Used to audit module-root changes affecting all future lookups.
    event RegistryUpdated(
        address indexed oldRegistry,
        address indexed newRegistry
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the registry module.
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (see {ZeroAddress})
     *      - initialRegistryAddr is not a contract (see {NotAContract})
     *
     * Security:
     * - One-time initializer.
     * - Registry address becomes the SSOT for writer and ACL resolution.
     *
     * @param initialRegistryAddr Registry contract address.
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Views ━━━━━━━━━━━━━━━*/

    /// @notice Returns the Registry address used by this module.
    /// @dev View-only helper; no Registry validity check is applied here.
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    /**
     * @notice Returns one feature definition.
     * @dev Missing keys return the default zero-value tuple.
     *
     * Security:
     * - View-only; no state mutation.
     *
     * @param featureKey Feature identifier.
     * @return minLevel Minimum {ServiceLevel} ordinal required for the feature.
     * @return enabled Whether the feature is currently enabled.
     * @return nameOrUri Human-readable name or metadata URI.
     */
    function getFeature(
        bytes32 featureKey
    )
        external
        view
        returns (uint8 minLevel, bool enabled, string memory nameOrUri)
    {
        Feature storage f = _features[featureKey];
        return (f.minLevel, f.enabled, f.nameOrUri);
    }

    /**
     * @notice Returns a paginated slice of feature keys.
     * @dev Reverts if:
     *      - offset is greater than total key count (see {IndexOutOfBounds})
     *
     * Security:
     * - View-only pagination helper.
     *
     * @param offset Zero-based starting index into the feature key array.
     * @param limit Maximum number of keys to return.
     * @return keys Paginated feature key slice.
     * @return total Total number of registered feature keys.
     */
    function listFeatureKeys(
        uint256 offset,
        uint256 limit
    ) external view returns (bytes32[] memory keys, uint256 total) {
        total = _featureKeys.length;
        if (offset > total) revert IndexOutOfBounds(offset, total);
        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 n = end > offset ? end - offset : 0;
        keys = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            keys[i] = _featureKeys[offset + i];
        }
        return (keys, total);
    }

    /*━━━━━━━━━━━━━━━ Writes ━━━━━━━━━━━━━━━*/

    /**
     * @notice Sets one feature definition.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - caller is neither RewardConfig nor ACTION_REWARD_CONFIG_EMERGENCY holder
     *      - featureKey is zero (see {FeatureRegistry__InvalidFeatureKey})
     *      - minLevel exceeds {ServiceLevel.VIP} (see {FeatureRegistry__InvalidServiceLevel})
     *
     * Security:
     * - Primary writer is Registry[KEY_REWARD_CONFIG].
     * - Break-glass path is ACTION_REWARD_CONFIG_EMERGENCY.
     *
     * @param featureKey Feature identifier.
     * @param minLevel Minimum {ServiceLevel} ordinal required for access.
     * @param enabled Whether the feature is enabled.
     * @param nameOrUri Human-readable name or metadata URI.
     */
    function setFeature(
        bytes32 featureKey,
        uint8 minLevel,
        bool enabled,
        string calldata nameOrUri
    ) external onlyValidRegistry {
        _requireWriter(msg.sender);
        _setFeature(featureKey, minLevel, enabled, nameOrUri);
    }

    /**
     * @notice Sets multiple feature definitions in one call.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - caller is neither RewardConfig nor ACTION_REWARD_CONFIG_EMERGENCY holder
     *      - array lengths do not match (see {ArrayLengthMismatch})
     *      - any featureKey is zero (see {FeatureRegistry__InvalidFeatureKey})
     *      - any minLevel exceeds {ServiceLevel.VIP} (see {FeatureRegistry__InvalidServiceLevel})
     *
     * Security:
     * - Batch write preserves the same writer gating as {setFeature}.
     * - Iterates sequentially and emits one {FeatureSet} event per entry.
     *
     * @param keys Feature identifiers.
     * @param minLevels Minimum {ServiceLevel} ordinals for each key.
     * @param enableds Enabled flags for each key.
     * @param uris Human-readable names or metadata URIs for each key.
     */
    function batchSetFeatures(
        bytes32[] calldata keys,
        uint8[] calldata minLevels,
        bool[] calldata enableds,
        string[] calldata uris
    ) external onlyValidRegistry {
        _requireWriter(msg.sender);
        if (keys.length != minLevels.length)
            revert ArrayLengthMismatch(keys.length, minLevels.length);
        if (keys.length != enableds.length)
            revert ArrayLengthMismatch(keys.length, enableds.length);
        if (keys.length != uris.length)
            revert ArrayLengthMismatch(keys.length, uris.length);
        for (uint256 i = 0; i < keys.length; i++) {
            _setFeature(keys[i], minLevels[i], enableds[i], uris[i]);
        }
    }

    /*━━━━━━━━━━━━━━━ Internals ━━━━━━━━━━━━━━━*/

    /// @dev Writes one feature record and emits the delta event.
    function _setFeature(
        bytes32 featureKey,
        uint8 minLevel,
        bool enabled,
        string calldata nameOrUri
    ) internal {
        if (featureKey == bytes32(0))
            revert FeatureRegistry__InvalidFeatureKey();
        if (minLevel > uint8(ServiceLevel.VIP))
            revert FeatureRegistry__InvalidServiceLevel(minLevel);

        Feature storage f = _features[featureKey];
        uint8 oldMinLevel = f.minLevel;
        bool oldEnabled = f.enabled;
        bytes32 oldUriHash = keccak256(bytes(f.nameOrUri));

        if (_indexPlus1[featureKey] == 0) {
            _featureKeys.push(featureKey);
            _indexPlus1[featureKey] = _featureKeys.length; // index+1
        }

        f.minLevel = minLevel;
        f.enabled = enabled;
        f.nameOrUri = nameOrUri;

        emit FeatureSet(
            featureKey,
            oldMinLevel,
            minLevel,
            oldEnabled,
            enabled,
            oldUriHash,
            keccak256(bytes(nameOrUri)),
            msg.sender,
            block.number
        );
    }

    /// @dev Allows RewardConfig as the primary writer and ACTION_REWARD_CONFIG_EMERGENCY as break-glass.
    function _requireWriter(address caller) internal view {
        address rewardConfig = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_REWARD_CONFIG
        );
        if (caller == rewardConfig) return;

        // break-glass
        _requireRole(ActionKeys.ACTION_REWARD_CONFIG_EMERGENCY, caller);
    }

    /*━━━━━━━━━━━━━━━ RewardModuleBase ━━━━━━━━━━━━━━━*/

    function _getRegistryAddr() internal view override returns (address) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ UUPS And Registry Management ━━━━━━━━━━━━━━━*/

    /// @dev Reverts if caller lacks ACTION_UPGRADE_MODULE or newImplementation is zero (see {ZeroAddress}).
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    /**
     * @notice Updates the Registry root used by this module.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - caller lacks ACTION_SET_PARAMETER
     *      - newRegistryAddr is zero (see {ZeroAddress})
     *      - newRegistryAddr is not a contract (see {NotAContract})
     *
     * Security:
     * - Governance-only root update.
     * - Changes all future module lookups and role resolution.
     *
     * @param newRegistryAddr New Registry contract address.
     */
    function updateRegistry(
        address newRegistryAddr
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        if (newRegistryAddr.code.length == 0)
            revert NotAContract(newRegistryAddr);

        address old = _registryAddr;
        _registryAddr = newRegistryAddr;
        emit RegistryUpdated(old, newRegistryAddr);
    }

    /*━━━━━━━━━━━━━━━ Storage Gap ━━━━━━━━━━━━━━━*/
    uint256[50] private __gap;
}
