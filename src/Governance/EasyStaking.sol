// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
// solhint-disable-next-line max-line-length
import {ERC20PermitUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
// solhint-disable-next-line max-line-length
import {ERC20VotesUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20VotesUpgradeable.sol";
import {NoncesUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/NoncesUpgradeable.sol";

import {Registry} from "../registry/Registry.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {ActionKeys} from "../constants/ActionKeys.sol";
import {RewardModuleBase} from "../Reward/internal/RewardModuleBase.sol";
import {NotAContract, ZeroAddress} from "../errors/StandardErrors.sol";

/// @title EasyStaking
/// @notice Stakes EASY tokens into a non-transferable ERC20Votes wrapper for governance voting power.
/// @dev Users receive `stEASY` 1:1 against the staked EASY amount. The token is soulbound-like because transfers
///      between non-zero addresses are blocked in {_update}.
contract EasyStaking is
    Initializable,
    ERC20PermitUpgradeable,
    ERC20VotesUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    RewardModuleBase
{
    using SafeERC20 for IERC20;

    /// @notice Registry address used to resolve module dependencies and permission checks.
    address private _registryAddr;

    /// @dev Reverts when stake/unstake amount is zero.
    error EasyStaking__ZeroAmount();
    /// @dev Reverts when attempting to transfer `stEASY` between non-zero addresses.
    error EasyStaking__NonTransferable();

    /// @notice Emitted when a user stakes EASY and receives `stEASY` voting shares.
    event EasyStaked(address indexed user, uint256 amount, uint256 blockNumber);
    /// @notice Emitted when a user burns `stEASY` and withdraws EASY.
    event EasyUnstaked(
        address indexed user,
        uint256 amount,
        uint256 blockNumber
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the staking wrapper and binds the Registry.
     * @dev Reverts if:
     *      - `initialRegistryAddr` is zero (see {ZeroAddress})
     *      - `initialRegistryAddr` has no code (see {NotAContract})
     *
     * Security:
     * - Single-use initializer for the proxy instance
     *
     * @param initialRegistryAddr Registry contract used to resolve EASY token and AccessControlManager.
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);

        __ERC20_init("Staked Easy", "stEASY");
        __ERC20Permit_init("Staked Easy");
        __ERC20Votes_init();
        __Votes_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        _registryAddr = initialRegistryAddr;
    }

    /**
     * @notice Stakes EASY and mints the same amount of `stEASY` voting shares to the caller.
     * @dev Reverts if:
     *      - Registry is unset or not a contract (via `onlyValidRegistry`)
     *      - `amount` is zero (see {EasyStaking__ZeroAmount})
     *      - Registry is missing `KEY_EASY_TOKEN`
     *      - EASY transfer fails in `safeTransferFrom`
     *
     * Security:
     * - Non-reentrant around token transfer + minting
     * - Automatically self-delegates on first stake so voting checkpoints become active
     *
     * @param amount EASY amount to stake, in token base units.
     */
    function stake(uint256 amount) external onlyValidRegistry nonReentrant {
        if (amount == 0) revert EasyStaking__ZeroAmount();
        address token = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_EASY_TOKEN
        );
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        _mint(msg.sender, amount);
        if (delegates(msg.sender) == address(0)) {
            _delegate(msg.sender, msg.sender);
        }
        _tryPushEasyStaked(msg.sender, amount, balanceOf(msg.sender));
        emit EasyStaked(msg.sender, amount, block.number);
    }

    /**
     * @notice Burns `stEASY` and returns the same amount of EASY to the caller.
     * @dev Reverts if:
     *      - Registry is unset or not a contract (via `onlyValidRegistry`)
     *      - `amount` is zero (see {EasyStaking__ZeroAmount})
     *      - caller balance is lower than `amount` (reverts in ERC20 burn path)
     *      - Registry is missing `KEY_EASY_TOKEN`
     *      - EASY transfer fails in `safeTransfer`
     *
     * Security:
     * - Non-reentrant around burn + token transfer
     * - Voting power is reduced through ERC20Votes checkpointing as part of the burn flow
     *
     * @param amount EASY / `stEASY` amount to unstake, in token base units.
     */
    function unstake(uint256 amount) external onlyValidRegistry nonReentrant {
        if (amount == 0) revert EasyStaking__ZeroAmount();
        _burn(msg.sender, amount);
        address token = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_EASY_TOKEN
        );
        IERC20(token).safeTransfer(msg.sender, amount);
        _tryPushEasyUnstaked(msg.sender, amount, balanceOf(msg.sender));
        emit EasyUnstaked(msg.sender, amount, block.number);
    }

    /// @dev Returns the Registry address for {RewardModuleBase} helpers.
    function _getRegistryAddr() internal view override returns (address) {
        return _registryAddr;
    }

    /// @dev Blocks transfers between non-zero addresses to keep `stEASY` non-transferable.
    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20Upgradeable, ERC20VotesUpgradeable) {
        if (from != address(0) && to != address(0))
            revert EasyStaking__NonTransferable();
        super._update(from, to, value);
    }

    /// @notice Returns the current permit nonce for `owner`.
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

    /// @notice Returns the fixed decimals value used by EASY and `stEASY`.
    function decimals() public pure override returns (uint8) {
        return 18;
    }

    /// @dev UUPS upgrade hook gated by `ACTION_UPGRADE_MODULE`.
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override {
        if (newImplementation == address(0)) revert ZeroAddress();
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
    }

    uint256[45] private __gap;
}
