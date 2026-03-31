// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal placeholder contract that reverts with raw bytes("rewardView unavailable") on any call.
/// @dev Used by localhost/protocol E2E to simulate a bound-but-unavailable RewardView now that Registry rejects zero addresses.
contract MockRewardViewUnavailable {
    fallback() external payable {
        bytes memory reason = bytes("rewardView unavailable");
        assembly {
            revert(add(reason, 0x20), mload(reason))
        }
    }
}