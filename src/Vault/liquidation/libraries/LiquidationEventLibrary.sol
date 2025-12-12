// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title 清算事件库
 * @title Liquidation Event Library
 * @author RWA Lending Platform
 * @notice 提供清算相关的事件定义和触发函数，使用模板化设计减少重复代码
 * @notice Provides liquidation-related event definitions and trigger functions, using templated design to reduce code duplication
 * @dev 使用事件模板和通用触发函数，确保一致性和可追踪性
 * @dev Uses event templates and generic trigger functions to ensure consistency and traceability
 */
library LiquidationEventLibrary {
    /* ============ Event Templates ============ */
    
    /**
     * @notice 基础事件模板 - 包含时间戳的通用事件结构
     * @notice Base event template - Generic event structure with timestamp
     */
    struct BaseEvent {
        uint256 timestamp;
    }
    
    /**
     * @notice 用户相关事件模板 - 包含用户地址和时间戳
     * @notice User-related event template - Contains user address and timestamp
     */
    struct UserEvent {
        address user;
        uint256 timestamp;
    }
    
    /**
     * @notice 清算事件模板 - 包含清算相关参数
     * @notice Liquidation event template - Contains liquidation-related parameters
     */
    struct LiquidationEvent {
        address targetUser;
        address targetAsset;
        address liquidatorAddr;
        uint256 timestamp;
    }
    
    /**
     * @notice 批量事件模板 - 包含批量操作参数
     * @notice Batch event template - Contains batch operation parameters
     */
    struct BatchEvent {
        address operator;
        uint256 batchSize;
        uint256 timestamp;
    }
    
    /**
     * @notice 配置事件模板 - 包含配置更新参数
     * @notice Configuration event template - Contains configuration update parameters
     */
    struct ConfigEvent {
        bytes32 configKey;
        uint256 oldValue;
        uint256 newValue;
        address updater;
        uint256 timestamp;
    }

    /* ============ Liquidation Events ============ */
    
    event LiquidationStarted(
        address indexed targetUser,
        address indexed targetAsset,
        address indexed liquidatorAddr,
        uint256 debtAmount,
        uint256 collateralAmount,
        uint256 timestamp
    );
    
    event LiquidationCompleted(
        address indexed targetUser,
        address indexed targetAsset,
        address indexed liquidatorAddr,
        uint256 debtReduction,
        uint256 collateralReduction,
        uint256 reward,
        uint256 timestamp
    );
    
    event LiquidationFailed(
        address indexed targetUser,
        address indexed targetAsset,
        address indexed liquidatorAddr,
        string failureReason,
        uint256 timestamp
    );

    event LiquidationCollateralRecordUpdated(
        address indexed targetUser,
        address indexed targetAsset,
        uint256 oldAmount,
        uint256 newAmount,
        uint256 timestamp
    );

    /* ============ Batch Liquidation Events ============ */
    
    event BatchLiquidationStarted(
        address indexed liquidatorAddr,
        uint256 batchSize,
        uint256 timestamp
    );
    
    event BatchLiquidationCompleted(
        address indexed liquidatorAddr,
        uint256 batchSize,
        uint256 successCount,
        uint256 totalReward,
        uint256 timestamp
    );

    /* ============ Reward Events ============ */
    
    event RewardDistributed(
        address indexed recipient,
        string rewardType,
        uint256 amount,
        uint256 timestamp
    );
    
    event PointsRewarded(
        address indexed recipient,
        uint256 points,
        string rewardReason,
        uint256 timestamp
    );

    /* ============ Query Events ============ */
    
    event BatchQueryCompleted(
        bytes32 indexed queryId,
        uint256 resultCount,
        uint256 timestamp
    );

    event BatchQueryFailed(
        bytes32 indexed queryId,
        string failureReason,
        uint256 timestamp
    );

    event ExternalModuleCallFailed(
        address indexed moduleAddress,
        string functionName,
        string failureReason,
        uint256 timestamp
    );

    /* ============ Risk Management Events ============ */
    
    event RiskScoreUpdated(
        address indexed targetUser,
        uint256 oldScore,
        uint256 newScore,
        string updateReason,
        uint256 timestamp
    );
    
    event HealthFactorUpdated(
        address indexed targetUser,
        uint256 oldFactor,
        uint256 newFactor,
        uint256 timestamp
    );

    /* ============ Configuration Events ============ */
    
    event ConfigurationUpdated(
        bytes32 indexed configKey,
        uint256 oldValue,
        uint256 newValue,
        address indexed updater,
        uint256 timestamp
    );
    
    event BatchConfigurationUpdated(
        bytes32[] configKeys,
        uint256[] oldValues,
        uint256[] newValues,
        address indexed updater,
        uint256 timestamp
    );

    /* ============ Statistics Events ============ */
    
    event StatisticsUpdated(
        string statType,
        uint256 oldValue,
        uint256 newValue,
        uint256 timestamp
    );
    
    event ProfitStatisticsUpdated(
        uint256 period,
        uint256 totalProfit,
        uint256 liquidatorCount,
        uint256 timestamp
    );

    /* ============ Guarantee Events ============ */
    
    event GuaranteeAdded(
        address indexed targetUser,
        uint256 amount,
        uint256 totalGuarantee,
        uint256 timestamp
    );
    
    event GuaranteeReduced(
        address indexed targetUser,
        uint256 amount,
        uint256 totalGuarantee,
        string reductionReason,
        uint256 timestamp
    );

    /* ============ Query Management Events ============ */
    
    event QueryFailure(
        bytes4 indexed functionSig,
        address indexed targetUser,
        string failureReason,
        uint256 timestamp
    );

    event BatchStrategyFailure(
        uint256 indexed index,
        address indexed userAddress,
        string failureReason,
        uint256 timestamp
    );

    event QueryExecuted(
        address indexed user,
        bytes32 indexed queryType,
        uint256 timestamp
    );

    event LiquidationStrategyOptimized(
        address indexed user,
        uint256 targetHF,
        uint256 timestamp
    );

    event CacheExpired(
        bytes32 indexed queryId,
        uint256 expiredAt,
        uint256 timestamp
    );

    event CacheCleared(
        bytes32 indexed queryId,
        address indexed clearedBy,
        uint256 timestamp
    );

    /* ============ Module Cache Events ============ */
    
    event ModuleCacheUpdated(
        bytes32 indexed moduleKey,
        address indexed oldAddress,
        address indexed newAddress,
        address updater,
        uint256 version,
        uint256 timestamp
    );
    
    event ModuleCacheRemoved(
        bytes32 indexed moduleKey,
        address indexed moduleAddress,
        address indexed updater,
        uint256 version,
        uint256 timestamp
    );
    
    event ModuleCacheExpired(
        bytes32 indexed moduleKey,
        address indexed moduleAddress,
        uint256 cacheAge,
        uint256 maxAge,
        uint256 timestamp
    );
    
    event ModuleCacheCleared(
        address indexed clearedBy,
        uint256 clearedCount,
        uint256 timestamp
    );
    
    event ModuleCacheInitialized(
        address indexed controller,
        bool allowTimeRollback,
        uint256 timestamp
    );

    /* ============ Generic Event Trigger Functions ============ */
    
    /**
     * @notice 获取当前时间戳 - 通用时间戳获取函数
     * @notice Get current timestamp - Generic timestamp function
     * @return 当前时间戳 Current timestamp
     */
    function getTimestamp() internal view returns (uint256) {
        return block.timestamp;
    }
    
    /**
     * @notice 验证地址不为零 - 通用地址验证函数
     * @notice Validate address is not zero - Generic address validation function
     * @param addr 要验证的地址 Address to validate
     * @return 是否为有效地址 Whether it's a valid address
     */
    function isValidAddress(address addr) internal pure returns (bool) {
        return addr != address(0);
    }

    /* ============ Liquidation Event Triggers ============ */
    
    /**
     * @notice 触发清算开始事件
     * @notice Trigger liquidation started event
     * @param targetUser 用户地址 User address
     * @param targetAsset 资产地址 Asset address
     * @param liquidatorAddr 清算人地址 Liquidator address
     * @param debtAmount 债务数量 Debt amount
     * @param collateralAmount 抵押物数量 Collateral amount
     */
    function emitLiquidationStarted(
        address targetUser,
        address targetAsset,
        address liquidatorAddr,
        uint256 debtAmount,
        uint256 collateralAmount
    ) internal {
        require(isValidAddress(targetUser), "Invalid user address");
        require(isValidAddress(targetAsset), "Invalid asset address");
        require(isValidAddress(liquidatorAddr), "Invalid liquidator address");
        
        emit LiquidationStarted(
            targetUser,
            targetAsset,
            liquidatorAddr,
            debtAmount,
            collateralAmount,
            getTimestamp()
        );
    }

    /**
     * @notice 触发清算完成事件
     * @notice Trigger liquidation completed event
     * @param targetUser 用户地址 User address
     * @param targetAsset 资产地址 Asset address
     * @param liquidatorAddr 清算人地址 Liquidator address
     * @param debtReduction 债务减少量 Debt reduction
     * @param collateralReduction 抵押物减少量 Collateral reduction
     * @param reward 奖励 Reward
     */
    function emitLiquidationCompleted(
        address targetUser,
        address targetAsset,
        address liquidatorAddr,
        uint256 debtReduction,
        uint256 collateralReduction,
        uint256 reward
    ) internal {
        require(isValidAddress(targetUser), "Invalid user address");
        require(isValidAddress(targetAsset), "Invalid asset address");
        require(isValidAddress(liquidatorAddr), "Invalid liquidator address");
        
        emit LiquidationCompleted(
            targetUser,
            targetAsset,
            liquidatorAddr,
            debtReduction,
            collateralReduction,
            reward,
            getTimestamp()
        );
    }

    /**
     * @notice 触发清算失败事件
     * @notice Trigger liquidation failed event
     * @param targetUser 用户地址 User address
     * @param targetAsset 资产地址 Asset address
     * @param liquidatorAddr 清算人地址 Liquidator address
     * @param failureReason 失败原因 Failure reason
     */
    function emitLiquidationFailed(
        address targetUser,
        address targetAsset,
        address liquidatorAddr,
        string memory failureReason
    ) internal {
        require(isValidAddress(targetUser), "Invalid user address");
        require(isValidAddress(targetAsset), "Invalid asset address");
        require(isValidAddress(liquidatorAddr), "Invalid liquidator address");
        require(bytes(failureReason).length > 0, "Empty failure reason");
        
        emit LiquidationFailed(
            targetUser,
            targetAsset,
            liquidatorAddr,
            failureReason,
            getTimestamp()
        );
    }

    /* ============ Batch Liquidation Event Triggers ============ */
    
    /**
     * @notice 触发批量清算开始事件
     * @notice Trigger batch liquidation started event
     * @param liquidatorAddr 清算人地址 Liquidator address
     * @param batchSize 批量大小 Batch size
     */
    function emitBatchLiquidationStarted(
        address liquidatorAddr,
        uint256 batchSize
    ) internal {
        require(isValidAddress(liquidatorAddr), "Invalid liquidator address");
        require(batchSize > 0, "Invalid batch size");
        
        emit BatchLiquidationStarted(
            liquidatorAddr,
            batchSize,
            getTimestamp()
        );
    }

    /**
     * @notice 触发批量清算完成事件
     * @notice Trigger batch liquidation completed event
     * @param liquidatorAddr 清算人地址 Liquidator address
     * @param batchSize 批量大小 Batch size
     * @param successCount 成功数量 Success count
     * @param totalReward 总奖励 Total reward
     */
    function emitBatchLiquidationCompleted(
        address liquidatorAddr,
        uint256 batchSize,
        uint256 successCount,
        uint256 totalReward
    ) internal {
        require(isValidAddress(liquidatorAddr), "Invalid liquidator address");
        require(batchSize > 0, "Invalid batch size");
        require(successCount <= batchSize, "Invalid success count");
        
        emit BatchLiquidationCompleted(
            liquidatorAddr,
            batchSize,
            successCount,
            totalReward,
            getTimestamp()
        );
    }

    /* ============ Reward Event Triggers ============ */
    
    /**
     * @notice 触发奖励分配事件
     * @notice Trigger reward distributed event
     * @param recipient 接收者地址 Recipient address
     * @param rewardType 奖励类型 Reward type
     * @param amount 数量 Amount
     */
    function emitRewardDistributed(
        address recipient,
        string memory rewardType,
        uint256 amount
    ) internal {
        require(isValidAddress(recipient), "Invalid recipient address");
        require(bytes(rewardType).length > 0, "Empty reward type");
        
        emit RewardDistributed(
            recipient,
            rewardType,
            amount,
            getTimestamp()
        );
    }

    /**
     * @notice 触发积分奖励事件
     * @notice Trigger points rewarded event
     * @param recipient 接收者地址 Recipient address
     * @param points 积分 Points
     * @param rewardReason 奖励原因 Reward reason
     */
    function emitPointsRewarded(
        address recipient,
        uint256 points,
        string memory rewardReason
    ) internal {
        require(isValidAddress(recipient), "Invalid recipient address");
        require(bytes(rewardReason).length > 0, "Empty reward reason");
        
        emit PointsRewarded(
            recipient,
            points,
            rewardReason,
            getTimestamp()
        );
    }

    /* ============ Risk Management Event Triggers ============ */
    
    /**
     * @notice 触发风险评分更新事件
     * @notice Trigger risk score updated event
     * @param targetUser 用户地址 User address
     * @param oldScore 旧评分 Old score
     * @param newScore 新评分 New score
     * @param updateReason 更新原因 Update reason
     */
    function emitRiskScoreUpdated(
        address targetUser,
        uint256 oldScore,
        uint256 newScore,
        string memory updateReason
    ) internal {
        require(isValidAddress(targetUser), "Invalid user address");
        require(bytes(updateReason).length > 0, "Empty update reason");
        
        emit RiskScoreUpdated(
            targetUser,
            oldScore,
            newScore,
            updateReason,
            getTimestamp()
        );
    }

    /**
     * @notice 触发健康因子更新事件
     * @notice Trigger health factor updated event
     * @param targetUser 用户地址 User address
     * @param oldFactor 旧因子 Old factor
     * @param newFactor 新因子 New factor
     */
    function emitHealthFactorUpdated(
        address targetUser,
        uint256 oldFactor,
        uint256 newFactor
    ) internal {
        require(isValidAddress(targetUser), "Invalid user address");
        
        emit HealthFactorUpdated(
            targetUser,
            oldFactor,
            newFactor,
            getTimestamp()
        );
    }

    /* ============ Configuration Event Triggers ============ */
    
    /**
     * @notice 触发配置更新事件
     * @notice Trigger configuration updated event
     * @param configKey 配置键 Configuration key
     * @param oldValue 旧值 Old value
     * @param newValue 新值 New value
     * @param updater 更新者地址 Updater address
     */
    function emitConfigurationUpdated(
        bytes32 configKey,
        uint256 oldValue,
        uint256 newValue,
        address updater
    ) internal {
        require(isValidAddress(updater), "Invalid updater address");
        
        emit ConfigurationUpdated(
            configKey,
            oldValue,
            newValue,
            updater,
            getTimestamp()
        );
    }

    /**
     * @notice 触发批量配置更新事件
     * @notice Trigger batch configuration updated event
     * @param configKeys 配置键数组 Array of configuration keys
     * @param oldValues 旧值数组 Array of old values
     * @param newValues 新值数组 Array of new values
     * @param updater 更新者地址 Updater address
     */
    function emitBatchConfigurationUpdated(
        bytes32[] memory configKeys,
        uint256[] memory oldValues,
        uint256[] memory newValues,
        address updater
    ) internal {
        require(isValidAddress(updater), "Invalid updater address");
        require(configKeys.length > 0, "Empty config keys");
        require(configKeys.length == oldValues.length, "Length mismatch");
        require(configKeys.length == newValues.length, "Length mismatch");
        
        emit BatchConfigurationUpdated(
            configKeys,
            oldValues,
            newValues,
            updater,
            getTimestamp()
        );
    }

    /* ============ Statistics Event Triggers ============ */
    
    /**
     * @notice 触发统计更新事件
     * @notice Trigger statistics updated event
     * @param statType 统计类型 Statistics type
     * @param oldValue 旧值 Old value
     * @param newValue 新值 New value
     */
    function emitStatisticsUpdated(
        string memory statType,
        uint256 oldValue,
        uint256 newValue
    ) internal {
        require(bytes(statType).length > 0, "Empty stat type");
        
        emit StatisticsUpdated(
            statType,
            oldValue,
            newValue,
            getTimestamp()
        );
    }

    /**
     * @notice 触发利润统计更新事件
     * @notice Trigger profit statistics updated event
     * @param period 期间 Period
     * @param totalProfit 总利润 Total profit
     * @param liquidatorCount 清算人数量 Liquidator count
     */
    function emitProfitStatisticsUpdated(
        uint256 period,
        uint256 totalProfit,
        uint256 liquidatorCount
    ) internal {
        emit ProfitStatisticsUpdated(
            period,
            totalProfit,
            liquidatorCount,
            getTimestamp()
        );
    }

    /* ============ Guarantee Event Triggers ============ */
    
    /**
     * @notice 触发保证金添加事件
     * @notice Trigger guarantee added event
     * @param targetUser 用户地址 User address
     * @param amount 数量 Amount
     * @param totalGuarantee 总保证金 Total guarantee
     */
    function emitGuaranteeAdded(
        address targetUser,
        uint256 amount,
        uint256 totalGuarantee
    ) internal {
        require(isValidAddress(targetUser), "Invalid user address");
        require(amount > 0, "Invalid amount");
        
        emit GuaranteeAdded(
            targetUser,
            amount,
            totalGuarantee,
            getTimestamp()
        );
    }

    /**
     * @notice 触发保证金减少事件
     * @notice Trigger guarantee reduced event
     * @param targetUser 用户地址 User address
     * @param amount 数量 Amount
     * @param totalGuarantee 总保证金 Total guarantee
     * @param reductionReason 减少原因 Reduction reason
     */
    function emitGuaranteeReduced(
        address targetUser,
        uint256 amount,
        uint256 totalGuarantee,
        string memory reductionReason
    ) internal {
        require(isValidAddress(targetUser), "Invalid user address");
        require(amount > 0, "Invalid amount");
        require(bytes(reductionReason).length > 0, "Empty reduction reason");
        
        emit GuaranteeReduced(
            targetUser,
            amount,
            totalGuarantee,
            reductionReason,
            getTimestamp()
        );
    }

    /* ============ Query Event Triggers ============ */
    
    /**
     * @notice 触发批量查询完成事件
     * @notice Trigger batch query completed event
     * @param queryId 查询ID Query ID
     * @param resultCount 结果数量 Result count
     */
    function emitBatchQueryCompleted(
        bytes32 queryId,
        uint256 resultCount
    ) internal {
        emit BatchQueryCompleted(
            queryId,
            resultCount,
            getTimestamp()
        );
    }

    /**
     * @notice 触发批量查询失败事件
     * @notice Trigger batch query failed event
     * @param queryId 查询ID Query ID
     * @param failureReason 失败原因 Failure reason
     */
    function emitBatchQueryFailed(
        bytes32 queryId,
        string memory failureReason
    ) internal {
        require(bytes(failureReason).length > 0, "Empty failure reason");
        
        emit BatchQueryFailed(
            queryId,
            failureReason,
            getTimestamp()
        );
    }

    /**
     * @notice 触发外部模块调用失败事件
     * @notice Trigger external module call failed event
     * @param moduleAddress 模块地址 Module address
     * @param functionName 函数名称 Function name
     * @param failureReason 失败原因 Failure reason
     */
    function emitExternalModuleCallFailed(
        address moduleAddress,
        string memory functionName,
        string memory failureReason
    ) internal {
        require(isValidAddress(moduleAddress), "Invalid module address");
        require(bytes(functionName).length > 0, "Empty function name");
        require(bytes(failureReason).length > 0, "Empty failure reason");
        
        emit ExternalModuleCallFailed(
            moduleAddress,
            functionName,
            failureReason,
            getTimestamp()
        );
    }

    /* ============ Module Cache Event Triggers ============ */
    
    /**
     * @notice 触发模块缓存更新事件
     * @notice Trigger module cache updated event
     * @param moduleKey 模块键值 Module key
     * @param oldAddress 旧地址 Old address
     * @param newAddress 新地址 New address
     * @param updater 更新者地址 Updater address
     * @param version 版本号 Version number
     */
    function emitModuleCacheUpdated(
        bytes32 moduleKey,
        address oldAddress,
        address newAddress,
        address updater,
        uint256 version
    ) internal {
        require(isValidAddress(updater), "Invalid updater address");
        
        emit ModuleCacheUpdated(
            moduleKey,
            oldAddress,
            newAddress,
            updater,
            version,
            getTimestamp()
        );
    }

    /**
     * @notice 触发模块缓存移除事件
     * @notice Trigger module cache removed event
     * @param moduleKey 模块键值 Module key
     * @param moduleAddress 模块地址 Module address
     * @param updater 更新者地址 Updater address
     * @param version 版本号 Version number
     */
    function emitModuleCacheRemoved(
        bytes32 moduleKey,
        address moduleAddress,
        address updater,
        uint256 version
    ) internal {
        require(isValidAddress(updater), "Invalid updater address");
        
        emit ModuleCacheRemoved(
            moduleKey,
            moduleAddress,
            updater,
            version,
            getTimestamp()
        );
    }

    /**
     * @notice 触发模块缓存过期事件
     * @notice Trigger module cache expired event
     * @param moduleKey 模块键值 Module key
     * @param moduleAddress 模块地址 Module address
     * @param cacheAge 缓存年龄 Cache age
     * @param maxAge 最大有效期 Maximum validity period
     */
    function emitModuleCacheExpired(
        bytes32 moduleKey,
        address moduleAddress,
        uint256 cacheAge,
        uint256 maxAge
    ) internal {
        require(isValidAddress(moduleAddress), "Invalid module address");
        
        emit ModuleCacheExpired(
            moduleKey,
            moduleAddress,
            cacheAge,
            maxAge,
            getTimestamp()
        );
    }

    /**
     * @notice 触发模块缓存清理事件
     * @notice Trigger module cache cleared event
     * @param clearedBy 清理者地址 Address of who cleared the cache
     * @param clearedCount 清理数量 Cleared count
     */
    function emitModuleCacheCleared(
        address clearedBy,
        uint256 clearedCount
    ) internal {
        require(isValidAddress(clearedBy), "Invalid cleared by address");
        
        emit ModuleCacheCleared(
            clearedBy,
            clearedCount,
            getTimestamp()
        );
    }

    /**
     * @notice 触发模块缓存初始化事件
     * @notice Trigger module cache initialized event
     * @param controller 控制器地址 Controller address
     * @param allowTimeRollback 是否允许时间回退 Whether to allow time rollback
     */
    function emitModuleCacheInitialized(
        address controller,
        bool allowTimeRollback
    ) internal {
        require(isValidAddress(controller), "Invalid controller address");
        
        emit ModuleCacheInitialized(
            controller,
            allowTimeRollback,
            getTimestamp()
        );
    }

    /**
     * @notice 触发清算抵押物记录更新事件
     * @notice Emit liquidation collateral record updated event
     * @param targetUser 目标用户地址 Target user address
     * @param targetAsset 目标资产地址 Target asset address
     * @param oldAmount 旧数量 Old amount
     * @param newAmount 新数量 New amount
     * @param timestamp 时间戳 Timestamp
     */
    function emitLiquidationCollateralRecordUpdated(
        address targetUser,
        address targetAsset,
        uint256 oldAmount,
        uint256 newAmount,
        uint256 timestamp
    ) internal {
        emit LiquidationCollateralRecordUpdated(
            targetUser,
            targetAsset,
            oldAmount,
            newAmount,
            timestamp
        );
    }
} 