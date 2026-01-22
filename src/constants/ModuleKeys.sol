// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @notice Central registry of module identifiers as `bytes32` keys (keccak256 hashes).
 * @dev Reverts if:
 *      - N/A (pure constant registry; only helper functions may revert as documented)
 *
 * Security:
 * - Keys are deterministic (`keccak256("<MODULE_NAME>")`) and must remain stable once deployed.
 * - Do not change existing key values to preserve backward compatibility with on-chain registry data.
 */
library ModuleKeys {
    // ============ Custom Errors ============
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

    // ============ Core Modules ============
    /// @notice CollateralManager module key.
    /// @dev Used by Registry to store the CollateralManager contract address.
    /// @dev Hash: keccak256("COLLATERAL_MANAGER")
    bytes32 internal constant KEY_CM = keccak256("COLLATERAL_MANAGER");
    
    /// @notice Lending engine (ledger) module key (VaultLendingEngine / ILendingEngineBasic).
    /// @dev Used by Registry to store the lending engine contract address.
    /// @dev Hash: keccak256("LENDING_ENGINE")
    bytes32 internal constant KEY_LE = keccak256("LENDING_ENGINE");

    /// @notice Vault lending engine module key.
    /// @dev Used by Registry to store the VaultLendingEngine contract address.
    /// @dev Hash: keccak256("VAULT_LENDING_ENGINE")
    bytes32 internal constant KEY_VAULT_LENDING_ENGINE = keccak256("VAULT_LENDING_ENGINE");

    /// @notice Order engine module key (core/LendingEngine / IOrderEngine).
    /// @dev Used by Registry to store the order engine contract address.
    /// @dev Hash: keccak256("ORDER_ENGINE")
    bytes32 internal constant KEY_ORDER_ENGINE = keccak256("ORDER_ENGINE");
    
    /// @notice Deprecated: health factor calculator module key.
    /// @dev Replaced by LiquidationRiskManager / HealthView.
    /// @dev Preserved as a placeholder to avoid breaking legacy data/scripts; new code must not use it.
    /// @dev Hash: keccak256("HEALTH_FACTOR_CALCULATOR")
    bytes32 internal constant KEY_HF_CALC = keccak256("HEALTH_FACTOR_CALCULATOR");
    
    /// @notice Vault statistics module key.
    /// @dev Used by Registry to store the VaultStatistics (or StatisticsView) contract address.
    /// @dev Hash: keccak256("VAULT_STATISTICS")
    bytes32 internal constant KEY_STATS = keccak256("VAULT_STATISTICS");
    
    /// @notice Degradation core monitoring module identifier
    /// @dev Hash: keccak256("DEGRADATION_CORE")
    bytes32 internal constant KEY_DEGRADATION_CORE = keccak256("DEGRADATION_CORE");

    /// @notice Degradation monitor (keeper) module identifier
    /// @dev Hash: keccak256("DEGRADATION_MONITOR")
    bytes32 internal constant KEY_DEGRADATION_MONITOR = keccak256("DEGRADATION_MONITOR");
    
    /// @notice Degradation storage module identifier
    /// @dev Hash: keccak256("DEGRADATION_STORAGE")
    bytes32 internal constant KEY_DEGRADATION_STORAGE = keccak256("DEGRADATION_STORAGE");
    
    /// @notice Module health view module identifier
    /// @dev Hash: keccak256("MODULE_HEALTH_VIEW")
    bytes32 internal constant KEY_MODULE_HEALTH_VIEW = keccak256("MODULE_HEALTH_VIEW");
    
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

    // ============ Supporting Modules ============
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
    
    /// @notice Reward core module key.
    /// @dev Used by Registry to store the RewardCore contract address.
    /// @dev Hash: keccak256("REWARD_CORE")
    bytes32 internal constant KEY_REWARD_CORE = keccak256("REWARD_CORE");
    
    /// @notice Reward manager core module key.
    /// @dev Used by Registry to store the RewardManagerCore contract address.
    /// @dev Hash: keccak256("REWARD_MANAGER_CORE")
    bytes32 internal constant KEY_REWARD_MANAGER_CORE = keccak256("REWARD_MANAGER_CORE");
    
    /// @notice Reward configuration module key.
    /// @dev Used by Registry to store the RewardConfig contract address.
    /// @dev Hash: keccak256("REWARD_CONFIG")
    bytes32 internal constant KEY_REWARD_CONFIG = keccak256("REWARD_CONFIG");
    
    /// @notice Reward consumption module key.
    /// @dev Used by Registry to store the RewardConsumption contract address.
    /// @dev Hash: keccak256("REWARD_CONSUMPTION")
    bytes32 internal constant KEY_REWARD_CONSUMPTION = keccak256("REWARD_CONSUMPTION");
    
    /// @notice Deprecated: valuation oracle adapter module key.
    /// @dev Replaced by KEY_PRICE_ORACLE; preserved for backward compatibility only. New code must not use it.
    /// @dev Hash: keccak256("VALUATION_ORACLE")
    bytes32 internal constant KEY_VALUATION_ORACLE = keccak256("VALUATION_ORACLE");

    /// @notice ValuationOracleView module key (canonical price view facade).
    /// @dev Used by Registry to store the ValuationOracleView contract address.
    /// @dev Hash: keccak256("VALUATION_ORACLE_VIEW")
    bytes32 internal constant KEY_VALUATION_ORACLE_VIEW = keccak256("VALUATION_ORACLE_VIEW");
    
    /// @notice Guarantee fund manager module key.
    /// @dev Used by Registry to store the GuaranteeFundManager contract address.
    /// @dev Hash: keccak256("GUARANTEE_FUND_MANAGER")
    bytes32 internal constant KEY_GUARANTEE_FUND = keccak256("GUARANTEE_FUND_MANAGER");
    
    /// @notice Early repayment guarantee manager module key.
    /// @dev Used by Registry to store the EarlyRepaymentGuaranteeManager contract address.
    /// @dev Hash: keccak256("EARLY_REPAYMENT_GUARANTEE_MANAGER")
    // Reason: Module key string must match deployed constant; cannot be shortened without breaking compatibility.
    // solhint-disable-next-line gas-small-strings
    bytes32 internal constant KEY_EARLY_REPAYMENT_GUARANTEE = keccak256("EARLY_REPAYMENT_GUARANTEE_MANAGER");
    
    /// @notice Keeper registry module key.
    /// @dev Used by Registry to store the KeeperRegistry contract address.
    /// @dev Hash: keccak256("KEEPER_REGISTRY")
    bytes32 internal constant KEY_KEEPER_REGISTRY = keccak256("KEEPER_REGISTRY");
    
    /// @notice Whitelist registry module key.
    /// @dev Used by Registry to store the WhitelistRegistry contract address.
    /// @dev Hash: keccak256("WHITELIST_REGISTRY")
    bytes32 internal constant KEY_WHITELIST_REGISTRY = keccak256("WHITELIST_REGISTRY");

    // ============ Access Control Modules ============
    /// @notice Access control manager module key.
    /// @dev Used by Registry to store the AccessControlManager contract address.
    /// @dev Hash: keccak256("ACCESS_CONTROL_MANAGER")
    bytes32 internal constant KEY_ACCESS_CONTROL = keccak256("ACCESS_CONTROL_MANAGER");
    
    /// @notice Access controller module key (enhanced).
    /// @dev Used by Registry to store the AccessController contract address.
    /// @dev Hash: keccak256("ACCESS_CONTROLLER")
    bytes32 internal constant KEY_ACCESS_CONTROLLER = keccak256("ACCESS_CONTROLLER");
    
    /// @notice Asset whitelist module key.
    /// @dev Used by Registry to store the AssetWhitelist contract address.
    /// @dev Hash: keccak256("ASSET_WHITELIST")
    bytes32 internal constant KEY_ASSET_WHITELIST = keccak256("ASSET_WHITELIST");
    
    /// @notice Authority whitelist module key.
    /// @dev Used by Registry to store the AuthorityWhitelist contract address.
    /// @dev Hash: keccak256("AUTHORITY_WHITELIST")
    bytes32 internal constant KEY_AUTHORITY_WHITELIST = keccak256("AUTHORITY_WHITELIST");

    // ============ Liquidation / Settlement Modules ============
    /// @notice Settlement manager (unified settlement/liquidation write entry) module key.
    /// @dev Used by Registry to store the SettlementManager contract address.
    /// @dev Hash: keccak256("SETTLEMENT_MANAGER")
    bytes32 internal constant KEY_SETTLEMENT_MANAGER = keccak256("SETTLEMENT_MANAGER");

    /// @notice Lender pool vault module key (recommended on-chain liquidity pool location).
    /// @dev Used by Registry to store the LenderPoolVault contract address.
    /// @dev Hash: keccak256("LENDER_POOL_VAULT")
    bytes32 internal constant KEY_LENDER_POOL_VAULT = keccak256("LENDER_POOL_VAULT");

    /// @notice Liquidation manager module key.
    /// @dev Used by Registry to store the LiquidationManager contract address.
    /// @dev Hash: keccak256("LIQUIDATION_MANAGER")
    bytes32 internal constant KEY_LIQUIDATION_MANAGER = keccak256("LIQUIDATION_MANAGER");
    
    /// @notice Liquidation risk manager module key.
    /// @dev Used by Registry to store the LiquidationRiskManager contract address.
    /// @dev Hash: keccak256("LIQUIDATION_RISK_MANAGER")
    bytes32 internal constant KEY_LIQUIDATION_RISK_MANAGER = keccak256("LIQUIDATION_RISK_MANAGER");
    
    /// @notice Liquidation calculator module key.
    /// @dev Used by Registry to store the LiquidationCalculator contract address.
    /// @dev Hash: keccak256("LIQUIDATION_CALCULATOR")
    bytes32 internal constant KEY_LIQUIDATION_CALCULATOR = keccak256("LIQUIDATION_CALCULATOR");
    
    /// @notice Liquidation config manager module key.
    /// @dev Used by Registry to store the LiquidationConfigManager contract address.
    /// @dev Hash: keccak256("LIQUIDATION_CONFIG_MANAGER")
    bytes32 internal constant KEY_LIQUIDATION_CONFIG_MANAGER = keccak256("LIQUIDATION_CONFIG_MANAGER");
    
    /// @notice Liquidation orchestrator module key.
    /// @dev Used by Registry to store the LiquidationOrchestrator contract address.
    /// @dev Hash: keccak256("LIQUIDATION_ORCHESTRATOR")
    bytes32 internal constant KEY_LIQUIDATION_ORCHESTRATOR = keccak256("LIQUIDATION_ORCHESTRATOR");
    
    /// @notice Degradation manager module key.
    /// @dev Used by Registry to store the DegradationManager contract address.
    /// @dev Hash: keccak256("DEGRADATION_MANAGER")
    bytes32 internal constant KEY_DEGRADATION_MANAGER = keccak256("DEGRADATION_MANAGER");

    // ============ Registry System Modules ============
    /// @notice Dynamic module registry module key.
    /// @dev Used by Registry to store the RegistryDynamicModuleKey contract address.
    /// @dev Hash: keccak256("DYNAMIC_MODULE_REGISTRY")
    bytes32 internal constant KEY_DYNAMIC_MODULE_REGISTRY = keccak256("DYNAMIC_MODULE_REGISTRY");

    /// @notice Cache maintenance manager module key (governance ops: batch refresh module caches).
    /// @dev Used by Registry to store the CacheMaintenanceManager contract address.
    /// @dev Hash: keccak256("CACHE_MAINTENANCE_MANAGER")
    bytes32 internal constant KEY_CACHE_MAINTENANCE_MANAGER = keccak256("CACHE_MAINTENANCE_MANAGER");

    // ============ Governance Modules ============
    /// @notice Cross-chain governance module key.
    /// @dev Used by Registry to store the CrossChainGovernance contract address.
    /// @dev Hash: keccak256("CROSS_CHAIN_GOVERNANCE")
    bytes32 internal constant KEY_CROSS_CHAIN_GOV = keccak256("CROSS_CHAIN_GOVERNANCE");
    
    /// @notice Governance role module key.
    /// @dev Used by Registry to store the GovernanceRole contract address.
    /// @dev Hash: keccak256("GOVERNANCE_ROLE")
    bytes32 internal constant KEY_GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

    // ============ Registry ============
    /// @notice Registry module key.
    /// @dev Used by Registry to store the Registry contract address.
    /// @dev Hash: keccak256("REGISTRY")
    bytes32 internal constant KEY_REGISTRY = keccak256("REGISTRY");

    // ============ NFT / Token Modules ============
    /// @notice Loan NFT module key.
    /// @dev Used by Registry to store the LoanNFT contract address.
    /// @dev Hash: keccak256("LOAN_NFT")
    bytes32 internal constant KEY_LOAN_NFT = keccak256("LOAN_NFT");
    
    /// @notice Reward points module key.
    /// @dev Used by Registry to store the RewardPoints contract address.
    /// @dev Hash: keccak256("REWARD_POINTS")
    bytes32 internal constant KEY_REWARD_POINTS = keccak256("REWARD_POINTS");
    
    /// @notice RWA token module key.
    /// @dev Used by Registry to store the RWAToken contract address.
    /// @dev Hash: keccak256("RWA_TOKEN")
    bytes32 internal constant KEY_RWA_TOKEN = keccak256("RWA_TOKEN");

    // ============ Utility Modules ============
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

    // ============ Oracle Modules ============
    /// @notice Price oracle module key.
    /// @dev Used by Registry to store the PriceOracle contract address.
    /// @dev Hash: keccak256("PRICE_ORACLE")
    bytes32 internal constant KEY_PRICE_ORACLE = keccak256("PRICE_ORACLE");
    
    /// @notice CoinGecko price updater module key.
    /// @dev Used by Registry to store the CoinGeckoPriceUpdater contract address.
    /// @dev Hash: keccak256("COINGECKO_PRICE_UPDATER")
    bytes32 internal constant KEY_COINGECKO_UPDATER = keccak256("COINGECKO_PRICE_UPDATER");
    
    /// @notice CoinGecko price updater view module key.
    /// @dev Used by Registry to store the CoinGeckoPriceUpdaterView contract address.
    /// @dev Hash: keccak256("COINGECKO_PRICE_UPDATER_VIEW")
    bytes32 internal constant KEY_COINGECKO_PRICE_UPDATER_VIEW = keccak256("COINGECKO_PRICE_UPDATER_VIEW");
    
    /// @notice Settlement token module key.
    /// @dev Used by Registry to store the SettlementToken contract address.
    /// @dev Hash: keccak256("SETTLEMENT_TOKEN")
    bytes32 internal constant KEY_SETTLEMENT_TOKEN = keccak256("SETTLEMENT_TOKEN");

    // ============ Strategy Modules ============
    /// @notice RWA auto leveraged strategy module key.
    /// @dev Used by Registry to store the RWAAutoLeveragedStrategy contract address.
    /// @dev Hash: keccak256("RWA_AUTO_LEVERAGED_STRATEGY")
    bytes32 internal constant KEY_RWA_STRATEGY = keccak256("RWA_AUTO_LEVERAGED_STRATEGY");

    // ============ Business Logic Modules ============
    /// @notice Vault business logic module key.
    /// @dev Used by Registry to store the VaultBusinessLogic contract address.
    /// @dev Hash: keccak256("VAULT_BUSINESS_LOGIC")
    bytes32 internal constant KEY_VAULT_BUSINESS_LOGIC = keccak256("VAULT_BUSINESS_LOGIC");

    // ============ View Modules ============
    /// @notice HealthView module key.
    /// @dev Used by Registry to store the HealthView contract address.
    /// @dev Hash: keccak256("HEALTH_VIEW")
    bytes32 internal constant KEY_HEALTH_VIEW = keccak256("HEALTH_VIEW");
    /// @notice RiskView module key (legacy).
    /// @dev Used by Registry to store the RiskView contract address.
    /// @dev Hash: keccak256("RISK_VIEW")
    bytes32 internal constant KEY_RISK_VIEW = keccak256("RISK_VIEW");
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
    bytes32 internal constant KEY_LIQUIDATION_VIEW = keccak256("LIQUIDATION_VIEW");

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
    bytes32 internal constant KEY_SYSTEM_HEALTH_VIEW = keccak256("SYSTEM_HEALTH_VIEW");
    /// @notice Liquidation payout manager module key.
    /// @dev Used by Registry to store the LiquidationPayoutManager contract address.
    /// @dev Hash: keccak256("LIQUIDATION_PAYOUT_MANAGER")
    bytes32 internal constant KEY_LIQUIDATION_PAYOUT_MANAGER = keccak256("LIQUIDATION_PAYOUT_MANAGER");
    
    /// @notice Event history manager module key.
    /// @dev Used by Registry to store the EventHistoryManager contract address.
    /// @dev Hash: keccak256("EVENT_HISTORY_MANAGER")
    bytes32 internal constant KEY_EVENT_HISTORY_MANAGER = keccak256("EVENT_HISTORY_MANAGER");

    // ============ Reward Configuration Submodules ============
    /// @notice Advanced analytics configuration module key.
    /// @dev Used by Registry to store the AdvancedAnalyticsConfig contract address.
    /// @dev Hash: keccak256("ADVANCED_ANALYTICS_CONFIG")
    bytes32 internal constant KEY_ADVANCED_ANALYTICS_CONFIG = keccak256("ADVANCED_ANALYTICS_CONFIG");
    
    /// @notice Priority service configuration module key.
    /// @dev Used by Registry to store the PriorityServiceConfig contract address.
    /// @dev Hash: keccak256("PRIORITY_SERVICE_CONFIG")
    bytes32 internal constant KEY_PRIORITY_SERVICE_CONFIG = keccak256("PRIORITY_SERVICE_CONFIG");
    
    /// @notice Feature unlock configuration module key.
    /// @dev Used by Registry to store the FeatureUnlockConfig contract address.
    /// @dev Hash: keccak256("FEATURE_UNLOCK_CONFIG")
    bytes32 internal constant KEY_FEATURE_UNLOCK_CONFIG = keccak256("FEATURE_UNLOCK_CONFIG");
    
    /// @notice Governance access configuration module key.
    /// @dev Used by Registry to store the GovernanceAccessConfig contract address.
    /// @dev Hash: keccak256("GOVERNANCE_ACCESS_CONFIG")
    bytes32 internal constant KEY_GOVERNANCE_ACCESS_CONFIG = keccak256("GOVERNANCE_ACCESS_CONFIG");
    
    /// @notice Testnet features configuration module key.
    /// @dev Used by Registry to store the TestnetFeaturesConfig contract address.
    /// @dev Hash: keccak256("TESTNET_FEATURES_CONFIG")
    bytes32 internal constant KEY_TESTNET_FEATURES_CONFIG = keccak256("TESTNET_FEATURES_CONFIG");

    // ============ Versioned Keys ============
    /// @notice Reward manager V1 module key (example).
    /// @dev Used by Registry to store the RewardManager V1 contract address.
    /// @dev Hash: keccak256("REWARD_MANAGER_V1")
    bytes32 internal constant KEY_REWARD_MANAGER_V1 = keccak256("REWARD_MANAGER_V1");

    // ============ Helper Functions ============
    
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
        bytes32[] memory keys = new bytes32[](71);

        // ===== Core Modules =====
        keys[0] = KEY_CM;
        keys[1] = KEY_LE;
        keys[2] = KEY_HF_CALC;
        keys[3] = KEY_STATS;
        keys[4] = KEY_VAULT_CONFIG;
        keys[5] = KEY_VAULT_CORE;
        // Core (added): Order engine
        keys[6] = KEY_ORDER_ENGINE;

        // ===== Supporting Modules =====
        keys[7]  = KEY_FR;
        keys[8]  = KEY_RM;
        keys[9]  = KEY_REWARD_CORE;
        keys[10] = KEY_REWARD_MANAGER_CORE;
        keys[11] = KEY_REWARD_CONFIG;
        keys[12] = KEY_REWARD_CONSUMPTION;
        // Canonical price view facade.
        keys[13] = KEY_VALUATION_ORACLE_VIEW;
        keys[14] = KEY_GUARANTEE_FUND;
        keys[15] = KEY_KEEPER_REGISTRY;
        keys[16] = KEY_WHITELIST_REGISTRY;

        // ===== Access Control Modules =====
        keys[17] = KEY_ACCESS_CONTROL;
        keys[18] = KEY_ACCESS_CONTROLLER;
        keys[19] = KEY_ASSET_WHITELIST;
        keys[20] = KEY_AUTHORITY_WHITELIST;

        // ===== Registry System Modules =====
        keys[21] = KEY_DYNAMIC_MODULE_REGISTRY;

        // ===== Governance Modules =====
        keys[22] = KEY_CROSS_CHAIN_GOV;
        keys[23] = KEY_GOVERNANCE_ROLE;

        // ===== Registry =====
        keys[24] = KEY_REGISTRY;

        // ===== NFT / Token =====
        keys[25] = KEY_LOAN_NFT;
        keys[26] = KEY_REWARD_POINTS;
        keys[27] = KEY_RWA_TOKEN;

        // ===== Utilities =====
        keys[28] = KEY_TOKEN_UTILS;
        keys[29] = KEY_REVERT_DECODER;
        keys[30] = KEY_VAULT_UTILS;

        // ===== Oracles =====
        keys[31] = KEY_PRICE_ORACLE;
        keys[32] = KEY_COINGECKO_UPDATER;
        keys[33] = KEY_COINGECKO_PRICE_UPDATER_VIEW;
        keys[34] = KEY_SETTLEMENT_TOKEN;

        // ===== Strategies =====
        keys[35] = KEY_RWA_STRATEGY;

        // ===== Business Logic =====
        keys[36] = KEY_VAULT_BUSINESS_LOGIC;

        // ===== Views =====
        keys[37] = KEY_HEALTH_VIEW;
        keys[38] = KEY_RISK_VIEW;
        keys[39] = KEY_SYSTEM_VIEW;
        keys[40] = KEY_USER_VIEW;
        keys[41] = KEY_VIEW_CACHE;
        keys[42] = KEY_EVENT_HISTORY_MANAGER;
        keys[43] = KEY_POSITION_VIEW;
        keys[44] = KEY_DASHBOARD_VIEW;
        keys[45] = KEY_PREVIEW_VIEW;
        keys[46] = KEY_LIQUIDATION_VIEW;
        keys[47] = KEY_REWARD_VIEW;

        // ===== Liquidation =====
        keys[48] = KEY_LIQUIDATION_MANAGER;
        keys[49] = KEY_LIQUIDATION_RISK_MANAGER;
        keys[50] = KEY_LIQUIDATION_ORCHESTRATOR;
        keys[51] = KEY_LIQUIDATION_CALCULATOR;
        keys[52] = KEY_LIQUIDATION_CONFIG_MANAGER;

        // ===== Reward Configuration Submodules =====
        keys[53] = KEY_ADVANCED_ANALYTICS_CONFIG;
        keys[54] = KEY_PRIORITY_SERVICE_CONFIG;
        keys[55] = KEY_FEATURE_UNLOCK_CONFIG;
        keys[56] = KEY_GOVERNANCE_ACCESS_CONFIG;
        keys[57] = KEY_TESTNET_FEATURES_CONFIG;

        // ===== Versioned Keys =====
        keys[58] = KEY_REWARD_MANAGER_V1;
        keys[59] = KEY_DEGRADATION_MANAGER;

        // ===== Additional Modules =====
        keys[60] = KEY_VAULT_LENDING_ENGINE;
        keys[61] = KEY_DEGRADATION_STORAGE;
        keys[62] = KEY_MODULE_HEALTH_VIEW;
        keys[63] = KEY_BATCH_VIEW;
        keys[64] = KEY_EARLY_REPAYMENT_GUARANTEE;
        keys[65] = KEY_REGISTRY_VIEW;
        keys[66] = KEY_SYSTEM_HEALTH_VIEW;
        keys[67] = KEY_LIQUIDATION_PAYOUT_MANAGER;
        // SettlementManager (unified settlement / liquidation write entry)
        keys[68] = KEY_SETTLEMENT_MANAGER;
        // LenderPoolVault (on-chain liquidity pool)
        keys[69] = KEY_LENDER_POOL_VAULT;
        // CacheMaintenanceManager (governance ops: batch refresh module caches)
        keys[70] = KEY_CACHE_MAINTENANCE_MANAGER;

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
        string[] memory names = new string[](71);

        // ===== Core Modules =====
        names[0] = "KEY_CM";
        names[1] = "KEY_LE";
        names[2] = "KEY_HF_CALC";
        names[3] = "KEY_STATS";
        names[4] = "KEY_VAULT_CONFIG";
        names[5] = "KEY_VAULT_CORE";
        names[6] = "KEY_ORDER_ENGINE";

        // ===== Supporting Modules =====
        names[7]  = "KEY_FR";
        names[8]  = "KEY_RM";
        names[9]  = "KEY_REWARD_CORE";
        names[10] = "KEY_REWARD_MANAGER_CORE";
        names[11] = "KEY_REWARD_CONFIG";
        names[12] = "KEY_REWARD_CONSUMPTION";
        names[13] = "KEY_VALUATION_ORACLE_VIEW";
        names[14] = "KEY_GUARANTEE_FUND";
        names[15] = "KEY_KEEPER_REGISTRY";
        names[16] = "KEY_WHITELIST_REGISTRY";

        // ===== Access Control Modules =====
        names[17] = "KEY_ACCESS_CONTROL";
        names[18] = "KEY_ACCESS_CONTROLLER";
        names[19] = "KEY_ASSET_WHITELIST";
        names[20] = "KEY_AUTHORITY_WHITELIST";

        // ===== Registry System Modules =====
        names[21] = "KEY_DYNAMIC_MODULE_REGISTRY";

        // ===== Governance Modules =====
        names[22] = "KEY_CROSS_CHAIN_GOV";
        names[23] = "KEY_GOVERNANCE_ROLE";

        // ===== Registry =====
        names[24] = "KEY_REGISTRY";

        // ===== NFT / Token =====
        names[25] = "KEY_LOAN_NFT";
        names[26] = "KEY_REWARD_POINTS";
        names[27] = "KEY_RWA_TOKEN";

        // ===== Utilities =====
        names[28] = "KEY_TOKEN_UTILS";
        names[29] = "KEY_REVERT_DECODER";
        names[30] = "KEY_VAULT_UTILS";

        // ===== Oracles =====
        names[31] = "KEY_PRICE_ORACLE";
        names[32] = "KEY_COINGECKO_UPDATER";
        names[33] = "KEY_COINGECKO_PRICE_UPDATER_VIEW";
        names[34] = "KEY_SETTLEMENT_TOKEN";

        // ===== Strategies =====
        names[35] = "KEY_RWA_STRATEGY";

        // ===== Business Logic =====
        names[36] = "KEY_VAULT_BUSINESS_LOGIC";

        // ===== Views =====
        names[37] = "KEY_HEALTH_VIEW";
        names[38] = "KEY_RISK_VIEW";
        names[39] = "KEY_SYSTEM_VIEW";
        names[40] = "KEY_USER_VIEW";
        names[41] = "KEY_VIEW_CACHE";
        names[42] = "KEY_EVENT_HISTORY_MANAGER";
        names[43] = "KEY_POSITION_VIEW";
        names[44] = "KEY_DASHBOARD_VIEW";
        names[45] = "KEY_PREVIEW_VIEW";
        names[46] = "KEY_LIQUIDATION_VIEW";
        names[47] = "KEY_REWARD_VIEW";

        // ===== Liquidation =====
        names[48] = "KEY_LIQUIDATION_MANAGER";
        names[49] = "KEY_LIQUIDATION_RISK_MANAGER";
        names[50] = "KEY_LIQUIDATION_ORCHESTRATOR";
        names[51] = "KEY_LIQUIDATION_CALCULATOR";
        names[52] = "KEY_LIQUIDATION_CONFIG_MANAGER";

        // ===== Reward Configuration Submodules =====
        names[53] = "KEY_ADVANCED_ANALYTICS_CONFIG";
        names[54] = "KEY_PRIORITY_SERVICE_CONFIG";
        names[55] = "KEY_FEATURE_UNLOCK_CONFIG";
        names[56] = "KEY_GOVERNANCE_ACCESS_CONFIG";
        names[57] = "KEY_TESTNET_FEATURES_CONFIG";

        // ===== Versioned Keys =====
        names[58] = "KEY_REWARD_MANAGER_V1";
        names[59] = "KEY_DEGRADATION_MANAGER";

        // ===== Additional Modules =====
        names[60] = "KEY_VAULT_LENDING_ENGINE";
        names[61] = "KEY_DEGRADATION_STORAGE";
        names[62] = "KEY_MODULE_HEALTH_VIEW";
        names[63] = "KEY_BATCH_VIEW";
        names[64] = "KEY_EARLY_REPAYMENT_GUARANTEE";
        names[65] = "KEY_REGISTRY_VIEW";
        names[66] = "KEY_SYSTEM_HEALTH_VIEW";
        names[67] = "KEY_LIQUIDATION_PAYOUT_MANAGER";
        names[68] = "KEY_SETTLEMENT_MANAGER";
        names[69] = "KEY_LENDER_POOL_VAULT";
        names[70] = "KEY_CACHE_MAINTENANCE_MANAGER";

        return names;
    }
    
    /**
     * @notice Get the total number of module keys in the static list.
     * @dev Reverts if:
     *      - N/A
     *
     * Security:
     * - Pure function; does not access external state.
     *
     * @return count Number of keys in `getAllKeys()`
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
        if (index >= keys.length) revert ModuleKeys__IndexOutOfBounds(index, keys.length);
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
    function getModuleKeyString(bytes32 key) internal pure returns (string memory) {
        if (key == KEY_CM) return "collateralManager";
        if (key == KEY_LE) return "lendingEngine";
        if (key == KEY_ORDER_ENGINE) return "orderEngine";
        // Deprecated: do not return "hfCalculator" mapping anymore.
        // Phase 1: KEY_STATS points to StatisticsView.
        if (key == KEY_STATS) return "statisticsView";
        if (key == KEY_VAULT_CONFIG) return "vaultConfig";
        if (key == KEY_VAULT_CORE) return "vaultCore";
        if (key == KEY_FR) return "feeRouter";
        if (key == KEY_RM) return "rewardManager";
        if (key == KEY_REWARD_CORE) return "rewardCore";
        if (key == KEY_REWARD_MANAGER_CORE) return "rewardManagerCore";
        if (key == KEY_REWARD_CONFIG) return "rewardConfig";
        if (key == KEY_REWARD_CONSUMPTION) return "rewardConsumption";
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
        if (key == KEY_REGISTRY) return "registry";
        if (key == KEY_LOAN_NFT) return "loanNFT";
        if (key == KEY_REWARD_POINTS) return "rewardPoints";
        if (key == KEY_RWA_TOKEN) return "rwaToken";
        if (key == KEY_TOKEN_UTILS) return "tokenUtils";
        if (key == KEY_REVERT_DECODER) return "revertDecoder";
        if (key == KEY_VAULT_UTILS) return "vaultUtils";
        if (key == KEY_PRICE_ORACLE) return "priceOracle";
        if (key == KEY_COINGECKO_UPDATER) return "coinGeckoPriceUpdater";
        if (key == KEY_COINGECKO_PRICE_UPDATER_VIEW) return "coinGeckoPriceUpdaterView";
        if (key == KEY_SETTLEMENT_TOKEN) return "settlementToken";
        if (key == KEY_RWA_STRATEGY) return "rwaAutoLeveragedStrategy";
        if (key == KEY_VAULT_BUSINESS_LOGIC) return "vaultBusinessLogic";
        if (key == KEY_SETTLEMENT_MANAGER) return "settlementManager";
        if (key == KEY_LENDER_POOL_VAULT) return "lenderPoolVault";
        if (key == KEY_LIQUIDATION_MANAGER) return "liquidationManager";
        if (key == KEY_LIQUIDATION_RISK_MANAGER) return "liquidationRiskManager";
        if (key == KEY_LIQUIDATION_ORCHESTRATOR) return "liquidationOrchestrator";
        if (key == KEY_LIQUIDATION_CALCULATOR) return "liquidationCalculator";
        if (key == KEY_LIQUIDATION_CONFIG_MANAGER) return "liquidationConfigManager";
        if (key == KEY_REWARD_VIEW) return "rewardView";
        if (key == KEY_VAULT_LENDING_ENGINE) return "vaultLendingEngine";
        if (key == KEY_DEGRADATION_STORAGE) return "degradationStorage";
        if (key == KEY_MODULE_HEALTH_VIEW) return "moduleHealthView";
        if (key == KEY_BATCH_VIEW) return "batchView";
        if (key == KEY_EARLY_REPAYMENT_GUARANTEE) return "earlyRepaymentGuaranteeManager";
        if (key == KEY_ADVANCED_ANALYTICS_CONFIG) return "advancedAnalyticsConfig";
        if (key == KEY_PRIORITY_SERVICE_CONFIG) return "priorityServiceConfig";
        if (key == KEY_FEATURE_UNLOCK_CONFIG) return "featureUnlockConfig";
        if (key == KEY_GOVERNANCE_ACCESS_CONFIG) return "governanceAccessConfig";
        if (key == KEY_TESTNET_FEATURES_CONFIG) return "testnetFeaturesConfig";
        if (key == KEY_REWARD_MANAGER_V1) return "rewardManagerV1";
        if (key == KEY_DEGRADATION_MANAGER) return "degradationManager";
        if (key == KEY_POSITION_VIEW) return "positionView";
        if (key == KEY_DASHBOARD_VIEW) return "dashboardView";
        if (key == KEY_PREVIEW_VIEW) return "previewView";
        if (key == KEY_LIQUIDATION_VIEW) return "liquidationView";
        if (key == KEY_CACHE_MAINTENANCE_MANAGER) return "cacheMaintenanceManager";
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
    function getModuleKeyConstantString(bytes32 key) internal pure returns (string memory) {
        if (key == bytes32(0)) revert ModuleKeys__InvalidModuleKey();
        
        if (key == KEY_CM) return "KEY_CM";
        if (key == KEY_LE) return "KEY_LE";
        if (key == KEY_ORDER_ENGINE) return "KEY_ORDER_ENGINE";
        // Deprecated: do not return KEY_HF_CALC anymore.
        if (key == KEY_STATS) return "KEY_STATS";
        if (key == KEY_VAULT_CONFIG) return "KEY_VAULT_CONFIG";
        if (key == KEY_VAULT_CORE) return "KEY_VAULT_CORE";
        if (key == KEY_FR) return "KEY_FR";
        if (key == KEY_RM) return "KEY_RM";
        if (key == KEY_REWARD_CORE) return "KEY_REWARD_CORE";
        if (key == KEY_REWARD_MANAGER_CORE) return "KEY_REWARD_MANAGER_CORE";
        if (key == KEY_REWARD_CONFIG) return "KEY_REWARD_CONFIG";
        if (key == KEY_REWARD_CONSUMPTION) return "KEY_REWARD_CONSUMPTION";
        // DEPRECATED: preserved for backward compatibility only.
        if (key == KEY_VALUATION_ORACLE) return "KEY_VALUATION_ORACLE";
        if (key == KEY_VALUATION_ORACLE_VIEW) return "KEY_VALUATION_ORACLE_VIEW";
        if (key == KEY_GUARANTEE_FUND) return "KEY_GUARANTEE_FUND";
        if (key == KEY_KEEPER_REGISTRY) return "KEY_KEEPER_REGISTRY";
        if (key == KEY_WHITELIST_REGISTRY) return "KEY_WHITELIST_REGISTRY";
        if (key == KEY_ACCESS_CONTROL) return "KEY_ACCESS_CONTROL";
        if (key == KEY_ACCESS_CONTROLLER) return "KEY_ACCESS_CONTROLLER";
        if (key == KEY_ASSET_WHITELIST) return "KEY_ASSET_WHITELIST";
        if (key == KEY_AUTHORITY_WHITELIST) return "KEY_AUTHORITY_WHITELIST";
        if (key == KEY_DYNAMIC_MODULE_REGISTRY) return "KEY_DYNAMIC_MODULE_REGISTRY";
        if (key == KEY_CROSS_CHAIN_GOV) return "KEY_CROSS_CHAIN_GOV";
        if (key == KEY_GOVERNANCE_ROLE) return "KEY_GOVERNANCE_ROLE";
        if (key == KEY_REGISTRY) return "KEY_REGISTRY";
        if (key == KEY_LOAN_NFT) return "KEY_LOAN_NFT";
        if (key == KEY_REWARD_POINTS) return "KEY_REWARD_POINTS";
        if (key == KEY_RWA_TOKEN) return "KEY_RWA_TOKEN";
        if (key == KEY_TOKEN_UTILS) return "KEY_TOKEN_UTILS";
        if (key == KEY_REVERT_DECODER) return "KEY_REVERT_DECODER";
        if (key == KEY_VAULT_UTILS) return "KEY_VAULT_UTILS";
        if (key == KEY_PRICE_ORACLE) return "KEY_PRICE_ORACLE";
        if (key == KEY_COINGECKO_UPDATER) return "KEY_COINGECKO_UPDATER";
        if (key == KEY_COINGECKO_PRICE_UPDATER_VIEW) return "KEY_COINGECKO_PRICE_UPDATER_VIEW";
        if (key == KEY_SETTLEMENT_TOKEN) return "KEY_SETTLEMENT_TOKEN";
        if (key == KEY_RWA_STRATEGY) return "KEY_RWA_STRATEGY";
        if (key == KEY_VAULT_BUSINESS_LOGIC) return "KEY_VAULT_BUSINESS_LOGIC";
        if (key == KEY_SETTLEMENT_MANAGER) return "KEY_SETTLEMENT_MANAGER";
        if (key == KEY_LENDER_POOL_VAULT) return "KEY_LENDER_POOL_VAULT";
        if (key == KEY_LIQUIDATION_MANAGER) return "KEY_LIQUIDATION_MANAGER";
        if (key == KEY_LIQUIDATION_RISK_MANAGER) return "KEY_LIQUIDATION_RISK_MANAGER";
        if (key == KEY_LIQUIDATION_ORCHESTRATOR) return "KEY_LIQUIDATION_ORCHESTRATOR";
        if (key == KEY_LIQUIDATION_CALCULATOR) return "KEY_LIQUIDATION_CALCULATOR";
        if (key == KEY_LIQUIDATION_CONFIG_MANAGER) return "KEY_LIQUIDATION_CONFIG_MANAGER";
        if (key == KEY_ADVANCED_ANALYTICS_CONFIG) return "KEY_ADVANCED_ANALYTICS_CONFIG";
        if (key == KEY_PRIORITY_SERVICE_CONFIG) return "KEY_PRIORITY_SERVICE_CONFIG";
        if (key == KEY_FEATURE_UNLOCK_CONFIG) return "KEY_FEATURE_UNLOCK_CONFIG";
        if (key == KEY_GOVERNANCE_ACCESS_CONFIG) return "KEY_GOVERNANCE_ACCESS_CONFIG";
        if (key == KEY_TESTNET_FEATURES_CONFIG) return "KEY_TESTNET_FEATURES_CONFIG";
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
        if (key == KEY_EARLY_REPAYMENT_GUARANTEE) return "KEY_EARLY_REPAYMENT_GUARANTEE";
        if (key == KEY_CACHE_MAINTENANCE_MANAGER) return "KEY_CACHE_MAINTENANCE_MANAGER";
        
        revert ModuleKeys__UnknownModuleKey(key);
    }
    
    /**
     * @notice Convert a legacy lowerCamelCase module name to its module key.
     * @dev Reverts if:
     *      - N/A (returns bytes32(0) for unknown names)
     *
     * Security:
     * - Pure function; does not access external state.
     * - Uses `keccak256(abi.encodePacked(name))` to compare against known names.
     * - Legacy behavior: unknown names return `bytes32(0)`; callers must validate if a non-zero key is required.
     *
     * @param name Legacy module name (lowerCamelCase)
     * @return key Module key, or bytes32(0) if unknown
     */
    function getModuleKeyFromString(string memory name) internal pure returns (bytes32) {
        bytes32 nameHash = keccak256(abi.encodePacked(name));
        if (nameHash == keccak256(abi.encodePacked("collateralManager"))) return KEY_CM;
        if (nameHash == keccak256(abi.encodePacked("lendingEngine"))) return KEY_LE;
        if (nameHash == keccak256(abi.encodePacked("orderEngine"))) return KEY_ORDER_ENGINE;
        // Deprecated: do not support "hfCalculator" name mapping anymore.
        // Preserved: keep "statisticsView" mapping for backward compatibility.
        if (nameHash == keccak256(abi.encodePacked("statisticsView"))) return KEY_STATS;
        if (nameHash == keccak256(abi.encodePacked("vaultConfig"))) return KEY_VAULT_CONFIG;
        if (nameHash == keccak256(abi.encodePacked("vaultCore"))) return KEY_VAULT_CORE;
        if (nameHash == keccak256(abi.encodePacked("feeRouter"))) return KEY_FR;
        if (nameHash == keccak256(abi.encodePacked("rewardManager"))) return KEY_RM;
        if (nameHash == keccak256(abi.encodePacked("rewardCore"))) return KEY_REWARD_CORE;
        if (nameHash == keccak256(abi.encodePacked("rewardManagerCore"))) return KEY_REWARD_MANAGER_CORE;
        if (nameHash == keccak256(abi.encodePacked("rewardConfig"))) return KEY_REWARD_CONFIG;
        if (nameHash == keccak256(abi.encodePacked("rewardConsumption"))) return KEY_REWARD_CONSUMPTION;
        if (nameHash == keccak256(abi.encodePacked("valuationOracle"))) return KEY_VALUATION_ORACLE; // DEPRECATED
        if (nameHash == keccak256(abi.encodePacked("valuationOracleView"))) return KEY_VALUATION_ORACLE_VIEW;
        if (nameHash == keccak256(abi.encodePacked("guaranteeFundManager"))) return KEY_GUARANTEE_FUND;
        if (nameHash == keccak256(abi.encodePacked("keeperRegistry"))) return KEY_KEEPER_REGISTRY;
        if (nameHash == keccak256(abi.encodePacked("whitelistRegistry"))) return KEY_WHITELIST_REGISTRY;
        if (nameHash == keccak256(abi.encodePacked("accessControlManager"))) return KEY_ACCESS_CONTROL;
        if (nameHash == keccak256(abi.encodePacked("accessController"))) return KEY_ACCESS_CONTROLLER;
        if (nameHash == keccak256(abi.encodePacked("assetWhitelist"))) return KEY_ASSET_WHITELIST;
        if (nameHash == keccak256(abi.encodePacked("authorityWhitelist"))) return KEY_AUTHORITY_WHITELIST;
        if (nameHash == keccak256(abi.encodePacked("dynamicModuleRegistry"))) return KEY_DYNAMIC_MODULE_REGISTRY;
        if (nameHash == keccak256(abi.encodePacked("crossChainGovernance"))) return KEY_CROSS_CHAIN_GOV;
        if (nameHash == keccak256(abi.encodePacked("governanceRole"))) return KEY_GOVERNANCE_ROLE;
        if (nameHash == keccak256(abi.encodePacked("registry"))) return KEY_REGISTRY;
        if (nameHash == keccak256(abi.encodePacked("loanNFT"))) return KEY_LOAN_NFT;
        if (nameHash == keccak256(abi.encodePacked("rewardPoints"))) return KEY_REWARD_POINTS;
        if (nameHash == keccak256(abi.encodePacked("rwaToken"))) return KEY_RWA_TOKEN;
        if (nameHash == keccak256(abi.encodePacked("tokenUtils"))) return KEY_TOKEN_UTILS;
        if (nameHash == keccak256(abi.encodePacked("revertDecoder"))) return KEY_REVERT_DECODER;
        if (nameHash == keccak256(abi.encodePacked("vaultUtils"))) return KEY_VAULT_UTILS;
        if (nameHash == keccak256(abi.encodePacked("priceOracle"))) return KEY_PRICE_ORACLE;
        if (nameHash == keccak256(abi.encodePacked("coinGeckoPriceUpdater"))) return KEY_COINGECKO_UPDATER;
        if (nameHash == keccak256(abi.encodePacked("coinGeckoPriceUpdaterView"))) {
            return KEY_COINGECKO_PRICE_UPDATER_VIEW;
        }
        if (nameHash == keccak256(abi.encodePacked("settlementToken"))) return KEY_SETTLEMENT_TOKEN;
        if (nameHash == keccak256(abi.encodePacked("rwaAutoLeveragedStrategy"))) return KEY_RWA_STRATEGY;
        if (nameHash == keccak256(abi.encodePacked("vaultBusinessLogic"))) return KEY_VAULT_BUSINESS_LOGIC;
        if (nameHash == keccak256(abi.encodePacked("settlementManager"))) return KEY_SETTLEMENT_MANAGER;
        if (nameHash == keccak256(abi.encodePacked("lenderPoolVault"))) return KEY_LENDER_POOL_VAULT;
        if (nameHash == keccak256(abi.encodePacked("liquidationManager"))) return KEY_LIQUIDATION_MANAGER;
        if (nameHash == keccak256(abi.encodePacked("liquidationRiskManager"))) return KEY_LIQUIDATION_RISK_MANAGER;
        if (nameHash == keccak256(abi.encodePacked("liquidationOrchestrator"))) return KEY_LIQUIDATION_ORCHESTRATOR;
        if (nameHash == keccak256(abi.encodePacked("liquidationCalculator"))) return KEY_LIQUIDATION_CALCULATOR;
        if (nameHash == keccak256(abi.encodePacked("liquidationConfigManager"))) return KEY_LIQUIDATION_CONFIG_MANAGER;
        if (nameHash == keccak256(abi.encodePacked("advancedAnalyticsConfig"))) return KEY_ADVANCED_ANALYTICS_CONFIG;
        if (nameHash == keccak256(abi.encodePacked("priorityServiceConfig"))) return KEY_PRIORITY_SERVICE_CONFIG;
        if (nameHash == keccak256(abi.encodePacked("featureUnlockConfig"))) return KEY_FEATURE_UNLOCK_CONFIG;
        if (nameHash == keccak256(abi.encodePacked("governanceAccessConfig"))) return KEY_GOVERNANCE_ACCESS_CONFIG;
        if (nameHash == keccak256(abi.encodePacked("testnetFeaturesConfig"))) return KEY_TESTNET_FEATURES_CONFIG;
        if (nameHash == keccak256(abi.encodePacked("rewardManagerV1"))) return KEY_REWARD_MANAGER_V1;
        if (nameHash == keccak256(abi.encodePacked("degradationManager"))) return KEY_DEGRADATION_MANAGER;
        if (nameHash == keccak256(abi.encodePacked("positionView"))) return KEY_POSITION_VIEW;
        if (nameHash == keccak256(abi.encodePacked("dashboardView"))) return KEY_DASHBOARD_VIEW;
        if (nameHash == keccak256(abi.encodePacked("previewView"))) return KEY_PREVIEW_VIEW;
        if (nameHash == keccak256(abi.encodePacked("liquidationView"))) return KEY_LIQUIDATION_VIEW;
        // DEPRECATED alias: prefer "liquidationView"
        if (nameHash == keccak256(abi.encodePacked("liquidatorView"))) return KEY_LIQUIDATION_VIEW;
        if (nameHash == keccak256(abi.encodePacked("rewardView"))) return KEY_REWARD_VIEW;
        if (nameHash == keccak256(abi.encodePacked("vaultLendingEngine"))) return KEY_VAULT_LENDING_ENGINE;
        if (nameHash == keccak256(abi.encodePacked("degradationStorage"))) return KEY_DEGRADATION_STORAGE;
        if (nameHash == keccak256(abi.encodePacked("moduleHealthView"))) return KEY_MODULE_HEALTH_VIEW;
        if (nameHash == keccak256(abi.encodePacked("batchView"))) return KEY_BATCH_VIEW;
        if (nameHash == keccak256(abi.encodePacked("earlyRepaymentGuaranteeManager"))) {
            return KEY_EARLY_REPAYMENT_GUARANTEE;
        }
        if (nameHash == keccak256(abi.encodePacked("cacheMaintenanceManager"))) return KEY_CACHE_MAINTENANCE_MANAGER;
        
        return bytes32(0);
    }
    
    /**
     * @notice Check whether a key exists in the static key list (`getAllKeys()`).
     * @dev Reverts if:
     *      - N/A (returns false for unknown keys)
     *
     * Security:
     * - Pure function; does not access external state.
     *
     * @param key Module key (`bytes32`) to validate
     * @return isValid True if `key` is in `getAllKeys()`
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