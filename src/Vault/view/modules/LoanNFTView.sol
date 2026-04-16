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
import { IOrderStateStoreV2 } from "../../../interfaces/IOrderStateStoreV2.sol";
import { BatchTooLarge, MissingRole, NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";

/**
 * @title LoanNFTView
 * @notice View module for enumerating LoanNFTs owned by a user through view-only queries.
 * @dev Motivation: frontends should enumerate a user's loans via LoanNFT (user -> tokenIds -> loanId/status)
 *      and then fetch order-centric details via LendingEngineView.
 *
 *      Architecture-Guide alignment:
 *      - This module stays in the View layer and only exposes user-scoped enumeration.
 *      - The returned `status` field is a read-only snapshot of the LoanNFT lifecycle SSOT.
 *      - Business lifecycle transitions are still written by ORDER_ENGINE / SettlementManager,
 *        not by this module.
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

    /// @notice Minimal per-token info for frontend enumeration, including lifecycle status snapshot.
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
    * @notice Return the number of LoanNFTs held by a user, together with metadata.
    * @dev This is the preferred replacement for legacy `LendingEngineView.getUserLoanCount`.
    *      Use this module for user -> token/order enumeration, and use LendingEngineView for
    *      order-centric reads such as `getLoanOrder(...)` / `getOrderStatus(orderId)`.
     *
    * Security:
    * - Scheme U user-scoped read gate.
    * - View-only.

    * @param user Target user address.
    * @return count Number of LoanNFTs currently owned by the user.
    * @return isValid True if the read succeeded.
    * @return blockNumber Read block number.
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
    * @notice Return a user's LoanNFT tokenIds with pagination.
    * @dev Reverts if:
    *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
    *      - caller is not authorized for `user` (MissingRole via onlyAuthorizedUser)
    *      - limit is zero (LoanNFTView__InvalidLimit)
    *      - limit exceeds `_MAX_BATCH_SIZE` (BatchTooLarge)
    *
    * Security:
    * - Scheme U user-scoped read gate.
    * - View-only.
    *
    * @param user Target user address.
    * @param offset Zero-based offset into the user's token list.
    * @param limit Maximum number of tokenIds to return.
    * @return tokenIds Token ids in the requested page.
    * @return totalCount Total token count for the user.
    * @return isValid True if the read succeeded.
    * @return blockNumber Read block number.
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
    * @notice Return a user's loans as paginated LoanNFT items.
    * @dev Reverts if:
    *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
    *      - caller is not authorized for `user` (MissingRole via onlyAuthorizedUser)
    *      - limit is zero (LoanNFTView__InvalidLimit)
    *      - limit exceeds `_MAX_BATCH_SIZE` (BatchTooLarge)
    *
    *      Each item includes the current LoanNFT-backed lifecycle status snapshot so user-scoped UIs
    *      do not need to infer coarse order state from unrelated accounting fields.
    *
    * Security:
    * - Scheme U user-scoped read gate.
    * - View-only.
    *
    * @param user Target user address.
    * @param offset Zero-based offset into the user's token list.
    * @param limit Maximum number of items to return.
    * @return items LoanNFT items for the requested page.
    * @return totalCount Total token count for the user.
    * @return isValid True if the read succeeded.
    * @return blockNumber Read block number.
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
        (IOrderStateStoreV2 orderStateStore, bool hasOrderStateStore) = _tryOrderStateStore();
        for (uint256 i; i < pageLen; ) {
            uint256 tokenId = _loanNftEnumerable().tokenOfOwnerByIndex(user, offset + i);
            ILoanNFT.LoanMetadata memory meta = loanNft.getLoanMetadata(tokenId);
            ILoanNFT.LoanStatus status = meta.status;
            if (
                hasOrderStateStore
                    && orderStateStore.hasOrderState(IOrderStateStoreV2.OrderProductType.LOAN, meta.loanId)
            ) {
                status = orderStateStore.getLegacyLoanStatus(meta.loanId);
            }
            items[i] = UserLoanNftItem({ tokenId: tokenId, orderId: meta.loanId, status: status });
            unchecked { ++i; }
        }
        return (items, totalCount, true, _now());
    }

    /**
     * @notice Return the Registry address used by this module.
     * @dev This getter may return address(0) if the contract is not initialized.
     *
     * Security:
     * - View-only.
     *
     * @return registryAddrVar Registry contract address.
     */
    function getRegistry() external view returns (address registryAddrVar) {
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

    function _tryOrderStateStore() internal view returns (IOrderStateStoreV2 orderStateStore, bool hasStore) {
        address orderStateStoreAddr = Registry(_registryAddr).getModule(ModuleKeys.KEY_ORDER_STATE_STORE);
        if (orderStateStoreAddr == address(0) || orderStateStoreAddr.code.length == 0) {
            return (IOrderStateStoreV2(address(0)), false);
        }

        return (IOrderStateStoreV2(orderStateStoreAddr), true);
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
