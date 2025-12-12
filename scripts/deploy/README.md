# 部署脚本说明

## 📁 文件组织结构

### **核心部署脚本**
- `setup-data-collection.sh` - **AWS数据收集系统部署** (最新)
- `setup_ec2_full_project.sh` - **完整项目部署到EC2** (最新)
- `setup_aws_rds.sh` - **AWS RDS数据库设置** (最新)

### **基础设施脚本**
- `create-ec2-instances.sh` - 创建EC2实例
- `setup_aws_rds.sh` - 设置AWS RDS数据库
- `setup_route53.sh` - 设置Route53 DNS
- `setup_ssh_tunnel.sh` - 设置SSH隧道

### **应用部署脚本**
- `setup_ec2_frontend.sh` - 部署前端到EC2
- `setup_data_sync.sh` - 数据同步设置
- `setup_local_database.sh` - 本地数据库设置

### **配置和测试脚本**
- `setup-deployment-config.sh` - 部署配置设置
- `update_env_config.sh` - 环境变量配置更新
- `test_aws_connection.sh` - AWS连接测试
- `test-deployment.sh` - 部署测试
- `auto-deploy.sh` - 自动部署脚本

### **集成脚本**
- `deploy_aws_integration.sh` - AWS集成部署

## 🚀 推荐使用顺序

### **1. 首次部署**
```bash
# 1. 创建基础设施
./scripts/deploy/create-ec2-instances.sh
./scripts/deploy/setup_aws_rds.sh
./scripts/deploy/setup_route53.sh

# 2. 部署应用
./scripts/deploy/setup_ec2_full_project.sh
./scripts/deploy/setup-data-collection.sh

# 3. 测试部署
./scripts/deploy/test-deployment.sh
```

### **2. 数据收集部署**
```bash
# 设置24小时数据收集
./scripts/deploy/setup-data-collection.sh

# 测试数据收集
./scripts/deploy/test_aws_connection.sh
```

### **3. 前端部署**
```bash
# 仅部署前端
./scripts/deploy/setup_ec2_frontend.sh
```

## 📋 文件功能说明

| 文件名 | 功能 | 状态 |
|--------|------|------|
| `setup-data-collection.sh` | AWS数据收集系统部署 | ✅ 推荐使用 |
| `setup_ec2_full_project.sh` | 完整项目部署 | ✅ 推荐使用 |
| `setup_aws_rds.sh` | AWS RDS设置 | ✅ 推荐使用 |
| `create-ec2-instances.sh` | 创建EC2实例 | ✅ 推荐使用 |
| `setup_route53.sh` | DNS设置 | ✅ 推荐使用 |
| `setup_ssh_tunnel.sh` | SSH隧道设置 | ✅ 推荐使用 |
| `setup_ec2_frontend.sh` | 前端部署 | ✅ 推荐使用 |
| `setup_data_sync.sh` | 数据同步 | ✅ 推荐使用 |
| `setup_local_database.sh` | 本地数据库 | ✅ 推荐使用 |
| `test-deployment.sh` | 部署测试 | ✅ 推荐使用 |
| `test_aws_connection.sh` | AWS连接测试 | ✅ 推荐使用 |
| `auto-deploy.sh` | 自动部署 | ✅ 推荐使用 |

## ⚠️ 已删除的重复文件

以下文件因重复内容已被删除：
- `setup-aws-cron.sh` (功能已合并到 `setup-data-collection.sh`)
- `deploy-24h-collection-to-aws.sh` (功能已合并到 `setup-data-collection.sh`)
- `quick-deploy-ec2.sh` (功能已合并到 `setup_ec2_full_project.sh`)
- `deploy_complete.sh` (功能已合并到 `setup_ec2_full_project.sh`)
- `deploy_to_aws.sh` (功能已合并到 `setup_ec2_full_project.sh`)
- `setup_ec2_database.sh` (功能已合并到 `setup_aws_rds.sh`)
- `setup_db.sh` (功能已合并到 `setup_aws_rds.sh`)

## 🔧 使用说明

1. **确保有适当的权限**: 所有脚本都需要执行权限
2. **检查前置条件**: 运行前确保AWS CLI已配置
3. **按顺序执行**: 按照推荐顺序执行脚本
4. **测试部署**: 部署完成后运行测试脚本验证

## 📞 支持

如有问题，请检查：
1. AWS CLI配置是否正确
2. SSH密钥是否正确设置
3. 网络连接是否正常
4. 相关服务是否已启动