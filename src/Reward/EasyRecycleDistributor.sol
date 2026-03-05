// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../registry/Registry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { RewardModuleBase } from "./internal/RewardModuleBase.sol";
import { EasyToken } from "../Token/EasyToken.sol";
import { NotAContract, ZeroAddress } from "../errors/StandardErrors.sol";

/// @title EasyRecycleDistributor
/// @notice Receives Easy spend and splits 75/15/10 (burn/team/eco)
contract EasyRecycleDistributor is Initializable, UUPSUpgradeable, RewardModuleBase {
    using SafeERC20 for IERC20;

    /// @notice Registry address
    address private _registryAddr;

    address private _teamRecipient;
    address private _ecoRecipient;

    event RecipientsUpdated(address indexed teamRecipient, address indexed ecoRecipient, uint256 blockNumber);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialRegistryAddr, address teamRecipient, address ecoRecipient) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        if (teamRecipient == address(0) || ecoRecipient == address(0)) revert ZeroAddress();

        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
        _teamRecipient = teamRecipient;
        _ecoRecipient = ecoRecipient;

        emit RecipientsUpdated(teamRecipient, ecoRecipient, block.number);
    }

    /// @notice Handle a spend income and split into burn/team/eco
    /// @dev Only EasyConsumption (Registry[KEY_EASY_CONSUMPTION]) may call
    function handleEasyIncome(address payer, uint256 amount, uint8 spendType) external onlyValidRegistry {
        address consumption = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_EASY_CONSUMPTION);
        if (msg.sender != consumption) return;
        if (amount == 0) return;

        uint256 burnAmount = (amount * 75) / 100;
        uint256 teamAmount = (amount * 15) / 100;
        uint256 ecoAmount = amount - burnAmount - teamAmount;

        EasyToken token = EasyToken(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_EASY_TOKEN));
        token.burn(address(this), burnAmount);

        IERC20(address(token)).safeTransfer(_teamRecipient, teamAmount);
        IERC20(address(token)).safeTransfer(_ecoRecipient, ecoAmount);

        _tryPushEasyRecycledSplit(payer, amount, burnAmount, teamAmount, ecoAmount, spendType);
    }

    /// @notice Update recipients (governance)
    function setRecipients(address teamRecipient, address ecoRecipient) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (teamRecipient == address(0) || ecoRecipient == address(0)) revert ZeroAddress();
        _teamRecipient = teamRecipient;
        _ecoRecipient = ecoRecipient;
        emit RecipientsUpdated(teamRecipient, ecoRecipient, block.number);
    }

    function getRecipients() external view onlyValidRegistry returns (address teamRecipient, address ecoRecipient) {
        return (_teamRecipient, _ecoRecipient);
    }

    function _getRegistryAddr() internal view override returns (address) {
        return _registryAddr;
    }

    function _authorizeUpgrade(address newImplementation) internal view override {
        if (newImplementation == address(0)) revert ZeroAddress();
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
    }

    uint256[45] private __gap;
}
