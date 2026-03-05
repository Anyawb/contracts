// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Registry } from "../registry/Registry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { RewardModuleBase } from "./internal/RewardModuleBase.sol";
import { EasyToken } from "../Token/EasyToken.sol";
import { IPriceOracle } from "../interfaces/IPriceOracle.sol";
import { NotAContract, ZeroAddress } from "../errors/StandardErrors.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

interface IEasyEmissionConfigView {
    function getEmissionParams()
        external
        view
        returns (uint256 thresholdUsd8, uint256 mintPer1000Usd, uint256 kNum, uint256 kDen, uint256 updateBlock);
}

interface ILoanFlowViewGlobalRead {
    function getGlobalLoanFlowWithMeta()
        external
        view
        returns (
            uint256 totalBorrowVolumeUsd8,
            uint256 totalRepayVolumeUsd8,
            uint256 totalBorrowCount,
            uint256 totalRepayCount,
            bool isValid,
            uint256 blockNumber
        );
}

/// @title EasyEmissionController
/// @notice Mints Easy on repay completion (on-time only), per WhitePaper formulas
contract EasyEmissionController is Initializable, UUPSUpgradeable, RewardModuleBase {
    /// @notice Registry address
    address private _registryAddr;

    /// @notice Emitted when Easy is minted for a repaid order
    event EasyMinted(
        address indexed borrower,
        address indexed lender,
        uint256 indexed orderId,
        uint256 amountUsd8,
        uint256 totalMinted,
        uint256 borrowerShare,
        uint256 lenderShare,
        uint8 stage,
        uint256 retainedEasy,
        uint256 totalBorrowVolumeUsd8,
        bool flowValid,
        uint256 blockNumber
    );

    /// @notice Emitted when Easy minting is skipped (best-effort)
    event EasyMintSkipped(address indexed borrower, address indexed lender, uint256 indexed orderId, string reason);

    // WhitePaper: borrow amount minimum is 1000U.
    uint256 private constant _MIN_BORROW_USD8 = 1000 * 1e8;
    // WhitePaper: total borrow fee is 0.06% (6 bps); mint is based on net borrow after fee.
    uint256 private constant _BORROW_FEE_BPS = 6;
    uint256 private constant _BPS_DENOM = 10_000;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize with Registry address
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /// @notice Entry from RewardManager: order-based event with lender + asset
    /// @dev Only RewardManager (Registry[KEY_RM]) may call
    function onLoanEventByOrderWithLender(
        address borrower,
        address lender,
        address asset,
        uint256 orderId,
        uint256 amountBaseUnits,
        uint256 /* maturity */,
        uint8 outcome
    ) external onlyValidRegistry {
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (msg.sender != rewardManager) return;

        // WhitePaper trigger: mint when a loan is completed (i.e., repaid in full).
        // Outcome mapping (from RewardManagerCore):
        // 0=Borrow,1=RepayOnTimeFull,2=RepayEarlyFull,3=RepayLateFull
        if (outcome != 1 && outcome != 2 && outcome != 3) return;
        if (borrower == address(0) || lender == address(0)) {
            emit EasyMintSkipped(borrower, lender, orderId, "zero-address");
            return;
        }
        if (amountBaseUnits == 0) {
            emit EasyMintSkipped(borrower, lender, orderId, "zero-amount");
            return;
        }

        uint256 amountUsd8Gross = _toUsd8(asset, amountBaseUnits);
        if (amountUsd8Gross == 0) {
            emit EasyMintSkipped(borrower, lender, orderId, "price-unavailable");
            return;
        }

        if (amountUsd8Gross < _MIN_BORROW_USD8) {
            emit EasyMintSkipped(borrower, lender, orderId, "below-min-1000u");
            return;
        }

        // Apply WhitePaper fee rule: mint is based on net amount after total fee.
        uint256 amountUsd8 = Math.mulDiv(amountUsd8Gross, (_BPS_DENOM - _BORROW_FEE_BPS), _BPS_DENOM);

        (uint256 thresholdUsd8, uint256 mintPer1000Usd, uint256 kNum, uint256 kDen, ) =
            IEasyEmissionConfigView(_getEasyEmissionConfig()).getEmissionParams();

        (uint256 totalBorrowVolumeUsd8, , , , bool flowValid, ) =
            ILoanFlowViewGlobalRead(_getLoanFlowView()).getGlobalLoanFlowWithMeta();

        uint8 stage = totalBorrowVolumeUsd8 < thresholdUsd8 ? 0 : 1;

        uint256 totalMinted;
        if (stage == 0) {
            // bootstrap: amountUsd8 / (1000*1e8) * mintPer1000Usd
            totalMinted = Math.mulDiv(amountUsd8, mintPer1000Usd, 1000 * 1e8);
        } else {
            // deflation: (amountUsd8 / 100) / (1 + k * retainedEasy)
            uint256 retainedEasy = _getRetainedEasy();
            uint256 base = Math.mulDiv(amountUsd8, 1e10, 100); // amountUsd8 * 1e18 / 1e8 / 100
            uint256 denom = kDen + (kNum * retainedEasy);
            if (denom == 0) {
                emit EasyMintSkipped(borrower, lender, orderId, "invalid-denom");
                return;
            }
            totalMinted = Math.mulDiv(base, kDen, denom);
        }

        if (totalMinted == 0) {
            emit EasyMintSkipped(borrower, lender, orderId, "zero-mint");
            return;
        }

        uint256 borrowerShare = totalMinted / 2;
        uint256 lenderShare = totalMinted - borrowerShare;

        EasyToken token = EasyToken(_getEasyToken());
        token.mint(borrower, borrowerShare);
        token.mint(lender, lenderShare);

        emit EasyMinted(
            borrower,
            lender,
            orderId,
            amountUsd8,
            totalMinted,
            borrowerShare,
            lenderShare,
            stage,
            _getRetainedEasy(),
            totalBorrowVolumeUsd8,
            flowValid,
            block.number
        );

        _tryPushEasyMinted(borrower, lender, totalMinted, borrowerShare, lenderShare, orderId, amountUsd8);
    }

    // ========== Internal helpers ==========

    function _toUsd8(address asset, uint256 amountBaseUnits) internal view returns (uint256) {
        address priceOracle = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_PRICE_ORACLE);
        try IPriceOracle(priceOracle).getPrice(asset) returns (uint256 price, uint256, uint256 assetDecimals) {
            if (price == 0 || assetDecimals == 0) return 0;
            return Math.mulDiv(amountBaseUnits, price, 10 ** assetDecimals);
        } catch {
            return 0;
        }
    }

    function _getRetainedEasy() internal view returns (uint256) {
        EasyToken token = EasyToken(_getEasyToken());
        return token.totalSupply() / 1e18;
    }

    function _getEasyToken() internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_EASY_TOKEN);
    }

    function _getEasyEmissionConfig() internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_EASY_EMISSION_CONFIG);
    }

    function _getLoanFlowView() internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LOAN_FLOW_VIEW);
    }

    // ========== RewardModuleBase ==========

    function _getRegistryAddr() internal view override returns (address) {
        return _registryAddr;
    }

    // ========== UUPS ==========

    function _authorizeUpgrade(address newImplementation) internal view override {
        if (newImplementation == address(0)) revert ZeroAddress();
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
    }

    uint256[45] private __gap;
}
