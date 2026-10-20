/**
 * dsh-github-push — Host half.
 *
 * One model-facing tool that writes to a Git remote. The account is never
 * guessed: the tool lists the accounts `gh` knows, asks the user to pick one,
 * verifies that account can push to the repository, and only then pushes.
 *
 * Deliberately dependency-free: the bundle imports nothing, so it resolves the
 * same way from a profile install as from a checkout.
 */

export const name = 'github-push'

/** Services this plugin reads through `ctx`. */
export const inject = ['tools', 'userQuestions', 'subprocess']

/** GitHub host this tool works against. */
const HOST = 'github.com'

/** Per-stream cap for captured child output. */
const MAX_BYTES = 262144

/** Credential helper that answers git's password prompt from the child env. */
const TOKEN_HELPER = '!f() { echo username=x-access-token; echo "password=$GH_PUSH_TOKEN"; }; f'

/**
 * User-facing copy. The account dialog is read by a human, so it follows an
 * explicit language instead of the language of whoever is driving the tool.
 */
const COPY = {
  zh: {
    accountHeader: 'GitHub 账号',
    accountQuestion: (target) => `用哪个 GitHub 账号推送到 ${target}？`,
    activeNote: '当前活动账号',
    noScopes: '未记录 scope',
    forceHeader: '强制推送',
    forceQuestion: (repo, branch, sha) => `用 --force-with-lease 覆盖 ${repo} 的分支 "${branch}"（当前 ${sha}）？`,
    cancel: '取消',
    cancelHint: '保持远端分支不变。',
    force: '强制推送',
    forceHint: '替换远端分支；不在本分支上的提交会丢失。',
    noAccount: '未选择账号，未推送。',
    verified: (login, repo, branch, ahead) =>
      `校验通过：${login} 可推送到 ${repo}（分支 ${branch}，领先 ${ahead} 个提交）。未推送。`,
    forceDeclined: '未确认强制推送，未推送。',
    pushed: (branch, repo, login, notes) => `已用 ${login} 推送 ${branch} 到 ${repo}${notes}。`,
    tagsNote: '（含标签）',
    forceNote: '（force-with-lease）',
  },
  en: {
    accountHeader: 'GitHub account',
    accountQuestion: (target) => `Push ${target} with which GitHub account?`,
    activeNote: 'currently active',
    noScopes: 'no scopes recorded',
    forceHeader: 'Force push',
    forceQuestion: (repo, branch, sha) => `Rewrite ${repo} branch "${branch}" with --force-with-lease from commit ${sha}?`,
    cancel: 'Cancel',
    cancelHint: 'Leave the remote branch as it is.',
    force: 'Force push',
    forceHint: 'Replace the remote branch; commits not in this branch are lost.',
    noAccount: 'No account was chosen, so nothing was pushed.',
    verified: (login, repo, branch, ahead) =>
      `Verified: ${login} can push to ${repo} (branch ${branch}, ${ahead} commit(s) ahead). Nothing was pushed.`,
    forceDeclined: 'The force push was not confirmed, so nothing was pushed.',
    pushed: (branch, repo, login, notes) => `Pushed ${branch} to ${repo} as ${login}${notes}.`,
    tagsNote: ' (with tags)',
    forceNote: ' (force-with-lease)',
  },
}

/**
 * Pick the copy table: row config first, then an environment override, then
 * Chinese. `auto` follows the host system locale.
 */
function copyFor(config) {
  const fromEnv = typeof process.env.DSH_GITHUB_PUSH_LANGUAGE === 'string'
    ? process.env.DSH_GITHUB_PUSH_LANGUAGE.trim().toLowerCase()
    : ''
  const requested = config && typeof config.language === 'string' ? config.language.trim().toLowerCase() : ''
  const choice = requested || fromEnv || 'zh'
  if (choice === 'zh' || choice === 'en') return COPY[choice]
  let locale = ''
  try {
    locale = new Intl.DateTimeFormat().resolvedOptions().locale || ''
  } catch {
    locale = ''
  }
  return /^zh/i.test(locale) ? COPY.zh : COPY.en
}

function textOf(reader) {
  if (!reader) return ''
  try {
    return reader.readFrom(0).text
  } catch {
    return ''
  }
}

/** Hide anything that looks like a GitHub token before it reaches the model. */
function redact(text) {
  return String(text ?? '').replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, 'ghp_***')
}

/** Run one child process and collect its bounded output. */
async function run(ctx, argv, options) {
  const handle = ctx.subprocess.spawn({
    argv,
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: MAX_BYTES },
      stderr: { maxBytes: MAX_BYTES },
    },
    graceMs: 5000,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const outcome = await handle.done
  return {
    code: outcome.exitCode,
    stdout: textOf(handle.collected.stdout),
    stderr: textOf(handle.collected.stderr),
  }
}

async function git(ctx, args, options) {
  return run(ctx, ['git', ...args], options)
}

/** Bounded, redacted detail for an error message (never used for token reads). */
function detailOf(result) {
  return redact((result.stderr || result.stdout || '').trim()).slice(0, 800)
}

/** Split a remote URL into its scheme, host, and `owner/repo` slug. */
function parseRemote(url) {
  const https = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)\/?$/.exec(url)
  if (https) return { scheme: 'https', host: https[1].toLowerCase(), slug: stripGit(https[2]) }
  const ssh = /^(?:ssh:\/\/)?(?:[^@/]+@)?([^:/]+)[:/](.+?)\/?$/.exec(url)
  if (ssh) return { scheme: 'ssh', host: ssh[1].toLowerCase(), slug: stripGit(ssh[2]) }
  return undefined
}

function stripGit(path) {
  return path.replace(/\.git$/, '').replace(/\/+$/, '')
}

/** Read the accounts `gh` can act as on the requested host. */
async function listAccounts(ctx, cwd, signal) {
  const status = await run(ctx, ['gh', 'auth', 'status', '--json', 'hosts'], { cwd, signal })
  if (status.code !== 0) {
    throw new Error(`gh auth status failed: ${detailOf(status) || `exit ${status.code}`}`)
  }
  let hosts
  try {
    hosts = JSON.parse(status.stdout).hosts ?? {}
  } catch {
    throw new Error('gh auth status returned output this tool could not read')
  }
  const accounts = (hosts[HOST] ?? [])
    .filter((entry) => entry && entry.state === 'success' && typeof entry.login === 'string')
    .map((entry) => ({
      login: entry.login,
      scopes: typeof entry.scopes === 'string' ? entry.scopes : '',
      active: entry.active === true,
    }))
  accounts.sort((a, b) => Number(b.active) - Number(a.active) || a.login.localeCompare(b.login))
  return accounts
}

/** Ask the user which account to push with; returns a login or undefined. */
async function chooseAccount(ctx, accounts, exec, target, t) {
  const answer = await ctx.userQuestions.ask({
    questions: [
      {
        id: 'account',
        header: t.accountHeader,
        question: t.accountQuestion(target),
        options: accounts.map((account) => ({
          label: account.login,
          description: `${account.scopes || t.noScopes}${account.active ? ` · ${t.activeNote}` : ''}`,
        })),
      },
    ],
    agent: exec.agent,
    signal: exec.signal,
    wait: { callId: exec.callId },
  })
  const item = answer.answers.find((entry) => entry.id === 'account')
  if (!item) return undefined
  const picked = item.selected[0] ?? (item.custom ? item.custom.trim() : '')
  return picked ? accounts.find((account) => account.login === picked) : undefined
}

/** Verify the chosen account, then the repository's writability. */
async function verifyIdentity(ctx, login, cwd, signal) {
  const token = await run(ctx, ['gh', 'auth', 'token', '--user', login], { cwd, signal })
  const value = token.stdout.trim()
  if (token.code !== 0 || value === '') {
    throw new Error(`gh has no usable token for ${login}: ${detailOf(token) || 'empty token'}`)
  }
  const env = { GH_TOKEN: value, GH_NO_UPDATE_NOTIFIER: '1' }
  const who = await run(ctx, ['gh', 'api', 'user', '--jq', '.login'], { cwd, env, signal })
  if (who.code !== 0) throw new Error(`${login} cannot authenticate: ${detailOf(who)}`)
  const actual = who.stdout.trim()
  if (actual !== login) {
    throw new Error(`gh returned a token for "${actual}" instead of "${login}"; refusing to push`)
  }
  return { token: value, env }
}

async function verifyRepository(ctx, env, slug, cwd, signal) {
  const api = await run(ctx, ['gh', 'api', `repos/${slug}`], { cwd, env, signal })
  if (api.code !== 0) {
    throw new Error(`cannot read repository ${slug}: ${detailOf(api)}`)
  }
  let repo
  try {
    repo = JSON.parse(api.stdout)
  } catch {
    throw new Error(`repository ${slug} returned output this tool could not read`)
  }
  const fullName = typeof repo.full_name === 'string' ? repo.full_name : slug
  const pushAllowed = repo.permissions?.push === true
  return {
    fullName,
    private: repo.private === true,
    pushAllowed,
    archived: repo.archived === true,
    defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : '',
  }
}

/** Register the push tool. */
export function apply(ctx, config) {
  const t = copyFor(config)
  const definition = {
    name: 'github_push',
    description:
      'Push a Git repository to GitHub with an explicitly chosen local `gh` account: lists the accounts `gh` holds, asks the user which one to use, verifies that account can push to the remote repository, then pushes the branch. It never commits and never picks an account on its own; an SSH remote is refused because the account choice would not apply. Set dry_run to run the checks and report without writing to the remote.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['cwd'],
      properties: {
        cwd: {
          type: 'string',
          description: 'Absolute path of the Git working tree to push.',
        },
        remote: {
          type: 'string',
          description: 'Remote name to push to. Defaults to "origin".',
        },
        branch: {
          type: 'string',
          description: 'Branch to push, as `branch:branch`. Defaults to the branch checked out in cwd.',
        },
        follow_tags: {
          type: 'boolean',
          description: 'Also push annotated tags reachable from the pushed commits. Defaults to false.',
        },
        force: {
          type: 'boolean',
          description:
            'Push with --force-with-lease after a second confirmation. Set it only when the user asked to rewrite remote history. Defaults to false.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Verify the account and repository and report what would be pushed, without writing to the remote. Defaults to false.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['pushed', 'dryRun', 'message'],
        properties: {
          pushed: { type: 'boolean', description: 'Whether this call wrote to the remote.' },
          dryRun: { type: 'boolean', description: 'Whether the call was verify-only.' },
          account: {
            type: 'object',
            additionalProperties: false,
            required: ['login'],
            properties: {
              login: { type: 'string' },
              active: { type: 'boolean' },
              scopes: { type: 'string' },
            },
          },
          repo: {
            type: 'object',
            additionalProperties: false,
            required: ['fullName'],
            properties: {
              fullName: { type: 'string' },
              private: { type: 'boolean' },
              pushAllowed: { type: 'boolean' },
              archived: { type: 'boolean' },
              defaultBranch: { type: 'string' },
            },
          },
          remote: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              scheme: { type: 'string' },
              url: { type: 'string' },
            },
          },
          branch: { type: 'string' },
          ahead: { type: 'integer', description: 'Commits not yet on the upstream branch; null when the branch has no upstream.' },
          commits: { type: 'array', items: { type: 'string' } },
          head: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const input = args ?? {}
      const cwd = typeof input.cwd === 'string' ? input.cwd.trim() : ''
      if (!cwd) throw new Error('cwd is required: pass the absolute path of the Git working tree')
      if (!exec.agent) throw new Error('choosing a GitHub account needs a live agent')

      const remoteName = typeof input.remote === 'string' && input.remote.trim() ? input.remote.trim() : 'origin'
      const dryRun = input.dry_run === true
      const force = input.force === true
      const followTags = input.follow_tags === true

      const top = await git(ctx, ['rev-parse', '--show-toplevel'], { cwd, signal: exec.signal })
      if (top.code !== 0) throw new Error(`not a Git working tree: ${cwd} (${detailOf(top)})`)
      const root = top.stdout.trim()

      const remoteUrl = await git(ctx, ['remote', 'get-url', remoteName], { cwd: root, signal: exec.signal })
      if (remoteUrl.code !== 0) throw new Error(`remote "${remoteName}" does not exist in ${root}`)
      const remote = parseRemote(remoteUrl.stdout.trim())
      if (remote === undefined) throw new Error(`cannot read the remote URL: ${remoteUrl.stdout.trim()}`)
      if (remote.host !== HOST) throw new Error(`remote host is ${remote.host}; this tool pushes to ${HOST} only`)
      if (remote.scheme !== 'https') {
        throw new Error(
          `remote "${remoteName}" uses ${remote.scheme}; the selected gh account would not be used. Point the remote at https://${remote.host}/${remote.slug}.git or push without this tool.`,
        )
      }

      const warnings = []
      const accounts = await listAccounts(ctx, root, exec.signal)
      if (accounts.length === 0) throw new Error('no GitHub account is signed in to gh; run `gh auth login` first')

      const chosen = await chooseAccount(ctx, accounts, exec, remote.slug, t)
      if (chosen === undefined) {
        return {
          pushed: false,
          dryRun,
          remote: { name: remoteName, scheme: remote.scheme, url: remoteUrl.stdout.trim() },
          warnings,
          message: t.noAccount,
        }
      }

      const { token, env } = await verifyIdentity(ctx, chosen.login, root, exec.signal)
      const repo = await verifyRepository(ctx, env, remote.slug, root, exec.signal)

      if (repo.archived) throw new Error(`repository ${repo.fullName} is archived and cannot be pushed to`)
      if (!repo.pushAllowed) {
        throw new Error(`${chosen.login} does not have push permission on ${repo.fullName}`)
      }
      if (repo.fullName.toLowerCase() !== remote.slug.toLowerCase()) {
        warnings.push(
          `the repository moved: ${remote.slug} is now ${repo.fullName}. Git follows the redirect; update the remote when convenient.`,
        )
      }

      const branchResult =
        typeof input.branch === 'string' && input.branch.trim()
          ? { code: 0, stdout: input.branch.trim(), stderr: '' }
          : await git(ctx, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, signal: exec.signal })
      if (branchResult.code !== 0) throw new Error(`cannot read the current branch: ${detailOf(branchResult)}`)
      const branch = branchResult.stdout.trim()
      if (branch === 'HEAD') throw new Error('HEAD is detached; check out a branch before pushing')

      const aheadResult = await git(ctx, ['rev-list', '--count', '@{u}..HEAD'], { cwd: root, signal: exec.signal })
      const ahead = aheadResult.code === 0 ? Number(aheadResult.stdout.trim()) : null
      if (ahead === null) warnings.push(`branch "${branch}" has no upstream; pushing will set the remote branch directly.`)

      const range = ahead === null ? ['HEAD'] : ['@{u}..HEAD']
      const listResult = await git(
        ctx,
        ['log', '--pretty=%h %s', '-n', '10', ...range],
        { cwd: root, signal: exec.signal },
      )
      const commits = listResult.code === 0
        ? listResult.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
        : []
      const headResult = await git(ctx, ['log', '-1', '--pretty=%h %an <%ae> %s'], { cwd: root, signal: exec.signal })
      const head = headResult.code === 0 ? headResult.stdout.trim() : ''

      const report = {
        pushed: false,
        dryRun,
        account: { login: chosen.login, active: chosen.active, scopes: chosen.scopes },
        repo,
        remote: { name: remoteName, scheme: remote.scheme, url: remoteUrl.stdout.trim() },
        branch,
        ahead,
        commits,
        head,
        warnings,
      }

      if (dryRun) {
        return {
          ...report,
          message: t.verified(chosen.login, repo.fullName, branch, ahead ?? '?'),
        }
      }

      if (force) {
        const approval = await ctx.userQuestions.ask({
          questions: [
            {
              id: 'force',
              header: t.forceHeader,
              question: t.forceQuestion(repo.fullName, branch, head.split(' ')[0] ?? 'HEAD'),
              options: [
                { label: t.cancel, description: t.cancelHint },
                { label: t.force, description: t.forceHint },
              ],
            },
          ],
          agent: exec.agent,
          signal: exec.signal,
          wait: { callId: exec.callId },
        })
        const answer = approval.answers.find((entry) => entry.id === 'force')
        if (!answer || answer.selected[0] !== t.force) {
          return { ...report, message: t.forceDeclined }
        }
      }

      const pushArgv = [
        'git',
        '-c',
        'credential.helper=',
        '-c',
        `credential.helper=${TOKEN_HELPER}`,
        'push',
        remoteName,
        ...(force ? ['--force-with-lease'] : []),
        ...(followTags ? ['--follow-tags'] : []),
        `${branch}:${branch}`,
      ]
      const push = await run(ctx, pushArgv, {
        cwd: root,
        env: { GH_PUSH_TOKEN: token, GIT_TERMINAL_PROMPT: '0' },
        signal: exec.signal,
      })
      if (push.code !== 0) throw new Error(`git push failed: ${detailOf(push)}`)

      const after = await git(ctx, ['rev-list', '--count', '@{u}..HEAD'], { cwd: root, signal: exec.signal })
      const remaining = after.code === 0 ? Number(after.stdout.trim()) : null
      if (remaining !== null && remaining > 0) {
        warnings.push(`${remaining} commit(s) still differ from the upstream branch after the push.`)
      }

      return {
        ...report,
        pushed: true,
        ahead: remaining,
        message: t.pushed(
          branch,
          repo.fullName,
          chosen.login,
          `${followTags ? t.tagsNote : ''}${force ? t.forceNote : ''}`,
        ),
      }
    },
  }

  ctx.effect(() => ctx.tools.register(definition), 'github-push: tool')
}
