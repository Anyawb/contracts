// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title ReentrancyGuardSlimUpgradeable
/// @notice Upgrade-safe reentrancy guard without OZ's unreachable-code warning under viaIR.
/// @dev Storage layout compatible with OZ v5 ReentrancyGuardUpgradeable by reusing the same ERC-7201 slot.
abstract contract ReentrancyGuardSlimUpgradeable is Initializable {
    // Same semantics as OZ:
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    error ReentrancyGuardReentrantCall();

    /// @custom:storage-location erc7201:openzeppelin.storage.ReentrancyGuard
    struct ReentrancyGuardStorage {
        uint256 _status;
    }

    // Exact value from OZ v5.1.0 ReentrancyGuardUpgradeable:
    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.ReentrancyGuard")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ReentrancyGuardStorageLocation =
        0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00;

    function _getReentrancyGuardStorage() private pure returns (ReentrancyGuardStorage storage $) {
        assembly {
            $.slot := ReentrancyGuardStorageLocation
        }
    }

    function __ReentrancyGuardSlim_init() internal onlyInitializing {
        ReentrancyGuardStorage storage $ = _getReentrancyGuardStorage();
        $._status = NOT_ENTERED;
    }

    function _reentrancyGuardEnter() internal {
        ReentrancyGuardStorage storage $ = _getReentrancyGuardStorage();
        if ($._status == ENTERED) revert ReentrancyGuardReentrantCall();
        $._status = ENTERED;
    }

    function _reentrancyGuardExit() internal {
        ReentrancyGuardStorage storage $ = _getReentrancyGuardStorage();
        $._status = NOT_ENTERED;
    }

    function _reentrancyGuardEntered() internal view returns (bool) {
        ReentrancyGuardStorage storage $ = _getReentrancyGuardStorage();
        return $._status == ENTERED;
    }

    // leave space for future vars in inheritors (pattern parity)
    uint256[49] private __gap;
}

