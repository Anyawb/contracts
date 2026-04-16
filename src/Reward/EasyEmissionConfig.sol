// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ActionKeys} from "../constants/ActionKeys.sol";
import {RewardModuleBase} from "./internal/RewardModuleBase.sol";
import {SystemEvents} from "../Vault/SystemEvents.sol";
import {
    NotAContract,
    ZeroAddress,
    InvalidCaller
} from "../errors/StandardErrors.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title EasyEmissionConfig
/// @notice SSOT for Easy emission parameters used by {EasyEmissionController}.
/// @dev Stores bootstrap and deflation parameters behind Registry and ActionKeys governance.
contract EasyEmissionConfig is
    Initializable,
    UUPSUpgradeable,
    RewardModuleBase
{
    uint8 private constant _SYSTEM_VALUATION_DECIMALS = 18;

    /// @notice Registry address
    address private _registryAddr;

    /// @notice Bootstrap threshold in the shared system valuation unit.
    uint256 private _bootstrapThresholdValue;
    /// @notice Bootstrap mint amount per 1000 value units (18 decimals)
    uint256 private _bootstrapMintPer1000Usd;
    /// @notice Deflation coefficient numerator (kNum)
    uint256 private _deflationKNum;
    /// @notice Deflation coefficient denominator (kDen)
    uint256 private _deflationKDen;
    /// @notice Last update block
    uint256 private _updateBlock;

    /// @notice Emitted when emission parameters are updated.
    /// @dev Emitted on initialization and each successful governance write.
    event EmissionParamsUpdated(
        uint256 thresholdValue,
        uint256 mintPer1000Usd,
        uint8 valuationDecimals,
        uint256 kNum,
        uint256 kDen,
        uint256 blockNumber
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the module with WhitePaper-aligned defaults.
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (see {ZeroAddress})
     *      - initialRegistryAddr is not a contract (see {NotAContract})
     *
     * Security:
     * - One-time initializer.
     * - Pushes RewardView observability best-effort; push failure MUST NOT block initialization.
     *
     * @param initialRegistryAddr Registry contract address.
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);

        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;

        _bootstrapThresholdValue = 100_000_000 * 1e18;
        _bootstrapMintPer1000Usd = 10 * 1e18;
        _deflationKNum = 1;
        _deflationKDen = 10_000_000;
        _updateBlock = block.number;

        emit EmissionParamsUpdated(
            _bootstrapThresholdValue,
            _bootstrapMintPer1000Usd,
            _SYSTEM_VALUATION_DECIMALS,
            _deflationKNum,
            _deflationKDen,
            block.number
        );

        _tryPushEasyEmissionParamsUpdated(
            _bootstrapThresholdValue,
            _SYSTEM_VALUATION_DECIMALS,
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

    /*━━━━━━━━━━━━━━━ Governance Writes ━━━━━━━━━━━━━━━*/

    /**
     * @notice Updates Easy emission parameters.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - caller lacks ACTION_SET_PARAMETER
     *      - kDen is zero (see {InvalidCaller})
     *      - mintPer1000Usd is zero (see {InvalidCaller})
     *
     * Security:
     * - Role-gated by ACTION_SET_PARAMETER.
     * - RewardView cache push is best-effort and MUST NOT block the write path.
     *
      * @param thresholdValue Bootstrap/deflation stage threshold in the shared system valuation unit.
      * @param mintPer1000Usd Bootstrap mint amount per 1000 value units, in Easy 18 decimals.
     * @param kNum Deflation numerator.
     * @param kDen Deflation denominator. MUST be non-zero.
     */
    function setEmissionParams(
          uint256 thresholdValue,
        uint256 mintPer1000Usd,
        uint256 kNum,
        uint256 kDen
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (kDen == 0) revert InvalidCaller();
        if (mintPer1000Usd == 0) revert InvalidCaller();

        _bootstrapThresholdValue = thresholdValue;
        _bootstrapMintPer1000Usd = mintPer1000Usd;
        _deflationKNum = kNum;
        _deflationKDen = kDen;
        _updateBlock = block.number;

        emit EmissionParamsUpdated(
            thresholdValue,
            mintPer1000Usd,
            _SYSTEM_VALUATION_DECIMALS,
            kNum,
            kDen,
            block.number
        );

        _tryPushEasyEmissionParamsUpdated(
            thresholdValue,
            _SYSTEM_VALUATION_DECIMALS,
            mintPer1000Usd,
            kNum,
            kDen
        );
    }

    /*━━━━━━━━━━━━━━━ Views ━━━━━━━━━━━━━━━*/

    /**
     * @notice Returns the full emission parameter set.
     * @dev Reverts if Registry validation fails in {onlyValidRegistry}.
     *
     * Security:
     * - View-only; no state mutation.
     *
     * @return thresholdValue Bootstrap/deflation stage threshold in the shared system valuation unit.
     * @return mintPer1000Usd Bootstrap mint amount per 1000 value units, in Easy 18 decimals.
     * @return kNum Deflation numerator.
     * @return kDen Deflation denominator.
     * @return valuationDecimals Shared valuation precision for `thresholdValue`.
     * @return updateBlock Block number of the latest parameter update.
     */
    function getEmissionParams()
        external
        view
        onlyValidRegistry
        returns (
            uint256 thresholdValue,
            uint256 mintPer1000Usd,
            uint256 kNum,
            uint256 kDen,
            uint8 valuationDecimals,
            uint256 updateBlock
        )
    {
        return (
            _bootstrapThresholdValue,
            _bootstrapMintPer1000Usd,
            _deflationKNum,
            _deflationKDen,
            _SYSTEM_VALUATION_DECIMALS,
            _updateBlock
        );
    }

    /// @notice Returns the bootstrap threshold in the shared system valuation unit.
    /// @dev Reverts if Registry validation fails in {onlyValidRegistry}.
    function bootstrapThresholdValue()
        external
        view
        onlyValidRegistry
        returns (uint256)
    {
        return _bootstrapThresholdValue;
    }

    /// @notice Returns the bootstrap mint amount per 1000 USD.
    /// @dev Reverts if Registry validation fails in {onlyValidRegistry}.
    function bootstrapMintPer1000Usd()
        external
        view
        onlyValidRegistry
        returns (uint256)
    {
        return _bootstrapMintPer1000Usd;
    }

    /// @notice Returns the deflation numerator.
    /// @dev Reverts if Registry validation fails in {onlyValidRegistry}.
    function deflationKNum() external view onlyValidRegistry returns (uint256) {
        return _deflationKNum;
    }

    /// @notice Returns the deflation denominator.
    /// @dev Reverts if Registry validation fails in {onlyValidRegistry}.
    function deflationKDen() external view onlyValidRegistry returns (uint256) {
        return _deflationKDen;
    }

    /// @notice Returns the block number of the latest parameter update.
    /// @dev Reverts if Registry validation fails in {onlyValidRegistry}.
    function getLastUpdateBlock()
        external
        view
        onlyValidRegistry
        returns (uint256)
    {
        return _updateBlock;
    }

    /*━━━━━━━━━━━━━━━ RewardModuleBase ━━━━━━━━━━━━━━━*/

    function _getRegistryAddr() internal view override returns (address) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ UUPS ━━━━━━━━━━━━━━━*/

    /// @dev Reverts if caller lacks ACTION_UPGRADE_MODULE or newImplementation is zero (see {ZeroAddress}).
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    uint256[45] private __gap;
}
