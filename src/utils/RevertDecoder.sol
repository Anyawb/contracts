// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title RevertDecoder
/// @notice 提供链上对常见 revert data 的解码能力，仅供调试 / 离线调用。
/// @dev 本库只是示例，实际解析可在前端或脚本完成，链上调用应谨慎，以免消耗过多 gas。
library RevertDecoder {
    bytes4 private constant ERROR_SELECTOR = 0x08c379a0; // Error(string)
    bytes4 private constant PANIC_SELECTOR = 0x4e487b71; // Panic(uint256)

    function decode(bytes memory data) public pure returns (string memory) {
        if (data.length < 4) return "Empty revert";
        bytes4 selector;
        assembly {
            selector := mload(add(data, 32))
        }
        if (selector == ERROR_SELECTOR) {
            // Skip selector and offset
            string memory reason;
            assembly {
                // data layout: selector (4) + offset (32) + string length (32) + string data
                reason := add(data, 68) // 4+32+32 = 68
            }
            return reason;
        }
        if (selector == PANIC_SELECTOR) {
            return "Panic error";
        }
        // default: custom error selector
        return "Custom/Error selector";
    }
} 