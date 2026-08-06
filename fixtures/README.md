# fixtures/

本地 Gitea 测试环境(交接包 3.6),供 Gitea client 的联调与端到端测试使用。

## 起环境

```bash
./fixtures/init.sh            # 幂等,可反复执行
./fixtures/init.sh --reset    # 连数据卷一起清掉,彻底重来
docker compose -f fixtures/docker-compose.yml down    # 停(保留数据)
```

脚本会建好:

| 对象 | 说明 |
|---|---|
| `ai-skills/team-skills` | 样例技能库,内容取自 `team-skills-repo/` |
| `skillsync-admin` | 仓库写权限,验证「直推」路径 |
| `skillsync-reader` | 仓库只读,验证「无写权限自动走提交审核」路径(决策 C3) |

连接信息与访问令牌写入 `fixtures/.env.local`(已在 `.gitignore` 中,不进版本控制)。
Rust 集成测试读取该文件;文件不存在时相关测试自动跳过,不会让 `cargo test` 失败。

## 样例技能

| 目录 | 用途 |
|---|---|
| `skills/good-skill` | 规范样例 |
| `skills/with-scripts` | 含 `run.sh`,验证详情页「含可执行脚本」警示角标 |
| `skills/taken-name` | 验证分享时的同名冲突预检 |
| `skills/bad-frontmatter` | 缺 description,验证跳过该目录且不影响同仓库其他技能 |
| `curated.json` | 首次启动向导的团队精选清单 |
| `tags.json` | 商店标签(M5 任务 3)。故意留了一个对不上任何目录的键,验证"多余条目被丢弃" |

## 版本说明

镜像固定在 `gitea/gitea:1.25.3`,与生产实例一致(决策 C1)。

交接包 3.6 原本写的是 1.24;此处有意对齐生产版本——本 fixture 要验证的多文件提交
(`POST /repos/{owner}/{repo}/contents`)与 PR 创建正是次版本之间可能存在差异的接口,
拿 1.24 验证却往 1.25.3 上线,等于没有验证。

`init.sh` 灌样例数据时走的就是多文件提交接口,因此环境起得来本身就说明该接口可用。
