# fixtures/

测试环境(规格见 docs/开发交接包 3.6),M1 任务 4 开发前建好并跑起来:

- `docker-compose.yml`:Gitea 1.24 + 初始化脚本(建 org/repo/测试用户×2:有写权限/只读)
- `team-skills-repo/`:样例仓库内容(good-skill / with-scripts / taken-name / bad-frontmatter / curated.json),由 init 脚本推入 fixture Gitea
