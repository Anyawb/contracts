// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { ViewVersioned } from "../ViewVersioned.sol";
import { ILoanNFT } from "../../../interfaces/ILoanNFT.sol";
import { BatchTooLarge, MissingRole, NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";

/**
 * @title LoanNFTView
 * @notice Read-only view module for enumerating LoanNFTs owned by a user (0-gas queries).
 * @dev Motivation: frontends should enumerate a user's loans via LoanNFT (user -> tokenIds -> loanId/status)
 *      and then fetch order details by orderId via LendingEngineView.
 *
 * Reverts if:
 * - registry is zero / not a contract (ZeroAddress / NotAContract)
 * - caller lacks required role for a gated read (MissingRole)
 */
contract LoanNFTView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/

    /// @notice Reverts when a caller-provided `limit` parameter is invalid (e.g., zero).
    error LoanNFTView__InvalidLimit();

    /*━━━━━━━━━━━━━━━ Structs ━━━━━━━━━━━━━━━*/

    /// @notice Minimal per-token info for frontend enumeration.
    struct UserLoanNftItem {
        uint256 tokenId;
        uint256 orderId;
        ILoanNFT.LoanStatus status;
    }

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    /// @notice Registry contract address (internal use only).
    address private _registryAddr;

    uint256 private constant _MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /// @dev Scheme U: self-read allowed; non-self requires VIEW_USER_DATA or ADMIN.
    modifier onlyAuthorizedUser(address user) {
        if (
            msg.sender != user && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, msg.sender)
                && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)
        ) revert MissingRole();
        _;
    }

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the LoanNFTView (UUPS).
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (ZeroAddress)
     *      - initialRegistryAddr is not a contract (NotAContract)
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);

        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Read APIs ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get the number of LoanNFTs (loans) for a given user, with metadata.
     * @dev This is the preferred replacement for legacy `LendingEngineView.getUserLoanCount`.
     *
     * Security:
     * - Scheme U user-scoped read gate.
     */
    function getUserLoanCount(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedUser(user)
        returns (uint256 count, bool isValid, uint256 blockNumber)
    {
        count = _loanNftEnumerable().balanceOf(user);
        return (count, true, _now());
    }

    /**
     * @notice Get a user's LoanNFT tokenIds with pagination.
     * @param user Target user
     * @param offset 0-based offset into the user's token list
     * @param limit Max number of tokenIds to return (must be 1..MAX_BATCH_SIZE)
     */
    function getUserTokenIdsPaginated(address user, uint256 offset, uint256 limit)
        external
        view
        onlyValidRegistry
        onlyAuthorizedUser(user)
        returns (uint256[] memory tokenIds, uint256 totalCount, bool isValid, uint256 blockNumber)
    {
        _validateLimit(limit);
        totalCount = _loanNftEnumerable().balanceOf(user);
        if (offset >= totalCount) return (new uint256[](0), totalCount, true, _now());

        uint256 end = offset + limit;
        if (end > totalCount) end = totalCount;
        uint256 pageLen = end - offset;

        tokenIds = new uint256[](pageLen);
        for (uint256 i; i < pageLen; ) {
            tokenIds[i] = _loanNftEnumerable().tokenOfOwnerByIndex(user, offset + i);
            unchecked { ++i; }
        }
        return (tokenIds, totalCount, true, _now());
    }

    /**
     * @notice Enumerate a user's loans (LoanNFTs) as (tokenId, orderId, status) with pagination.
     * @dev Frontend path:
     *      1) Call this to get orderIds
     *      2) Call LendingEngineView.getLoanOrder(orderId) to fetch order details
     */
    function getUserLoansPaginated(address user, uint256 offset, uint256 limit)
        external
        view
        onlyValidRegistry
        onlyAuthorizedUser(user)
        returns (UserLoanNftItem[] memory items, uint256 totalCount, bool isValid, uint256 blockNumber)
    {
        _validateLimit(limit);
        totalCount = _loanNftEnumerable().balanceOf(user);
        if (offset >= totalCount) return (new UserLoanNftItem[](0), totalCount, true, _now());

        uint256 end = offset + limit;
        if (end > totalCount) end = totalCount;
        uint256 pageLen = end - offset;
        items = new UserLoanNftItem[](pageLen);

        ILoanNFT loanNft = _loanNft();
        for (uint256 i; i < pageLen; ) {
            uint256 tokenId = _loanNftEnumerable().tokenOfOwnerByIndex(user, offset + i);
            ILoanNFT.LoanMetadata memory meta = loanNft.getLoanMetadata(tokenId);
            items[i] = UserLoanNftItem({ tokenId: tokenId, orderId: meta.loanId, status: meta.status });
            unchecked { ++i; }
        }
        return (items, totalCount, true, _now());
    }

    /**
     * @notice Get the Registry contract address.
     * @dev This getter may return address(0) if the contract is not initialized.
     */
    function getRegistry() external view returns (address registryAddrVar) {
        return _registryAddr;
    }

    /**
     * @notice Get the Registry contract address (legacy getter).
     */
    function registryAddr() external view returns (address registryAddrVar) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/

    /// @dev View-only block helper for meta outputs (not used for state changes).
    function _now() internal view returns (uint256) {
        return block.number;
    }

    function _validateLimit(uint256 limit) internal pure {
        if (limit == 0) revert LoanNFTView__InvalidLimit();
        if (limit > _MAX_BATCH_SIZE) revert BatchTooLarge(limit, _MAX_BATCH_SIZE);
    }

    function _loanNft() internal view returns (ILoanNFT) {
        address loanNftAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LOAN_NFT);
        if (loanNftAddr.code.length == 0) revert NotAContract(loanNftAddr);
        return ILoanNFT(loanNftAddr);
    }

    function _loanNftEnumerable() internal view returns (IERC721EnumerableLike) {
        address loanNftAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LOAN_NFT);
        if (loanNftAddr.code.length == 0) revert NotAContract(loanNftAddr);
        return IERC721EnumerableLike(loanNftAddr);
    }

    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            revert MissingRole();
        }
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ Versioning (C+B baseline) ━━━━━━━━━━━━━━━*/

    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/

    uint256[50] private __gap;
}

/// @dev Minimal ERC721Enumerable surface for LoanNFT enumeration.
interface IERC721EnumerableLike {
    function balanceOf(address owner) external view returns (uint256);
    function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256);
}
