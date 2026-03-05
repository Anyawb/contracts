// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {IRegistry} from "../interfaces/IRegistry.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {ActionKeys} from "../constants/ActionKeys.sol";
import {RewardTypes} from "./RewardTypes.sol";
import {RewardModuleBase} from "./internal/RewardModuleBase.sol";
import {ZeroAddress, NotAContract, IndexOutOfBounds, ArrayLengthMismatch} from "../errors/StandardErrors.sol";

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
contract FeatureRegistry is Initializable, UUPSUpgradeable, RewardTypes, RewardModuleBase {
    // ============ Errors ============
    error FeatureRegistry__InvalidServiceLevel(uint8 level);
    error FeatureRegistry__InvalidFeatureKey();

    // ============ Types ============
    struct Feature {
        uint8 minLevel; // RewardTypes.ServiceLevel
        bool enabled;
        string nameOrUri;
    }

    // ============ Storage ============
    address private _registryAddr;

    mapping(bytes32 => Feature) private _features;

    bytes32[] private _featureKeys;
    mapping(bytes32 => uint256) private _indexPlus1; // 0 => not present; else index+1 in _featureKeys

    // ============ Events ============
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
    }

    // ============ Views ============

    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    function getFeature(bytes32 featureKey)
        external
        view
        returns (uint8 minLevel, bool enabled, string memory nameOrUri)
    {
        Feature storage f = _features[featureKey];
        return (f.minLevel, f.enabled, f.nameOrUri);
    }

    function listFeatureKeys(uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory keys, uint256 total)
    {
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

    // ============ Writes (SSOT) ============

    function setFeature(bytes32 featureKey, uint8 minLevel, bool enabled, string calldata nameOrUri)
        external
        onlyValidRegistry
    {
        _requireWriter(msg.sender);
        _setFeature(featureKey, minLevel, enabled, nameOrUri);
    }

    function batchSetFeatures(
        bytes32[] calldata keys,
        uint8[] calldata minLevels,
        bool[] calldata enableds,
        string[] calldata uris
    ) external onlyValidRegistry {
        _requireWriter(msg.sender);
        if (keys.length != minLevels.length) revert ArrayLengthMismatch(keys.length, minLevels.length);
        if (keys.length != enableds.length) revert ArrayLengthMismatch(keys.length, enableds.length);
        if (keys.length != uris.length) revert ArrayLengthMismatch(keys.length, uris.length);
        for (uint256 i = 0; i < keys.length; i++) {
            _setFeature(keys[i], minLevels[i], enableds[i], uris[i]);
        }
    }

    // ============ Internals ============

    function _setFeature(bytes32 featureKey, uint8 minLevel, bool enabled, string calldata nameOrUri) internal {
        if (featureKey == bytes32(0)) revert FeatureRegistry__InvalidFeatureKey();
        if (minLevel > uint8(ServiceLevel.VIP)) revert FeatureRegistry__InvalidServiceLevel(minLevel);

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

    function _requireWriter(address caller) internal view {
        address rewardConfig = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_CONFIG);
        if (caller == rewardConfig) return;

        // break-glass
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

