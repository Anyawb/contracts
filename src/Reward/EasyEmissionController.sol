// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Registry} from "../registry/Registry.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {ActionKeys} from "../constants/ActionKeys.sol";
import {RewardModuleBase} from "./internal/RewardModuleBase.sol";
import {EasyToken} from "../Token/EasyToken.sol";
import {IPriceOracleRead} from "../interfaces/IPriceOracleRead.sol";
import {
    MissingRole,
    NotAContract,
    ZeroAddress
} from "../errors/StandardErrors.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @title IEasyEmissionConfigView
/// @notice Minimal read interface for EasyEmissionConfig.
/// @dev Used by {EasyEmissionController} to fetch emission parameters without importing the full config implementation.
interface IEasyEmissionConfigView {
    /// @notice Returns the current emission parameter tuple.
    function getEmissionParams()
        external
        view
        returns (
            uint256 thresholdUsd8,
            uint256 mintPer1000Usd,
            uint256 kNum,
            uint256 kDen,
            uint256 updateBlock
        );
}

/// @title ILoanFlowViewGlobalRead
/// @notice Minimal global read interface for LoanFlowView.
/// @dev Used by {EasyEmissionController} to fetch total borrow flow inputs for WhitePaper mint calculations.
interface ILoanFlowViewGlobalRead {
    /// @notice Returns global borrow and repay flow totals together with validity metadata.
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

/// @title IRewardAccrualManager
/// @notice Minimal reward-offset interface for RewardAccrualManager.
/// @dev Used by {EasyEmissionController} to offset pending penalty debt before minting Easy.
interface IRewardAccrualManager {
    /// @notice Offsets pending penalty debt against an Easy accrual amount.
    function offsetPenaltyOnReward(
        address user,
        uint256 easyRewardAmount,
        string calldata reason
    ) external returns (uint256 netAmount);
}

/// @title EasyEmissionController
/// @notice Mints Easy on full repayment completion according to WhitePaper formulas.
/// @dev Reads emission configuration and protocol flow best-effort.
///      It offsets pending penalty debt before minting borrower and lender shares.
contract EasyEmissionController is
    Initializable,
    UUPSUpgradeable,
    RewardModuleBase
{
    /// @notice Registry address
    address private _registryAddr;

    /// @notice Emitted when Easy is minted for a repaid order.
    /// @dev flowValid mirrors LoanFlowView validity.
    ///      retainedEasy and totalBorrowVolumeUsd8 capture the formula inputs used for the mint.
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

    /// @notice Emitted when Easy minting is skipped.
    /// @dev reason is a machine-readable skip cause such as zero-address,
    ///      price-unavailable, or offset-fully.
    event EasyMintSkipped(
        address indexed borrower,
        address indexed lender,
        uint256 indexed orderId,
        string reason
    );

    // WhitePaper: borrow amount minimum is 1000U.
    uint256 private constant _MIN_BORROW_USD8 = 1000 * 1e8;
    // Fee SSOT (see docs/WhitePaper.md and docs/Usage-Guide/Funds-Flow-Architecture-Guide.md):
    // - Platform total fee is 0.6%.
    // - Borrow-side fee is 0.3% (30 bps) via FeeRouter; repay-side fee is 0.3% via LendingEngine.repay.
    // Easy minting is based on the *net borrow amount* after the borrow-side fee.
    uint256 private constant _BORROW_FEE_BPS = 30;
    uint256 private constant _BPS_DENOM = 10_000;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the module with the Registry address.
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (see {ZeroAddress})
     *      - initialRegistryAddr is not a contract (see {NotAContract})
     *
     * Security:
     * - One-time initializer.
     * - Registry address becomes the SSOT for Reward, oracle, and token module resolution.
     *
     * @param initialRegistryAddr Registry contract address.
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Mint Entry ━━━━━━━━━━━━━━━*/

    /**
     * @notice Processes one order-level loan event and mints Easy on full repayment paths.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - Registry missing KEY_RM, KEY_EASY_EMISSION_CONFIG,
     *        KEY_LOAN_FLOW_VIEW, KEY_EASY_TOKEN, or KEY_PRICE_ORACLE
     *      - caller is not Registry[KEY_RM] (see {MissingRole})
     *      - EasyToken mint reverts
     *
     * Security:
     * - Only RewardManager may call.
     * - Non-mint cases are deliberately best-effort and emit {EasyMintSkipped}
     *   instead of reverting.
     * - Price reads and penalty offsets are best-effort; a failed price read
     *   returns amountUsd8 == 0 and skips minting.
     *
     * @param borrower Borrower account for the repaid order.
     * @param lender Lender account for the repaid order.
     * @param asset Borrowed asset used for price conversion.
     * @param orderId Order identifier.
     * @param amountBaseUnits Repaid principal amount in the asset's base units.
     * @param outcome Loan outcome code from RewardManagerCore:
     *        0=Borrow, 1=RepayOnTimeFull, 2=RepayEarlyFull, 3=RepayLateFull.
     */
    function onLoanEventByOrderWithLender(
        address borrower,
        address lender,
        address asset,
        uint256 orderId,
        uint256 amountBaseUnits,
        uint256 /* maturity */,
        uint8 outcome
    ) external onlyValidRegistry {
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_RM
        );
        if (msg.sender != rewardManager) revert MissingRole();

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
            emit EasyMintSkipped(
                borrower,
                lender,
                orderId,
                "price-unavailable"
            );
            return;
        }

        if (amountUsd8Gross < _MIN_BORROW_USD8) {
            emit EasyMintSkipped(borrower, lender, orderId, "below-min-1000u");
            return;
        }

        // Apply WhitePaper fee rule: mint is based on net amount after total fee.
        uint256 amountUsd8 = Math.mulDiv(
            amountUsd8Gross,
            (_BPS_DENOM - _BORROW_FEE_BPS),
            _BPS_DENOM
        );

        (
            uint256 thresholdUsd8,
            uint256 mintPer1000Usd,
            uint256 kNum,
            uint256 kDen,

        ) = IEasyEmissionConfigView(_getEasyEmissionConfig())
                .getEmissionParams();

        (
            uint256 totalBorrowVolumeUsd8,
            ,
            ,
            ,
            bool flowValid,

        ) = ILoanFlowViewGlobalRead(_getLoanFlowView())
                .getGlobalLoanFlowWithMeta();

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
                emit EasyMintSkipped(
                    borrower,
                    lender,
                    orderId,
                    "invalid-denom"
                );
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

        // Offset pending penalty debt for both parties before minting.
        uint256 netBorrowerShare = borrowerShare;
        uint256 netLenderShare = lenderShare;
        try
            Registry(_registryAddr).getModuleOrRevert(
                ModuleKeys.KEY_REWARD_ACCRUAL_MANAGER
            )
        returns (address ramAddr) {
            IRewardAccrualManager ram = IRewardAccrualManager(ramAddr);
            try
                ram.offsetPenaltyOnReward(
                    borrower,
                    borrowerShare,
                    "PenaltyOffsetOnReward"
                )
            returns (uint256 v) {
                netBorrowerShare = v;
            } catch {
                uint256 ignoredBorrowerOffset = netBorrowerShare;
                ignoredBorrowerOffset;
            }
            try
                ram.offsetPenaltyOnReward(
                    lender,
                    lenderShare,
                    "PenaltyOffsetOnReward"
                )
            returns (uint256 v) {
                netLenderShare = v;
            } catch {
                uint256 ignoredLenderOffset = netLenderShare;
                ignoredLenderOffset;
            }
        } catch {
            uint256 ignoredAccrualManager = 0;
            ignoredAccrualManager;
        }

        borrowerShare = netBorrowerShare;
        lenderShare = netLenderShare;
        totalMinted = borrowerShare + lenderShare;
        if (totalMinted == 0) {
            emit EasyMintSkipped(borrower, lender, orderId, "offset-fully");
            return;
        }

        EasyToken token = EasyToken(_getEasyToken());
        if (borrowerShare > 0) token.mint(borrower, borrowerShare);
        if (lenderShare > 0) token.mint(lender, lenderShare);

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

        _tryPushEasyMinted(
            borrower,
            lender,
            totalMinted,
            borrowerShare,
            lenderShare,
            orderId,
            amountUsd8
        );
    }

    /*━━━━━━━━━━━━━━━ Internal Helpers ━━━━━━━━━━━━━━━*/

    /// @dev Converts an asset amount into USD-8 using the best-effort oracle
    ///      read. Returns 0 on failure or invalid oracle data.
    function _toUsd8(
        address asset,
        uint256 amountBaseUnits
    ) internal view returns (uint256) {
        address priceOracle = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_PRICE_ORACLE
        );
        try IPriceOracleRead(priceOracle).getPrice(asset) returns (
            uint256 price,
            uint256,
            uint256 assetDecimals
        ) {
            if (price == 0 || assetDecimals == 0) return 0;
            return Math.mulDiv(amountBaseUnits, price, 10 ** assetDecimals);
        } catch {
            return 0;
        }
    }

    /// @dev Returns retained Easy as totalSupply / 1e18, matching the deflation formula input.
    function _getRetainedEasy() internal view returns (uint256) {
        EasyToken token = EasyToken(_getEasyToken());
        return token.totalSupply() / 1e18;
    }

    function _getEasyToken() internal view returns (address) {
        return
            Registry(_registryAddr).getModuleOrRevert(
                ModuleKeys.KEY_EASY_TOKEN
            );
    }

    function _getEasyEmissionConfig() internal view returns (address) {
        return
            Registry(_registryAddr).getModuleOrRevert(
                ModuleKeys.KEY_EASY_EMISSION_CONFIG
            );
    }

    function _getLoanFlowView() internal view returns (address) {
        return
            Registry(_registryAddr).getModuleOrRevert(
                ModuleKeys.KEY_LOAN_FLOW_VIEW
            );
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
        if (newImplementation == address(0)) revert ZeroAddress();
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
    }

    uint256[45] private __gap;
}
