#!/usr/bin/env bash
set -euo pipefail

# Purpose: Create/ensure Route 53 hosted zone and DNS records for a domain
# Records created:
# - A (Alias) @ -> CloudFront
# - AAAA (Alias) @ -> CloudFront
# - Optional CNAME www -> CloudFront (when CREATE_WWW_CNAME=true)
# - Optional ACM validation CNAME (when ACM_VALIDATION_NAME & ACM_VALIDATION_VALUE provided)
#
# Required env vars:
#   DOMAIN                e.g. easifi.io
#   CLOUDFRONT_DOMAIN     e.g. d1q1tzwj9bh8s.cloudfront.net
# Optional env vars:
#   CREATE_WWW_CNAME      true|false (default: true)
#   ACM_VALIDATION_NAME   full validation name from ACM (e.g. _abc123.easifi.io)
#   ACM_VALIDATION_VALUE  validation value ending with .acm-validations.aws
#   AWS_PROFILE / AWS_REGION standard AWS CLI vars
#
# Notes:
# - CloudFront hosted zone id is constant: Z2FDTNDATAQYW2
# - After creating the hosted zone, update your registrar (e.g., Namecheap) to use
#   the NS records printed by this script, then wait for propagation.

if ! command -v aws >/dev/null 2>&1; then
  echo "[ERROR] aws CLI 未安装，请先安装 AWS CLI。" >&2
  exit 1
fi

DOMAIN=${DOMAIN:-}
CLOUDFRONT_DOMAIN=${CLOUDFRONT_DOMAIN:-}
CREATE_WWW_CNAME=${CREATE_WWW_CNAME:-true}

if [[ -z "${DOMAIN}" || -z "${CLOUDFRONT_DOMAIN}" ]]; then
  echo "用法示例:" >&2
  echo "  DOMAIN=easifi.io \\" >&2
  echo "  CLOUDFRONT_DOMAIN=d1q1tzwj9bh8s.cloudfront.net \\" >&2
  echo "  ACM_VALIDATION_NAME=_a039a49713cf4b55f0bcd6806c4597c.easifi.io \\" >&2
  echo "  ACM_VALIDATION_VALUE=_2603a91635ea80a903ebd5684daaa7fb.xlfgrmvvlj.acm-validations.aws \\" >&2
  echo "  CREATE_WWW_CNAME=true \\" >&2
  echo "  bash scripts/deploy/setup_route53.sh" >&2
  exit 2
fi

CF_HOSTED_ZONE_ID="Z2FDTNDATAQYW2"

echo "[INFO] 确认/创建 Hosted Zone: ${DOMAIN}"
HZ_ID=$(aws route53 list-hosted-zones-by-name \
  --dns-name "${DOMAIN}" \
  --query "HostedZones[?Name==\`${DOMAIN}.\`].Id | [0]" \
  --output text)

if [[ "${HZ_ID}" == "None" || -z "${HZ_ID}" ]]; then
  echo "[INFO] 未找到，创建新的 Hosted Zone..."
  CREATE_OUT=$(aws route53 create-hosted-zone \
    --name "${DOMAIN}" \
    --caller-reference "setup-${DOMAIN}-$(date +%s)" )
  HZ_ID=$(echo "${CREATE_OUT}" | sed -n 's/.*\"Id\": \"\([^\"]*\)\".*/\1/p' | head -n1)
fi

# Normalize hosted zone id (strip /hostedzone/ if present)
HZ_ID=${HZ_ID##*/}
echo "[INFO] Hosted Zone Id: ${HZ_ID}"

echo "[INFO] 当前 NS 名称服务器（请到注册商设置这些 NS）:"
aws route53 list-resource-record-sets \
  --hosted-zone-id "${HZ_ID}" \
  --query "ResourceRecordSets[?Type=='NS']|[0].ResourceRecords[].Value" \
  --output text | tr '\t' '\n' || true

echo "[INFO] 创建/更新根域 A/AAAA 别名到 CloudFront: ${CLOUDFRONT_DOMAIN}"
TMP_CHANGE=$(mktemp)
cat >"${TMP_CHANGE}" <<EOF
{
  "Comment": "Setup A/AAAA alias for ${DOMAIN}",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "${DOMAIN}.",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "${CF_HOSTED_ZONE_ID}",
          "DNSName": "${CLOUDFRONT_DOMAIN}.",
          "EvaluateTargetHealth": false
        }
      }
    },
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "${DOMAIN}.",
        "Type": "AAAA",
        "AliasTarget": {
          "HostedZoneId": "${CF_HOSTED_ZONE_ID}",
          "DNSName": "${CLOUDFRONT_DOMAIN}.",
          "EvaluateTargetHealth": false
        }
      }
    }
  ]
}
EOF

CHANGE_ID=$(aws route53 change-resource-record-sets \
  --hosted-zone-id "${HZ_ID}" \
  --change-batch file://"${TMP_CHANGE}" \
  --query 'ChangeInfo.Id' --output text)

echo "[INFO] 等待 A/AAAA 记录生效: ${CHANGE_ID}"
aws route53 wait resource-record-sets-changed --id "${CHANGE_ID}"
rm -f "${TMP_CHANGE}"

if [[ "${CREATE_WWW_CNAME}" == "true" ]]; then
  echo "[INFO] 创建/更新 CNAME www -> ${CLOUDFRONT_DOMAIN}"
  TMP_CHANGE=$(mktemp)
  cat >"${TMP_CHANGE}" <<EOF
{
  "Comment": "Setup CNAME www -> CloudFront for ${DOMAIN}",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "www.${DOMAIN}.",
        "Type": "CNAME",
        "TTL": 300,
        "ResourceRecords": [{"Value": "${CLOUDFRONT_DOMAIN}."}]
      }
    }
  ]
}
EOF
  CHANGE_ID=$(aws route53 change-resource-record-sets \
    --hosted-zone-id "${HZ_ID}" \
    --change-batch file://"${TMP_CHANGE}" \
    --query 'ChangeInfo.Id' --output text)
  echo "[INFO] 等待 www CNAME 生效: ${CHANGE_ID}"
  aws route53 wait resource-record-sets-changed --id "${CHANGE_ID}"
  rm -f "${TMP_CHANGE}"
fi

if [[ -n "${ACM_VALIDATION_NAME:-}" && -n "${ACM_VALIDATION_VALUE:-}" ]]; then
  echo "[INFO] 创建/更新 ACM 验证 CNAME"
  TMP_CHANGE=$(mktemp)
  cat >"${TMP_CHANGE}" <<EOF
{
  "Comment": "ACM validation CNAME for ${DOMAIN}",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "${ACM_VALIDATION_NAME}.",
        "Type": "CNAME",
        "TTL": 300,
        "ResourceRecords": [{"Value": "${ACM_VALIDATION_VALUE}."}]
      }
    }
  ]
}
EOF
  CHANGE_ID=$(aws route53 change-resource-record-sets \
    --hosted-zone-id "${HZ_ID}" \
    --change-batch file://"${TMP_CHANGE}" \
    --query 'ChangeInfo.Id' --output text)
  echo "[INFO] 等待 ACM 验证 CNAME 生效: ${CHANGE_ID}"
  aws route53 wait resource-record-sets-changed --id "${CHANGE_ID}"
  rm -f "${TMP_CHANGE}"
fi

echo "[OK] 记录已创建/更新。"
echo "[NEXT] 请到注册商把域名 NS 指向上面打印的 4 个 Route 53 NS。生效后，在 Amplify 自定义域页面点击验证/重试。"


