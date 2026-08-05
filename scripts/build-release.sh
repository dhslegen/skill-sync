#!/usr/bin/env bash
# SkillSync 发布构建(任务 13)。
#
# 职责:
#   1. 强制校验编译期注入的内网配置——缺了任何一个,构建出的包连不上公司技能库,
#      却要到用户手里才发现(app 只会显示"未配置")。这类包绝不允许流出。
#   2. macOS 上按环境变量决定 签名/公证:证书未到位时仍可出"未签名测试包",
#      但会打显眼的警告——Sequoia 起未公证应用非开发者基本打不开(设计方案 2.5⑤)。
#
# 用法:
#   export SKILLSYNC_BUILTIN_GITEA_URL="https://gitea.<内网域名>"
#   export SKILLSYNC_OAUTH_CLIENT_ID="<OAuth 应用的 Client ID>"
#   export SKILLSYNC_BUILTIN_REPO="skills/skills"
#   export SKILLSYNC_BUILTIN_BRANCH="main"
#   # 可选(M3):GitHub 源的一键登录。不设不拦构建,GitHub 源仍可匿名浏览获取。
#   export SKILLSYNC_GITHUB_CLIENT_ID="<GitHub OAuth App 的 Client ID(需启用 Device Flow)>"
#   # macOS 签名 + 公证(证书到位后):
#   export APPLE_SIGNING_IDENTITY="Developer ID Application: <公司> (<TEAMID>)"
#   export APPLE_ID="<公证用 Apple ID>" APPLE_PASSWORD="<app 专用密码>" APPLE_TEAM_ID="<TEAMID>"
#   ./scripts/build-release.sh
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
for var in SKILLSYNC_BUILTIN_GITEA_URL SKILLSYNC_OAUTH_CLIENT_ID SKILLSYNC_BUILTIN_REPO SKILLSYNC_BUILTIN_BRANCH; do
  if [[ -z "${!var:-}" ]]; then
    echo "❌ 缺少环境变量 $var —— 没有它构建出的包连不上公司技能库" >&2
    fail=1
  fi
done

# App 自更新链路(M2 任务 5):更新源地址 + minisign 公钥编译进包,
# 私钥用于给产物出 .sig。缺任何一个,发布出去的包将永远收不到更新——同样绝不允许流出。
for var in SKILLSYNC_UPDATE_URL SKILLSYNC_UPDATE_PUBKEY TAURI_SIGNING_PRIVATE_KEY; do
  if [[ -z "${!var:-}" ]]; then
    echo "❌ 缺少环境变量 $var —— 没有它发布出去的包永远收不到应用更新" >&2
    fail=1
  fi
done

if [[ $fail -ne 0 ]]; then
  echo "发布构建终止。上述 SKILLSYNC_*/TAURI_SIGNING_* 变量都设好后重试。" >&2
  echo "minisign 密钥对用 'pnpm tauri signer generate' 生成;私钥离线保管,丢失即永远无法推更新。" >&2
  exit 1
fi

# GitHub 一键登录是可选能力:不设只提示,不拦构建(M3 任务 5a)
if [[ -z "${SKILLSYNC_GITHUB_CLIENT_ID:-}" ]]; then
  echo "⚠️  未设置 SKILLSYNC_GITHUB_CLIENT_ID:GitHub 源可浏览获取,但「一键登录」不可用。" >&2
fi

case "$SKILLSYNC_BUILTIN_GITEA_URL" in
  https://*) ;;
  http://*)
    echo "⚠️  内网地址是 http(明文)。OAuth 令牌会裸奔,确认这是内网且 IT 知情。" >&2
    ;;
  *)
    echo "❌ SKILLSYNC_BUILTIN_GITEA_URL 不是 http(s) 地址: $SKILLSYNC_BUILTIN_GITEA_URL" >&2
    exit 1
    ;;
esac

if [[ "$(uname)" == "Darwin" ]]; then
  if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
    echo "⚠️  未设置 APPLE_SIGNING_IDENTITY:产物不签名,只能用于内部测试机。" >&2
    echo "    Sequoia 起,未公证的应用普通同事双击打不开(需右键打开并二次确认)。" >&2
  elif [[ -z "${APPLE_ID:-}" || -z "${APPLE_PASSWORD:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
    echo "⚠️  已设签名身份但缺公证凭证(APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID):" >&2
    echo "    产物已签名但未公证,Gatekeeper 仍会拦。" >&2
  else
    echo "✅ 签名 + 公证凭证齐备,tauri build 会自动完成签名与公证(含 staple)。"
  fi
fi

echo "==> pnpm install"
pnpm install --frozen-lockfile

echo "==> tauri build(附带 updater 产物:.sig 与压缩包)"
# createUpdaterArtifacts 只在发布构建打开:主 tauri.conf.json 不放它,
# 否则没有签名私钥的日常 pnpm tauri build 会直接失败。
# 额外参数透传:出 universal 包时需要 --target universal-apple-darwin
# (Intel Mac 也能装。不透传的话参数被吞掉,只出当前架构的包,而这件事
#  要到装机时才发现——2026-08-05 加)
pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":true}}' "$@"

echo
echo "构建完成。产物:"
# universal 构建落在 target/universal-apple-darwin/ 下,不是 target/release/,
# 所以按模式找而不是写死一条路径
find src-tauri/target -maxdepth 4 -path '*/release/bundle/*' \
  \( -name '*.dmg' -o -name '*.exe' -o -name '*.msi' -o -name '*.app.tar.gz' -o -name '*.sig' \) \
  -newermt '-10 minutes' 2>/dev/null | sort || true
