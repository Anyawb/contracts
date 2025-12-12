import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers, upgrades } = hardhat;

import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
// ContractTransactionReceipt 类型已移除，因为未使用

/**
 * LoanNFT 测试模块
 * 
 * 测试目标:
 * - ACM 权限控制集成
 * - NFT 铸造和销毁功能
 * - SBT 锁定功能
 * - 贷款状态管理
 * - 用户代币查询
 * - 升级和暂停功能
 * - 事件记录验证
 */
describe('LoanNFT – ACM 集成测试', function () {
  // 常量定义
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  // const ONE_ETH = ethers.parseUnits('1', 18); // 未使用，已注释
  // const ONE_USD = ethers.parseUnits('1', 6); // 未使用，已注释
  
  // 角色定义 - 使用 ActionKeys 中定义的角色
  const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('BORROW')); // 使用借款权限作为铸造权限
  const GOVERNANCE_ROLE = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER')); // 使用设置参数权限作为治理权限
  
  // 添加调试信息来验证角色哈希值
  console.log('MINTER_ROLE hash:', MINTER_ROLE);
  console.log('GOVERNANCE_ROLE hash:', GOVERNANCE_ROLE);
  
  // 测试数据
  const LOAN_ID = 1n;
  const PRINCIPAL = ethers.parseUnits('1000', 6); // 1000 USDC
  const RATE = 500n; // 5% 年化利率
  const TERM = 365n * 24n * 3600n; // 1年
  const ORACLE_PRICE = ethers.parseUnits('50000', 8); // $50,000
  const COLLATERAL_HASH = ethers.keccak256(ethers.toUtf8Bytes('test_collateral'));

  async function deployFixture() {
    const [governance, alice, bob, charlie]: SignerWithAddress[] = await ethers.getSigners();
    
    // 部署 ACM
    const ACMFactory = await ethers.getContractFactory('AccessControlManager');
    const acm = await ACMFactory.connect(governance).deploy(governance.address);
    await acm.waitForDeployment();
    
    // 部署 Registry
    const RegistryFactory = await ethers.getContractFactory('Registry');
    const registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();
    
    // 部署 MockERC20 用于测试
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    const mockToken = await MockERC20Factory.deploy('Mock USDC', 'USDC', 6);
    await mockToken.waitForDeployment();
    
    // 部署 LoanNFT
    const LoanNFTFactory = await ethers.getContractFactory('LoanNFT');
    const loanNFT = await upgrades.deployProxy(
      LoanNFTFactory,
      ['Loan Certificate', 'LOAN', 'https://api.example.com/loan/', await registry.getAddress(), await acm.getAddress()],
      { kind: 'uups' }
    );
    await loanNFT.waitForDeployment();
    
    // 设置 ACM 权限
    await acm.connect(governance).grantRole(GOVERNANCE_ROLE, governance.address);
    await acm.connect(governance).grantRole(MINTER_ROLE, governance.address);
    await acm.connect(governance).grantRole(MINTER_ROLE, alice.address);
    
    // 为 LoanNFT 合约授予 OWNER 权限，使其能够调用 ACM 的 grantRole 函数
    await acm.connect(governance).setUserPermission(await loanNFT.getAddress(), 4); // PermissionLevel.ADMIN
    await acm.connect(governance).setUserPermission(await loanNFT.getAddress(), 5); // PermissionLevel.OWNER
    
    return { 
      loanNFT, 
      acm, 
      registry, 
      mockToken, 
      governance, 
      alice, 
      bob, 
      charlie 
    };
  }

  describe('初始化测试', function () {
    it('应正确初始化合约', async function () {
      const { loanNFT, acm, registry } = await deployFixture();
      
      expect(await loanNFT.name()).to.equal('Loan Certificate');
      expect(await loanNFT.symbol()).to.equal('LOAN');
      expect(await loanNFT.getRegistry()).to.equal(await registry.getAddress());
      expect(await loanNFT.getACM()).to.equal(await acm.getAddress());
    });

    it('应正确设置 ACM 权限', async function () {
      const { loanNFT, acm, governance, alice } = await deployFixture();
      
      // 调试信息
      console.log('Governance address:', governance.address);
      console.log('Alice address:', alice.address);
      console.log('Governance is governance:', await loanNFT.isGovernance(governance.address));
      console.log('Governance is minter:', await loanNFT.isMinter(governance.address));
      console.log('Alice is minter:', await loanNFT.isMinter(alice.address));
      console.log('Alice is governance:', await loanNFT.isGovernance(alice.address));
      
      // 直接检查 ACM 中的角色
      console.log('Governance has MINTER_ROLE in ACM:', await acm.hasRole(MINTER_ROLE, governance.address));
      console.log('Alice has MINTER_ROLE in ACM:', await acm.hasRole(MINTER_ROLE, alice.address));
      console.log('Governance has GOVERNANCE_ROLE in ACM:', await acm.hasRole(GOVERNANCE_ROLE, governance.address));
      
      // 检查 LoanNFT 中的 ACM 地址
      console.log('LoanNFT ACM address:', await loanNFT.getACM());
      console.log('Actual ACM address:', await acm.getAddress());
      
      // 直接调用 ACM 的 hasRole 函数
      const acmAddress = await loanNFT.getACM();
      const acmContract = await ethers.getContractAt('AccessControlManager', acmAddress);
      console.log('Direct ACM call - Governance has MINTER_ROLE:', await acmContract.hasRole(MINTER_ROLE, governance.address));
      console.log('Direct ACM call - Alice has MINTER_ROLE:', await acmContract.hasRole(MINTER_ROLE, alice.address));
      
      expect(await loanNFT.isGovernance(governance.address)).to.be.true;
      expect(await loanNFT.isMinter(governance.address)).to.be.true;
      expect(await loanNFT.isMinter(alice.address)).to.be.true;
      expect(await loanNFT.isGovernance(alice.address)).to.be.false;
    });
  });

  describe('ACM 权限控制测试', function () {
    it('非铸造者应无法铸造 NFT', async function () {
      const { loanNFT, acm, bob } = await deployFixture();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID,
        collateralHash: COLLATERAL_HASH,
        status: 0 // Active
      };
      
      await expect(
        loanNFT.connect(bob).mintLoanCertificate(bob.address, loanMetadata)
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('非治理角色应无法暂停系统', async function () {
      const { loanNFT, acm, bob } = await deployFixture();
      
      await expect(
        loanNFT.connect(bob).pause()
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('非治理角色应无法更新 Registry', async function () {
      const { loanNFT, acm, bob } = await deployFixture();
      
      await expect(
        loanNFT.connect(bob).setRegistry(bob.address)
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('非治理角色应无法更新 ACM', async function () {
      const { loanNFT, acm, bob } = await deployFixture();
      
      await expect(
        loanNFT.connect(bob).setACM(bob.address)
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('非治理角色应无法锁定 SBT', async function () {
      const { loanNFT, acm, alice, bob } = await deployFixture();
      
      // 先铸造一个 NFT
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID,
        collateralHash: COLLATERAL_HASH,
        status: 0 // Active
      };
      
      const tx = await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Transaction failed');
      
      const tokenId = 0n; // 第一个 NFT
      
      await expect(
        loanNFT.connect(bob).lockAsSBT(tokenId)
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });
  });

  describe('NFT 铸造功能测试', function () {
    it('应正确铸造贷款 NFT', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID,
        collateralHash: COLLATERAL_HASH,
        status: 0 // Active
      };
      
      const tx = await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Transaction failed');
      
      expect(await loanNFT.ownerOf(0)).to.equal(bob.address);
      expect(await loanNFT.balanceOf(bob.address)).to.equal(1n);
      
      // 验证元数据
      const metadata = await loanNFT.getLoanMetadata(0);
      expect(metadata.principal).to.equal(PRINCIPAL);
      expect(metadata.rate).to.equal(RATE);
      expect(metadata.term).to.equal(TERM);
      expect(metadata.oraclePrice).to.equal(ORACLE_PRICE);
      expect(metadata.loanId).to.equal(LOAN_ID);
      expect(metadata.collateralHash).to.equal(COLLATERAL_HASH);
      expect(metadata.status).to.equal(0); // Active
    });

    it('应防止重复铸造相同 loanId', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID,
        collateralHash: COLLATERAL_HASH,
        status: 0 // Active
      };
      
      // 第一次铸造
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      
      // 第二次铸造相同 loanId 应失败
      await expect(
        loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata)
      ).to.be.revertedWithCustomError(loanNFT, 'LoanNFT__LoanAlreadyMinted');
    });

    it('应正确记录铸造事件', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID,
        collateralHash: COLLATERAL_HASH,
        status: 0 // Active
      };
      
      const tx = await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Transaction failed');
      
      // 验证 LoanCertificateMinted 事件
      const mintEvent = receipt.logs.find(log => {
        try {
          const parsed = loanNFT.interface.parseLog(log);
          return parsed?.name === 'LoanCertificateMinted';
        } catch {
          return false;
        }
      });
      
      expect(mintEvent).to.not.be.undefined;
      
      // 验证 ActionExecuted 事件
      const actionEvent = receipt.logs.find(log => {
        try {
          const parsed = loanNFT.interface.parseLog(log);
          return parsed?.name === 'ActionExecuted';
        } catch {
          return false;
        }
      });
      
      expect(actionEvent).to.not.be.undefined;
    });
  });

  describe('SBT 锁定功能测试', function () {
    it('治理角色应能锁定 NFT 为 SBT', async function () {
      const { loanNFT, alice, governance, bob } = await deployFixture();
      
      // 先铸造一个 NFT
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID,
        collateralHash: COLLATERAL_HASH,
        status: 0 // Active
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const tokenId = 0n;
      
      // 锁定为 SBT
      const tx = await loanNFT.connect(governance).lockAsSBT(tokenId);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Transaction failed');
      
      // 验证锁定后无法转移
      await expect(
        loanNFT.connect(bob).transferFrom(bob.address, alice.address, tokenId)
      ).to.be.revertedWithCustomError(loanNFT, 'LoanNFT__SoulBound');
    });

    it('应正确记录 SBT 锁定事件', async function () {
      const { loanNFT, alice, governance, bob } = await deployFixture();
      
      // 先铸造一个 NFT
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID,
        collateralHash: COLLATERAL_HASH,
        status: 0 // Active
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const tokenId = 0n;
      
      // 锁定为 SBT
      const tx = await loanNFT.connect(governance).lockAsSBT(tokenId);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Transaction failed');
      
      // 验证 TokenLocked 事件
      const lockEvent = receipt.logs.find(log => {
        try {
          const parsed = loanNFT.interface.parseLog(log);
          return parsed?.name === 'TokenLocked';
        } catch {
          return false;
        }
      });
      
      expect(lockEvent).to.not.be.undefined;
    });
  });

  describe('NFT 销毁功能测试', function () {
    it('治理角色应能销毁 NFT', async function () {
      const { loanNFT, alice, governance, bob } = await deployFixture();
      
      // 先铸造一个 NFT
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID,
        collateralHash: COLLATERAL_HASH,
        status: 0 // Active
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const tokenId = 0n;
      
      // 销毁 NFT
      const tx = await loanNFT.connect(governance).burn(tokenId);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Transaction failed');
      
      // 验证 NFT 已被销毁
      await expect(loanNFT.ownerOf(tokenId)).to.be.revertedWith('ERC721: invalid token ID');
      expect(await loanNFT.balanceOf(bob.address)).to.equal(0n);
    });

    it('应正确记录销毁事件', async function () {
      const { loanNFT, alice, governance, bob } = await deployFixture();
      
      // 先铸造一个 NFT
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID,
        collateralHash: COLLATERAL_HASH,
        status: 0 // Active
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const tokenId = 0n;
      
      // 销毁 NFT
      const tx = await loanNFT.connect(governance).burn(tokenId);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Transaction failed');
      
      // 验证 TokenBurned 事件
      const burnEvent = receipt.logs.find(log => {
        try {
          const parsed = loanNFT.interface.parseLog(log);
          return parsed?.name === 'TokenBurned';
        } catch {
          return false;
        }
      });
      
      expect(burnEvent).to.not.be.undefined;
    });
  });

  describe('贷款状态管理测试', function () {
    it('铸造者应能更新贷款状态', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID,
        collateralHash: COLLATERAL_HASH,
        status: 0 // Active
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const tokenId = 0n;
      
      // 更新状态
      await loanNFT.connect(alice).updateLoanStatus(tokenId, 1);
      const metadata = await loanNFT.getLoanMetadata(tokenId);
      expect(metadata.status).to.equal(1);
    });

    it('非铸造者应无法更新贷款状态', async function () {
      const { loanNFT, alice, bob, charlie, acm } = await deployFixture();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID,
        collateralHash: COLLATERAL_HASH,
        status: 0 // Active
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const tokenId = 0n;
      
      // 非铸造者尝试更新状态
      await expect(
        loanNFT.connect(charlie).updateLoanStatus(tokenId, 1)
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });
  });

  describe('用户代币查询测试', function () {
    it('应正确返回用户持有的代币', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      // 铸造多个 NFT 给同一个用户
      const loanMetadata1 = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID,
        collateralHash: COLLATERAL_HASH,
        status: 0 // Active
      };
      
      const loanMetadata2 = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID + 1n,
        collateralHash: COLLATERAL_HASH,
        status: 0 // Active
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata1);
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata2);
      
      // 查询用户代币
      const userTokens = await loanNFT.getUserTokens(bob.address);
      expect(userTokens.length).to.equal(2);
      expect(userTokens[0]).to.equal(0n);
      expect(userTokens[1]).to.equal(1n);
    });
  });

  describe('系统管理功能测试', function () {
    it('治理角色应能暂停和恢复系统', async function () {
      const { loanNFT, governance } = await deployFixture();
      
      // 暂停系统
      await loanNFT.connect(governance).pause();
      expect(await loanNFT.paused()).to.be.true;
      
      // 恢复系统
      await loanNFT.connect(governance).unpause();
      expect(await loanNFT.paused()).to.be.false;
    });

    it('暂停时铸造应失败', async function () {
      const { loanNFT, alice, governance, bob } = await deployFixture();
      
      // 暂停系统
      await loanNFT.connect(governance).pause();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID,
        collateralHash: COLLATERAL_HASH,
        status: 0 // Active
      };
      
      await expect(
        loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata)
      ).to.be.revertedWith('Pausable: paused');
    });

    it('治理角色应能更新 Registry 地址', async function () {
      const { loanNFT, governance, bob } = await deployFixture();
      
      await loanNFT.connect(governance).setRegistry(bob.address);
      expect(await loanNFT.getRegistry()).to.equal(bob.address);
    });

    it('治理角色应能更新 ACM 地址', async function () {
      const { loanNFT, governance, bob } = await deployFixture();
      
      await loanNFT.connect(governance).setACM(bob.address);
      expect(await loanNFT.getACM()).to.equal(bob.address);
    });

    it('治理角色应能授予和撤销铸造角色', async function () {
      const { loanNFT, governance, bob } = await deployFixture();
      
      // 授予铸造角色
      await loanNFT.connect(governance).grantMinterRole(bob.address);
      expect(await loanNFT.isMinter(bob.address)).to.be.true;
      
      // 撤销铸造角色
      await loanNFT.connect(governance).revokeMinterRole(bob.address);
      expect(await loanNFT.isMinter(bob.address)).to.be.false;
    });
  });

  describe('Token URI 测试', function () {
    it('应返回正确的 Token URI', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID,
        collateralHash: COLLATERAL_HASH,
        status: 0 // Active
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const tokenId = 0n;
      
      const tokenURI = await loanNFT.tokenURI(tokenId);
      expect(tokenURI).to.include('data:application/json;base64,');
      
      // 解码 base64 数据
      const base64Data = tokenURI.replace('data:application/json;base64,', '');
      const jsonString = Buffer.from(base64Data, 'base64').toString();
      const metadata = JSON.parse(jsonString);
      
      expect(metadata.name).to.equal('Loan #0');
      expect(metadata.description).to.equal('Loan Certificate NFT');
      expect(metadata.attributes).to.be.an('array');
      expect(metadata.attributes.length).to.equal(5);
    });
  });

  describe('错误处理测试', function () {
    it('应正确处理无效 tokenId', async function () {
      const { loanNFT } = await deployFixture();
      
      await expect(
        loanNFT.getLoanMetadata(999)
      ).to.be.revertedWithCustomError(loanNFT, 'LoanNFT__InvalidTokenId');
      
      await expect(
        loanNFT.tokenURI(999)
      ).to.be.revertedWithCustomError(loanNFT, 'LoanNFT__InvalidTokenId');
    });

    it('应正确处理零地址参数', async function () {
      const { loanNFT, alice } = await deployFixture();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID,
        collateralHash: COLLATERAL_HASH,
        status: 0 // Active
      };
      
      await expect(
        loanNFT.connect(alice).mintLoanCertificate(ZERO_ADDRESS, loanMetadata)
      ).to.be.revertedWithCustomError(loanNFT, 'ZeroAddress');
    });
  });

  describe('接口兼容性测试', function () {
    it('应正确支持 ERC721 接口', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID,
        collateralHash: COLLATERAL_HASH,
        status: 0 // Active
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const tokenId = 0n;
      
      // 测试 ERC721 标准函数
      expect(await loanNFT.ownerOf(tokenId)).to.equal(bob.address);
      expect(await loanNFT.balanceOf(bob.address)).to.equal(1n);
      expect(await loanNFT.tokenOfOwnerByIndex(bob.address, 0)).to.equal(tokenId);
      expect(await loanNFT.totalSupply()).to.equal(1n);
    });

    it('应正确支持 ERC721Enumerable 接口', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID,
        collateralHash: COLLATERAL_HASH,
        status: 0 // Active
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      
      // 测试 ERC721Enumerable 函数
      expect(await loanNFT.totalSupply()).to.equal(1n);
      expect(await loanNFT.tokenByIndex(0)).to.equal(0n);
      expect(await loanNFT.tokenOfOwnerByIndex(bob.address, 0)).to.equal(0n);
    });
  });

  describe('调试测试', function () {
    it('直接验证 ACM 角色检查', async function () {
      const { loanNFT, acm, governance, alice } = await deployFixture();
      
      // 直接检查 ACM 中的角色
      const governanceHasMinterRole = await acm.hasRole(MINTER_ROLE, governance.address);
      const aliceHasMinterRole = await acm.hasRole(MINTER_ROLE, alice.address);
      const governanceHasGovernanceRole = await acm.hasRole(GOVERNANCE_ROLE, governance.address);
      
      console.log('Direct ACM calls:');
      console.log('  governanceHasMinterRole:', governanceHasMinterRole);
      console.log('  aliceHasMinterRole:', aliceHasMinterRole);
      console.log('  governanceHasGovernanceRole:', governanceHasGovernanceRole);
      
      // 通过 LoanNFT 检查角色
      const loanNFTGovernanceIsMinter = await loanNFT.isMinter(governance.address);
      const loanNFTAliceIsMinter = await loanNFT.isMinter(alice.address);
      const loanNFTGovernanceIsGovernance = await loanNFT.isGovernance(governance.address);
      
      console.log('LoanNFT calls:');
      console.log('  loanNFTGovernanceIsMinter:', loanNFTGovernanceIsMinter);
      console.log('  loanNFTAliceIsMinter:', loanNFTAliceIsMinter);
      console.log('  loanNFTGovernanceIsGovernance:', loanNFTGovernanceIsGovernance);
      
      // 验证结果应该一致
      expect(governanceHasMinterRole).to.equal(loanNFTGovernanceIsMinter);
      expect(aliceHasMinterRole).to.equal(loanNFTAliceIsMinter);
      expect(governanceHasGovernanceRole).to.equal(loanNFTGovernanceIsGovernance);
    });
  });
}); 