# Gitea 分享权限预检 ground truth(M4 任务 2 录制纪要)

录制时间:2026-08-04。目标:本地 docker fixture(`fixtures/init.sh` 起的 Gitea 1.25.3,
`ai-skills/team-skills`)。三种身份:`skillsync-admin`(管理员)/ `skillsync-writer`
(**普通写权限协作者,本次录制新建并已加进 init.sh**)/ `skillsync-reader`(只读协作者)。
录制过程对 main 临时加过分支保护,录完已拆除并确认现场恢复(见文末)。

## 结论(预检判据的依据)

### 1. `permissions.push` 单独用会说谎

`GET /repos/{owner}/{repo}` 的 `permissions.push` **只表示"对仓库有写权限"**,
不含分支保护。main 受保护时它**仍然是 true**,而直推必然 403。
M3 的 `submit_gitea` 因此只能"先试直推、403 再降级",预检若照抄这个判据,
就会对着一个必定走评审的场景预告"会直接生效"——那是假话。

### 2. `GET /repos/{o}/{r}/branches/{branch}` 的 `user_can_push` 才是准确判据

它把「仓库写权限」与「该分支的保护规则」**合并**成一个答案,且**只读用户也读得到**
(不需要 admin 权限,不像 `branch_protections` 端点)。实测矩阵:

| 场景 | `permissions.push` | `protected` | `user_can_push` |
|---|---|---|---|
| 未保护 + 管理员 | true | false | **true** |
| 未保护 + 普通写权限 | true | false | **true** |
| 未保护 + 只读 | false | false | false |
| 受保护 + 管理员 | true | true | **false** |
| 受保护 + 普通写权限 | true | true | **false** |
| 受保护 + 只读 | false | true | false |

**管理员在受保护分支上也是 `user_can_push=false`**(Gitea 不给管理员默认豁免),
所以不必为管理员另开一档。

### 3. 两个字段合起来才能分出三条提交路径

`user_can_push` 为 false 时分不出「有写权限但分支受保护」与「只读」——而这两档的
去向完全不同(前者在本库开分支评审,后者要 fork 到自己名下跨库评审)。判据组合:

| `user_can_push` | `permissions.push` | 预告的路径 | 对应 `submit_gitea` 分支 |
|---|---|---|---|
| true | (true) | 直接生效 | 直推 |
| false | true | 提交审核(本库开分支) | 403 降级那条 |
| false | false | 提交审核(先复制一份到你名下) | fork + 跨库评审 |

### 4. 与实际行为一致性已实证(这条不验就可能反向撒谎)

`skillsync-writer` 对受保护的 main:
- 直推 `POST /repos/{o}/{r}/contents` → **403** `user cannot commit to repo [user: skillsync-writer]`
- 带 `new_branch` 开分支提交 → **201**

即 `user_can_push=false` 与"直推真的会失败"完全对上,预检不会预告一个实际能成的直推。

### 5. 匿名与只读的 `permissions` 完全相同

都是 `{admin:false, push:false, pull:true}`。**permissions 分不出"未登录"与"只读"**,
预检必须靠登录态另判——分享本来就要求登录(`share_source` 取不到凭证即 `AUTH_REQUIRED`),
所以预检也只在已登录时才发。

## 录制物

- `branch-unprotected-writer.json` —— 未保护 + 普通写权限的 branches 响应(裁掉 `commit` 大块)
- `repo-readonly.json` —— 只读身份看到的 repos 响应(只留判据相关的三个字段)

受保护那一档没有落文件:它与未保护版的差别只有 `protected`/`user_can_push` 两个布尔,
上面的矩阵已经把值写死;wiremock 测试直接按矩阵构造响应,不需要再存一份近乎相同的 json。

## 现场恢复

分支保护已 `DELETE /branch_protections/main`(204),探测分支 `probe-branch` 已删(204),
`probe-writer.txt` 未进 main(直推被 403 挡下)。复查:`protected=false`、
`user_can_push=true`、分支只剩 `main` 与既有的 `store-perf-50`。

`skillsync-writer` 用户保留,并已写进 `fixtures/init.sh`(幂等):它补上了 fixture 缺的
「普通写权限」这一档——真实公司场景正是"普通员工有写权限 + main 受保护"(CLAUDE.md 关键事实)。

## GitHub 侧(未在本次录制范围内)

`github.rs` 的 `repo_view` 已有 `permissions.push` 与 `default_branch`。GitHub 的分支保护
**预检不到**:REST 的 branch-protection 端点要 admin 权限,普通协作者读不到;M3-5b 的判据
是提交时刻 GraphQL 的 `errors[].type = BRANCH_PROTECTION_RULE_VIOLATION`(试了才知道)。
因此 GitHub 源的预检只给两档:有写权限 → "可能直接生效,受保护时会转为提交审核";
无写权限 → "会复制一份到你名下再提交审核"。**不假装能预知分支保护**。
