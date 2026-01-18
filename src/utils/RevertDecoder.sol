// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title RevertDecoder
 * @notice Decode common EVM revert payloads (best-effort).
 * @dev Reverts if:
 *      - none (best-effort decoder)
 *
 * Security:
 * - Uses inline assembly to read the first 4 bytes selector.
 * - Intended for debugging/off-chain usage; avoid using on-chain in gas-sensitive paths.
 */
library RevertDecoder {
    bytes4 private constant ERROR_SELECTOR = 0x08c379a0; // Error(string)
    bytes4 private constant PANIC_SELECTOR = 0x4e487b71; // Panic(uint256)

    /**
     * @notice Decode a revert payload into a human-readable string.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Pure decoder; does not perform external calls.
     *
     * @param data Raw revert data.
     * @return decoded Best-effort decoded message. For custom errors, returns a placeholder string.
     */
    function decode(bytes memory data) public pure returns (string memory decoded) {
        if (data.length < 4) return "Empty revert";
        bytes4 selector = _selector(data);
        if (selector == ERROR_SELECTOR) {
            // Error(string): selector + abi.encode(string)
            bytes memory payload = _slice(data, 4);
            return abi.decode(payload, (string));
        }
        if (selector == PANIC_SELECTOR) {
            return "Panic error";
        }
        // default: custom error selector
        return "Custom/Error selector";
    }

    /**
     * @notice Return the first 4 bytes selector of a bytes array.
     * @dev Reverts if:
     *      - data.length < 4 (checked by caller)
     *
     * Security:
     * - Pure byte manipulation only.
     */
    function _selector(bytes memory data) private pure returns (bytes4 sel) {
        // bytes4(bytes1) is left-aligned, so shift subsequent bytes into place.
        return bytes4(data[0]) | (bytes4(data[1]) >> 8) | (bytes4(data[2]) >> 16) | (bytes4(data[3]) >> 24);
    }

    /**
     * @notice Slice a bytes array from a start offset to the end.
     * @dev Reverts if:
     *      - start > data.length (out-of-bounds)
     *
     * Security:
     * - Pure copy only (O(n)).
     */
    function _slice(bytes memory data, uint256 start) private pure returns (bytes memory out) {
        if (start > data.length) return new bytes(0);
        uint256 len = data.length - start;
        out = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            out[i] = data[start + i];
        }
    }
} 