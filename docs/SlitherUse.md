# Slither 使用手册

> 本文档汇总本项目常用的 Slither 静态分析命令及其参数含义，方便日后手动或 CI 环境下快速调用。

## 1. 环境准备

```bash
# 1) 安装 Python 3.11（macOS 例子，其他系统请自行调整）
brew install python@3.11

# 2) 创建并激活虚拟环境
/opt/homebrew/bin/python3.11 -m venv venv-slither
source venv-slither/bin/activate

# 3) 安装指定版本 Slither
pip install --upgrade pip
pip install slither-analyzer==0.11.3

# 4) 确认版本
slither --version   # 应输出 v0.11.3
```

> 提示：每次使用 Slither 前，**记得** `source venv-slither/bin/activate`；用完后 `deactivate`。
# 进入项目目录后
source venv-slither/bin/activate   # 激活环境
slither --version                  # Slither v0.11.3
SLITHER=1 slither . --config-file slither.config.json # 运行审计
deactivate                         # 退出环境

---

## 2. 常用命令速查

| 目的 | 命令 | 关键参数说明 |
|------|------|--------------|
| **完整扫描（使用配置文件）** | `SLITHER=1 slither . --config-file slither.config.json` | `SLITHER=1` 环境变量让 Hardhat 采用 viaIR 编译；`--config-file` 读取统一的过滤/排除设置 |
| **仅输出高/中危** | `SLITHER=1 slither . --filter-paths "node_modules,test,scripts,mocks,interfaces,examples,tools" --exclude-informational --exclude-low` | `--filter-paths` 忽略无关目录；`--exclude-*` 剔除提示级与低危结果 |
| **强制 CI 失败（发现高危时退出非 0）** | *在任意命令后追加* `--fail-high` | 结果包含 Impact=High 即返回非零退出码 |
| **输出人类摘要** | `--print human-summary` | 简洁 Markdown 摘要，适合控制台查看 |
| **输出合约摘要** | `--print contract-summary` | 显示每个合约的函数、继承等结构信息 |
| **生成调用图** | `--print call-graph` | DOT 格式；可用 `dot -Tpng` 渲染 |
| **生成继承图** | `--print inheritance` | DOT 继承关系图 |
| **写入报告文件** | `slither . ... > slither-report/summary.txt` | 通过重定向输出到文件；CI 中常用 |

### 示例：一次性生成两份报告
```bash
mkdir -p slither-report
SLITHER=1 slither . \ 
  --config-file slither.config.json \ 
  --print human-summary > slither-report/summary.txt
SLITHER=1 slither . \ 
  --config-file slither.config.json \ 
  --print contract-summary > slither-report/contracts.txt
```

---

## 3. GitHub Actions 集成片段

```yaml
- name: Setup Python 3.11
  uses: actions/setup-python@v4
  with:
    python-version: '3.11'

- name: Install Slither 0.11.3
  run: |
    pip install --upgrade pip
    pip install slither-analyzer==0.11.3

- name: Run Slither (仅高/中危)
  env:
    SLITHER: "1"
  run: |
    slither . \
      --filter-paths "node_modules,test,scripts,mocks,interfaces,examples,tools" \
      --exclude-informational --exclude-low \
      --print human-summary --print contract-summary \
      --fail-high
```

---

## 4. 参数备忘

- `--filter-paths <list>`：逗号分隔目录列表，Slither 会忽略匹配路径。
- `--exclude-informational / --exclude-low / --exclude-medium / --exclude-high`：逐级排除风险等级。
- `--fail-high`：若检测到 High 级别漏洞，退出码为 1，CI 失败。
- `--config-file <file>`：加载 JSON 配置，集中维护 filter_paths / detectors / exclusions 等。
- `SLITHER=1`：配合 Hardhat `hardhat.config.js` 里的逻辑，在开启此变量时切换 viaIR 编译，减小 "stack too deep" 问题。

---

> 如需查看更多可用打印器、检测器，可执行：
> ```bash
> slither --list-detectors | less
> slither --list-printers | less
> ```