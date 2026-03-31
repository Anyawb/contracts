// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ActionKeys
 * @notice Define the canonical ActionKeys permission and audit identifiers
 *         used across the protocol.
 * @dev Reverts if:
 *      - helper lookups do not revert on unknown inputs and instead return
 *        `false`, empty strings, or fixed arrays as documented
 *
 * Security:
 * - Existing keccak256-derived key values are part of the permission SSOT
 *   and must remain stable after deployment.
 * - Callers should reuse these constants instead of inlining hashes
 *   to avoid permission drift between modules, docs, and integrations.
 *
 * @custom:security-contact security@example.com
 */
library ActionKeys {
    /*━━━━━━━━━━━━━━━ Constants ━━━━━━━━━━━━━━━*/
    /// @notice Total number of canonical action keys in the static registry.
    /// @dev Keep this value in sync with {getAllActionKeysFixed}.
    uint256 internal constant ACTION_KEY_COUNT = 49;

    /*━━━━━━━━━━━━━━━ Core User Actions ━━━━━━━━━━━━━━━*/
    /// @notice Canonical action key for deposit flows.
    /// @dev Hash: keccak256("DEPOSIT").
    bytes32 public constant ACTION_DEPOSIT = keccak256("DEPOSIT");

    /// @notice Canonical action key for borrow flows.
    /// @dev Hash: keccak256("BORROW").
    bytes32 public constant ACTION_BORROW = keccak256("BORROW");

    /// @notice Canonical action key for repay flows.
    /// @dev Hash: keccak256("REPAY").
    bytes32 public constant ACTION_REPAY = keccak256("REPAY");

    /// @notice Canonical action key for collateral-withdraw flows.
    /// @dev Hash: keccak256("WITHDRAW").
    bytes32 public constant ACTION_WITHDRAW = keccak256("WITHDRAW");

    /// @notice Dedicated action key for order-creation authorization.
    /// @dev Intended for permission checks on create-order paths, not as a generic business-action label.
    /// @dev Hash: keccak256("ORDER_CREATE").
    bytes32 public constant ACTION_ORDER_CREATE = keccak256("ORDER_CREATE");

    /// @notice Canonical action key for liquidation flows.
    /// @dev Hash: keccak256("LIQUIDATE").
    bytes32 public constant ACTION_LIQUIDATE = keccak256("LIQUIDATE");

    /// @notice Canonical action key for partial-liquidation flows.
    /// @dev Hash: keccak256("LIQUIDATE_PARTIAL").
    bytes32 public constant ACTION_LIQUIDATE_PARTIAL =
        keccak256("LIQUIDATE_PARTIAL");

    /// @notice Canonical action key for guarantee-forfeiture liquidation flows.
    /// @dev Hash: keccak256("LIQUIDATE_GUARANTEE").
    bytes32 public constant ACTION_LIQUIDATE_GUARANTEE =
        keccak256("LIQUIDATE_GUARANTEE");

    /// @notice Canonical action key for locking an early-repayment guarantee record.
    /// @dev Used by EarlyRepaymentGuaranteeManager guarantee-lock paths.
    /// @dev Hash: keccak256("LOCK_EARLY_REPAYMENT_GUARANTEE").
    bytes32 public constant ACTION_LOCK_EARLY_REPAYMENT_GUARANTEE =
        keccak256("LOCK_EARLY_REPAYMENT_GUARANTEE");

    /// @notice Canonical action key for settling early-repayment guarantees.
    /// @dev Used by EarlyRepaymentGuaranteeManager early-settlement paths.
    /// @dev Hash: keccak256("SETTLE_EARLY_REPAYMENT_GUARANTEE").
    bytes32 public constant ACTION_SETTLE_EARLY_REPAYMENT_GUARANTEE =
        keccak256("SETTLE_EARLY_REPAYMENT_GUARANTEE");

    /*━━━━━━━━━━━━━━━ Reward Actions ━━━━━━━━━━━━━━━*/
    /// @notice Canonical action key for claiming rewards.
    /// @dev Hash: keccak256("CLAIM_REWARD").
    bytes32 public constant ACTION_CLAIM_REWARD = keccak256("CLAIM_REWARD");

    /// @notice Canonical action key for consuming EASY tokens.
    /// @dev Hash: keccak256("CONSUME_EASY").
    bytes32 public constant ACTION_CONSUME_EASY = keccak256("CONSUME_EASY");

    /*━━━━━━━━━━━━━━━ System Management Actions ━━━━━━━━━━━━━━━*/
    /// @notice Canonical action key for price-update paths.
    /// @dev Hash: keccak256("UPDATE_PRICE").
    bytes32 public constant ACTION_UPDATE_PRICE = keccak256("UPDATE_PRICE");

    /// @notice Canonical action key for parameter updates.
    /// @dev Hash: keccak256("SET_PARAMETER").
    bytes32 public constant ACTION_SET_PARAMETER = keccak256("SET_PARAMETER");

    /// @notice Canonical action key for module upgrades.
    /// @dev Hash: keccak256("UPGRADE_MODULE").
    bytes32 public constant ACTION_UPGRADE_MODULE = keccak256("UPGRADE_MODULE");

    /// @notice Canonical action key for pause-system paths.
    /// @dev Hash: keccak256("PAUSE_SYSTEM").
    bytes32 public constant ACTION_PAUSE_SYSTEM = keccak256("PAUSE_SYSTEM");

    /// @notice Canonical action key for unpause-system paths.
    /// @dev Hash: keccak256("UNPAUSE_SYSTEM").
    bytes32 public constant ACTION_UNPAUSE_SYSTEM = keccak256("UNPAUSE_SYSTEM");

    /*━━━━━━━━━━━━━━━ Governance Actions ━━━━━━━━━━━━━━━*/
    /// @notice Canonical action key for proposal creation.
    /// @dev Hash: keccak256("CREATE_PROPOSAL").
    bytes32 public constant ACTION_CREATE_PROPOSAL =
        keccak256("CREATE_PROPOSAL");

    /// @notice Canonical action key for voting.
    /// @dev Hash: keccak256("VOTE").
    bytes32 public constant ACTION_VOTE = keccak256("VOTE");

    /// @notice Canonical action key for proposal execution.
    /// @dev Hash: keccak256("EXECUTE_PROPOSAL").
    bytes32 public constant ACTION_EXECUTE_PROPOSAL =
        keccak256("EXECUTE_PROPOSAL");

    /// @notice Canonical action key for cross-chain voting.
    /// @dev Hash: keccak256("CROSS_CHAIN_VOTE").
    bytes32 public constant ACTION_CROSS_CHAIN_VOTE =
        keccak256("CROSS_CHAIN_VOTE");

    /*━━━━━━━━━━━━━━━ Permission Administration Actions ━━━━━━━━━━━━━━━*/
    /// @notice Canonical action key for role grants.
    /// @dev Hash: keccak256("GRANT_ROLE").
    bytes32 public constant ACTION_GRANT_ROLE = keccak256("GRANT_ROLE");

    /// @notice Canonical action key for role revocations.
    /// @dev Hash: keccak256("REVOKE_ROLE").
    bytes32 public constant ACTION_REVOKE_ROLE = keccak256("REVOKE_ROLE");

    /// @notice Canonical action key for allowlist additions.
    /// @dev Hash: keccak256("ADD_WHITELIST").
    bytes32 public constant ACTION_ADD_WHITELIST = keccak256("ADD_WHITELIST");

    /// @notice Canonical action key for allowlist removals.
    /// @dev Hash: keccak256("REMOVE_WHITELIST").
    bytes32 public constant ACTION_REMOVE_WHITELIST =
        keccak256("REMOVE_WHITELIST");

    /*━━━━━━━━━━━━━━━ Batch Actions ━━━━━━━━━━━━━━━*/
    /// @notice Canonical action key for batch deposits.
    /// @dev Hash: keccak256("BATCH_DEPOSIT").
    bytes32 public constant ACTION_BATCH_DEPOSIT = keccak256("BATCH_DEPOSIT");

    /// @notice Canonical action key for batch borrows.
    /// @dev Hash: keccak256("BATCH_BORROW").
    bytes32 public constant ACTION_BATCH_BORROW = keccak256("BATCH_BORROW");

    /// @notice Canonical action key for batch repays.
    /// @dev Hash: keccak256("BATCH_REPAY").
    bytes32 public constant ACTION_BATCH_REPAY = keccak256("BATCH_REPAY");

    /// @notice Canonical action key for batch withdrawals.
    /// @dev Hash: keccak256("BATCH_WITHDRAW").
    bytes32 public constant ACTION_BATCH_WITHDRAW = keccak256("BATCH_WITHDRAW");

    /*━━━━━━━━━━━━━━━ Testnet Actions ━━━━━━━━━━━━━━━*/
    /// @notice Canonical action key for testnet configuration paths.
    /// @dev Hash: keccak256("TESTNET_CONFIG").
    bytes32 public constant ACTION_TESTNET_CONFIG = keccak256("TESTNET_CONFIG");

    /// @notice Canonical action key for testnet activation paths.
    /// @dev Hash: keccak256("TESTNET_ACTIVATE").
    bytes32 public constant ACTION_TESTNET_ACTIVATE =
        keccak256("TESTNET_ACTIVATE");

    /// @notice Canonical action key for testnet pause paths.
    /// @dev Hash: keccak256("TESTNET_PAUSE").
    bytes32 public constant ACTION_TESTNET_PAUSE = keccak256("TESTNET_PAUSE");

    /*━━━━━━━━━━━━━━━ View and Query Actions ━━━━━━━━━━━━━━━*/
    /// @notice Canonical action key for viewing user data.
    /// @dev Hash: keccak256("VIEW_USER_DATA").
    bytes32 public constant ACTION_VIEW_USER_DATA = keccak256("VIEW_USER_DATA");

    /// @notice Canonical action key for viewing risk data.
    /// @dev Hash: keccak256("VIEW_RISK_DATA").
    bytes32 public constant ACTION_VIEW_RISK_DATA = keccak256("VIEW_RISK_DATA");

    /// @notice Canonical action key for viewing system data.
    /// @dev Hash: keccak256("VIEW_SYSTEM_DATA").
    bytes32 public constant ACTION_VIEW_SYSTEM_DATA =
        keccak256("VIEW_SYSTEM_DATA");

    /// @notice Canonical action key for viewing liquidation data.
    /// @dev Hash: keccak256("VIEW_LIQUIDATION_DATA").
    bytes32 public constant ACTION_VIEW_LIQUIDATION_DATA =
        keccak256("VIEW_LIQUIDATION_DATA");

    /// @notice Canonical action key for viewing cache data.
    /// @dev Hash: keccak256("VIEW_CACHE_DATA").
    bytes32 public constant ACTION_VIEW_CACHE_DATA =
        keccak256("VIEW_CACHE_DATA");

    /// @notice Canonical action key for authorized view-cache push paths.
    /// @dev Used to restrict who may push updates into view-layer write endpoints.
    /// @dev Hash: keccak256("ACTION_VIEW_PUSH").
    bytes32 public constant ACTION_VIEW_PUSH = keccak256("ACTION_VIEW_PUSH");

    /// @notice Canonical action key for event-history management.
    /// @dev Hash: keccak256("MANAGE_EVENT_HISTORY").
    bytes32 public constant ACTION_MANAGE_EVENT_HISTORY =
        keccak256("MANAGE_EVENT_HISTORY");

    /// @notice Canonical action key for viewing price data.
    /// @dev Hash: keccak256("VIEW_PRICE_DATA").
    bytes32 public constant ACTION_VIEW_PRICE_DATA =
        keccak256("VIEW_PRICE_DATA");

    /// @notice Canonical action key for viewing degradation data.
    /// @dev Hash: keccak256("VIEW_DEGRADATION_DATA").
    bytes32 public constant ACTION_VIEW_DEGRADATION_DATA =
        keccak256("VIEW_DEGRADATION_DATA");

    /*━━━━━━━━━━━━━━━ Administrative Actions ━━━━━━━━━━━━━━━*/
    /// @notice Canonical action key for admin-level access.
    /// @dev Hash: keccak256("ACTION_ADMIN").
    bytes32 public constant ACTION_ADMIN = keccak256("ACTION_ADMIN");

    /// @notice Canonical action key for RewardConfig emergency break-glass paths.
    /// @dev Intended for tightly controlled emergency overrides on RewardConfig-related modules.
    /// @dev Hash: keccak256("ACTION_REWARD_CONFIG_EMERGENCY").
    bytes32 public constant ACTION_REWARD_CONFIG_EMERGENCY =
        keccak256("ACTION_REWARD_CONFIG_EMERGENCY");

    /// @notice Canonical action key for setting the upgrade admin.
    /// @dev Hash: keccak256("SET_UPGRADE_ADMIN").
    bytes32 public constant ACTION_SET_UPGRADE_ADMIN =
        keccak256("SET_UPGRADE_ADMIN");

    /// @notice Canonical action key for emergency parameter updates.
    /// @dev Hash: keccak256("EMERGENCY_SET_PARAMETER").
    bytes32 public constant ACTION_EMERGENCY_SET_PARAMETER =
        keccak256("EMERGENCY_SET_PARAMETER");

    /// @notice Canonical action key for privileged user-data modifications.
    /// @dev Hash: keccak256("ACTION_MODIFY_USER_DATA").
    bytes32 public constant ACTION_MODIFY_USER_DATA =
        keccak256("ACTION_MODIFY_USER_DATA");

    /// @notice Canonical action key for viewing system-status snapshots.
    /// @dev Hash: keccak256("ACTION_VIEW_SYSTEM_STATUS").
    bytes32 public constant ACTION_VIEW_SYSTEM_STATUS =
        keccak256("ACTION_VIEW_SYSTEM_STATUS");

    /*━━━━━━━━━━━━━━━ Query Management Actions ━━━━━━━━━━━━━━━*/
    /// @notice Canonical action key for query-management privileges.
    /// @dev Hash: keccak256("QUERY_MANAGER").
    bytes32 public constant ACTION_QUERY_MANAGER = keccak256("QUERY_MANAGER");

    /*━━━━━━━━━━━━━━━ Reserve Flow Actions ━━━━━━━━━━━━━━━*/
    /// @notice Canonical action key for reserve-for-lending flows.
    /// @dev Hash: keccak256("RESERVE_FOR_LENDING").
    bytes32 public constant ACTION_RESERVE_FOR_LENDING =
        keccak256("RESERVE_FOR_LENDING");

    /// @notice Canonical action key for reserve-cancellation flows.
    /// @dev Hash: keccak256("CANCEL_RESERVE").
    bytes32 public constant ACTION_CANCEL_RESERVE = keccak256("CANCEL_RESERVE");

    /**
     * @notice Return whether `key` exists in the canonical ActionKeys set.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure validation helper; returns `false` for unknown keys instead of reverting.
     * - Uses the fixed static list from {getAllActionKeysFixed}, so ACTION_KEY_COUNT must stay in sync with that list.
     *
     * @param key Action key hash to validate.
     * @return isKnown True if `key` is part of the canonical static set.
     */
    function isValidActionKey(bytes32 key) internal pure returns (bool) {
        bytes32[ACTION_KEY_COUNT] memory keys = getAllActionKeysFixed();
        for (uint256 i = 0; i < ACTION_KEY_COUNT; i++) {
            if (keys[i] == key) {
                return true;
            }
        }
        return false;
    }

    /**
     * @notice Convert an ActionKeys hash to its legacy lowerCamelCase audit string.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure compatibility helper for logs and human-readable action traces.
     * - Returns an empty string for unknown keys, so callers must not treat empty output as a valid action name.
     *
     * @param key Action key hash.
     * @return actionName Legacy lowerCamelCase action name, or an empty string if unknown.
     */
    function getActionKeyString(
        bytes32 key
    ) internal pure returns (string memory) {
        if (key == ACTION_DEPOSIT) return "deposit";
        if (key == ACTION_BORROW) return "borrow";
        if (key == ACTION_REPAY) return "repay";
        if (key == ACTION_WITHDRAW) return "withdraw";
        if (key == ACTION_ORDER_CREATE) return "orderCreate";
        if (key == ACTION_LIQUIDATE) return "liquidate";
        if (key == ACTION_LIQUIDATE_PARTIAL) return "liquidatePartial";
        if (key == ACTION_LIQUIDATE_GUARANTEE) return "liquidateGuarantee";
        if (key == ACTION_LOCK_EARLY_REPAYMENT_GUARANTEE)
            return "lockEarlyRepaymentGuarantee";
        if (key == ACTION_SETTLE_EARLY_REPAYMENT_GUARANTEE)
            return "settleEarlyRepaymentGuarantee";
        if (key == ACTION_CLAIM_REWARD) return "claimReward";
        if (key == ACTION_CONSUME_EASY) return "consumeEasy";
        if (key == ACTION_UPDATE_PRICE) return "updatePrice";
        if (key == ACTION_SET_PARAMETER) return "setParameter";
        if (key == ACTION_UPGRADE_MODULE) return "upgradeModule";
        if (key == ACTION_PAUSE_SYSTEM) return "pauseSystem";
        if (key == ACTION_UNPAUSE_SYSTEM) return "unpauseSystem";
        if (key == ACTION_CREATE_PROPOSAL) return "createProposal";
        if (key == ACTION_VOTE) return "vote";
        if (key == ACTION_EXECUTE_PROPOSAL) return "executeProposal";
        if (key == ACTION_CROSS_CHAIN_VOTE) return "crossChainVote";
        if (key == ACTION_GRANT_ROLE) return "grantRole";
        if (key == ACTION_REVOKE_ROLE) return "revokeRole";
        if (key == ACTION_ADD_WHITELIST) return "addWhitelist";
        if (key == ACTION_REMOVE_WHITELIST) return "removeWhitelist";
        if (key == ACTION_BATCH_DEPOSIT) return "batchDeposit";
        if (key == ACTION_BATCH_BORROW) return "batchBorrow";
        if (key == ACTION_BATCH_REPAY) return "batchRepay";
        if (key == ACTION_BATCH_WITHDRAW) return "batchWithdraw";
        if (key == ACTION_TESTNET_CONFIG) return "testnetConfig";
        if (key == ACTION_TESTNET_ACTIVATE) return "testnetActivate";
        if (key == ACTION_TESTNET_PAUSE) return "testnetPause";
        if (key == ACTION_VIEW_USER_DATA) return "viewUserData";
        if (key == ACTION_VIEW_RISK_DATA) return "viewRiskData";
        if (key == ACTION_VIEW_SYSTEM_DATA) return "viewSystemData";
        if (key == ACTION_VIEW_LIQUIDATION_DATA) return "viewLiquidationData";
        if (key == ACTION_VIEW_CACHE_DATA) return "viewCacheData";
        if (key == ACTION_VIEW_PRICE_DATA) return "viewPriceData";
        if (key == ACTION_VIEW_DEGRADATION_DATA) return "viewDegradationData";
        if (key == ACTION_VIEW_PUSH) return "actionViewPush";
        if (key == ACTION_ADMIN) return "actionAdmin";
        if (key == ACTION_REWARD_CONFIG_EMERGENCY)
            return "actionRewardConfigEmergency";
        if (key == ACTION_MODIFY_USER_DATA) return "actionModifyUserData";
        if (key == ACTION_SET_UPGRADE_ADMIN) return "setUpgradeAdmin";
        if (key == ACTION_EMERGENCY_SET_PARAMETER)
            return "emergencySetParameter";
        if (key == ACTION_VIEW_SYSTEM_STATUS) return "actionViewSystemStatus";
        if (key == ACTION_QUERY_MANAGER) return "queryManager";
        if (key == ACTION_RESERVE_FOR_LENDING) return "reserveForLending";
        if (key == ACTION_CANCEL_RESERVE) return "cancelReserve";
        return "";
    }

    /**
     * @notice Return the fixed canonical ActionKeys array.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure static registry helper.
     * - Array ordering is part of the local helper contract between
     *   {ACTION_KEY_COUNT}, {isValidActionKey}, and external tooling expectations.
     *
     * @return keys Fixed ActionKeys array.
     */
    function getAllActionKeysFixed()
        internal
        pure
        returns (bytes32[ACTION_KEY_COUNT] memory)
    {
        bytes32[ACTION_KEY_COUNT] memory keys;
        keys[0] = ACTION_DEPOSIT;
        keys[1] = ACTION_BORROW;
        keys[2] = ACTION_REPAY;
        keys[3] = ACTION_WITHDRAW;
        keys[4] = ACTION_LIQUIDATE;
        keys[5] = ACTION_LIQUIDATE_PARTIAL;
        keys[6] = ACTION_LIQUIDATE_GUARANTEE;
        keys[7] = ACTION_CLAIM_REWARD;
        keys[8] = ACTION_CONSUME_EASY;
        keys[9] = ACTION_UPDATE_PRICE;
        keys[10] = ACTION_SET_PARAMETER;
        keys[11] = ACTION_UPGRADE_MODULE;
        keys[12] = ACTION_PAUSE_SYSTEM;
        keys[13] = ACTION_UNPAUSE_SYSTEM;
        keys[14] = ACTION_CREATE_PROPOSAL;
        keys[15] = ACTION_VOTE;
        keys[16] = ACTION_EXECUTE_PROPOSAL;
        keys[17] = ACTION_CROSS_CHAIN_VOTE;
        keys[18] = ACTION_GRANT_ROLE;
        keys[19] = ACTION_REVOKE_ROLE;
        keys[20] = ACTION_ADD_WHITELIST;
        keys[21] = ACTION_REMOVE_WHITELIST;
        keys[22] = ACTION_BATCH_DEPOSIT;
        keys[23] = ACTION_BATCH_BORROW;
        keys[24] = ACTION_BATCH_REPAY;
        keys[25] = ACTION_BATCH_WITHDRAW;
        keys[26] = ACTION_TESTNET_CONFIG;
        keys[27] = ACTION_TESTNET_ACTIVATE;
        keys[28] = ACTION_TESTNET_PAUSE;
        keys[29] = ACTION_VIEW_USER_DATA;
        keys[30] = ACTION_VIEW_RISK_DATA;
        keys[31] = ACTION_VIEW_SYSTEM_DATA;
        keys[32] = ACTION_VIEW_LIQUIDATION_DATA;
        keys[33] = ACTION_VIEW_CACHE_DATA;
        keys[34] = ACTION_VIEW_PRICE_DATA;
        keys[35] = ACTION_VIEW_DEGRADATION_DATA;
        keys[36] = ACTION_ADMIN;
        keys[37] = ACTION_SET_UPGRADE_ADMIN;
        keys[38] = ACTION_EMERGENCY_SET_PARAMETER;
        keys[39] = ACTION_MODIFY_USER_DATA;
        keys[40] = ACTION_VIEW_SYSTEM_STATUS;
        keys[41] = ACTION_QUERY_MANAGER;
        keys[42] = ACTION_ORDER_CREATE;
        keys[43] = ACTION_VIEW_PUSH;
        keys[44] = ACTION_RESERVE_FOR_LENDING;
        keys[45] = ACTION_CANCEL_RESERVE;
        keys[46] = ACTION_LOCK_EARLY_REPAYMENT_GUARANTEE;
        keys[47] = ACTION_SETTLE_EARLY_REPAYMENT_GUARANTEE;
        keys[48] = ACTION_REWARD_CONFIG_EMERGENCY;
        return keys;
    }
}
