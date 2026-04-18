// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20PermitUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {ERC20VotesUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20VotesUpgradeable.sol";
import {NoncesUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/NoncesUpgradeable.sol";
import {AccessControlEnumerableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title EasyToken
 * @notice EasiFi governance and ecosystem token with pause, permit, vote, and role-gated mint/burn flows.
 * @dev Reverts if:
 *      - initialization receives admin = address(0) (EasyToken__InvalidAddress)
 *      - mint or burn receives a zero address or zero amount (EasyToken__InvalidAddress / EasyToken__ZeroAmount)
 *      - caller lacks the required role for mint, burn, pause, unpause, sole-minter rotation, or upgrades
 *
 * Security:
 * - Minting is restricted to MINTER_ROLE.
 * - Burning is restricted to BURNER_ROLE.
 * - Pause, unpause, sole-minter rotation, and UUPS upgrades are restricted to DEFAULT_ADMIN_ROLE.
 */
contract EasyToken is
    Initializable,
    ERC20PermitUpgradeable,
    ERC20VotesUpgradeable,
    AccessControlEnumerableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    /*━━━━━━━━━━━━━━━ Roles And Constants ━━━━━━━━━━━━━━━*/
    /// @notice Role allowed to mint Easy.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Role allowed to burn Easy.
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    /*━━━━━━━━━━━━━━━ Custom Errors ━━━━━━━━━━━━━━━*/
    /// @dev Reverts when an address argument is zero where a non-zero address is required.
    error EasyToken__InvalidAddress(address addr);
    /// @dev Reverts when a mint or burn amount is zero.
    error EasyToken__ZeroAmount();

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/
    /// @notice Emitted when Easy is minted.
    /// @dev Event only.
    event EasyMinted(address indexed to, uint256 amount);
    /// @notice Emitted when Easy is burned.
    /// @dev Event only.
    event EasyBurned(address indexed from, uint256 amount);

    /// @notice Emitted when the pause state changes.
    /// @dev Event only.
    event PauseStatusChanged(bool paused, uint256 blockNumber);
    /// @notice Emitted when the unique minter role holder is rotated.
    /// @dev Event only.
    event SoleMinterUpdated(address indexed newMinter, uint256 blockNumber);

    /**
     * @notice Initializes the token and grants DEFAULT_ADMIN_ROLE to admin.
     * @dev Reverts if:
     *      - admin is address(0) (EasyToken__InvalidAddress)
     *      - the contract is already initialized (Initializable)
     *
     * Security:
     * - Initialization is single-use.
     * - The admin becomes the initial governance authority for mint/burn role assignment and upgrades.
     *
     * @param admin Admin address that receives DEFAULT_ADMIN_ROLE.
     */
    function initialize(address admin) external initializer {
        if (admin == address(0)) revert EasyToken__InvalidAddress(admin);

        __ERC20_init("Easy Governance Token", "Easy");
        __ERC20Permit_init("Easy Governance Token");
        __ERC20Votes_init();
        __Votes_init();
        __AccessControlEnumerable_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /*━━━━━━━━━━━━━━━ Mint And Burn ━━━━━━━━━━━━━━━*/
    /**
     * @notice Mints Easy to to.
     * @dev Reverts if:
     *      - caller lacks MINTER_ROLE
     *      - to is address(0) (EasyToken__InvalidAddress)
     *      - amount is zero (EasyToken__ZeroAmount)
     *      - the token is paused (Pausable)
     *
     * Security:
     * - Role-gated to MINTER_ROLE.
     * - Pausable to stop issuance during emergencies.
     *
     * @param to Recipient address.
     * @param amount Mint amount in 18-decimal Easy units.
     */
    function mint(
        address to,
        uint256 amount
    ) external whenNotPaused onlyRole(MINTER_ROLE) {
        if (to == address(0)) revert EasyToken__InvalidAddress(to);
        if (amount == 0) revert EasyToken__ZeroAmount();
        _mint(to, amount);
        emit EasyMinted(to, amount);
    }

    /**
     * @notice Burns Easy from from.
     * @dev Reverts if:
     *      - caller lacks BURNER_ROLE
     *      - from is address(0) (EasyToken__InvalidAddress)
     *      - amount is zero (EasyToken__ZeroAmount)
     *      - the token is paused (Pausable)
     *
     * Security:
     * - Role-gated to BURNER_ROLE.
     * - Intended for controlled penalty, recycle, or consumption flows.
     *
     * @param from Address whose balance is burned.
     * @param amount Burn amount in 18-decimal Easy units.
     */
    function burn(
        address from,
        uint256 amount
    ) external whenNotPaused onlyRole(BURNER_ROLE) {
        if (from == address(0)) revert EasyToken__InvalidAddress(from);
        if (amount == 0) revert EasyToken__ZeroAmount();
        _burn(from, amount);
        emit EasyBurned(from, amount);
    }

    /**
     * @notice Replaces all existing MINTER_ROLE holders with newMinter.
     * @dev Reverts if:
     *      - caller lacks DEFAULT_ADMIN_ROLE
     *      - newMinter is address(0) (EasyToken__InvalidAddress)
     *
     * Security:
     * - Centralizes mint authority into a single designated issuer.
     * - Existing minters are revoked before the new minter is granted.
     *
     * @param newMinter New sole minter address.
     */
    function setSoleMinter(
        address newMinter
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newMinter == address(0))
            revert EasyToken__InvalidAddress(newMinter);

        while (getRoleMemberCount(MINTER_ROLE) > 0) {
            address holder = getRoleMember(MINTER_ROLE, 0);
            _revokeRole(MINTER_ROLE, holder);
        }

        _grantRole(MINTER_ROLE, newMinter);
        emit SoleMinterUpdated(newMinter, block.number);
    }

    /*━━━━━━━━━━━━━━━ Pausable Controls ━━━━━━━━━━━━━━━*/
    /**
     * @notice Pauses token transfers, minting, and burning.
     * @dev Reverts if:
     *      - caller lacks DEFAULT_ADMIN_ROLE
     *      - the token is already paused (Pausable)
     *
     * Security:
     * - Emergency stop controlled by DEFAULT_ADMIN_ROLE.
     */
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
        emit PauseStatusChanged(true, block.number);
    }

    /**
     * @notice Unpauses token transfers, minting, and burning.
     * @dev Reverts if:
     *      - caller lacks DEFAULT_ADMIN_ROLE
     *      - the token is not paused (Pausable)
     *
     * Security:
     * - Emergency recovery controlled by DEFAULT_ADMIN_ROLE.
     */
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
        emit PauseStatusChanged(false, block.number);
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20Upgradeable, ERC20VotesUpgradeable) whenNotPaused {
        super._update(from, to, value);
    }

    function nonces(
        address owner
    )
        public
        view
        override(ERC20PermitUpgradeable, NoncesUpgradeable)
        returns (uint256)
    {
        return super.nonces(owner);
    }

    /**
     * @notice Returns the token decimals used by Easy.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Pure metadata read.
     */
    function decimals() public pure override returns (uint8) {
        return 18;
    }

    /*━━━━━━━━━━━━━━━ Upgrades ━━━━━━━━━━━━━━━*/
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override onlyRole(DEFAULT_ADMIN_ROLE) {
        // UUPS authorization enforced by role
        newImplementation;
    }

    uint256[45] private __gap;
}
