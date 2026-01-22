// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// solhint-disable-next-line no-global-import
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
// solhint-disable-next-line no-global-import
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IRegistryDynamicModuleKey } from "../../../interfaces/IRegistryDynamicModuleKey.sol";
import { NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/**
 * @title RegistryView
 * @notice Read-only Registry facade for listing module keys, checking registrations, reverse lookups, and pagination.
 * @dev Reverts if:
 *      - registry is zero / not a contract (ZeroAddress / NotAContract)
 *      - batch size exceeds MAX_BATCH_SIZE (RegistryView__BatchTooLarge)
 *
 * Security:
 * - Read-only: this module does not mutate Registry state; it only reads and aggregates data for 0-gas queries.
 * - Best-effort dynamic key aggregation: if the dynamic key registry is missing or fails, the module falls back to
 *   static ModuleKeys only.
 * - UUPS upgradeability is role-gated (ACTION_ADMIN via ACM).
 */
contract RegistryView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/

    /**
     * @notice Batch size exceeds MAX_BATCH_SIZE.
     * @dev Reverts when an input batch length is greater than ViewConstants.MAX_BATCH_SIZE.
     *      Used by: checkModulesExist, batchFindModuleKeysByAddresses, getRegisteredModuleKeysPaginated.
     * @param length Input batch length
     * @param maxAllowed Maximum allowed batch size
     */
    error RegistryView__BatchTooLarge(uint256 length, uint256 maxAllowed);

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    address private _registryAddr;
    uint256 private constant _MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the RegistryView (UUPS).
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (ZeroAddress)
     *      - initialRegistryAddr is not a contract (NotAContract)
     *
     * Security:
     * - initializer (UUPS)
     *
     * @param initialRegistryAddr Registry contract address
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/

    function _enforceBatchLimit(uint256 len) internal pure {
        if (len > _MAX_BATCH_SIZE) revert RegistryView__BatchTooLarge(len, _MAX_BATCH_SIZE);
    }

    /**
     * @notice Get the full list of module keys (static + dynamic).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only
     * - Best-effort: if dynamic key registry is missing (address(0)) or the call fails, returns static keys only.
     *
     * @return allKeys All module keys (static keys first, then dynamic keys)
     */
    function _getAllModuleKeys() internal view returns (bytes32[] memory) {
        bytes32[] memory staticKeys = ModuleKeys.getAllKeys();
        address dynReg = Registry(_registryAddr).getModule(ModuleKeys.KEY_DYNAMIC_MODULE_REGISTRY);
        
        // No dynamic key registry configured.
        if (dynReg == address(0)) return staticKeys;
        
        // Best-effort: attempt to load dynamic keys.
        try IRegistryDynamicModuleKey(dynReg).getDynamicModuleKeys() returns (bytes32[] memory dynamicKeys) {
            uint256 staticLen = staticKeys.length;
            uint256 dynamicLen = dynamicKeys.length;
            bytes32[] memory allKeys = new bytes32[](staticLen + dynamicLen);
            
            for (uint256 i = 0; i < staticLen; ) {
                allKeys[i] = staticKeys[i];
                unchecked { ++i; }
            }
            
            for (uint256 i = 0; i < dynamicLen; ) {
                allKeys[staticLen + i] = dynamicKeys[i];
                unchecked { ++i; }
            }
            
            return allKeys;
        } catch {
            // Dynamic key registry call failed: fall back to static keys.
            return staticKeys;
        }
    }

    /*━━━━━━━━━━━━━━━ Read APIs: keys ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get all known module keys (static + dynamic).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only
     * - Best-effort: dynamic keys are included only if dynamic key registry is configured and callable.
     *
     * @return allKeys All module keys (static keys first, then dynamic keys)
     */
    function getAllModuleKeys() external view onlyValidRegistry returns (bytes32[] memory) {
        return _getAllModuleKeys();
    }

    /**
     * @notice Get all registered module keys (static + dynamic).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only
     *
     * @return keys Registered module keys
     */
    function getAllRegisteredModuleKeys() external view onlyValidRegistry returns (bytes32[] memory) {
        bytes32[] memory allKeys = _getAllModuleKeys();
        uint256 count;
        for (uint256 i; i < allKeys.length; i++) {
            if (Registry(_registryAddr).getModule(allKeys[i]) != address(0)) count++;
        }
        bytes32[] memory keys = new bytes32[](count);
        uint256 k;
        for (uint256 i; i < allKeys.length; i++) {
            address addr = Registry(_registryAddr).getModule(allKeys[i]);
            if (addr != address(0)) keys[k++] = allKeys[i];
        }
        return keys;
    }

    /**
     * @notice Get all registered module keys and their resolved addresses (static + dynamic).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only
     *
     * @return keys Registered module keys
     * @return addrs Module addresses corresponding to keys
     */
    function getAllRegisteredModules()
        external
        view
        onlyValidRegistry
        returns (bytes32[] memory keys, address[] memory addrs)
    {
        bytes32[] memory allKeys = _getAllModuleKeys();
        uint256 count;
        for (uint256 i; i < allKeys.length; i++) {
            if (Registry(_registryAddr).getModule(allKeys[i]) != address(0)) count++;
        }
        keys = new bytes32[](count);
        addrs = new address[](count);
        uint256 k;
        for (uint256 i; i < allKeys.length; i++) {
            address addr = Registry(_registryAddr).getModule(allKeys[i]);
            if (addr != address(0)) {
                keys[k] = allKeys[i];
                addrs[k] = addr;
                k++;
            }
        }
    }

    /*━━━━━━━━━━━━━━━ Read APIs: existence checks ━━━━━━━━━━━━━━━*/

    /**
     * @notice Batch-check whether modules exist (registered) for the given keys.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - keys.length exceeds MAX_BATCH_SIZE (RegistryView__BatchTooLarge)
     *
     * Security:
     * - Read-only
     *
     * @param keys Module keys to check
     * @return exists Per-key existence flags (true if Registry.getModule(key) != address(0))
     */
    function checkModulesExist(bytes32[] calldata keys)
        external
        view
        onlyValidRegistry
        returns (bool[] memory exists)
    {
        _enforceBatchLimit(keys.length);
        exists = new bool[](keys.length);
        for (uint256 i; i < keys.length; i++) {
            exists[i] = (Registry(_registryAddr).getModule(keys[i]) != address(0));
        }
    }

    /**
     * @notice Alias for {checkModulesExist} (backward compatible).
     * @dev Reverts if:
     *      - see {checkModulesExist}
     *
     * Security:
     * - Read-only
     *
     * @param keys Module keys to check
     * @return exists Per-key existence flags
     */
    function batchModuleExists(bytes32[] calldata keys)
        external
        view
        onlyValidRegistry
        returns (bool[] memory exists)
    {
        return this.checkModulesExist(keys);
    }

    /*━━━━━━━━━━━━━━━ Read APIs: reverse lookup ━━━━━━━━━━━━━━━*/

    /**
     * @notice Reverse lookup a static module key by module address (best-effort).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only
     * - Best-effort: scans static keys only (ModuleKeys.getAllKeys()) to keep runtime bounded and predictable.
     *
     * @param moduleAddr Module address to search for
     * @param maxCount Maximum number of static keys to scan (0 means scan all static keys)
     * @return key Matched key, or bytes32(0) if not found
     * @return found Whether a matching key was found
     */
    function findModuleKeyByAddress(address moduleAddr, uint256 maxCount)
        external
        view
        onlyValidRegistry
        returns (bytes32 key, bool found)
    {
        if (moduleAddr == address(0)) return (bytes32(0), false);
        bytes32[] memory allKeys = ModuleKeys.getAllKeys();
        uint256 limit = maxCount == 0 || maxCount > allKeys.length ? allKeys.length : maxCount;
        for (uint256 i; i < limit; i++) {
            if (Registry(_registryAddr).getModule(allKeys[i]) == moduleAddr) return (allKeys[i], true);
        }
        return (bytes32(0), false);
    }

    /**
     * @notice Batch reverse lookup static keys by module addresses.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - moduleAddrs.length exceeds MAX_BATCH_SIZE (RegistryView__BatchTooLarge)
     *
     * Security:
     * - Read-only
     *
     * @param moduleAddrs Module addresses to search for
     * @param maxCount Maximum number of static keys to scan per address (0 means scan all static keys)
     * @return keys Matched keys (bytes32(0) when not found)
     * @return founds Per-address found flags
     */
    function batchFindModuleKeysByAddresses(address[] calldata moduleAddrs, uint256 maxCount)
        external
        view
        onlyValidRegistry
        returns (bytes32[] memory keys, bool[] memory founds)
    {
        _enforceBatchLimit(moduleAddrs.length);
        keys = new bytes32[](moduleAddrs.length);
        founds = new bool[](moduleAddrs.length);
        for (uint256 i; i < moduleAddrs.length; i++) {
            (keys[i], founds[i]) = this.findModuleKeyByAddress(moduleAddrs[i], maxCount);
        }
    }

    /*━━━━━━━━━━━━━━━ Read APIs: pagination ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get registered module keys with pagination (static + dynamic).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - limit exceeds MAX_BATCH_SIZE (RegistryView__BatchTooLarge)
     *
     * Security:
     * - Read-only
     *
     * @param offset Page offset into the registered key list (0-based)
     * @param limit Maximum number of keys to return (must be <= MAX_BATCH_SIZE)
     * @return keys Page of registered keys
     * @return totalCount Total number of registered keys
     */
    function getRegisteredModuleKeysPaginated(uint256 offset, uint256 limit)
        external
        view
        onlyValidRegistry
        returns (bytes32[] memory keys, uint256 totalCount)
    {
        if (limit > _MAX_BATCH_SIZE) revert RegistryView__BatchTooLarge(limit, _MAX_BATCH_SIZE);
        bytes32[] memory allKeys = _getAllModuleKeys();
        for (uint256 i; i < allKeys.length; i++) {
            if (Registry(_registryAddr).getModule(allKeys[i]) != address(0)) totalCount++;
        }
        if (offset >= totalCount) return (new bytes32[](0), totalCount);
        uint256 end = offset + limit;
        if (end > totalCount) end = totalCount;
        uint256 pageLen = end - offset;
        keys = new bytes32[](pageLen);
        uint256 idx;
        uint256 write;
        for (uint256 i; i < allKeys.length && write < pageLen; i++) {
            if (Registry(_registryAddr).getModule(allKeys[i]) != address(0)) {
                if (idx >= offset && idx < end) {
                    keys[write++] = allKeys[i];
                }
                idx++;
            }
        }
    }

    /*━━━━━━━━━━━━━━━ Read APIs: registry address (legacy-compatible) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get the Registry contract address (legacy `registryAddrVar` name).
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Read-only
     *
     * @return registryAddr Registry contract address
     */
    function registryAddrVar() external view returns (address) { return _registryAddr; }

    /**
     * @notice Get the Registry contract address.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Read-only
     *
     * @return registryAddr Registry contract address
     */
    function registryAddr() external view returns (address) { return _registryAddr; }

    /**
     * @notice Get the Registry contract address (legacy `getRegistry` name).
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Read-only
     *
     * @return registryAddr Registry contract address
     */
    function getRegistry() external view returns (address) { return _registryAddr; }

    /*━━━━━━━━━━━━━━━ Read APIs: governance passthrough (best-effort) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Best-effort passthrough to Registry.minDelay().
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns 0 if the underlying Registry call fails or the function is not implemented.
     *
     * @return delay Governance minDelay (seconds), or 0 on failure
     */
    function minDelay() external view onlyValidRegistry returns (uint256) {
        try Registry(_registryAddr).minDelay() returns (uint256 v) { return v; } catch { return 0; }
    }

    /**
     * @notice Best-effort passthrough to Registry.MAX_DELAY().
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns 0 if the underlying Registry call fails or the function is not implemented.
     *
     * @return delay Governance MAX_DELAY (seconds), or 0 on failure
     */
    function maxDelay() external view onlyValidRegistry returns (uint256) {
        try Registry(_registryAddr).MAX_DELAY() returns (uint256 v) { return v; } catch { return 0; }
    }

    /**
     * @notice Best-effort passthrough to Registry.owner().
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns address(0) if the underlying Registry call fails or the function is not implemented.
     *
     * @return ownerAddr Owner address, or address(0) on failure
     */
    function owner() external view onlyValidRegistry returns (address) {
        try Registry(_registryAddr).owner() returns (address v) { return v; } catch { return address(0); }
    }

    /*━━━━━━━━━━━━━━━ UUPS upgrade ━━━━━━━━━━━━━━━*/

    /**
     * @notice Authorize a UUPS upgrade.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADMIN (reverts in ViewAccessLib.requireRole)
     *      - newImplementation is zero (ZeroAddress)
     *      - newImplementation is not a contract (NotAContract)
     *
     * Security:
     * - Role-gated: ACTION_ADMIN
     *
     * @param newImplementation New implementation address
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ Versioning (C+B baseline) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get the API version for this module.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Read-only
     *
     * @return version API semantic version
     */
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    /**
     * @notice Get the schema version for this module's outputs.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Read-only
     *
     * @return version Schema version
     */
    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/

    uint256[50] private __gap;
}


