// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @notice Define the canonical Registry module identifiers as deterministic bytes32 keys.
 * @dev Reverts if:
 *      - helper lookups receive invalid / unknown inputs where explicitly documented
 *
 * Security:
 * - Keys are deterministic keccak256 hashes and form part of the Registry dependency-resolution SSOT.
 * - Existing key values must remain stable to preserve on-chain registry data,
 *   upgrade compatibility, and off-chain tooling.
 */
library ModuleKeys {
    /*━━━━━━━━━━━━━━━ Custom Errors ━━━━━━━━━━━━━━━*/
    /// @notice Thrown when accessing the static key list with an out-of-bounds index.
    /// @dev Reverts if:
    ///      - `index >= length`
    ///
    /// @param index Requested index (0-based)
    /// @param length Total length of the static list
    error ModuleKeys__IndexOutOfBounds(uint256 index, uint256 length);

    /// @notice Thrown when a module key is zero (`bytes32(0)`) where a valid key is required.
    error ModuleKeys__InvalidModuleKey();

    /// @notice Thrown when a module key is not recognized by this static registry.
    /// @param key The unknown module key (`bytes32`)
    error ModuleKeys__UnknownModuleKey(bytes32 key);
    /*━━━━━━━━━━━━━━━ Core Modules ━━━━━━━━━━━━━━━*/
    /// @notice CollateralManager module key.
    /// @dev Used by Registry to store the CollateralManager contract address.
    /// @dev Hash: keccak256("COLLATERAL_MANAGER")
    bytes32 internal constant KEY_CM = keccak256("COLLATERAL_MANAGER");

    /// @notice Lending engine (ledger) module key (VaultLendingEngine / ILendingEngineBasic legacy umbrella).
    /// @dev Used by Registry to store the lending engine contract address.
    /// @dev Hash: keccak256("LENDING_ENGINE")
    bytes32 internal constant KEY_LE = keccak256("LENDING_ENGINE");

    /// @notice Vault lending engine module key.
    /// @dev Used by Registry to store the VaultLendingEngine contract address.
    /// @dev Hash: keccak256("VAULT_LENDING_ENGINE")
    bytes32 internal constant KEY_VAULT_LENDING_ENGINE =
        keccak256("VAULT_LENDING_ENGINE");

    /// @notice Order engine module key (core/LendingEngine / IOrderEngine).
    /// @dev Used by Registry to store the order engine contract address.
    /// @dev Hash: keccak256("ORDER_ENGINE")
    bytes32 internal constant KEY_ORDER_ENGINE = keccak256("ORDER_ENGINE");

    /// @notice Canonical multi-product order-state SSOT module key.
    /// @dev Used by Registry to store the OrderStateStoreV2 contract address.
    /// @dev Hash: keccak256("ORDER_STATE_STORE")
    bytes32 internal constant KEY_ORDER_STATE_STORE =
        keccak256("ORDER_STATE_STORE");

    /// @notice Deprecated: health factor calculator module key.
    /// @dev Replaced by LiquidationRiskManager / HealthView.
    /// @dev Preserved as a placeholder to avoid breaking legacy data/scripts; new code must not use it.
    /// @dev Hash: keccak256("HEALTH_FACTOR_CALCULATOR")
    bytes32 internal constant KEY_HF_CALC =
        keccak256("HEALTH_FACTOR_CALCULATOR");

    /// @notice Vault statistics module key.
    /// @dev Used by Registry to store the VaultStatistics (or StatisticsView) contract address.
    /// @dev Hash: keccak256("VAULT_STATISTICS")
    bytes32 internal constant KEY_STATS = keccak256("VAULT_STATISTICS");

    /// @notice Statistics push orchestrator module key (strict B+).
    /// @dev Used by Registry to store the StatisticsPushManager (a.k.a. ViewPushOrchestrator) contract address.
    ///      This module is the single on-chain entrypoint responsible for generating `seq/requestId/nextVersion`,
    ///      reading SSOT snapshots, and pushing snapshots into StatisticsView.
    /// @dev Hash: keccak256("STATISTICS_PUSH_MANAGER")
    bytes32 internal constant KEY_STATS_PUSH_MANAGER =
        keccak256("STATISTICS_PUSH_MANAGER");

    /// @notice Loan flow view module key (protocol loan flow metrics, shared valuation-unit SSOT).
    /// @dev Used by Registry to store the LoanFlowView contract address.
    /// @dev Hash: keccak256("LOAN_FLOW_VIEW")
    bytes32 internal constant KEY_LOAN_FLOW_VIEW = keccak256("LOAN_FLOW_VIEW");

    /// @notice Loan flow push orchestrator module key (strict B+).
    /// @dev Used by Registry to store the LoanFlowPushManager contract address.
    ///      This module is the single on-chain entrypoint responsible for generating `requestId/seq/nextVersion`,
    ///      computing asset-native value from the price-oracle SSOT, normalizing it into the shared
    ///      18-decimal system valuation unit, and pushing deltas into LoanFlowView.
    /// @dev Hash: keccak256("LOAN_FLOW_PUSH_MANAGER")
    bytes32 internal constant KEY_LOAN_FLOW_PUSH_MANAGER =
        keccak256("LOAN_FLOW_PUSH_MANAGER");

    /// @notice Degradation core monitoring module identifier
    /// @dev Hash: keccak256("DEGRADATION_CORE")
    bytes32 internal constant KEY_DEGRADATION_CORE =
        keccak256("DEGRADATION_CORE");

    /// @notice Degradation monitor (keeper) module identifier
    /// @dev Hash: keccak256("DEGRADATION_MONITOR")
    bytes32 internal constant KEY_DEGRADATION_MONITOR =
        keccak256("DEGRADATION_MONITOR");

    /// @notice Degradation storage module identifier
    /// @dev Hash: keccak256("DEGRADATION_STORAGE")
    bytes32 internal constant KEY_DEGRADATION_STORAGE =
        keccak256("DEGRADATION_STORAGE");

    /// @notice Module health view module identifier
    /// @dev Hash: keccak256("MODULE_HEALTH_VIEW")
    bytes32 internal constant KEY_MODULE_HEALTH_VIEW =
        keccak256("MODULE_HEALTH_VIEW");

    /// @notice Batch view module identifier
    /// @dev Hash: keccak256("BATCH_VIEW")
    bytes32 internal constant KEY_BATCH_VIEW = keccak256("BATCH_VIEW");

    /// @notice Vault configuration module key.
    /// @dev Used by Registry to store the VaultConfig contract address.
    /// @dev Hash: keccak256("VAULT_CONFIG")
    bytes32 internal constant KEY_VAULT_CONFIG = keccak256("VAULT_CONFIG");

    /// @notice Vault core module key.
    /// @dev Used by Registry to store the VaultCore contract address.
    /// @dev Hash: keccak256("VAULT_CORE")
    bytes32 internal constant KEY_VAULT_CORE = keccak256("VAULT_CORE");

    // NOTE: Per Architecture-Guide, View addresses should be resolved via KEY_VAULT_CORE -> viewContractAddrVar().
    // We intentionally do not introduce KEY_VAULT_ROUTER to avoid duplicated sources and misconfiguration risk.

    /*━━━━━━━━━━━━━━━ Supporting Modules ━━━━━━━━━━━━━━━*/
    /// @notice Fee router module key.
    /// @dev Used by Registry to store the FeeRouter contract address.
    /// @dev Hash: keccak256("FEE_ROUTER")
    bytes32 internal constant KEY_FR = keccak256("FEE_ROUTER");

    /// @notice Fee router view module key.
    /// @dev Used by Registry to store the FeeRouterView contract address.
    ///      IMPORTANT (Architecture-Guide SSOT):
    ///      - Chain modules MUST resolve view addresses via KEY_VAULT_CORE -> VaultCore.viewContractAddrVar().
    ///      - KEY_FRV is for ops/tools/off-chain convenience only and MUST NOT be used as an on-chain fallback
    ///        source to resolve view addresses (avoid multi-source drift).
    /// @dev Hash: keccak256("FEE_ROUTER_VIEW")
    bytes32 internal constant KEY_FRV = keccak256("FEE_ROUTER_VIEW");

    /// @notice Reward manager module key.
    /// @dev Used by Registry to store the RewardManager contract address.
    /// @dev Hash: keccak256("REWARD_MANAGER")
    bytes32 internal constant KEY_RM = keccak256("REWARD_MANAGER");

    /// @notice Reward manager core module key.
    /// @dev Used by Registry to store the RewardManagerCore contract address.
    /// @dev Hash: keccak256("REWARD_MANAGER_CORE")
    bytes32 internal constant KEY_REWARD_MANAGER_CORE =
        keccak256("REWARD_MANAGER_CORE");

    /// @notice Reward accrual manager module key.
    /// @dev Used by Registry to store the RewardAccrualManager contract address.
    /// @dev Hash: keccak256("REWARD_ACCRUAL_MANAGER")
    bytes32 internal constant KEY_REWARD_ACCRUAL_MANAGER =
        keccak256("REWARD_ACCRUAL_MANAGER");

    /// @notice Reward configuration module key.
    /// @dev Used by Registry to store the RewardConfig contract address.
    /// @dev Hash: keccak256("REWARD_CONFIG")
    bytes32 internal constant KEY_REWARD_CONFIG = keccak256("REWARD_CONFIG");

    /// @notice Reward earn-configuration submodule key.
    /// @dev Used by Registry to store the EarnConfig contract address.
    /// @dev Hash: keccak256("REWARD_EARN_CONFIG")
    bytes32 internal constant KEY_REWARD_EARN_CONFIG =
        keccak256("REWARD_EARN_CONFIG");

    /// @notice Easy emission config module key.
    /// @dev Used by Registry to store the EasyEmissionConfig contract address.
    /// @dev Hash: keccak256("EASY_EMISSION_CONFIG")
    bytes32 internal constant KEY_EASY_EMISSION_CONFIG =
        keccak256("EASY_EMISSION_CONFIG");

    /// @notice Easy emission controller module key.
    /// @dev Used by Registry to store the EasyEmissionController contract address.
    /// @dev Hash: keccak256("EASY_EMISSION_CONTROLLER")
    bytes32 internal constant KEY_EASY_EMISSION_CONTROLLER =
        keccak256("EASY_EMISSION_CONTROLLER");

    /// @notice Easy consumption module key.
    /// @dev Used by Registry to store the EasyConsumption contract address.
    /// @dev Hash: keccak256("EASY_CONSUMPTION")
    bytes32 internal constant KEY_EASY_CONSUMPTION =
        keccak256("EASY_CONSUMPTION");

    /// @notice Easy recycle distributor module key.
    /// @dev Used by Registry to store the EasyRecycleDistributor contract address.
    /// @dev Hash: keccak256("EASY_RECYCLE_DISTRIBUTOR")
    bytes32 internal constant KEY_EASY_RECYCLE_DISTRIBUTOR =
        keccak256("EASY_RECYCLE_DISTRIBUTOR");

    /// @notice Deprecated: valuation oracle adapter module key.
    /// @dev Replaced by KEY_PRICE_ORACLE; preserved for backward compatibility only. New code must not use it.
    /// @dev Hash: keccak256("VALUATION_ORACLE")
    bytes32 internal constant KEY_VALUATION_ORACLE =
        keccak256("VALUATION_ORACLE");

    /// @notice ValuationOracleView module key (canonical price view facade).
    /// @dev Used by Registry to store the ValuationOracleView contract address.
    /// @dev Hash: keccak256("VALUATION_ORACLE_VIEW")
    bytes32 internal constant KEY_VALUATION_ORACLE_VIEW =
        keccak256("VALUATION_ORACLE_VIEW");

    /// @notice Guarantee fund manager module key.
    /// @dev Used by Registry to store the GuaranteeFundManager contract address.
    /// @dev Hash: keccak256("GUARANTEE_FUND_MANAGER")
    bytes32 internal constant KEY_GUARANTEE_FUND =
        keccak256("GUARANTEE_FUND_MANAGER");

    /// @notice Early repayment guarantee manager module key.
    /// @dev Used by Registry to store the EarlyRepaymentGuaranteeManager contract address.
    /// @dev Hash: keccak256("EARLY_REPAYMENT_GUARANTEE_MANAGER")
    // Reason: Module key string must match deployed constant; cannot be shortened without breaking compatibility.
    bytes32 internal constant KEY_EARLY_REPAYMENT_GUARANTEE =
        keccak256("EARLY_REPAYMENT_GUARANTEE_MANAGER");

    /// @notice Keeper registry module key.
    /// @dev Used by Registry to store the KeeperRegistry contract address.
    /// @dev Hash: keccak256("KEEPER_REGISTRY")
    bytes32 internal constant KEY_KEEPER_REGISTRY =
        keccak256("KEEPER_REGISTRY");

    /// @notice Whitelist registry module key.
    /// @dev Used by Registry to store the WhitelistRegistry contract address.
    /// @dev Hash: keccak256("WHITELIST_REGISTRY")
    bytes32 internal constant KEY_WHITELIST_REGISTRY =
        keccak256("WHITELIST_REGISTRY");

    /*━━━━━━━━━━━━━━━ Access Control Modules ━━━━━━━━━━━━━━━*/
    /// @notice Access control manager module key.
    /// @dev Used by Registry to store the AccessControlManager contract address.
    /// @dev Hash: keccak256("ACCESS_CONTROL_MANAGER")
    bytes32 internal constant KEY_ACCESS_CONTROL =
        keccak256("ACCESS_CONTROL_MANAGER");

    /// @notice Access controller module key (enhanced).
    /// @dev Used by Registry to store the AccessController contract address.
    /// @dev Hash: keccak256("ACCESS_CONTROLLER")
    bytes32 internal constant KEY_ACCESS_CONTROLLER =
        keccak256("ACCESS_CONTROLLER");

    /// @notice Asset whitelist module key.
    /// @dev Used by Registry to store the AssetWhitelist contract address.
    /// @dev Hash: keccak256("ASSET_WHITELIST")
    bytes32 internal constant KEY_ASSET_WHITELIST =
        keccak256("ASSET_WHITELIST");

    /// @notice Authority whitelist module key.
    /// @dev Used by Registry to store the AuthorityWhitelist contract address.
    /// @dev Hash: keccak256("AUTHORITY_WHITELIST")
    bytes32 internal constant KEY_AUTHORITY_WHITELIST =
        keccak256("AUTHORITY_WHITELIST");

    /*━━━━━━━━━━━━━━━ Liquidation and Settlement Modules ━━━━━━━━━━━━━━━*/
    /// @notice Settlement manager (unified settlement/liquidation write entry) module key.
    /// @dev Used by Registry to store the SettlementManager contract address.
    /// @dev Hash: keccak256("SETTLEMENT_MANAGER")
    bytes32 internal constant KEY_SETTLEMENT_MANAGER =
        keccak256("SETTLEMENT_MANAGER");

    /// @notice Lender pool vault module key (recommended on-chain liquidity pool location).
    /// @dev Used by Registry to store the LenderPoolVault contract address.
    /// @dev Hash: keccak256("LENDER_POOL_VAULT")
    bytes32 internal constant KEY_LENDER_POOL_VAULT =
        keccak256("LENDER_POOL_VAULT");

    /// @notice Liquidation manager module key.
    /// @dev Used by Registry to store the LiquidationManager contract address.
    /// @dev Hash: keccak256("LIQUIDATION_MANAGER")
    bytes32 internal constant KEY_LIQUIDATION_MANAGER =
        keccak256("LIQUIDATION_MANAGER");

    /// @notice Liquidation risk manager module key.
    /// @dev Used by Registry to store the LiquidationRiskManager contract address.
    /// @dev Hash: keccak256("LIQUIDATION_RISK_MANAGER")
    bytes32 internal constant KEY_LIQUIDATION_RISK_MANAGER =
        keccak256("LIQUIDATION_RISK_MANAGER");

    /// @notice Liquidation calculator module key.
    /// @dev Used by Registry to store the LiquidationCalculator contract address.
    /// @dev Hash: keccak256("LIQUIDATION_CALCULATOR")
    bytes32 internal constant KEY_LIQUIDATION_CALCULATOR =
        keccak256("LIQUIDATION_CALCULATOR");

    /// @notice Liquidation config manager module key.
    /// @dev Used by Registry to store the LiquidationConfigManager contract address.
    /// @dev Hash: keccak256("LIQUIDATION_CONFIG_MANAGER")
    bytes32 internal constant KEY_LIQUIDATION_CONFIG_MANAGER =
        keccak256("LIQUIDATION_CONFIG_MANAGER");

    /// @notice Liquidation orchestrator module key.
    /// @dev Used by Registry to store the LiquidationOrchestrator contract address.
    /// @dev Hash: keccak256("LIQUIDATION_ORCHESTRATOR")
    bytes32 internal constant KEY_LIQUIDATION_ORCHESTRATOR =
        keccak256("LIQUIDATION_ORCHESTRATOR");

    /// @notice Degradation manager module key.
    /// @dev Used by Registry to store the DegradationManager contract address.
    /// @dev Hash: keccak256("DEGRADATION_MANAGER")
    bytes32 internal constant KEY_DEGRADATION_MANAGER =
        keccak256("DEGRADATION_MANAGER");

    /*━━━━━━━━━━━━━━━ Registry System Modules ━━━━━━━━━━━━━━━*/
    /// @notice Dynamic module registry module key.
    /// @dev Used by Registry to store the RegistryDynamicModuleKey contract address.
    /// @dev Hash: keccak256("DYNAMIC_MODULE_REGISTRY")
    bytes32 internal constant KEY_DYNAMIC_MODULE_REGISTRY =
        keccak256("DYNAMIC_MODULE_REGISTRY");

    /// @notice Cache maintenance manager module key (governance ops: batch refresh module caches).
    /// @dev Used by Registry to store the CacheMaintenanceManager contract address.
    /// @dev Hash: keccak256("CACHE_MAINTENANCE_MANAGER")
    bytes32 internal constant KEY_CACHE_MAINTENANCE_MANAGER =
        keccak256("CACHE_MAINTENANCE_MANAGER");

    /*━━━━━━━━━━━━━━━ Governance Modules ━━━━━━━━━━━━━━━*/
    /// @notice Cross-chain governance module key.
    /// @dev Used by Registry to store the CrossChainGovernance contract address.
    /// @dev Hash: keccak256("CROSS_CHAIN_GOVERNANCE")
    bytes32 internal constant KEY_CROSS_CHAIN_GOV =
        keccak256("CROSS_CHAIN_GOVERNANCE");

    /// @notice Governance role module key.
    /// @dev Used by Registry to store the GovernanceRole contract address.
    /// @dev Hash: keccak256("GOVERNANCE_ROLE")
    bytes32 internal constant KEY_GOVERNANCE_ROLE =
        keccak256("GOVERNANCE_ROLE");

    /// @notice Governance escrow module key (DEPRECATED in SSOT "one-token-two-uses" mode).
    /// @dev Kept for backward compatibility. SSOT target-state uses EasyToken directly as IVotes token.
    /// @dev Hash: keccak256("GOVERNANCE_ESCROW")
    bytes32 internal constant KEY_GOVERNANCE_ESCROW =
        keccak256("GOVERNANCE_ESCROW");

    /// @notice Governance gate (SSOT) module key.
    /// @dev Used by Registry to store the GovernanceGate contract address.
    /// @dev Hash: keccak256("GOVERNANCE_GATE")
    bytes32 internal constant KEY_GOVERNANCE_GATE =
        keccak256("GOVERNANCE_GATE");

    /// @notice Feature registry (SSOT) module key.
    /// @dev Used by Registry to store the FeatureRegistry contract address.
    /// @dev Hash: keccak256("FEATURE_REGISTRY")
    bytes32 internal constant KEY_FEATURE_REGISTRY =
        keccak256("FEATURE_REGISTRY");

    /// @notice Governance guardian (foundation veto) address key.
    /// @dev Stored as a module-address entry in Registry for SSOT + migration.
    /// @dev Hash: keccak256("GOVERNANCE_GUARDIAN")
    bytes32 internal constant KEY_GOVERNANCE_GUARDIAN =
        keccak256("GOVERNANCE_GUARDIAN");

    /*━━━━━━━━━━━━━━━ Registry Module ━━━━━━━━━━━━━━━*/
    /// @notice Registry module key.
    /// @dev Used by Registry to store the Registry contract address.
    /// @dev Hash: keccak256("REGISTRY")
    bytes32 internal constant KEY_REGISTRY = keccak256("REGISTRY");

    /*━━━━━━━━━━━━━━━ NFT and Token Modules ━━━━━━━━━━━━━━━*/
    /// @notice Loan NFT module key.
    /// @dev Used by Registry to store the LoanNFT contract address.
    /// @dev Hash: keccak256("LOAN_NFT")
    bytes32 internal constant KEY_LOAN_NFT = keccak256("LOAN_NFT");

    /// @notice Easy token module key.
    /// @dev Used by Registry to store the EasyToken contract address.
    /// @dev Hash: keccak256("EASY_TOKEN")
    bytes32 internal constant KEY_EASY_TOKEN = keccak256("EASY_TOKEN");

    /// @notice Easy staking module key.
    /// @dev Used by Registry to store the EasyStaking contract address.
    /// @dev Hash: keccak256("EASY_STAKING")
    bytes32 internal constant KEY_EASY_STAKING = keccak256("EASY_STAKING");

    /// @notice AI credits vault module key.
    /// @dev Used by Registry to store the AICreditsVault contract address.
    /// @dev Hash: keccak256("AI_CREDITS_VAULT")
    bytes32 internal constant KEY_AI_CREDITS_VAULT =
        keccak256("AI_CREDITS_VAULT");

    /// @notice RWA token module key.
    /// @dev Used by Registry to store the RWAToken contract address.
    /// @dev Hash: keccak256("RWA_TOKEN")
    bytes32 internal constant KEY_RWA_TOKEN = keccak256("RWA_TOKEN");

    /*━━━━━━━━━━━━━━━ Utility Modules ━━━━━━━━━━━━━━━*/
    /// @notice Token utilities module key.
    /// @dev Used by Registry to store the TokenUtils contract address.
    /// @dev Hash: keccak256("TOKEN_UTILS")
    bytes32 internal constant KEY_TOKEN_UTILS = keccak256("TOKEN_UTILS");

    /// @notice Revert decoder module key.
    /// @dev Used by Registry to store the RevertDecoder contract address.
    /// @dev Hash: keccak256("REVERT_DECODER")
    bytes32 internal constant KEY_REVERT_DECODER = keccak256("REVERT_DECODER");

    /// @notice Vault utilities module key.
    /// @dev Used by Registry to store the VaultUtils contract address.
    /// @dev Hash: keccak256("VAULT_UTILS")
    bytes32 internal constant KEY_VAULT_UTILS = keccak256("VAULT_UTILS");

    /*━━━━━━━━━━━━━━━ Oracle Modules ━━━━━━━━━━━━━━━*/
    /// @notice Price oracle module key.
    /// @dev Used by Registry to store the PriceOracle contract address.
    /// @dev Hash: keccak256("PRICE_ORACLE")
    bytes32 internal constant KEY_PRICE_ORACLE = keccak256("PRICE_ORACLE");

    /// @notice Price updater module key.
    /// @dev Used by Registry to store the PriceUpdater contract address.
    /// @dev Preserves the legacy CoinGecko hash input for onchain compatibility.
    /// @dev Hash: keccak256("COINGECKO_PRICE_UPDATER")
    bytes32 internal constant KEY_PRICE_UPDATER =
        keccak256("COINGECKO_PRICE_UPDATER");
    bytes32 internal constant KEY_COINGECKO_UPDATER = KEY_PRICE_UPDATER;

    /// @notice Price updater view module key.
    /// @dev Used by Registry to store the PriceUpdaterView contract address.
    /// @dev Preserves the legacy CoinGecko hash input for onchain compatibility.
    /// @dev Hash: keccak256("COINGECKO_PRICE_UPDATER_VIEW")
    bytes32 internal constant KEY_PRICE_UPDATER_VIEW =
        keccak256("COINGECKO_PRICE_UPDATER_VIEW");
    bytes32 internal constant KEY_COINGECKO_PRICE_UPDATER_VIEW =
        KEY_PRICE_UPDATER_VIEW;

    /// @notice Settlement token module key.
    /// @dev Used by Registry to store the SettlementToken contract address.
    /// @dev Hash: keccak256("SETTLEMENT_TOKEN")
    bytes32 internal constant KEY_SETTLEMENT_TOKEN =
        keccak256("SETTLEMENT_TOKEN");

    /*━━━━━━━━━━━━━━━ Strategy Modules ━━━━━━━━━━━━━━━*/
    /// @notice RWA auto leveraged strategy module key.
    /// @dev Used by Registry to store the RWAAutoLeveragedStrategy contract address.
    /// @dev Hash: keccak256("RWA_AUTO_LEVERAGED_STRATEGY")
    bytes32 internal constant KEY_RWA_STRATEGY =
        keccak256("RWA_AUTO_LEVERAGED_STRATEGY");

    /*━━━━━━━━━━━━━━━ Business Logic Modules ━━━━━━━━━━━━━━━*/
    /// @notice Vault business logic module key.
    /// @dev Used by Registry to store the VaultBusinessLogic contract address.
    /// @dev Hash: keccak256("VAULT_BUSINESS_LOGIC")
    bytes32 internal constant KEY_VAULT_BUSINESS_LOGIC =
        keccak256("VAULT_BUSINESS_LOGIC");

    /// @notice Registry key for the standalone blocks-only coordinator module.
    /// @dev Used to resolve the BlocksOnlyCoordinator contract that owns blocks-only order creation,
    ///      repayment orchestration, debt-free trade-close, and maturity-gated settlement/liquidation entrypoints.
    /// @dev Hash: keccak256("BLOCKS_ONLY_COORDINATOR")
    bytes32 internal constant KEY_BLOCKS_ONLY_COORDINATOR =
        keccak256("BLOCKS_ONLY_COORDINATOR");

    /// @notice Registry key for the dedicated blocks-only view module.
    /// @dev Used to resolve the BlocksOnlyView contract that exposes permissioned order and runtime read helpers.
    /// @dev Hash: keccak256("BLOCKS_ONLY_VIEW")
    bytes32 internal constant KEY_BLOCKS_ONLY_VIEW =
        keccak256("BLOCKS_ONLY_VIEW");

    /*━━━━━━━━━━━━━━━ View Modules ━━━━━━━━━━━━━━━*/
    /// @notice HealthView module key.
    /// @dev Used by Registry to store the HealthView contract address.
    /// @dev Hash: keccak256("HEALTH_VIEW")
    bytes32 internal constant KEY_HEALTH_VIEW = keccak256("HEALTH_VIEW");
    /// @notice RiskView module key (legacy).
    /// @dev Used by Registry to store the RiskView contract address.
    /// @dev Hash: keccak256("RISK_VIEW")
    bytes32 internal constant KEY_RISK_VIEW = keccak256("RISK_VIEW");
    /// @notice SystemRiskView module key.
    /// @dev Used by Registry to store the SystemRiskView contract address.
    /// @dev Hash: keccak256("SYSTEM_RISK_VIEW")
    bytes32 internal constant KEY_SYSTEM_RISK_VIEW =
        keccak256("SYSTEM_RISK_VIEW");
    /// @notice SystemView module key.
    /// @dev Used by Registry to store the SystemView contract address.
    /// @dev Hash: keccak256("SYSTEM_VIEW")
    bytes32 internal constant KEY_SYSTEM_VIEW = keccak256("SYSTEM_VIEW");
    /// @notice UserViewFacade module key.
    /// @dev Used by Registry to store the UserViewFacade contract address.
    /// @dev Hash: keccak256("USER_VIEW")
    bytes32 internal constant KEY_USER_VIEW = keccak256("USER_VIEW");

    // Additional View modules: Position / Dashboard / Preview
    /// @notice PositionView module key.
    /// @dev Used by Registry to store the PositionView contract address.
    /// @dev Hash: keccak256("POSITION_VIEW")
    bytes32 internal constant KEY_POSITION_VIEW = keccak256("POSITION_VIEW");

    /// @notice DashboardView module key.
    /// @dev Used by Registry to store the DashboardView contract address.
    /// @dev Hash: keccak256("DASHBOARD_VIEW")
    bytes32 internal constant KEY_DASHBOARD_VIEW = keccak256("DASHBOARD_VIEW");

    /// @notice PreviewView module key.
    /// @dev Used by Registry to store the PreviewView contract address.
    /// @dev Hash: keccak256("PREVIEW_VIEW")
    bytes32 internal constant KEY_PREVIEW_VIEW = keccak256("PREVIEW_VIEW");
    /// @notice LiquidationEventsView module key.
    /// @dev Used by Registry to store the LiquidationEventsView contract address.
    /// @dev Hash: keccak256("LIQUIDATION_VIEW")
    bytes32 internal constant KEY_LIQUIDATION_VIEW =
        keccak256("LIQUIDATION_VIEW");

    /// @notice RewardView module key.
    /// @dev Used by Registry to store the RewardView contract address.
    /// @dev Hash: keccak256("REWARD_VIEW")
    bytes32 internal constant KEY_REWARD_VIEW = keccak256("REWARD_VIEW");

    /// @notice View cache module key.
    /// @dev Used by Registry to store the ViewCache contract address.
    /// @dev Hash: keccak256("VIEW_CACHE")
    bytes32 internal constant KEY_VIEW_CACHE = keccak256("VIEW_CACHE");
    /// @notice RegistryView module key.
    /// @dev Read-only registry view for enumeration / reverse-lookup / pagination queries.
    /// @dev Hash: keccak256("REGISTRY_VIEW")
    bytes32 internal constant KEY_REGISTRY_VIEW = keccak256("REGISTRY_VIEW");
    /// @notice SystemHealthView module key.
    /// @dev Read-only system health / degradation view.
    /// @dev Hash: keccak256("SYSTEM_HEALTH_VIEW")
    bytes32 internal constant KEY_SYSTEM_HEALTH_VIEW =
        keccak256("SYSTEM_HEALTH_VIEW");
    /// @notice Liquidation payout manager module key.
    /// @dev Used by Registry to store the LiquidationPayoutManager contract address.
    /// @dev Hash: keccak256("LIQUIDATION_PAYOUT_MANAGER")
    bytes32 internal constant KEY_LIQUIDATION_PAYOUT_MANAGER =
        keccak256("LIQUIDATION_PAYOUT_MANAGER");

    /// @notice Event history manager module key.
    /// @dev Used by Registry to store the EventHistoryManager contract address.
    /// @dev Hash: keccak256("EVENT_HISTORY_MANAGER")
    bytes32 internal constant KEY_EVENT_HISTORY_MANAGER =
        keccak256("EVENT_HISTORY_MANAGER");

    /*━━━━━━━━━━━━━━━ Versioned Keys ━━━━━━━━━━━━━━━*/
    /// @notice Reward manager V1 module key (example).
    /// @dev Used by Registry to store the RewardManager V1 contract address.
    /// @dev Hash: keccak256("REWARD_MANAGER_V1")
    bytes32 internal constant KEY_REWARD_MANAGER_V1 =
        keccak256("REWARD_MANAGER_V1");

    /*━━━━━━━━━━━━━━━ Helper Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get the full static list of module keys.
     * @dev Reverts if:
     *      - N/A
     *
     * Security:
     * - Pure function; does not access external state.
     *
     * @return keys Static key list (dense; order must remain in sync with `getAllKeyStrings()`)
     */
    function getAllKeys() internal pure returns (bytes32[] memory) {
        // NOTE: Keep this list dense (no holes) and in sync with getAllKeyStrings().
        bytes32[] memory keys = new bytes32[](84);
        uint256 i = 0;

        /*━━━━━━━━━━━━━━━ Core Modules ━━━━━━━━━━━━━━━*/
        keys[i++] = KEY_CM;
        keys[i++] = KEY_LE;
        keys[i++] = KEY_HF_CALC;
        keys[i++] = KEY_STATS;
        keys[i++] = KEY_VAULT_CONFIG;
        keys[i++] = KEY_VAULT_CORE;
        keys[i++] = KEY_ORDER_ENGINE;
        keys[i++] = KEY_ORDER_STATE_STORE;

        /*━━━━━━━━━━━━━━━ Supporting Modules ━━━━━━━━━━━━━━━*/
        keys[i++] = KEY_FR;
        keys[i++] = KEY_RM;
        keys[i++] = KEY_REWARD_MANAGER_CORE;
        keys[i++] = KEY_REWARD_ACCRUAL_MANAGER;
        keys[i++] = KEY_REWARD_CONFIG;
        keys[i++] = KEY_REWARD_EARN_CONFIG;
        // Canonical price view facade.
        keys[i++] = KEY_VALUATION_ORACLE_VIEW;
        keys[i++] = KEY_GUARANTEE_FUND;
        keys[i++] = KEY_KEEPER_REGISTRY;
        keys[i++] = KEY_WHITELIST_REGISTRY;

        /*━━━━━━━━━━━━━━━ Access Control Modules ━━━━━━━━━━━━━━━*/
        keys[i++] = KEY_ACCESS_CONTROL;
        keys[i++] = KEY_ACCESS_CONTROLLER;
        keys[i++] = KEY_ASSET_WHITELIST;
        keys[i++] = KEY_AUTHORITY_WHITELIST;

        /*━━━━━━━━━━━━━━━ Registry System Modules ━━━━━━━━━━━━━━━*/
        keys[i++] = KEY_DYNAMIC_MODULE_REGISTRY;

        /*━━━━━━━━━━━━━━━ Governance Modules ━━━━━━━━━━━━━━━*/
        keys[i++] = KEY_CROSS_CHAIN_GOV;
        keys[i++] = KEY_GOVERNANCE_ROLE;

        /*━━━━━━━━━━━━━━━ Registry Module ━━━━━━━━━━━━━━━*/
        keys[i++] = KEY_REGISTRY;

        /*━━━━━━━━━━━━━━━ NFT and Token Modules ━━━━━━━━━━━━━━━*/
        keys[i++] = KEY_LOAN_NFT;
        keys[i++] = KEY_EASY_TOKEN;
        keys[i++] = KEY_RWA_TOKEN;

        /*━━━━━━━━━━━━━━━ Utility Modules ━━━━━━━━━━━━━━━*/
        keys[i++] = KEY_TOKEN_UTILS;
        keys[i++] = KEY_REVERT_DECODER;
        keys[i++] = KEY_VAULT_UTILS;

        /*━━━━━━━━━━━━━━━ Oracle Modules ━━━━━━━━━━━━━━━*/
        keys[i++] = KEY_PRICE_ORACLE;
        keys[i++] = KEY_PRICE_UPDATER;
        keys[i++] = KEY_PRICE_UPDATER_VIEW;
        keys[i++] = KEY_SETTLEMENT_TOKEN;

        /*━━━━━━━━━━━━━━━ Strategy Modules ━━━━━━━━━━━━━━━*/
        keys[i++] = KEY_RWA_STRATEGY;

        /*━━━━━━━━━━━━━━━ Business Logic Modules ━━━━━━━━━━━━━━━*/
        keys[i++] = KEY_VAULT_BUSINESS_LOGIC;
        keys[i++] = KEY_BLOCKS_ONLY_COORDINATOR;

        /*━━━━━━━━━━━━━━━ View Modules ━━━━━━━━━━━━━━━*/
        keys[i++] = KEY_BLOCKS_ONLY_VIEW;
        keys[i++] = KEY_HEALTH_VIEW;
        keys[i++] = KEY_RISK_VIEW;
        keys[i++] = KEY_SYSTEM_VIEW;
        keys[i++] = KEY_USER_VIEW;
        keys[i++] = KEY_VIEW_CACHE;
        keys[i++] = KEY_EVENT_HISTORY_MANAGER;
        keys[i++] = KEY_POSITION_VIEW;
        keys[i++] = KEY_DASHBOARD_VIEW;
        keys[i++] = KEY_PREVIEW_VIEW;
        keys[i++] = KEY_LIQUIDATION_VIEW;
        keys[i++] = KEY_REWARD_VIEW;

        /*━━━━━━━━━━━━━━━ Liquidation and Settlement Modules ━━━━━━━━━━━━━━━*/
        keys[i++] = KEY_LIQUIDATION_MANAGER;
        keys[i++] = KEY_LIQUIDATION_RISK_MANAGER;
        keys[i++] = KEY_LIQUIDATION_ORCHESTRATOR;
        keys[i++] = KEY_LIQUIDATION_CALCULATOR;
        keys[i++] = KEY_LIQUIDATION_CONFIG_MANAGER;

        /*━━━━━━━━━━━━━━━ Versioned Keys ━━━━━━━━━━━━━━━*/
        keys[i++] = KEY_REWARD_MANAGER_V1;
        keys[i++] = KEY_DEGRADATION_MANAGER;

        /*━━━━━━━━━━━━━━━ Additional Modules ━━━━━━━━━━━━━━━*/
        keys[i++] = KEY_VAULT_LENDING_ENGINE;
        keys[i++] = KEY_DEGRADATION_STORAGE;
        keys[i++] = KEY_MODULE_HEALTH_VIEW;
        keys[i++] = KEY_BATCH_VIEW;
        keys[i++] = KEY_EARLY_REPAYMENT_GUARANTEE;
        keys[i++] = KEY_REGISTRY_VIEW;
        keys[i++] = KEY_SYSTEM_HEALTH_VIEW;
        keys[i++] = KEY_LIQUIDATION_PAYOUT_MANAGER;
        // SettlementManager (unified settlement / liquidation write entry)
        keys[i++] = KEY_SETTLEMENT_MANAGER;
        // LenderPoolVault (on-chain liquidity pool)
        keys[i++] = KEY_LENDER_POOL_VAULT;
        // CacheMaintenanceManager (governance ops: batch refresh module caches)
        keys[i++] = KEY_CACHE_MAINTENANCE_MANAGER;
        // SystemRiskView (system-only risk reads)
        keys[i++] = KEY_SYSTEM_RISK_VIEW;
        // Statistics push orchestrator (strict B+)
        keys[i++] = KEY_STATS_PUSH_MANAGER;
        // Loan flow view (protocol flow stats, shared valuation unit)
        keys[i++] = KEY_LOAN_FLOW_VIEW;
        // Loan flow push orchestrator (strict B+)
        keys[i++] = KEY_LOAN_FLOW_PUSH_MANAGER;
        // AI credits vault (on-chain credits SSOT)
        keys[i++] = KEY_AI_CREDITS_VAULT;
        // Governance escrow (deprecated in SSOT one-token mode)
        keys[i++] = KEY_GOVERNANCE_ESCROW;
        // Governance gate (SSOT)
        keys[i++] = KEY_GOVERNANCE_GATE;
        // Feature registry (SSOT)
        keys[i++] = KEY_FEATURE_REGISTRY;
        // Governance guardian (foundation veto)
        keys[i++] = KEY_GOVERNANCE_GUARDIAN;

        /*━━━━━━━━━━━━━━━ Easy Token and Emission Modules ━━━━━━━━━━━━━━━*/
        keys[i++] = KEY_EASY_TOKEN;
        keys[i++] = KEY_EASY_EMISSION_CONFIG;
        keys[i++] = KEY_EASY_EMISSION_CONTROLLER;
        keys[i++] = KEY_EASY_CONSUMPTION;
        keys[i++] = KEY_EASY_RECYCLE_DISTRIBUTOR;
        keys[i++] = KEY_EASY_STAKING;

        return keys;
    }

    /**
     * @notice Get the canonical constant-name strings for the static key list.
     * @dev Reverts if:
     *      - N/A
     *
     * Security:
     * - Pure function; does not access external state.
     *
     * @return names Constant names (e.g. `"KEY_CM"`) ordered to match `getAllKeys()`
     */
    function getAllKeyStrings() internal pure returns (string[] memory) {
        // NOTE: Keep this list dense (no holes) and in sync with getAllKeys().
        string[] memory names = new string[](84);
        uint256 i = 0;

        /*━━━━━━━━━━━━━━━ Core Modules ━━━━━━━━━━━━━━━*/
        names[i++] = "KEY_CM";
        names[i++] = "KEY_LE";
        names[i++] = "KEY_HF_CALC";
        names[i++] = "KEY_STATS";
        names[i++] = "KEY_VAULT_CONFIG";
        names[i++] = "KEY_VAULT_CORE";
        names[i++] = "KEY_ORDER_ENGINE";
        names[i++] = "KEY_ORDER_STATE_STORE";

        /*━━━━━━━━━━━━━━━ Supporting Modules ━━━━━━━━━━━━━━━*/
        names[i++] = "KEY_FR";
        names[i++] = "KEY_RM";
        names[i++] = "KEY_REWARD_MANAGER_CORE";
        names[i++] = "KEY_REWARD_ACCRUAL_MANAGER";
        names[i++] = "KEY_REWARD_CONFIG";
        names[i++] = "KEY_REWARD_EARN_CONFIG";
        names[i++] = "KEY_VALUATION_ORACLE_VIEW";
        names[i++] = "KEY_GUARANTEE_FUND";
        names[i++] = "KEY_KEEPER_REGISTRY";
        names[i++] = "KEY_WHITELIST_REGISTRY";

        /*━━━━━━━━━━━━━━━ Access Control Modules ━━━━━━━━━━━━━━━*/
        names[i++] = "KEY_ACCESS_CONTROL";
        names[i++] = "KEY_ACCESS_CONTROLLER";
        names[i++] = "KEY_ASSET_WHITELIST";
        names[i++] = "KEY_AUTHORITY_WHITELIST";

        /*━━━━━━━━━━━━━━━ Registry System Modules ━━━━━━━━━━━━━━━*/
        names[i++] = "KEY_DYNAMIC_MODULE_REGISTRY";

        /*━━━━━━━━━━━━━━━ Governance Modules ━━━━━━━━━━━━━━━*/
        names[i++] = "KEY_CROSS_CHAIN_GOV";
        names[i++] = "KEY_GOVERNANCE_ROLE";

        /*━━━━━━━━━━━━━━━ Registry Module ━━━━━━━━━━━━━━━*/
        names[i++] = "KEY_REGISTRY";

        /*━━━━━━━━━━━━━━━ NFT and Token Modules ━━━━━━━━━━━━━━━*/
        names[i++] = "KEY_LOAN_NFT";
        names[i++] = "KEY_EASY_TOKEN";
        names[i++] = "KEY_RWA_TOKEN";

        /*━━━━━━━━━━━━━━━ Utility Modules ━━━━━━━━━━━━━━━*/
        names[i++] = "KEY_TOKEN_UTILS";
        names[i++] = "KEY_REVERT_DECODER";
        names[i++] = "KEY_VAULT_UTILS";

        /*━━━━━━━━━━━━━━━ Oracle Modules ━━━━━━━━━━━━━━━*/
        names[i++] = "KEY_PRICE_ORACLE";
        names[i++] = "KEY_PRICE_UPDATER";
        names[i++] = "KEY_PRICE_UPDATER_VIEW";
        names[i++] = "KEY_SETTLEMENT_TOKEN";

        /*━━━━━━━━━━━━━━━ Strategy Modules ━━━━━━━━━━━━━━━*/
        names[i++] = "KEY_RWA_STRATEGY";

        /*━━━━━━━━━━━━━━━ Business Logic Modules ━━━━━━━━━━━━━━━*/
        names[i++] = "KEY_VAULT_BUSINESS_LOGIC";
        names[i++] = "KEY_BLOCKS_ONLY_COORDINATOR";

        /*━━━━━━━━━━━━━━━ View Modules ━━━━━━━━━━━━━━━*/
        names[i++] = "KEY_BLOCKS_ONLY_VIEW";
        names[i++] = "KEY_HEALTH_VIEW";
        names[i++] = "KEY_RISK_VIEW";
        names[i++] = "KEY_SYSTEM_VIEW";
        names[i++] = "KEY_USER_VIEW";
        names[i++] = "KEY_VIEW_CACHE";
        names[i++] = "KEY_EVENT_HISTORY_MANAGER";
        names[i++] = "KEY_POSITION_VIEW";
        names[i++] = "KEY_DASHBOARD_VIEW";
        names[i++] = "KEY_PREVIEW_VIEW";
        names[i++] = "KEY_LIQUIDATION_VIEW";
        names[i++] = "KEY_REWARD_VIEW";

        /*━━━━━━━━━━━━━━━ Liquidation and Settlement Modules ━━━━━━━━━━━━━━━*/
        names[i++] = "KEY_LIQUIDATION_MANAGER";
        names[i++] = "KEY_LIQUIDATION_RISK_MANAGER";
        names[i++] = "KEY_LIQUIDATION_ORCHESTRATOR";
        names[i++] = "KEY_LIQUIDATION_CALCULATOR";
        names[i++] = "KEY_LIQUIDATION_CONFIG_MANAGER";

        /*━━━━━━━━━━━━━━━ Versioned Keys ━━━━━━━━━━━━━━━*/
        names[i++] = "KEY_REWARD_MANAGER_V1";
        names[i++] = "KEY_DEGRADATION_MANAGER";

        /*━━━━━━━━━━━━━━━ Additional Modules ━━━━━━━━━━━━━━━*/
        names[i++] = "KEY_VAULT_LENDING_ENGINE";
        names[i++] = "KEY_DEGRADATION_STORAGE";
        names[i++] = "KEY_MODULE_HEALTH_VIEW";
        names[i++] = "KEY_BATCH_VIEW";
        names[i++] = "KEY_EARLY_REPAYMENT_GUARANTEE";
        names[i++] = "KEY_REGISTRY_VIEW";
        names[i++] = "KEY_SYSTEM_HEALTH_VIEW";
        names[i++] = "KEY_LIQUIDATION_PAYOUT_MANAGER";
        names[i++] = "KEY_SETTLEMENT_MANAGER";
        names[i++] = "KEY_LENDER_POOL_VAULT";
        names[i++] = "KEY_CACHE_MAINTENANCE_MANAGER";
        names[i++] = "KEY_SYSTEM_RISK_VIEW";
        names[i++] = "KEY_STATS_PUSH_MANAGER";
        names[i++] = "KEY_LOAN_FLOW_VIEW";
        names[i++] = "KEY_LOAN_FLOW_PUSH_MANAGER";
        names[i++] = "KEY_AI_CREDITS_VAULT";
        names[i++] = "KEY_GOVERNANCE_ESCROW";
        names[i++] = "KEY_GOVERNANCE_GATE";
        names[i++] = "KEY_FEATURE_REGISTRY";
        names[i++] = "KEY_GOVERNANCE_GUARDIAN";

        /*━━━━━━━━━━━━━━━ Easy Token and Emission Modules ━━━━━━━━━━━━━━━*/
        names[i++] = "KEY_EASY_TOKEN";
        names[i++] = "KEY_EASY_EMISSION_CONFIG";
        names[i++] = "KEY_EASY_EMISSION_CONTROLLER";
        names[i++] = "KEY_EASY_CONSUMPTION";
        names[i++] = "KEY_EASY_RECYCLE_DISTRIBUTOR";
        names[i++] = "KEY_EASY_STAKING";

        return names;
    }

    /**
     * @notice Return the total number of keys in the canonical static module-key list.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure helper; derives count from {getAllKeys} so callers inherit the current canonical list length.
     *
     * @return count Number of keys in {getAllKeys}.
     */
    function getKeyCount() internal pure returns (uint256) {
        return getAllKeys().length;
    }

    /**
     * @notice Get a module key by index from the static list.
     * @dev Reverts if:
     *      - index >= getAllKeys().length
     *
     * Security:
     * - Pure function; does not access external state.
     *
     * @param index Zero-based index in `getAllKeys()`
     * @return key Module key at `index`
     */
    function getKeyByIndex(uint256 index) internal pure returns (bytes32) {
        bytes32[] memory keys = getAllKeys();
        if (index >= keys.length)
            revert ModuleKeys__IndexOutOfBounds(index, keys.length);
        return keys[index];
    }

    /**
     * @notice Convert a module key to a legacy lowerCamelCase module name.
     * @dev Reverts if:
     *      - N/A (returns empty string for unknown keys)
     *
     * Security:
     * - Pure function; does not access external state.
     * - This is a legacy mapping for backwards compatibility; new integrations should prefer canonical constant names.
     *
     * @param key Module key (`bytes32`)
     * @return name Legacy module name (lowerCamelCase), or empty string if unknown
     */
    function getModuleKeyString(
        bytes32 key
    ) internal pure returns (string memory) {
        if (key == KEY_CM) return "collateralManager";
        if (key == KEY_LE) return "lendingEngine";
        if (key == KEY_ORDER_ENGINE) return "orderEngine";
        if (key == KEY_ORDER_STATE_STORE) return "orderStateStore";
        // Deprecated: do not return "hfCalculator" mapping anymore.
        // Phase 1: KEY_STATS points to StatisticsView.
        if (key == KEY_STATS) return "statisticsView";
        if (key == KEY_VAULT_CONFIG) return "vaultConfig";
        if (key == KEY_VAULT_CORE) return "vaultCore";
        if (key == KEY_FR) return "feeRouter";
        if (key == KEY_RM) return "rewardManager";
        if (key == KEY_REWARD_MANAGER_CORE) return "rewardManagerCore";
        if (key == KEY_REWARD_ACCRUAL_MANAGER) return "rewardAccrualManager";
        if (key == KEY_REWARD_CONFIG) return "rewardConfig";
        if (key == KEY_REWARD_EARN_CONFIG) return "rewardEarnConfig";
        if (key == KEY_EASY_EMISSION_CONFIG) return "easyEmissionConfig";
        if (key == KEY_EASY_EMISSION_CONTROLLER)
            return "easyEmissionController";
        if (key == KEY_EASY_CONSUMPTION) return "easyConsumption";
        if (key == KEY_EASY_RECYCLE_DISTRIBUTOR)
            return "easyRecycleDistributor";
        if (key == KEY_EASY_STAKING) return "easyStaking";
        // DEPRECATED: use "priceOracle" in new code.
        if (key == KEY_VALUATION_ORACLE) return "valuationOracle";
        if (key == KEY_VALUATION_ORACLE_VIEW) return "valuationOracleView";
        if (key == KEY_GUARANTEE_FUND) return "guaranteeFundManager";
        if (key == KEY_KEEPER_REGISTRY) return "keeperRegistry";
        if (key == KEY_WHITELIST_REGISTRY) return "whitelistRegistry";
        if (key == KEY_ACCESS_CONTROL) return "accessControlManager";
        if (key == KEY_ACCESS_CONTROLLER) return "accessController";
        if (key == KEY_ASSET_WHITELIST) return "assetWhitelist";
        if (key == KEY_AUTHORITY_WHITELIST) return "authorityWhitelist";
        if (key == KEY_DYNAMIC_MODULE_REGISTRY) return "dynamicModuleRegistry";
        if (key == KEY_CROSS_CHAIN_GOV) return "crossChainGovernance";
        if (key == KEY_GOVERNANCE_ROLE) return "governanceRole";
        if (key == KEY_GOVERNANCE_ESCROW) return "governanceEscrow";
        if (key == KEY_GOVERNANCE_GATE) return "governanceGate";
        if (key == KEY_FEATURE_REGISTRY) return "featureRegistry";
        if (key == KEY_GOVERNANCE_GUARDIAN) return "governanceGuardian";
        if (key == KEY_REGISTRY) return "registry";
        if (key == KEY_LOAN_NFT) return "loanNFT";
        if (key == KEY_EASY_TOKEN) return "easyToken";
        if (key == KEY_AI_CREDITS_VAULT) return "aiCreditsVault";
        if (key == KEY_RWA_TOKEN) return "rwaToken";
        if (key == KEY_TOKEN_UTILS) return "tokenUtils";
        if (key == KEY_REVERT_DECODER) return "revertDecoder";
        if (key == KEY_VAULT_UTILS) return "vaultUtils";
        if (key == KEY_PRICE_ORACLE) return "priceOracle";
        if (key == KEY_PRICE_UPDATER) return "priceUpdater";
        if (key == KEY_PRICE_UPDATER_VIEW) return "priceUpdaterView";
        if (key == KEY_SETTLEMENT_TOKEN) return "settlementToken";
        if (key == KEY_RWA_STRATEGY) return "rwaAutoLeveragedStrategy";
        if (key == KEY_VAULT_BUSINESS_LOGIC) return "vaultBusinessLogic";
        if (key == KEY_BLOCKS_ONLY_COORDINATOR) return "blocksOnlyCoordinator";
        if (key == KEY_BLOCKS_ONLY_VIEW) return "blocksOnlyView";
        if (key == KEY_SETTLEMENT_MANAGER) return "settlementManager";
        if (key == KEY_LENDER_POOL_VAULT) return "lenderPoolVault";
        if (key == KEY_LIQUIDATION_MANAGER) return "liquidationManager";
        if (key == KEY_LIQUIDATION_RISK_MANAGER)
            return "liquidationRiskManager";
        if (key == KEY_LIQUIDATION_ORCHESTRATOR)
            return "liquidationOrchestrator";
        if (key == KEY_LIQUIDATION_CALCULATOR) return "liquidationCalculator";
        if (key == KEY_LIQUIDATION_CONFIG_MANAGER)
            return "liquidationConfigManager";
        if (key == KEY_REWARD_VIEW) return "rewardView";
        if (key == KEY_VAULT_LENDING_ENGINE) return "vaultLendingEngine";
        if (key == KEY_DEGRADATION_STORAGE) return "degradationStorage";
        if (key == KEY_MODULE_HEALTH_VIEW) return "moduleHealthView";
        if (key == KEY_BATCH_VIEW) return "batchView";
        if (key == KEY_EARLY_REPAYMENT_GUARANTEE)
            return "earlyRepaymentGuaranteeManager";
        if (key == KEY_REWARD_MANAGER_V1) return "rewardManagerV1";
        if (key == KEY_DEGRADATION_MANAGER) return "degradationManager";
        if (key == KEY_POSITION_VIEW) return "positionView";
        if (key == KEY_DASHBOARD_VIEW) return "dashboardView";
        if (key == KEY_PREVIEW_VIEW) return "previewView";
        if (key == KEY_LIQUIDATION_VIEW) return "liquidationView";
        if (key == KEY_SYSTEM_RISK_VIEW) return "systemRiskView";
        if (key == KEY_CACHE_MAINTENANCE_MANAGER)
            return "cacheMaintenanceManager";
        if (key == KEY_STATS_PUSH_MANAGER) return "statisticsPushManager";
        if (key == KEY_LOAN_FLOW_VIEW) return "loanFlowView";
        if (key == KEY_LOAN_FLOW_PUSH_MANAGER) return "loanFlowPushManager";
        return "";
    }

    /**
     * @notice Convert a module key to its canonical constant name (e.g. `KEY_CM`).
     * @dev Reverts if:
     *      - key == bytes32(0)
     *      - key is not recognized by this registry
     *
     * Security:
     * - Pure function; does not access external state.
     *
     * @param key Module key (`bytes32`) to convert
     * @return constantName Canonical constant name string (UPPER_SNAKE_CASE)
     */
    function getModuleKeyConstantString(
        bytes32 key
    ) internal pure returns (string memory) {
        if (key == bytes32(0)) revert ModuleKeys__InvalidModuleKey();

        if (key == KEY_CM) return "KEY_CM";
        if (key == KEY_LE) return "KEY_LE";
        if (key == KEY_ORDER_ENGINE) return "KEY_ORDER_ENGINE";
        if (key == KEY_ORDER_STATE_STORE) return "KEY_ORDER_STATE_STORE";
        // Deprecated: do not return KEY_HF_CALC anymore.
        if (key == KEY_STATS) return "KEY_STATS";
        if (key == KEY_VAULT_CONFIG) return "KEY_VAULT_CONFIG";
        if (key == KEY_VAULT_CORE) return "KEY_VAULT_CORE";
        if (key == KEY_FR) return "KEY_FR";
        if (key == KEY_RM) return "KEY_RM";
        if (key == KEY_REWARD_MANAGER_CORE) return "KEY_REWARD_MANAGER_CORE";
        if (key == KEY_REWARD_ACCRUAL_MANAGER)
            return "KEY_REWARD_ACCRUAL_MANAGER";
        if (key == KEY_REWARD_CONFIG) return "KEY_REWARD_CONFIG";
        if (key == KEY_REWARD_EARN_CONFIG) return "KEY_REWARD_EARN_CONFIG";
        if (key == KEY_EASY_EMISSION_CONFIG) return "KEY_EASY_EMISSION_CONFIG";
        if (key == KEY_EASY_EMISSION_CONTROLLER)
            return "KEY_EASY_EMISSION_CONTROLLER";
        if (key == KEY_EASY_CONSUMPTION) return "KEY_EASY_CONSUMPTION";
        if (key == KEY_EASY_RECYCLE_DISTRIBUTOR)
            return "KEY_EASY_RECYCLE_DISTRIBUTOR";
        if (key == KEY_EASY_STAKING) return "KEY_EASY_STAKING";
        // DEPRECATED: preserved for backward compatibility only.
        if (key == KEY_VALUATION_ORACLE) return "KEY_VALUATION_ORACLE";
        if (key == KEY_VALUATION_ORACLE_VIEW)
            return "KEY_VALUATION_ORACLE_VIEW";
        if (key == KEY_GUARANTEE_FUND) return "KEY_GUARANTEE_FUND";
        if (key == KEY_KEEPER_REGISTRY) return "KEY_KEEPER_REGISTRY";
        if (key == KEY_WHITELIST_REGISTRY) return "KEY_WHITELIST_REGISTRY";
        if (key == KEY_ACCESS_CONTROL) return "KEY_ACCESS_CONTROL";
        if (key == KEY_ACCESS_CONTROLLER) return "KEY_ACCESS_CONTROLLER";
        if (key == KEY_ASSET_WHITELIST) return "KEY_ASSET_WHITELIST";
        if (key == KEY_AUTHORITY_WHITELIST) return "KEY_AUTHORITY_WHITELIST";
        if (key == KEY_DYNAMIC_MODULE_REGISTRY)
            return "KEY_DYNAMIC_MODULE_REGISTRY";
        if (key == KEY_CROSS_CHAIN_GOV) return "KEY_CROSS_CHAIN_GOV";
        if (key == KEY_GOVERNANCE_ROLE) return "KEY_GOVERNANCE_ROLE";
        if (key == KEY_GOVERNANCE_ESCROW) return "KEY_GOVERNANCE_ESCROW";
        if (key == KEY_GOVERNANCE_GATE) return "KEY_GOVERNANCE_GATE";
        if (key == KEY_FEATURE_REGISTRY) return "KEY_FEATURE_REGISTRY";
        if (key == KEY_GOVERNANCE_GUARDIAN) return "KEY_GOVERNANCE_GUARDIAN";
        if (key == KEY_REGISTRY) return "KEY_REGISTRY";
        if (key == KEY_LOAN_NFT) return "KEY_LOAN_NFT";
        if (key == KEY_EASY_TOKEN) return "KEY_EASY_TOKEN";
        if (key == KEY_AI_CREDITS_VAULT) return "KEY_AI_CREDITS_VAULT";
        if (key == KEY_RWA_TOKEN) return "KEY_RWA_TOKEN";
        if (key == KEY_TOKEN_UTILS) return "KEY_TOKEN_UTILS";
        if (key == KEY_REVERT_DECODER) return "KEY_REVERT_DECODER";
        if (key == KEY_VAULT_UTILS) return "KEY_VAULT_UTILS";
        if (key == KEY_PRICE_ORACLE) return "KEY_PRICE_ORACLE";
        if (key == KEY_PRICE_UPDATER) return "KEY_PRICE_UPDATER";
        if (key == KEY_PRICE_UPDATER_VIEW) return "KEY_PRICE_UPDATER_VIEW";
        if (key == KEY_SETTLEMENT_TOKEN) return "KEY_SETTLEMENT_TOKEN";
        if (key == KEY_RWA_STRATEGY) return "KEY_RWA_STRATEGY";
        if (key == KEY_VAULT_BUSINESS_LOGIC) return "KEY_VAULT_BUSINESS_LOGIC";
        if (key == KEY_BLOCKS_ONLY_COORDINATOR)
            return "KEY_BLOCKS_ONLY_COORDINATOR";
        if (key == KEY_BLOCKS_ONLY_VIEW) return "KEY_BLOCKS_ONLY_VIEW";
        if (key == KEY_SETTLEMENT_MANAGER) return "KEY_SETTLEMENT_MANAGER";
        if (key == KEY_LENDER_POOL_VAULT) return "KEY_LENDER_POOL_VAULT";
        if (key == KEY_LIQUIDATION_MANAGER) return "KEY_LIQUIDATION_MANAGER";
        if (key == KEY_LIQUIDATION_RISK_MANAGER)
            return "KEY_LIQUIDATION_RISK_MANAGER";
        if (key == KEY_LIQUIDATION_ORCHESTRATOR)
            return "KEY_LIQUIDATION_ORCHESTRATOR";
        if (key == KEY_LIQUIDATION_CALCULATOR)
            return "KEY_LIQUIDATION_CALCULATOR";
        if (key == KEY_LIQUIDATION_CONFIG_MANAGER)
            return "KEY_LIQUIDATION_CONFIG_MANAGER";
        if (key == KEY_REWARD_MANAGER_V1) return "KEY_REWARD_MANAGER_V1";
        if (key == KEY_DEGRADATION_MANAGER) return "KEY_DEGRADATION_MANAGER";
        if (key == KEY_POSITION_VIEW) return "KEY_POSITION_VIEW";
        if (key == KEY_DASHBOARD_VIEW) return "KEY_DASHBOARD_VIEW";
        if (key == KEY_PREVIEW_VIEW) return "KEY_PREVIEW_VIEW";
        if (key == KEY_LIQUIDATION_VIEW) return "KEY_LIQUIDATION_VIEW";
        if (key == KEY_REWARD_VIEW) return "KEY_REWARD_VIEW";
        if (key == KEY_VAULT_LENDING_ENGINE) return "KEY_VAULT_LENDING_ENGINE";
        if (key == KEY_DEGRADATION_STORAGE) return "KEY_DEGRADATION_STORAGE";
        if (key == KEY_MODULE_HEALTH_VIEW) return "KEY_MODULE_HEALTH_VIEW";
        if (key == KEY_BATCH_VIEW) return "KEY_BATCH_VIEW";
        if (key == KEY_EARLY_REPAYMENT_GUARANTEE)
            return "KEY_EARLY_REPAYMENT_GUARANTEE";
        if (key == KEY_CACHE_MAINTENANCE_MANAGER)
            return "KEY_CACHE_MAINTENANCE_MANAGER";
        if (key == KEY_SYSTEM_RISK_VIEW) return "KEY_SYSTEM_RISK_VIEW";
        if (key == KEY_STATS_PUSH_MANAGER) return "KEY_STATS_PUSH_MANAGER";
        if (key == KEY_LOAN_FLOW_VIEW) return "KEY_LOAN_FLOW_VIEW";
        if (key == KEY_LOAN_FLOW_PUSH_MANAGER)
            return "KEY_LOAN_FLOW_PUSH_MANAGER";

        revert ModuleKeys__UnknownModuleKey(key);
    }

    /**
     * @notice Convert a legacy lowerCamelCase module name to its canonical module key.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure compatibility helper for legacy config / tooling inputs.
     * - Unknown names intentionally return `bytes32(0)` instead of reverting,
     *   so callers must explicitly validate non-zero output before using it as a Registry key.
     * - Comparison is hash-based via `keccak256(abi.encodePacked(name))` against the hard-coded compatibility map.
     *
     * @param name Legacy lowerCamelCase module name.
     * @return key Canonical module key, or `bytes32(0)` if `name` is unknown.
     */
    function getModuleKeyFromString(
        string memory name
    ) internal pure returns (bytes32) {
        bytes32 nameHash = keccak256(abi.encodePacked(name));
        if (nameHash == keccak256(abi.encodePacked("collateralManager")))
            return KEY_CM;
        if (nameHash == keccak256(abi.encodePacked("lendingEngine")))
            return KEY_LE;
        if (nameHash == keccak256(abi.encodePacked("orderEngine")))
            return KEY_ORDER_ENGINE;
        if (nameHash == keccak256(abi.encodePacked("orderStateStore")))
            return KEY_ORDER_STATE_STORE;
        // Deprecated: do not support "hfCalculator" name mapping anymore.
        // Preserved: keep "statisticsView" mapping for backward compatibility.
        if (nameHash == keccak256(abi.encodePacked("statisticsView")))
            return KEY_STATS;
        if (nameHash == keccak256(abi.encodePacked("vaultConfig")))
            return KEY_VAULT_CONFIG;
        if (nameHash == keccak256(abi.encodePacked("vaultCore")))
            return KEY_VAULT_CORE;
        if (nameHash == keccak256(abi.encodePacked("feeRouter"))) return KEY_FR;
        if (nameHash == keccak256(abi.encodePacked("rewardManager")))
            return KEY_RM;
        if (nameHash == keccak256(abi.encodePacked("rewardManagerCore")))
            return KEY_REWARD_MANAGER_CORE;
        if (nameHash == keccak256(abi.encodePacked("rewardAccrualManager")))
            return KEY_REWARD_ACCRUAL_MANAGER;
        if (nameHash == keccak256(abi.encodePacked("rewardConfig")))
            return KEY_REWARD_CONFIG;
        if (nameHash == keccak256(abi.encodePacked("rewardEarnConfig")))
            return KEY_REWARD_EARN_CONFIG;
        if (nameHash == keccak256(abi.encodePacked("easyEmissionConfig")))
            return KEY_EASY_EMISSION_CONFIG;
        if (nameHash == keccak256(abi.encodePacked("easyEmissionController")))
            return KEY_EASY_EMISSION_CONTROLLER;
        if (nameHash == keccak256(abi.encodePacked("easyConsumption")))
            return KEY_EASY_CONSUMPTION;
        if (nameHash == keccak256(abi.encodePacked("easyRecycleDistributor")))
            return KEY_EASY_RECYCLE_DISTRIBUTOR;
        if (nameHash == keccak256(abi.encodePacked("easyStaking")))
            return KEY_EASY_STAKING;
        if (nameHash == keccak256(abi.encodePacked("valuationOracle")))
            return KEY_VALUATION_ORACLE; // DEPRECATED
        if (nameHash == keccak256(abi.encodePacked("valuationOracleView")))
            return KEY_VALUATION_ORACLE_VIEW;
        if (nameHash == keccak256(abi.encodePacked("guaranteeFundManager")))
            return KEY_GUARANTEE_FUND;
        if (nameHash == keccak256(abi.encodePacked("keeperRegistry")))
            return KEY_KEEPER_REGISTRY;
        if (nameHash == keccak256(abi.encodePacked("whitelistRegistry")))
            return KEY_WHITELIST_REGISTRY;
        if (nameHash == keccak256(abi.encodePacked("accessControlManager")))
            return KEY_ACCESS_CONTROL;
        if (nameHash == keccak256(abi.encodePacked("accessController")))
            return KEY_ACCESS_CONTROLLER;
        if (nameHash == keccak256(abi.encodePacked("assetWhitelist")))
            return KEY_ASSET_WHITELIST;
        if (nameHash == keccak256(abi.encodePacked("authorityWhitelist")))
            return KEY_AUTHORITY_WHITELIST;
        if (nameHash == keccak256(abi.encodePacked("dynamicModuleRegistry")))
            return KEY_DYNAMIC_MODULE_REGISTRY;
        if (nameHash == keccak256(abi.encodePacked("crossChainGovernance")))
            return KEY_CROSS_CHAIN_GOV;
        if (nameHash == keccak256(abi.encodePacked("governanceRole")))
            return KEY_GOVERNANCE_ROLE;
        if (nameHash == keccak256(abi.encodePacked("governanceEscrow")))
            return KEY_GOVERNANCE_ESCROW;
        if (nameHash == keccak256(abi.encodePacked("governanceGate")))
            return KEY_GOVERNANCE_GATE;
        if (nameHash == keccak256(abi.encodePacked("featureRegistry")))
            return KEY_FEATURE_REGISTRY;
        if (nameHash == keccak256(abi.encodePacked("governanceGuardian")))
            return KEY_GOVERNANCE_GUARDIAN;
        if (nameHash == keccak256(abi.encodePacked("registry")))
            return KEY_REGISTRY;
        if (nameHash == keccak256(abi.encodePacked("loanNFT")))
            return KEY_LOAN_NFT;
        if (nameHash == keccak256(abi.encodePacked("easyToken")))
            return KEY_EASY_TOKEN;
        if (nameHash == keccak256(abi.encodePacked("aiCreditsVault")))
            return KEY_AI_CREDITS_VAULT;
        if (nameHash == keccak256(abi.encodePacked("rwaToken")))
            return KEY_RWA_TOKEN;
        if (nameHash == keccak256(abi.encodePacked("tokenUtils")))
            return KEY_TOKEN_UTILS;
        if (nameHash == keccak256(abi.encodePacked("revertDecoder")))
            return KEY_REVERT_DECODER;
        if (nameHash == keccak256(abi.encodePacked("vaultUtils")))
            return KEY_VAULT_UTILS;
        if (nameHash == keccak256(abi.encodePacked("priceOracle")))
            return KEY_PRICE_ORACLE;
        if (nameHash == keccak256(abi.encodePacked("priceUpdater")))
            return KEY_PRICE_UPDATER;
        if (nameHash == keccak256(abi.encodePacked("coinGeckoPriceUpdater")))
            return KEY_PRICE_UPDATER;
        if (nameHash == keccak256(abi.encodePacked("priceUpdaterView"))) {
            return KEY_PRICE_UPDATER_VIEW;
        }
        if (
            nameHash == keccak256(abi.encodePacked("coinGeckoPriceUpdaterView"))
        ) {
            return KEY_PRICE_UPDATER_VIEW;
        }
        if (nameHash == keccak256(abi.encodePacked("settlementToken")))
            return KEY_SETTLEMENT_TOKEN;
        if (nameHash == keccak256(abi.encodePacked("rwaAutoLeveragedStrategy")))
            return KEY_RWA_STRATEGY;
        if (nameHash == keccak256(abi.encodePacked("vaultBusinessLogic")))
            return KEY_VAULT_BUSINESS_LOGIC;
        if (nameHash == keccak256(abi.encodePacked("blocksOnlyCoordinator")))
            return KEY_BLOCKS_ONLY_COORDINATOR;
        if (nameHash == keccak256(abi.encodePacked("blocksOnlyView")))
            return KEY_BLOCKS_ONLY_VIEW;
        if (nameHash == keccak256(abi.encodePacked("settlementManager")))
            return KEY_SETTLEMENT_MANAGER;
        if (nameHash == keccak256(abi.encodePacked("lenderPoolVault")))
            return KEY_LENDER_POOL_VAULT;
        if (nameHash == keccak256(abi.encodePacked("liquidationManager")))
            return KEY_LIQUIDATION_MANAGER;
        if (nameHash == keccak256(abi.encodePacked("liquidationRiskManager")))
            return KEY_LIQUIDATION_RISK_MANAGER;
        if (nameHash == keccak256(abi.encodePacked("liquidationOrchestrator")))
            return KEY_LIQUIDATION_ORCHESTRATOR;
        if (nameHash == keccak256(abi.encodePacked("liquidationCalculator")))
            return KEY_LIQUIDATION_CALCULATOR;
        if (nameHash == keccak256(abi.encodePacked("liquidationConfigManager")))
            return KEY_LIQUIDATION_CONFIG_MANAGER;
        if (nameHash == keccak256(abi.encodePacked("rewardManagerV1")))
            return KEY_REWARD_MANAGER_V1;
        if (nameHash == keccak256(abi.encodePacked("degradationManager")))
            return KEY_DEGRADATION_MANAGER;
        if (nameHash == keccak256(abi.encodePacked("positionView")))
            return KEY_POSITION_VIEW;
        if (nameHash == keccak256(abi.encodePacked("dashboardView")))
            return KEY_DASHBOARD_VIEW;
        if (nameHash == keccak256(abi.encodePacked("previewView")))
            return KEY_PREVIEW_VIEW;
        if (nameHash == keccak256(abi.encodePacked("liquidationView")))
            return KEY_LIQUIDATION_VIEW;
        // DEPRECATED alias: prefer "liquidationView"
        if (nameHash == keccak256(abi.encodePacked("liquidatorView")))
            return KEY_LIQUIDATION_VIEW;
        if (nameHash == keccak256(abi.encodePacked("rewardView")))
            return KEY_REWARD_VIEW;
        if (nameHash == keccak256(abi.encodePacked("systemRiskView")))
            return KEY_SYSTEM_RISK_VIEW;
        if (nameHash == keccak256(abi.encodePacked("vaultLendingEngine")))
            return KEY_VAULT_LENDING_ENGINE;
        if (nameHash == keccak256(abi.encodePacked("degradationStorage")))
            return KEY_DEGRADATION_STORAGE;
        if (nameHash == keccak256(abi.encodePacked("moduleHealthView")))
            return KEY_MODULE_HEALTH_VIEW;
        if (nameHash == keccak256(abi.encodePacked("batchView")))
            return KEY_BATCH_VIEW;
        if (
            nameHash ==
            keccak256(abi.encodePacked("earlyRepaymentGuaranteeManager"))
        ) {
            return KEY_EARLY_REPAYMENT_GUARANTEE;
        }
        if (nameHash == keccak256(abi.encodePacked("cacheMaintenanceManager")))
            return KEY_CACHE_MAINTENANCE_MANAGER;
        if (nameHash == keccak256(abi.encodePacked("statisticsPushManager")))
            return KEY_STATS_PUSH_MANAGER;
        if (nameHash == keccak256(abi.encodePacked("loanFlowView")))
            return KEY_LOAN_FLOW_VIEW;
        if (nameHash == keccak256(abi.encodePacked("loanFlowPushManager")))
            return KEY_LOAN_FLOW_PUSH_MANAGER;

        return bytes32(0);
    }

    /**
     * @notice Return whether `key` exists in the canonical static module-key list.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure validation helper.
     * - Returns `false` for unknown keys instead of reverting,
     *   so callers can handle invalid configuration paths explicitly.
     *
     * @param key Module key to validate.
     * @return isValid True if `key` is present in {getAllKeys}.
     */
    function isValidModuleKey(bytes32 key) internal pure returns (bool) {
        bytes32[] memory keys = getAllKeys();
        for (uint256 i = 0; i < keys.length; i++) {
            if (keys[i] == key) {
                return true;
            }
        }
        return false;
    }
}
