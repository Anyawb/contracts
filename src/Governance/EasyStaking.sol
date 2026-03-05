// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import { ERC20PermitUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import { ERC20VotesUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20VotesUpgradeable.sol";
import { NoncesUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/NoncesUpgradeable.sol";

import { Registry } from "../registry/Registry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { RewardModuleBase } from "../Reward/internal/RewardModuleBase.sol";
import { NotAContract, ZeroAddress } from "../errors/StandardErrors.sol";

/// @title EasyStaking
/// @notice Stake Easy to obtain voting power (1:1)
contract EasyStaking is
    Initializable,
    ERC20PermitUpgradeable,
    ERC20VotesUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    RewardModuleBase
{
    using SafeERC20 for IERC20;

    /// @notice Registry address
    address private _registryAddr;

    error EasyStaking__ZeroAmount();
    error EasyStaking__NonTransferable();

    event EasyStaked(address indexed user, uint256 amount, uint256 blockNumber);
    event EasyUnstaked(address indexed user, uint256 amount, uint256 blockNumber);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);

        __ERC20_init("Staked Easy", "stEASY");
        __ERC20Permit_init("Staked Easy");
        __ERC20Votes_init();
        __Votes_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        _registryAddr = initialRegistryAddr;
    }

    function stake(uint256 amount) external onlyValidRegistry nonReentrant {
        if (amount == 0) revert EasyStaking__ZeroAmount();
        address token = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_EASY_TOKEN);
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        _mint(msg.sender, amount);
        if (delegates(msg.sender) == address(0)) {
            _delegate(msg.sender, msg.sender);
        }
        _tryPushEasyStaked(msg.sender, amount, balanceOf(msg.sender));
        emit EasyStaked(msg.sender, amount, block.number);
    }

    function unstake(uint256 amount) external onlyValidRegistry nonReentrant {
        if (amount == 0) revert EasyStaking__ZeroAmount();
        _burn(msg.sender, amount);
        address token = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_EASY_TOKEN);
        IERC20(token).safeTransfer(msg.sender, amount);
        _tryPushEasyUnstaked(msg.sender, amount, balanceOf(msg.sender));
        emit EasyUnstaked(msg.sender, amount, block.number);
    }

    function _getRegistryAddr() internal view override returns (address) {
        return _registryAddr;
    }

    function _update(address from, address to, uint256 value)
        internal
        override(ERC20Upgradeable, ERC20VotesUpgradeable)
    {
        if (from != address(0) && to != address(0)) revert EasyStaking__NonTransferable();
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

    function _authorizeUpgrade(address newImplementation) internal view override {
        if (newImplementation == address(0)) revert ZeroAddress();
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
    }

    uint256[45] private __gap;
}
