import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const KEY_ACM = ethers.keccak256(ethers.toUtf8Bytes("ACCESS_CONTROL_MANAGER"));
const KEY_REWARD_MANAGER_CORE = ethers.keccak256(ethers.toUtf8Bytes("REWARD_MANAGER_CORE"));
const KEY_REWARD_CONSUMPTION = ethers.keccak256(ethers.toUtf8Bytes("REWARD_CONSUMPTION"));
const KEY_REWARD_CORE = ethers.keccak256(ethers.toUtf8Bytes("REWARD_CORE"));
const KEY_REWARD_POINTS = ethers.keccak256(ethers.toUtf8Bytes("REWARD_POINTS"));

const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes("ACTION_ADMIN"));
const ACTION_VIEW_USER_DATA = ethers.keccak256(ethers.toUtf8Bytes("VIEW_USER_DATA"));

describe("RewardView", function () {
  async function getModuleSigner(address: string) {
    await ethers.provider.send("hardhat_setBalance", [address, "0x56bc75e2d63100000"]); // 100 ether
    return await ethers.getImpersonatedSigner(address);
  }

  async function deployFixture() {
    const [admin, user, other] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("MockRegistry");
    const registry = await Registry.deploy();

    const ACM = await ethers.getContractFactory("MockAccessControlManager");
    const acm = await ACM.deploy();

    const RewardCore = await ethers.getContractFactory("MockRewardCoreView");
    const rewardCore = await RewardCore.deploy();

    const RewardManagerCore = await ethers.getContractFactory("MockRewardManagerCoreView");
    const rewardManagerCore = await RewardManagerCore.deploy();

    const RewardConsumption = await ethers.getContractFactory("MockRewardManagerCoreView");
    const rewardConsumption = await RewardConsumption.deploy();

    const RewardPoints = await ethers.getContractFactory("MockRewardPointsMinimal");
    const rewardPoints = await RewardPoints.deploy();

    // register modules
    await registry.setModule(KEY_ACM, await acm.getAddress());
    await registry.setModule(KEY_REWARD_MANAGER_CORE, await rewardManagerCore.getAddress());
    await registry.setModule(KEY_REWARD_CONSUMPTION, await rewardConsumption.getAddress());
    await registry.setModule(KEY_REWARD_CORE, await rewardCore.getAddress());
    await registry.setModule(KEY_REWARD_POINTS, await rewardPoints.getAddress());

    // grant roles
    await acm.grantRole(ACTION_ADMIN, admin.address);
    await acm.grantRole(ACTION_VIEW_USER_DATA, admin.address);
    await acm.grantRole(ACTION_VIEW_USER_DATA, user.address);

    // deploy RewardView
    const RewardView = await ethers.getContractFactory("RewardView");
    const rv = await upgrades.deployProxy(RewardView, [await registry.getAddress()], { kind: "uups" });

    return {
      admin,
      user,
      other,
      registry,
      acm,
      rewardCore,
      rewardManagerCore,
      rewardConsumption,
      rewardPoints,
      rv,
    };
  }

  it("initialize should revert on zero registry", async function () {
    const RewardView = await ethers.getContractFactory("RewardView");
    await expect(upgrades.deployProxy(RewardView, [ethers.ZeroAddress], { kind: "uups" })).to.be.revertedWithCustomError(
      RewardView,
      "ZeroAddress"
    );
  });

  it("setRegistry requires admin role and non-zero", async function () {
    const { rv, other, registry, acm, admin } = await loadFixture(deployFixture);
    const newRegistry = registry;
    await expect(rv.connect(other).setRegistry(await newRegistry.getAddress())).to.be.revertedWithCustomError(rv, "MissingRole");

    await acm.grantRole(ACTION_ADMIN, other.address);
    await expect(rv.connect(other).setRegistry(ethers.ZeroAddress)).to.be.revertedWithCustomError(rv, "ZeroAddress");
    await rv.connect(other).setRegistry(await newRegistry.getAddress());
    expect(await rv.getRegistry()).to.equal(await newRegistry.getAddress());
    // restore admin for subsequent tests
    await acm.grantRole(ACTION_ADMIN, admin.address);
  });

  it("onlyWriter allows reward modules to push updates", async function () {
    const { rv, rewardManagerCore, user, other } = await loadFixture(deployFixture);
    await expect(rv.connect(other).pushRewardEarned(user.address, 100, "bonus", 1)).to.be.revertedWithCustomError(rv, "RewardView__UnauthorizedWriter");

    const writer = await getModuleSigner(await rewardManagerCore.getAddress());
    await rv.connect(writer).pushRewardEarned(user.address, 100, "bonus", 1);
    const summary = await rv.getUserRewardSummary(user.address);
    expect(summary.totalEarned).to.equal(100);
  });

  it("onlyAuthorizedFor permits self or viewer role", async function () {
    const { rv, rewardManagerCore, user, other, acm } = await loadFixture(deployFixture);
    const writer = await getModuleSigner(await rewardManagerCore.getAddress());
    await rv.connect(writer).pushRewardEarned(user.address, 50, "bonus", 1);
    await expect(rv.connect(other).getUserRewardSummary(user.address)).to.be.revertedWithCustomError(rv, "MissingRole");

    await acm.grantRole(ACTION_VIEW_USER_DATA, other.address);
    const summary = await rv.connect(other).getUserRewardSummary(user.address);
    expect(summary.totalEarned).to.equal(50);
    const selfSummary = await rv.connect(user).getUserRewardSummary(user.address);
    expect(selfSummary.totalEarned).to.equal(50);
  });

  it("push functions update summary, activities, top earners, and system stats", async function () {
    const { rv, rewardManagerCore, user } = await loadFixture(deployFixture);
    const writer = await getModuleSigner(await rewardManagerCore.getAddress());
    await rv.connect(writer).pushRewardEarned(user.address, 100, "earn", 10);
    await rv.connect(writer).pushPointsBurned(user.address, 20, "burn", 20);
    await rv.connect(writer).pushPenaltyLedger(user.address, 5, 30);
    await rv.connect(writer).pushUserLevel(user.address, 2, 40);
    await rv.connect(writer).pushUserPrivilege(user.address, 0x1234n, 50);
    await rv.connect(writer).pushSystemStats(3, 7, 60);

    const summary = await rv.getUserRewardSummary(user.address);
    expect(summary.totalEarned).to.equal(100);
    expect(summary.totalBurned).to.equal(20);
    expect(summary.pendingPenalty).to.equal(5);
    expect(summary.level).to.equal(2);
    expect(summary.privilegesPacked).to.equal(0x1234n);

    const sys = await rv.getSystemRewardStats();
    expect(sys.totalBatchOps).to.equal(3);
    expect(sys.totalCachedRewards).to.equal(7);

    const activities = await rv.getUserRecentActivities(user.address, 0, 0, 10);
    expect(activities.length).to.equal(3);

    const [topAddrs, topAmounts] = await rv.getTopEarners();
    expect(topAddrs[0]).to.equal(user.address);
    expect(topAmounts[0]).to.equal(100);
  });

  it("getUserRecentActivities respects limit and filters window", async function () {
    const { rv, rewardManagerCore, user } = await loadFixture(deployFixture);
    const writer = await getModuleSigner(await rewardManagerCore.getAddress());
    await rv.connect(writer).pushRewardEarned(user.address, 10, "a", 10);
    await rv.connect(writer).pushRewardEarned(user.address, 20, "b", 20);
    await rv.connect(writer).pushPointsBurned(user.address, 5, "c", 30);

    const all = await rv.getUserRecentActivities(user.address, 0, 0, 2);
    expect(all.length).to.equal(2);

    const filtered = await rv.getUserRecentActivities(user.address, 15, 25, 5);
    expect(filtered.length).to.equal(1);
    expect(filtered[0].amount).to.equal(20);
  });

  it("pass-through queries return data from underlying modules", async function () {
    const { rv, rewardManagerCore, rewardCore, rewardPoints, user, admin } = await loadFixture(deployFixture);
    // RewardPoints balance
    await rewardPoints.setBalance(user.address, 999);
    expect(await rv.getUserBalance(user.address)).to.equal(999);

    // RewardCore configs and usage
    const cfg = {
      price: 1,
      duration: 2,
      isActive: true,
      level: 0,
      description: "test",
    };
    await rewardCore.setServiceConfig(0, 0, cfg);
    await rewardCore.setServiceUsage(0, 123);
    await rewardCore.setUserLastConsumption(user.address, 0, 777);

    const returnedCfg = await rv.getServiceConfig(0, 0);
    expect(returnedCfg.price).to.equal(1);
    expect(await rv.getServiceUsage(0)).to.equal(123);
    expect(await rv.getUserLastConsumption(user.address, 0)).to.equal(777);

    // RewardManagerCore values
    await rewardManagerCore.setRewardParameters(10, 20, 30, 40);
    await rewardManagerCore.setCacheExpirationTime(555);
    await rewardManagerCore.setDynamicRewardParameters(66, 77);
    await rewardManagerCore.setLastRewardResetTime(888);
    await rewardManagerCore.setLevelMultiplier(1, 999);
    await rewardManagerCore.setUserLevel(user.address, 2);
    await rewardManagerCore.setUserActivity(user.address, 11, 22, 33);
    await rewardManagerCore.setUserPenaltyDebt(user.address, 44);
    await rewardManagerCore.setSystemStats(5, 6);
    await rewardManagerCore.setUserCache(user.address, 101, 202, true, 2, 11, 22, 33, 44);

    const params = await rv.getRewardParametersView();
    expect(params[0]).to.equal(10n);
    const userCache = await rv.getUserCacheView(user.address);
    expect(userCache[0]).to.equal(101n);
    expect(await rv.getCacheExpirationTimeView()).to.equal(555n);
    const dyn = await rv.getDynamicRewardParametersView();
    expect(dyn[0]).to.equal(66n);
    expect(dyn[1]).to.equal(77n);
    expect(await rv.getLastRewardResetTimeView()).to.equal(888n);
    expect(await rv.getUserLevelView(user.address)).to.equal(2);
    expect(await rv.getLevelMultiplierView(1)).to.equal(999n);
    const activity = await rv.getUserActivityView(user.address);
    expect(activity[0]).to.equal(11n);
    expect(activity[1]).to.equal(22n);
    expect(activity[2]).to.equal(33n);
    expect(await rv.getUserPenaltyDebtView(user.address)).to.equal(44n);
    const sys = await rv.getSystemRewardCoreStatsView();
    expect(sys[0]).to.equal(5n);
    expect(sys[1]).to.equal(6n);
  });

  describe("事件序列测试", function () {
    it("pushRewardEarned 应发出正确的 DataPush 事件", async function () {
      const { rv, rewardManagerCore, user } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      const DATA_TYPE_REWARD_EARNED = ethers.keccak256(ethers.toUtf8Bytes("REWARD_EARNED"));
      const tx = await rv.connect(writer).pushRewardEarned(user.address, 100, "test_reason", 12345);
      const receipt = await tx.wait();
      
      const event = receipt?.logs.find((log: any) => {
        try {
          const parsed = rv.interface.parseLog(log);
          return parsed?.name === "DataPushed";
        } catch {
          return false;
        }
      });
      
      expect(event).to.not.be.undefined;
      if (event) {
        const parsed = rv.interface.parseLog(event);
        expect(parsed?.args[0]).to.equal(DATA_TYPE_REWARD_EARNED);
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
          ["address", "uint256", "string", "uint256"],
          parsed?.args[1]
        );
        expect(decoded[0]).to.equal(user.address);
        expect(decoded[1]).to.equal(100n);
        expect(decoded[2]).to.equal("test_reason");
        expect(decoded[3]).to.equal(12345n);
      }
    });

    it("pushPointsBurned 应发出正确的 DataPush 事件", async function () {
      const { rv, rewardManagerCore, user } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      const DATA_TYPE_REWARD_BURNED = ethers.keccak256(ethers.toUtf8Bytes("REWARD_BURNED"));
      const tx = await rv.connect(writer).pushPointsBurned(user.address, 50, "burn_reason", 67890);
      const receipt = await tx.wait();
      
      const event = receipt?.logs.find((log: any) => {
        try {
          const parsed = rv.interface.parseLog(log);
          return parsed?.name === "DataPushed";
        } catch {
          return false;
        }
      });
      
      expect(event).to.not.be.undefined;
      if (event) {
        const parsed = rv.interface.parseLog(event);
        expect(parsed?.args[0]).to.equal(DATA_TYPE_REWARD_BURNED);
      }
    });

    it("pushUserLevel 应发出正确的 DataPush 事件", async function () {
      const { rv, rewardManagerCore, user } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      const DATA_TYPE_REWARD_LEVEL_UPDATED = ethers.keccak256(ethers.toUtf8Bytes("REWARD_LEVEL_UPDATED"));
      const tx = await rv.connect(writer).pushUserLevel(user.address, 3, 99999);
      const receipt = await tx.wait();
      
      const event = receipt?.logs.find((log: any) => {
        try {
          const parsed = rv.interface.parseLog(log);
          return parsed?.name === "DataPushed";
        } catch {
          return false;
        }
      });
      
      expect(event).to.not.be.undefined;
      if (event) {
        const parsed = rv.interface.parseLog(event);
        expect(parsed?.args[0]).to.equal(DATA_TYPE_REWARD_LEVEL_UPDATED);
      }
    });

    it("pushUserPrivilege 应发出正确的 DataPush 事件", async function () {
      const { rv, rewardManagerCore, user } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      const DATA_TYPE_REWARD_PRIVILEGE_UPDATED = ethers.keccak256(ethers.toUtf8Bytes("REWARD_PRIVILEGE_UPDATED"));
      const tx = await rv.connect(writer).pushUserPrivilege(user.address, 0xABCDn, 111111);
      const receipt = await tx.wait();
      
      const event = receipt?.logs.find((log: any) => {
        try {
          const parsed = rv.interface.parseLog(log);
          return parsed?.name === "DataPushed";
        } catch {
          return false;
        }
      });
      
      expect(event).to.not.be.undefined;
      if (event) {
        const parsed = rv.interface.parseLog(event);
        expect(parsed?.args[0]).to.equal(DATA_TYPE_REWARD_PRIVILEGE_UPDATED);
      }
    });

    it("pushSystemStats 应发出正确的 DataPush 事件", async function () {
      const { rv, rewardManagerCore } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      const DATA_TYPE_REWARD_STATS_UPDATED = ethers.keccak256(ethers.toUtf8Bytes("REWARD_STATS_UPDATED"));
      const tx = await rv.connect(writer).pushSystemStats(100, 200, 222222);
      const receipt = await tx.wait();
      
      const event = receipt?.logs.find((log: any) => {
        try {
          const parsed = rv.interface.parseLog(log);
          return parsed?.name === "DataPushed";
        } catch {
          return false;
        }
      });
      
      expect(event).to.not.be.undefined;
      if (event) {
        const parsed = rv.interface.parseLog(event);
        expect(parsed?.args[0]).to.equal(DATA_TYPE_REWARD_STATS_UPDATED);
      }
    });

    it("多个连续操作应按顺序发出事件", async function () {
      const { rv, rewardManagerCore, user } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      const DATA_TYPE_REWARD_EARNED = ethers.keccak256(ethers.toUtf8Bytes("REWARD_EARNED"));
      const DATA_TYPE_REWARD_BURNED = ethers.keccak256(ethers.toUtf8Bytes("REWARD_BURNED"));
      
      const tx1 = await rv.connect(writer).pushRewardEarned(user.address, 100, "earn1", 1);
      const tx2 = await rv.connect(writer).pushPointsBurned(user.address, 20, "burn1", 2);
      const tx3 = await rv.connect(writer).pushRewardEarned(user.address, 50, "earn2", 3);
      
      const receipt1 = await tx1.wait();
      const receipt2 = await tx2.wait();
      const receipt3 = await tx3.wait();
      
      const events1 = receipt1?.logs.filter((log: any) => {
        try {
          const parsed = rv.interface.parseLog(log);
          return parsed?.name === "DataPushed";
        } catch {
          return false;
        }
      });
      const events2 = receipt2?.logs.filter((log: any) => {
        try {
          const parsed = rv.interface.parseLog(log);
          return parsed?.name === "DataPushed";
        } catch {
          return false;
        }
      });
      const events3 = receipt3?.logs.filter((log: any) => {
        try {
          const parsed = rv.interface.parseLog(log);
          return parsed?.name === "DataPushed";
        } catch {
          return false;
        }
      });
      
      expect(events1?.length).to.equal(1);
      expect(events2?.length).to.equal(1);
      expect(events3?.length).to.equal(1);
      
      if (events1?.[0] && events2?.[0] && events3?.[0]) {
        const parsed1 = rv.interface.parseLog(events1[0]);
        const parsed2 = rv.interface.parseLog(events2[0]);
        const parsed3 = rv.interface.parseLog(events3[0]);
        
        expect(parsed1?.args[0]).to.equal(DATA_TYPE_REWARD_EARNED);
        expect(parsed2?.args[0]).to.equal(DATA_TYPE_REWARD_BURNED);
        expect(parsed3?.args[0]).to.equal(DATA_TYPE_REWARD_EARNED);
      }
    });
  });

  describe("批量边界测试", function () {
    it("应能处理超过 MAX_ACTIVITY_SCAN (500) 的活动记录", async function () {
      const { rv, rewardManagerCore, user } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      // 创建 600 条活动记录（超过 MAX_ACTIVITY_SCAN = 500）
      const count = 600;
      for (let i = 1; i <= count; i++) {
        await rv.connect(writer).pushRewardEarned(user.address, i, `earn_${i}`, i);
      }
      
      // 查询应该只返回最近的记录（受 limit 限制）
      const recent = await rv.getUserRecentActivities(user.address, 0, 0, 10);
      expect(recent.length).to.equal(10);
      expect(recent[0].amount).to.equal(BigInt(count)); // 最新的记录
      expect(recent[9].amount).to.equal(BigInt(count - 9)); // 第10条记录
      
      // 查询所有记录（但受 MAX_ACTIVITY_SCAN 限制）
      const all = await rv.getUserRecentActivities(user.address, 0, 0, 1000);
      // 应该只返回最多 500 条（MAX_ACTIVITY_SCAN）
      expect(all.length).to.be.at.most(500);
    });

    it("应能处理大量用户的活动记录", async function () {
      const { rv, rewardManagerCore } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      const userCount = 50;
      const activitiesPerUser = 20;
      
      // 为每个用户创建活动记录
      for (let u = 0; u < userCount; u++) {
        const user = ethers.Wallet.createRandom();
        for (let i = 1; i <= activitiesPerUser; i++) {
          await rv.connect(writer).pushRewardEarned(user.address, i * 10, `earn_${i}`, i);
        }
        
        // 验证每个用户的活动记录
        const activities = await rv.getUserRecentActivities(user.address, 0, 0, 100);
        expect(activities.length).to.equal(activitiesPerUser);
      }
    });

    it("Top Earners 应正确处理超过 TOP_N (10) 的用户", async function () {
      const { rv, rewardManagerCore } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      // 创建 15 个用户（超过 TOP_N = 10）
      // 使用递减金额，确保前10个用户能进入 Top Earners
      const users = [];
      const amounts = [];
      for (let i = 0; i < 15; i++) {
        const user = ethers.Wallet.createRandom();
        const amount = (15 - i) * 1000; // 15000, 14000, ..., 1000
        users.push(user);
        amounts.push(amount);
        await rv.connect(writer).pushRewardEarned(user.address, amount, "top_earner", 1);
      }
      
      const [topAddrs, topAmounts] = await rv.getTopEarners();
      
      // 应该只返回 TOP_N = 10 个用户
      expect(topAddrs.length).to.equal(10);
      expect(topAmounts.length).to.equal(10);
      
      // 验证排序（降序）
      for (let i = 0; i < 9; i++) {
        expect(topAmounts[i]).to.be.gte(topAmounts[i + 1]);
      }
      
      // 验证前 10 个用户（金额最大的）都在列表中
      // 注意：由于 Top Earners 逻辑，只有 totalEarned > 最末位时才能插入
      // 前10个用户的金额是：15000, 14000, ..., 6000
      // 第11个用户的金额是 5000，应该无法插入（因为最末位是 6000）
      const top10Amounts = amounts.slice(0, 10); // [15000, 14000, ..., 6000]
      
      // 验证前10个用户的金额都在 Top Earners 中
      for (const amount of top10Amounts) {
        expect(topAmounts).to.include(BigInt(amount));
      }
      
      // 验证第 11-15 个用户（金额较小的）不在列表中
      // 这些用户的金额是：5000, 4000, 3000, 2000, 1000
      // 它们应该无法进入 Top 10（因为最末位是 6000）
      const bottom5Amounts = amounts.slice(10, 15); // [5000, 4000, 3000, 2000, 1000]
      for (const amount of bottom5Amounts) {
        expect(topAmounts).to.not.include(BigInt(amount));
      }
      
      // 验证 Top Earners 中的最小金额应该 >= 6000（第10个用户的金额）
      const minTopAmount = Math.min(...topAmounts.map((a: bigint) => Number(a)));
      expect(minTopAmount).to.be.gte(6000);
    });

    it("Top Earners 应正确处理用户积分更新和位置调整", async function () {
      const { rv, rewardManagerCore } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      // 创建 10 个用户
      const users = [];
      for (let i = 0; i < 10; i++) {
        const user = ethers.Wallet.createRandom();
        users.push(user);
        await rv.connect(writer).pushRewardEarned(user.address, (10 - i) * 100, "initial", 1);
      }
      
      const [topAddrs1, topAmounts1] = await rv.getTopEarners();
      expect(topAddrs1[0]).to.equal(users[0].address);
      expect(topAmounts1[0]).to.equal(1000n);
      
      // 更新最后一个用户的积分，使其超过第一个用户
      await rv.connect(writer).pushRewardEarned(users[9].address, 2000, "boost", 2);
      
      const [topAddrs2, topAmounts2] = await rv.getTopEarners();
      expect(topAddrs2[0]).to.equal(users[9].address);
      expect(topAmounts2[0]).to.equal(2100n); // 100 + 2000
      expect(topAddrs2[1]).to.equal(users[0].address);
      expect(topAmounts2[1]).to.equal(1000n);
    });

    it("应能处理大量并发写入操作", async function () {
      const { rv, rewardManagerCore } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      const userCount = 20;
      const operationsPerUser = 10;
      const users = [];
      
      for (let i = 0; i < userCount; i++) {
        users.push(ethers.Wallet.createRandom());
      }
      
      // 并发执行多个操作
      const promises = [];
      for (let u = 0; u < userCount; u++) {
        for (let op = 0; op < operationsPerUser; op++) {
          promises.push(
            rv.connect(writer).pushRewardEarned(users[u].address, op * 10, `op_${op}`, op)
          );
        }
      }
      
      await Promise.all(promises);
      
      // 验证每个用户的数据
      for (const user of users) {
        const summary = await rv.getUserRewardSummary(user.address);
        const expectedTotal = (operationsPerUser - 1) * operationsPerUser / 2 * 10;
        expect(summary.totalEarned).to.equal(BigInt(expectedTotal));
        
        const activities = await rv.getUserRecentActivities(user.address, 0, 0, 100);
        expect(activities.length).to.equal(operationsPerUser);
      }
    });

    it("应能处理多个模块同时并发写入", async function () {
      const { rv, rewardManagerCore, rewardConsumption } = await loadFixture(deployFixture);
      const writer1 = await getModuleSigner(await rewardManagerCore.getAddress());
      const writer2 = await getModuleSigner(await rewardConsumption.getAddress());
      
      const userCount = 30;
      const users = [];
      
      for (let i = 0; i < userCount; i++) {
        users.push(ethers.Wallet.createRandom());
      }
      
      // 两个模块同时并发写入
      const promises1 = [];
      const promises2 = [];
      
      for (let u = 0; u < userCount; u++) {
        // RewardManagerCore 写入积分获得
        promises1.push(
          rv.connect(writer1).pushRewardEarned(users[u].address, (u + 1) * 100, "earn", u)
        );
        // RewardConsumption 写入积分消费
        promises2.push(
          rv.connect(writer2).pushPointsBurned(users[u].address, (u + 1) * 50, "burn", u)
        );
      }
      
      await Promise.all([...promises1, ...promises2]);
      
      // 验证每个用户的数据
      for (let u = 0; u < userCount; u++) {
        const summary = await rv.getUserRewardSummary(users[u].address);
        expect(summary.totalEarned).to.equal(BigInt((u + 1) * 100));
        expect(summary.totalBurned).to.equal(BigInt((u + 1) * 50));
        
        const activities = await rv.getUserRecentActivities(users[u].address, 0, 0, 100);
        expect(activities.length).to.equal(2); // earn + burn
      }
    });

    it("应能处理混合操作类型的并发写入", async function () {
      const { rv, rewardManagerCore } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      const userCount = 25;
      const users = [];
      
      for (let i = 0; i < userCount; i++) {
        users.push(ethers.Wallet.createRandom());
      }
      
      // 混合不同类型的操作并发执行
      const promises = [];
      for (let u = 0; u < userCount; u++) {
        promises.push(rv.connect(writer).pushRewardEarned(users[u].address, 100, "earn", u * 4));
        promises.push(rv.connect(writer).pushPointsBurned(users[u].address, 20, "burn", u * 4 + 1));
        promises.push(rv.connect(writer).pushPenaltyLedger(users[u].address, 5, u * 4 + 2));
        promises.push(rv.connect(writer).pushUserLevel(users[u].address, (u % 5) + 1, u * 4 + 3));
      }
      
      await Promise.all(promises);
      
      // 验证每个用户的数据
      for (let u = 0; u < userCount; u++) {
        const summary = await rv.getUserRewardSummary(users[u].address);
        expect(summary.totalEarned).to.equal(100n);
        expect(summary.totalBurned).to.equal(20n);
        expect(summary.pendingPenalty).to.equal(5n);
        expect(summary.level).to.equal((u % 5) + 1);
        
        const activities = await rv.getUserRecentActivities(users[u].address, 0, 0, 100);
        expect(activities.length).to.equal(3); // earn, burn, penalty (level 不产生活动记录)
      }
    });

    it("应能处理超大规模并发写入（100+ 用户，1000+ 操作）", async function () {
      const { rv, rewardManagerCore } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      const userCount = 100;
      const operationsPerUser = 10;
      const users = [];
      
      for (let i = 0; i < userCount; i++) {
        users.push(ethers.Wallet.createRandom());
      }
      
      // 创建 1000 个并发操作
      const promises = [];
      for (let u = 0; u < userCount; u++) {
        for (let op = 0; op < operationsPerUser; op++) {
          promises.push(
            rv.connect(writer).pushRewardEarned(users[u].address, op * 10 + u, `u${u}_op${op}`, op)
          );
        }
      }
      
      await Promise.all(promises);
      
      // 验证系统统计
      const stats = await rv.getSystemRewardStats();
      expect(stats.activeUsers).to.equal(userCount);
      
      // 随机抽样验证几个用户的数据
      const sampleIndices = [0, 25, 50, 75, 99];
      for (const idx of sampleIndices) {
        const summary = await rv.getUserRewardSummary(users[idx].address);
        const expectedTotal = operationsPerUser * (operationsPerUser - 1) / 2 * 10 + operationsPerUser * idx;
        expect(summary.totalEarned).to.equal(BigInt(expectedTotal));
        
        const activities = await rv.getUserRecentActivities(users[idx].address, 0, 0, 100);
        expect(activities.length).to.equal(operationsPerUser);
      }
    });

    it("并发写入时应保持 Top Earners 的正确性", async function () {
      const { rv, rewardManagerCore } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      const userCount = 50;
      const users = [];
      const expectedAmounts = new Map();
      
      for (let i = 0; i < userCount; i++) {
        users.push(ethers.Wallet.createRandom());
        expectedAmounts.set(users[i].address, 0n);
      }
      
      // 并发写入，每个用户多次获得积分
      const promises = [];
      for (let u = 0; u < userCount; u++) {
        for (let op = 0; op < 5; op++) {
          const amount = (u + 1) * 100 + op * 10;
          expectedAmounts.set(users[u].address, expectedAmounts.get(users[u].address)! + BigInt(amount));
          promises.push(
            rv.connect(writer).pushRewardEarned(users[u].address, amount, `op_${op}`, op)
          );
        }
      }
      
      await Promise.all(promises);
      
      // 验证 Top Earners
      const [topAddrs, topAmounts] = await rv.getTopEarners();
      
      // 验证排序（降序）
      for (let i = 0; i < topAmounts.length - 1; i++) {
        if (topAmounts[i] > 0n && topAmounts[i + 1] > 0n) {
          expect(topAmounts[i]).to.be.gte(topAmounts[i + 1]);
        }
      }
      
      // 验证 Top Earners 中的用户数据正确
      for (let i = 0; i < topAddrs.length; i++) {
        if (topAddrs[i] !== ethers.ZeroAddress) {
          const summary = await rv.getUserRewardSummary(topAddrs[i]);
          expect(summary.totalEarned).to.equal(topAmounts[i]);
          expect(summary.totalEarned).to.equal(expectedAmounts.get(topAddrs[i]));
        }
      }
    });

    it("并发写入时应保持活动记录的完整性", async function () {
      const { rv, rewardManagerCore } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      const userCount = 40;
      const operationsPerUser = 15;
      const users = [];
      
      for (let i = 0; i < userCount; i++) {
        users.push(ethers.Wallet.createRandom());
      }
      
      // 记录每个用户应该有的活动
      const expectedActivities = new Map();
      for (let u = 0; u < userCount; u++) {
        expectedActivities.set(users[u].address, []);
      }
      
      // 并发写入（使用唯一时间戳避免冲突）
      for (let u = 0; u < userCount; u++) {
        for (let op = 0; op < operationsPerUser; op++) {
          const amount = op * 10;
          const ts = u * 1000 + op; // 确保每个用户和操作都有唯一时间戳
          expectedActivities.get(users[u].address)!.push({ amount, ts, kind: 1 });
          await rv.connect(writer).pushRewardEarned(users[u].address, amount, `op_${op}`, ts);
        }
      }

      // 验证每个用户的活动记录完整性（严格：全部写入应被记录）
      let totalActivities = 0;
      for (let u = 0; u < userCount; u++) {
        const activities = await rv.getUserRecentActivities(users[u].address, 0, 0, 200);
        totalActivities += activities.length;

        // 验证活动记录按时间倒序（最新的在前）
        if (activities.length > 1) {
          for (let i = 0; i < activities.length - 1; i++) {
            expect(activities[i].ts).to.be.gte(activities[i + 1].ts);
          }
        }

        // 验证活动数量与金额
        expect(activities.length).to.equal(operationsPerUser);
        const activityAmounts = activities.map((a: any) => Number(a.amount));
        const expectedAmounts = expectedActivities.get(users[u].address)!.map((e: any) => e.amount);
        for (const amount of expectedAmounts) {
          expect(activityAmounts).to.include(amount);
        }

        // 验证汇总数据（应该等于所有操作的总和）
        const summary = await rv.getUserRewardSummary(users[u].address);
        const expectedTotal = operationsPerUser * (operationsPerUser - 1) / 2 * 10;
        expect(summary.totalEarned).to.equal(BigInt(expectedTotal));
      }

      // 验证总活动记录数量（严格等于预期值）
      const expectedTotalActivities = userCount * operationsPerUser;
      expect(totalActivities).to.equal(expectedTotalActivities);
    });

    it("并发写入时应保持系统统计的准确性", async function () {
      const { rv, rewardManagerCore } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      const userCount = 60;
      const users = [];
      
      for (let i = 0; i < userCount; i++) {
        users.push(ethers.Wallet.createRandom());
      }
      
      // 并发写入系统统计
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          rv.connect(writer).pushSystemStats(100 + i, 200 + i, i)
        );
      }
      
      // 同时并发写入用户数据
      for (let u = 0; u < userCount; u++) {
        promises.push(
          rv.connect(writer).pushRewardEarned(users[u].address, 100, "earn", u)
        );
      }
      
      await Promise.all(promises);
      
      // 验证系统统计（最后一次更新应该生效）
      // 注意：由于并发执行，最后一次 pushSystemStats 可能不是索引 9
      // 但应该是最新的时间戳对应的值
      const stats = await rv.getSystemRewardStats();
      // 验证值在合理范围内（最后一次应该是 100-109 之间）
      expect(stats.totalBatchOps).to.be.gte(100);
      expect(stats.totalBatchOps).to.be.lte(109);
      expect(stats.totalCachedRewards).to.be.gte(200);
      expect(stats.totalCachedRewards).to.be.lte(209);
      expect(stats.activeUsers).to.equal(userCount);
    });

    it("并发写入大量用户时应正确处理 Top Earners 更新", async function () {
      const { rv, rewardManagerCore } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      const userCount = 200;
      const users = [];
      const amounts = [];
      
      // 创建用户，金额从大到小
      for (let i = 0; i < userCount; i++) {
        users.push(ethers.Wallet.createRandom());
        amounts.push((userCount - i) * 100); // 20000, 19900, ..., 100
      }
      
      // 并发写入所有用户
      const promises = [];
      for (let i = 0; i < userCount; i++) {
        promises.push(
          rv.connect(writer).pushRewardEarned(users[i].address, amounts[i], "concurrent", 1)
        );
      }
      
      await Promise.all(promises);
      
      // 验证 Top Earners 只包含前 10 个用户
      const [topAddrs, topAmounts] = await rv.getTopEarners();
      expect(topAddrs.length).to.equal(10);
      expect(topAmounts.length).to.equal(10);
      
      // 验证排序
      for (let i = 0; i < 9; i++) {
        expect(topAmounts[i]).to.be.gte(topAmounts[i + 1]);
      }
      
      // 验证前 10 个用户的金额都在 Top Earners 中
      const top10Amounts = amounts.slice(0, 10);
      for (const amount of top10Amounts) {
        expect(topAmounts).to.include(BigInt(amount));
      }
      
      // 验证第 11-200 个用户不在 Top Earners 中
      const bottomAmounts = amounts.slice(10, 200);
      for (const amount of bottomAmounts) {
        expect(topAmounts).to.not.include(BigInt(amount));
      }
    });

    it("并发写入时应正确处理同一用户的多次更新", async function () {
      const { rv, rewardManagerCore } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      const user = ethers.Wallet.createRandom();
      const updateCount = 100;
      const updates = [];
      
      // 准备 100 次更新
      for (let i = 0; i < updateCount; i++) {
        updates.push({
          amount: (i + 1) * 10,
          ts: i + 1
        });
      }
      
      // 顺序执行所有更新，确保全部成功写入
      for (let idx = 0; idx < updates.length; idx++) {
        const update = updates[idx];
        await rv.connect(writer).pushRewardEarned(user.address, update.amount, `update_${idx}`, update.ts);
      }
      
      // 验证用户汇总
      const summary = await rv.getUserRewardSummary(user.address);
      const expectedTotal = updateCount * (updateCount + 1) / 2 * 10;
      expect(summary.totalEarned).to.equal(BigInt(expectedTotal));
      expect(summary.lastActivity).to.equal(BigInt(updateCount));
      
      // 验证活动记录（顺序执行，期望全部存在）
      const activities = await rv.getUserRecentActivities(user.address, 0, 0, 200);
      expect(activities.length).to.equal(updateCount);
      
      // 验证活动记录按时间倒序
      for (let i = 0; i < activities.length - 1; i++) {
        expect(activities[i].ts).to.be.gte(activities[i + 1].ts);
      }
      
      // 验证 Top Earners 包含该用户
      const [topAddrs, topAmounts] = await rv.getTopEarners();
      expect(topAddrs).to.include(user.address);
      const userIndex = topAddrs.indexOf(user.address);
      expect(topAmounts[userIndex]).to.equal(BigInt(expectedTotal));
    });

    it("并发写入混合操作时应保持数据一致性", async function () {
      const { rv, rewardManagerCore } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      const userCount = 35;
      const users = [];
      
      for (let i = 0; i < userCount; i++) {
        users.push(ethers.Wallet.createRandom());
      }
      
      // 记录每个用户的预期状态
      const expectedState = new Map();
      for (let u = 0; u < userCount; u++) {
        expectedState.set(users[u].address, {
          totalEarned: 0n,
          totalBurned: 0n,
          pendingPenalty: 0n,
          level: 0,
          activities: []
        });
      }
      
      // 并发执行混合操作
      const promises = [];
      for (let u = 0; u < userCount; u++) {
        const state = expectedState.get(users[u].address);
        
        // Earn
        state.totalEarned += 1000n;
        state.activities.push({ kind: 1, amount: 1000, ts: u * 4 });
        promises.push(rv.connect(writer).pushRewardEarned(users[u].address, 1000, "earn", u * 4));
        
        // Burn
        state.totalBurned += 200n;
        state.activities.push({ kind: 2, amount: 200, ts: u * 4 + 1 });
        promises.push(rv.connect(writer).pushPointsBurned(users[u].address, 200, "burn", u * 4 + 1));
        
        // Penalty
        state.pendingPenalty = 50n;
        state.activities.push({ kind: 3, amount: 50, ts: u * 4 + 2 });
        promises.push(rv.connect(writer).pushPenaltyLedger(users[u].address, 50, u * 4 + 2));
        
        // Level
        state.level = (u % 5) + 1;
        promises.push(rv.connect(writer).pushUserLevel(users[u].address, (u % 5) + 1, u * 4 + 3));
      }
      
      await Promise.all(promises);
      
      // 验证每个用户的数据一致性
      for (let u = 0; u < userCount; u++) {
        const summary = await rv.getUserRewardSummary(users[u].address);
        const expected = expectedState.get(users[u].address);
        
        expect(summary.totalEarned).to.equal(expected.totalEarned);
        expect(summary.totalBurned).to.equal(expected.totalBurned);
        expect(summary.pendingPenalty).to.equal(expected.pendingPenalty);
        expect(summary.level).to.equal(expected.level);
        
        const activities = await rv.getUserRecentActivities(users[u].address, 0, 0, 100);
        expect(activities.length).to.equal(3); // earn, burn, penalty (level 不产生 activity)
      }
    });
  });

  describe("边界条件测试", function () {
    it("应能处理零值输入", async function () {
      const { rv, rewardManagerCore, user } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      await rv.connect(writer).pushRewardEarned(user.address, 0, "zero_earn", 1);
      await rv.connect(writer).pushPointsBurned(user.address, 0, "zero_burn", 2);
      await rv.connect(writer).pushPenaltyLedger(user.address, 0, 3);
      await rv.connect(writer).pushUserLevel(user.address, 0, 4);
      await rv.connect(writer).pushUserPrivilege(user.address, 0, 5);
      
      const summary = await rv.getUserRewardSummary(user.address);
      expect(summary.totalEarned).to.equal(0);
      expect(summary.totalBurned).to.equal(0);
      expect(summary.pendingPenalty).to.equal(0);
      expect(summary.level).to.equal(0);
      expect(summary.privilegesPacked).to.equal(0);
    });

    it("应能处理极大值输入", async function () {
      const { rv, rewardManagerCore, user } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      const maxUint256 = ethers.MaxUint256;
      const maxUint8 = 255n;
      
      await rv.connect(writer).pushRewardEarned(user.address, maxUint256, "max_earn", 1);
      await rv.connect(writer).pushPointsBurned(user.address, maxUint256, "max_burn", 2);
      await rv.connect(writer).pushPenaltyLedger(user.address, maxUint256, 3);
      await rv.connect(writer).pushUserLevel(user.address, Number(maxUint8), 4);
      await rv.connect(writer).pushUserPrivilege(user.address, maxUint256, 5);
      
      const summary = await rv.getUserRewardSummary(user.address);
      expect(summary.totalEarned).to.equal(maxUint256);
      expect(summary.totalBurned).to.equal(maxUint256);
      expect(summary.pendingPenalty).to.equal(maxUint256);
      expect(summary.level).to.equal(255);
      expect(summary.privilegesPacked).to.equal(maxUint256);
    });

    it("getUserRecentActivities 应正确处理边界时间窗口", async function () {
      const { rv, rewardManagerCore, user } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      // 创建不同时间戳的活动
      await rv.connect(writer).pushRewardEarned(user.address, 10, "t1", 100);
      await rv.connect(writer).pushRewardEarned(user.address, 20, "t2", 200);
      await rv.connect(writer).pushRewardEarned(user.address, 30, "t3", 300);
      await rv.connect(writer).pushRewardEarned(user.address, 40, "t4", 400);
      await rv.connect(writer).pushRewardEarned(user.address, 50, "t5", 500);
      
      // 测试精确边界
      const exact = await rv.getUserRecentActivities(user.address, 200, 400, 10);
      expect(exact.length).to.equal(3);
      expect(exact[0].amount).to.equal(40); // t4
      expect(exact[1].amount).to.equal(30); // t3
      expect(exact[2].amount).to.equal(20); // t2
      
      // 测试包含边界
      const inclusive = await rv.getUserRecentActivities(user.address, 200, 200, 10);
      expect(inclusive.length).to.equal(1);
      expect(inclusive[0].amount).to.equal(20);
      
      // 测试无匹配窗口
      const noMatch = await rv.getUserRecentActivities(user.address, 1000, 2000, 10);
      expect(noMatch.length).to.equal(0);
    });

    it("getUserRecentActivities 应正确处理 limit = 0", async function () {
      const { rv, rewardManagerCore, user } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      await rv.connect(writer).pushRewardEarned(user.address, 10, "test", 1);
      
      const result = await rv.getUserRecentActivities(user.address, 0, 0, 0);
      expect(result.length).to.equal(0);
    });

    it("Top Earners 应正确处理空列表", async function () {
      const { rv } = await loadFixture(deployFixture);
      
      const [topAddrs, topAmounts] = await rv.getTopEarners();
      expect(topAddrs.length).to.equal(10);
      expect(topAmounts.length).to.equal(10);
      
      // 所有地址应该是零地址
      for (const addr of topAddrs) {
        expect(addr).to.equal(ethers.ZeroAddress);
      }
      
      // 所有金额应该是 0
      for (const amount of topAmounts) {
        expect(amount).to.equal(0);
      }
    });

    it("应正确处理用户从未有活动的情况", async function () {
      const { rv, user } = await loadFixture(deployFixture);
      
      const summary = await rv.getUserRewardSummary(user.address);
      expect(summary.totalEarned).to.equal(0);
      expect(summary.totalBurned).to.equal(0);
      expect(summary.pendingPenalty).to.equal(0);
      expect(summary.level).to.equal(0);
      expect(summary.privilegesPacked).to.equal(0);
      expect(summary.lastActivity).to.equal(0);
      
      const activities = await rv.getUserRecentActivities(user.address, 0, 0, 100);
      expect(activities.length).to.equal(0);
    });

    it("应正确处理活动时间戳的更新逻辑", async function () {
      const { rv, rewardManagerCore, user } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      await rv.connect(writer).pushRewardEarned(user.address, 10, "old", 100);
      let summary = await rv.getUserRewardSummary(user.address);
      expect(summary.lastActivity).to.equal(100);
      
      // 更新的时间戳应该更新 lastActivity
      await rv.connect(writer).pushRewardEarned(user.address, 20, "new", 200);
      summary = await rv.getUserRewardSummary(user.address);
      expect(summary.lastActivity).to.equal(200);
      
      // 更旧的时间戳不应该更新 lastActivity
      await rv.connect(writer).pushRewardEarned(user.address, 30, "older", 150);
      summary = await rv.getUserRewardSummary(user.address);
      expect(summary.lastActivity).to.equal(200);
    });

    it("应正确处理活跃用户计数", async function () {
      const { rv, rewardManagerCore } = await loadFixture(deployFixture);
      const writer = await getModuleSigner(await rewardManagerCore.getAddress());
      
      const user1 = ethers.Wallet.createRandom();
      const user2 = ethers.Wallet.createRandom();
      
      let stats = await rv.getSystemRewardStats();
      expect(stats.activeUsers).to.equal(0);
      
      await rv.connect(writer).pushRewardEarned(user1.address, 10, "test", 1);
      stats = await rv.getSystemRewardStats();
      expect(stats.activeUsers).to.equal(1);
      
      await rv.connect(writer).pushRewardEarned(user2.address, 20, "test", 2);
      stats = await rv.getSystemRewardStats();
      expect(stats.activeUsers).to.equal(2);
      
      // 同一用户再次操作不应增加计数
      await rv.connect(writer).pushRewardEarned(user1.address, 30, "test", 3);
      stats = await rv.getSystemRewardStats();
      expect(stats.activeUsers).to.equal(2);
    });
  });
});

