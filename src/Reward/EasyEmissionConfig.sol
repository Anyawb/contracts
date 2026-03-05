// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ActionKeys } from "../constants/ActionKeys.sol";
import { RewardModuleBase } from "./internal/RewardModuleBase.sol";
import { SystemEvents } from "../Vault/SystemEvents.sol";
import { NotAContract, ZeroAddress, InvalidCaller } from "../errors/StandardErrors.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title EasyEmissionConfig
/// @notice SSOT for Easy emission parameters (bootstrap + deflation)
/// @dev Write path is governed by ActionKeys and Registry
contract EasyEmissionConfig is Initializable, UUPSUpgradeable, RewardModuleBase {
    /// @notice Registry address
    address private _registryAddr;

    /// @notice Bootstrap threshold in USD-8
    uint256 private _bootstrapThresholdUsd8;
    /// @notice Bootstrap mint amount per 1000 USD (18 decimals)
    uint256 private _bootstrapMintPer1000Usd;
    /// @notice Deflation coefficient numerator (kNum)
    uint256 private _deflationKNum;
    /// @notice Deflation coefficient denominator (kDen)
    uint256 private _deflationKDen;
    /// @notice Last update block
    uint256 private _updateBlock;

    event EmissionParamsUpdated(
        uint256 thresholdUsd8,
        uint256 mintPer1000Usd,
        uint256 kNum,
        uint256 kDen,
        uint256 blockNumber
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize with WhitePaper-aligned defaults
    /// @param initialRegistryAddr Registry contract address
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);

        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;

        _bootstrapThresholdUsd8 = 100_000_000 * 1e8;
        _bootstrapMintPer1000Usd = 10 * 1e18;
        _deflationKNum = 1;
        _deflationKDen = 10_000_000;
        _updateBlock = block.number;

        emit EmissionParamsUpdated(
            _bootstrapThresholdUsd8,
            _bootstrapMintPer1000Usd,
            _deflationKNum,
            _deflationKDen,
            block.number
        );

        _tryPushEasyEmissionParamsUpdated(
            _bootstrapThresholdUsd8,
            _bootstrapMintPer1000Usd,
            _deflationKNum,
            _deflationKDen
        );

        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    // ========== Governance Writes ==========

    /// @notice Update emission parameters
    /// @dev Requires ACTION_SET_PARAMETER via ACM
    function setEmissionParams(
        uint256 thresholdUsd8,
        uint256 mintPer1000Usd,
        uint256 kNum,
        uint256 kDen
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (kDen == 0) revert InvalidCaller();
        if (mintPer1000Usd == 0) revert InvalidCaller();

        _bootstrapThresholdUsd8 = thresholdUsd8;
        _bootstrapMintPer1000Usd = mintPer1000Usd;
        _deflationKNum = kNum;
        _deflationKDen = kDen;
        _updateBlock = block.number;

        emit EmissionParamsUpdated(thresholdUsd8, mintPer1000Usd, kNum, kDen, block.number);

        _tryPushEasyEmissionParamsUpdated(thresholdUsd8, mintPer1000Usd, kNum, kDen);
    }

    // ========== Views ==========

    function getEmissionParams()
        external
        view
        onlyValidRegistry
        returns (
            uint256 thresholdUsd8,
            uint256 mintPer1000Usd,
            uint256 kNum,
            uint256 kDen,
            uint256 updateBlock
        )
    {
        return (_bootstrapThresholdUsd8, _bootstrapMintPer1000Usd, _deflationKNum, _deflationKDen, _updateBlock);
    }

    function bootstrapThresholdUsd8() external view onlyValidRegistry returns (uint256) {
        return _bootstrapThresholdUsd8;
    }

    function bootstrapMintPer1000Usd() external view onlyValidRegistry returns (uint256) {
        return _bootstrapMintPer1000Usd;
    }

    function deflationKNum() external view onlyValidRegistry returns (uint256) {
        return _deflationKNum;
    }

    function deflationKDen() external view onlyValidRegistry returns (uint256) {
        return _deflationKDen;
    }

    function getLastUpdateBlock() external view onlyValidRegistry returns (uint256) {
        return _updateBlock;
    }

    // ========== RewardModuleBase ==========

    function _getRegistryAddr() internal view override returns (address) {
        return _registryAddr;
    }

    // ========== UUPS ==========

    function _authorizeUpgrade(address newImplementation) internal view override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    uint256[45] private __gap;
}
