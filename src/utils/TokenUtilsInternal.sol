// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC1155 } from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import { AmountIsZero, AmountMismatch, ZeroAddress } from "../errors/StandardErrors.sol";

/**
 * @title TokenUtilsInternal
 * @notice Stateless token transfer helpers (ERC20/ERC721/ERC1155) and delta checks.
 * @dev Security:
 * - Library performs external token calls; callers must ensure approvals and permissions.
 * - ERC165 probing uses staticcall and is best-effort.
 */
library TokenUtilsInternal {
    using SafeERC20 for IERC20;

    /* -------------------------- Constants -------------------------- */
    bytes4 private constant _ERC721_INTERFACE_ID = 0x80ac58cd;
    bytes4 private constant _ERC1155_INTERFACE_ID = 0xd9b67a26;

    /**
     * @notice Snapshot this contract's ERC20 balance for a token.
     * @dev Reverts if:
     *      - IERC20.balanceOf call fails (propagates)
     *
     * Security:
     * - View-only external call to token.
     *
     * @param token ERC20 token interface.
     * @return balance Balance of address(this).
     */
    function _balanceOf(IERC20 token) internal view returns (uint256 balance) {
        return token.balanceOf(address(this));
    }

    /**
     * @notice Pre-validate that an expected amount is non-zero.
     * @dev Reverts if:
     *      - expectedAmount == 0 (AmountIsZero)
     *
     * Security:
     * - Pure validation only.
     *
     * @param expectedAmount Expected amount (token decimals).
     * @return validated Same value for convenient inlining.
     */
    function preValidateAmount(uint256 expectedAmount) internal pure returns (uint256 validated) {
        if (expectedAmount == 0) revert AmountIsZero();
        return expectedAmount;
    }

    /**
     * @notice Verify that an ERC20 transfer resulted in an exact expected delta.
     * @dev Reverts if:
     *      - actualAmount != expectedAmount (AmountMismatch)
     *      - IERC20.balanceOf calls fail (propagates)
     *
     * Security:
     * - View-only external calls to token.
     *
     * @param beforeBalance Balance snapshot before the transfer (token decimals).
     * @param token ERC20 token interface.
     * @param expectedAmount Expected amount received (token decimals).
     */
    function verifyTransferResult(
        uint256 beforeBalance,
        IERC20 token,
        uint256 expectedAmount
    ) internal view {
        uint256 afterBalance = token.balanceOf(address(this));
        uint256 actualAmount = afterBalance - beforeBalance;
        if (actualAmount != expectedAmount) revert AmountMismatch();
    }

    /**
     * @notice Pull tokens (ERC20/ERC721/ERC1155) into this contract.
     * @dev Reverts if:
     *      - token == address(0) or from == address(0) (ZeroAddress)
     *      - amount == 0 (AmountIsZero)
     *      - underlying token transfer fails (propagates)
     *
     * Security:
     * - Performs external token calls (safeTransferFrom / safeTransferFrom / SafeERC20.safeTransferFrom).
     * - ERC165 probing is best-effort and may misclassify non-ERC165 tokens as ERC20.
     *
     * @param token Token contract address.
     * @param from Sender address to pull from.
     * @param id Token id (ERC721/ERC1155); ignored for ERC20.
     * @param amount Amount (ERC20/ERC1155 token decimals). For ERC721, pass 1 as a placeholder.
     */
    function _pullTokenUniversal(
        address token,
        address from,
        uint256 id,
        uint256 amount
    ) internal {
        if (token == address(0) || from == address(0)) revert ZeroAddress();

        // Amount validation (for ERC721, pass 1 as a placeholder).
        preValidateAmount(amount);

        if (_supportsInterface(token, _ERC721_INTERFACE_ID)) {
            // ERC721: ignore amount, transfer token id.
            IERC721(token).safeTransferFrom(from, address(this), id);
        } else if (_supportsInterface(token, _ERC1155_INTERFACE_ID)) {
            // ERC1155
            IERC1155(token).safeTransferFrom(from, address(this), id, amount, "");
        } else {
            // Default to ERC20 path (incl. some non-ERC165 implementations).
            IERC20(token).safeTransferFrom(from, address(this), amount);
        }
    }

    /**
     * @notice Return ERC20 balance delta for an account.
     * @dev Reverts if:
     *      - afterBalance < beforeBalance (Solidity ^0.8.x underflow)
     *      - IERC20.balanceOf call fails (propagates)
     *
     * Security:
     * - View-only external call to token.
     *
     * @param token ERC20 token address.
     * @param account Account address.
     * @param beforeBalance Balance snapshot before (token decimals).
     * @return delta afterBalance - beforeBalance.
     */
    function _getBalanceDelta(
        address token,
        address account,
        uint256 beforeBalance
    ) internal view returns (uint256 delta) {
        uint256 afterBalance = IERC20(token).balanceOf(account);
        return afterBalance - beforeBalance;
    }

    /**
     * @notice Best-effort ERC165 interface check.
     * @dev Reverts if:
     *      - none (returns false on failure)
     *
     * Security:
     * - Uses staticcall to the token; failures are treated as "unsupported".
     *
     * @param token Token contract address.
     * @param interfaceId ERC165 interface id.
     * @return supported True if supportsInterface(interfaceId) returns true.
     */
    function _supportsInterface(address token, bytes4 interfaceId) private view returns (bool supported) {
        (bool success, bytes memory result) = token.staticcall(
            abi.encodeWithSelector(IERC165.supportsInterface.selector, interfaceId)
        );
        return (success && result.length >= 32 && abi.decode(result, (bool)));
    }
}

