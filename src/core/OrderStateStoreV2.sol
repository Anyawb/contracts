// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {ActionKeys} from "../constants/ActionKeys.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {NotAContract, ZeroAddress} from "../errors/StandardErrors.sol";
import {IAccessControlManager} from "../interfaces/IAccessControlManager.sol";
import {IOrderEngine} from "../interfaces/IOrderEngine.sol";
import {IOrderEngineViewAdapter} from "../interfaces/IOrderEngineViewAdapter.sol";
import {ILoanNFT} from "../interfaces/ILoanNFT.sol";
import {IOrderStateStoreV2} from "../interfaces/IOrderStateStoreV2.sol";
import {IRegistry} from "../interfaces/IRegistry.sol";
import {IShortfallLedger} from "../interfaces/IShortfallLedger.sol";

contract OrderStateStoreV2 is Initializable, UUPSUpgradeable, IOrderStateStoreV2 {
    address private _registryAddr;

    mapping(uint8 productType => mapping(uint256 orderId => OrderState orderState))
        private _orderStates;

    error OrderStateStoreV2__AlreadyInitialized(
        OrderProductType productType,
        uint256 orderId
    );
    error OrderStateStoreV2__MissingOrder(
        OrderProductType productType,
        uint256 orderId
    );
    error OrderStateStoreV2__UnauthorizedWriter(address caller);
    error OrderStateStoreV2__InvalidLifecycleTransition(
        OrderProductType productType,
        uint256 orderId,
        LifecycleStatus fromLifecycle,
        LifecycleStatus toLifecycle
    );
    error OrderStateStoreV2__InvalidCloseReason(
        OrderProductType productType,
        uint256 orderId,
        CloseReason closeReason
    );
    error OrderStateStoreV2__InvalidCollateralDisposition(
        OrderProductType productType,
        uint256 orderId,
        CollateralDispositionStatus collateralDisposition
    );
    error OrderStateStoreV2__InvalidImplementation();

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    modifier onlyOrderEngine() {
        _requireModuleCaller(ModuleKeys.KEY_ORDER_ENGINE);
        _;
    }

    modifier onlySettlementManager() {
        _requireModuleCaller(ModuleKeys.KEY_SETTLEMENT_MANAGER);
        _;
    }

    modifier onlyBlocksOnlyCoordinator() {
        _requireModuleCaller(ModuleKeys.KEY_BLOCKS_ONLY_COORDINATOR);
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);

        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    function initializeLoanOrderState(
        uint256 orderId,
        uint256 createdBlockHint
    ) external onlyValidRegistry onlyOrderEngine {
        _initializeState(
            OrderProductType.LOAN,
            orderId,
            createdBlockHint,
            LifecycleStatus.ACTIVE,
            CollateralDispositionStatus.NONE
        );
    }

    function initializeBlocksOnlyOrderState(
        uint256 orderId,
        uint256 createdBlockHint
    ) external onlyValidRegistry onlyBlocksOnlyCoordinator {
        _initializeState(
            OrderProductType.BLOCKS_ONLY,
            orderId,
            createdBlockHint,
            LifecycleStatus.ACTIVE,
            CollateralDispositionStatus.COORDINATOR_CUSTODY
        );
    }

    function markLoanRepaid(
        uint256 orderId,
        uint256 createdBlockHint
    ) external onlyValidRegistry onlyOrderEngine {
        OrderState storage state = _bootstrapLoanState(orderId, createdBlockHint);
        if (state.lifecycle != LifecycleStatus.ACTIVE) {
            revert OrderStateStoreV2__InvalidLifecycleTransition(
                OrderProductType.LOAN,
                orderId,
                state.lifecycle,
                LifecycleStatus.REPAID
            );
        }

        _setLifecycle(
            OrderProductType.LOAN,
            orderId,
            state,
            LifecycleStatus.REPAID,
            CloseReason.FULL_REPAY,
            block.number
        );
    }

    function markBlocksOnlyRepaid(
        uint256 orderId,
        uint256 createdBlockHint
    ) external onlyValidRegistry onlyBlocksOnlyCoordinator {
        OrderState storage state = _bootstrapBlocksOnlyState(
            orderId,
            createdBlockHint
        );
        if (state.lifecycle != LifecycleStatus.ACTIVE) {
            revert OrderStateStoreV2__InvalidLifecycleTransition(
                OrderProductType.BLOCKS_ONLY,
                orderId,
                state.lifecycle,
                LifecycleStatus.REPAID
            );
        }

        _setLifecycle(
            OrderProductType.BLOCKS_ONLY,
            orderId,
            state,
            LifecycleStatus.REPAID,
            CloseReason.NONE,
            0
        );
    }

    function applyLoanTerminalTransition(
        uint256 orderId,
        uint256 createdBlockHint,
        LifecycleStatus lifecycle,
        CloseReason closeReason,
        IShortfallLedger.ShortfallStatus shortfallStatus,
        CollateralDispositionStatus collateralDisposition
    ) external onlyValidRegistry onlySettlementManager {
        if (
            lifecycle != LifecycleStatus.LIQUIDATED &&
            lifecycle != LifecycleStatus.DEFAULTED
        ) {
            revert OrderStateStoreV2__InvalidLifecycleTransition(
                OrderProductType.LOAN,
                orderId,
                LifecycleStatus.ACTIVE,
                lifecycle
            );
        }
        if (
            closeReason != CloseReason.KEEPER_LIQUIDATION &&
            closeReason != CloseReason.MATURITY_DEFAULT
        ) {
            revert OrderStateStoreV2__InvalidCloseReason(
                OrderProductType.LOAN,
                orderId,
                closeReason
            );
        }
        if (
            collateralDisposition !=
            CollateralDispositionStatus.SEIZED_AND_DISTRIBUTED
        ) {
            revert OrderStateStoreV2__InvalidCollateralDisposition(
                OrderProductType.LOAN,
                orderId,
                collateralDisposition
            );
        }

        OrderState storage state = _bootstrapLoanState(orderId, createdBlockHint);
        if (state.lifecycle != LifecycleStatus.ACTIVE) {
            revert OrderStateStoreV2__InvalidLifecycleTransition(
                OrderProductType.LOAN,
                orderId,
                state.lifecycle,
                lifecycle
            );
        }

        _setCollateralDisposition(
            OrderProductType.LOAN,
            orderId,
            state,
            collateralDisposition
        );
        _setShortfallStatus(
            OrderProductType.LOAN,
            orderId,
            state,
            shortfallStatus
        );
        _setLifecycle(
            OrderProductType.LOAN,
            orderId,
            state,
            lifecycle,
            closeReason,
            block.number
        );
    }

    function applyBlocksOnlyCloseTransition(
        uint256 orderId,
        uint256 createdBlockHint,
        CloseReason closeReason,
        CollateralDispositionStatus collateralDisposition
    ) external onlyValidRegistry onlyBlocksOnlyCoordinator {
        if (
            closeReason != CloseReason.BLOCKS_TRADE_CLOSE &&
            closeReason != CloseReason.BLOCKS_MATURITY_CLOSE
        ) {
            revert OrderStateStoreV2__InvalidCloseReason(
                OrderProductType.BLOCKS_ONLY,
                orderId,
                closeReason
            );
        }
        if (
            collateralDisposition !=
            CollateralDispositionStatus.RETURNED_TO_BORROWER &&
            collateralDisposition !=
            CollateralDispositionStatus.DELIVERED_TO_LENDER
        ) {
            revert OrderStateStoreV2__InvalidCollateralDisposition(
                OrderProductType.BLOCKS_ONLY,
                orderId,
                collateralDisposition
            );
        }

        OrderState storage state = _bootstrapBlocksOnlyState(
            orderId,
            createdBlockHint
        );
        if (
            state.lifecycle != LifecycleStatus.ACTIVE &&
            state.lifecycle != LifecycleStatus.REPAID
        ) {
            revert OrderStateStoreV2__InvalidLifecycleTransition(
                OrderProductType.BLOCKS_ONLY,
                orderId,
                state.lifecycle,
                LifecycleStatus.CLOSED
            );
        }

        _setCollateralDisposition(
            OrderProductType.BLOCKS_ONLY,
            orderId,
            state,
            collateralDisposition
        );
        _setLifecycle(
            OrderProductType.BLOCKS_ONLY,
            orderId,
            state,
            LifecycleStatus.CLOSED,
            closeReason,
            block.number
        );
    }

    /**
     * @notice Sync shortfall status for an existing loan order state.
     * @dev Reverts if:
     *      - registry is invalid
     *      - caller is not the registered SettlementManager module
     *
     * Security:
        * - Missing state is compensated only when ORDER_ENGINE already exposes a terminal lifecycle
        *   (`Liquidated*` / `Defaulted*`); this avoids reconstructing a fake ACTIVE lifecycle from
        *   shortfall-only updates while still repairing state holes caused by temporary store unavailability.
        * - `createdBlockHint` is used as bootstrap compatibility hint when compensation is required.
     *
     * @param orderId Loan order identifier
     * @param createdBlockHint Historical compatibility hint (reserved)
     * @param shortfallStatus Shortfall status sourced from SettlementManager
     */
    function syncLoanShortfallState(
        uint256 orderId,
        uint256 createdBlockHint,
        IShortfallLedger.ShortfallStatus shortfallStatus
    ) external onlyValidRegistry onlySettlementManager {
        if (!_hasState(OrderProductType.LOAN, orderId)) {
            if (
                !_compensateMissingLoanTerminalState(
                    orderId,
                    createdBlockHint,
                    shortfallStatus
                )
            ) {
                return;
            }
            return;
        }

        OrderState storage state = _orderStates[uint8(OrderProductType.LOAN)][
            orderId
        ];
        _setShortfallStatus(
            OrderProductType.LOAN,
            orderId,
            state,
            shortfallStatus
        );
    }

    function _compensateMissingLoanTerminalState(
        uint256 orderId,
        uint256 createdBlockHint,
        IShortfallLedger.ShortfallStatus shortfallStatus
    ) internal returns (bool compensated) {
        address orderEngineAddr = IRegistry(_registryAddr).getModule(
            ModuleKeys.KEY_ORDER_ENGINE
        );
        if (orderEngineAddr == address(0) || orderEngineAddr.code.length == 0) {
            return false;
        }

        IOrderEngine.LoanOrder memory order;
        ILoanNFT.LoanStatus orderStatus;

        try
            IOrderEngineViewAdapter(orderEngineAddr).getLoanOrderForView(orderId)
        returns (IOrderEngine.LoanOrder memory readOrder) {
            order = readOrder;
        } catch {
            return false;
        }

        try
            IOrderEngineViewAdapter(orderEngineAddr).getOrderStatusForView(orderId)
        returns (ILoanNFT.LoanStatus status) {
            orderStatus = status;
        } catch {
            return false;
        }

        LifecycleStatus lifecycle;
        CloseReason closeReason;
        if (
            orderStatus == ILoanNFT.LoanStatus.Liquidated ||
            orderStatus == ILoanNFT.LoanStatus.LiquidatedWithShortfall
        ) {
            lifecycle = LifecycleStatus.LIQUIDATED;
            closeReason = CloseReason.KEEPER_LIQUIDATION;
        } else if (
            orderStatus == ILoanNFT.LoanStatus.Defaulted ||
            orderStatus == ILoanNFT.LoanStatus.DefaultedWithShortfall
        ) {
            lifecycle = LifecycleStatus.DEFAULTED;
            closeReason = CloseReason.MATURITY_DEFAULT;
        } else {
            return false;
        }

        uint256 createdBlock = createdBlockHint;
        if (createdBlock == 0) {
            createdBlock = order.startTimestamp == 0
                ? block.number
                : order.startTimestamp;
        }

        _initializeState(
            OrderProductType.LOAN,
            orderId,
            createdBlock,
            LifecycleStatus.ACTIVE,
            CollateralDispositionStatus.NONE
        );

        OrderState storage state = _orderStates[uint8(OrderProductType.LOAN)][
            orderId
        ];
        _setCollateralDisposition(
            OrderProductType.LOAN,
            orderId,
            state,
            CollateralDispositionStatus.SEIZED_AND_DISTRIBUTED
        );
        _setShortfallStatus(
            OrderProductType.LOAN,
            orderId,
            state,
            shortfallStatus
        );
        _setLifecycle(
            OrderProductType.LOAN,
            orderId,
            state,
            lifecycle,
            closeReason,
            block.number
        );

        return true;
    }

    function hasOrderState(
        OrderProductType productType,
        uint256 orderId
    ) external view returns (bool hasState) {
        return _hasState(productType, orderId);
    }

    function getOrderState(
        OrderProductType productType,
        uint256 orderId
    ) external view returns (OrderState memory orderState) {
        return _orderStates[uint8(productType)][orderId];
    }

    function getLegacyLoanStatus(
        uint256 orderId
    ) external view returns (ILoanNFT.LoanStatus status) {
        if (!_hasState(OrderProductType.LOAN, orderId)) {
            revert OrderStateStoreV2__MissingOrder(OrderProductType.LOAN, orderId);
        }
        return _mapLoanStateToLegacy(_orderStates[uint8(OrderProductType.LOAN)][orderId]);
    }

    function getRegistry() external view returns (address registryAddr) {
        return _registryAddr;
    }

    function _authorizeUpgrade(address newImplementation) internal view override {
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) {
            revert OrderStateStoreV2__InvalidImplementation();
        }

        address acm = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ACCESS_CONTROL
        );
        IAccessControlManager(acm).requireRole(
            ActionKeys.ACTION_UPGRADE_MODULE,
            msg.sender
        );
    }

    function _initializeState(
        OrderProductType productType,
        uint256 orderId,
        uint256 createdBlockHint,
        LifecycleStatus lifecycle,
        CollateralDispositionStatus collateralDisposition
    ) internal {
        if (_hasState(productType, orderId)) {
            revert OrderStateStoreV2__AlreadyInitialized(productType, orderId);
        }

        uint256 createdBlock = createdBlockHint == 0
            ? block.number
            : createdBlockHint;
        _orderStates[uint8(productType)][orderId] = OrderState({
            productType: productType,
            lifecycle: lifecycle,
            closeReason: CloseReason.NONE,
            shortfallStatus: IShortfallLedger.ShortfallStatus.NONE,
            collateralDisposition: collateralDisposition,
            createdBlock: createdBlock,
            updatedBlock: block.number,
            closedBlock: 0
        });

        emit OrderStateInitialized(
            productType,
            orderId,
            lifecycle,
            collateralDisposition,
            createdBlock
        );
    }

    function _bootstrapLoanState(
        uint256 orderId,
        uint256 createdBlockHint
    ) internal returns (OrderState storage state) {
        if (!_hasState(OrderProductType.LOAN, orderId)) {
            _initializeState(
                OrderProductType.LOAN,
                orderId,
                createdBlockHint,
                LifecycleStatus.ACTIVE,
                CollateralDispositionStatus.NONE
            );
        }
        state = _orderStates[uint8(OrderProductType.LOAN)][orderId];
    }

    function _bootstrapBlocksOnlyState(
        uint256 orderId,
        uint256 createdBlockHint
    ) internal returns (OrderState storage state) {
        if (!_hasState(OrderProductType.BLOCKS_ONLY, orderId)) {
            _initializeState(
                OrderProductType.BLOCKS_ONLY,
                orderId,
                createdBlockHint,
                LifecycleStatus.ACTIVE,
                CollateralDispositionStatus.COORDINATOR_CUSTODY
            );
        }
        state = _orderStates[uint8(OrderProductType.BLOCKS_ONLY)][orderId];
    }

    function _setLifecycle(
        OrderProductType productType,
        uint256 orderId,
        OrderState storage state,
        LifecycleStatus newLifecycle,
        CloseReason closeReason,
        uint256 closedBlock
    ) internal {
        LifecycleStatus previousLifecycle = state.lifecycle;
        state.lifecycle = newLifecycle;
        state.closeReason = closeReason;
        state.updatedBlock = block.number;
        state.closedBlock = closedBlock;

        emit OrderLifecycleTransitioned(
            productType,
            orderId,
            previousLifecycle,
            newLifecycle,
            closeReason,
            closedBlock,
            state.updatedBlock
        );
    }

    function _setShortfallStatus(
        OrderProductType productType,
        uint256 orderId,
        OrderState storage state,
        IShortfallLedger.ShortfallStatus newShortfallStatus
    ) internal {
        IShortfallLedger.ShortfallStatus previousStatus = state.shortfallStatus;
        if (previousStatus == newShortfallStatus) {
            return;
        }

        state.shortfallStatus = newShortfallStatus;
        state.updatedBlock = block.number;

        emit OrderShortfallStateChanged(
            productType,
            orderId,
            previousStatus,
            newShortfallStatus,
            state.updatedBlock
        );
    }

    function _setCollateralDisposition(
        OrderProductType productType,
        uint256 orderId,
        OrderState storage state,
        CollateralDispositionStatus newDisposition
    ) internal {
        CollateralDispositionStatus previousDisposition = state
            .collateralDisposition;
        if (previousDisposition == newDisposition) {
            return;
        }

        state.collateralDisposition = newDisposition;
        state.updatedBlock = block.number;

        emit OrderCollateralDispositionChanged(
            productType,
            orderId,
            previousDisposition,
            newDisposition,
            state.updatedBlock
        );
    }

    function _hasState(
        OrderProductType productType,
        uint256 orderId
    ) internal view returns (bool hasState) {
        return _orderStates[uint8(productType)][orderId].productType != OrderProductType.NONE;
    }

    function _mapLoanStateToLegacy(
        OrderState memory state
    ) internal pure returns (ILoanNFT.LoanStatus status) {
        if (state.lifecycle == LifecycleStatus.REPAID) {
            return ILoanNFT.LoanStatus.Repaid;
        }
        if (state.lifecycle == LifecycleStatus.LIQUIDATED) {
            return state.shortfallStatus == IShortfallLedger.ShortfallStatus.NONE
                ? ILoanNFT.LoanStatus.Liquidated
                : ILoanNFT.LoanStatus.LiquidatedWithShortfall;
        }
        if (state.lifecycle == LifecycleStatus.DEFAULTED) {
            return state.shortfallStatus == IShortfallLedger.ShortfallStatus.NONE
                ? ILoanNFT.LoanStatus.Defaulted
                : ILoanNFT.LoanStatus.DefaultedWithShortfall;
        }
        return ILoanNFT.LoanStatus.Active;
    }

    function _requireModuleCaller(bytes32 moduleKey) internal view {
        address module = IRegistry(_registryAddr).getModule(moduleKey);
        if (msg.sender != module || module == address(0)) {
            revert OrderStateStoreV2__UnauthorizedWriter(msg.sender);
        }
    }
}