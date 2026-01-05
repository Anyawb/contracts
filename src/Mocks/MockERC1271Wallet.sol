// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @title MockERC1271Wallet
/// @notice Test-only ERC-1271 wallet with configurable behavior.
/// @dev This is intentionally permissive to simulate "bad wallets" and edge-cases.
contract MockERC1271Wallet is IERC1271, IERC721Receiver {
    bytes4 internal constant MAGICVALUE = 0x1626ba7e;

    enum Mode {
        AlwaysValid,
        AlwaysInvalid,
        Revert,
        ValidOnlyForDigest
    }

    Mode public mode;
    bytes32 public allowedDigest;

    event ModeSet(Mode mode);
    event AllowedDigestSet(bytes32 digest);

    constructor(Mode initialMode) {
        mode = initialMode;
        emit ModeSet(initialMode);
    }

    function setMode(Mode m) external {
        mode = m;
        emit ModeSet(m);
    }

    function setAllowedDigest(bytes32 d) external {
        allowedDigest = d;
        emit AllowedDigestSet(d);
    }

    /// @notice Minimal "wallet" exec to interact as this contract.
    /// @dev Anyone can call this in tests; do NOT use in production.
    function exec(address to, uint256 value, bytes calldata data) external returns (bytes memory ret) {
        (bool ok, bytes memory out) = to.call{ value: value }(data);
        require(ok, "MockERC1271Wallet: exec failed");
        return out;
    }

    receive() external payable {}

    function isValidSignature(bytes32 hash, bytes memory /*signature*/ ) external view override returns (bytes4) {
        if (mode == Mode.Revert) revert("MockERC1271Wallet: reverted");
        if (mode == Mode.AlwaysInvalid) return bytes4(0xffffffff);
        if (mode == Mode.ValidOnlyForDigest) return hash == allowedDigest ? MAGICVALUE : bytes4(0xffffffff);
        // AlwaysValid
        return MAGICVALUE;
    }

    /// @notice Allow receiving ERC721 via safeMint/safeTransfer.
    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

