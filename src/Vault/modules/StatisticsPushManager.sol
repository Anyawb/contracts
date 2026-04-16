// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import {Registry} from "../../registry/Registry.sol";
import {ModuleKeys} from "../../constants/ModuleKeys.sol";
import {ActionKeys} from "../../constants/ActionKeys.sol";
import {CacheEvents} from "../CacheEvents.sol";
import {ViewConstants} from "../view/ViewConstants.sol";
import {IAccessControlManager} from "../../interfaces/IAccessControlManager.sol";
import {ILendingEngineDebtRead} from "../../interfaces/ILendingEngineDebtRead.sol";
import {IGuaranteeFundManager} from "../../interfaces/IGuaranteeFundManager.sol";
import {IPositionViewValuation} from "../../interfaces/IPositionViewValuation.sol";
import {
    MissingRole,
    NotAContract,
    ZeroAddress
} from "../../errors/StandardErrors.sol";

/// @title IStatisticsViewSnapshotMinimal
/// @notice Minimal snapshot interface for StatisticsView push operations.
/// @dev Used by {StatisticsPushManager} to read optimistic-concurrency versions and push user or guarantee snapshots.
interface IStatisticsViewSnapshotMinimal {
    /// @notice Returns the current user statistics version expected by the pusher.
    function getUserStatsVersionForPusher(
        address user
    ) external view returns (uint64);

    /// @notice Returns the current guarantee snapshot version expected by the pusher.
    function getGuaranteeVersionForPusher(
        address user,
        address asset
    ) external view returns (uint64);

    /// @notice Pushes one user statistics snapshot.
    function pushUserStatsSnapshot(
        address user,
        uint256 collateralValue,
        uint256 debtValue,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external;

    /// @notice Pushes one guarantee snapshot.
    function pushGuaranteeSnapshot(
        address user,
        address asset,
        uint256 userBalance,
        uint256 totalByAsset,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external;
}

/**
 * @title StatisticsPushManager
 * @notice Pushes authoritative StatisticsView snapshots through best-effort orchestration paths.
 * @dev Reverts if:
 *      - see individual functions
 *
 * Security:
 * - Single on-chain entrypoint for StatisticsView snapshot pushes.
 * - Reads SSOT state only and does not write ledger state.
 * - Generates seq, requestId, and nextVersion deterministically for retryable optimistic concurrency.
 * - Push failures emit CacheUpdateFailedWithContext and must not block ledger writes.
 * - Sequence numbers are maintained independently for user stats keys and guarantee keys.
 */
contract StatisticsPushManager is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    CacheEvents
{
    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/
    address private _registryAddr;

    mapping(address => uint64) private _userStatsSeq;
    mapping(address => mapping(address => uint64)) private _guaranteeSeq;

    /*━━━━━━━━━━━━━━━ Constants ━━━━━━━━━━━━━━━*/
    // Keep a small guardrail for any bounded enumeration/loops in the future.
    uint256 internal constant _MAX_ENUMERATION = ViewConstants.MAX_BATCH_SIZE;

    /*━━━━━━━━━━━━━━━ Constructor / Initializer ━━━━━━━━━━━━━━━*/
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /*━━━━━━━━━━━━━━━ Public Notify APIs ━━━━━━━━━━━━━━━*/
    /**
     * @notice Push a refreshed user statistics snapshot after a ledger-affecting write.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - caller is not an authorized notifier (MissingRole)
     *
     *      Internal push failures are handled on a best-effort basis: the function emits
     *      CacheUpdateFailedWithContext and returns without reverting the caller's broader flow.
     *
     * Security:
     * - Restricted to SSOT ledger and orchestration modules via `_requireNotifier()`.
     */
    function notifyUserStats(
        address user
    ) external onlyValidRegistry nonReentrant {
        _requireNotifier(msg.sender);
        _pushUserStatsSnapshotBestEffort(user);
    }

    /**
     * @notice Push a refreshed guarantee snapshot after a guarantee-balance write.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - caller is not an authorized notifier (MissingRole)
     *
     *      Internal push failures are handled on a best-effort basis: the function emits
     *      CacheUpdateFailedWithContext and returns without reverting the caller's broader flow.
     *
     * Security:
     * - Restricted to SSOT ledger and orchestration modules via `_requireNotifier()`.
     */
    function notifyGuarantee(
        address user,
        address asset
    ) external onlyValidRegistry nonReentrant {
        _requireNotifier(msg.sender);
        _pushGuaranteeSnapshotBestEffort(user, asset);
    }

    /*━━━━━━━━━━━━━━━ Retry APIs (role-gated) ━━━━━━━━━━━━━━━*/
    /**
     * @notice Retry a user statistics snapshot push by recomputing SSOT state and replaying the update.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_PUSH (propagated)
     *
     *      Internal push failures are handled on a best-effort basis: the function emits
     *      CacheUpdateFailedWithContext and returns.
     *
     * Security:
     * - Retry entrypoint for keepers and off-chain repair services.
     */
    function retryUserStats(
        address user
    ) external onlyValidRegistry nonReentrant {
        _requireRole(ActionKeys.ACTION_VIEW_PUSH, msg.sender);
        _pushUserStatsSnapshotBestEffort(user);
    }

    /**
     * @notice Retry a guarantee snapshot push by recomputing SSOT state and replaying the update.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract
     *        (ZeroAddress / NotAContract) (via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_PUSH (propagated)
     *
     *      Internal push failures are handled on a best-effort basis: the function emits
     *      CacheUpdateFailedWithContext and returns.
     *
     * Security:
     * - Retry entrypoint for keepers and off-chain repair services.
     */
    function retryGuarantee(
        address user,
        address asset
    ) external onlyValidRegistry nonReentrant {
        _requireRole(ActionKeys.ACTION_VIEW_PUSH, msg.sender);
        _pushGuaranteeSnapshotBestEffort(user, asset);
    }

    /*━━━━━━━━━━━━━━━ Internal Snapshot Read And Push ━━━━━━━━━━━━━━━*/
    function _pushUserStatsSnapshotBestEffort(address user) internal {
        if (user == address(0)) {
            emit CacheUpdateFailedWithContext(
                address(0),
                address(0),
                bytes32(0),
                address(0),
                0,
                0,
                abi.encode("user=0"),
                0,
                0
            );
            return;
        }

        uint64 seq = _nextUserSeq(user);
        bytes32 requestId = _makeRequestIdUserStats(user, seq);

        // Resolve dependencies (SSOT).
        address statsViewAddr = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_STATS
        );
        address leAddr = Registry(_registryAddr).getModule(ModuleKeys.KEY_LE);
        address pvAddr = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_POSITION_VIEW
        );

        if (statsViewAddr == address(0) || statsViewAddr.code.length == 0) {
            emit CacheUpdateFailedWithContext(
                user,
                address(0),
                requestId,
                statsViewAddr,
                0,
                0,
                abi.encode("statsView missing"),
                seq,
                0
            );
            return;
        }
        if (leAddr == address(0) || leAddr.code.length == 0) {
            emit CacheUpdateFailedWithContext(
                user,
                address(0),
                requestId,
                statsViewAddr,
                0,
                0,
                abi.encode("lendingEngine missing"),
                seq,
                0
            );
            return;
        }
        if (pvAddr == address(0) || pvAddr.code.length == 0) {
            emit CacheUpdateFailedWithContext(
                user,
                address(0),
                requestId,
                statsViewAddr,
                0,
                0,
                abi.encode("positionView missing"),
                seq,
                0
            );
            return;
        }

        // Compute authoritative snapshot (SSOT-derived).
        // IMPORTANT (Architecture-Guide SSOT): collateral/debt totals MUST be expressed in the
        // shared 18-decimal system valuation unit, not as raw token amounts. Therefore we read:
        // - collateralValue from PositionView valuation
        // - debtValue from LendingEngine valuation
        (
            uint256 collateralTotal,
            uint256 debtTotal,
            bytes memory snapErr
        ) = _readUserTotalsValue(pvAddr, leAddr, user);
        if (snapErr.length != 0) {
            emit CacheUpdateFailedWithContext(
                user,
                address(0),
                requestId,
                statsViewAddr,
                collateralTotal,
                debtTotal,
                snapErr,
                seq,
                0
            );
            return;
        }

        // Strict optimistic concurrency: read current version, nextVersion = current + 1.
        uint64 nextVersion;
        try
            IStatisticsViewSnapshotMinimal(statsViewAddr)
                .getUserStatsVersionForPusher(user)
        returns (uint64 cur) {
            nextVersion = cur + 1;
        } catch (bytes memory reason) {
            emit CacheUpdateFailedWithContext(
                user,
                address(0),
                requestId,
                statsViewAddr,
                collateralTotal,
                debtTotal,
                reason,
                seq,
                0
            );
            return;
        }

        try
            IStatisticsViewSnapshotMinimal(statsViewAddr).pushUserStatsSnapshot(
                user,
                collateralTotal,
                debtTotal,
                requestId,
                seq,
                nextVersion
            )
        {
            return;
        } catch (bytes memory reason) {
            emit CacheUpdateFailedWithContext(
                user,
                address(0),
                requestId,
                statsViewAddr,
                collateralTotal,
                debtTotal,
                reason,
                seq,
                nextVersion
            );
        }
    }

    function _pushGuaranteeSnapshotBestEffort(
        address user,
        address asset
    ) internal {
        if (user == address(0) || asset == address(0)) {
            emit CacheUpdateFailedWithContext(
                user,
                asset,
                bytes32(0),
                address(0),
                0,
                0,
                abi.encode("user/asset=0"),
                0,
                0
            );
            return;
        }

        uint64 seq = _nextGuaranteeSeq(user, asset);
        bytes32 requestId = _makeRequestIdGuarantee(user, asset, seq);

        address statsViewAddr = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_STATS
        );
        address gfmAddr = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_GUARANTEE_FUND
        );
        if (statsViewAddr == address(0) || statsViewAddr.code.length == 0) {
            emit CacheUpdateFailedWithContext(
                user,
                asset,
                requestId,
                statsViewAddr,
                0,
                0,
                abi.encode("statsView missing"),
                seq,
                0
            );
            return;
        }
        if (gfmAddr == address(0) || gfmAddr.code.length == 0) {
            emit CacheUpdateFailedWithContext(
                user,
                asset,
                requestId,
                statsViewAddr,
                0,
                0,
                abi.encode("guaranteeFund missing"),
                seq,
                0
            );
            return;
        }

        uint256 userBal;
        uint256 totalByAsset;
        try
            IGuaranteeFundManager(gfmAddr).getLockedGuarantee(user, asset)
        returns (uint256 b) {
            userBal = b;
        } catch (bytes memory reason) {
            emit CacheUpdateFailedWithContext(
                user,
                asset,
                requestId,
                statsViewAddr,
                0,
                0,
                reason,
                seq,
                0
            );
            return;
        }
        try
            IGuaranteeFundManager(gfmAddr).getTotalGuaranteeByAsset(asset)
        returns (uint256 t) {
            totalByAsset = t;
        } catch (bytes memory reason) {
            emit CacheUpdateFailedWithContext(
                user,
                asset,
                requestId,
                statsViewAddr,
                userBal,
                0,
                reason,
                seq,
                0
            );
            return;
        }

        uint64 nextVersion;
        try
            IStatisticsViewSnapshotMinimal(statsViewAddr)
                .getGuaranteeVersionForPusher(user, asset)
        returns (uint64 cur) {
            nextVersion = cur + 1;
        } catch (bytes memory reason) {
            emit CacheUpdateFailedWithContext(
                user,
                asset,
                requestId,
                statsViewAddr,
                userBal,
                totalByAsset,
                reason,
                seq,
                0
            );
            return;
        }

        // For guarantee snapshots, place (userBalance, totalByAsset) into the
        // (collateral, debt) fields of CacheUpdateFailedWithContext
        // to keep the event replayable with only two scalar slots.
        try
            IStatisticsViewSnapshotMinimal(statsViewAddr).pushGuaranteeSnapshot(
                user,
                asset,
                userBal,
                totalByAsset,
                requestId,
                seq,
                nextVersion
            )
        {
            return;
        } catch (bytes memory reason) {
            emit CacheUpdateFailedWithContext(
                user,
                asset,
                requestId,
                statsViewAddr,
                userBal,
                totalByAsset,
                reason,
                seq,
                nextVersion
            );
        }
    }

    function _readUserTotalsValue(
        address positionViewAddr,
        address leAddr,
        address user
    )
        internal
        view
        returns (
            uint256 collateralValue,
            uint256 debtValue,
            bytes memory err
        )
    {
        // Collateral total value in the shared 18-decimal system valuation unit.
        try
            IPositionViewValuation(positionViewAddr)
                .getUserTotalCollateralValue(user)
        returns (uint256 v) {
            collateralValue = v;
        } catch (bytes memory reason) {
            return (
                0,
                0,
                abi.encode("getUserTotalCollateralValue failed", reason)
            );
        }

        // Debt total value in the shared 18-decimal system valuation unit.
        try ILendingEngineDebtRead(leAddr).getUserTotalDebtValue(user) returns (
            uint256 v
        ) {
            debtValue = v;
        } catch (bytes memory reason) {
            return (
                collateralValue,
                0,
                abi.encode("getUserTotalDebtValue failed", reason)
            );
        }
    }

    /*━━━━━━━━━━━━━━━ Internal: seq/requestId helpers ━━━━━━━━━━━━━━━*/
    function _nextUserSeq(address user) internal returns (uint64) {
        unchecked {
            _userStatsSeq[user] += 1;
        }
        return _userStatsSeq[user];
    }

    function _nextGuaranteeSeq(
        address user,
        address asset
    ) internal returns (uint64) {
        unchecked {
            _guaranteeSeq[user][asset] += 1;
        }
        return _guaranteeSeq[user][asset];
    }

    function _makeRequestIdUserStats(
        address user,
        uint64 seq
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    bytes1(0x01),
                    block.chainid,
                    address(this),
                    user,
                    seq
                )
            );
    }

    function _makeRequestIdGuarantee(
        address user,
        address asset,
        uint64 seq
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    bytes1(0x02),
                    block.chainid,
                    address(this),
                    user,
                    asset,
                    seq
                )
            );
    }

    /*━━━━━━━━━━━━━━━ Internal: access control ━━━━━━━━━━━━━━━*/
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ACCESS_CONTROL
        );
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    function _requireNotifier(address caller) internal view {
        // Allow admin-style ops.
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ACCESS_CONTROL
        );
        // If caller has ACTION_VIEW_PUSH, allow.
        try
            IAccessControlManager(acmAddr).hasRole(
                ActionKeys.ACTION_VIEW_PUSH,
                caller
            )
        returns (bool ok) {
            if (ok) return;
        } catch {
            acmAddr = acmAddr;
        }

        // Otherwise restrict to known SSOT modules (hard allowlist via Registry resolution).
        if (caller == Registry(_registryAddr).getModule(ModuleKeys.KEY_CM))
            return;
        if (caller == Registry(_registryAddr).getModule(ModuleKeys.KEY_LE))
            return;
        if (
            caller ==
            Registry(_registryAddr).getModule(ModuleKeys.KEY_SETTLEMENT_MANAGER)
        ) return;
        if (
            caller ==
            Registry(_registryAddr).getModule(ModuleKeys.KEY_GUARANTEE_FUND)
        ) return;
        if (
            caller ==
            Registry(_registryAddr).getModule(
                ModuleKeys.KEY_LIQUIDATION_MANAGER
            )
        ) return;
        if (
            caller ==
            Registry(_registryAddr).getModule(ModuleKeys.KEY_VAULT_CORE)
        ) return;

        revert MissingRole();
    }

    /*━━━━━━━━━━━━━━━ UUPS upgradeability ━━━━━━━━━━━━━━━*/
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0)
            revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/
    uint256[50] private __gap;
}
