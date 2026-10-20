# dsh-github-push

给 DeepSeek Harness 的一个「安全推送」工具：**先列账号、让你选、再校仓库、最后才推**。

> A model-facing tool that pushes a Git repository to GitHub with an explicitly chosen local `gh` account — the account is never guessed.

## 它解决的问题

多 GitHub 账号的机器上，`git push` 用的是「当时活动的凭据」。选错账号的后果不是报错，而是**用别人的身份写入了远端**；被拒绝反而是运气好的情况。

这个工具把流程固定成四步，任何一步不满足就停下，不自动换账号重试：

| 步骤 | 行为 | 失败即停 |
|---|---|---|
| 1. 列身份 | `gh auth status --json hosts`，只取 `github.com` 下可用的账号；活动账号排最前 | 无可用账号 |
| 2. 让你选 | `ctx.userQuestions.ask()` 弹单选，选项附 scopes 与「当前活动账号」 | 空选 |
| 3. 校仓库 | 用**该账号** token 调 `gh api user`（身份必须一致）→ `gh api repos/{owner}/{repo}`（push 权限、是否归档、改名后的 full_name） | 身份不符 / 无权限 / 已归档 |
| 4. 推送 | `git push <remote> branch:branch`，token 只通过**子进程环境变量**交给 `credential.helper` | 认证 / 网络 / 保护分支 |

## 安全边界

- **不自己挑账号**：没有「默认账号」逻辑，选择永远来自人
- **不切换全局状态**：不调用 `gh auth switch`、不写 git config
- **token 不进 argv、不进输出**：只作为子进程环境变量存在；错误文本对 `ghp_…` 形态做脱敏
- **SSH remote 直接拒绝**：那种情况下选的账号根本不生效，会给出改成 HTTPS 的提示
- **force 需二次确认**：且使用 `--force-with-lease`
- **只推不提交**：不 add、不 commit、不改工作树

## 工具参数

| 参数 | 说明 |
|---|---|
| `cwd`（必填） | Git 工作树的绝对路径 |
| `remote` | 远端名，默认 `origin` |
| `branch` | 要推的分支，默认当前分支（`branch:branch`） |
| `follow_tags` | 同时推注解标签，默认 false |
| `force` | `--force-with-lease` + 二次确认，默认 false |
| `dry_run` | 只校验并报告，不写远端，默认 false |

## 安装

```text
plugin_manager install_bundle github:just-liuyi/dsh-github-push
```

装好后 Agent 的工具列表里会出现 `github_push`。

## 已知限制

- 仅支持 `github.com`，且只支持 HTTPS remote
- 依赖本机 `gh` CLI（≥ 2.40，需 `auth status --json`）与已登录账号
- 不做提交作者邮箱与账号归属的一致性校验（只在结果里回显 `head` 提交信息）
- 不处理 submodule / LFS 指针

## License

MIT
