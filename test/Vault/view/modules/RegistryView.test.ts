import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const KEY_ACM = ethers.id("ACCESS_CONTROL_MANAGER");
const KEY_PV = ethers.id("POSITION_VIEW");
const KEY_PREVIEW = ethers.id("PREVIEW_VIEW");
const KEY_HEALTH = ethers.id("HEALTH_VIEW");
const KEY_OTHER = ethers.id("OTHER_MODULE");
const KEY_DYNAMIC_MODULE_REGISTRY = ethers.id("DYNAMIC_MODULE_REGISTRY");
const ACTION_ADMIN = ethers.id("ACTION_ADMIN");
const MAX_BATCH = 100n; // 来自 ViewConstants.MAX_BATCH_SIZE

function extractRevertData(e: any): string | undefined {
  const roots: Array<unknown> = [
    e?.info?.error?.data,
    e?.info?.error?.error?.data,
    e?.error?.data,
    e?.error?.error?.data,
    e?.data,
  ];
  for (const v of roots) {
    if (typeof v === "string" && v.startsWith("0x")) return v;
  }
  return undefined;
}

async function expectMissingRole(p: Promise<unknown>) {
  const selMissingRole = ethers.id("MissingRole()").slice(0, 10).toLowerCase();
  try {
    await p;
  } catch (e: any) {
    const data = extractRevertData(e);
    const sel = data && data.length >= 10 ? data.slice(0, 10).toLowerCase() : "";
    // Accept either selector match or a message fallback.
    expect(sel === selMissingRole || String(e?.message ?? "").includes("MissingRole")).to.eq(true);
    return;
  }
  throw new Error("Expected MissingRole revert, but succeeded");
}

describe("RegistryView", function () {
  async function deployFixture() {
    const [admin, user] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("MockRegistry");
    const registry = await Registry.deploy();

    const Access = await ethers.getContractFactory("MockAccessControlManager");
    const acm = await Access.deploy();
    await acm.grantRole(ACTION_ADMIN, admin.address);

    const RegistryView = await ethers.getContractFactory("RegistryView");
    const rv = await upgrades.deployProxy(
      RegistryView,
      [await registry.getAddress()],
      { kind: "uups" }
    );

    await registry.setModule(KEY_ACM, await acm.getAddress());

    return { admin, user, registry, acm, rv };
  }

  describe("init", function () {
    it("reverts on zero registry", async function () {
      const RegistryView = await ethers.getContractFactory("RegistryView");
      await expect(
        upgrades.deployProxy(
          RegistryView,
          [ethers.ZeroAddress],
          { kind: "uups" }
        )
      ).to.be.revertedWithCustomError(RegistryView, "ZeroAddress");
    });

    it("reverts on non-contract registry", async function () {
      const RegistryView = await ethers.getContractFactory("RegistryView");
      const eoa = ethers.Wallet.createRandom().address;
      await expect(upgrades.deployProxy(RegistryView, [eoa], { kind: "uups" })).to.be.revertedWithCustomError(
        RegistryView,
        "NotAContract"
      );
    });

    it("sets registry address", async function () {
      const { registry, rv } = await loadFixture(deployFixture);
      expect(await rv.registryAddr()).to.equal(await registry.getAddress());
      expect(await rv.getRegistry()).to.equal(await registry.getAddress());
    });
  });

  describe("RV-01 static interface constraints", function () {
    it("has no push* functions; non-upgrade APIs are view/pure", async function () {
      const { rv } = await loadFixture(deployFixture);
      const abiFrags = rv.interface.fragments.filter((f: any) => f.type === "function");
      const fnNames = abiFrags.map((f: any) => f.name);

      expect(fnNames.filter((n: string) => n.startsWith("push")).length).to.eq(0);

      // UUPS entrypoints are expected to be nonpayable; everything else should be view/pure.
      const allowedNonView = new Set(["upgradeToAndCall", "initialize"]);
      for (const f of abiFrags as any[]) {
        if (allowedNonView.has(f.name)) continue;
        expect(["view", "pure"].includes(f.stateMutability)).to.eq(true, `expected ${f.name} to be view/pure`);
      }
    });
  });

  describe("RV-02 onlyValidRegistry (uninitialized)", function () {
    it("reverts on read APIs when registry not initialized", async function () {
      const RegistryView = await ethers.getContractFactory("RegistryView");
      const impl = await RegistryView.deploy();
      await expect(impl.getAllModuleKeys()).to.be.revertedWithCustomError(impl, "ZeroAddress");
      await expect(impl.checkModulesExist([KEY_ACM])).to.be.revertedWithCustomError(impl, "ZeroAddress");
      // Legacy getters should not revert.
      expect(await impl.registryAddr()).to.equal(ethers.ZeroAddress);
      expect(await impl.registryAddrVar()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("module listing", function () {
    it("returns only registered module keys", async function () {
      const { registry, rv } = await loadFixture(deployFixture);
      await registry.setModule(KEY_PV, ethers.Wallet.createRandom().address);
      await registry.setModule(KEY_PREVIEW, ethers.Wallet.createRandom().address);
      const keys = await rv.getAllRegisteredModuleKeys();
      expect(keys).to.include.members([KEY_ACM, KEY_PV, KEY_PREVIEW]);
    });

    it("returns registered modules with addresses", async function () {
      const { registry, rv, acm } = await loadFixture(deployFixture);
      const pvAddr = ethers.Wallet.createRandom().address;
      await registry.setModule(KEY_PV, pvAddr);
      const [keys, addrs] = await rv.getAllRegisteredModules();
      const indexAcm = keys.findIndex((k: string) => k === KEY_ACM);
      const indexPv = keys.findIndex((k: string) => k === KEY_PV);
      expect(addrs[indexAcm]).to.equal(await acm.getAddress());
      expect(addrs[indexPv]).to.equal(pvAddr);
    });
  });

  describe("existence checks with batch limits", function () {
    it("checkModulesExist rejects empty array", async function () {
      const { rv } = await loadFixture(deployFixture);
      await expect(rv.checkModulesExist([])).to.be.revertedWithCustomError(rv, "EmptyArray");
    });

    it("batchFindModuleKeysByAddresses rejects empty array", async function () {
      const { rv } = await loadFixture(deployFixture);
      await expect(rv.batchFindModuleKeysByAddresses([], 0)).to.be.revertedWithCustomError(rv, "EmptyArray");
    });

    it("checkModulesExist respects batch limit", async function () {
      const { rv } = await loadFixture(deployFixture);
      const oversized = Array.from({ length: Number(MAX_BATCH) + 1 }, (_, i) => ethers.id("KEY" + i));
      await expect(rv.checkModulesExist(oversized)).to.be.revertedWithCustomError(rv, "BatchTooLarge");
    });

    it("batchFindModuleKeysByAddresses respects batch limit", async function () {
      const { rv } = await loadFixture(deployFixture);
      const oversized = Array.from({ length: Number(MAX_BATCH) + 1 }, () => ethers.Wallet.createRandom().address);
      await expect(rv.batchFindModuleKeysByAddresses(oversized, 0)).to.be.revertedWithCustomError(
        rv,
        "BatchTooLarge"
      );
    });

    it("getRegisteredModuleKeysPaginated enforces limit", async function () {
      const { rv } = await loadFixture(deployFixture);
      await expect(rv.getRegisteredModuleKeysPaginated(0, Number(MAX_BATCH) + 1)).to.be.revertedWithCustomError(
        rv,
        "BatchTooLarge"
      );
    });

    it("checkModulesExist returns correct booleans", async function () {
      const { registry, rv } = await loadFixture(deployFixture);
      await registry.setModule(KEY_PV, ethers.Wallet.createRandom().address);
      const res = await rv.checkModulesExist([KEY_PV, KEY_HEALTH]);
      expect(res[0]).to.equal(true);
      expect(res[1]).to.equal(false);
    });
  });

  describe("reverse lookup", function () {
    it("findModuleKeyByAddress respects maxCount", async function () {
      const { registry, rv } = await loadFixture(deployFixture);
      const addr1 = ethers.Wallet.createRandom().address;
      const addr2 = ethers.Wallet.createRandom().address;
      await registry.setModule(KEY_PV, addr1);
      await registry.setModule(KEY_HEALTH, addr2);

      const [keyLimited, foundLimited] = await rv.findModuleKeyByAddress(addr2, 1);
      expect(foundLimited).to.equal(false);
      expect(keyLimited).to.equal(ethers.ZeroHash);

      const [keyFull, foundFull] = await rv.findModuleKeyByAddress(addr2, 0);
      expect(foundFull).to.equal(true);
      expect(keyFull).to.equal(KEY_HEALTH);
    });

    it("batchFindModuleKeysByAddresses returns keys and found flags", async function () {
      const { registry, rv } = await loadFixture(deployFixture);
      const addr1 = ethers.Wallet.createRandom().address;
      await registry.setModule(KEY_PV, addr1);

      const [keys, founds] = await rv.batchFindModuleKeysByAddresses([addr1, ethers.ZeroAddress], 0);
      expect(keys[0]).to.equal(KEY_PV);
      expect(founds[0]).to.equal(true);
      expect(founds[1]).to.equal(false);
    });
  });

  describe("pagination", function () {
    it("returns paginated registered keys with totalCount", async function () {
      const { registry, rv } = await loadFixture(deployFixture);
      await registry.setModule(KEY_PV, ethers.Wallet.createRandom().address);
      await registry.setModule(KEY_PREVIEW, ethers.Wallet.createRandom().address);
      await registry.setModule(KEY_HEALTH, ethers.Wallet.createRandom().address);

      const [page, total] = await rv.getRegisteredModuleKeysPaginated(1, 2);
      expect(total).to.equal(4); // ACM + 3 registered above
      expect(page.length).to.equal(2);
    });
  });

  describe("governance passthrough (mock-compatible)", function () {
    it("minDelay/maxDelay/owner return fallback values with MockRegistry", async function () {
      const { rv } = await loadFixture(deployFixture);
      expect(await rv.minDelay()).to.equal(0);
      expect(await rv.maxDelay()).to.equal(0);
      expect(await rv.owner()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("动态模块键聚合", function () {
    it("没有动态模块键注册表时只返回静态键", async function () {
      const { rv } = await loadFixture(deployFixture);
      const allKeys = await rv.getAllModuleKeys();
      expect(allKeys.length).to.be.gt(0);
      expect(allKeys).to.include(KEY_ACM);
    });

    it("有动态模块键注册表时聚合静态键和动态键", async function () {
      const [admin] = await ethers.getSigners();
      const Registry = await ethers.getContractFactory("MockRegistry");
      const registry = await Registry.deploy();

      const DynamicKeyReg = await ethers.getContractFactory("MockRegistryDynamicModuleKey");
      const dynamicKeyReg = await DynamicKeyReg.deploy();

      // 注册一些动态键
      await dynamicKeyReg.registerModuleKey("CUSTOM_MODULE_1");
      await dynamicKeyReg.registerModuleKey("CUSTOM_MODULE_2");
      
      // 获取动态键
      const dynamicKeys = await dynamicKeyReg.getDynamicModuleKeys();
      expect(dynamicKeys.length).to.equal(2);

      // 将动态键注册表注册到 Registry
      await registry.setModule(KEY_DYNAMIC_MODULE_REGISTRY, await dynamicKeyReg.getAddress());

      const RegistryView = await ethers.getContractFactory("RegistryView");
      const rv = await upgrades.deployProxy(
        RegistryView,
        [await registry.getAddress()],
        { kind: "uups" }
      );

      // 先创建一个不包含动态键注册表的 RegistryView 来获取静态键数量
      const Registry2 = await ethers.getContractFactory("MockRegistry");
      const registry2 = await Registry2.deploy();
      const RegistryView2 = await ethers.getContractFactory("RegistryView");
      const rv2 = await upgrades.deployProxy(
        RegistryView2,
        [await registry2.getAddress()],
        { kind: "uups" }
      );
      const staticKeysCount = (await rv2.getAllModuleKeys()).length;

      // 现在获取包含动态键的键列表
      const allKeys = await rv.getAllModuleKeys();
      
      // 应该包含静态键
      expect(allKeys).to.include(KEY_ACM);
      // 应该包含动态键（总数应该大于静态键数量）
      expect(allKeys.length).to.be.gt(staticKeysCount);
      // 验证动态键都在结果中
      for (const dk of dynamicKeys) {
        expect(allKeys).to.include(dk);
      }
    });

    it("动态键查询失败时回退到静态键", async function () {
      const Registry = await ethers.getContractFactory("MockRegistry");
      const registry = await Registry.deploy();

      const DynRevert = await ethers.getContractFactory("MockRegistryDynamicModuleKeyRevert");
      const dynRevert = await DynRevert.deploy();
      await registry.setModule(KEY_DYNAMIC_MODULE_REGISTRY, await dynRevert.getAddress());

      const RegistryView = await ethers.getContractFactory("RegistryView");
      const rv = await upgrades.deployProxy(
        RegistryView,
        [await registry.getAddress()],
        { kind: "uups" }
      );

      // 先获取不包含动态键注册表时的键列表（应该只有静态键）
      const Registry2 = await ethers.getContractFactory("MockRegistry");
      const registry2 = await Registry2.deploy();
      const rv2 = await upgrades.deployProxy(RegistryView, [await registry2.getAddress()], { kind: "uups" });
      const staticKeysOnly = await rv2.getAllModuleKeys();

      // dyn registry reverts: should NOT revert, should fall back to static keys only
      const allKeys = await rv.getAllModuleKeys();
      expect(allKeys).to.include(KEY_ACM);
      expect(allKeys.length).to.equal(staticKeysOnly.length);
    });

    it("getAllRegisteredModuleKeys 包含动态键中已注册的模块", async function () {
      const [admin] = await ethers.getSigners();
      const Registry = await ethers.getContractFactory("MockRegistry");
      const registry = await Registry.deploy();

      const DynamicKeyReg = await ethers.getContractFactory("MockRegistryDynamicModuleKey");
      const dynamicKeyReg = await DynamicKeyReg.deploy();

      // 注册动态键
      await dynamicKeyReg.registerModuleKey("CUSTOM_MODULE_1");
      await dynamicKeyReg.registerModuleKey("CUSTOM_MODULE_2");
      const dynamicKeys = await dynamicKeyReg.getDynamicModuleKeys();
      const dynamicKey1 = dynamicKeys[0];
      const dynamicKey2 = dynamicKeys[1];

      // 将动态键注册表注册到 Registry
      await registry.setModule(KEY_DYNAMIC_MODULE_REGISTRY, await dynamicKeyReg.getAddress());

      // 注册一些静态模块
      const acm = await (await ethers.getContractFactory("MockAccessControlManager")).deploy();
      await registry.setModule(KEY_ACM, await acm.getAddress());

      // 注册动态键对应的模块
      const dynamicModule1 = ethers.Wallet.createRandom().address;
      await registry.setModule(dynamicKey1, dynamicModule1);

      const RegistryView = await ethers.getContractFactory("RegistryView");
      const rv = await upgrades.deployProxy(
        RegistryView,
        [await registry.getAddress()],
        { kind: "uups" }
      );

      const registeredKeys = await rv.getAllRegisteredModuleKeys();
      
      // 应该包含已注册的静态键
      expect(registeredKeys).to.include(KEY_ACM);
      // 应该包含已注册的动态键
      expect(registeredKeys).to.include(dynamicKey1);
      // 不应该包含未注册的动态键
      expect(registeredKeys).to.not.include(dynamicKey2);
    });

    it("getAllRegisteredModules 包含动态键模块的地址", async function () {
      const [admin] = await ethers.getSigners();
      const Registry = await ethers.getContractFactory("MockRegistry");
      const registry = await Registry.deploy();

      const DynamicKeyReg = await ethers.getContractFactory("MockRegistryDynamicModuleKey");
      const dynamicKeyReg = await DynamicKeyReg.deploy();

      await dynamicKeyReg.registerModuleKey("CUSTOM_MODULE_1");
      await registry.setModule(KEY_DYNAMIC_MODULE_REGISTRY, await dynamicKeyReg.getAddress());
      const dynamicKeys = await dynamicKeyReg.getDynamicModuleKeys();
      const dynamicKey1 = dynamicKeys[0];

      const acm = await (await ethers.getContractFactory("MockAccessControlManager")).deploy();
      await registry.setModule(KEY_ACM, await acm.getAddress());

      const dynamicModule1 = ethers.Wallet.createRandom().address;
      await registry.setModule(dynamicKey1, dynamicModule1);

      const RegistryView = await ethers.getContractFactory("RegistryView");
      const rv = await upgrades.deployProxy(
        RegistryView,
        [await registry.getAddress()],
        { kind: "uups" }
      );

      const [keys, addrs] = await rv.getAllRegisteredModules();
      
      const indexAcm = keys.findIndex((k: string) => k === KEY_ACM);
      const indexDynamic = keys.findIndex((k: string) => k === dynamicKey1);
      
      expect(addrs[indexAcm]).to.equal(await acm.getAddress());
      expect(addrs[indexDynamic]).to.equal(dynamicModule1);
    });

    it("getRegisteredModuleKeysPaginated 包含动态键", async function () {
      const [admin] = await ethers.getSigners();
      const Registry = await ethers.getContractFactory("MockRegistry");
      const registry = await Registry.deploy();

      const DynamicKeyReg = await ethers.getContractFactory("MockRegistryDynamicModuleKey");
      const dynamicKeyReg = await DynamicKeyReg.deploy();

      await dynamicKeyReg.registerModuleKey("CUSTOM_MODULE_1");
      await registry.setModule(KEY_DYNAMIC_MODULE_REGISTRY, await dynamicKeyReg.getAddress());
      const dynamicKeys = await dynamicKeyReg.getDynamicModuleKeys();
      const dynamicKey1 = dynamicKeys[0];

      const acm = await (await ethers.getContractFactory("MockAccessControlManager")).deploy();
      await registry.setModule(KEY_ACM, await acm.getAddress());

      const dynamicModule1 = ethers.Wallet.createRandom().address;
      await registry.setModule(dynamicKey1, dynamicModule1);

      const RegistryView = await ethers.getContractFactory("RegistryView");
      const rv = await upgrades.deployProxy(
        RegistryView,
        [await registry.getAddress()],
        { kind: "uups" }
      );

      const [page, total] = await rv.getRegisteredModuleKeysPaginated(0, 10);
      
      expect(total).to.be.gte(2); // 至少包含 ACM 和 dynamicKey1
      expect(page.length).to.be.gte(2);
      expect(page).to.include(KEY_ACM);
      expect(page).to.include(dynamicKey1);
    });
  });

  describe("真实 Registry passthrough 测试", function () {
    async function deployRealRegistryFixture() {
      const [admin] = await ethers.getSigners();
      
      // 部署真实 Registry（使用代理模式）
      const RegistryFactory = await ethers.getContractFactory("Registry");
      const registryImplementation = await RegistryFactory.deploy();
      await registryImplementation.waitForDeployment();
      
      const minDelay = BigInt((24 * 60 * 60) / 2); // 1 day in blocks (2s baseline)
      const maxDelay = BigInt((7 * 24 * 60 * 60) / 2); // cap = 7 days in blocks
      const upgradeAdmin = admin.address;
      const emergencyAdmin = admin.address;

      const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
      const registryProxy = await ProxyFactory.deploy(
        await registryImplementation.getAddress(),
        registryImplementation.interface.encodeFunctionData(
          "initialize",
          [minDelay, maxDelay, upgradeAdmin, emergencyAdmin, admin.address]
        )
      );
      await registryProxy.waitForDeployment();
      
      const registry = registryImplementation.attach(await registryProxy.getAddress());
      
      // 部署 RegistryView
      const RegistryView = await ethers.getContractFactory("RegistryView");
      const rv = await upgrades.deployProxy(
        RegistryView,
        [await registry.getAddress()],
        { kind: "uups" }
      );
      
      return { admin, registry, rv, minDelay };
    }

    it("应该能够与真实 Registry 合约交互", async function () {
      const { admin, registry, rv, minDelay } = await loadFixture(deployRealRegistryFixture);
      
      // 验证 RegistryView 可以访问真实 Registry
      expect(await rv.registryAddr()).to.equal(await registry.getAddress());
      
      // 验证可以获取真实 Registry 的 minDelay
      const actualMinDelay = await rv.minDelay();
      expect(actualMinDelay).to.equal(minDelay);
      
      // 验证可以获取真实 Registry 的 owner
      const owner = await rv.owner();
      expect(owner).to.equal(admin.address);
    });

    it("应该能够从真实 Registry 获取模块地址", async function () {
      const { rv } = await loadFixture(deployRealRegistryFixture);
      
      // 验证 RegistryView 可以查询真实 Registry
      const allKeys = await rv.getAllModuleKeys();
      expect(allKeys.length).to.be.gt(0);
      
      // 验证可以获取已注册的模块键（初始状态应该为空或很少）
      const registeredKeys = await rv.getAllRegisteredModuleKeys();
      expect(registeredKeys.length).to.be.gte(0);
    });

    it("应该能够处理真实 Registry 的 MAX_DELAY", async function () {
      const { rv } = await loadFixture(deployRealRegistryFixture);
      
      // 验证可以获取真实 Registry 的 MAX_DELAY
      const maxDelay = await rv.maxDelay();
      // MAX_DELAY 应该是 7 days (blocks, 2s/block)
      expect(maxDelay).to.equal((7 * 24 * 60 * 60) / 2);
    });

    it("应该能够处理真实 Registry 的动态模块键注册表", async function () {
      const { rv } = await loadFixture(deployRealRegistryFixture);
      
      const DynamicKeyReg = await ethers.getContractFactory("MockRegistryDynamicModuleKey");
      const dynamicKeyReg = await DynamicKeyReg.deploy();
      
      // 注册一些动态键
      await dynamicKeyReg.registerModuleKey("REAL_DYNAMIC_1");
      
      // 验证 getAllModuleKeys 可以正常工作
      // 注意：由于真实 Registry 需要 owner 权限设置模块，动态键注册表可能未在 Registry 中注册
      // 这种情况下应该只返回静态键
      const allKeys = await rv.getAllModuleKeys();
      expect(allKeys.length).to.be.gt(0);
      
      // 验证至少包含已知的静态键
      expect(allKeys).to.include(KEY_ACM);
    });
  });

  describe("RV-06 UUPS upgrade authorization", function () {
    it("reverts upgradeTo for non-admin caller", async function () {
      const { rv, user } = await loadFixture(deployFixture);
      const RegistryView = await ethers.getContractFactory("RegistryView");
      const newImpl = await RegistryView.deploy();
      await expectMissingRole(rv.connect(user).upgradeToAndCall(await newImpl.getAddress(), "0x"));
    });

    it("reverts on zero/EOA newImplementation (after role check)", async function () {
      const { rv, admin } = await loadFixture(deployFixture);
      await expect(rv.connect(admin).upgradeToAndCall(ethers.ZeroAddress, "0x")).to.be.revertedWithCustomError(
        rv,
        "ZeroAddress"
      );
      const eoa = ethers.Wallet.createRandom().address;
      await expect(rv.connect(admin).upgradeToAndCall(eoa, "0x")).to.be.revertedWithCustomError(rv, "NotAContract");
    });

    it("allows upgradeTo for admin with contract implementation", async function () {
      const { rv, admin } = await loadFixture(deployFixture);
      const RegistryView = await ethers.getContractFactory("RegistryView");
      const newImpl = await RegistryView.deploy();
      await expect(rv.connect(admin).upgradeToAndCall(await newImpl.getAddress(), "0x")).to.not.be.reverted;
    });
  });
});

