// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {Registry} from "../registry/Registry.sol";

contract VaultBaseUpgradeMockV1 is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    uint256 public totalValue;
    address public operator;

    function initialize(address initialOwner, uint256 initialValue) external initializer {
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        totalValue = initialValue;
        operator = initialOwner;
    }

    function setTotalValue(uint256 nextValue) external onlyOwner {
        totalValue = nextValue;
    }

    function setOperator(address nextOperator) external onlyOwner {
        operator = nextOperator;
    }

    function version() external pure virtual returns (uint256) {
        return 1;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}

/// @custom:oz-upgrades-unsafe-allow missing-initializer-call
contract VaultBaseUpgradeMockV2 is VaultBaseUpgradeMockV1 {
    uint256 public upgradeCounter;
    bool public v2Initialized;

    /// @custom:oz-upgrades-validate-as-initializer
    function initializeV2(uint256 initialCounter) external reinitializer(2) {
        upgradeCounter = initialCounter;
        v2Initialized = true;
    }

    function recordUpgradeCheckpoint(uint256 nextCounter) external onlyOwner {
        upgradeCounter = nextCounter;
    }

    function version() external pure override returns (uint256) {
        return 2;
    }
}

contract VaultBaseUpgradeMockBadLayout is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    address public operator;
    uint256 public totalValue;

    function initialize(address initialOwner, uint256 initialValue) external initializer {
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        operator = initialOwner;
        totalValue = initialValue;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}

contract RegistryUpgradeAttackMock is Registry {
    function seizeOwner(address nextOwner) external reinitializer(2) {
        _transferOwnership(nextOwner);
    }
}