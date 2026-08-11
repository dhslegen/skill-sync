#!/usr/bin/env bash
# SkillSync 一条命令发版:改版本号 → commit+tag+push(触发 GitHub CI 出 Windows 包)
#                        → 本地构建 macOS(签名+公证)→ 打 dmg → 等 CI → 下载 exe 补签
#                        → 全部产物传内网 Gitea 发布仓 → 更新 latest.json(三平台)。
#
# 用法:
#   set -a; . fixtures/.env.gitea.local; . fixtures/.env.apple.local; . fixtures/.env.release.local; set +a
#   export SKILLSYNC_UPDATE_URL="${SKILLSYNC_BUILTIN_GITEA_URL}/skills/skillsync-releases/releases/download/latest/latest.json"
#   export SKILLSYNC_UPDATE_PUBKEY="$(cat ~/.tauri/skillsync.key.pub)"
#   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/skillsync.key)"
#   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
#   ./scripts/publish-release.sh 0.2.0
#
#   应急开关 SKIP_WINDOWS=1:CI 不可用时只发 macOS。后果:公告牌没有 windows-x86_64
#   条目,Windows 老用户查更新会一直"已最新",停在旧版——补发时用同流程发下一个版本号。
#
# Windows 段(M8 任务 2,2026-08-07 拍板「直接用公开 GitHub CI」):
#   - 版本号 commit + tag v<版本> 由本脚本**自动推送**——CI checkout 的是 tag 指向的
#     commit,版本号必须先进 tag,这一步没法留给人;与本地 macOS 构建并行,总时长不变。
#   - CI 产物**没有 .sig**(minisign 私钥绝不进公开仓,见 release.yml guard 注释),
#     exe 下载回本机后用 `pnpm tauri signer sign` 补签——私钥全程不离开这台机器。
#   - 等 CI 放在内网 release 创建**之前**:CI 失败时内网零写入,修好重跑即可
#     (版本号 commit 与 tag 已推也无妨,重跑会沿用)。
#
# 前置(一次性):
#   - fixtures/.env.release.local 里放 SKILLSYNC_RELEASE_TOKEN=<内网 Gitea 个人访问令牌>
#     (Gitea 右上角头像 → 设置 → 应用 → 生成令牌,勾 repository 读写;*.local 不进 git)
#   - 内网 Gitea 建好发布仓 skills/skillsync-releases(勾"初始化仓库"即可,内容无所谓)
#   - gh CLI 已登录 github.com(下载 CI artifact 用)
#
# 发布仓布局(每次发版后):
#   release v0.2.0  ← dmg + tar.gz + sig + x64-setup.exe + exe.sig(版本存档)
#   release latest  ← latest.json(地址永远不变,app 编译时记的就是它)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-}"
if [[ -z "$VERSION" || ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "用法:./scripts/publish-release.sh <新版本号,如 0.2.0>" >&2
  echo "     发版说明从 RELEASE_NOTES.md 的对应版本章节自动读取(见下)" >&2
  exit 1
fi

# ---------- 发版说明:从 RELEASE_NOTES.md 取该版本的章节 ----------
# 2026-08-07 用户拍板:**每个版本都要有发版说明**,不能再让所有 release 长着
# 同一句"内部发布"——同事拿到新包得知道升了什么。说明的唯一真相是仓库里的
# RELEASE_NOTES.md(受版本控制、随代码走查),README 的版本历史与内网 release
# 的 body 都从它来,不手抄第二份。
NOTES_FILE="RELEASE_NOTES.md"
RELEASE_NOTES="$(python3 - "$VERSION" <<'PYEOF'
import re, sys, pathlib
version = sys.argv[1]
path = pathlib.Path("RELEASE_NOTES.md")
if not path.exists():
    sys.exit(f"缺 {path}")
text = path.read_text(encoding="utf-8")
# 章节形如 "## 0.3.12 —— 标题",取到下一个 "## " 或文件末尾
m = re.search(rf"^##\s+{re.escape(version)}\b.*?$(.*?)(?=^##\s|\Z)", text, re.M | re.S)
if not m:
    sys.exit(f"RELEASE_NOTES.md 里没有 {version} 的章节")
body = m.group(1).strip()
if not body:
    sys.exit(f"RELEASE_NOTES.md 里 {version} 的章节是空的")
print(body)
PYEOF
)" || {
  echo "❌ 拿不到 v$VERSION 的发版说明。" >&2
  echo "   请先在 $NOTES_FILE 顶部加一段:" >&2
  echo "" >&2
  echo "   ## $VERSION —— 一句话主题" >&2
  echo "" >&2
  echo "   - 改了什么、用户会看到什么变化" >&2
  echo "" >&2
  echo "   这是硬要求:没有说明的版本发出去,同事不知道该不该升(2026-08-07 拍板)。" >&2
  exit 1
}

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

SKIP_WINDOWS="${SKIP_WINDOWS:-}"
if [[ -z "$SKIP_WINDOWS" ]]; then
  command -v gh >/dev/null 2>&1 || {
    echo "❌ 缺 gh CLI(Windows 包要从 GitHub CI 下载);应急可 SKIP_WINDOWS=1 只发 macOS" >&2
    exit 1
  }
fi

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

# ---------- 提交版本号并打 tag:tag push 触发 release.yml 出 Windows 包,
#            与下面的本地 macOS 构建并行(CI 6-10 分钟,mac 构建+公证更久)----------
if [[ -z "$SKIP_WINDOWS" ]]; then
  echo "==> 提交版本号并推 tag v$VERSION(触发 GitHub CI 构建 Windows 包)"
  git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
  git diff --cached --quiet || git commit -m "发版 v$VERSION: 版本号三处对齐"
  git tag "v$VERSION" 2>/dev/null || echo "   tag v$VERSION 已存在,沿用(重跑场景)"
  git push origin HEAD "refs/tags/v$VERSION"
fi

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

# ---------- 等 CI 出 Windows 包并本地补签(放在内网 release 创建之前:
#            CI 失败时内网零写入,修好重跑即可)----------
WIN_EXE=""; WIN_SIG=""; WIN_URL=""
if [[ -z "$SKIP_WINDOWS" ]]; then
  echo "==> 等 GitHub CI 出 Windows 包(release.yml,通常 6-10 分钟)"
  RUN_ID=""
  for _ in $(seq 1 30); do
    RUN_ID="$(gh run list --workflow=release.yml --json databaseId,headBranch \
      -q "[.[] | select(.headBranch == \"v$VERSION\")][0].databaseId" 2>/dev/null || true)"
    [[ -n "$RUN_ID" && "$RUN_ID" != "null" ]] && break
    sleep 10
  done
  [[ -n "$RUN_ID" && "$RUN_ID" != "null" ]] || {
    echo "❌ 等了 5 分钟没见到 tag v$VERSION 触发的 Release workflow——tag 推上去了吗?" >&2
    exit 1
  }
  for _ in $(seq 1 60); do
    [[ "$(gh run view "$RUN_ID" --json status -q .status)" == "completed" ]] && break
    sleep 30
  done
  CONCLUSION="$(gh run view "$RUN_ID" --json conclusion -q .conclusion)"
  [[ "$CONCLUSION" == "success" ]] || {
    echo "❌ GitHub CI 构建失败或超时(run $RUN_ID,conclusion=$CONCLUSION)。" >&2
    echo "   gh run view $RUN_ID --log-failed 看原因;应急:SKIP_WINDOWS=1 重跑只发 macOS" >&2
    exit 1
  }
  WINDIR="$(mktemp -d)"
  gh run download "$RUN_ID" -n skillsync-Windows -D "$WINDIR"
  WIN_EXE="$WINDIR/SkillSync_${VERSION}_x64-setup.exe"
  [[ -f "$WIN_EXE" ]] || {
    echo "❌ CI artifact 里没有 SkillSync_${VERSION}_x64-setup.exe——tag 指向的版本号对不上?" >&2
    exit 1
  }
  echo "==> 本地补签 Windows 包(私钥不进公开 CI,.sig 只能在这里出)"
  pnpm tauri signer sign "$WIN_EXE" >/dev/null
  WIN_SIG="$WIN_EXE.sig"
  [[ -f "$WIN_SIG" ]] || { echo "❌ 补签没产出 $WIN_SIG" >&2; exit 1; }
  WIN_URL="$GITEA/skills/skillsync-releases/releases/download/v$VERSION/SkillSync_${VERSION}_x64-setup.exe"
fi

# ---------- 传版本 release:dmg 给人装,tar.gz+sig 给自动更新下载 ----------
echo "==> 创建 release v$VERSION 并上传产物"
RELEASE_BODY="$(RELEASE_NOTES="$RELEASE_NOTES" python3 - <<'PYEOF'
import json, os
notes = os.environ["RELEASE_NOTES"]
tail = ("\n\n---\nmacOS 装 dmg,Windows 装 x64-setup.exe;"
        "tar.gz / sig 是自动更新用的,不用手动下载。")
print(json.dumps(notes + tail, ensure_ascii=False))
PYEOF
)"
RELEASE_ID="$(api POST "/releases" -H "Content-Type: application/json" \
  -d "{\"tag_name\":\"v$VERSION\",\"name\":\"SkillSync $VERSION\",\"body\":$RELEASE_BODY}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")"
api POST "/releases/$RELEASE_ID/assets?name=SkillSync_${VERSION}_universal.dmg" -F "attachment=@$DMG" >/dev/null
api POST "/releases/$RELEASE_ID/assets?name=SkillSync.app.tar.gz" -F "attachment=@$TARBALL" >/dev/null
api POST "/releases/$RELEASE_ID/assets?name=SkillSync.app.tar.gz.sig" -F "attachment=@$SIGFILE" >/dev/null
if [[ -n "$WIN_EXE" ]]; then
  api POST "/releases/$RELEASE_ID/assets?name=SkillSync_${VERSION}_x64-setup.exe" -F "attachment=@$WIN_EXE" >/dev/null
  api POST "/releases/$RELEASE_ID/assets?name=SkillSync_${VERSION}_x64-setup.exe.sig" -F "attachment=@$WIN_SIG" >/dev/null
fi

# ---------- 更新公告牌 latest.json(地址恒定;universal 包同时喂两种芯片的 Mac,
#            windows-x86_64 指向 NSIS exe——tauri v2 的 Windows 更新工件就是安装包本身)----------
echo "==> 更新 latest 公告牌"
TARBALL_URL="$GITEA/skills/skillsync-releases/releases/download/v$VERSION/SkillSync.app.tar.gz"
python3 - "$VERSION" "$TARBALL_URL" "$SIGFILE" "$WIN_URL" "${WIN_SIG:-}" <<'PYEOF'
import json, sys, datetime
v, url, sigfile, win_url, win_sigfile = sys.argv[1:6]
sig = open(sigfile).read().strip()
entry = {"signature": sig, "url": url}
# universal 包,两种芯片的 Mac 都指向同一个文件
platforms = {"darwin-aarch64": entry, "darwin-x86_64": entry}
# SKIP_WINDOWS 时不写 windows 条目(Windows 老用户会一直"已最新",见脚本头部说明)
if win_url and win_sigfile:
    platforms["windows-x86_64"] = {"signature": open(win_sigfile).read().strip(), "url": win_url}
doc = {
    "version": v,
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": platforms,
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
if [[ -n "$WIN_EXE" ]]; then
  PLATS="$(curl -sSf "$SKILLSYNC_UPDATE_URL" | python3 -c "import json,sys;print(','.join(sorted(json.load(sys.stdin)['platforms'])))")"
  if [[ "$PLATS" != "darwin-aarch64,darwin-x86_64,windows-x86_64" ]]; then
    echo "❌ 公告牌平台条目不对:$PLATS(应为三平台齐全)" >&2
    exit 1
  fi
  curl -sSfI "$WIN_URL" >/dev/null || { echo "❌ Windows 包下载地址不可达:$WIN_URL" >&2; exit 1; }
fi

# ---------- 清理公开 CI 上的 artifact(2026-08-07 用户拍板)----------
# 分发实际走内网发布仓,GitHub 上那份副本没有任何人用,却带着编译进去的内网配置
# 在公开仓挂 90 天(删 tag **不会**删 artifact,要按 artifact id 逐个删)。
# 放在全部成功之后:中途任何失败 artifact 都还在,便于排查与重跑。
# 删不掉只警告——发版已经成功了,清理失败不该让脚本以非零退出吓人。
if [[ -n "${RUN_ID:-}" ]]; then
  echo "==> 清理 GitHub CI artifact(run $RUN_ID)"
  for AID in $(gh api "repos/dhslegen/skill-sync/actions/runs/$RUN_ID/artifacts" \
                 -q '.artifacts[].id' 2>/dev/null || true); do
    if gh api -X DELETE "repos/dhslegen/skill-sync/actions/artifacts/$AID" >/dev/null 2>&1; then
      echo "   已删 artifact $AID"
    else
      echo "   ⚠️ artifact $AID 删除失败,手动清理:gh api -X DELETE repos/dhslegen/skill-sync/actions/artifacts/$AID" >&2
    fi
  done
fi

# ---------- 回收 Rust 构建的孤儿产物(2026-08-10 用户拍板)----------
# 为什么挂在发版脚本里:cargo **没有任何 GC 机制**,而发版正是孤儿产物的最大来源。
# 产物文件名里的 hash 来自 metadata(版本号/features/依赖/编译 flag),**不含源码内容**
# ——所以纯改代码是原地覆盖,不累积;而**版本号一变,整套产物换新名、旧的全成孤儿**。
# 实测:src-tauri/target 从 M1 开工到 2026-08-10(约 10 天、13 个版本)堆到 73GB,
# 其中 deps/ 43GB 里躺着 576327 个 .o(macOS debug 默认 split-debuginfo=unpacked,
# DWARF 调试信息散在每个 codegen unit 的 .o 里),incremental/ 另有 32GB。
# 单个集成测试二进制在 debug 下 65MB,而 tests/ 有 28 个 crate,每个都全量链接 lib。
#
# 调试信息档位**刻意保持现状**(未设 [profile.dev] debug):排查 Rust 侧问题
# 高度依赖 backtrace 与 lldb,压体积的收益不值得拿它换——用定期回收解决,不用降级调试能力。
#
# 与上面 artifact 清理同一口径:**回收失败只警告,绝不让发版以非零退出**
# (发版已经成功了)。工具没装也只提示不拦——换台机器发版不该因为少个开发工具就失败。
if command -v cargo-sweep >/dev/null 2>&1; then
  echo "==> 回收 Rust 构建的孤儿产物"
  BEFORE_KB="$(/usr/bin/du -sk src-tauri/target 2>/dev/null | cut -f1 || echo 0)"

  # 策略 = **硬上限 20GB**(2026-08-11 用户拍板),不是 --time 时间窗口:
  # 发版密集时"7 天内"能同时躺着好几个版本的整套产物,时间窗口给不出体积保证。
  # maxsize 从最老的开始删,近期产物保留,下次增量重编不受影响。
  # 两个易错点(都已用 --help 与 --dry-run 核实过,别凭记忆改):
  #   ① **单位默认 MB**,必须写 `20GB`——写成 `20` 就是 20MB,会把整个 target 扫空;
  #   ② `[PATH]` 收的是**项目目录**(含 Cargo.toml),给 `src-tauri/target` 只会
  #      WARN "does not exist" 然后静默什么都不删。
  cargo sweep --maxsize 20GB src-tauri || true

  AFTER_KB="$(/usr/bin/du -sk src-tauri/target 2>/dev/null | cut -f1 || echo 0)"
  echo "   target: $((BEFORE_KB/1024))MB → $((AFTER_KB/1024))MB"
else
  echo "   ⚠️ 未装 cargo-sweep,跳过孤儿产物回收(装它:cargo install cargo-sweep)" >&2
fi

echo
echo "✅ v$VERSION 发布完成"
echo "   新用户安装包:$GITEA/skills/skillsync-releases/releases  (发 dmg / x64-setup.exe 链接到内网群即可)"
echo "   老用户:app 内「设置 → 检查应用更新」立即可见;自动检查按各自设置的频率触发"
if [[ -z "$SKIP_WINDOWS" ]]; then
  echo "   版本号 commit 与 tag v$VERSION 已由脚本推送,无需再手动 commit"
else
  echo "   ⚠️ SKIP_WINDOWS 模式:公告牌没有 windows 条目,Windows 用户收不到这版更新"
  echo "   别忘了:git add -A && git commit -m '发版 v$VERSION' && git push"
fi
