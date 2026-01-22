// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// solhint-disable-next-line no-global-import
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
// solhint-disable-next-line no-global-import
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../../constants/DataPushTypes.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/**
 * @title EventHistoryManager
 * @notice Lightweight event history stub (no on-chain persistence).
 * @dev Reverts if:
 *      - registry is zero / not a contract (ZeroAddress / NotAContract)
 *      - caller lacks required role (MissingRole via ACM)
 *
 * Security:
 * - No stateful history is stored on-chain (events-only).
 * - `recordEvent` is role-gated to prevent arbitrary log spam.
 * - UUPS upgradeability is role-gated (ACTION_ADMIN).
 */
contract EventHistoryManager is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/

    /**
     * @notice Emitted when a business event is recorded for off-chain indexing.
     * @param eventType Event type hash (e.g. keccak256("UPPER_SNAKE_CASE"))
     * @param user Related user address (may be zero depending on event semantics)
     * @param asset Related asset address (may be zero depending on event semantics)
     * @param amount Amount/quantity (token decimals as defined by the event producer)
     * @param extraData ABI-encoded extra payload for off-chain decoders
     * @param timestamp Event timestamp (seconds since epoch)
     */
    event HistoryRecorded(
        bytes32 indexed eventType,
        address indexed user,
        address indexed asset,
        uint256 amount,
        bytes extraData,
        uint256 timestamp
    );

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    /// @notice Registry contract address (internal use only).
    address private _registryAddr;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    modifier onlyAuthorizedModule() {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_MANAGE_EVENT_HISTORY, msg.sender);
        _;
    }

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the EventHistoryManager (UUPS).
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

    /*━━━━━━━━━━━━━━━ Push APIs ━━━━━━━━━━━━━━━*/

    /**
     * @notice Record a business event for off-chain indexing.
     * @dev Reverts if:
     *      - registry is not configured (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_MANAGE_EVENT_HISTORY (MissingRole via ACM)
     *
     * Security:
     * - events-only (no persistent storage writes except registry address)
     *
     * @param eventType Event type hash (keccak256("UPPER_SNAKE_CASE") suggested)
     * @param user Related user address (may be zero depending on event semantics)
     * @param asset Related asset address (may be zero depending on event semantics)
     * @param amount Amount/quantity (token decimals as defined by producer)
     * @param extraData ABI-encoded extra payload for off-chain decoders
     */
    function recordEvent(
        bytes32 eventType,
        address user,
        address asset,
        uint256 amount,
        bytes calldata extraData
    ) external onlyValidRegistry onlyAuthorizedModule {
        // solhint-disable-next-line not-rely-on-time
        uint256 timestamp = block.timestamp;
        emit HistoryRecorded(eventType, user, asset, amount, extraData, timestamp);

        // Unified DataPush event (off-chain consumers should subscribe to DataPushed)
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_HISTORY,
            abi.encode(eventType, user, asset, amount, extraData)
        );
    }

    /*━━━━━━━━━━━━━━━ UUPS upgradeability ━━━━━━━━━━━━━━━*/

    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ Read APIs ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get the Registry contract address (legacy getter).
     * @dev This function is kept for backward compatibility; prefer `getRegistry()`.
     *
     * Security:
     * - Read-only
     *
     * @return registryAddrVar Registry contract address
     */
    function registryAddr() external view returns (address registryAddrVar) {
        return _registryAddr;
    }

    /**
     * @notice Get the Registry contract address.
     * @dev Prefer this function over the legacy `registryAddr()` getter.
     *
     * Security:
     * - Read-only
     *
     * @return registryAddrVar Registry contract address
     */
    function getRegistry() external view returns (address registryAddrVar) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ Versioning (C+B baseline) ━━━━━━━━━━━━━━━*/
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /// @notice Storage gap for future upgrades
    uint256[50] private __gap;
}
