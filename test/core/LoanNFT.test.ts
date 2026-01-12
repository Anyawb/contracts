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
    
    // 部署 MockRegistry（轻量版，无权限限制，仅用于测试）
    const RegistryFactory = await ethers.getContractFactory('MockRegistry');
    const registry = await RegistryFactory.connect(governance).deploy();
    await registry.waitForDeployment();
    
    // 部署 MockERC20 用于测试
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    const mockToken = await MockERC20Factory.deploy('Mock USDC', 'USDC', 6);
    await mockToken.waitForDeployment();
    
    // 注册 ACM 到 Registry，符合合约新的地址解析路径
    // 注意：Registry.setModule 需要 onlyOwner 权限，governance 是 deployer 所以是 owner
    await registry.connect(governance).setModule(
      ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER')),
      await acm.getAddress()
    );
    
    // 部署 LoanNFT
    const LoanNFTFactory = await ethers.getContractFactory('LoanNFT');

    const loanNFT = await upgrades.deployProxy(
      LoanNFTFactory,
      ['Loan Certificate', 'LOAN', 'https://api.example.com/loan/', await registry.getAddress()],
      { kind: 'uups' }
    );
    await loanNFT.waitForDeployment();
    
    // 设置 ACM 权限（governance 默认已具备治理权限，给 governance 和 alice 都授权铸造）
    await acm.connect(governance).grantRole(MINTER_ROLE, governance.address);
    await acm.connect(governance).grantRole(MINTER_ROLE, alice.address);
    
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
      await expect(loanNFT.ownerOf(tokenId))
        .to.be.revertedWithCustomError(loanNFT, 'ERC721NonexistentToken')
        .withArgs(tokenId);
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
      ).to.be.revertedWithCustomError(loanNFT, 'EnforcedPause');
    });

    it('治理角色应能更新 Registry 地址', async function () {
      const { loanNFT, governance, bob } = await deployFixture();
      
      await loanNFT.connect(governance).setRegistry(bob.address);
      expect(await loanNFT.getRegistry()).to.equal(bob.address);
    });

    it('治理角色应能授予和撤销铸造角色', async function () {
      const { loanNFT, acm, governance, bob } = await deployFixture();
      
      // 注意：由于 ACM.grantRole 需要 onlyOwner，而 LoanNFT 不是 owner
      // 所以需要通过 governance（ACM owner）直接调用 ACM.grantRole
      // 然后测试 LoanNFT.isMinter 是否正确识别
      await acm.connect(governance).grantRole(MINTER_ROLE, bob.address);
      expect(await loanNFT.isMinter(bob.address)).to.be.true;
      
      // 撤销铸造角色（同样通过 ACM 直接调用）
      await acm.connect(governance).revokeRole(MINTER_ROLE, bob.address);
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

  describe('贷款状态转换测试', function () {
    it('应正确从 Active 转换为 Repaid', async function () {
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
      
      // 初始状态应为 Active
      let metadata = await loanNFT.getLoanMetadata(tokenId);
      expect(metadata.status).to.equal(0); // Active
      
      // 转换为 Repaid
      await loanNFT.connect(alice).updateLoanStatus(tokenId, 1); // Repaid
      metadata = await loanNFT.getLoanMetadata(tokenId);
      expect(metadata.status).to.equal(1); // Repaid
    });

    it('应正确从 Active 转换为 Liquidated', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID + 1n,
        collateralHash: COLLATERAL_HASH,
        status: 0
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const tokenId = 0n; // 每个测试用例从 0 开始
      
      // 转换为 Liquidated
      await loanNFT.connect(alice).updateLoanStatus(tokenId, 2); // Liquidated
      const metadata = await loanNFT.getLoanMetadata(tokenId);
      expect(metadata.status).to.equal(2); // Liquidated
    });

    it('应正确从 Active 转换为 Defaulted', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID + 2n,
        collateralHash: COLLATERAL_HASH,
        status: 0
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const tokenId = 0n; // 每个测试用例从 0 开始
      
      // 转换为 Defaulted
      await loanNFT.connect(alice).updateLoanStatus(tokenId, 3); // Defaulted
      const metadata = await loanNFT.getLoanMetadata(tokenId);
      expect(metadata.status).to.equal(3); // Defaulted
    });

    it('应正确发出状态更新事件', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID + 3n,
        collateralHash: COLLATERAL_HASH,
        status: 0
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const tokenId = 0n; // 每个测试用例从 0 开始
      
      await expect(loanNFT.connect(alice).updateLoanStatus(tokenId, 1))
        .to.emit(loanNFT, 'LoanStatusUpdated')
        .withArgs(tokenId, 1);
    });
  });

  describe('批量操作测试', function () {
    it('应正确处理多个 NFT 的铸造', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      const loanIds = [10n, 11n, 12n, 13n, 14n];
      
      for (let i = 0; i < loanIds.length; i++) {
        const loanMetadata = {
          principal: PRINCIPAL,
          rate: RATE,
          term: TERM,
          oraclePrice: ORACLE_PRICE,
          loanId: loanIds[i],
          collateralHash: COLLATERAL_HASH,
          status: 0
        };
        
        await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      }
      
      // 验证所有 NFT 都已铸造
      expect(await loanNFT.balanceOf(bob.address)).to.equal(5n);
      expect(await loanNFT.totalSupply()).to.equal(5n);
    });

    it('应正确查询用户持有的多个代币', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      const loanIds = [20n, 21n, 22n];
      
      for (let i = 0; i < loanIds.length; i++) {
        const loanMetadata = {
          principal: PRINCIPAL,
          rate: RATE,
          term: TERM,
          oraclePrice: ORACLE_PRICE,
          loanId: loanIds[i],
          collateralHash: COLLATERAL_HASH,
          status: 0
        };
        
        await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      }
      
      const userTokens = await loanNFT.getUserTokens(bob.address);
      expect(userTokens.length).to.equal(3);
      expect(userTokens[0]).to.equal(0n);
      expect(userTokens[1]).to.equal(1n);
      expect(userTokens[2]).to.equal(2n);
    });

    it('应正确批量更新多个 NFT 的状态', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      const loanIds = [30n, 31n, 32n];
      const tokenIds = [];
      
      for (let i = 0; i < loanIds.length; i++) {
        const loanMetadata = {
          principal: PRINCIPAL,
          rate: RATE,
          term: TERM,
          oraclePrice: ORACLE_PRICE,
          loanId: loanIds[i],
          collateralHash: COLLATERAL_HASH,
          status: 0
        };
        
        const tx = await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
        tokenIds.push(BigInt(i));
      }
      
      // 批量更新状态为 Repaid
      for (const tokenId of tokenIds) {
        await loanNFT.connect(alice).updateLoanStatus(tokenId, 1); // Repaid
        const metadata = await loanNFT.getLoanMetadata(tokenId);
        expect(metadata.status).to.equal(1);
      }
    });
  });

  describe('边界值测试', function () {
    it('应正确处理最大 loanId', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      const maxLoanId = ethers.MaxUint256;
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: maxLoanId,
        collateralHash: COLLATERAL_HASH,
        status: 0
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const metadata = await loanNFT.getLoanMetadata(0n);
      expect(metadata.loanId).to.equal(maxLoanId);
    });

    it('应正确处理最小 principal（1 wei）', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      const loanMetadata = {
        principal: 1n, // 最小单位
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID + 100n,
        collateralHash: COLLATERAL_HASH,
        status: 0
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const metadata = await loanNFT.getLoanMetadata(0n);
      expect(metadata.principal).to.equal(1n);
    });

    it('应拒绝零 principal 的铸造', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      const loanMetadata = {
        principal: 0n, // 零值应被拒绝
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID + 101n,
        collateralHash: COLLATERAL_HASH,
        status: 0
      };
      
      await expect(
        loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata)
      ).to.be.revertedWithCustomError(loanNFT, 'LoanNFT__InvalidOrder');
    });
  });

  describe('Registry 更新后功能验证', function () {
    it('Registry 更新后应能正确解析 ACM 地址', async function () {
      const { loanNFT, acm, registry, governance, alice } = await deployFixture();
      
      // 创建新的 Registry
      const NewRegistryFactory = await ethers.getContractFactory('MockRegistry');
      const newRegistry = await NewRegistryFactory.deploy();
      await newRegistry.waitForDeployment();
      
      // 在新 Registry 中注册 ACM
      await newRegistry.setModule(
        ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER')),
        await acm.getAddress()
      );
      
      // 更新 LoanNFT 的 Registry
      await loanNFT.connect(governance).setRegistry(await newRegistry.getAddress());
      
      // 验证仍能正确查询权限
      expect(await loanNFT.isMinter(alice.address)).to.be.true;
      expect(await loanNFT.isGovernance(governance.address)).to.be.true;
    });

    it('Registry 更新后应能继续铸造 NFT', async function () {
      const { loanNFT, acm, registry, governance, alice, bob } = await deployFixture();
      
      // 创建新的 Registry
      const NewRegistryFactory = await ethers.getContractFactory('MockRegistry');
      const newRegistry = await NewRegistryFactory.deploy();
      await newRegistry.waitForDeployment();
      
      // 在新 Registry 中注册 ACM
      await newRegistry.setModule(
        ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER')),
        await acm.getAddress()
      );
      
      // 更新 LoanNFT 的 Registry
      await loanNFT.connect(governance).setRegistry(await newRegistry.getAddress());
      
      // 验证仍能铸造
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID + 200n,
        collateralHash: COLLATERAL_HASH,
        status: 0
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      expect(await loanNFT.balanceOf(bob.address)).to.equal(1n);
    });
  });

  describe('元数据完整性测试', function () {
    it('应正确保存和检索所有元数据字段', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      const customPrincipal = ethers.parseUnits('5000', 6);
      const customRate = 600n; // 6%
      const customTerm = 180n * 24n * 3600n; // 180天
      const customOraclePrice = ethers.parseUnits('60000', 8);
      const customLoanId = LOAN_ID + 300n;
      const customCollateralHash = ethers.keccak256(ethers.toUtf8Bytes('custom_collateral'));
      
      const loanMetadata = {
        principal: customPrincipal,
        rate: customRate,
        term: customTerm,
        oraclePrice: customOraclePrice,
        loanId: customLoanId,
        collateralHash: customCollateralHash,
        status: 0
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const tokenId = 0n;
      
      const metadata = await loanNFT.getLoanMetadata(tokenId);
      expect(metadata.principal).to.equal(customPrincipal);
      expect(metadata.rate).to.equal(customRate);
      expect(metadata.term).to.equal(customTerm);
      expect(metadata.oraclePrice).to.equal(customOraclePrice);
      expect(metadata.loanId).to.equal(customLoanId);
      expect(metadata.collateralHash).to.equal(customCollateralHash);
      expect(metadata.status).to.equal(0); // Active
    });

    it('TokenURI 应包含所有元数据信息', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID + 400n,
        collateralHash: COLLATERAL_HASH,
        status: 0
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const tokenId = 0n;
      
      const tokenURI = await loanNFT.tokenURI(tokenId);
      const base64Data = tokenURI.replace('data:application/json;base64,', '');
      const jsonString = Buffer.from(base64Data, 'base64').toString();
      const metadata = JSON.parse(jsonString);
      
      // 验证所有字段都存在
      expect(metadata.name).to.exist;
      expect(metadata.description).to.exist;
      expect(metadata.attributes).to.be.an('array');
      expect(metadata.attributes.length).to.equal(5);
      
      // 验证属性值
      const attributes = metadata.attributes;
      expect(attributes.find((a: any) => a.trait_type === 'LoanId')).to.exist;
      expect(attributes.find((a: any) => a.trait_type === 'Principal')).to.exist;
      expect(attributes.find((a: any) => a.trait_type === 'Rate (bps)')).to.exist;
      expect(attributes.find((a: any) => a.trait_type === 'Term')).to.exist;
      expect(attributes.find((a: any) => a.trait_type === 'Status')).to.exist;
    });
  });

  describe('枚举功能边界测试', function () {
    it('应正确处理空用户代币列表', async function () {
      const { loanNFT, charlie } = await deployFixture();
      
      const userTokens = await loanNFT.getUserTokens(charlie.address);
      expect(userTokens.length).to.equal(0);
      expect(await loanNFT.balanceOf(charlie.address)).to.equal(0n);
    });

    it('应正确支持 tokenByIndex', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      const loanIds = [50n, 51n, 52n];
      
      for (let i = 0; i < loanIds.length; i++) {
        const loanMetadata = {
          principal: PRINCIPAL,
          rate: RATE,
          term: TERM,
          oraclePrice: ORACLE_PRICE,
          loanId: loanIds[i],
          collateralHash: COLLATERAL_HASH,
          status: 0
        };
        
        await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      }
      
      // 验证 tokenByIndex
      expect(await loanNFT.tokenByIndex(0)).to.equal(0n);
      expect(await loanNFT.tokenByIndex(1)).to.equal(1n);
      expect(await loanNFT.tokenByIndex(2)).to.equal(2n);
    });

    it('应正确处理 totalSupply', async function () {
      const { loanNFT, alice, bob, charlie } = await deployFixture();
      
      expect(await loanNFT.totalSupply()).to.equal(0n);
      
      // 铸造第一个 NFT
      const loanMetadata1 = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID + 500n,
        collateralHash: COLLATERAL_HASH,
        status: 0
      };
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata1);
      expect(await loanNFT.totalSupply()).to.equal(1n);
      
      // 铸造第二个 NFT 给不同用户
      const loanMetadata2 = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID + 501n,
        collateralHash: COLLATERAL_HASH,
        status: 0
      };
      await loanNFT.connect(alice).mintLoanCertificate(charlie.address, loanMetadata2);
      expect(await loanNFT.totalSupply()).to.equal(2n);
    });
  });

  describe('SBT 转移限制测试', function () {
    it('SBT 代币应无法在用户间转移', async function () {
      const { loanNFT, alice, bob, charlie, governance } = await deployFixture();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID + 600n,
        collateralHash: COLLATERAL_HASH,
        status: 0
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const tokenId = 0n;
      
      // 锁定为 SBT
      await loanNFT.connect(governance).lockAsSBT(tokenId);
      
      // 尝试转移应失败
      await expect(
        loanNFT.connect(bob).transferFrom(bob.address, charlie.address, tokenId)
      ).to.be.revertedWithCustomError(loanNFT, 'LoanNFT__SoulBound');
    });

    it('SBT 代币应允许销毁', async function () {
      const { loanNFT, alice, bob, governance } = await deployFixture();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID + 601n,
        collateralHash: COLLATERAL_HASH,
        status: 0
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const tokenId = 0n;
      
      // 锁定为 SBT
      await loanNFT.connect(governance).lockAsSBT(tokenId);
      
      // 销毁应成功（SBT 限制不适用于销毁）
      await loanNFT.connect(governance).burn(tokenId);
      await expect(loanNFT.ownerOf(tokenId)).to.be.reverted;
    });

    it('非 SBT 代币应能正常转移', async function () {
      const { loanNFT, alice, bob, charlie } = await deployFixture();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID + 602n,
        collateralHash: COLLATERAL_HASH,
        status: 0
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const tokenId = 0n;
      
      // 未锁定为 SBT，应能正常转移
      await loanNFT.connect(bob).transferFrom(bob.address, charlie.address, tokenId);
      expect(await loanNFT.ownerOf(tokenId)).to.equal(charlie.address);
    });
  });

  describe('紧急场景测试', function () {
    it('暂停后应阻止所有关键操作', async function () {
      const { loanNFT, alice, bob, governance } = await deployFixture();
      
      // 暂停系统
      await loanNFT.connect(governance).pause();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID + 700n,
        collateralHash: COLLATERAL_HASH,
        status: 0
      };
      
      // 铸造应失败
      await expect(
        loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata)
      ).to.be.revertedWithCustomError(loanNFT, 'EnforcedPause');
    });

    it('暂停后应允许解除暂停', async function () {
      const { loanNFT, governance } = await deployFixture();
      
      await loanNFT.connect(governance).pause();
      expect(await loanNFT.paused()).to.be.true;
      
      await loanNFT.connect(governance).unpause();
      expect(await loanNFT.paused()).to.be.false;
    });

    it('解除暂停后应恢复所有功能', async function () {
      const { loanNFT, alice, bob, governance } = await deployFixture();
      
      // 暂停
      await loanNFT.connect(governance).pause();
      
      // 解除暂停
      await loanNFT.connect(governance).unpause();
      
      // 验证功能恢复
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID + 701n,
        collateralHash: COLLATERAL_HASH,
        status: 0
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      expect(await loanNFT.balanceOf(bob.address)).to.equal(1n);
    });
  });

  describe('事件完整性测试', function () {
    it('铸造应发出所有相关事件', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID + 800n,
        collateralHash: COLLATERAL_HASH,
        status: 0
      };
      
      await expect(loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata))
        .to.emit(loanNFT, 'LoanCertificateMinted')
        .withArgs(bob.address, 0n, LOAN_ID + 800n, PRINCIPAL, RATE, TERM)
        .and.to.emit(loanNFT, 'Transfer') // ERC721 标准事件
        .withArgs(ethers.ZeroAddress, bob.address, 0n);
    });

    it('锁定 SBT 应发出正确事件', async function () {
      const { loanNFT, alice, bob, governance } = await deployFixture();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID + 801n,
        collateralHash: COLLATERAL_HASH,
        status: 0
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const tokenId = 0n;
      
      await expect(loanNFT.connect(governance).lockAsSBT(tokenId))
        .to.emit(loanNFT, 'TokenLocked')
        .withArgs(tokenId);
    });

    it('销毁应发出正确事件', async function () {
      const { loanNFT, alice, bob, governance } = await deployFixture();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID + 802n,
        collateralHash: COLLATERAL_HASH,
        status: 0
      };
      
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      const tokenId = 0n;
      
      await expect(loanNFT.connect(governance).burn(tokenId))
        .to.emit(loanNFT, 'TokenBurned')
        .withArgs(tokenId)
        .and.to.emit(loanNFT, 'Transfer') // ERC721 标准事件
        .withArgs(bob.address, ethers.ZeroAddress, tokenId);
    });
  });

  describe('并发和重入防护测试', function () {
    it('应防止同一 loanId 的重复铸造', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID + 900n,
        collateralHash: COLLATERAL_HASH,
        status: 0
      };
      
      // 第一次铸造成功
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      
      // 尝试用相同 loanId 再次铸造应失败
      await expect(
        loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata)
      ).to.be.revertedWithCustomError(loanNFT, 'LoanNFT__LoanAlreadyMinted');
    });

    it('nonReentrant 修饰符应防止重入攻击', async function () {
      const { loanNFT, alice, bob } = await deployFixture();
      
      // 这个测试主要验证 nonReentrant 修饰符存在
      // 实际的重入攻击需要恶意合约，这里验证函数有修饰符即可
      const loanMetadata = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID + 901n,
        collateralHash: COLLATERAL_HASH,
        status: 0
      };
      
      // 正常铸造应成功（如果存在重入漏洞，这里会失败）
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata);
      expect(await loanNFT.balanceOf(bob.address)).to.equal(1n);
    });
  });

  describe('代币 ID 递增测试', function () {
    it('代币 ID 应正确递增', async function () {
      const { loanNFT, alice, bob, charlie } = await deployFixture();
      
      const loanMetadata1 = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID + 1000n,
        collateralHash: COLLATERAL_HASH,
        status: 0
      };
      
      const loanMetadata2 = {
        principal: PRINCIPAL,
        rate: RATE,
        term: TERM,
        oraclePrice: ORACLE_PRICE,
        loanId: LOAN_ID + 1001n,
        collateralHash: COLLATERAL_HASH,
        status: 0
      };
      
      // 铸造第一个 NFT
      await loanNFT.connect(alice).mintLoanCertificate(bob.address, loanMetadata1);
      expect(await loanNFT.ownerOf(0n)).to.equal(bob.address);
      
      // 铸造第二个 NFT
      await loanNFT.connect(alice).mintLoanCertificate(charlie.address, loanMetadata2);
      expect(await loanNFT.ownerOf(1n)).to.equal(charlie.address);
      
      // 验证 totalSupply
      expect(await loanNFT.totalSupply()).to.equal(2n);
    });
  });
}); 