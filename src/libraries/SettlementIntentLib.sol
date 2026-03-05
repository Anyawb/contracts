// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/**
 * @title SettlementIntentLib
 * @notice Lightweight library for EIP-712 hashing, signature validation, and intent state checks (borrow/lend).
 * @dev Reverts if:
 *      - (none; see per-function notes)
 *
 * Security:
 * - Stateless library; does not mutate state except via provided storage mappings.
 */
library SettlementIntentLib {
    /*━━━━━━━━━━━━━━━ STRUCTS ━━━━━━━━━━━━━━━*/
    // NOTE: Field order is EIP-712 canonical and MUST match the type string in `hashBorrowIntent`.
    struct BorrowIntent {
        address borrower;
        address collateralAsset;
        uint256 collateralAmount;
        address borrowAsset;
        uint256 amount;
        uint16 termDays;
        uint256 rateBps;
        /// @dev Legacy field name. Semantics: **expireBlock** (block.number), not unix time.
        uint256 expireAt;
        bytes32 salt;
    }

    // NOTE (Time-Dependency-Refactor / blocks-term intent):
    // - `termDays` is legacy and is treated as a bucket id in the legacy intent.
    // - This intent uses `termBlocks` as the SSOT duration input (block.number axis), provided fully off-chain.
    // - Field order is EIP-712 canonical and MUST match the type string in `hashBorrowIntentBlocks`.
    struct BorrowIntentBlocks {
        address borrower;
        address collateralAsset;
        uint256 collateralAmount;
        address borrowAsset;
        uint256 amount;
        uint256 termBlocks;
        uint256 rateBps;
        /// @dev Legacy field name kept for signing compatibility. Semantics: **expireBlock** (block.number).
        uint256 expireAt;
        bytes32 salt;
    }

    // NOTE: Field order is EIP-712 canonical and MUST match the type string in `hashLendIntent`.
    struct LendIntent {
        /**
         * @notice Lender intent signer (EOA / ERC-1271 smart wallet).
         * @dev This is the match authorizer / fund owner, and is NOT the same as `LoanOrder.lender`
         *      (which may be a pool vault address depending on the architecture variant).
         */
        address lenderSigner;
        address asset;
        uint256 amount;
        uint16 minTermDays;
        uint16 maxTermDays;
        uint256 minRateBps;
        /// @dev Legacy field name. Semantics: **expireBlock** (block.number), not unix time.
        uint256 expireAt;
        bytes32 salt;
    }

    // NOTE (Time-Dependency-Refactor / blocks-term intent):
    // - Uses explicit blocks-based bounds, and avoids any on-chain "days <-> blocks" conversion.
    // - Field order is EIP-712 canonical and MUST match the type string in `hashLendIntentBlocks`.
    struct LendIntentBlocks {
        address lenderSigner;
        address asset;
        uint256 amount;
        uint256 minTermBlocks;
        uint256 maxTermBlocks;
        uint256 minRateBps;
        /// @dev Legacy field name kept for signing compatibility. Semantics: **expireBlock** (block.number).
        uint256 expireAt;
        bytes32 salt;
    }

    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/
    /// @notice Thrown when an intent has expired (block.number > expireAt).
    error SettlementIntentLib__IntentExpired();
    /// @notice Thrown when an intent hash is already marked as matched.
    error SettlementIntentLib__AlreadyMatched();
    /// @notice Thrown when a provided signature is invalid for the expected signer/digest.
    error SettlementIntentLib__InvalidSignature();

    /*━━━━━━━━━━━━━━━ API ━━━━━━━━━━━━━━━*/
    /**
     * @notice Compute the EIP-712 struct hash for a BorrowIntent.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function; does not validate intent semantics (e.g., expiration).
     *
     * @param bi Borrow intent payload.
     * @return structHash EIP-712 struct hash for BorrowIntent.
     */
    function hashBorrowIntent(BorrowIntent memory bi) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            keccak256(
                "BorrowIntent(address borrower,address collateralAsset,uint256 collateralAmount,address borrowAsset,"
                "uint256 amount,uint16 termDays,uint256 rateBps,uint256 expireAt,bytes32 salt)"
            ),
            bi.borrower,
            bi.collateralAsset,
            bi.collateralAmount,
            bi.borrowAsset,
            bi.amount,
            bi.termDays,
            bi.rateBps,
            bi.expireAt,
            bi.salt
        ));
    }

    /**
     * @notice Compute the EIP-712 struct hash for a BorrowIntentBlocks (termBlocks SSOT).
     * @dev Reverts if: (none)
     *
     * @param bi Borrow intent (blocks-term) payload.
     * @return structHash EIP-712 struct hash for BorrowIntentBlocks.
     */
    function hashBorrowIntentBlocks(BorrowIntentBlocks memory bi) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            keccak256(
                "BorrowIntentBlocks(address borrower,address collateralAsset,uint256 collateralAmount,address borrowAsset,"
                "uint256 amount,uint256 termBlocks,uint256 rateBps,uint256 expireAt,bytes32 salt)"
            ),
            bi.borrower,
            bi.collateralAsset,
            bi.collateralAmount,
            bi.borrowAsset,
            bi.amount,
            bi.termBlocks,
            bi.rateBps,
            bi.expireAt,
            bi.salt
        ));
    }

    /**
     * @notice Compute the EIP-712 struct hash for a LendIntent.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function; does not validate intent semantics (e.g., expiration).
     *
     * @param li Lend intent payload.
     * @return structHash EIP-712 struct hash for LendIntent.
     */
    function hashLendIntent(LendIntent memory li) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            keccak256(
                "LendIntent(address lenderSigner,address asset,uint256 amount,uint16 minTermDays,"
                "uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)"
            ),
            li.lenderSigner,
            li.asset,
            li.amount,
            li.minTermDays,
            li.maxTermDays,
            li.minRateBps,
            li.expireAt,
            li.salt
        ));
    }

    /**
     * @notice Compute the EIP-712 struct hash for a LendIntentBlocks (termBlocks bounds).
     * @dev Reverts if: (none)
     *
     * @param li Lend intent (blocks-term) payload.
     * @return structHash EIP-712 struct hash for LendIntentBlocks.
     */
    function hashLendIntentBlocks(LendIntentBlocks memory li) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            keccak256(
                "LendIntentBlocks(address lenderSigner,address asset,uint256 amount,uint256 minTermBlocks,"
                "uint256 maxTermBlocks,uint256 minRateBps,uint256 expireAt,bytes32 salt)"
            ),
            li.lenderSigner,
            li.asset,
            li.amount,
            li.minTermBlocks,
            li.maxTermBlocks,
            li.minRateBps,
            li.expireAt,
            li.salt
        ));
    }

    /**
     * @notice Build an EIP-712 domain separator.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function; caller is responsible for supplying the correct chainId and verifyingContract.
     *
     * @param name EIP-712 domain name.
     * @param version EIP-712 domain version.
     * @param chainId Chain id used for domain separation.
     * @param verifyingContract Verifying contract address used for domain separation.
     * @return domainSeparator EIP-712 domain separator.
     */
    function buildDomainSeparator(
        string memory name,
        string memory version,
        uint256 chainId,
        address verifyingContract
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifyingContract
            )
        );
    }

    /**
     * @notice Compute the EIP-712 typed data digest for signing/verification.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function.
     *
     * @param domainSeparator EIP-712 domain separator.
     * @param structHash EIP-712 struct hash (e.g., from hashBorrowIntent/hashLendIntent).
     * @return digest EIP-712 typed data digest.
     */
    function toTypedDataHash(bytes32 domainSeparator, bytes32 structHash) internal pure returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
    }

    /**
     * @notice Verify an EOA signature or an ERC-1271 contract wallet signature.
     * @dev Reverts if:
     *      - (none) (returns false on failure)
     *
     * Security:
     * - Calls into `signer` if it is a contract (ERC-1271); signer MUST be trusted for potential reverts.
     *
     * @param signer Expected signer address (EOA or ERC-1271 contract).
     * @param digest EIP-712 typed data digest.
     * @param signature Signature bytes.
     * @return valid True if signature is valid for signer/digest.
     */
    function verifySignature(
        address signer,
        bytes32 digest,
        bytes memory signature
    ) internal view returns (bool) {
        if (signer == address(0)) return false;
        if (_isContract(signer)) {
            return IERC1271(signer).isValidSignature(digest, signature) == 0x1626ba7e;
        }
        return ECDSA.recover(digest, signature) == signer;
    }

    /**
     * @notice Returns whether an address is a contract.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Uses `account.code.length` (EVM semantics).
     *
     * @param account Address to check.
     * @return isContract_ True if `account` has code.
     */
    function _isContract(address account) private view returns (bool isContract_) {
        return account.code.length > 0;
    }

    /**
     * @notice Validate an intent is open (not expired and not yet matched).
     * @dev Reverts if:
     *      - block.number > expireAt (SettlementIntentLib__IntentExpired)
     *      - matched[intentHash] is true (SettlementIntentLib__AlreadyMatched)
     *
     * Security:
     * - Time-Dependency-Refactor SSOT: expiry windows are block-based; do NOT use time-in-seconds.
     *
     * @param matched Mapping of intentHash => matched flag (storage).
     * @param intentHash Intent hash identifier.
     * @param expireAt Expiration block (block.number). Legacy name kept for EIP-712 compatibility.
     */
    function validateOpen(
        mapping(bytes32 => bool) storage matched,
        bytes32 intentHash,
        uint256 expireAt
    ) internal view {
        if (block.number > expireAt) revert SettlementIntentLib__IntentExpired();
        if (matched[intentHash]) revert SettlementIntentLib__AlreadyMatched();
    }

    /**
     * @notice Mark an intent hash as matched.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Storage-only.
     *
     * @param matched Mapping of intentHash => matched flag (storage).
     * @param intentHash Intent hash identifier.
     */
    function markMatched(
        mapping(bytes32 => bool) storage matched,
        bytes32 intentHash
    ) internal {
        matched[intentHash] = true;
    }
}


