// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { ReentrancyGuardSlimUpgradeable } from "../utils/ReentrancyGuardSlimUpgradeable.sol";

error CrossChainGovernance__InvalidProposal();
error CrossChainGovernance__ProposalNotActive();
error CrossChainGovernance__AlreadyVoted();
error CrossChainGovernance__InvalidChainId();
error CrossChainGovernance__ExecutionFailed();
error CrossChainGovernance__InsufficientVotes();
error CrossChainGovernance__InvalidExecutor();

/// @title CrossChainGovernance - 跨链治理投票系统
/// @notice 支持多链投票、提案管理、跨链执行的治理系统
/// @dev 遵循 docs/SmartContractStandard.md 注释规范
contract CrossChainGovernance is Initializable, AccessControlUpgradeable, ReentrancyGuardSlimUpgradeable, UUPSUpgradeable {
    
    /// @notice 治理角色
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    /// @notice 执行者角色
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");
    
    /// @notice 提案状态枚举
    enum ProposalState {
        Pending,    // 待投票
        Active,     // 投票中
        Succeeded,  // 投票成功
        Executed,   // 已执行
        Defeated,   // 投票失败
        Expired     // 已过期
    }
    
    /// @notice 投票选项枚举
    enum VoteOption {
        Against,    // 反对
        For,        // 赞成
        Abstain     // 弃权
    }
    
    /// @notice 提案结构
    struct Proposal {
        uint256 proposalId;
        address proposer;
        string description;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        uint256 startTime;
        uint256 endTime;
        uint256 executionTime;
        bool executed;
        bool canceled;
        ProposalState state;
        uint256 quorum;
        uint256 chainId;
        bytes[] actions;
        address[] targets;
    }
    
    /// @notice 投票记录结构
    struct Vote {
        VoteOption option;
        uint256 weight;
        uint256 timestamp;
        bool hasVoted;
    }
    
    /// @notice 跨链投票记录
    struct CrossChainVote {
        uint256 chainId;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        uint256 totalWeight;
        bool isVerified;
    }
    
    /// @notice 提案映射
    mapping(uint256 => Proposal) public proposals;
    
    /// @notice 用户投票记录
    mapping(uint256 => mapping(address => Vote)) public votes;
    
    /// @notice 跨链投票记录
    mapping(uint256 => mapping(uint256 => CrossChainVote)) public crossChainVotes;
    
    /// @notice 支持的链ID
    mapping(uint256 => bool) public supportedChains;
    
    /// @notice 提案计数器
    uint256 public proposalCount;
    
    /// @notice 投票权重映射
    mapping(address => uint256) public votingPower;
    
    /// @notice 最小提案时间
    uint256 public minProposalTime = 1 days;
    
    /// @notice 最大提案时间
    uint256 public maxProposalTime = 30 days;
    
    /// @notice 执行延迟时间
    uint256 public executionDelay = 2 days;
    
    /// @notice 法定人数比例 (BPS)
    uint256 public quorumBPS = 4000; // 40%
    
    /// @notice 投票阈值比例 (BPS)
    uint256 public voteThresholdBPS = 6000; // 60%
    
    /// @notice 跨链验证器
    mapping(address => bool) public crossChainValidators;
    
    /// @notice 跨链消息哈希验证
    mapping(bytes32 => bool) public executedCrossChainMessages;

    event ProposalCreated(uint256 indexed proposalId, address indexed proposer, string description, uint256 startTime, uint256 endTime);
    event VoteCast(uint256 indexed proposalId, address indexed voter, VoteOption option, uint256 weight);
    event ProposalExecuted(uint256 indexed proposalId, address indexed executor);
    event CrossChainVoteReceived(uint256 indexed proposalId, uint256 indexed chainId, uint256 forVotes, uint256 againstVotes, uint256 abstainVotes);
    event CrossChainExecution(uint256 indexed proposalId, uint256 indexed chainId, bytes32 messageHash);
    event GovernanceParametersUpdated(uint256 minProposalTime, uint256 maxProposalTime, uint256 executionDelay, uint256 quorumBPS, uint256 voteThresholdBPS);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice 初始化合约
    /// @param admin 管理员地址
    function initialize(address admin, address /* governanceToken */) external initializer {
        __AccessControl_init();
        __ReentrancyGuardSlim_init();
        __UUPSUpgradeable_init();
        
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
        _grantRole(EXECUTOR_ROLE, admin);
        
        // 初始化支持的链
        supportedChains[1] = true;    // Ethereum
        supportedChains[42161] = true; // Arbitrum
        supportedChains[137] = true;   // Polygon
        supportedChains[56] = true;    // BSC
    }

    /// @notice 创建提案
    /// @param description 提案描述
    /// @param actions 执行动作数组
    /// @param targets 目标合约数组
    /// @param votingPeriod 投票周期
    function createProposal(
        string calldata description,
        bytes[] calldata actions,
        address[] calldata targets,
        uint256 votingPeriod
    ) external onlyRole(GOVERNANCE_ROLE) returns (uint256 proposalId) {
        if (votingPeriod < minProposalTime || votingPeriod > maxProposalTime) {
            revert CrossChainGovernance__InvalidProposal();
        }
        
        proposalId = ++proposalCount;
        
        uint256 startTime = block.timestamp;
        uint256 endTime = startTime + votingPeriod;
        uint256 quorum = _calculateQuorum();
        
        proposals[proposalId] = Proposal({
            proposalId: proposalId,
            proposer: msg.sender,
            description: description,
            forVotes: 0,
            againstVotes: 0,
            abstainVotes: 0,
            startTime: startTime,
            endTime: endTime,
            executionTime: 0,
            executed: false,
            canceled: false,
            state: ProposalState.Active,
            quorum: quorum,
            chainId: block.chainid,
            actions: actions,
            targets: targets
        });
        
        emit ProposalCreated(proposalId, msg.sender, description, startTime, endTime);
    }

    /// @notice 投票
    /// @param proposalId 提案ID
    /// @param option 投票选项
    function vote(uint256 proposalId, VoteOption option) external {
        Proposal storage proposal = proposals[proposalId];
        
        if (proposal.state != ProposalState.Active) {
            revert CrossChainGovernance__ProposalNotActive();
        }
        
        if (block.timestamp < proposal.startTime || block.timestamp > proposal.endTime) {
            revert CrossChainGovernance__ProposalNotActive();
        }
        
        Vote storage userVote = votes[proposalId][msg.sender];
        if (userVote.hasVoted) {
            revert CrossChainGovernance__AlreadyVoted();
        }
        
        uint256 weight = votingPower[msg.sender];
        if (weight == 0) {
            revert CrossChainGovernance__InsufficientVotes();
        }
        
        userVote.option = option;
        userVote.weight = weight;
        userVote.timestamp = block.timestamp;
        userVote.hasVoted = true;
        
        if (option == VoteOption.For) {
            proposal.forVotes += weight;
        } else if (option == VoteOption.Against) {
            proposal.againstVotes += weight;
        } else if (option == VoteOption.Abstain) {
            proposal.abstainVotes += weight;
        }
        
        emit VoteCast(proposalId, msg.sender, option, weight);
    }

    /// @notice 执行提案
    /// @param proposalId 提案ID
    function executeProposal(uint256 proposalId) external onlyRole(EXECUTOR_ROLE) {
        _reentrancyGuardEnter();
        Proposal storage proposal = proposals[proposalId];
        
        if (proposal.executed) {
            revert CrossChainGovernance__ExecutionFailed();
        }
        
        if (proposal.state != ProposalState.Succeeded) {
            revert CrossChainGovernance__ExecutionFailed();
        }
        
        if (block.timestamp < proposal.endTime + executionDelay) {
            revert CrossChainGovernance__ExecutionFailed();
        }
        
        proposal.executed = true;
        proposal.executionTime = block.timestamp;
        proposal.state = ProposalState.Executed;
        
        // 执行提案动作
        for (uint256 i = 0; i < proposal.actions.length; i++) {
            (bool success, ) = proposal.targets[i].call(proposal.actions[i]);
            if (!success) {
                revert CrossChainGovernance__ExecutionFailed();
            }
        }
        
        emit ProposalExecuted(proposalId, msg.sender);
        _reentrancyGuardExit();
    }

    /// @notice 接收跨链投票
    /// @param proposalId 提案ID
    /// @param chainId 源链ID
    /// @param forVotes 赞成票数
    /// @param againstVotes 反对票数
    /// @param abstainVotes 弃权票数
    /// @param totalWeight 总权重
    /// @param validator 验证器地址
    function receiveCrossChainVote(
        uint256 proposalId,
        uint256 chainId,
        uint256 forVotes,
        uint256 againstVotes,
        uint256 abstainVotes,
        uint256 totalWeight,
        address validator,
        bytes calldata /* signature */
    ) external onlyRole(EXECUTOR_ROLE) {
        _reentrancyGuardEnter();
        if (!supportedChains[chainId]) {
            revert CrossChainGovernance__InvalidChainId();
        }
        
        if (!crossChainValidators[validator]) {
            revert CrossChainGovernance__InvalidExecutor();
        }
        
        // 验证签名 (简化版本，实际需要完整的签名验证)
        // bytes32 messageHash = keccak256(abi.encodePacked(
        //     proposalId,
        //     chainId,
        //     forVotes,
        //     againstVotes,
        //     abstainVotes,
        //     totalWeight
        // ));
        
        CrossChainVote storage crossChainVote = crossChainVotes[proposalId][chainId];
        crossChainVote.forVotes = forVotes;
        crossChainVote.againstVotes = againstVotes;
        crossChainVote.abstainVotes = abstainVotes;
        crossChainVote.totalWeight = totalWeight;
        crossChainVote.isVerified = true;
        
        // 更新主提案的投票数
        Proposal storage proposal = proposals[proposalId];
        proposal.forVotes += forVotes;
        proposal.againstVotes += againstVotes;
        proposal.abstainVotes += abstainVotes;
        
        emit CrossChainVoteReceived(proposalId, chainId, forVotes, againstVotes, abstainVotes);
        _reentrancyGuardExit();
    }

    /// @notice 跨链执行提案
    /// @param proposalId 提案ID
    /// @param targetChainId 目标链ID
    /// @param targetContract 目标合约地址
    /// @param action 执行动作
    function executeCrossChainProposal(
        uint256 proposalId,
        uint256 targetChainId,
        address targetContract,
        bytes calldata action
    ) external onlyRole(EXECUTOR_ROLE) {
        _reentrancyGuardEnter();
        if (!supportedChains[targetChainId]) {
            revert CrossChainGovernance__InvalidChainId();
        }
        
        Proposal storage proposal = proposals[proposalId];
        if (!proposal.executed) {
            revert CrossChainGovernance__ExecutionFailed();
        }
        
        bytes32 crossChainMessageHash = keccak256(abi.encodePacked(
            proposalId,
            targetChainId,
            targetContract,
            action
        ));
        
        if (executedCrossChainMessages[crossChainMessageHash]) {
            revert CrossChainGovernance__ExecutionFailed();
        }
        
        executedCrossChainMessages[crossChainMessageHash] = true;
        
        emit CrossChainExecution(proposalId, targetChainId, crossChainMessageHash);
        _reentrancyGuardExit();
    }

    /// @notice 更新投票权重
    /// @param user 用户地址
    /// @param weight 新权重
    function updateVotingPower(address user, uint256 weight) external onlyRole(GOVERNANCE_ROLE) {
        _reentrancyGuardEnter();
        votingPower[user] = weight;
        _reentrancyGuardExit();
    }

    /// @notice 批量更新投票权重
    /// @param users 用户地址数组
    /// @param weights 权重数组
    function batchUpdateVotingPower(address[] calldata users, uint256[] calldata weights) external onlyRole(GOVERNANCE_ROLE) {
        _reentrancyGuardEnter();
        if (users.length != weights.length) {
            revert CrossChainGovernance__InvalidProposal();
        }
        
        for (uint256 i = 0; i < users.length; i++) {
            votingPower[users[i]] = weights[i];
        }
        _reentrancyGuardExit();
    }

    /// @notice 更新治理参数
    /// @param minTime 最小提案时间
    /// @param maxTime 最大提案时间
    /// @param delay 执行延迟
    /// @param quorum 法定人数比例
    /// @param threshold 投票阈值比例
    function updateGovernanceParameters(
        uint256 minTime,
        uint256 maxTime,
        uint256 delay,
        uint256 quorum,
        uint256 threshold
    ) external onlyRole(GOVERNANCE_ROLE) {
        _reentrancyGuardEnter();
        minProposalTime = minTime;
        maxProposalTime = maxTime;
        executionDelay = delay;
        quorumBPS = quorum;
        voteThresholdBPS = threshold;
        
        emit GovernanceParametersUpdated(minTime, maxTime, delay, quorum, threshold);
        _reentrancyGuardExit();
    }

    /// @notice 添加跨链验证器
    /// @param validator 验证器地址
    function addCrossChainValidator(address validator) external onlyRole(GOVERNANCE_ROLE) {
        crossChainValidators[validator] = true;
    }

    /// @notice 移除跨链验证器
    /// @param validator 验证器地址
    function removeCrossChainValidator(address validator) external onlyRole(GOVERNANCE_ROLE) {
        crossChainValidators[validator] = false;
    }

    /// @notice 添加支持的链
    /// @param chainId 链ID
    function addSupportedChain(uint256 chainId) external onlyRole(GOVERNANCE_ROLE) {
        supportedChains[chainId] = true;
    }

    /// @notice 移除支持的链
    /// @param chainId 链ID
    function removeSupportedChain(uint256 chainId) external onlyRole(GOVERNANCE_ROLE) {
        supportedChains[chainId] = false;
    }

    /// @notice 获取提案状态
    /// @param proposalId 提案ID
    /// @return state 提案状态
    function getProposalState(uint256 proposalId) external view returns (ProposalState state) {
        Proposal storage proposal = proposals[proposalId];
        
        if (proposal.executed) {
            return ProposalState.Executed;
        }
        
        if (proposal.canceled) {
            return ProposalState.Defeated;
        }
        
        if (block.timestamp < proposal.startTime) {
            return ProposalState.Pending;
        }
        
        if (block.timestamp > proposal.endTime) {
            uint256 totalVotes = proposal.forVotes + proposal.againstVotes + proposal.abstainVotes;
            if (totalVotes >= proposal.quorum && proposal.forVotes > proposal.againstVotes) {
                return ProposalState.Succeeded;
            } else {
                return ProposalState.Defeated;
            }
        }
        
        return ProposalState.Active;
    }

    /// @notice 获取用户投票信息
    /// @param proposalId 提案ID
    /// @param voter 投票者地址
    /// @return option 投票选项
    /// @return weight 投票权重
    /// @return timestamp 投票时间
    /// @return hasVoted 是否已投票
    function getUserVote(uint256 proposalId, address voter) external view returns (
        VoteOption option,
        uint256 weight,
        uint256 timestamp,
        bool hasVoted
    ) {
        Vote storage userVote = votes[proposalId][voter];
        return (userVote.option, userVote.weight, userVote.timestamp, userVote.hasVoted);
    }

    /// @notice 获取跨链投票信息
    /// @param proposalId 提案ID
    /// @param chainId 链ID
    /// @return forVotes 赞成票数
    /// @return againstVotes 反对票数
    /// @return abstainVotes 弃权票数
    /// @return totalWeight 总权重
    /// @return isVerified 是否已验证
    function getCrossChainVote(uint256 proposalId, uint256 chainId) external view returns (
        uint256 forVotes,
        uint256 againstVotes,
        uint256 abstainVotes,
        uint256 totalWeight,
        bool isVerified
    ) {
        CrossChainVote storage crossChainVote = crossChainVotes[proposalId][chainId];
        return (crossChainVote.forVotes, crossChainVote.againstVotes, crossChainVote.abstainVotes, crossChainVote.totalWeight, crossChainVote.isVerified);
    }

    /// @notice 计算法定人数
    /// @return quorum 法定人数
    function _calculateQuorum() internal view returns (uint256 quorum) {
        // 这里应该基于治理代币的总供应量计算
        // 简化版本，实际需要查询治理代币合约
        uint256 totalSupply = 1000000e18; // 假设总供应量
        return (totalSupply * quorumBPS) / 10000;
    }

    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal view override onlyRole(DEFAULT_ADMIN_ROLE) {
        // 防御式校验：避免升级到 EOA/零地址
        require(newImplementation.code.length > 0, "Invalid implementation");
    }

    // ============ Storage Gap ============
    uint256[50] private __gap;
} 