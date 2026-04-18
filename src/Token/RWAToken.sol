// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title RWAToken
 * @notice Example RWA asset token used in collateral, borrow, and liquidation demonstrations.
 * @dev Reverts if:
 *      - mint or burn receives a zero address (RWAToken__InvalidAddress)
 *      - mint or burn receives amount = 0 (RWAToken__ZeroAmount)
 *      - caller is not the owner for owner-gated mint/burn flows (Ownable)
 *
 * Security:
 * - This token is an example asset token, not part of the Easy / governance-token subsystem.
 * - Owner-gated mint and burn are suitable for mocks or demos, not production issuance policy.
 */
contract RWAToken is ERC20, Ownable {
    /*━━━━━━━━━━━━━━━ Custom Errors ━━━━━━━━━━━━━━━*/
    /// @dev Reverts when an address argument is zero where a non-zero address is required.
    error RWAToken__InvalidAddress(address addr);
    /// @dev Reverts when a mint or burn amount is zero.
    error RWAToken__ZeroAmount();

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/
    /// @notice Emitted when example RWA tokens are minted.
    /// @dev Event only.
    event TokensMinted(address indexed to, uint256 amount);

    /// @notice Emitted when example RWA tokens are burned.
    /// @dev Event only.
    event TokensBurned(address indexed from, uint256 amount);

    /**
     * @notice Deploys the example RWA token and sets the deployer as owner.
     * @dev Reverts if:
     *      - none in this contract; upstream ERC20 / Ownable constructor assumptions apply
     *
     * Security:
     * - Ownership starts at msg.sender.
     * - All privileged mint and owner-burn flows are controlled by Ownable.
     *
     * @param name_ ERC20 name.
     * @param symbol_ ERC20 symbol.
     */
    constructor(
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) Ownable(msg.sender) {}

    /**
     * @notice Mints example RWA tokens to to.
     * @dev Reverts if:
     *      - caller is not the owner (Ownable)
     *      - to is address(0) (RWAToken__InvalidAddress)
     *      - amount is zero (RWAToken__ZeroAmount)
     *
     * Security:
     * - Owner-gated example issuance.
     *
     * @param to Recipient address.
     * @param amount Mint amount in token base units.
     */
    function mint(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert RWAToken__InvalidAddress(to);
        if (amount == 0) revert RWAToken__ZeroAmount();
        _mint(to, amount);
        emit TokensMinted(to, amount);
    }

    /**
     * @notice Burns example RWA tokens from from.
     * @dev Reverts if:
     *      - caller is not the owner (Ownable)
     *      - from is address(0) (RWAToken__InvalidAddress)
     *      - amount is zero (RWAToken__ZeroAmount)
     *
     * Security:
     * - Owner-gated forced burn for demo and fixture management only.
     *
     * @param from Address whose balance is burned.
     * @param amount Burn amount in token base units.
     */
    function burn(address from, uint256 amount) external onlyOwner {
        if (from == address(0)) revert RWAToken__InvalidAddress(from);
        if (amount == 0) revert RWAToken__ZeroAmount();
        _burn(from, amount);
        emit TokensBurned(from, amount);
    }

    /**
     * @notice Burns caller-owned example RWA tokens.
     * @dev Reverts if:
     *      - amount is zero (RWAToken__ZeroAmount)
     *
     * Security:
     * - Self-burn only; cannot burn another account's balance.
     *
     * @param amount Burn amount in token base units.
     */
    function burn(uint256 amount) external {
        if (amount == 0) revert RWAToken__ZeroAmount();
        _burn(msg.sender, amount);
        emit TokensBurned(msg.sender, amount);
    }
}
