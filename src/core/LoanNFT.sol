// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
// solhint-disable-next-line max-line-length
import {ERC721EnumerableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721EnumerableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

import {ActionKeys} from "../constants/ActionKeys.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {SystemEvents} from "../Vault/SystemEvents.sol";
import {ILoanNFT} from "../interfaces/ILoanNFT.sol";
import {IRegistry} from "../interfaces/IRegistry.sol";
import {IAccessControlManager} from "../interfaces/IAccessControlManager.sol";
import {NotAContract, ZeroAddress} from "../errors/StandardErrors.sol";
import {DataPushLibrary} from "../libraries/DataPushLibrary.sol";
import {DataPushTypes} from "../constants/DataPushTypes.sol";

/**
 * @title LoanNFT
 * @notice ERC-721 loan certificate NFT, optionally lockable as a Soulbound Token (SBT).
 * @dev Reverts if:
 *      - the Registry address is not set (see `onlyValidRegistry`)
 *      - AccessControlManager rejects the caller for the required action key (resolved via Registry)
 *
 * Security:
 * - Role-gated via Registry-resolved AccessControlManager (ModuleKeys.KEY_ACCESS_CONTROL)
 * - Pausable for sensitive flows
 * - ReentrancyGuard on minting flow
 * - UUPS upgrade authorization is role-gated
 */
contract LoanNFT is
    Initializable,
    ERC721Upgradeable,
    ERC721EnumerableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    ILoanNFT
{
    /*━━━━━━━━━━━━━━━ ROLES ━━━━━━━━━━━━━━━*/

    /**
     * @notice Action key used to gate minting-related operations.
     * @dev Maps to `ActionKeys.ACTION_BORROW`.
     */
    bytes32 public constant MINTER_ROLE_VAR = ActionKeys.ACTION_BORROW;

    /**
     * @notice Action key used to gate governance/admin operations.
     * @dev Maps to `ActionKeys.ACTION_SET_PARAMETER`.
     */
    bytes32 public constant GOVERNANCE_ROLE_VAR =
        ActionKeys.ACTION_SET_PARAMETER;

    /*━━━━━━━━━━━━━━━ STATE ━━━━━━━━━━━━━━━*/

    /**
     * @notice Next token id to be minted.
     */
    uint256 private _nextTokenId;

    /**
     * @notice Registry address (SSOT for module address resolution).
     * @dev Used to resolve AccessControlManager via `ModuleKeys.KEY_ACCESS_CONTROL`.
     */
    address private _registryAddr;

    /**
     * @notice Loan metadata by token id.
     */
    mapping(uint256 tokenId => LoanMetadata) private _loanMetadata;

    /**
     * @notice SBT lock flag by token id.
     * @dev When true, transfers between non-zero addresses are blocked (mint/burn are allowed).
     */
    mapping(uint256 tokenId => bool) private _soulBound;

    /**
     * @notice One-time mint guard by loan id.
     */
    mapping(uint256 loanId => bool) private _loanMinted;

    /**
     * @notice Base token URI (reserved for future usage).
     */
    string private _baseTokenURI;

    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Legacy / internal error for non-minter callers (not used by current role-gated flow).
     */
    error LoanNFT__NotMinter();

    /**
     * @notice Invalid loan/order input.
     */
    error LoanNFT__InvalidOrder();

    /**
     * @notice Invalid upgrade implementation (no code at target).
     */
    error LoanNFT__InvalidImplementation();

    // Data push type constants live in `DataPushTypes`.

    /*━━━━━━━━━━━━━━━ MODIFIERS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Ensures the Registry address is configured.
     * @dev Reverts with `ZeroAddress()` if `_registryAddr` is zero.
     */
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /*━━━━━━━━━━━━━━━ INITIALIZER ━━━━━━━━━━━━━━━*/

    /**
     * @notice Initialize the upgradeable LoanNFT contract.
     * @dev Reverts if:
     *      - `initialRegistryAddr` is zero
     *
     * Security:
     * - Initializer can only be called once (UUPS/Initializable)
     *
     * @param name_ ERC-721 collection name
     * @param symbol_ ERC-721 collection symbol
     * @param baseTokenURI_ Base token URI (reserved for future usage)
     * @param initialRegistryAddr Registry address (module resolution SSOT)
     */
    function initialize(
        string calldata name_,
        string calldata symbol_,
        string calldata baseTokenURI_,
        address initialRegistryAddr
    ) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);

        __ERC721_init(name_, symbol_);
        __ERC721Enumerable_init();
        __UUPSUpgradeable_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        _registryAddr = initialRegistryAddr;
        _baseTokenURI = baseTokenURI_;

        // Log initialization action.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );

        // Do not push business data during initialization (no valid tokenId context).
    }

    /**
     * @notice Constructor disables initializers on the implementation contract.
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor() {
        _disableInitializers();
    }

    /*━━━━━━━━━━━━━━━ ADMIN FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Pause sensitive operations.
     * @dev Reverts if:
     *      - Registry is not configured
     *      - caller lacks governance permission (via ACM resolved through Registry)
     *
     * Security:
     * - Role-gated (governance)
     */
    function pause() external onlyValidRegistry {
        _requireRole(GOVERNANCE_ROLE_VAR, msg.sender);
        _pause();

        // Log pause action.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_PAUSE_SYSTEM,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_PAUSE_SYSTEM),
            msg.sender,
            block.number
        );

        // Unified data push (architecture requirement).
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_NFT_PAUSED,
            abi.encode(msg.sender, block.number)
        );
    }

    /**
     * @notice Unpause sensitive operations.
     * @dev Reverts if:
     *      - Registry is not configured
     *      - caller lacks governance permission (via ACM resolved through Registry)
     *
     * Security:
     * - Role-gated (governance)
     */
    function unpause() external onlyValidRegistry {
        _requireRole(GOVERNANCE_ROLE_VAR, msg.sender);
        _unpause();

        // Log unpause action.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_UNPAUSE_SYSTEM,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UNPAUSE_SYSTEM),
            msg.sender,
            block.number
        );

        // Unified data push (architecture requirement).
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_NFT_UNPAUSED,
            abi.encode(msg.sender, block.number)
        );
    }

    /**
     * @notice Update the Registry address.
     * @dev Reverts if:
     *      - Registry is not configured (current `_registryAddr` is zero)
     *      - caller lacks governance permission (via ACM resolved through Registry)
     *      - `newRegistryAddr` is zero
     *
     * Security:
     * - Role-gated (governance)
     *
     * @param newRegistryAddr New Registry address
     */
    function setRegistry(address newRegistryAddr) external onlyValidRegistry {
        _requireRole(GOVERNANCE_ROLE_VAR, msg.sender);
        _setRegistry(newRegistryAddr);
    }

    /*━━━━━━━━━━━━━━━ EXTERNAL API ━━━━━━━━━━━━━━━*/

    /**
     * @notice Mint a loan certificate NFT.
     * @dev Reverts if:
     *      - contract is paused
     *      - Registry is not configured
     *      - caller lacks mint permission (via ACM resolved through Registry)
     *      - `to` is zero
     *      - `data.loanId` was already minted (`LoanNFT__LoanAlreadyMinted`)
     *      - `data.principal` is zero (`LoanNFT__InvalidOrder`)
     *
     * Security:
     * - Non-reentrant
     * - Pausable
     * - Role-gated (minter)
     *
     * @param to Recipient address (typically the borrower)
     * @param data Loan metadata snapshot (see `ILoanNFT.LoanMetadata`)
     * @return tokenId Newly minted token id
     * @inheritdoc ILoanNFT
     */
    function mintLoanCertificate(
        address to,
        LoanMetadata calldata data
    )
        external
        override
        whenNotPaused
        onlyValidRegistry
        nonReentrant
        returns (uint256 tokenId)
    {
        _requireRole(MINTER_ROLE_VAR, msg.sender);
        if (to == address(0)) revert ZeroAddress();
        if (_loanMinted[data.loanId])
            revert LoanNFT__LoanAlreadyMinted(data.loanId);
        if (data.principal == 0) revert LoanNFT__InvalidOrder();

        _loanMinted[data.loanId] = true;
        tokenId = _nextTokenId;
        unchecked {
            _nextTokenId = tokenId + 1;
        }

        LoanMetadata memory metadata = data;
        metadata.status = LoanStatus.Active;
        _loanMetadata[tokenId] = metadata;
        _safeMint(to, tokenId);

        emit LoanCertificateMinted(
            to,
            tokenId,
            data.loanId,
            data.principal,
            data.rate,
            data.term
        );

        // Log mint action.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_BORROW,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_BORROW),
            msg.sender,
            block.number
        );

        // Unified data push (architecture requirement).
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_NFT_MINTED,
            abi.encode(
                to,
                tokenId,
                data.loanId,
                data.principal,
                data.rate,
                data.term,
                block.number
            )
        );
    }

    /**
     * @notice Permanently lock a token as SBT (non-transferable between users).
     * @dev Reverts if:
     *      - Registry is not configured
     *      - caller lacks governance permission (via ACM resolved through Registry)
     *      - `tokenId` does not exist (`LoanNFT__InvalidTokenId`)
     *
     * Security:
     * - Role-gated (governance)
     *
     * @param tokenId Token id to lock
     * @inheritdoc ILoanNFT
     */
    function lockAsSBT(uint256 tokenId) external override onlyValidRegistry {
        _requireRole(GOVERNANCE_ROLE_VAR, msg.sender);
        if (_ownerOf(tokenId) == address(0)) revert LoanNFT__InvalidTokenId();
        _soulBound[tokenId] = true;
        emit TokenLocked(tokenId);

        // Log parameter update action.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );

        // Unified data push (architecture requirement).
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_NFT_LOCKED,
            abi.encode(tokenId, msg.sender, block.number)
        );
    }

    /**
     * @notice Burn a loan certificate token.
     * @dev Reverts if:
     *      - Registry is not configured
     *      - caller lacks governance permission (via ACM resolved through Registry)
     *      - `tokenId` does not exist (`LoanNFT__InvalidTokenId`)
     *
     * Security:
     * - Role-gated (governance)
     *
     * @param tokenId Token id to burn
     * @inheritdoc ILoanNFT
     */
    function burn(uint256 tokenId) external override onlyValidRegistry {
        _requireRole(GOVERNANCE_ROLE_VAR, msg.sender);
        if (_ownerOf(tokenId) == address(0)) revert LoanNFT__InvalidTokenId();
        _burn(tokenId);
        emit TokenBurned(tokenId);

        // Log burn action.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );

        // Unified data push (architecture requirement).
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_NFT_BURNED,
            abi.encode(tokenId, msg.sender, block.number)
        );
    }

    /**
     * @notice Update loan status associated with a token.
     * @dev Reverts if:
     *      - Registry is not configured
     *      - caller lacks mint permission (via ACM resolved through Registry)
     *      - `tokenId` does not exist (`LoanNFT__InvalidTokenId`)
     *
     * Security:
     * - Role-gated (minter)
     *
     * @param tokenId Token id
     * @param newStatus New loan status
     * @inheritdoc ILoanNFT
     */
    function updateLoanStatus(
        uint256 tokenId,
        LoanStatus newStatus
    ) external override onlyValidRegistry {
        _requireRole(MINTER_ROLE_VAR, msg.sender);
        if (_ownerOf(tokenId) == address(0)) revert LoanNFT__InvalidTokenId();
        _loanMetadata[tokenId].status = newStatus;
        emit LoanStatusUpdated(tokenId, newStatus);

        // Log status update action.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );

        // Unified data push (architecture requirement).
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_NFT_STATUS_UPDATED,
            abi.encode(tokenId, newStatus, msg.sender, block.number)
        );
    }

    /*━━━━━━━━━━━━━━━ VIEW FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Return on-chain, base64-encoded JSON metadata for a token.
     * @dev Reverts if:
     *      - `tokenId` does not exist (`LoanNFT__InvalidTokenId`)
     *
     * Security:
     * - View only
     *
     * @param tokenId Token id
     * @return Metadata URI in `data:application/json;base64,...` form
     */
    function tokenURI(
        uint256 tokenId
    ) public view override returns (string memory) {
        if (_ownerOf(tokenId) == address(0)) revert LoanNFT__InvalidTokenId();
        LoanMetadata memory metadata = _loanMetadata[tokenId];

        // On-chain base64 metadata (no external server required).
        string memory json = Base64.encode(
            bytes(
                string(
                    // solhint-disable quotes
                    abi.encodePacked(
                        '{"name":"Loan #',
                        Strings.toString(tokenId),
                        '","description":"Loan Certificate NFT",',
                        '"attributes":[{"trait_type":"LoanId","value":"',
                        Strings.toString(metadata.loanId),
                        '"},{"trait_type":"Principal","value":"',
                        Strings.toString(metadata.principal),
                        '"},{"trait_type":"Rate (bps)","value":"',
                        Strings.toString(metadata.rate),
                        '"},{"trait_type":"Term","value":"',
                        Strings.toString(metadata.term),
                        '"},{"trait_type":"Status","value":"',
                        _statusToString(metadata.status),
                        '"}]}'
                    )
                    // solhint-enable quotes
                )
            )
        );
        return string(abi.encodePacked("data:application/json;base64,", json));
    }

    /**
     * @notice Get loan metadata for a token id.
     * @dev Reverts if:
     *      - `tokenId` does not exist (`LoanNFT__InvalidTokenId`)
     *
     * Security:
     * - View only
     *
     * @param tokenId Token id
     * @return Loan metadata snapshot
     * @inheritdoc ILoanNFT
     */
    function getLoanMetadata(
        uint256 tokenId
    ) external view override returns (LoanMetadata memory) {
        if (_ownerOf(tokenId) == address(0)) revert LoanNFT__InvalidTokenId();
        return _loanMetadata[tokenId];
    }

    /**
     * @notice Get all token ids owned by `user`.
     * @dev Reverts if:
     *      - none (but may be gas-heavy for very large balances)
     *
     * Security:
     * - View only
     *
     * @param user Owner address
     * @return Array of token ids owned by `user`
     * @inheritdoc ILoanNFT
     */
    function getUserTokens(
        address user
    ) external view override returns (uint256[] memory) {
        uint256 balance = balanceOf(user);
        uint256[] memory tokens = new uint256[](balance);
        for (uint256 i; i < balance; ) {
            tokens[i] = tokenOfOwnerByIndex(user, i);
            unchecked {
                ++i;
            }
        }
        return tokens;
    }

    /**
     * @notice Get the current Registry address.
     * @return Registry address
     */
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ INTERNALS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Require `user` to have `actionKey` permission in ACM resolved via Registry.
     * @dev Reverts if:
     *      - Registry module KEY_ACCESS_CONTROL resolves to zero
     *      - AccessControlManager rejects the role for (`actionKey`, `user`)
     *
     * @param actionKey Action key (permission)
     * @param user Address being checked
     */
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ACCESS_CONTROL
        );
        if (acmAddr == address(0)) revert ZeroAddress();
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /**
     * @notice OZ v5 ERC-721 internal state update hook.
     * @dev Reverts if:
     *      - token is SBT-locked and transfer is between non-zero addresses (`LoanNFT__SoulBound`)
     *
     * Security:
     * - Enforces SBT non-transferability invariant (mint/burn allowed)
     */
    function _update(
        address to,
        uint256 tokenId,
        address auth
    )
        internal
        override(ERC721Upgradeable, ERC721EnumerableUpgradeable)
        returns (address)
    {
        // mint: from == 0; burn: to == 0; only block user-to-user transfers.
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0) && _soulBound[tokenId]) {
            revert LoanNFT__SoulBound(tokenId);
        }
        return super._update(to, tokenId, auth);
    }

    /**
     * @notice OZ v5 balance increment hook (required for Enumerable multiple inheritance).
     */
    function _increaseBalance(
        address account,
        uint128 value
    ) internal override(ERC721Upgradeable, ERC721EnumerableUpgradeable) {
        super._increaseBalance(account, value);
    }

    /**
     * @notice Authorize UUPS upgrades.
     * @dev Reverts if:
     *      - caller lacks governance permission (via ACM resolved through Registry)
     *      - `newImplementation` has no code (`LoanNFT__InvalidImplementation`)
     *
     * Security:
     * - Role-gated (governance)
     *
     * @param newImplementation New implementation address
     */
    function _authorizeUpgrade(address newImplementation) internal override {
        _requireRole(GOVERNANCE_ROLE_VAR, msg.sender);
        if (newImplementation.code.length == 0)
            revert LoanNFT__InvalidImplementation();

        // Log upgrade action.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.number
        );
    }

    /**
     * @notice Convert loan status enum to a display string.
     * @param st Loan status
     * @return Status string
     */
    function _statusToString(
        LoanStatus st
    ) private pure returns (string memory) {
        if (st == LoanStatus.Active) return "Active";
        if (st == LoanStatus.Repaid) return "Repaid";
        if (st == LoanStatus.Liquidated) return "Liquidated";
        return "Defaulted";
    }

    /**
     * @notice ERC-165 interface support check.
     * @param interfaceId Interface id
     * @return True if supported
     */
    function supportsInterface(
        bytes4 interfaceId
    )
        public
        view
        override(ERC721Upgradeable, ERC721EnumerableUpgradeable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    /**
     * @notice Internal: set Registry address.
     * @dev Reverts if:
     *      - `newRegistryAddr` is zero
     *
     * @param newRegistryAddr New Registry address
     */
    function _setRegistry(address newRegistryAddr) internal {
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        if (newRegistryAddr.code.length == 0)
            revert NotAContract(newRegistryAddr);

        address oldRegistry = _registryAddr;
        _registryAddr = newRegistryAddr;

        // Log parameter update action.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );

        // Unified data push (architecture requirement).
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_NFT_REGISTRY_UPDATED,
            abi.encode(oldRegistry, newRegistryAddr, msg.sender, block.number)
        );
    }

    /*━━━━━━━━━━━━━━━ GAP ━━━━━━━━━━━━━━━*/

    /**
     * @notice Storage gap reserved for future upgrades.
     * @dev Upgrade safety: prevents storage slot collisions when adding new variables.
     */
    uint256[44] private __gap; // storage gap for upgrade safety
}
