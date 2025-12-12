// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "./LiquidationValidationLibrary.sol";

/**
 * @title 清算代币操作库
 * @title Liquidation Token Operations Library
 * @author RWA Lending Platform
 * @notice 提供代币操作相关的功能，整合所有清算模块中重复的代币操作逻辑
 * @notice Provides token operation-related functionality, integrates all repeated token operation logic from liquidation modules
 * @dev 提供标准化的代币操作函数，确保一致性和安全性
 * @dev Provides standardized token operation functions to ensure consistency and security
 */
library LiquidationTokenLibrary {
    using LiquidationValidationLibrary for *;

    /* ============ Custom Errors ============ */
    
    /**
     * @notice 代币转账失败错误 - 当代币转账失败时触发
     * @notice Token transfer failed error - Triggered when token transfer fails
     * @param tokenAddr 代币地址 Token address
     * @param fromAddr 发送者地址 From address
     * @param toAddr 接收者地址 To address
     * @param amountValue 数量 Amount
     */
    error TokenTransferFailed(address tokenAddr, address fromAddr, address toAddr, uint256 amountValue);
    
    /**
     * @notice 代币授权失败错误 - 当代币授权失败时触发
     * @notice Token approval failed error - Triggered when token approval fails
     * @param tokenAddr 代币地址 Token address
     * @param spenderAddr 授权者地址 Spender address
     * @param amountValue 数量 Amount
     */
    error TokenApprovalFailed(address tokenAddr, address spenderAddr, uint256 amountValue);
    
    /**
     * @notice 代币余额不足错误 - 当代币余额不足时触发
     * @notice Insufficient token balance error - Triggered when token balance is insufficient
     * @param tokenAddr 代币地址 Token address
     * @param accountAddr 账户地址 Account address
     * @param requiredAmount 需要数量 Required amount
     * @param availableAmount 可用数量 Available amount
     */
    error InsufficientTokenBalance(address tokenAddr, address accountAddr, uint256 requiredAmount, uint256 availableAmount);

    /* ============ ERC20 Token Operations ============ */
    
    /**
     * @notice 安全转账ERC20代币 - 安全地转账ERC20代币
     * @notice Safe transfer ERC20 token - Safely transfer ERC20 token
     * @param tokenAddr 代币地址 Token address
     * @param fromAddr 发送者地址 From address
     * @param toAddr 接收者地址 To address
     * @param amountValue 数量 Amount
     * @return success 是否成功 Whether successful
     */
    function safeTransferERC20(
        address tokenAddr,
        address fromAddr,
        address toAddr,
        uint256 amountValue
    ) internal returns (bool success) {
        LiquidationValidationLibrary.validateAddress(tokenAddr);
        LiquidationValidationLibrary.validateAddress(fromAddr);
        LiquidationValidationLibrary.validateAddress(toAddr);
        LiquidationValidationLibrary.validateAmount(amountValue);
        
        try IERC20(tokenAddr).transferFrom(fromAddr, toAddr, amountValue) returns (bool result) {
            success = result;
            if (!success) {
                revert TokenTransferFailed(tokenAddr, fromAddr, toAddr, amountValue);
            }
        } catch {
            revert TokenTransferFailed(tokenAddr, fromAddr, toAddr, amountValue);
        }
    }

    /**
     * @notice 安全转账ERC20代币（直接转账） - 安全地直接转账ERC20代币
     * @notice Safe transfer ERC20 token (direct transfer) - Safely transfer ERC20 token directly
     * @param tokenAddr 代币地址 Token address
     * @param toAddr 接收者地址 To address
     * @param amountValue 数量 Amount
     * @return success 是否成功 Whether successful
     */
    function safeTransferERC20Direct(
        address tokenAddr,
        address toAddr,
        uint256 amountValue
    ) internal returns (bool success) {
        LiquidationValidationLibrary.validateAddress(tokenAddr);
        LiquidationValidationLibrary.validateAddress(toAddr);
        LiquidationValidationLibrary.validateAmount(amountValue);
        
        try IERC20(tokenAddr).transfer(toAddr, amountValue) returns (bool result) {
            success = result;
            if (!success) {
                revert TokenTransferFailed(tokenAddr, address(this), toAddr, amountValue);
            }
        } catch {
            revert TokenTransferFailed(tokenAddr, address(this), toAddr, amountValue);
        }
    }

    /**
     * @notice 批量转账ERC20代币 - 批量转账ERC20代币
     * @notice Batch transfer ERC20 tokens - Batch transfer ERC20 tokens
     * @param tokenAddr 代币地址 Token address
     * @param recipientAddrs 接收者地址数组 Array of recipient addresses
     * @param amountValues 数量数组 Array of amounts
     * @return successCount 成功数量 Success count
     */
    function batchTransferERC20(
        address tokenAddr,
        address[] memory recipientAddrs,
        uint256[] memory amountValues
    ) internal returns (uint256 successCount) {
        LiquidationValidationLibrary.validateArrayLength(recipientAddrs, amountValues);
        LiquidationValidationLibrary.validateAddress(tokenAddr);
        
        successCount = 0;
        for (uint256 i = 0; i < recipientAddrs.length; i++) {
            if (safeTransferERC20Direct(tokenAddr, recipientAddrs[i], amountValues[i])) {
                successCount++;
            }
        }
    }

    /* ============ ERC721 Token Operations ============ */
    
    /**
     * @notice 安全转账ERC721代币 - 安全地转账ERC721代币
     * @notice Safe transfer ERC721 token - Safely transfer ERC721 token
     * @param tokenAddr 代币地址 Token address
     * @param fromAddr 发送者地址 From address
     * @param toAddr 接收者地址 To address
     * @param tokenIdValue 代币ID Token ID
     * @return success 是否成功 Whether successful
     */
    function safeTransferERC721(
        address tokenAddr,
        address fromAddr,
        address toAddr,
        uint256 tokenIdValue
    ) internal returns (bool success) {
        LiquidationValidationLibrary.validateAddress(tokenAddr);
        LiquidationValidationLibrary.validateAddress(fromAddr);
        LiquidationValidationLibrary.validateAddress(toAddr);
        
        try IERC721(tokenAddr).transferFrom(fromAddr, toAddr, tokenIdValue) {
            success = true;
        } catch {
            success = false;
        }
        
        if (!success) {
            revert TokenTransferFailed(tokenAddr, fromAddr, toAddr, tokenIdValue);
        }
    }

    /**
     * @notice 批量转账ERC721代币 - 批量转账ERC721代币
     * @notice Batch transfer ERC721 tokens - Batch transfer ERC721 tokens
     * @param tokenAddr 代币地址 Token address
     * @param recipientAddrs 接收者地址数组 Array of recipient addresses
     * @param tokenIdValues 代币ID数组 Array of token IDs
     * @return successCount 成功数量 Success count
     */
    function batchTransferERC721(
        address tokenAddr,
        address[] memory recipientAddrs,
        uint256[] memory tokenIdValues
    ) internal returns (uint256 successCount) {
        LiquidationValidationLibrary.validateArrayLength(recipientAddrs, tokenIdValues);
        LiquidationValidationLibrary.validateAddress(tokenAddr);
        
        successCount = 0;
        for (uint256 i = 0; i < recipientAddrs.length; i++) {
            if (safeTransferERC721(tokenAddr, address(this), recipientAddrs[i], tokenIdValues[i])) {
                successCount++;
            }
        }
    }

    /* ============ ERC1155 Token Operations ============ */
    
    /**
     * @notice 安全转账ERC1155代币 - 安全地转账ERC1155代币
     * @notice Safe transfer ERC1155 token - Safely transfer ERC1155 token
     * @param tokenAddr 代币地址 Token address
     * @param fromAddr 发送者地址 From address
     * @param toAddr 接收者地址 To address
     * @param tokenIdValue 代币ID Token ID
     * @param amountValue 数量 Amount
     * @param dataBytes 数据 Data
     * @return success 是否成功 Whether successful
     */
    function safeTransferERC1155(
        address tokenAddr,
        address fromAddr,
        address toAddr,
        uint256 tokenIdValue,
        uint256 amountValue,
        bytes memory dataBytes
    ) internal returns (bool success) {
        LiquidationValidationLibrary.validateAddress(tokenAddr);
        LiquidationValidationLibrary.validateAddress(fromAddr);
        LiquidationValidationLibrary.validateAddress(toAddr);
        LiquidationValidationLibrary.validateAmount(amountValue);
        
        try IERC1155(tokenAddr).safeTransferFrom(fromAddr, toAddr, tokenIdValue, amountValue, dataBytes) {
            success = true;
        } catch {
            success = false;
        }
        
        if (!success) {
            revert TokenTransferFailed(tokenAddr, fromAddr, toAddr, amountValue);
        }
    }

    /**
     * @notice 批量转账ERC1155代币 - 批量转账ERC1155代币
     * @notice Batch transfer ERC1155 tokens - Batch transfer ERC1155 tokens
     * @param tokenAddr 代币地址 Token address
     * @param recipientAddrs 接收者地址数组 Array of recipient addresses
     * @param tokenIdValues 代币ID数组 Array of token IDs
     * @param amountValues 数量数组 Array of amounts
     * @param dataBytesArray 数据数组 Array of data
     * @return successCount 成功数量 Success count
     */
    function batchTransferERC1155(
        address tokenAddr,
        address[] memory recipientAddrs,
        uint256[] memory tokenIdValues,
        uint256[] memory amountValues,
        bytes[] memory dataBytesArray
    ) internal returns (uint256 successCount) {
        LiquidationValidationLibrary.validateArrayLength(recipientAddrs, tokenIdValues);
        LiquidationValidationLibrary.validateArrayLength(recipientAddrs, amountValues);
        LiquidationValidationLibrary.validateAddress(tokenAddr);
        
        successCount = 0;
        for (uint256 i = 0; i < recipientAddrs.length; i++) {
            if (safeTransferERC1155(tokenAddr, address(this), recipientAddrs[i], tokenIdValues[i], amountValues[i], dataBytesArray[i])) {
                successCount++;
            }
        }
    }

    /* ============ Token Balance Operations ============ */
    
    /**
     * @notice 获取ERC20代币余额 - 获取ERC20代币余额
     * @notice Get ERC20 token balance - Get ERC20 token balance
     * @param tokenAddr 代币地址 Token address
     * @param accountAddr 账户地址 Account address
     * @return balanceValue 余额 Balance
     */
    function getERC20Balance(
        address tokenAddr,
        address accountAddr
    ) internal view returns (uint256 balanceValue) {
        LiquidationValidationLibrary.validateAddress(tokenAddr);
        LiquidationValidationLibrary.validateAddress(accountAddr);
        
        try IERC20(tokenAddr).balanceOf(accountAddr) returns (uint256 result) {
            balanceValue = result;
        } catch {
            balanceValue = 0;
        }
    }

    /**
     * @notice 检查ERC20代币余额 - 检查ERC20代币余额是否充足
     * @notice Check ERC20 token balance - Check if ERC20 token balance is sufficient
     * @param tokenAddr 代币地址 Token address
     * @param accountAddr 账户地址 Account address
     * @param requiredAmount 需要数量 Required amount
     * @return sufficient 是否充足 Whether sufficient
     */
    function checkERC20Balance(
        address tokenAddr,
        address accountAddr,
        uint256 requiredAmount
    ) internal view returns (bool sufficient) {
        uint256 balanceValue = getERC20Balance(tokenAddr, accountAddr);
        sufficient = balanceValue >= requiredAmount;
        
        if (!sufficient) {
            revert InsufficientTokenBalance(tokenAddr, accountAddr, requiredAmount, balanceValue);
        }
    }

    /**
     * @notice 获取ERC721代币所有者 - 获取ERC721代币所有者
     * @notice Get ERC721 token owner - Get ERC721 token owner
     * @param tokenAddr 代币地址 Token address
     * @param tokenIdValue 代币ID Token ID
     * @return ownerAddr 所有者地址 Owner address
     */
    function getERC721Owner(
        address tokenAddr,
        uint256 tokenIdValue
    ) internal view returns (address ownerAddr) {
        LiquidationValidationLibrary.validateAddress(tokenAddr);
        
        try IERC721(tokenAddr).ownerOf(tokenIdValue) returns (address result) {
            ownerAddr = result;
        } catch {
            ownerAddr = address(0);
        }
    }

    /**
     * @notice 获取ERC1155代币余额 - 获取ERC1155代币余额
     * @notice Get ERC1155 token balance - Get ERC1155 token balance
     * @param tokenAddr 代币地址 Token address
     * @param accountAddr 账户地址 Account address
     * @param tokenIdValue 代币ID Token ID
     * @return balanceValue 余额 Balance
     */
    function getERC1155Balance(
        address tokenAddr,
        address accountAddr,
        uint256 tokenIdValue
    ) internal view returns (uint256 balanceValue) {
        LiquidationValidationLibrary.validateAddress(tokenAddr);
        LiquidationValidationLibrary.validateAddress(accountAddr);
        
        try IERC1155(tokenAddr).balanceOf(accountAddr, tokenIdValue) returns (uint256 result) {
            balanceValue = result;
        } catch {
            balanceValue = 0;
        }
    }

    /* ============ Token Approval Operations ============ */
    
    /**
     * @notice 安全授权ERC20代币 - 安全地授权ERC20代币
     * @notice Safe approve ERC20 token - Safely approve ERC20 token
     * @param tokenAddr 代币地址 Token address
     * @param spenderAddr 授权者地址 Spender address
     * @param amountValue 数量 Amount
     * @return success 是否成功 Whether successful
     */
    function safeApproveERC20(
        address tokenAddr,
        address spenderAddr,
        uint256 amountValue
    ) internal returns (bool success) {
        LiquidationValidationLibrary.validateAddress(tokenAddr);
        LiquidationValidationLibrary.validateAddress(spenderAddr);
        
        try IERC20(tokenAddr).approve(spenderAddr, amountValue) returns (bool result) {
            success = result;
            if (!success) {
                revert TokenApprovalFailed(tokenAddr, spenderAddr, amountValue);
            }
        } catch {
            revert TokenApprovalFailed(tokenAddr, spenderAddr, amountValue);
        }
    }

    /**
     * @notice 安全授权ERC721代币 - 安全地授权ERC721代币
     * @notice Safe approve ERC721 token - Safely approve ERC721 token
     * @param tokenAddr 代币地址 Token address
     * @param toAddr 授权者地址 To address
     * @param tokenIdValue 代币ID Token ID
     * @return success 是否成功 Whether successful
     */
    function safeApproveERC721(
        address tokenAddr,
        address toAddr,
        uint256 tokenIdValue
    ) internal returns (bool success) {
        LiquidationValidationLibrary.validateAddress(tokenAddr);
        LiquidationValidationLibrary.validateAddress(toAddr);
        
        try IERC721(tokenAddr).approve(toAddr, tokenIdValue) {
            success = true;
        } catch {
            success = false;
        }
        
        if (!success) {
            revert TokenApprovalFailed(tokenAddr, toAddr, tokenIdValue);
        }
    }

    /* ============ Token Utility Operations ============ */
    
    /**
     * @notice 获取代币信息 - 获取代币的基本信息
     * @notice Get token info - Get basic token information
     * @param tokenAddr 代币地址 Token address
     * @return tokenName 代币名称 Token name
     * @return tokenSymbol 代币符号 Token symbol
     * @return tokenDecimals 代币精度 Token decimals
     */
    function getTokenInfo(
        address tokenAddr
    ) internal view returns (
        string memory tokenName,
        string memory tokenSymbol,
        uint8 tokenDecimals
    ) {
        LiquidationValidationLibrary.validateAddress(tokenAddr);
        
        try IERC20Metadata(tokenAddr).name() returns (string memory nameResult) {
            tokenName = nameResult;
        } catch {
            tokenName = "";
        }
        
        try IERC20Metadata(tokenAddr).symbol() returns (string memory symbolResult) {
            tokenSymbol = symbolResult;
        } catch {
            tokenSymbol = "";
        }
        
        try IERC20Metadata(tokenAddr).decimals() returns (uint8 decimalsResult) {
            tokenDecimals = decimalsResult;
        } catch {
            tokenDecimals = 18;
        }
    }

    /**
     * @notice 计算代币价值 - 根据数量和价格计算代币价值
     * @notice Calculate token value - Calculate token value based on amount and price
     * @param amountValue 数量 Amount
     * @param priceValue 价格 Price
     * @param decimalsValue 精度 Decimals
     * @return valueResult 价值 Value
     */
    function calculateTokenValue(
        uint256 amountValue,
        uint256 priceValue,
        uint8 decimalsValue
    ) internal pure returns (uint256 valueResult) {
        LiquidationValidationLibrary.validatePrice(priceValue);
        
        uint256 precisionValue = 10 ** decimalsValue;
        valueResult = (amountValue * priceValue) / precisionValue;
    }

    /**
     * @notice 转换代币精度 - 转换代币精度
     * @notice Convert token decimals - Convert token decimals
     * @param amountValue 数量 Amount
     * @param fromDecimalsValue 源精度 From decimals
     * @param toDecimalsValue 目标精度 To decimals
     * @return convertedAmountValue 转换后的数量 Converted amount
     */
    function convertTokenDecimals(
        uint256 amountValue,
        uint8 fromDecimalsValue,
        uint8 toDecimalsValue
    ) internal pure returns (uint256 convertedAmountValue) {
        if (fromDecimalsValue == toDecimalsValue) {
            convertedAmountValue = amountValue;
        } else if (fromDecimalsValue < toDecimalsValue) {
            convertedAmountValue = amountValue * (10 ** (toDecimalsValue - fromDecimalsValue));
        } else {
            convertedAmountValue = amountValue / (10 ** (fromDecimalsValue - toDecimalsValue));
        }
    }

    /* ============ Generic Token Operations ============ */
    
    /**
     * @notice 安全转账代币 - 通用的安全转账函数
     * @notice Safe transfer token - Generic safe transfer function
     * @param tokenAddr 代币地址 Token address
     * @param toAddr 接收者地址 To address
     * @param amountValue 数量 Amount
     * @return success 是否成功 Whether successful
     */
    function safeTransfer(
        address tokenAddr,
        address toAddr,
        uint256 amountValue
    ) internal returns (bool success) {
        return safeTransferERC20Direct(tokenAddr, toAddr, amountValue);
    }
} 