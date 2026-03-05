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

interface IEasyRecycleDistributor {
    function handleEasyIncome(address payer, uint256 amount, uint8 spendType) external;
}

/// @title EasyConsumption
/// @notice Per-call Easy spend entry for EasiM/API
contract EasyConsumption is Initializable, UUPSUpgradeable, RewardModuleBase {
    using SafeERC20 for IERC20;

    enum SpendType {
        EasiMCall,
        StrategyApiCall
    }

    address private _registryAddr;
    uint256 private constant _SPEND_AMOUNT = 1e18;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /// @notice Spend 1 Easy for EasiM call
    function consumeEasiMCall(address user) external onlyValidRegistry {
        _consume(user, SpendType.EasiMCall);
    }

    /// @notice Spend 1 Easy for Strategy API call
    function consumeStrategyApiCall(address user) external onlyValidRegistry {
        _consume(user, SpendType.StrategyApiCall);
    }

    function _consume(address user, SpendType spendType) internal {
        if (user == address(0)) revert ZeroAddress();
        if (msg.sender != user) {
            _requireRole(ActionKeys.ACTION_CONSUME_EASY, msg.sender);
        }

        EasyToken token = EasyToken(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_EASY_TOKEN));
        address recycle = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_EASY_RECYCLE_DISTRIBUTOR);

        IERC20(address(token)).safeTransferFrom(user, recycle, _SPEND_AMOUNT);

        IEasyRecycleDistributor(recycle).handleEasyIncome(user, _SPEND_AMOUNT, uint8(spendType));

        _tryPushEasySpent(user, uint8(spendType), _SPEND_AMOUNT);
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
