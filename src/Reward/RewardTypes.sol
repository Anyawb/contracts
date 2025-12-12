// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { VaultTypes } from "../Vault/VaultTypes.sol";

/// @title RewardTypes - 积分系统共享数据类型
/// @notice 定义积分消费系统的枚举和结构体
/// @dev 遵循 docs/SmartContractStandard.md 注释规范
/// @dev 与 ActionKeys、ModuleKeys、VaultTypes 集成，确保架构一致性
/// @dev 这些类型定义与标准化动作和模块标识保持一致
contract RewardTypes {
    
    /// @notice 服务类型枚举
    /// @dev 对应 ModuleKeys 中的配置模块：
    ///      - AdvancedAnalytics -> KEY_ADVANCED_ANALYTICS_CONFIG
    ///      - PriorityService -> KEY_PRIORITY_SERVICE_CONFIG  
    ///      - FeatureUnlock -> KEY_FEATURE_UNLOCK_CONFIG
    ///      - GovernanceAccess -> KEY_GOVERNANCE_ACCESS_CONFIG
    ///      - TestnetFeatures -> KEY_TESTNET_FEATURES_CONFIG
    enum ServiceType {
        AdvancedAnalytics,    // 高级数据分析
        PriorityService,      // 优先服务
        FeatureUnlock,        // 功能解锁
        GovernanceAccess,     // 治理参与
        TestnetFeatures       // 测试网功能
    }
    
    /// @notice 服务等级枚举
    /// @dev 对应 ActionKeys 中的动作：
    ///      - 消费积分 -> ACTION_CONSUME_POINTS
    ///      - 升级服务 -> ACTION_UPGRADE_SERVICE
    enum ServiceLevel {
        Basic,      // 基础
        Standard,   // 标准
        Premium,    // 高级
        VIP         // VIP
    }
    
    /// @notice 消费记录结构
    /// @dev 用于记录用户积分消费历史，与 VaultTypes.ActionExecuted 事件配合使用
    /// @dev 对应 ActionKeys.ACTION_CONSUME_POINTS 和 ActionKeys.ACTION_UPGRADE_SERVICE
    struct ConsumptionRecord {
        uint256 points;           // 消费积分数量
        uint256 timestamp;        // 消费时间戳
        ServiceType serviceType;  // 服务类型
        ServiceLevel serviceLevel; // 服务等级
        bool isActive;            // 是否激活
        uint256 expirationTime;   // 过期时间
    }
    
    /// @notice 服务配置结构
    /// @dev 由各配置模块（ModuleKeys 中定义）提供，通过 Registry 获取
    /// @dev 与 VaultTypes 中的参数更新事件配合使用
    struct ServiceConfig {
        uint256 price;           // 服务价格（积分）
        uint256 duration;        // 服务时长（秒）
        bool isActive;           // 是否激活
        ServiceLevel level;      // 服务等级
        string description;      // 服务描述
    }
    
    /// @notice 用户特权状态
    /// @dev 记录用户在各服务类型中的特权状态
    /// @dev 与 VaultTypes.ActionExecuted 事件配合，记录权限变更
    struct UserPrivilege {
        bool hasAdvancedAnalytics;    // 是否有高级数据分析权限
        bool hasPriorityService;      // 是否有优先服务权限
        bool hasFeatureUnlock;        // 是否有功能解锁权限
        bool hasGovernanceAccess;     // 是否有治理参与权限
        bool hasTestnetFeatures;      // 是否有测试网功能权限
        uint256 analyticsLevel;       // 数据分析等级
        uint256 priorityLevel;        // 优先服务等级
        uint256 featureLevel;         // 功能解锁等级
        uint256 governanceLevel;      // 治理参与等级
        uint256 testnetLevel;         // 测试网功能等级
    }
} 