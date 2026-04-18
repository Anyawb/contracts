// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILoanNFT
 * @notice Interface for the loan certificate ERC-721 NFT (optionally lockable as SBT).
 * @dev Reverts if:
 *      - implementation-defined access control fails (role-gated / onlyModule)
 *
 * Security:
 * - Role-gated in the implementation (typically via Registry-resolved ACM)
 * - SBT lock must prevent user-to-user transfers (mint/burn allowed)
 */
interface ILoanNFT {
    /*━━━━━━━━━━━━━━━ ENUMS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Loan lifecycle status reflected by the NFT.
     * @dev Semantics:
     * - Active: loan is ongoing
     * - Repaid: loan is fully repaid
     * - Liquidated: loan was liquidated
     * - Defaulted: loan is in default
     *
     * Architecture-Guide alignment:
     * - This enum is the coarse business lifecycle SSOT consumed by view-layer readers.
     * - View modules may expose it, but must not own lifecycle transitions.
     */
    enum LoanStatus {
        Active,
        Repaid,
        Liquidated,
        Defaulted,
        LiquidatedWithShortfall,
        DefaultedWithShortfall
    }

    /*━━━━━━━━━━━━━━━ STRUCTS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Immutable loan snapshot at mint time, except `status` which may be updated by an authorized module.
     * @dev Units / conventions:
     * - `principal`: token decimals of the underlying debt asset (implementation-defined)
     * - `rate`: annualized rate in bps (\(1e4 = 100%\))
     * - `term`: seconds
     * - `oraclePrice`: implementation-defined oracle precision
     */
    struct LoanMetadata {
        uint256 principal;
        uint256 rate;
        uint256 term;
        uint256 oraclePrice;
        uint256 loanId;
        bytes32 collateralHash;
        LoanStatus status;
    }

    /*━━━━━━━━━━━━━━━ EVENTS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Emitted when a loan certificate NFT is minted.
     * @dev Security:
     * - Event-only; consumers must treat ORDER_ENGINE / LoanNFT implementation as SSOT.
     *
     * @param to Recipient address
     * @param tokenId Minted token id
     * @param loanId Order/loan id in the lending engine (implementation-defined)
     * @param principal Principal amount (token decimals)
     * @param rate Annualized rate (bps)
     * @param term Term length (seconds)
     */
    event LoanCertificateMinted(
        address indexed to,
        uint256 indexed tokenId,
        uint256 loanId,
        uint256 principal,
        uint256 rate,
        uint256 term
    );

    /**
     * @notice Emitted when a token is locked as SBT (non-transferable between users).
     * @dev Security:
     * - Event-only; transfer restrictions must be enforced in implementation.
     *
     * @param tokenId Token id
     */
    event TokenLocked(uint256 indexed tokenId);

    /**
     * @notice Emitted when a token is burned.
     * @dev Security:
     * - Event-only; burn authorization is enforced in implementation.
     *
     * @param tokenId Token id
     */
    event TokenBurned(uint256 indexed tokenId);

    /**
     * @notice Emitted when loan status is updated for a token.
     * @dev Security:
     * - Event-only; status authorization is enforced in implementation.
     *
     * @param tokenId Token id
     * @param newStatus New status
     */
    event LoanStatusUpdated(uint256 indexed tokenId, LoanStatus newStatus);

    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/

    /// @dev Reverts when the caller is not authorized to perform the action.
    error LoanNFT__NotAuthorized();

    /// @dev Reverts when a token locked as SBT is transferred between users.
    /// @param tokenId Token id.
    error LoanNFT__SoulBound(uint256 tokenId);

    /// @dev Reverts when the referenced token id does not exist.
    error LoanNFT__InvalidTokenId();

    /// @dev Reverts when the loan or order id was already minted.
    /// @param loanId Loan or order id.
    error LoanNFT__LoanAlreadyMinted(uint256 loanId);

    /*━━━━━━━━━━━━━━━ EXTERNAL API ━━━━━━━━━━━━━━━*/

    /**
     * @notice Mint a loan certificate NFT.
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined)
     *      - `to` is zero (implementation-defined)
     *      - `data.loanId` was already minted (`LoanNFT__LoanAlreadyMinted`)
     *
     * Security:
     * - Role-gated in implementation
     *
     * @param to Recipient address (typically the borrower)
     * @param data Loan metadata snapshot (see struct-level units)
     * @return tokenId Newly minted token id
     */
    function mintLoanCertificate(
        address to,
        LoanMetadata calldata data
    ) external returns (uint256 tokenId);

    /**
     * @notice Permanently lock a token as SBT (non-transferable between users).
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined)
     *      - `tokenId` does not exist (`LoanNFT__InvalidTokenId`)
     *
     * Security:
     * - Role-gated in implementation
     *
     * @param tokenId Token id
     */
    function lockAsSBT(uint256 tokenId) external;

    /**
     * @notice Burn a loan certificate token.
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined)
     *      - `tokenId` does not exist (`LoanNFT__InvalidTokenId`)
     *
     * Security:
     * - Role-gated in implementation
     */
    function burn(uint256 tokenId) external;

    /**
     * @notice Update loan status for a token (e.g. Repaid/Liquidated/Defaulted).
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined)
     *      - `tokenId` does not exist (`LoanNFT__InvalidTokenId`)
     *
     * Security:
     * - Role-gated in implementation
     */
    function updateLoanStatus(uint256 tokenId, LoanStatus newStatus) external;

    /**
     * @notice Get all token ids owned by `user`.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View only
     *
     * @param user Owner address
     * @return tokenIds Array of token ids owned by `user`
     */
    function getUserTokens(
        address user
    ) external view returns (uint256[] memory tokenIds);

    /**
     * @notice Get loan metadata for a token id.
     * @dev Reverts if:
     *      - `tokenId` does not exist (`LoanNFT__InvalidTokenId`)
     *
     * Security:
     * - View only
     *
     * @param tokenId Token id
     * @return metadata Loan metadata snapshot
     */
    function getLoanMetadata(
        uint256 tokenId
    ) external view returns (LoanMetadata memory metadata);

    /**
     * @notice Get minimal loan identity and lifecycle status for a token id.
     * @dev Reverts if:
     *      - `tokenId` does not exist (`LoanNFT__InvalidTokenId`)
     *
     * Security:
     * - View only.
     * - This method is layout-stable and intended for cross-module status reads.
     *
     * @param tokenId Token id.
     * @return loanId Loan/order id bound to this token.
     * @return status Current coarse lifecycle status.
     */
    function getLoanIdentity(
        uint256 tokenId
    ) external view returns (uint256 loanId, LoanStatus status);

    /*━━━━━━━━━━━━━━━ RESERVED FOR FUTURE UPGRADE ━━━━━━━━━━━━━━━*/
    // /**
    //  * @notice Batch mint loan certificate NFTs (e.g. for bundled issuance).
    //  * @dev Reverts if:
    //  *      - caller is not authorized (implementation-defined)
    //  *      - input arrays are inconsistent (implementation-defined)
    //  *
    //  * Security:
    //  * - Role-gated in implementation
    //  */
    // function batchMintLoanCertificate(address[] calldata to, LoanMetadata[] calldata data) external;
}
