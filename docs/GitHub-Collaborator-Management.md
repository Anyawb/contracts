# GitHub 协作者管理指南

> 本指南详细说明如何在 contracts 项目中添加和管理 GitHub 协作者（Collaborator）

## 📋 目录

1. [前置准备](#前置准备)
2. [方式一：使用 GitHub CLI (gh)](#方式一使用-github-cli-gh)
3. [方式二：使用网页界面](#方式二使用网页界面)
4. [权限级别说明](#权限级别说明)
5. [常见问题](#常见问题)
6. [最佳实践](#最佳实践)

---

## 前置准备

### 检查仓库信息

当前项目仓库地址：
```
https://github.com/Anyawb/contracts.git
```

### 确认权限

⚠️ **重要**：只有仓库的 **Owner** 或具有 **Admin** 权限的用户才能添加协作者。

---

## 方式一：使用 GitHub CLI (gh)

### 1. 安装 GitHub CLI

#### macOS
```bash
brew install gh
```

#### Linux
```bash
# Ubuntu/Debian
sudo apt install gh

# 或使用官方安装脚本
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt update
sudo apt install gh
```

#### Windows
```powershell
# 使用 Chocolatey
choco install gh

# 或使用 Scoop
scoop install gh
```

### 2. 登录 GitHub CLI

```bash
# 启动登录流程
gh auth login

# 按照提示选择：
# - GitHub.com
# - HTTPS
# - 选择认证方式（浏览器或令牌）
# - 授权访问
```

### 3. 验证登录状态

```bash
# 检查登录状态
gh auth status

# 应该显示类似：
# ✓ Logged in to github.com as <your-username> (github.com)
```

### 4. 添加协作者

#### 基本命令格式

```bash
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  /repos/:owner/:repo/collaborators/:username \
  -f permission="<permission_level>"
```

#### 实际使用示例

```bash
# 添加协作者（需要替换为实际的用户名和权限）
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  /repos/Anyawb/contracts/collaborators/<username> \
  -f permission="push"
```

#### 权限级别参数

- `pull` - 只读权限（只能拉取代码）
- `triage` - 可以管理 issues 和 PRs
- `push` - 可以推送代码（写权限）
- `maintain` - 可以管理仓库设置（除了删除仓库）
- `admin` - 完全管理权限（包括添加协作者）

#### 完整示例

```bash
# 示例 1：添加一个具有写权限的协作者
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  /repos/Anyawb/contracts/collaborators/john-doe \
  -f permission="push"

# 示例 2：添加一个具有管理员权限的协作者
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  /repos/Anyawb/contracts/collaborators/jane-smith \
  -f permission="admin"
```

### 5. 查看现有协作者

```bash
# 列出所有协作者
gh api \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  /repos/Anyawb/contracts/collaborators

# 格式化输出（需要 jq）
gh api \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  /repos/Anyawb/contracts/collaborators | jq '.[] | {login: .login, permissions: .permissions}'
```

### 6. 移除协作者

```bash
# 移除协作者
gh api \
  --method DELETE \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  /repos/Anyawb/contracts/collaborators/<username>
```

### 7. 更新协作者权限

```bash
# 更新权限（使用 PUT 方法，与添加相同）
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  /repos/Anyawb/contracts/collaborators/<username> \
  -f permission="admin"
```

---

## 方式二：使用网页界面

### 步骤 1：访问仓库设置页面

1. 打开浏览器，访问仓库：
   ```
   https://github.com/Anyawb/contracts
   ```

2. 点击仓库页面右上角的 **Settings**（设置）按钮

3. 在左侧菜单中，找到并点击 **Collaborators**（协作者）

   > 如果看不到 "Collaborators" 选项，说明您没有管理员权限

### 步骤 2：添加新协作者

1. 在 "Collaborators" 页面，点击 **Add people**（添加人员）按钮

2. 在弹出的搜索框中，输入要添加的用户名、邮箱或全名

3. 从搜索结果中选择正确的用户

4. 选择权限级别：
   - **Read** - 只读权限
   - **Triage** - 可以管理 issues 和 PRs
   - **Write** - 可以推送代码
   - **Maintain** - 可以管理仓库设置
   - **Admin** - 完全管理权限

5. 点击 **Add [username] to this repository**（将用户添加到此仓库）

### 步骤 3：等待用户接受邀请

- 被添加的用户会收到一封邀请邮件
- 用户需要点击邮件中的链接接受邀请
- 在用户接受之前，其状态会显示为 "Pending"（待处理）

### 步骤 4：管理现有协作者

在协作者列表中，您可以：

- **查看权限**：每个协作者旁边显示其权限级别
- **更改权限**：点击权限下拉菜单，选择新的权限级别
- **移除协作者**：点击用户名旁边的 **X** 按钮

---

## 权限级别说明

### 详细权限对比表

| 权限级别 | 读取代码 | 创建分支 | 推送代码 | 合并 PR | 管理 Issues | 管理设置 | 添加协作者 | 删除仓库 |
|---------|---------|---------|---------|---------|------------|---------|----------|---------|
| **Read** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Triage** | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| **Write** | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Maintain** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅* | ❌ | ❌ |
| **Admin** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |

*Maintain 权限可以管理大部分设置，但不能添加协作者或删除仓库

### 推荐权限分配

#### 对于开发者
- **Write** 权限：允许推送代码、创建分支、合并 PR
- 适合日常开发工作

#### 对于代码审查者
- **Triage** 权限：可以管理 issues 和 PRs，但不能直接推送代码
- 适合代码审查和项目管理

#### 对于项目维护者
- **Maintain** 权限：可以管理仓库设置，但不能添加协作者
- 适合长期维护项目的核心成员

#### 对于项目所有者
- **Admin** 权限：完全管理权限
- 仅限项目所有者或核心管理员

---

## 常见问题

### Q1: 为什么我看不到 "Collaborators" 选项？

**A:** 这通常意味着您没有管理员权限。只有 **Owner** 或 **Admin** 权限的用户才能管理协作者。

**解决方案：**
- 联系仓库所有者为您提升权限
- 或使用 GitHub CLI（如果您有 API token 权限）

### Q2: 使用 GitHub CLI 时提示 "Not Found" 或 "Forbidden"

**A:** 可能的原因：

1. **未登录或登录过期**
   ```bash
   gh auth login
   gh auth status
   ```

2. **没有管理员权限**
   - 确认您的账户是仓库的 Owner 或 Admin

3. **仓库路径错误**
   - 确认仓库路径：`Anyawb/contracts`

### Q3: 协作者没有收到邀请邮件

**A:** 检查以下事项：

1. 确认用户邮箱地址正确
2. 检查用户的 GitHub 通知设置
3. 用户可以在 GitHub 网页上查看待处理的邀请：
   ```
   https://github.com/Anyawb/contracts/invitations
   ```

### Q4: 如何批量添加多个协作者？

**A:** 使用脚本批量操作：

```bash
#!/bin/bash
# 批量添加协作者脚本

REPO="Anyawb/contracts"
PERMISSION="push"  # 或 "admin", "maintain", "triage", "pull"

# 协作者用户名列表
COLLABORATORS=(
  "user1"
  "user2"
  "user3"
)

for username in "${COLLABORATORS[@]}"; do
  echo "Adding $username..."
  gh api \
    --method PUT \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    /repos/$REPO/collaborators/$username \
    -f permission="$PERMISSION"
done
```

### Q5: 如何查看协作者的详细权限？

**A:** 使用以下命令：

```bash
# 查看特定用户的权限
gh api \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  /repos/Anyawb/contracts/collaborators/<username>/permission
```

---

## 最佳实践

### 1. 权限最小化原则

- ✅ **推荐**：只授予必要的权限
- ❌ **避免**：给所有协作者 Admin 权限

### 2. 定期审查协作者列表

- 定期检查协作者列表，移除不再需要的用户
- 审查权限分配是否合理

### 3. 使用团队（Teams）管理权限

对于大型项目，考虑使用 GitHub Teams：

```bash
# 创建团队
gh api \
  --method POST \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  /orgs/Anyawb/teams \
  -f name="contracts-developers" \
  -f description="Contracts repository developers"

# 将团队添加到仓库
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  /orgs/Anyawb/teams/contracts-developers/repos/Anyawb/contracts \
  -f permission="push"
```

### 4. 记录权限变更

- 在项目文档中记录权限分配决策
- 使用 GitHub Issues 或 Projects 跟踪权限变更

### 5. 使用分支保护规则

即使协作者有 Write 权限，也建议设置分支保护规则：

1. 进入 **Settings** → **Branches**
2. 添加规则保护 `main` 或 `master` 分支
3. 要求 PR 审查后才能合并

---

## 快速参考命令

### GitHub CLI 常用命令

```bash
# 登录
gh auth login

# 检查状态
gh auth status

# 添加协作者（Write 权限）
gh api --method PUT \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  /repos/Anyawb/contracts/collaborators/<username> \
  -f permission="push"

# 列出所有协作者
gh api \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  /repos/Anyawb/contracts/collaborators

# 移除协作者
gh api --method DELETE \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  /repos/Anyawb/contracts/collaborators/<username>
```

### 网页界面路径

```
仓库主页 → Settings → Collaborators → Add people
```

---

## 相关资源

- [GitHub CLI 官方文档](https://cli.github.com/manual/)
- [GitHub 协作者权限文档](https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-github-user-account/managing-access-to-your-personal-repositories/inviting-collaborators-to-a-personal-repository)
- [GitHub API 文档 - 协作者](https://docs.github.com/en/rest/collaborators/collaborators)

---

**版本**: 1.0.0  
**最后更新**: 2025年1月  
**维护者**: Contracts Repository Team

