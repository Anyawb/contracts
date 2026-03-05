// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import { ERC20PermitUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import { ERC20VotesUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20VotesUpgradeable.sol";
import { NoncesUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/NoncesUpgradeable.sol";
import { AccessControlEnumerableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @title EasyToken (Upgradeable & Pausable)
/// @notice EasiFi platform governance and ecosystem token (Easy)
contract EasyToken is
    Initializable,
    ERC20PermitUpgradeable,
    ERC20VotesUpgradeable,
    AccessControlEnumerableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    // =================== Roles & Constants ===================
    /// @notice Minter role for token issuance
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Burner role for token burn (penalties, recycle, consumption)
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    // =================== Custom Errors ===================
    error EasyToken__InvalidAddress(address addr);
    error EasyToken__ZeroAmount();

    // =================== Events ===================
    event EasyMinted(address indexed to, uint256 amount);
    event EasyBurned(address indexed from, uint256 amount);

    event PauseStatusChanged(bool paused, uint256 blockNumber);
    event SoleMinterUpdated(address indexed newMinter, uint256 blockNumber);

    /// @notice Initialize (one-time)
    /// @param admin Admin address with DEFAULT_ADMIN_ROLE
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

    // =================== Mint & Burn ===================
    function mint(address to, uint256 amount) external whenNotPaused onlyRole(MINTER_ROLE) {
        if (to == address(0)) revert EasyToken__InvalidAddress(to);
        if (amount == 0) revert EasyToken__ZeroAmount();
        _mint(to, amount);
        emit EasyMinted(to, amount);
    }

    function burn(address from, uint256 amount) external whenNotPaused onlyRole(BURNER_ROLE) {
        if (from == address(0)) revert EasyToken__InvalidAddress(from);
        if (amount == 0) revert EasyToken__ZeroAmount();
        _burn(from, amount);
        emit EasyBurned(from, amount);
    }

    /// @notice Set a single minter role holder (recommended: EasyEmissionController)
    function setSoleMinter(address newMinter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newMinter == address(0)) revert EasyToken__InvalidAddress(newMinter);

        while (getRoleMemberCount(MINTER_ROLE) > 0) {
            address holder = getRoleMember(MINTER_ROLE, 0);
            _revokeRole(MINTER_ROLE, holder);
        }

        _grantRole(MINTER_ROLE, newMinter);
        emit SoleMinterUpdated(newMinter, block.number);
    }

    // =================== Pausable ===================
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
        emit PauseStatusChanged(true, block.number);
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
        emit PauseStatusChanged(false, block.number);
    }

    function _update(address from, address to, uint256 value)
        internal
        override(ERC20Upgradeable, ERC20VotesUpgradeable)
        whenNotPaused
    {
        super._update(from, to, value);
    }

    function nonces(address owner)
        public
        view
        override(ERC20PermitUpgradeable, NoncesUpgradeable)
        returns (uint256)
    {
        return super.nonces(owner);
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    // =================== Upgrades ===================
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {
        // UUPS authorization enforced by role
    }

    uint256[45] private __gap;
}
