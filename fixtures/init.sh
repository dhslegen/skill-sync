#!/usr/bin/env bash
# 起本地 Gitea 测试实例并灌入样例数据(交接包 3.6)。
#
# 幂等:重复执行不会报错,已存在的用户/组织/仓库会跳过。
# 彻底重来:./fixtures/init.sh --reset
#
# 建成的东西:
#   组织 ai-skills,仓库 ai-skills/team-skills(内容取自 fixtures/team-skills-repo/)
#   用户 skillsync-admin  —— 仓库写权限,验证「直推」路径
#   用户 skillsync-reader —— 仓库只读,验证「无写权限自动走提交审核」路径
#   两个用户的访问令牌写入 fixtures/.env.local(已在 .gitignore 中,勿提交)
set -euo pipefail

cd "$(dirname "$0")"

BASE_URL="http://127.0.0.1:3300"
ADMIN_USER="skillsync-admin"
ADMIN_PASS="skillsync-admin-pw"
READER_USER="skillsync-reader"
READER_PASS="skillsync-reader-pw"
ORG="ai-skills"
REPO="team-skills"
ENV_FILE=".env.local"

log() { printf '\033[1m▸\033[0m %s\n' "$*"; }

if [[ "${1:-}" == "--reset" ]]; then
  log "清空既有 fixture 实例"
  docker compose down -v
fi

log "启动 Gitea"
docker compose up -d

log "等待 Gitea 就绪"
for i in $(seq 1 60); do
  if curl -fsS "$BASE_URL/api/healthz" >/dev/null 2>&1; then break; fi
  if [[ $i -eq 60 ]]; then
    echo "Gitea 在 3 分钟内未就绪,查看日志:docker compose -f fixtures/docker-compose.yml logs" >&2
    exit 1
  fi
  sleep 3
done

# 首个管理员只能用 CLI 建(此时还没有任何可认证的身份)。
# 容器里必须以 git 用户执行:Gitea 拒绝以 root 运行,而 docker compose exec 默认就是 root。
create_user() {
  local user=$1 pass=$2 admin_flag=$3
  if docker compose exec -T -u git gitea gitea admin user list 2>/dev/null | awk '{print $2}' | grep -qx "$user"; then
    log "用户 $user 已存在"
    return
  fi
  log "创建用户 $user"
  docker compose exec -T -u git gitea gitea admin user create \
    --username "$user" --password "$pass" --email "$user@fixture.local" \
    --must-change-password=false $admin_flag >/dev/null
}

create_user "$ADMIN_USER" "$ADMIN_PASS" "--admin"
create_user "$READER_USER" "$READER_PASS" ""

# 令牌:同名令牌重复创建会 400,失败就重建一次
issue_token() {
  local user=$1 pass=$2
  local resp
  resp=$(curl -fsS -X POST "$BASE_URL/api/v1/users/$user/tokens" \
    -u "$user:$pass" -H 'Content-Type: application/json' \
    -d '{"name":"skillsync-fixture","scopes":["write:user","write:organization","write:repository"]}' 2>/dev/null || true)
  if [[ -z "$resp" ]]; then
    curl -fsS -X DELETE "$BASE_URL/api/v1/users/$user/tokens/skillsync-fixture" -u "$user:$pass" >/dev/null 2>&1 || true
    resp=$(curl -fsS -X POST "$BASE_URL/api/v1/users/$user/tokens" \
      -u "$user:$pass" -H 'Content-Type: application/json' \
      -d '{"name":"skillsync-fixture","scopes":["write:user","write:organization","write:repository"]}')
  fi
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).sha1))' <<<"$resp"
}

log "签发访问令牌"
ADMIN_TOKEN=$(issue_token "$ADMIN_USER" "$ADMIN_PASS")
READER_TOKEN=$(issue_token "$READER_USER" "$READER_PASS")

api() {
  local method=$1 path=$2 body=${3:-}
  local args=(-sS -X "$method" "$BASE_URL/api/v1$path"
    -H "Authorization: token $ADMIN_TOKEN" -H 'Content-Type: application/json')
  [[ -n "$body" ]] && args+=(-d "$body")
  curl "${args[@]}"
}

if curl -fsS "$BASE_URL/api/v1/orgs/$ORG" -H "Authorization: token $ADMIN_TOKEN" >/dev/null 2>&1; then
  log "组织 $ORG 已存在"
else
  log "创建组织 $ORG"
  api POST /orgs "{\"username\":\"$ORG\",\"visibility\":\"public\"}" >/dev/null
fi

if curl -fsS "$BASE_URL/api/v1/repos/$ORG/$REPO" -H "Authorization: token $ADMIN_TOKEN" >/dev/null 2>&1; then
  log "仓库 $ORG/$REPO 已存在"
else
  log "创建仓库 $ORG/$REPO"
  api POST "/orgs/$ORG/repos" \
    "{\"name\":\"$REPO\",\"description\":\"SkillSync fixture 技能库\",\"auto_init\":true,\"default_branch\":\"main\"}" >/dev/null
fi

log "把 $READER_USER 加为只读协作者"
curl -sS -X PUT "$BASE_URL/api/v1/repos/$ORG/$REPO/collaborators/$READER_USER" \
  -H "Authorization: token $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"permission":"read"}' >/dev/null

log "灌入样例技能内容"
# 用的正是本 app 要打的多文件提交接口:init 阶段就把它跑一遍,接口不对会立刻暴露
PAYLOAD=$(node -e '
const { readdirSync, readFileSync, statSync } = require("fs");
const { join, relative } = require("path");
const root = "team-skills-repo";
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const files = walk(root).map((p) => ({
  operation: "create",
  path: relative(root, p).split(require("path").sep).join("/"),
  content: readFileSync(p).toString("base64"),
}));
process.stdout.write(JSON.stringify({
  branch: "main",
  message: "灌入 fixture 样例技能",
  files,
}));
')
RESP=$(api POST "/repos/$ORG/$REPO/contents" "$PAYLOAD")
if node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.exit(j.commit?0:1)})' <<<"$RESP" 2>/dev/null; then
  log "样例内容已提交"
else
  # 已存在时 create 会失败,这在重复执行时属正常
  log "样例内容疑似已存在,跳过(响应:$(head -c 160 <<<"$RESP"))"
fi

cat > "$ENV_FILE" <<EOF
# 由 fixtures/init.sh 生成,勿提交。Rust 集成测试从这里取连接信息。
SKILLSYNC_FIXTURE_GITEA_URL=$BASE_URL
SKILLSYNC_FIXTURE_ORG=$ORG
SKILLSYNC_FIXTURE_REPO=$REPO
SKILLSYNC_FIXTURE_ADMIN_USER=$ADMIN_USER
SKILLSYNC_FIXTURE_ADMIN_TOKEN=$ADMIN_TOKEN
SKILLSYNC_FIXTURE_READER_USER=$READER_USER
SKILLSYNC_FIXTURE_READER_TOKEN=$READER_TOKEN
EOF

log "完成。连接信息已写入 fixtures/$ENV_FILE"
log "Web 界面:$BASE_URL(管理员 $ADMIN_USER / $ADMIN_PASS)"
