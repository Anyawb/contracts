// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IRegistryDynamicModuleKey} from "../interfaces/IRegistryDynamicModuleKey.sol";

/// @title MockRegistryDynamicModuleKeyRevert
/// @notice Test-only mock that reverts on getDynamicModuleKeys()
/// @dev Used to validate RegistryView best-effort fallback behavior.
contract MockRegistryDynamicModuleKeyRevert is IRegistryDynamicModuleKey {
    error MockRegistryDynamicModuleKeyRevert__AlwaysRevert();

    /*━━━━━━━━━━━━━━━ Module Key Registration ━━━━━━━━━━━━━━━*/
    function registerModuleKey(
        string calldata
    ) external pure returns (bytes32) {
        revert MockRegistryDynamicModuleKeyRevert__AlwaysRevert();
    }

    function batchRegisterModuleKeys(
        string[] calldata
    ) external pure returns (bytes32[] memory) {
        revert MockRegistryDynamicModuleKeyRevert__AlwaysRevert();
    }

    function unregisterModuleKey(bytes32) external pure {
        revert MockRegistryDynamicModuleKeyRevert__AlwaysRevert();
    }

    /*━━━━━━━━━━━━━━━ Core Dynamic Module Key Functions ━━━━━━━━━━━━━━━*/
    function isDynamicModuleKey(bytes32) external pure returns (bool) {
        return false;
    }

    function isValidModuleKey(bytes32) external pure returns (bool) {
        return false;
    }

    function getModuleKeyByName(
        string calldata
    ) external pure returns (bytes32) {
        revert MockRegistryDynamicModuleKeyRevert__AlwaysRevert();
    }

    function getModuleKeyName(bytes32) external pure returns (string memory) {
        revert MockRegistryDynamicModuleKeyRevert__AlwaysRevert();
    }

    /*━━━━━━━━━━━━━━━ Dynamic Module Key Management ━━━━━━━━━━━━━━━*/
    function getDynamicModuleKeys() external pure returns (bytes32[] memory) {
        revert MockRegistryDynamicModuleKeyRevert__AlwaysRevert();
    }

    function getDynamicKeyCount() external pure returns (uint256) {
        return 0;
    }

    function getDynamicModuleKeyName(
        bytes32
    ) external pure returns (string memory) {
        revert MockRegistryDynamicModuleKeyRevert__AlwaysRevert();
    }

    function getNameHashToModuleKey(bytes32) external pure returns (bytes32) {
        return bytes32(0);
    }

    function getDynamicModuleKeyByIndex(
        uint256
    ) external pure returns (bytes32) {
        revert MockRegistryDynamicModuleKeyRevert__AlwaysRevert();
    }

    /*━━━━━━━━━━━━━━━ Admin Functions ━━━━━━━━━━━━━━━*/
    function getRegistrationAdmin() external pure returns (address) {
        return address(0);
    }

    function getSystemAdmin() external pure returns (address) {
        return address(0);
    }

    function setRegistrationAdmin(address) external pure {
        revert MockRegistryDynamicModuleKeyRevert__AlwaysRevert();
    }

    function setSystemAdmin(address) external pure {
        revert MockRegistryDynamicModuleKeyRevert__AlwaysRevert();
    }

    function pause() external pure {
        revert MockRegistryDynamicModuleKeyRevert__AlwaysRevert();
    }

    function unpause() external pure {
        revert MockRegistryDynamicModuleKeyRevert__AlwaysRevert();
    }
}
