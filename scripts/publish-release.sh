#!/usr/bin/env bash
# SkillSync 一条命令发版:改版本号 → 构建(签名+公证)→ 打 dmg → 传内网 Gitea 发布仓
#                        → 更新 latest.json(老用户的 app 由此收到自动更新)。
#
# 用法:
#   set -a; . fixtures/.env.gitea.local; . fixtures/.env.apple.local; . fixtures/.env.release.local; set +a
#   export SKILLSYNC_UPDATE_URL="${SKILLSYNC_BUILTIN_GITEA_URL}/skills/skillsync-releases/releases/download/latest/latest.json"
#   export SKILLSYNC_UPDATE_PUBKEY="$(cat ~/.tauri/skillsync.key.pub)"
#   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/skillsync.key)"
#   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
#   ./scripts/publish-release.sh 0.2.0
#
# 前置(一次性):
#   - fixtures/.env.release.local 里放 SKILLSYNC_RELEASE_TOKEN=<内网 Gitea 个人访问令牌>
#     (Gitea 右上角头像 → 设置 → 应用 → 生成令牌,勾 repository 读写;*.local 不进 git)
#   - 内网 Gitea 建好发布仓 skills/skillsync-releases(勾"初始化仓库"即可,内容无所谓)
#
# 发布仓布局(每次发版后):
#   release v0.2.0  ← dmg + tar.gz + sig(版本存档,tar.gz 是自动更新真正下载的东西)
#   release latest  ← latest.json(地址永远不变,app 编译时记的就是它)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-}"
if [[ -z "$VERSION" || ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "用法:./scripts/publish-release.sh <新版本号,如 0.2.0>" >&2
  exit 1
fi

# ---------- 前置校验:缺什么当场说清楚,不要构建了十分钟才失败 ----------
fail=0
for var in SKILLSYNC_BUILTIN_GITEA_URL SKILLSYNC_OAUTH_CLIENT_ID SKILLSYNC_BUILTIN_REPO \
           SKILLSYNC_BUILTIN_BRANCH SKILLSYNC_UPDATE_URL SKILLSYNC_UPDATE_PUBKEY \
           TAURI_SIGNING_PRIVATE_KEY APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD \
           APPLE_TEAM_ID SKILLSYNC_RELEASE_TOKEN; do
  if [[ -z "${!var:-}" ]]; then
    echo "❌ 缺环境变量 $var(见脚本头部的用法)" >&2
    fail=1
  fi
done
[[ $fail -ne 0 ]] && exit 1

GITEA="${SKILLSYNC_BUILTIN_GITEA_URL%/}"
REPO_API="$GITEA/api/v1/repos/skills/skillsync-releases"
AUTH=(-H "Authorization: token $SKILLSYNC_RELEASE_TOKEN")

api() { # method path [curl 额外参数...]
  local method="$1" path="$2"; shift 2
  curl -sS -f -X "$method" "${AUTH[@]}" "$REPO_API$path" "$@"
}

echo "==> 检查发布仓可达"
if ! api GET "" >/dev/null 2>&1; then
  echo "❌ 访问不到 $REPO_API" >&2
  echo "   ① 确认内网 Gitea 上已建仓 skills/skillsync-releases(勾选初始化);" >&2
  echo "   ② 确认 SKILLSYNC_RELEASE_TOKEN 有它的读写权限;③ 确认已连内网/VPN。" >&2
  exit 1
fi
if api GET "/releases/tags/v$VERSION" >/dev/null 2>&1; then
  echo "❌ v$VERSION 已经发过了。换一个版本号——已发出去的版本不覆盖。" >&2
  exit 1
fi

# ---------- 改版本号(三处必须一致;tauri.conf.json 是自动更新比对的权威) ----------
echo "==> 版本号 → $VERSION(package.json / tauri.conf.json / Cargo.toml)"
python3 - "$VERSION" <<'PYEOF'
import json, re, sys
v = sys.argv[1]
for p in ["package.json", "src-tauri/tauri.conf.json"]:
    doc = json.load(open(p))
    doc["version"] = v
    open(p, "w").write(json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
p = "src-tauri/Cargo.toml"
s = open(p).read()
s2 = re.sub(r'^version = "[^"]+"', f'version = "{v}"', s, count=1, flags=re.M)
assert s2 != s or f'version = "{v}"' in s, "Cargo.toml 版本没改动"
open(p, "w").write(s2)
PYEOF

# ---------- 构建(签名+公证)+ 打 dmg:沿用已打通的两步,坑都修在那两个脚本里 ----------
echo "==> 构建 universal 包(约 5-10 分钟)"
./scripts/build-release.sh --target universal-apple-darwin --bundles app
./scripts/make-dmg.sh

BUNDLE="src-tauri/target/universal-apple-darwin/release/bundle"
TARBALL="$(find "$BUNDLE/macos" -name '*.app.tar.gz' | head -1)"
SIGFILE="$(find "$BUNDLE/macos" -name '*.app.tar.gz.sig' | head -1)"
DMG="$BUNDLE/dmg/SkillSync_${VERSION}_universal.dmg"
for f in "$TARBALL" "$SIGFILE" "$DMG"; do
  [[ -f "$f" ]] || { echo "❌ 缺产物 $f" >&2; exit 1; }
done

# ---------- 传版本 release:dmg 给人装,tar.gz+sig 给自动更新下载 ----------
echo "==> 创建 release v$VERSION 并上传产物"
RELEASE_ID="$(api POST "/releases" -H "Content-Type: application/json" \
  -d "{\"tag_name\":\"v$VERSION\",\"name\":\"SkillSync $VERSION\",\"body\":\"内部发布。新用户装 dmg;tar.gz 与 sig 是自动更新用的,不用手动下载。\"}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")"
api POST "/releases/$RELEASE_ID/assets?name=SkillSync_${VERSION}_universal.dmg" -F "attachment=@$DMG" >/dev/null
api POST "/releases/$RELEASE_ID/assets?name=SkillSync.app.tar.gz" -F "attachment=@$TARBALL" >/dev/null
api POST "/releases/$RELEASE_ID/assets?name=SkillSync.app.tar.gz.sig" -F "attachment=@$SIGFILE" >/dev/null

# ---------- 更新公告牌 latest.json(地址恒定;universal 包同时喂两种芯片的 Mac) ----------
echo "==> 更新 latest 公告牌"
TARBALL_URL="$GITEA/skills/skillsync-releases/releases/download/v$VERSION/SkillSync.app.tar.gz"
python3 - "$VERSION" "$TARBALL_URL" "$SIGFILE" <<'PYEOF'
import json, sys, datetime
v, url, sigfile = sys.argv[1:4]
sig = open(sigfile).read().strip()
entry = {"signature": sig, "url": url}
doc = {
    "version": v,
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    # universal 包,两种芯片的 Mac 都指向同一个文件
    "platforms": {"darwin-aarch64": entry, "darwin-x86_64": entry},
}
open("/tmp/skillsync-latest.json", "w").write(json.dumps(doc, indent=2) + "\n")
PYEOF
# latest 这个 release 每次重建(附件要换);tag 本身留着,下载地址按 tag 名寻址不受影响
OLD_LATEST="$(api GET "/releases/tags/latest" 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])" 2>/dev/null || true)"
[[ -n "$OLD_LATEST" ]] && api DELETE "/releases/$OLD_LATEST" >/dev/null
LATEST_ID="$(api POST "/releases" -H "Content-Type: application/json" \
  -d "{\"tag_name\":\"latest\",\"name\":\"latest\",\"body\":\"自动更新公告牌,请勿手动改动。当前版本:$VERSION\"}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")"
api POST "/releases/$LATEST_ID/assets?name=latest.json" -F "attachment=@/tmp/skillsync-latest.json" >/dev/null

# ---------- 验收:装了旧版的 app 马上就会按这个地址查到新版本 ----------
echo "==> 验收公告牌"
GOT="$(curl -sSf "$SKILLSYNC_UPDATE_URL" | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])")"
if [[ "$GOT" != "$VERSION" ]]; then
  echo "❌ 公告牌上的版本是 $GOT,不是刚发的 $VERSION——检查 SKILLSYNC_UPDATE_URL 是否指向发布仓的 latest" >&2
  exit 1
fi

echo
echo "✅ v$VERSION 发布完成"
echo "   新用户安装包:$GITEA/skills/skillsync-releases/releases  (发 dmg 链接到内网群即可)"
echo "   老用户:app 内「设置 → 检查应用更新」立即可见;自动检查按各自设置的频率触发"
echo "   别忘了:git add -A && git commit -m '发版 v$VERSION' && git push"
