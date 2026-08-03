# GitHub 分享写路径 ground truth(M3-5b 录制纪要)

录制时间:2026-08-03。目标:`dhslegen/skillsync-write-lab`(为录制新建的公开测试仓,
初始只有 README);录制用 classic PAT(repo scope),录后已作废。
所有 json 为真实请求/响应,已确认不含任何凭证。

## 结论(端点拍板的依据)

1. **多文件一次提交只有两条路**:GraphQL `createCommitOnBranch` 或 git-data 四连
   (blobs→tree→commit→ref)。REST contents API 一次只能一个文件——分享一个
   含脚本/模板的技能会拆成多笔提交,历史脏且中途失败会留半成品。
   **拍板:走 `createCommitOnBranch`**(03/06):
   - 输入:`branch{repositoryNameWithOwner,branchName}` + `expectedHeadOid` +
     `message{headline}` + `fileChanges{additions[{path,contents(base64)}],deletions[{path}]}`;
   - 响应:`data.createCommitOnBranch.commit{oid,url,committedDate}`;
   - 附带好处:提交自动带平台签名(verified),归属登录用户。
2. **错误形状**(io 已录):
   - 陈旧 `expectedHeadOid` → `errors[].type = "STALE_DATA"`(04)——对应分享
     预检里"远端已变化"的 stale 分支;
   - 分支保护直推 → `errors[].type = "BRANCH_PROTECTION_RULE_VIOLATION"`(09),
     message 含 "Changes must be made through a pull request";REST contents 的
     同场景是 HTTP 409(09b)。**判定用 errors[].type,不 grep message**。
3. **权限矩阵判据**:`GET /repos/{o}/{r}` 的 `permissions.push`(01 true / 01b false)。
   有 push → 直推或开分支+PR;无 push → fork+PR。`branches/{b}` 的 `protected`
   字段(08b)可先探,但**不作唯一判据**——保护规则可能只拦部分人,写失败时的
   `BRANCH_PROTECTION_RULE_VIOLATION` 才是最终真相,按"先试直推、按错误类型
   降级到 PR 路径"或"protected=true 直接走 PR"设计(倾向后者,少一次失败请求)。
4. **fork 异步但很快**(11):`POST /repos/{o}/{r}/forks` 返回 **202**,响应体
   已带 `full_name`;对 octocat/Hello-World 实测 **~3 秒**后 GET 仓库 200 且
   分支头可读。轮询节奏:1s 间隔、60s 超时足够富余。
   - fork 支持 `name` 参数(避开与用户既有仓重名)与 `default_branch_only`;
   - fork 后跨仓 PR 的 `head` 用 `{user}:{branch}` 形式(标准格式,未真实录制
     ——不向第三方仓库开真 PR,wiremock 钉住格式)。
5. **可执行位丢失**(03b):`createCommitOnBranch` 的 fileChanges 没有 mode 字段,
   `scripts/run.sh` 提交后 mode 为 `100644`(非 100755)。这与 Gitea 分享路径
   (ChangeFilesRequest 同样无 mode)是同款限制,**两侧行为一致,接受**;
   若未来要保真,需换 git-data API(tree 支持 100755),记为已知取舍。
6. Branch protection 管理端点(08/10,PUT/DELETE `/branches/{b}/protection`)
   仅录制用,app 不碰。

## 文件清单

| 文件 | 内容 |
|---|---|
| 01/01b | 有/无 push 权限的 repo 视图(permissions 判据) |
| 02 | 分支头(protected=false 基线) |
| 03 | createCommitOnBranch 请求模板 + 成功响应 |
| 03b | GraphQL 提交后的树 mode(脚本 100644,可执行位丢失) |
| 04 | 陈旧 expectedHeadOid → STALE_DATA |
| 05/06/07 | 开分支(REST git/refs)/ 分支上提交 / 开 PR(number=1) |
| 08/08b | 开启保护的请求响应 / protected=true 的分支视图 |
| 09/09b | 保护拒推:GraphQL BRANCH_PROTECTION_RULE_VIOLATION / REST 409 |
| 11 | fork 202 → ~3s 可用的时序 |

## 录后现场

- 测试仓留有 `skills/demo-skill`、分支 `skillsync/share-demo`、PR #1(open)、
  保护已摘——供实现期继续手动验证,实现完可整仓删除;
- `dhslegen/skillsync-fork-timing-lab`(Hello-World 的 fork)已无用,
  PAT 未授 delete_repo,**需用户手动删除**;
- PAT 用完即废(用户侧操作)。
