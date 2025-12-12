// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ModuleKeys
/// @notice 系统各功能模块的 `bytes32` 哈希常量库
/// @dev 统一管理模块标识符，避免散落硬编码；新增常量需保持向后兼容，勿随意改动已有取值
/// @dev 这些常量用于Registry合约中的模块地址映射，确保系统模块化架构的一致性
/// @dev 所有常量都通过keccak256哈希生成，确保唯一性和不可变性
/// @dev 使用bytes32类型确保与Registry合约的兼容性
/// @custom:security-contact security@example.com
library ModuleKeys {
    // ============ 核心业务模块 Key ============
    /// @notice 抵押物管理模块的标识符
    /// @dev 用于Registry中存储CollateralManager合约地址
    /// @dev 哈希值：keccak256("COLLATERAL_MANAGER")
    bytes32 constant KEY_CM = keccak256("COLLATERAL_MANAGER");
    
    /// @notice 借贷账本引擎模块的标识符（VaultLendingEngine / ILendingEngineBasic）
    /// @dev 用于Registry中存储账本引擎合约地址
    /// @dev 哈希值：keccak256("LENDING_ENGINE")
    bytes32 constant KEY_LE = keccak256("LENDING_ENGINE");

    /// @notice Vault借贷引擎模块的标识符
    /// @dev 用于Registry中存储VaultLendingEngine合约地址
    /// @dev 哈希值：keccak256("VAULT_LENDING_ENGINE")
    bytes32 constant KEY_VAULT_LENDING_ENGINE = keccak256("VAULT_LENDING_ENGINE");

    /// @notice 订单引擎模块的标识符（core/LendingEngine / ILendingEngine）
    /// @dev 用于Registry中存储订单引擎合约地址
    /// @dev 哈希值：keccak256("ORDER_ENGINE")
    bytes32 constant KEY_ORDER_ENGINE = keccak256("ORDER_ENGINE");
    
    // 已废弃：健康因子计算器模块 Key（由 LiquidationRiskManager/HealthView 取代）
    // 保留占位避免老数据/脚本 break，但不再在任何读取路径中使用
    bytes32 constant KEY_HF_CALC = keccak256("HEALTH_FACTOR_CALCULATOR");
    
    /// @notice 金库统计模块的标识符
    /// @dev 用于Registry中存储VaultStatistics合约地址
    /// @dev 哈希值：keccak256("VAULT_STATISTICS")
    bytes32 constant KEY_STATS = keccak256("VAULT_STATISTICS");
    
    /// @notice Degradation core monitoring module identifier
    /// @dev Hash: keccak256("DEGRADATION_CORE")
    bytes32 constant KEY_DEGRADATION_CORE = keccak256("DEGRADATION_CORE");

    /// @notice Degradation monitor (keeper) module identifier
    /// @dev Hash: keccak256("DEGRADATION_MONITOR")
    bytes32 constant KEY_DEGRADATION_MONITOR = keccak256("DEGRADATION_MONITOR");
    
    /// @notice Degradation storage module identifier
    /// @dev Hash: keccak256("DEGRADATION_STORAGE")
    bytes32 constant KEY_DEGRADATION_STORAGE = keccak256("DEGRADATION_STORAGE");
    
    /// @notice Module health view module identifier
    /// @dev Hash: keccak256("MODULE_HEALTH_VIEW")
    bytes32 constant KEY_MODULE_HEALTH_VIEW = keccak256("MODULE_HEALTH_VIEW");
    
    /// @notice Batch view module identifier
    /// @dev Hash: keccak256("BATCH_VIEW")
    bytes32 constant KEY_BATCH_VIEW = keccak256("BATCH_VIEW");
    
    /// @notice 金库配置模块的标识符
    /// @dev 用于Registry中存储VaultConfig合约地址
    /// @dev 哈希值：keccak256("VAULT_CONFIG")
    bytes32 constant KEY_VAULT_CONFIG = keccak256("VAULT_CONFIG");
    
    /// @notice 金库核心模块的标识符
    /// @dev 用于Registry中存储VaultCore合约地址
    /// @dev 哈希值：keccak256("VAULT_CORE")
    bytes32 constant KEY_VAULT_CORE = keccak256("VAULT_CORE");

    // 注意：根据 Architecture-Guide，View 地址应通过 KEY_VAULT_CORE → viewContractAddrVar() 解析
    // 因此不新增 KEY_VAULT_VIEW，避免重复来源与配置错误风险。

    // ============ 业务支持模块 Key ============
    /// @notice 手续费路由模块的标识符
    /// @dev 用于Registry中存储FeeRouter合约地址
    /// @dev 哈希值：keccak256("FEE_ROUTER")
    bytes32 constant KEY_FR = keccak256("FEE_ROUTER");
    
    /// @notice 手续费路由视图模块的标识符
    /// @dev 用于Registry中存储FeeRouterView合约地址
    /// @dev 哈希值：keccak256("FEE_ROUTER_VIEW")
    bytes32 constant KEY_FRV = keccak256("FEE_ROUTER_VIEW");
    
    /// @notice 奖励管理模块的标识符
    /// @dev 用于Registry中存储RewardManager合约地址
    /// @dev 哈希值：keccak256("REWARD_MANAGER")
    bytes32 constant KEY_RM = keccak256("REWARD_MANAGER");
    
    /// @notice 奖励核心模块的标识符
    /// @dev 用于Registry中存储RewardCore合约地址
    /// @dev 哈希值：keccak256("REWARD_CORE")
    bytes32 constant KEY_REWARD_CORE = keccak256("REWARD_CORE");
    
    /// @notice 奖励管理核心模块的标识符
    /// @dev 用于Registry中存储RewardManagerCore合约地址
    /// @dev 哈希值：keccak256("REWARD_MANAGER_CORE")
    bytes32 constant KEY_REWARD_MANAGER_CORE = keccak256("REWARD_MANAGER_CORE");
    
    /// @notice 奖励配置模块的标识符
    /// @dev 用于Registry中存储RewardConfig合约地址
    /// @dev 哈希值：keccak256("REWARD_CONFIG")
    bytes32 constant KEY_REWARD_CONFIG = keccak256("REWARD_CONFIG");
    
    /// @notice 奖励消费模块的标识符
    /// @dev 用于Registry中存储RewardConsumption合约地址
    /// @dev 哈希值：keccak256("REWARD_CONSUMPTION")
    bytes32 constant KEY_REWARD_CONSUMPTION = keccak256("REWARD_CONSUMPTION");
    
    /// @notice 估值预言机适配器模块的标识符（DEPRECATED）
    /// @dev 已由 KEY_PRICE_ORACLE 取代，保留仅为向后兼容；新代码禁止使用
    /// @dev 哈希值：keccak256("VALUATION_ORACLE")
    bytes32 constant KEY_VALUATION_ORACLE = keccak256("VALUATION_ORACLE");
    
    /// @notice 保证金基金管理模块的标识符
    /// @dev 用于Registry中存储GuaranteeFundManager合约地址
    /// @dev 哈希值：keccak256("GUARANTEE_FUND_MANAGER")
    bytes32 constant KEY_GUARANTEE_FUND = keccak256("GUARANTEE_FUND_MANAGER");
    
    /// @notice 提前还款保证金管理模块的标识符
    /// @dev 用于Registry中存储EarlyRepaymentGuaranteeManager合约地址
    /// @dev 哈希值：keccak256("EARLY_REPAYMENT_GUARANTEE_MANAGER")
    bytes32 constant KEY_EARLY_REPAYMENT_GUARANTEE = keccak256("EARLY_REPAYMENT_GUARANTEE_MANAGER");
    
    /// @notice Keeper注册表模块的标识符
    /// @dev 用于Registry中存储KeeperRegistry合约地址
    /// @dev 哈希值：keccak256("KEEPER_REGISTRY")
    bytes32 constant KEY_KEEPER_REGISTRY = keccak256("KEEPER_REGISTRY");
    
    /// @notice 白名单注册表模块的标识符
    /// @dev 用于Registry中存储WhitelistRegistry合约地址
    /// @dev 哈希值：keccak256("WHITELIST_REGISTRY")
    bytes32 constant KEY_WHITELIST_REGISTRY = keccak256("WHITELIST_REGISTRY");

    // ============ 权限控制模块 Key ============
    /// @notice 访问控制管理器模块的标识符
    /// @dev 用于Registry中存储AccessControlManager合约地址
    /// @dev 哈希值：keccak256("ACCESS_CONTROL_MANAGER")
    bytes32 constant KEY_ACCESS_CONTROL = keccak256("ACCESS_CONTROL_MANAGER");
    
    /// @notice 访问控制器模块的标识符（增强版）
    /// @dev 用于Registry中存储AccessController合约地址
    /// @dev 哈希值：keccak256("ACCESS_CONTROLLER")
    bytes32 constant KEY_ACCESS_CONTROLLER = keccak256("ACCESS_CONTROLLER");
    
    /// @notice 资产白名单模块的标识符
    /// @dev 用于Registry中存储AssetWhitelist合约地址
    /// @dev 哈希值：keccak256("ASSET_WHITELIST")
    bytes32 constant KEY_ASSET_WHITELIST = keccak256("ASSET_WHITELIST");
    
    /// @notice 权限白名单模块的标识符
    /// @dev 用于Registry中存储AuthorityWhitelist合约地址
    /// @dev 哈希值：keccak256("AUTHORITY_WHITELIST")
    bytes32 constant KEY_AUTHORITY_WHITELIST = keccak256("AUTHORITY_WHITELIST");

    // ============ 清算模块 Key ============
    /// @notice 清算管理器模块的标识符
    /// @dev 用于Registry中存储LiquidationManager合约地址
    /// @dev 哈希值：keccak256("LIQUIDATION_MANAGER")
    bytes32 constant KEY_LIQUIDATION_MANAGER = keccak256("LIQUIDATION_MANAGER");
    
    /// @notice 清算奖励管理器模块的标识符
    /// @dev 用于Registry中存储LiquidationRewardManager合约地址
    /// @dev 哈希值：keccak256("LIQUIDATION_REWARD_MANAGER")
    bytes32 constant KEY_LIQUIDATION_REWARD_MANAGER = keccak256("LIQUIDATION_REWARD_MANAGER");
    
    /// @notice 清算利润统计管理器模块的标识符
    /// @dev 用于Registry中存储LiquidationProfitStatsManager合约地址
    /// @dev 哈希值：keccak256("LIQUIDATION_PROFIT_STATS_MANAGER")
    bytes32 constant KEY_LIQUIDATION_PROFIT_STATS_MANAGER = keccak256("LIQUIDATION_PROFIT_STATS_MANAGER");
    
    /// @notice 清算风险管理器模块的标识符
    /// @dev 用于Registry中存储LiquidationRiskManager合约地址
    /// @dev 哈希值：keccak256("LIQUIDATION_RISK_MANAGER")
    bytes32 constant KEY_LIQUIDATION_RISK_MANAGER = keccak256("LIQUIDATION_RISK_MANAGER");
    
    /// @notice 清算奖励分发器模块的标识符
    /// @dev 用于Registry中存储LiquidationRewardDistributor合约地址
    /// @dev 哈希值：keccak256("LIQUIDATION_REWARD_DISTRIBUTOR")
    bytes32 constant KEY_LIQUIDATION_REWARD_DISTRIBUTOR = keccak256("LIQUIDATION_REWARD_DISTRIBUTOR");
    
    /// @notice 清算记录管理器模块的标识符
    /// @dev 用于Registry中存储LiquidationRecordManager合约地址
    /// @dev 哈希值：keccak256("LIQUIDATION_RECORD_MANAGER")
    bytes32 constant KEY_LIQUIDATION_RECORD_MANAGER = keccak256("LIQUIDATION_RECORD_MANAGER");
    
    /// @notice 清算债务管理器模块的标识符
    /// @dev 用于Registry中存储LiquidationDebtManager合约地址
    /// @dev 哈希值：keccak256("LIQUIDATION_DEBT_MANAGER")
    bytes32 constant KEY_LIQUIDATION_DEBT_MANAGER = keccak256("LIQUIDATION_DEBT_MANAGER");
    
    /// @notice 清算计算器模块的标识符
    /// @dev 用于Registry中存储LiquidationCalculator合约地址
    /// @dev 哈希值：keccak256("LIQUIDATION_CALCULATOR")
    bytes32 constant KEY_LIQUIDATION_CALCULATOR = keccak256("LIQUIDATION_CALCULATOR");
    
    /// @notice 清算保证金管理器模块的标识符
    /// @dev 用于Registry中存储LiquidationGuaranteeManager合约地址
    /// @dev 哈希值：keccak256("LIQUIDATION_GUARANTEE_MANAGER")
    bytes32 constant KEY_LIQUIDATION_GUARANTEE_MANAGER = keccak256("LIQUIDATION_GUARANTEE_MANAGER");
    
    /// @notice 清算抵押物管理器模块的标识符
    /// @dev 用于Registry中存储LiquidationCollateralManager合约地址
    /// @dev 哈希值：keccak256("LIQUIDATION_COLLATERAL_MANAGER")
    bytes32 constant KEY_LIQUIDATION_COLLATERAL_MANAGER = keccak256("LIQUIDATION_COLLATERAL_MANAGER");
    
    /// @notice 清算债务记录管理器模块的标识符
    /// @dev 用于Registry中存储LiquidationDebtRecordManager合约地址
    /// @dev 哈希值：keccak256("LIQUIDATION_DEBT_RECORD_MANAGER")
    bytes32 constant KEY_LIQUIDATION_DEBT_RECORD_MANAGER = keccak256("LIQUIDATION_DEBT_RECORD_MANAGER");
    
    /// @notice 清算配置管理器模块的标识符
    /// @dev 用于Registry中存储LiquidationConfigManager合约地址
    /// @dev 哈希值：keccak256("LIQUIDATION_CONFIG_MANAGER")
    bytes32 constant KEY_LIQUIDATION_CONFIG_MANAGER = keccak256("LIQUIDATION_CONFIG_MANAGER");
    
    /// @notice 清算编排器模块的标识符
    /// @dev 用于Registry中存储LiquidationOrchestrator合约地址
    /// @dev 哈希值：keccak256("LIQUIDATION_ORCHESTRATOR")
    bytes32 constant KEY_LIQUIDATION_ORCHESTRATOR = keccak256("LIQUIDATION_ORCHESTRATOR");
    
    /// @notice 清算批量查询管理器模块的标识符
    /// @dev 用于Registry中存储LiquidationBatchQueryManager合约地址
    /// @dev 哈希值：keccak256("LIQUIDATION_BATCH_QUERY_MANAGER")
    bytes32 constant KEY_LIQUIDATION_BATCH_QUERY_MANAGER = keccak256("LIQUIDATION_BATCH_QUERY_MANAGER");
    
    /// @notice 降级管理模块的标识符
    /// @dev 用于Registry中存储DegradationManager合约地址
    /// @dev 哈希值：keccak256("DEGRADATION_MANAGER")
    bytes32 constant KEY_DEGRADATION_MANAGER = keccak256("DEGRADATION_MANAGER");

    // ============ Registry 系统模块 Key ============
    /// @notice Registry升级管理器模块的标识符
    /// @dev 用于Registry中存储RegistryUpgradeManager合约地址
    /// @dev 哈希值：keccak256("REGISTRY_UPGRADE_MANAGER")
    bytes32 constant KEY_REGISTRY_UPGRADE_MANAGER = keccak256("REGISTRY_UPGRADE_MANAGER");
    
    /// @notice Registry签名管理器模块的标识符
    /// @dev 用于Registry中存储RegistrySignatureManager合约地址
    /// @dev 哈希值：keccak256("REGISTRY_SIGNATURE_MANAGER")
    bytes32 constant KEY_REGISTRY_SIGNATURE_MANAGER = keccak256("REGISTRY_SIGNATURE_MANAGER");
    
    /// @notice Registry管理模块的标识符
    /// @dev 用于Registry中存储RegistryAdmin合约地址
    /// @dev 哈希值：keccak256("REGISTRY_ADMIN")
    bytes32 constant KEY_REGISTRY_ADMIN = keccak256("REGISTRY_ADMIN");
    
    /// @notice 动态模块注册表模块的标识符
    /// @dev 用于Registry中存储RegistryDynamicModuleKey合约地址
    /// @dev 哈希值：keccak256("DYNAMIC_MODULE_REGISTRY")
    bytes32 constant KEY_DYNAMIC_MODULE_REGISTRY = keccak256("DYNAMIC_MODULE_REGISTRY");

    // ============ 治理模块 Key ============
    /// @notice 跨链治理模块的标识符
    /// @dev 用于Registry中存储CrossChainGovernance合约地址
    /// @dev 哈希值：keccak256("CROSS_CHAIN_GOVERNANCE")
    bytes32 constant KEY_CROSS_CHAIN_GOV = keccak256("CROSS_CHAIN_GOVERNANCE");
    
    /// @notice 治理角色模块的标识符
    /// @dev 用于Registry中存储GovernanceRole合约地址
    /// @dev 哈希值：keccak256("GOVERNANCE_ROLE")
    bytes32 constant KEY_GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

    // ============ 注册表模块 Key ============
    /// @notice 注册表模块的标识符
    /// @dev 用于Registry中存储Registry合约地址
    /// @dev 哈希值：keccak256("REGISTRY")
    bytes32 constant KEY_REGISTRY = keccak256("REGISTRY");

    // ============ NFT/Token模块 Key ============
    /// @notice 贷款NFT模块的标识符
    /// @dev 用于Registry中存储LoanNFT合约地址
    /// @dev 哈希值：keccak256("LOAN_NFT")
    bytes32 constant KEY_LOAN_NFT = keccak256("LOAN_NFT");
    
    /// @notice 奖励积分模块的标识符
    /// @dev 用于Registry中存储RewardPoints合约地址
    /// @dev 哈希值：keccak256("REWARD_POINTS")
    bytes32 constant KEY_REWARD_POINTS = keccak256("REWARD_POINTS");
    
    /// @notice RWA代币模块的标识符
    /// @dev 用于Registry中存储RWAToken合约地址
    /// @dev 哈希值：keccak256("RWA_TOKEN")
    bytes32 constant KEY_RWA_TOKEN = keccak256("RWA_TOKEN");

    // ============ 工具模块 Key ============
    /// @notice 代币工具模块的标识符
    /// @dev 用于Registry中存储TokenUtils合约地址
    /// @dev 哈希值：keccak256("TOKEN_UTILS")
    bytes32 constant KEY_TOKEN_UTILS = keccak256("TOKEN_UTILS");
    
    /// @notice 回滚解码器模块的标识符
    /// @dev 用于Registry中存储RevertDecoder合约地址
    /// @dev 哈希值：keccak256("REVERT_DECODER")
    bytes32 constant KEY_REVERT_DECODER = keccak256("REVERT_DECODER");
    
    /// @notice 金库工具模块的标识符
    /// @dev 用于Registry中存储VaultUtils合约地址
    /// @dev 哈希值：keccak256("VAULT_UTILS")
    bytes32 constant KEY_VAULT_UTILS = keccak256("VAULT_UTILS");

    // ============ 价格预言机模块 Key ============
    /// @notice 价格预言机模块的标识符
    /// @dev 用于Registry中存储PriceOracle合约地址
    /// @dev 哈希值：keccak256("PRICE_ORACLE")
    bytes32 constant KEY_PRICE_ORACLE = keccak256("PRICE_ORACLE");
    
    /// @notice CoinGecko价格更新器模块的标识符
    /// @dev 用于Registry中存储CoinGeckoPriceUpdater合约地址
    /// @dev 哈希值：keccak256("COINGECKO_PRICE_UPDATER")
    bytes32 constant KEY_COINGECKO_UPDATER = keccak256("COINGECKO_PRICE_UPDATER");
    
    /// @notice CoinGecko价格更新器视图模块的标识符
    /// @dev 用于Registry中存储CoinGeckoPriceUpdaterView合约地址
    /// @dev 哈希值：keccak256("COINGECKO_PRICE_UPDATER_VIEW")
    bytes32 constant KEY_COINGECKO_PRICE_UPDATER_VIEW = keccak256("COINGECKO_PRICE_UPDATER_VIEW");
    
    /// @notice 结算币模块的标识符
    /// @dev 用于Registry中存储SettlementToken合约地址
    /// @dev 哈希值：keccak256("SETTLEMENT_TOKEN")
    bytes32 constant KEY_SETTLEMENT_TOKEN = keccak256("SETTLEMENT_TOKEN");

    // ============ 策略模块 Key ============
    /// @notice RWA自动杠杆策略模块的标识符
    /// @dev 用于Registry中存储RWAAutoLeveragedStrategy合约地址
    /// @dev 哈希值：keccak256("RWA_AUTO_LEVERAGED_STRATEGY")
    bytes32 constant KEY_RWA_STRATEGY = keccak256("RWA_AUTO_LEVERAGED_STRATEGY");

    // ============ 业务逻辑模块 Key ============
    /// @notice 金库业务逻辑模块的标识符
    /// @dev 用于Registry中存储VaultBusinessLogic合约地址
    /// @dev 哈希值：keccak256("VAULT_BUSINESS_LOGIC")
    bytes32 constant KEY_VAULT_BUSINESS_LOGIC = keccak256("VAULT_BUSINESS_LOGIC");

    // ============ View模块 Key ============
    /// @notice HealthView 模块 Key
    /// @dev 用于Registry 中存储 HealthView 合约地址
    /// @dev 哈希值：keccak256("HEALTH_VIEW")
    bytes32 constant KEY_HEALTH_VIEW = keccak256("HEALTH_VIEW");
    /// @notice RiskView 模块 Key (legacy)
    /// @dev 用于Registry 中存储 RiskView 合约地址
    /// @dev 哈希值：keccak256("RISK_VIEW")
    bytes32 constant KEY_RISK_VIEW = keccak256("RISK_VIEW");
    /// @notice SystemView 模块 Key
    /// @dev 用于Registry 中存储 SystemView 合约地址
    /// @dev 哈希值：keccak256("SYSTEM_VIEW")
    bytes32 constant KEY_SYSTEM_VIEW = keccak256("SYSTEM_VIEW");
    /// @notice UserViewFacade 模块 Key
    /// @dev 用于 Registry 中存储 UserViewFacade 合约地址
    /// @dev 哈希值：keccak256("USER_VIEW")
    bytes32 constant KEY_USER_VIEW = keccak256("USER_VIEW");

    // 新增：Position / Dashboard / Preview 视图模块
    /// @notice PositionView 模块 Key
    /// @dev 用于 Registry 中存储 PositionView 合约地址
    /// @dev 哈希值：keccak256("POSITION_VIEW")
    bytes32 constant KEY_POSITION_VIEW = keccak256("POSITION_VIEW");

    /// @notice DashboardView 模块 Key
    /// @dev 用于 Registry 中存储 DashboardView 合约地址
    /// @dev 哈希值：keccak256("DASHBOARD_VIEW")
    bytes32 constant KEY_DASHBOARD_VIEW = keccak256("DASHBOARD_VIEW");

    /// @notice PreviewView 模块 Key
    /// @dev 用于 Registry 中存储 PreviewView 合约地址
    /// @dev 哈希值：keccak256("PREVIEW_VIEW")
    bytes32 constant KEY_PREVIEW_VIEW = keccak256("PREVIEW_VIEW");
    /// @notice LiquidationEventsView 模块 Key（新增）
    /// @dev 用于 Registry 中存储 LiquidationEventsView 合约地址
    /// @dev 哈希值：keccak256("LIQUIDATION_VIEW")
    bytes32 constant KEY_LIQUIDATION_VIEW = keccak256("LIQUIDATION_VIEW");

    /// @notice RewardView 模块 Key（新增）
    /// @dev 用于 Registry 中存储 RewardView 合约地址
    /// @dev 哈希值：keccak256("REWARD_VIEW")
    bytes32 constant KEY_REWARD_VIEW = keccak256("REWARD_VIEW");

    /// @notice 视图缓存模块的标识符
    /// @dev 用于Registry中存储ViewCache合约地址
    /// @dev 哈希值：keccak256("VIEW_CACHE")
    bytes32 constant KEY_VIEW_CACHE = keccak256("VIEW_CACHE");
    /// @notice RegistryView 模块 Key（新增）
    /// @dev 只读注册表视图，承接枚举/反查/分页等查询
    /// @dev 哈希值：keccak256("REGISTRY_VIEW")
    bytes32 constant KEY_REGISTRY_VIEW = keccak256("REGISTRY_VIEW");
    /// @notice SystemHealthView 模块 Key（新增）
    /// @dev 系统健康/降级只读视图
    /// @dev 哈希值：keccak256("SYSTEM_HEALTH_VIEW")
    bytes32 constant KEY_SYSTEM_HEALTH_VIEW = keccak256("SYSTEM_HEALTH_VIEW");
    
    /// @notice 事件历史管理器模块的标识符
    /// @dev 用于Registry中存储EventHistoryManager合约地址
    /// @dev 哈希值：keccak256("EVENT_HISTORY_MANAGER")
    bytes32 constant KEY_EVENT_HISTORY_MANAGER = keccak256("EVENT_HISTORY_MANAGER");

    // ============ 奖励配置子模块 Key ============

    // ============ 奖励配置子模块 Key ============
    /// @notice 高级数据分析配置模块的标识符
    /// @dev 用于Registry中存储AdvancedAnalyticsConfig合约地址
    /// @dev 哈希值：keccak256("ADVANCED_ANALYTICS_CONFIG")
    bytes32 constant KEY_ADVANCED_ANALYTICS_CONFIG = keccak256("ADVANCED_ANALYTICS_CONFIG");
    
    /// @notice 优先服务配置模块的标识符
    /// @dev 用于Registry中存储PriorityServiceConfig合约地址
    /// @dev 哈希值：keccak256("PRIORITY_SERVICE_CONFIG")
    bytes32 constant KEY_PRIORITY_SERVICE_CONFIG = keccak256("PRIORITY_SERVICE_CONFIG");
    
    /// @notice 功能解锁配置模块的标识符
    /// @dev 用于Registry中存储FeatureUnlockConfig合约地址
    /// @dev 哈希值：keccak256("FEATURE_UNLOCK_CONFIG")
    bytes32 constant KEY_FEATURE_UNLOCK_CONFIG = keccak256("FEATURE_UNLOCK_CONFIG");
    
    /// @notice 治理访问配置模块的标识符
    /// @dev 用于Registry中存储GovernanceAccessConfig合约地址
    /// @dev 哈希值：keccak256("GOVERNANCE_ACCESS_CONFIG")
    bytes32 constant KEY_GOVERNANCE_ACCESS_CONFIG = keccak256("GOVERNANCE_ACCESS_CONFIG");
    
    /// @notice 测试网功能配置模块的标识符
    /// @dev 用于Registry中存储TestnetFeaturesConfig合约地址
    /// @dev 哈希值：keccak256("TESTNET_FEATURES_CONFIG")
    bytes32 constant KEY_TESTNET_FEATURES_CONFIG = keccak256("TESTNET_FEATURES_CONFIG");

    // ============ 版本控制 Key ============
    /// @notice 奖励管理模块V1版本的标识符（示例）
    /// @dev 用于Registry中存储RewardManager V1版本合约地址
    /// @dev 哈希值：keccak256("REWARD_MANAGER_V1")
    bytes32 constant KEY_REWARD_MANAGER_V1 = keccak256("REWARD_MANAGER_V1");

    // ============ 辅助函数 ============
    
    /// @notice 获取所有静态模块 Key 数组（无重复，顺序与常量声明分组一致）
    function getAllKeys() internal pure returns (bytes32[] memory) {
        bytes32[] memory keys = new bytes32[](72);

        // ===== 核心业务模块 =====
        keys[0] = KEY_CM;
        keys[1] = KEY_LE;
        keys[2] = KEY_HF_CALC;
        keys[3] = KEY_STATS;
        keys[4] = KEY_VAULT_CONFIG;
        keys[5] = KEY_VAULT_CORE;
        // 新增核心：订单引擎
        keys[6] = KEY_ORDER_ENGINE;

        // ===== 业务支持模块 =====
        keys[7]  = KEY_FR;
        keys[8]  = KEY_RM;
        keys[9]  = KEY_REWARD_CORE;
        keys[10] = KEY_REWARD_MANAGER_CORE;
        keys[11] = KEY_REWARD_CONFIG;
        keys[12] = KEY_REWARD_CONSUMPTION;
        keys[13] = KEY_VALUATION_ORACLE; // DEPRECATED: 仅保留占位
        keys[14] = KEY_GUARANTEE_FUND;
        keys[15] = KEY_KEEPER_REGISTRY;
        keys[16] = KEY_WHITELIST_REGISTRY;

        // ===== 权限控制模块 =====
        keys[17] = KEY_ACCESS_CONTROL;
        keys[18] = KEY_ACCESS_CONTROLLER;
        keys[19] = KEY_ASSET_WHITELIST;
        keys[20] = KEY_AUTHORITY_WHITELIST;

        // ===== Registry 系统模块 =====
        keys[21] = KEY_REGISTRY_ADMIN;
        keys[22] = KEY_DYNAMIC_MODULE_REGISTRY;

        // ===== 治理模块 =====
        keys[23] = KEY_CROSS_CHAIN_GOV;
        keys[24] = KEY_GOVERNANCE_ROLE;

        // ===== 注册表自身 =====
        keys[25] = KEY_REGISTRY;

        // ===== NFT / Token =====
        keys[26] = KEY_LOAN_NFT;
        keys[27] = KEY_REWARD_POINTS;
        keys[28] = KEY_RWA_TOKEN;

        // ===== 工具 =====
        keys[29] = KEY_TOKEN_UTILS;
        keys[30] = KEY_REVERT_DECODER;
        keys[31] = KEY_VAULT_UTILS;

        // ===== 价格预言机 =====
        keys[32] = KEY_PRICE_ORACLE;
        keys[33] = KEY_COINGECKO_UPDATER;
        keys[34] = KEY_COINGECKO_PRICE_UPDATER_VIEW;
        keys[35] = KEY_SETTLEMENT_TOKEN;

        // ===== 策略 =====
        keys[36] = KEY_RWA_STRATEGY;

        // ===== 业务逻辑 =====
        keys[37] = KEY_VAULT_BUSINESS_LOGIC;

        // ===== View 模块 =====
        keys[38] = KEY_HEALTH_VIEW;
        keys[39] = KEY_RISK_VIEW;
        keys[40] = KEY_SYSTEM_VIEW;
        keys[41] = KEY_USER_VIEW;
        keys[42] = KEY_VIEW_CACHE;
        keys[43] = KEY_EVENT_HISTORY_MANAGER;
        keys[44] = KEY_POSITION_VIEW;
        keys[45] = KEY_DASHBOARD_VIEW;
        keys[46] = KEY_PREVIEW_VIEW;
        keys[47] = KEY_LIQUIDATION_VIEW;
        keys[48] = KEY_REWARD_VIEW;

        // ===== 清算模块 =====
        keys[49] = KEY_LIQUIDATION_MANAGER;
        keys[50] = KEY_LIQUIDATION_RISK_MANAGER;
        keys[51] = KEY_LIQUIDATION_COLLATERAL_MANAGER;
        keys[52] = KEY_LIQUIDATION_DEBT_MANAGER;
        keys[53] = KEY_LIQUIDATION_ORCHESTRATOR;
        keys[54] = KEY_LIQUIDATION_CALCULATOR;
        keys[55] = KEY_LIQUIDATION_REWARD_DISTRIBUTOR;
        keys[56] = KEY_LIQUIDATION_RECORD_MANAGER;
        keys[57] = KEY_LIQUIDATION_CONFIG_MANAGER;

        // ===== 奖励配置子模块 =====
        keys[58] = KEY_ADVANCED_ANALYTICS_CONFIG;
        keys[59] = KEY_PRIORITY_SERVICE_CONFIG;
        keys[60] = KEY_FEATURE_UNLOCK_CONFIG;
        keys[61] = KEY_GOVERNANCE_ACCESS_CONFIG;
        keys[62] = KEY_TESTNET_FEATURES_CONFIG;

        // ===== 版本控制 =====
        keys[63] = KEY_REWARD_MANAGER_V1;
        keys[64] = KEY_DEGRADATION_MANAGER;

        // ===== 新增模块 =====
        keys[65] = KEY_VAULT_LENDING_ENGINE;
        keys[66] = KEY_DEGRADATION_STORAGE;
        keys[67] = KEY_MODULE_HEALTH_VIEW;
        keys[68] = KEY_BATCH_VIEW;
        keys[69] = KEY_EARLY_REPAYMENT_GUARANTEE;
        keys[70] = KEY_REGISTRY_VIEW;
        keys[71] = KEY_SYSTEM_HEALTH_VIEW;

        return keys;
    }
    
    /// @notice 获取所有模块 Key 的字符串名称（保持与 getAllKeys 顺序一致）
    function getAllKeyStrings() internal pure returns (string[] memory) {
        string[] memory names = new string[](72);

        // ===== 核心业务模块 =====
        names[0] = "KEY_CM";
        names[1] = "KEY_LE";
        names[2] = "KEY_HF_CALC";
        names[3] = "KEY_STATS";
        names[4] = "KEY_VAULT_CONFIG";
        names[5] = "KEY_VAULT_CORE";
        names[6] = "KEY_ORDER_ENGINE";

        // ===== 业务支持模块 =====
        names[7]  = "KEY_FR";
        names[8]  = "KEY_RM";
        names[9]  = "KEY_REWARD_CORE";
        names[10] = "KEY_REWARD_MANAGER_CORE";
        names[11] = "KEY_REWARD_CONFIG";
        names[12] = "KEY_REWARD_CONSUMPTION";
        names[13] = "KEY_VALUATION_ORACLE"; // DEPRECATED
        names[14] = "KEY_GUARANTEE_FUND";
        names[15] = "KEY_KEEPER_REGISTRY";
        names[16] = "KEY_WHITELIST_REGISTRY";

        // ===== 权限控制模块 =====
        names[17] = "KEY_ACCESS_CONTROL";
        names[18] = "KEY_ACCESS_CONTROLLER";
        names[19] = "KEY_ASSET_WHITELIST";
        names[20] = "KEY_AUTHORITY_WHITELIST";

        // ===== Registry 系统模块 =====
        names[21] = "KEY_REGISTRY_ADMIN";
        names[22] = "KEY_DYNAMIC_MODULE_REGISTRY";

        // ===== 治理模块 =====
        names[23] = "KEY_CROSS_CHAIN_GOV";
        names[24] = "KEY_GOVERNANCE_ROLE";

        // ===== 注册表自身 =====
        names[25] = "KEY_REGISTRY";

        // ===== NFT / Token =====
        names[26] = "KEY_LOAN_NFT";
        names[27] = "KEY_REWARD_POINTS";
        names[28] = "KEY_RWA_TOKEN";

        // ===== 工具 =====
        names[29] = "KEY_TOKEN_UTILS";
        names[30] = "KEY_REVERT_DECODER";
        names[31] = "KEY_VAULT_UTILS";

        // ===== 价格预言机 =====
        names[32] = "KEY_PRICE_ORACLE";
        names[33] = "KEY_COINGECKO_UPDATER";
        names[34] = "KEY_COINGECKO_PRICE_UPDATER_VIEW";
        names[35] = "KEY_SETTLEMENT_TOKEN";

        // ===== 策略 =====
        names[36] = "KEY_RWA_STRATEGY";

        // ===== 业务逻辑 =====
        names[37] = "KEY_VAULT_BUSINESS_LOGIC";

        // ===== View 模块 =====
        names[38] = "KEY_HEALTH_VIEW";
        names[39] = "KEY_RISK_VIEW";
        names[40] = "KEY_SYSTEM_VIEW";
        names[41] = "KEY_USER_VIEW";
        names[42] = "KEY_VIEW_CACHE";
        names[43] = "KEY_EVENT_HISTORY_MANAGER";
        names[44] = "KEY_POSITION_VIEW";
        names[45] = "KEY_DASHBOARD_VIEW";
        names[46] = "KEY_PREVIEW_VIEW";
        names[47] = "KEY_LIQUIDATION_VIEW";
        names[48] = "KEY_REWARD_VIEW";

        // ===== 清算模块 =====
        names[49] = "KEY_LIQUIDATION_MANAGER";
        names[50] = "KEY_LIQUIDATION_RISK_MANAGER";
        names[51] = "KEY_LIQUIDATION_COLLATERAL_MANAGER";
        names[52] = "KEY_LIQUIDATION_DEBT_MANAGER";
        names[53] = "KEY_LIQUIDATION_ORCHESTRATOR";
        names[54] = "KEY_LIQUIDATION_CALCULATOR";
        names[55] = "KEY_LIQUIDATION_REWARD_DISTRIBUTOR";
        names[56] = "KEY_LIQUIDATION_RECORD_MANAGER";
        names[57] = "KEY_LIQUIDATION_CONFIG_MANAGER";

        // ===== 奖励配置子模块 =====
        names[58] = "KEY_ADVANCED_ANALYTICS_CONFIG";
        names[59] = "KEY_PRIORITY_SERVICE_CONFIG";
        names[60] = "KEY_FEATURE_UNLOCK_CONFIG";
        names[61] = "KEY_GOVERNANCE_ACCESS_CONFIG";
        names[62] = "KEY_TESTNET_FEATURES_CONFIG";

        // ===== 版本控制 =====
        names[63] = "KEY_REWARD_MANAGER_V1";
        names[64] = "KEY_DEGRADATION_MANAGER";

        // ===== 新增模块 =====
        names[65] = "KEY_VAULT_LENDING_ENGINE";
        names[66] = "KEY_DEGRADATION_STORAGE";
        names[67] = "KEY_MODULE_HEALTH_VIEW";
        names[68] = "KEY_BATCH_VIEW";
        names[69] = "KEY_EARLY_REPAYMENT_GUARANTEE";
        names[70] = "KEY_REGISTRY_VIEW";
        names[71] = "KEY_SYSTEM_HEALTH_VIEW";

        return names;
    }
    
    /// @notice 获取模块Key总数
    /// @return 模块Key总数
    /// @dev 动态计算，避免硬编码，确保与getAllKeys()同步
    function getKeyCount() internal pure returns (uint256) {
        return getAllKeys().length;
    }
    
    /// @notice 根据索引获取模块Key
    /// @param index 索引位置
    /// @return 对应的模块Key
    /// @dev 如果索引超出范围，会revert
    function getKeyByIndex(uint256 index) internal pure returns (bytes32) {
        bytes32[] memory keys = getAllKeys();
        require(index < keys.length, "Index out of bounds");
        return keys[index];
    }
    
    /// @notice 将模块Key转换为对应的字符串名称（小写，用于向后兼容）
    /// @param key 模块Key
    /// @return 对应的字符串名称（小写格式）
    /// @dev 用于向后兼容，支持getNamedModule函数
    /// @dev 返回格式：collateralManager, lendingEngine 等
    function getModuleKeyString(bytes32 key) internal pure returns (string memory) {
        if (key == KEY_CM) return "collateralManager";
        if (key == KEY_LE) return "lendingEngine";
        if (key == KEY_ORDER_ENGINE) return "orderEngine";
        // 已废弃：不再返回 hfCalculator 名称
        if (key == KEY_STATS) return "statisticsView"; // 阶段一：KEY_STATS 指向 StatisticsView
        if (key == KEY_VAULT_CONFIG) return "vaultConfig";
        if (key == KEY_VAULT_CORE) return "vaultCore";
        if (key == KEY_FR) return "feeRouter";
        if (key == KEY_RM) return "rewardManager";
        if (key == KEY_REWARD_CORE) return "rewardCore";
        if (key == KEY_REWARD_MANAGER_CORE) return "rewardManagerCore";
        if (key == KEY_REWARD_CONFIG) return "rewardConfig";
        if (key == KEY_REWARD_CONSUMPTION) return "rewardConsumption";
        if (key == KEY_VALUATION_ORACLE) return "valuationOracle"; // DEPRECATED: 使用 priceOracle
        if (key == KEY_GUARANTEE_FUND) return "guaranteeFundManager";
        if (key == KEY_KEEPER_REGISTRY) return "keeperRegistry";
        if (key == KEY_WHITELIST_REGISTRY) return "whitelistRegistry";
        if (key == KEY_ACCESS_CONTROL) return "accessControlManager";
        if (key == KEY_ACCESS_CONTROLLER) return "accessController";
        if (key == KEY_ASSET_WHITELIST) return "assetWhitelist";
        if (key == KEY_AUTHORITY_WHITELIST) return "authorityWhitelist";
        if (key == KEY_REGISTRY_ADMIN) return "registryAdmin";
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
        if (key == KEY_LIQUIDATION_MANAGER) return "liquidationManager";
        if (key == KEY_LIQUIDATION_RISK_MANAGER) return "liquidationRiskManager";
        if (key == KEY_LIQUIDATION_COLLATERAL_MANAGER) return "liquidationCollateralManager";
        if (key == KEY_LIQUIDATION_DEBT_MANAGER) return "liquidationDebtManager";
        if (key == KEY_LIQUIDATION_ORCHESTRATOR) return "liquidationOrchestrator";
        if (key == KEY_LIQUIDATION_CALCULATOR) return "liquidationCalculator";
        if (key == KEY_LIQUIDATION_REWARD_DISTRIBUTOR) return "liquidationRewardDistributor";
        if (key == KEY_LIQUIDATION_RECORD_MANAGER) return "liquidationRecordManager";
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
        return "";
    }
    
    /// @notice 将模块Key转换为对应的常量字符串名称
    /// @param key 模块Key
    /// @return 对应的常量字符串名称（大写格式）
    /// @dev 用于前端友好显示，便于事件解码和日志可读性
    /// @dev 返回格式：KEY_CM, KEY_LE, KEY_REGISTRY 等
    /// @dev 对于未知模块键，会revert而不是返回空字符串，确保安全性
    function getModuleKeyConstantString(bytes32 key) internal pure returns (string memory) {
        // 验证输入不为零
        if (key == bytes32(0)) revert("Invalid module key: zero value");
        
        if (key == KEY_CM) return "KEY_CM";
        if (key == KEY_LE) return "KEY_LE";
        if (key == KEY_ORDER_ENGINE) return "KEY_ORDER_ENGINE";
        // 已废弃：不再返回 KEY_HF_CALC
        if (key == KEY_STATS) return "KEY_STATS";
        if (key == KEY_VAULT_CONFIG) return "KEY_VAULT_CONFIG";
        if (key == KEY_VAULT_CORE) return "KEY_VAULT_CORE";
        if (key == KEY_FR) return "KEY_FR";
        if (key == KEY_RM) return "KEY_RM";
        if (key == KEY_REWARD_CORE) return "KEY_REWARD_CORE";
        if (key == KEY_REWARD_MANAGER_CORE) return "KEY_REWARD_MANAGER_CORE";
        if (key == KEY_REWARD_CONFIG) return "KEY_REWARD_CONFIG";
        if (key == KEY_REWARD_CONSUMPTION) return "KEY_REWARD_CONSUMPTION";
        if (key == KEY_VALUATION_ORACLE) return "KEY_VALUATION_ORACLE"; // DEPRECATED
        if (key == KEY_GUARANTEE_FUND) return "KEY_GUARANTEE_FUND";
        if (key == KEY_KEEPER_REGISTRY) return "KEY_KEEPER_REGISTRY";
        if (key == KEY_WHITELIST_REGISTRY) return "KEY_WHITELIST_REGISTRY";
        if (key == KEY_ACCESS_CONTROL) return "KEY_ACCESS_CONTROL";
        if (key == KEY_ACCESS_CONTROLLER) return "KEY_ACCESS_CONTROLLER";
        if (key == KEY_ASSET_WHITELIST) return "KEY_ASSET_WHITELIST";
        if (key == KEY_AUTHORITY_WHITELIST) return "KEY_AUTHORITY_WHITELIST";
        if (key == KEY_REGISTRY_ADMIN) return "KEY_REGISTRY_ADMIN";
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
        if (key == KEY_LIQUIDATION_MANAGER) return "KEY_LIQUIDATION_MANAGER";
        if (key == KEY_LIQUIDATION_RISK_MANAGER) return "KEY_LIQUIDATION_RISK_MANAGER";
        if (key == KEY_LIQUIDATION_COLLATERAL_MANAGER) return "KEY_LIQUIDATION_COLLATERAL_MANAGER";
        if (key == KEY_LIQUIDATION_DEBT_MANAGER) return "KEY_LIQUIDATION_DEBT_MANAGER";
        if (key == KEY_LIQUIDATION_ORCHESTRATOR) return "KEY_LIQUIDATION_ORCHESTRATOR";
        if (key == KEY_LIQUIDATION_CALCULATOR) return "KEY_LIQUIDATION_CALCULATOR";
        if (key == KEY_LIQUIDATION_REWARD_DISTRIBUTOR) return "KEY_LIQUIDATION_REWARD_DISTRIBUTOR";
        if (key == KEY_LIQUIDATION_RECORD_MANAGER) return "KEY_LIQUIDATION_RECORD_MANAGER";
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
        
        // 对于未知模块键，revert而不是返回空字符串，确保安全性
        revert("Unknown module key");
    }
    
    /// @notice 将字符串名称转换为对应的模块Key
    /// @param name 模块名称字符串
    /// @return 对应的模块Key
    /// @dev 用于从字符串名称获取模块Key
    function getModuleKeyFromString(string memory name) internal pure returns (bytes32) {
        bytes32 nameHash = keccak256(abi.encodePacked(name));
        if (nameHash == keccak256(abi.encodePacked("collateralManager"))) return KEY_CM;
        if (nameHash == keccak256(abi.encodePacked("lendingEngine"))) return KEY_LE;
        if (nameHash == keccak256(abi.encodePacked("orderEngine"))) return KEY_ORDER_ENGINE;
        // 已废弃：不再支持 "hfCalculator" 名称映射
        if (nameHash == keccak256(abi.encodePacked("statisticsView"))) return KEY_STATS; // 兼容名称映射
        if (nameHash == keccak256(abi.encodePacked("vaultConfig"))) return KEY_VAULT_CONFIG;
        if (nameHash == keccak256(abi.encodePacked("vaultCore"))) return KEY_VAULT_CORE;
        if (nameHash == keccak256(abi.encodePacked("feeRouter"))) return KEY_FR;
        if (nameHash == keccak256(abi.encodePacked("rewardManager"))) return KEY_RM;
        if (nameHash == keccak256(abi.encodePacked("rewardCore"))) return KEY_REWARD_CORE;
        if (nameHash == keccak256(abi.encodePacked("rewardManagerCore"))) return KEY_REWARD_MANAGER_CORE;
        if (nameHash == keccak256(abi.encodePacked("rewardConfig"))) return KEY_REWARD_CONFIG;
        if (nameHash == keccak256(abi.encodePacked("rewardConsumption"))) return KEY_REWARD_CONSUMPTION;
        if (nameHash == keccak256(abi.encodePacked("valuationOracle"))) return KEY_VALUATION_ORACLE; // DEPRECATED
        if (nameHash == keccak256(abi.encodePacked("guaranteeFundManager"))) return KEY_GUARANTEE_FUND;
        if (nameHash == keccak256(abi.encodePacked("keeperRegistry"))) return KEY_KEEPER_REGISTRY;
        if (nameHash == keccak256(abi.encodePacked("whitelistRegistry"))) return KEY_WHITELIST_REGISTRY;
        if (nameHash == keccak256(abi.encodePacked("accessControlManager"))) return KEY_ACCESS_CONTROL;
        if (nameHash == keccak256(abi.encodePacked("accessController"))) return KEY_ACCESS_CONTROLLER;
        if (nameHash == keccak256(abi.encodePacked("assetWhitelist"))) return KEY_ASSET_WHITELIST;
        if (nameHash == keccak256(abi.encodePacked("authorityWhitelist"))) return KEY_AUTHORITY_WHITELIST;
        if (nameHash == keccak256(abi.encodePacked("registryAdmin"))) return KEY_REGISTRY_ADMIN;
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
        if (nameHash == keccak256(abi.encodePacked("coinGeckoPriceUpdaterView"))) return KEY_COINGECKO_PRICE_UPDATER_VIEW;
        if (nameHash == keccak256(abi.encodePacked("settlementToken"))) return KEY_SETTLEMENT_TOKEN;
        if (nameHash == keccak256(abi.encodePacked("rwaAutoLeveragedStrategy"))) return KEY_RWA_STRATEGY;
        if (nameHash == keccak256(abi.encodePacked("vaultBusinessLogic"))) return KEY_VAULT_BUSINESS_LOGIC;
        if (nameHash == keccak256(abi.encodePacked("liquidationManager"))) return KEY_LIQUIDATION_MANAGER;
        if (nameHash == keccak256(abi.encodePacked("liquidationRiskManager"))) return KEY_LIQUIDATION_RISK_MANAGER;
        if (nameHash == keccak256(abi.encodePacked("liquidationCollateralManager"))) return KEY_LIQUIDATION_COLLATERAL_MANAGER;
        if (nameHash == keccak256(abi.encodePacked("liquidationDebtManager"))) return KEY_LIQUIDATION_DEBT_MANAGER;
        if (nameHash == keccak256(abi.encodePacked("liquidationOrchestrator"))) return KEY_LIQUIDATION_ORCHESTRATOR;
        if (nameHash == keccak256(abi.encodePacked("liquidationCalculator"))) return KEY_LIQUIDATION_CALCULATOR;
        if (nameHash == keccak256(abi.encodePacked("liquidationRewardDistributor"))) return KEY_LIQUIDATION_REWARD_DISTRIBUTOR;
        if (nameHash == keccak256(abi.encodePacked("liquidationRecordManager"))) return KEY_LIQUIDATION_RECORD_MANAGER;
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
        if (nameHash == keccak256(abi.encodePacked("rewardView"))) return KEY_REWARD_VIEW;
        if (nameHash == keccak256(abi.encodePacked("vaultLendingEngine"))) return KEY_VAULT_LENDING_ENGINE;
        if (nameHash == keccak256(abi.encodePacked("degradationStorage"))) return KEY_DEGRADATION_STORAGE;
        if (nameHash == keccak256(abi.encodePacked("moduleHealthView"))) return KEY_MODULE_HEALTH_VIEW;
        if (nameHash == keccak256(abi.encodePacked("batchView"))) return KEY_BATCH_VIEW;
        if (nameHash == keccak256(abi.encodePacked("earlyRepaymentGuaranteeManager"))) return KEY_EARLY_REPAYMENT_GUARANTEE;
        
        return bytes32(0);
    }
    
    /// @notice 检查是否为有效的模块Key
    /// @param key 待检查的模块Key
    /// @return 是否为有效模块Key
    /// @dev 使用动态验证，避免硬编码，确保与getAllKeys()同步
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