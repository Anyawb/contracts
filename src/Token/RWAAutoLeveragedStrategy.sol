// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import {IVaultCore} from "../interfaces/IVaultCore.sol";
import {IVaultStorage} from "../interfaces/IVaultStorage.sol";
import {ILendingEngineBasic} from "../interfaces/ILendingEngineBasic.sol";
import {ICollateralManager} from "../interfaces/ICollateralManager.sol";
import {AmountIsZero} from "../errors/StandardErrors.sol";
import {IVaultRouter} from "../interfaces/IVaultRouter.sol";

/// @dev VaultBusinessLogic 最小接口：用于订单化 borrowWithRate 返回 orderId
interface IVaultBusinessLogic {
    function borrowWithRate(
        address user,
        address lender,
        address asset,
        uint256 amount,
        uint256 annualRateBps,
        uint16 termDays
    ) external returns (uint256 orderId);
}

// 临时最小接口（项目未提供 IPositionView.sol）
interface IPositionView {
    function getUserPosition(address user, address asset) external view returns (uint256 collateral, uint256 debt);
    function getHealthFactor(address user, address asset) external view returns (uint256 healthFactor);
    function getLiquidationRisk(address user, address asset) external view returns (bool isRisky, uint256 riskScore);
    function getMaxBorrowable(address user, address asset) external view returns (uint256 maxBorrowable);
}
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { Registry } from "../registry/Registry.sol";
import { IVaultStorage } from "../interfaces/IVaultStorage.sol";
// Minimal interface to access VaultCore.getRegistry without changing IVaultCore
interface IVaultCoreWithRegistry { function getRegistry() external view returns (address); }

/// @title RWAAutoLeveragedStrategy
/// @notice 高级RWA自动杠杆策略合约，支持多资产、动态杠杆、风险控制
/// @dev 集成完整的DeFi协议，提供专业级杠杆交易体验
contract RWAAutoLeveragedStrategy is ReentrancyGuard, Pausable, Ownable {
    using SafeERC20 for IERC20;
    using Math for uint256;

    /* ============ STRUCTS ============ */
    
    /// @notice 用户策略仓位信息
    struct Position {
        uint256 orderId;               // 绑定的订单ID（SSOT 仓位主键）
        address collateralAsset;       // 抵押资产
        address debtAsset;             // 债务资产（通常为 settlementToken）
        uint256 collateralAmount;      // 抵押物数量
        uint256 borrowedAmount;        // 借款数量
        uint256 leverageRatio;         // 杠杆倍数 (100 = 1x)
        uint256 openTimestamp;         // 开仓时间
        uint256 lastRebalanceTime;     // 最后再平衡时间
        bool isActive;                 // 仓位是否活跃
    }

    /// @notice 策略配置参数
    struct StrategyConfig {
        uint256 minLeverage;           // 最小杠杆 (100 = 1x)
        uint256 maxLeverage;           // 最大杠杆 (500 = 5x)
        uint256 targetHealthFactor;    // 目标健康因子
        uint256 rebalanceThreshold;    // 再平衡阈值
        uint256 maxPositionSize;       // 最大仓位大小
        uint256 cooldownPeriod;        // 操作冷却期
    }

    /// @notice 资产配置信息
    struct AssetConfig {
        bool isSupported;              // 是否支持该资产
        uint256 maxLeverage;          // 该资产最大杠杆
        uint256 minCollateral;        // 最小抵押量
        uint256 maxPositionSize;      // 最大仓位大小
    }

    /* ============ STATE VARIABLES ============ */
    IVaultCore public immutable vault;
    IERC20 public immutable rwaToken;
    IERC20 public immutable settlementToken;
    
    StrategyConfig public config;

    /// @notice 订单化借款参数（用于走撮合/订单落地路径生成真实 orderId）
    address public defaultLenderVar;
    uint256 public defaultAnnualRateBpsVar;
    uint16 public defaultTermDaysVar;

    error Strategy__OrderConfigNotSet();
    error Strategy__LeverageIncreaseNotSupportedInOrderMode();
    error Strategy__AssetMismatch();

    /// @notice 设置订单化借款参数（仅 owner）
    function setDefaultOrderConfig(address lender, uint256 annualRateBps, uint16 termDays) external onlyOwner {
        if (lender == address(0) || termDays == 0) revert Strategy__OrderConfigNotSet();
        defaultLenderVar = lender;
        defaultAnnualRateBpsVar = annualRateBps;
        defaultTermDaysVar = termDays;
    }
    
    // 用户仓位映射
    mapping(address => Position) public positions;
    
    // 资产配置映射
    mapping(address => AssetConfig) public assetConfigs;
    
    // 支持的资产列表
    address[] public supportedAssets;
    
    // 操作冷却期映射
    mapping(address => uint256) public lastOperationTime;
    
    // 统计信息
    uint256 public totalPositions;
    uint256 public totalCollateralValue;
    uint256 public totalBorrowedValue;

    /* ============ EVENTS ============ */
    
    event PositionOpened(
        address indexed user,
        address indexed asset,
        uint256 collateralAmount,
        uint256 borrowedAmount,
        uint256 leverageRatio
    );
    
    event PositionClosed(
        address indexed user,
        address indexed asset,
        uint256 collateralReturned,
        uint256 debtRepaid
    );
    
    event PositionRebalanced(
        address indexed user,
        address indexed asset,
        uint256 oldLeverage,
        uint256 newLeverage,
        uint256 healthFactor
    );
    
    event ConfigUpdated(
        uint256 minLeverage,
        uint256 maxLeverage,
        uint256 targetHealthFactor,
        uint256 rebalanceThreshold
    );
    
    event AssetConfigUpdated(
        address indexed asset,
        bool isSupported,
        uint256 maxLeverage,
        uint256 minCollateral
    );
    
    event EmergencyAction(
        address indexed user,
        string action,
        uint256 amount
    );

    /* ============ ERRORS ============ */
    
    error InvalidLeverage();
    error PositionAlreadyExists();
    error PositionNotFound();
    error CooldownNotExpired();
    error AssetNotSupported();
    error PositionSizeExceeded();
    error RebalanceNotNeeded();
    error EmergencyOnly();

    /* ============ CONSTRUCTOR ============ */
    
    constructor(
        address _vault,
        address _vaultStorage,
        address _rwaToken,
        uint256 _minLeverage,
        uint256 _maxLeverage
    ) {
        require(_vault != address(0), "Invalid vault address");
        require(_vaultStorage != address(0), "Invalid vault storage address");
        require(_rwaToken != address(0), "Invalid RWA token address");
        require(_minLeverage >= 100, "Min leverage must be >= 1x");
        require(_maxLeverage <= 500, "Max leverage must be <= 5x");
        require(_minLeverage <= _maxLeverage, "Invalid leverage range");
        
        vault = IVaultCore(_vault);
        rwaToken = IERC20(_rwaToken);
        settlementToken = IERC20(IVaultStorage(_vaultStorage).getSettlementTokenAddr());
        
        config = StrategyConfig({
            minLeverage: _minLeverage,
            maxLeverage: _maxLeverage,
            targetHealthFactor: 150, // 1.5x
            rebalanceThreshold: 20,  // 20% deviation
            maxPositionSize: 1000e18, // 1000 tokens
            cooldownPeriod: 1 hours
        });
    }

    /* ============ EXTERNAL FUNCTIONS ============ */
    
    /// @notice 开启杠杆仓位
    /// @param asset 抵押资产地址
    /// @param collateralAmount 抵押物数量
    /// @param leverageRatio 杠杆倍数 (100 = 1x)
    function openPosition(
        address asset,
        uint256 collateralAmount,
        uint256 leverageRatio
    ) external whenNotPaused nonReentrant {
        // 验证参数
        if (collateralAmount == 0) revert AmountIsZero();
        if (!assetConfigs[asset].isSupported) revert AssetNotSupported();
        if (leverageRatio < config.minLeverage || leverageRatio > config.maxLeverage) {
            revert InvalidLeverage();
        }
        if (leverageRatio > assetConfigs[asset].maxLeverage) revert InvalidLeverage();
        if (collateralAmount < assetConfigs[asset].minCollateral) revert AmountIsZero();
        if (positions[msg.sender].isActive) revert PositionAlreadyExists();
        if (block.timestamp < lastOperationTime[msg.sender] + config.cooldownPeriod) {
            revert CooldownNotExpired();
        }
        
        // 计算借款金额
        uint256 borrowAmount = (collateralAmount * (leverageRatio - 100)) / 100;
        
        // 检查仓位大小限制
        if (collateralAmount > assetConfigs[asset].maxPositionSize) revert PositionSizeExceeded();
        
        // 转移抵押代币到合约
        IERC20(asset).safeTransferFrom(msg.sender, address(this), collateralAmount);
        
        // 存入抵押物到Vault（注意：CM 才是 pull 资金的 spender，因此需要 approve CM）
        address reg = IVaultCoreWithRegistry(address(vault)).getRegistry();
        address cm = Registry(reg).getModuleOrRevert(ModuleKeys.KEY_CM);
        IERC20(asset).safeApprove(cm, collateralAmount);
        vault.deposit(asset, collateralAmount);

        // 订单化借款：走 VaultBusinessLogic.borrowWithRate → SettlementMatchLib.finalizeAtomic → (账本落地 + 订单创建) 返回 orderId
        if (defaultLenderVar == address(0) || defaultTermDaysVar == 0) revert Strategy__OrderConfigNotSet();
        address vbl = Registry(reg).getModuleOrRevert(ModuleKeys.KEY_VAULT_BUSINESS_LOGIC);
        uint256 orderId = IVaultBusinessLogic(vbl).borrowWithRate(
            address(this),
            defaultLenderVar,
            address(settlementToken),
            borrowAmount,
            defaultAnnualRateBpsVar,
            defaultTermDaysVar
        );
        
        // 记录仓位信息
        positions[msg.sender] = Position({
            orderId: orderId,
            collateralAsset: asset,
            debtAsset: address(settlementToken),
            collateralAmount: collateralAmount,
            borrowedAmount: borrowAmount,
            leverageRatio: leverageRatio,
            openTimestamp: block.timestamp,
            lastRebalanceTime: block.timestamp,
            isActive: true
        });
        
        // 更新统计信息
        totalPositions++;
        totalCollateralValue += collateralAmount;
        totalBorrowedValue += borrowAmount;
        lastOperationTime[msg.sender] = block.timestamp;
        
        // 转移借款给用户
        settlementToken.safeTransfer(msg.sender, borrowAmount);
        
        emit PositionOpened(msg.sender, asset, collateralAmount, borrowAmount, leverageRatio);
    }
    
    /// @notice 关闭杠杆仓位
    /// @param asset 抵押资产地址
    /// @param repayAmount 还款金额
    function closePosition(
        address asset,
        uint256 repayAmount
    ) external whenNotPaused nonReentrant {
        Position storage position = positions[msg.sender];
        if (!position.isActive) revert PositionNotFound();
        if (asset != position.collateralAsset) revert Strategy__AssetMismatch();
        if (repayAmount == 0) revert AmountIsZero();
        if (block.timestamp < lastOperationTime[msg.sender] + config.cooldownPeriod) {
            revert CooldownNotExpired();
        }
        
        // 转移还款代币到合约
        settlementToken.safeTransferFrom(msg.sender, address(this), repayAmount);
        
        // 还款到Vault（订单化：必须携带 orderId）
        settlementToken.safeApprove(address(vault), repayAmount);
        vault.repay(position.orderId, address(settlementToken), repayAmount);
        
        // 检查是否完全还款：改为通过 PositionView 查询
        address positionView = Registry(IVaultCoreWithRegistry(address(vault)).getRegistry()).getModuleOrRevert(ModuleKeys.KEY_POSITION_VIEW);
        (uint256 collateral, uint256 debt) = IPositionView(positionView).getUserPosition(msg.sender, address(settlementToken));
        uint256 remainingDebt = debt;
        collateral; // 使用变量避免警告
        
        if (remainingDebt == 0) {
            // 完全还款：抵押物应已由 SettlementManager 自动释放到本合约（borrower=本合约）
            uint256 collateralToWithdraw = position.collateralAmount;
            IERC20(position.collateralAsset).safeTransfer(msg.sender, collateralToWithdraw);
            
            // 更新统计信息
            totalPositions--;
            totalCollateralValue -= collateralToWithdraw;
            totalBorrowedValue -= position.borrowedAmount;
            
            // 清除仓位
            delete positions[msg.sender];
            
            emit PositionClosed(msg.sender, position.collateralAsset, collateralToWithdraw, position.borrowedAmount);
        } else {
            // 部分还款，更新仓位信息
            uint256 repaidAmount = position.borrowedAmount - remainingDebt;
            position.borrowedAmount = remainingDebt;
            totalBorrowedValue -= repaidAmount;
            
            emit PositionClosed(msg.sender, position.collateralAsset, 0, repaidAmount);
        }
        
        lastOperationTime[msg.sender] = block.timestamp;
    }
    
    /// @notice 再平衡仓位
    /// @param asset 抵押资产地址
    /// @param newLeverageRatio 新的杠杆倍数
    function rebalancePosition(
        address asset,
        uint256 newLeverageRatio
    ) external whenNotPaused nonReentrant {
        Position storage position = positions[msg.sender];
        if (!position.isActive) revert PositionNotFound();
        if (newLeverageRatio < config.minLeverage || newLeverageRatio > config.maxLeverage) {
            revert InvalidLeverage();
        }
        if (newLeverageRatio > assetConfigs[asset].maxLeverage) revert InvalidLeverage();
        if (block.timestamp < lastOperationTime[msg.sender] + config.cooldownPeriod) {
            revert CooldownNotExpired();
        }
        
        // 检查是否需要再平衡
        address positionView2 = Registry(IVaultCoreWithRegistry(address(vault)).getRegistry()).getModuleOrRevert(ModuleKeys.KEY_POSITION_VIEW);
        uint256 currentHealthFactor = IPositionView(positionView2).getHealthFactor(msg.sender, asset);
        uint256 leverageDiff = newLeverageRatio > position.leverageRatio ? 
            newLeverageRatio - position.leverageRatio : 
            position.leverageRatio - newLeverageRatio;
        if (currentHealthFactor >= config.targetHealthFactor && leverageDiff < config.rebalanceThreshold) {
            revert RebalanceNotNeeded();
        }
        
        uint256 oldLeverage = position.leverageRatio;
        uint256 targetBorrowAmount = (position.collateralAmount * (newLeverageRatio - 100)) / 100;
        uint256 currentBorrowAmount = position.borrowedAmount;
        
        if (targetBorrowAmount > currentBorrowAmount) {
            // 订单化语义下，增借会产生新的订单或需要扩展订单模型；本轮整改先禁止增借型再平衡
            asset; // silence unused in this branch
            revert Strategy__LeverageIncreaseNotSupportedInOrderMode();
        } else if (targetBorrowAmount < currentBorrowAmount) {
            // 需要还一些
            uint256 repayAmount = currentBorrowAmount - targetBorrowAmount;
            settlementToken.safeTransferFrom(msg.sender, address(this), repayAmount);
            settlementToken.safeApprove(address(vault), repayAmount);
            vault.repay(position.orderId, address(settlementToken), repayAmount);
            position.borrowedAmount = targetBorrowAmount;
            totalBorrowedValue -= repayAmount;
        }
        
        position.leverageRatio = newLeverageRatio;
        position.lastRebalanceTime = block.timestamp;
        lastOperationTime[msg.sender] = block.timestamp;
        
        emit PositionRebalanced(msg.sender, asset, oldLeverage, newLeverageRatio, currentHealthFactor);
    }
    
    /// @notice 紧急平仓（仅限紧急情况）
    /// @param user 用户地址
    /// @param asset 资产地址
    function emergencyClosePosition(address user, address asset) external onlyOwner {
        Position storage position = positions[user];
        if (!position.isActive) revert PositionNotFound();
        
        // 强制提取所有抵押物
        vault.withdraw(asset, position.collateralAmount);
        IERC20(asset).safeTransfer(user, position.collateralAmount);
        
        // 更新统计信息
        totalPositions--;
        totalCollateralValue -= position.collateralAmount;
        totalBorrowedValue -= position.borrowedAmount;
        
        // 清除仓位
        delete positions[user];
        
        emit EmergencyAction(user, "EmergencyClose", position.collateralAmount);
        emit PositionClosed(user, asset, position.collateralAmount, position.borrowedAmount);
    }

    /* ============ VIEW FUNCTIONS ============ */
    
    /// @notice 获取用户仓位信息
    /// @param user 用户地址
    /// @return position 仓位信息
    function getPosition(address user) external view returns (Position memory position) {
        return positions[user];
    }
    
    /// @notice 获取用户健康因子
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return healthFactor 健康因子
    function getHealthFactor(address user, address asset) external view returns (uint256 healthFactor) {
        address positionView3 = Registry(IVaultCoreWithRegistry(address(vault)).getRegistry()).getModuleOrRevert(ModuleKeys.KEY_POSITION_VIEW);
        return IPositionView(positionView3).getHealthFactor(user, asset);
    }
    
    /// @notice 检查用户是否处于清算风险
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return isRisky 是否处于风险状态
    function isLiquidationRisky(address user, address asset) external view returns (bool isRisky) {
        address positionView4 = Registry(IVaultCoreWithRegistry(address(vault)).getRegistry()).getModuleOrRevert(ModuleKeys.KEY_POSITION_VIEW);
        (isRisky,) = IPositionView(positionView4).getLiquidationRisk(user, asset);
    }
    
    /// @notice 获取最大可借金额
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return maxBorrowable 最大可借金额
    function getMaxBorrowable(address user, address asset) external view returns (uint256 maxBorrowable) {
        address positionView5 = Registry(IVaultCoreWithRegistry(address(vault)).getRegistry()).getModuleOrRevert(ModuleKeys.KEY_POSITION_VIEW);
        return IPositionView(positionView5).getMaxBorrowable(user, asset);
    }
    
    /// @notice 获取策略统计信息
    /// @return totalPositions_ 总仓位数量
    /// @return totalCollateralValue_ 总抵押价值
    /// @return totalBorrowedValue_ 总借款价值
    function getStrategyStats() external view returns (
        uint256 totalPositions_,
        uint256 totalCollateralValue_,
        uint256 totalBorrowedValue_
    ) {
        return (totalPositions, totalCollateralValue, totalBorrowedValue);
    }

    /* ============ ADMIN FUNCTIONS ============ */
    
    /// @notice 更新策略配置
    /// @param _config 新配置
    function updateConfig(StrategyConfig calldata _config) external onlyOwner {
        require(_config.minLeverage >= 100, "Min leverage must be >= 1x");
        require(_config.maxLeverage <= 500, "Max leverage must be <= 5x");
        require(_config.minLeverage <= _config.maxLeverage, "Invalid leverage range");
        require(_config.targetHealthFactor >= 110, "Target HF must be >= 1.1x");
        
        config = _config;
        emit ConfigUpdated(
            _config.minLeverage,
            _config.maxLeverage,
            _config.targetHealthFactor,
            _config.rebalanceThreshold
        );
    }
    
    /// @notice 更新资产配置
    /// @param asset 资产地址
    /// @param _config 资产配置
    function updateAssetConfig(address asset, AssetConfig calldata _config) external onlyOwner {
        require(asset != address(0), "Invalid asset address");
        
        assetConfigs[asset] = _config;
        
        // 更新支持资产列表
        bool found = false;
        for (uint256 i = 0; i < supportedAssets.length; i++) {
            if (supportedAssets[i] == asset) {
                found = true;
                break;
            }
        }
        
        if (_config.isSupported && !found) {
            supportedAssets.push(asset);
        } else if (!_config.isSupported && found) {
            // 移除资产（简化实现）
            for (uint256 i = 0; i < supportedAssets.length; i++) {
                if (supportedAssets[i] == asset) {
                    supportedAssets[i] = supportedAssets[supportedAssets.length - 1];
                    supportedAssets.pop();
                    break;
                }
            }
        }
        
        emit AssetConfigUpdated(asset, _config.isSupported, _config.maxLeverage, _config.minCollateral);
    }
    
    /// @notice 暂停合约
    function pause() external onlyOwner {
        _pause();
    }
    
    /// @notice 恢复合约
    function unpause() external onlyOwner {
        _unpause();
    }
    
    /// @notice 提取意外发送的代币
    /// @param token 代币地址
    /// @param to 接收地址
    /// @param amount 数量
    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Invalid recipient");
        IERC20(token).safeTransfer(to, amount);
    }

    /* ============ RECEIVE FUNCTION ============ */
    
    receive() external payable {
        revert("ETH not accepted");
    }
} 