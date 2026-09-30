/* 合并进 main 之后，自动在调用方仓库打下一个 vX.Y.Z tag。

   **这份文件是组合动作 `.github/actions/tag-on-merge` 的一部分，各仓库共用这一份**，
   通过 `.github/workflows/tag-on-merge.yml` 那个可复用工作流被调到各仓库的 job 里
   （caller 模板在 adopt/templates/tag-on-merge.yml）。它打的是**调用方仓库**的 tag——
   在 dev-infra 自己身上，打的就是各仓 caller 里那一行 `uses: …@vX.Y.Z` 钉的版本号。
   本地跑法（在要打 tag 的那个仓库根下）：node <这份文件> [--dry-run]

   ## 它替人做的是哪一步

   以前每个仓合并之后都要人手打 tag（agent 在会话环境里打 tag 拿 403），
   漏打、晚打的代价在 dev-infra 身上最贵：「先打 tag，再合 caller」那条顺序没人兜着。

   ## 版本号怎么定

   **默认 minor。** 这不是拍脑袋：接这条流水线之前，dev-infra 的 v1.1.0~v1.18.0、
   dev-agents 的 v1.0.0~v1.3.0、dev-standards 的 v1.0.0 全是人手打的，没有一个是
   patch 或 major——连纯修 bug、删掉一整个机制的那几次也是 minor。
   默认值照抄的是这几个仓实际的做法，不是某个工具的默认。

   要偏离默认，在 PR 上挂**恰好一个**这几个标签（名字见下面 RELEASE_LABELS，
   清单在 `.github/actions/labels-sync/labels.release.json`，由 labels-sync 的
   `release-labels: true` 建进调用方仓库；**没建之前挂不上，一律按默认 minor 打**）：

   | 标签 | 意思 |
   |---|---|
   | `release/major` | breaking change：各仓照旧升那一行 `uses:` 会坏 |
   | `release/patch` | 很小的改动：修 bug、措辞，行为契约不变 |
   | `release/skip`  | 这个 PR 单独不值得一个新版本（纯 README 之类） |

   **一次运行看的不是「刚合进来的那一个 PR」，而是「上一个 tag 到 main 的 tip 之间
   合进来的所有 PR」**，取其中最高的那一级（`release/skip` 不算级别；全是 skip 就不打）。
   这样哪一次运行被排队挤掉、哪一次因为标签没挂对红了，下一次运行都会把它们一起算进来，
   不会漏掉谁、也不会把一个 minor 降成 patch。

   ## 为什么打在「运行那一刻 main 的 tip」，而不是触发这次运行的那个 commit

   **`GITHUB_TOKEN` 给一个不是分支 tip 的 commit 建 tag，只要那个 commit 的
   `.github/workflows/` 和 tip 不一样，就会被拒**（"refusing to allow a GitHub App
   to create or update workflow … without `workflows` permission"，而 `GITHUB_TOKEN`
   拿不到 `workflows` 权限）。GitHub 把「新建一个 tag」当成「按那个 commit 的内容
   创建 workflow 文件」，拿它去和分支 tip 比。所以一旦排在前面的某次合并改过
   workflow，给旧 commit 补 tag 这条路就不通了。打在 tip 上，比较永远是「和自己比」。

   建的那一刻 tip 又往前走了（又有人合了一个改 workflow 的 PR），这次建 tag 会被拒——
   那时重新 fetch、按新 tip 重算一遍再建，最多 MAX_ROUNDS 轮。

   ## 失败方向

   **判不了就不打，而且出声**（非零退出，main 上那次运行是红的）。不打的代价是
   「这一版暂时没有 tag」——和今天漏打一样，但现在看得见；打错的代价是一个
   **永远收不回来的版本号**（tag 不移动），所以两边不对称，宁可不打。

   - 标签自相矛盾（同一个 PR 挂了两个 release/*）→ 红
   - main 上某个 commit 找不到把它合进来的 PR（直推？）→ 红，判不了它该算哪一级
   - 最新的 vX.Y.Z 不在 main 的历史上 → 红，「下一个」无从算起
   - 要建的 tag 已经存在（服务端 422）→ 红，**绝不覆盖、绝不移动**：这个脚本只调 POST
     /git/refs（只建不改），没有 PATCH、没有 force，由测试钉着

   修好之后（改标签、或者人手打一个 tag 越过去），在 Actions 里重跑失败的那一次，
   或者手动触发一次 tag-on-merge——两者都是重新读 GitHub 上此刻的标签。

   **只认 main、只认严格的 vX.Y.Z**：一个仓的默认分支不叫 main，或者 tag 是别的形状，
   这份脚本会出声地判不了（不会猜），接之前先看一眼。 */
const { execFileSync } = require("child_process");

/* 这条路只认 main：和 caller 模板（adopt/templates/tag-on-merge.yml）里
   `branches: [main]` 是同一处真相的两半，由测试比对。 */
const BRANCH = "main";

const RELEASE_LABELS = {
  major: "release/major",
  patch: "release/patch",
  skip: "release/skip",
};

const DEFAULT_LEVEL = "minor";

/* 高的在前：aggregate 取最高的那一级。 */
const LEVEL_ORDER = ["major", "minor", "patch"];

const MAX_ROUNDS = 3;

/* commit 刚合进来的那几秒，「这个 commit 是哪个 PR 合进来的」偶尔还查不到。
   查不到就等一会儿再查；这几次都查不到才算判不了。 */
const PR_LOOKUP_ATTEMPTS = 3;
const PR_LOOKUP_WAIT_MS = 5000;

/* —— 版本号 —— */

/** 只认严格的 vMAJOR.MINOR.PATCH。`v1`（挪 tag 时代留下来的那个）、`v1.2.3-rc.1`、
    前导零一律不算——它们不是这条序列里的版本，拿它们算「下一个」会算错。 */
function parseVersion(tag) {
  const m = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(tag));
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

function compareVersions(a, b) {
  return (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
}

function formatVersion(v) {
  return `v${v.major}.${v.minor}.${v.patch}`;
}

/** [{name, sha}] → 版本号最大的那一个（按数值比，不按字典序：v1.10.0 > v1.9.0）。 */
function latestTag(tags) {
  let best = null;
  for (const t of tags) {
    const v = parseVersion(t.name);
    if (v && (!best || compareVersions(v, best.version) > 0)) best = { ...t, version: v };
  }
  return best;
}

function bumpVersion(v, level) {
  if (level === "major") return { major: v.major + 1, minor: 0, patch: 0 };
  if (level === "minor") return { major: v.major, minor: v.minor + 1, patch: 0 };
  if (level === "patch") return { major: v.major, minor: v.minor, patch: v.patch + 1 };
  throw new Error("不认识的级别：" + level);
}

/* —— 标签 → 级别 —— */

/** 一个 PR 算哪一级。返回 { level, reason } 或 { error }。
    标签名按不区分大小写比：GitHub 上一个仓里标签名本来就不区分大小写，
    而这里比错的方向是「想要 major、拿到 minor」，而且不报错。 */
function classifyPr(pr) {
  const names = (pr.labels || []).map(l => String(typeof l === "string" ? l : l && l.name).toLowerCase());
  const hits = Object.entries(RELEASE_LABELS).filter(([, name]) => names.includes(name.toLowerCase()));
  if (hits.length > 1) {
    return { error: `#${pr.number} 同时挂着 ${hits.map(([, n]) => n).join(" 和 ")}，自相矛盾——只留一个` };
  }
  if (hits.length === 0) return { level: DEFAULT_LEVEL, reason: `没挂 release/* 标签，按默认 ${DEFAULT_LEVEL}` };
  const [level, name] = hits[0];
  return { level, reason: `挂着 ${name}` };
}

/** 把一段区间里的 PR 合成一个结论。prs 已去重。
    返回 { level: 'major'|'minor'|'patch'|null, rows, errors }；level 为 null 表示全是 skip。 */
function aggregate(prs) {
  const rows = [], errors = [];
  let best = null;
  for (const pr of prs) {
    const c = classifyPr(pr);
    if (c.error) { errors.push(c.error); continue; }
    rows.push({ number: pr.number, title: pr.title || "", level: c.level, reason: c.reason });
    if (c.level === "skip") continue;
    if (best === null || LEVEL_ORDER.indexOf(c.level) < LEVEL_ORDER.indexOf(best)) best = c.level;
  }
  return { level: best, rows, errors };
}

/* —— git —— */

function makeGit(cwd) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const isAncestor = (a, b) => {
    try { git("merge-base", "--is-ancestor", a, b); return true; }
    catch (e) { if (e.status === 1) return false; throw e; }
  };
  return { git, isAncestor };
}

/** 本地所有 tag，annotated 的剥到它指的那个 commit。 */
function listTags(git) {
  const out = git("for-each-ref", "--format=%(refname:strip=2) %(objectname) %(*objectname)", "refs/tags");
  if (!out) return [];
  return out.split("\n").map(line => {
    const [name, obj, peeled] = line.split(" ");
    return { name, sha: peeled || obj };
  });
}

/* —— GitHub API —— */

/* 没有 token 时不带 Authorization（本地 --dry-run 读公开仓库用得上）；
   带一个 "Bearer undefined" 过去只会换来 401。 */
function apiHeaders(token) {
  const h = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "dev-infra-tag-on-merge",
  };
  if (token) h.Authorization = "Bearer " + token;
  return h;
}

async function readError(res) {
  try {
    const body = await res.json();
    return body && body.message ? `HTTP ${res.status}：${body.message}` : `HTTP ${res.status}`;
  } catch { return `HTTP ${res.status}`; }
}

/** 把这个 commit 合进 main 的那几个 PR（通常恰好一个）。 */
async function mergedPrsFor(opts, sha) {
  const { api, repo, token } = opts;
  const doFetch = opts.fetchImpl || fetch;
  const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  for (let attempt = 1; attempt <= PR_LOOKUP_ATTEMPTS; attempt++) {
    const res = await doFetch(`${api}/repos/${repo}/commits/${sha}/pulls?per_page=100`, { headers: apiHeaders(token) });
    if (!res.ok) throw new Error(`查 ${sha.slice(0, 7)} 是哪个 PR 合进来的失败：${await readError(res)}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error(`查 ${sha.slice(0, 7)} 的 PR：响应不是数组`);
    const merged = body.filter(pr => pr && pr.merged_at && pr.base && pr.base.ref === BRANCH);
    if (merged.length) return merged;
    if (attempt < PR_LOOKUP_ATTEMPTS) await sleep(PR_LOOKUP_WAIT_MS);
  }
  return [];
}

/** 只建，不改：POST /git/refs 碰上已存在的 ref 返回 422，不会覆盖。
    **别在这儿加 PATCH 或 force**——tag 不移动是整套「钉 tag」的前提。 */
async function createTag(opts, name, sha) {
  const { api, repo, token } = opts;
  const doFetch = opts.fetchImpl || fetch;
  const res = await doFetch(`${api}/repos/${repo}/git/refs`, {
    method: "POST",
    headers: { ...apiHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "refs/tags/" + name, sha }),
  });
  if (res.ok) return { ok: true };
  return { ok: false, status: res.status, message: await readError(res) };
}

/* —— 主流程 —— */

/** 算一轮：从此刻 origin/main 的 tip 出发，判要不要打、打哪个。不写任何东西。
    返回 { kind: 'nothing'|'skip'|'tag'|'error', ... }。 */
async function planRound(opts) {
  const { git, isAncestor } = makeGit(opts.cwd);
  git("fetch", "--quiet", "--tags", "origin", `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`);
  const tip = git("rev-parse", `refs/remotes/origin/${BRANCH}^{commit}`);
  const tags = listTags(git);

  const latest = latestTag(tags);
  if (!latest) {
    return { kind: "error", tip, errors: ["仓库里一个 vX.Y.Z 形状的 tag 都没有，「下一个」无从算起——第一版请人手打"] };
  }

  const atTip = tags.filter(t => t.sha === tip && parseVersion(t.name));
  if (atTip.length) {
    return { kind: "nothing", tip, latest, message: `${BRANCH} 的 tip ${tip.slice(0, 7)} 已经有 tag：${atTip.map(t => t.name).join("、")}` };
  }
  if (isAncestor(tip, latest.sha)) {
    return { kind: "nothing", tip, latest, message: `${BRANCH} 的 tip ${tip.slice(0, 7)} 已经包含在 ${latest.name} 里` };
  }
  if (!isAncestor(latest.sha, tip)) {
    return {
      kind: "error", tip, latest,
      errors: [`最新的 ${latest.name}（${latest.sha.slice(0, 7)}）不在 ${BRANCH} 的历史上——是不是在别的分支上打过 tag？` +
        `「下一个版本」从哪儿往上加判不了，这一次请人来定`],
    };
  }

  /* --first-parent：只看主干上的那一串（squash 出来的 commit、merge commit、rebase 进来的
     那几个）。PR 分支里原来的 commit 不在这条线上，也不该各自去查一遍。 */
  const commits = git("rev-list", "--first-parent", `${latest.sha}..${tip}`).split("\n").filter(Boolean);
  const prs = new Map(), errors = [];
  for (const sha of commits) {
    const found = await mergedPrsFor(opts, sha);
    if (!found.length) {
      errors.push(`${sha.slice(0, 7)} 找不到把它合进 ${BRANCH} 的 PR（直推？），判不了它该算哪一级`);
      continue;
    }
    for (const pr of found) prs.set(pr.number, pr);
  }
  const agg = aggregate([...prs.values()].sort((a, b) => a.number - b.number));
  errors.push(...agg.errors);
  if (errors.length) return { kind: "error", tip, latest, rows: agg.rows, errors };
  if (agg.level === null) {
    return { kind: "skip", tip, latest, rows: agg.rows, message: `${latest.name} 之后合进来的 PR 全挂着 ${RELEASE_LABELS.skip}，这次不打` };
  }
  /* next 严格大于所有已知版本，本地不可能已有同名 tag。真撞上（这一刻别人刚建了它）
     是服务端 POST 返回 422，在 run() 里出声。 */
  const next = formatVersion(bumpVersion(latest.version, agg.level));
  return { kind: "tag", tip, latest, rows: agg.rows, level: agg.level, next };
}

/** 整个流程。dryRun 时只算不建。返回最后一轮的 plan，加上 created。 */
async function run(opts) {
  for (const [k, v] of [["仓库", opts.repo], ["API 地址", opts.api], ["工作目录", opts.cwd]]) {
    if (!v) throw new Error("缺少" + k);
  }
  if (!opts.dryRun && !opts.token) throw new Error("要建 tag 就得有 token（GITHUB_TOKEN）；只想看计划加 --dry-run");
  const log = opts.log || (() => {});
  let lastFailure = null;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const plan = await planRound(opts);
    if (plan.kind !== "tag" || opts.dryRun) return { ...plan, created: false };
    if (lastFailure && lastFailure.tip === plan.tip) break;

    const r = await createTag(opts, plan.next, plan.tip);
    if (r.ok) return { ...plan, created: true };

    /* 建失败了：先看 tip 动没动。动了 → 多半是「tip 往前走、这个 commit 的 workflow
       和新 tip 对不上」那条拒绝，按新 tip 重算一轮；没动 → 是真的失败，出声。 */
    log(`建 ${plan.next} → ${plan.tip.slice(0, 7)} 失败（${r.message}），重新 fetch 看 ${BRANCH} 有没有往前走`);
    lastFailure = { ...plan, failure: r };
    const { git } = makeGit(opts.cwd);
    git("fetch", "--quiet", "origin", `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`);
    const now = git("rev-parse", `refs/remotes/origin/${BRANCH}^{commit}`);
    if (now === plan.tip) break;
  }
  const f = lastFailure;
  const hint = f.failure.status === 422
    ? "（422 多半是这个 tag 刚被别人建了——不覆盖、不移动，请人来看）"
    : f.failure.status === 403 && /workflow/i.test(f.failure.message)
      ? `（${BRANCH} 的 tip 连着 ${MAX_ROUNDS} 轮都在往前走，每次建的时候那个 commit 已经不是 tip 了——等合并停下来，手动触发一次）`
      : f.failure.status === 403
        ? "（403：GITHUB_TOKEN 没有 contents: write，或者有一条 tag ruleset 不放 github-actions 过——那一层是人去仓库设置里点的）"
        : "";
  return { ...f, kind: "error", created: false, errors: [`建 ${f.next} 失败：${f.failure.message}${hint}`] };
}

function describe(r, dryRun) {
  const lines = [];
  if (r.rows && r.rows.length) {
    lines.push(`${r.latest.name} 之后合进 ${BRANCH} 的 PR：`);
    for (const row of r.rows) lines.push(`  #${row.number} ${row.level}（${row.reason}）${row.title ? "  " + row.title : ""}`);
  }
  if (r.kind === "tag") {
    const what = `${r.next} → ${r.tip.slice(0, 7)}（${r.latest.name} 的下一个 ${r.level}）`;
    lines.push(dryRun ? `dry-run：会打 ${what}，没有真的建` : `打了 ${what}`);
  } else if (r.message) {
    lines.push(r.message);
  }
  return lines.join("\n");
}

function summary(r, dryRun) {
  const out = ["## tag-on-merge", ""];
  if (r.kind === "tag") out.push(dryRun ? `dry-run：会打 **${r.next}**（没有真的建）` : `打了 **${r.next}** → \`${r.tip.slice(0, 7)}\``, "");
  else if (r.kind === "error") out.push("**没有打 tag**：", "", ...r.errors.map(e => "- " + e), "");
  else out.push(r.message, "");
  if (r.rows && r.rows.length) {
    out.push(`| PR | 级别 | 依据 |`, `|---|---|---|`);
    for (const row of r.rows) out.push(`| #${row.number} | ${row.level} | ${row.reason} |`);
  }
  return out.join("\n") + "\n";
}

async function main() {
  const argv = process.argv.slice(2);
  const unknown = argv.filter(a => a !== "--dry-run");
  /* 认不出的参数直接报错：`--dry_run` 被静默忽略的话，它会真的去建一个收不回来的 tag。 */
  if (unknown.length) throw new Error("认不出的参数：" + unknown.join(" ") + "（只认 --dry-run）");
  const dryRun = argv.includes("--dry-run");
  const r = await run({
    cwd: process.cwd(),
    api: (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, ""),
    repo: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
    dryRun,
    log: m => console.log(m),
  });
  console.log(describe(r, dryRun));
  if (process.env.GITHUB_STEP_SUMMARY) {
    require("fs").appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(r, dryRun));
  }
  if (r.kind === "error") {
    for (const e of r.errors) console.log("::error::" + e);
    process.exit(2);
  }
  if (r.kind === "tag" && r.created) console.log(`::notice::打了 ${r.next}`);
}

if (require.main === module) {
  main().catch(e => {
    console.log("::error::tag-on-merge 失败：" + (e && e.message ? e.message : e));
    process.exit(2);
  });
}

module.exports = {
  BRANCH, RELEASE_LABELS, DEFAULT_LEVEL, MAX_ROUNDS,
  parseVersion, compareVersions, formatVersion, latestTag, bumpVersion,
  classifyPr, aggregate, planRound, run, describe, summary,
};
