// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {Registry} from "../../../registry/Registry.sol";
import {ActionKeys} from "../../../constants/ActionKeys.sol";
import {ModuleKeys} from "../../../constants/ModuleKeys.sol";
import {ViewVersioned} from "../ViewVersioned.sol";
import {IOrderEngine} from "../../../interfaces/IOrderEngine.sol";
import {IOrderEngineViewAdapter} from "../../../interfaces/IOrderEngineViewAdapter.sol";
import {ILoanNFT} from "../../../interfaces/ILoanNFT.sol";
import {IOrderStateStoreV2} from "../../../interfaces/IOrderStateStoreV2.sol";
import {IShortfallLedger} from "../../../interfaces/IShortfallLedger.sol";
import {
    MissingRole,
    NotAContract,
    ZeroAddress
} from "../../../errors/StandardErrors.sol";
import {ViewAccessLib} from "../../../libraries/ViewAccessLib.sol";

/**
 * @title LendingEngineView
 * @notice View module for order-centric lending-engine reads.
 * @dev This module is decoupled from the core engine and resolves dependencies via Registry.
 *      Architecture-Guide alignment:
 *      - View layer only exposes read/cache/aggregation helpers and must not perform business writes.
 *      - Order lifecycle state-machine writes remain in ORDER_ENGINE / SettlementManager.
 *      - This module is the order-level read facade for explicit lifecycle status, while LoanNFTView
 *        remains the user-enumeration facade (user -> tokenIds -> orderId/status).
 *
 * Reverts if:
 * - registry is zero / not a contract (ZeroAddress / NotAContract)
 * - caller lacks required role for a gated read (MissingRole)
 *
 * Security:
 * - View-only module: this module does not perform business writes.
 * - UUPS upgradeability is role-gated (ACTION_ADMIN via ACM).
 */
contract LendingEngineView is Initializable, UUPSUpgradeable, ViewVersioned {
    struct OrderStateSnapshot {
        IOrderStateStoreV2.OrderProductType productType;
        IOrderStateStoreV2.LifecycleStatus lifecycle;
        IOrderStateStoreV2.CloseReason closeReason;
        IShortfallLedger.ShortfallStatus shortfallStatus;
        IOrderStateStoreV2.CollateralDispositionStatus collateralDisposition;
        bool hasLoss;
        uint256 createdBlock;
        uint256 updatedBlock;
        uint256 closedBlock;
    }

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    /// @notice Registry contract address (internal use only).
    address private _registryAddr;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /// @dev Gate for ops/system-level diagnostics reads.
    modifier onlyOps() {
        if (
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_VIEW_SYSTEM_DATA,
                msg.sender
            ) &&
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_ADMIN,
                msg.sender
            )
        ) revert MissingRole();
        _;
    }

    /// @dev Gate for user-scoped reads (caller must be the user, or have VIEW_USER_DATA / ADMIN).
    modifier onlyAuthorizedUser(address user) {
        if (
            msg.sender != user &&
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_VIEW_USER_DATA,
                msg.sender
            ) &&
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_ADMIN,
                msg.sender
            )
        ) revert MissingRole();
        _;
    }

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the LendingEngineView (UUPS).
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (ZeroAddress)
     *      - initialRegistryAddr is not a contract (NotAContract)
     *
     * Security:
     * - Initializer: callable once.
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

    /*━━━━━━━━━━━━━━━ Read APIs ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get a loan order snapshot for off-chain display.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not authorized to view the order (MissingRole)
     *
     * Security:
     * - View-only.
     *
     * @param orderId Engine order identifier
     * @return order Loan order struct snapshot (see IOrderEngine.LoanOrder)
     */
    function getLoanOrder(
        uint256 orderId
    )
        external
        view
        onlyValidRegistry
        returns (IOrderEngine.LoanOrder memory order)
    {
        return _getAuthorizedLoanOrder(orderId);
    }

    /**
     * @notice Get the explicit business lifecycle status for a loan order.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not authorized to view the order (MissingRole)
     *      - the underlying adapter rejects the order as invalid
     *
     * Architecture-Guide alignment:
     * - This is a read-only projection of the ORDER_ENGINE / LoanNFT lifecycle SSOT.
     * - It must not be treated as a write hook or secondary lifecycle owner.
     * - Downstream consumers should prefer this explicit status over inferring closed state from
     *   repaidAmount, debt-ledger deltas, or liquidation side effects.
     *
     * Security:
     * - View-only.
     *
     * @param orderId Engine order identifier
     * @return status Loan lifecycle status from the ORDER_ENGINE / LoanNFT SSOT
     */
    function getOrderStatus(
        uint256 orderId
    ) external view onlyValidRegistry returns (ILoanNFT.LoanStatus status) {
        _getAuthorizedLoanOrder(orderId);
        return _engine().getOrderStatusForView(orderId);
    }

    function getOrderStateSnapshot(
        uint256 orderId
    )
        external
        view
        onlyValidRegistry
        returns (OrderStateSnapshot memory snapshot)
    {
        IOrderEngine.LoanOrder memory order = _getAuthorizedLoanOrder(orderId);
        (
            IOrderStateStoreV2 orderStateStore,
            bool hasOrderStateStore
        ) = _tryOrderStateStore();
        if (hasOrderStateStore) {
            // Some live deployments may still bind a legacy order-state module
            // that does not implement v2 selectors. In that case, fallback to
            // the legacy snapshot path instead of bubbling an empty revert.
            try
                orderStateStore.hasOrderState(
                    IOrderStateStoreV2.OrderProductType.LOAN,
                    orderId
                )
            returns (bool hasState) {
                if (hasState) {
                    try
                        orderStateStore.getOrderState(
                            IOrderStateStoreV2.OrderProductType.LOAN,
                            orderId
                        )
                    returns (IOrderStateStoreV2.OrderState memory state) {
                        return _toOrderStateSnapshot(state);
                    } catch {
                        // Fallback to legacy status composition.
                        uint256 noop = 0;
                        noop;
                    }
                }
            } catch {
                // Fallback to legacy status composition.
                uint256 noop = 0;
                noop;
            }
        }

        return _buildLegacyOrderStateSnapshot(orderId, order);
    }

    /**
     * @notice Get the accumulated failed fee amount for an order (ops diagnostics).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks VIEW_SYSTEM_DATA / ADMIN (MissingRole via onlyOps)
     *
     * Security:
     * - View-only.
     *
     * @param orderId Engine order identifier
     * @return feeAmount Failed fee amount (engine-defined units/decimals)
     */
    function getFailedFeeAmount(
        uint256 orderId
    ) external view onlyValidRegistry onlyOps returns (uint256 feeAmount) {
        return _engine().getFailedFeeAmountForView(orderId);
    }

    /**
     * @notice Get the NFT mint retry count for an order (ops diagnostics).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks VIEW_SYSTEM_DATA / ADMIN (MissingRole via onlyOps)
     *
     * Security:
     * - View-only.
     *
     * @param orderId Engine order identifier
     * @return retryCount Retry count
     */
    function getNftRetryCount(
        uint256 orderId
    ) external view onlyValidRegistry onlyOps returns (uint256 retryCount) {
        return _engine().getNftRetryCountForView(orderId);
    }

    /**
     * @notice Check whether a user can access a given loan order, with metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks VIEW_USER_DATA / ADMIN (MissingRole via onlyAuthorizedUser)
     *
     * Security:
     * - View-only.
     *
     * @param orderId Engine order identifier
     * @param user Target user address
     * @return hasAccess Whether the user is allowed to view the order
     * @return isValid Whether the read succeeded
     * @return blockNumber Read block number (block.number)
     */
    function canAccessLoanOrder(
        uint256 orderId,
        address user
    )
        external
        view
        onlyValidRegistry
        onlyAuthorizedUser(user)
        returns (bool hasAccess, bool isValid, uint256 blockNumber)
    {
        if (user == address(0)) return (false, true, _now());
        IOrderEngine.LoanOrder memory order = _engine().getLoanOrderForView(
            orderId
        );
        hasAccess =
            (order.borrower != address(0) && user == order.borrower) ||
            (order.lender != address(0) && user == order.lender) ||
            _isCurrentLoanNftOwner(orderId, user);
        return (hasAccess, true, _now());
    }

    /**
     * @notice Check whether an account is the match engine (ops diagnostics).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks VIEW_SYSTEM_DATA / ADMIN (MissingRole via onlyOps)
     *
     * Security:
     * - View-only.
     *
     * @param account Account address to check
     * @return isMatch Whether the account is the match engine
     */
    function isMatchEngine(
        address account
    ) external view onlyValidRegistry onlyOps returns (bool isMatch) {
        return _engine().isMatchEngineForView(account);
    }

    /**
     * @notice Convenience helper to read the Registry address from the underlying engine adapter (ops only).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks VIEW_SYSTEM_DATA / ADMIN (MissingRole via onlyOps)
     *
     * Security:
     * - View-only.
     *
     * @return registry Registry contract address as reported by the engine adapter.
     */
    function getRegistryFromEngine()
        external
        view
        onlyValidRegistry
        onlyOps
        returns (address registry)
    {
        return _engine().getRegistryForView();
    }

    /**
     * @notice Return the Registry contract address.
     * @dev This getter may return address(0) if the contract is not initialized.
     *
     * Security:
     * - View-only.
     *
     * @return registryAddrVar Registry contract address.
     */
    function getRegistry() external view returns (address registryAddrVar) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/

    /// @dev View-only block helper for meta outputs (not used for state changes).
    function _now() internal view returns (uint256) {
        return block.number;
    }

    function _engine() internal view returns (IOrderEngineViewAdapter) {
        address engineAddr = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ORDER_ENGINE
        );
        return IOrderEngineViewAdapter(engineAddr);
    }

    function _tryOrderStateStore()
        internal
        view
        returns (IOrderStateStoreV2 orderStateStore, bool hasStore)
    {
        address orderStateStoreAddr = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_ORDER_STATE_STORE
        );
        if (
            orderStateStoreAddr == address(0) ||
            orderStateStoreAddr.code.length == 0
        ) {
            return (IOrderStateStoreV2(address(0)), false);
        }

        return (IOrderStateStoreV2(orderStateStoreAddr), true);
    }

    function _getAuthorizedLoanOrder(
        uint256 orderId
    ) internal view returns (IOrderEngine.LoanOrder memory order) {
        // Permission alignment: allow borrower/lender access, or ops/admin (VIEW_USER_DATA / ADMIN).
        bool isOps = ViewAccessLib.hasRole(
            _registryAddr,
            ActionKeys.ACTION_VIEW_USER_DATA,
            msg.sender
        ) ||
            ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_ADMIN,
                msg.sender
            );

        // Treat adapter as a data source; enforce borrower/lender access at the view boundary.
        order = _engine().getLoanOrderForView(orderId);
        bool isBorrower = order.borrower != address(0) &&
            msg.sender == order.borrower;
        bool isLender = order.lender != address(0) &&
            msg.sender == order.lender;
        bool isCurrentLoanNftOwner = _isCurrentLoanNftOwner(
            orderId,
            msg.sender
        );
        if (!isOps && !isBorrower && !isLender && !isCurrentLoanNftOwner)
            revert MissingRole();
        return order;
    }

    function _isCurrentLoanNftOwner(
        uint256 orderId,
        address viewer
    ) internal view returns (bool) {
        if (viewer == address(0)) return false;

        address loanNftAddr = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_LOAN_NFT
        );
        if (loanNftAddr == address(0) || loanNftAddr.code.length == 0)
            return false;

        try ILoanNFT(loanNftAddr).getUserTokens(viewer) returns (
            uint256[] memory tokenIds
        ) {
            for (uint256 i; i < tokenIds.length; ) {
                try ILoanNFT(loanNftAddr).getLoanMetadata(tokenIds[i]) returns (
                    ILoanNFT.LoanMetadata memory metadata
                ) {
                    if (metadata.loanId == orderId) return true;
                    // solhint-disable-next-line no-empty-blocks
                } catch {
                    // Best-effort owner lookup: skip broken token metadata instead of blocking reads.
                }
                unchecked {
                    ++i;
                }
            }
        } catch {
            return false;
        }

        return false;
    }

    function _toOrderStateSnapshot(
        IOrderStateStoreV2.OrderState memory state
    ) internal pure returns (OrderStateSnapshot memory snapshot) {
        return
            OrderStateSnapshot({
                productType: state.productType,
                lifecycle: state.lifecycle,
                closeReason: state.closeReason,
                shortfallStatus: state.shortfallStatus,
                collateralDisposition: state.collateralDisposition,
                hasLoss: state.shortfallStatus !=
                    IShortfallLedger.ShortfallStatus.NONE,
                createdBlock: state.createdBlock,
                updatedBlock: state.updatedBlock,
                closedBlock: state.closedBlock
            });
    }

    function _buildLegacyOrderStateSnapshot(
        uint256 orderId,
        IOrderEngine.LoanOrder memory order
    ) internal view returns (OrderStateSnapshot memory snapshot) {
        ILoanNFT.LoanStatus status = _engine().getOrderStatusForView(orderId);
        IShortfallLedger.ShortfallStatus shortfallStatus = _legacyShortfallStatus(
                orderId
            );
        IOrderStateStoreV2.LifecycleStatus lifecycle = IOrderStateStoreV2
            .LifecycleStatus
            .ACTIVE;
        IOrderStateStoreV2.CloseReason closeReason = IOrderStateStoreV2
            .CloseReason
            .NONE;
        IOrderStateStoreV2.CollateralDispositionStatus collateralDisposition = IOrderStateStoreV2
                .CollateralDispositionStatus
                .NONE;

        if (status == ILoanNFT.LoanStatus.Repaid) {
            lifecycle = IOrderStateStoreV2.LifecycleStatus.REPAID;
            closeReason = IOrderStateStoreV2.CloseReason.FULL_REPAY;
        } else if (
            status == ILoanNFT.LoanStatus.Liquidated ||
            status == ILoanNFT.LoanStatus.LiquidatedWithShortfall
        ) {
            lifecycle = IOrderStateStoreV2.LifecycleStatus.LIQUIDATED;
            closeReason = IOrderStateStoreV2.CloseReason.KEEPER_LIQUIDATION;
            collateralDisposition = IOrderStateStoreV2
                .CollateralDispositionStatus
                .SEIZED_AND_DISTRIBUTED;
        } else if (
            status == ILoanNFT.LoanStatus.Defaulted ||
            status == ILoanNFT.LoanStatus.DefaultedWithShortfall
        ) {
            lifecycle = IOrderStateStoreV2.LifecycleStatus.DEFAULTED;
            closeReason = IOrderStateStoreV2.CloseReason.MATURITY_DEFAULT;
            collateralDisposition = IOrderStateStoreV2
                .CollateralDispositionStatus
                .SEIZED_AND_DISTRIBUTED;
        }

        return
            OrderStateSnapshot({
                productType: IOrderStateStoreV2.OrderProductType.LOAN,
                lifecycle: lifecycle,
                closeReason: closeReason,
                shortfallStatus: shortfallStatus,
                collateralDisposition: collateralDisposition,
                hasLoss: shortfallStatus !=
                    IShortfallLedger.ShortfallStatus.NONE,
                createdBlock: order.startTimestamp,
                updatedBlock: order.startTimestamp,
                closedBlock: 0
            });
    }

    function _legacyShortfallStatus(
        uint256 orderId
    ) internal view returns (IShortfallLedger.ShortfallStatus shortfallStatus) {
        address settlementManagerAddr = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_SETTLEMENT_MANAGER
        );
        if (
            settlementManagerAddr == address(0) ||
            settlementManagerAddr.code.length == 0
        ) {
            return IShortfallLedger.ShortfallStatus.NONE;
        }

        try
            IShortfallLedger(settlementManagerAddr).getShortfallLedger(orderId)
        returns (IShortfallLedger.ShortfallLedger memory ledger) {
            return ledger.status;
        } catch {
            return IShortfallLedger.ShortfallStatus.NONE;
        }
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal view override onlyValidRegistry {
        if (
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_ADMIN,
                msg.sender
            )
        ) {
            revert MissingRole();
        }
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0)
            revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ Versioning (C+B baseline) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Return the API semantic version for this module.
     * @dev Reverts if: (never)
     *
     * Security:
     * - Pure function.
     *
     * @return version API semantic version.
     */
    function apiVersion() public pure override returns (uint256 version) {
        // v2: adds explicit order lifecycle status read via getOrderStatus(orderId).
        return 2;
    }

    /**
     * @notice Return the schema version for this module's outputs.
     * @dev Reverts if: (never)
     *
     * Security:
     * - Pure function.
     *
     * @return version Schema version.
     */
    function schemaVersion() public pure override returns (uint256 version) {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/

    uint256[50] private __gap;
}
