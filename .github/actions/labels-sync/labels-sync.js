/* 把标签清单同步成调用方仓库的 GitHub 标签。

   **这份文件是组合动作 `.github/actions/labels-sync` 的一部分，各仓库共用这一份**，
   通过 `.github/workflows/labels-sync.yml` 那个可复用工作流被调到各仓库的 job 里。
   **清单也在这儿**（同目录的 labels.json），理由见下面 BASE_MANIFEST 那一段。
   为什么这么拆见本仓 README 与 GinkgoLeafLab/GTO-Trainer 仓的
   docs/方案/2026-09-跨仓库基础设施复用.md；清单机制本身的调研与取舍见那个仓的
   docs/方案/2026-09-标签用清单管理.md。

   ## 为什么标签值得一份清单

   有一批标签是各仓**流程的组成部分**：issue 分级的三档类别 + `sev/` + `status/`
   （各仓的 CLAUDE.md 与 issue 表单按名字引用它们），`review-passed` 喂各仓
   review-gate caller 的 job 级 if——而那条路写出来的 `review` 是主干的必需检查。

   **准确的名单不在这段注释里**：清单是同目录的 labels.json，而「哪些是非有不可的」
   由同目录的 labels.test.js 逐个字面量钉着。这里刻意不抄一份数字或枚举——
   抄了就是第二处真相，加一档类别时它会安静地过期（这段话上一次就是这么过期的）。

   这套东西的失效方式**是静默的**。GitHub 对「打一个不存在的标签」的处理是：

     "If a label does not already exist in the repository, it will not be
      automatically added to the issue."
     https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms

   名字差一个字符、或者标签压根没建，那一步不报错也不提示。同理，`review-passed`
   匹配不上时 gate job 连 runner 都不起，**表现和「没人派评审」一模一样**。
   清单进仓库之后，这套定义第一次有了能对照的地方，改它也走 PR。

   ## 这个脚本只做加和改，**永远不删**

   这是刻意的，不是没写完。GitHub 官方对删除的说明是：

     "Deleting a label will remove the label from issues and pull requests."
     https://docs.github.com/en/issues/using-labels-and-milestones-to-track-work/managing-labels

   标签本身能重建，**issue 上的关联不能**——Labels API 只有 POST / PATCH / DELETE
   三个动作，没有「恢复」。丢掉分级意味着把每一条 issue 的原始现象重看一遍。

   现成的同步工具多数默认就是删的：micnncim/action-label-syncer 的 README 写着
   「all existing labels which not listed in manifest will be deleted by default」，
   Financial-Times/github-label-sync 写着「Normally any additional labels found on
   the repo are deleted」。于是清单里漏写一个 `sev/major`，所有已分级的 issue
   当场变成未分级。**我们要的是这个能力压根不存在**，而不是靠一行配置挡着它——
   那行被删掉时 CI 是绿的、标签是没的。

   所以这里的失败方向是**安全的那一边**：判错的最坏结果是「多建一个标签」或者
   「什么都没做」，不是「抹掉了历史数据」。清单里没有的标签只报告，一个字节都不动。

   **改名同理不做。** 在 GitHub 上改名会保留 issue 关联，而「删旧建新」不会——
   脚本只按 name 匹配，改名请人去网页上点。 */
const fs = require("fs");
const path = require("path");

/* 基础清单和这份脚本一起下发——**它是共享的那一份**，各仓不再各存一份。
   为什么连清单也共享：标签的抽象意义各仓相同，描述的措辞差异只是细节，
   而「同一个标签三个仓三种颜色」（`review-passed` 实测就是）纯粹是漂移。

   **可选的那几组单独成文件**（今天只有 `labels.qa.json`）：`qa-required` /
   `qa-passed` 只该出现在真的有 qa-gate 的仓里。这不是措辞差异，是能力差异——
   把它们写进一个没有 QA 的仓，就等于给它们一份正式定义，而没有任何东西在读它们
   （GinkgoLeafLab/GTO-Trainer-engine 的 CLAUDE.md 有一整节写这件事）。
   调用方用**可重复的 `--manifest`** 点名要哪几份，见下面 main()。 */
const BASE_MANIFEST = path.join(__dirname, "labels.json");

/* 官方原话：description "Must be 100 characters or fewer"
   https://docs.github.com/en/rest/issues/labels */
const DESC_MAX = 100;

/** 清单形状校验。**返回问题列表，不抛**——调用方要的是「哪几条不对」，不是第一条就断掉。

    这一层是整套东西里最值钱的部分：颜色格式、描述超长、重名，
    这三类错误在网页上手点时同样会犯，区别只是**这里会在 `npm test` 里当场红**。 */
function validateManifest(labels) {
  const problems = [];
  if (!Array.isArray(labels)) return ["清单不是数组"];
  if (labels.length === 0) return ["清单是空的"];

  const seen = new Map();
  labels.forEach((l, i) => {
    const at = "第 " + (i + 1) + " 条";
    if (!l || typeof l !== "object") { problems.push(at + "不是对象"); return; }

    const name = l.name;
    if (typeof name !== "string" || name === "") {
      problems.push(at + "的 name 不是非空字符串");
    } else if (name !== name.trim()) {
      /* 首尾空格在网页上看不出来，而它会让「同一个标签」变成两个 */
      problems.push(at + "（" + name + "）的 name 首尾有空格");
    } else {
      /* GitHub 判重名不分大小写，所以我们也不分——否则清单能过、API 会 422 */
      const key = name.toLowerCase();
      if (seen.has(key)) problems.push("重名：" + name + " 与 " + seen.get(key));
      else seen.set(key, name);
    }

    /* 颜色必须是 6 位 hex 且**不带 #**（官方：hexadecimal color code without the leading #）。
       带上 # 是最容易犯的一个错，而 API 会拒掉整个请求。 */
    if (typeof l.color !== "string" || !/^[0-9a-fA-F]{6}$/.test(l.color)) {
      problems.push(at + "（" + name + "）的 color 不是 6 位 hex（不要带 #）：" + l.color);
    }

    if (typeof l.description !== "string") {
      problems.push(at + "（" + name + "）的 description 不是字符串");
    } else if (charLen(l.description) > DESC_MAX) {
      /* 按码点数，不按 s.length（UTF-16 码元数）。中文在 BMP 里两者相等，
         **差别只出在 emoji 这类星平面字符上**（一个 emoji 占 2 个码元）。
         写成 s.length 的话，一串 emoji 明明没超 100 个字却被拦下。 */
      problems.push(at + "（" + name + "）的 description 超过 " + DESC_MAX + " 字：" + charLen(l.description));
    }
  });

  return problems;
}

/** 码点数。中文一个字算一个，别用 s.length（那是 UTF-16 码元数）。 */
function charLen(s) {
  return Array.from(s).length;
}

/** 算出要做什么。**纯函数，而且不产 delete**——上面说过为什么。

    返回 { create, update, extra, conflicts }：
    - create   清单里有、GitHub 上没有
    - update   两边都有但 color 或 description 不一样
    - extra    GitHub 上有、清单里没有 —— **只报告，不动它**
    - conflicts 只有大小写不同的同名标签 —— 也不动，交给人判

    **extra 里常驻几条是正常的，不是待办。** 典型的一类：一个没有装 qa-gate 的仓
    上仍然躺着手建的 `qa-required` / `qa-passed`——它们确实存在，但那个仓里
    没有任何东西在读它们。每次同步在 extra 里点名一次，那句话读作
    「这几个存在，但不属于这个仓的流程」。**要让它们进清单，得先让那个仓真的装上
    读它们的东西**（qa-labels 那个 input），否则等于给它们一份正式定义，
    下一个人就会以为那儿有 QA 在把关。 */
function diffLabels(manifest, live) {
  const byExact = new Map(live.map(l => [l.name, l]));
  const byLower = new Map(live.map(l => [l.name.toLowerCase(), l]));

  const create = [], update = [], conflicts = [];
  const matched = new Set();

  for (const want of manifest) {
    const exact = byExact.get(want.name);
    if (exact) {
      matched.add(exact.name);
      /* 颜色比对忽略大小写：GitHub 存的是小写，清单里写 D73A4A 不该被当成一次改动 */
      const sameColor = String(exact.color).toLowerCase() === want.color.toLowerCase();
      const sameDesc = (exact.description || "") === want.description;
      if (!sameColor || !sameDesc) update.push({ want, have: exact });
      continue;
    }
    /* 名字只差大小写：**不当成改名去改**。GitHub 判重名不分大小写，
       所以 POST 会 422、PATCH 又等于悄悄改名。这种情况极少，交给人。 */
    const loose = byLower.get(want.name.toLowerCase());
    if (loose) {
      matched.add(loose.name);
      conflicts.push({ want, have: loose });
      continue;
    }
    create.push(want);
  }

  const extra = live.filter(l => !matched.has(l.name));
  return { create, update, extra, conflicts };
}

/** 读若干份清单并拼成一份，然后**整体**校验。

    拼完再校验是刻意的：`validateManifest` 里本来就有「不重名」那一条，
    所以两份文件撞了同一个标签名会在这里当场红，而不是后来者悄悄覆盖前者。
    这是这个机制唯一会静默出错的地方，靠那条现成的断言堵住。

    一份都没给就**抛**——调用方没点名要哪几份清单，不该由这里替它猜一个默认。 */
function readManifests(files) {
  if (!files || !files.length) throw new Error("至少要给一份清单（--manifest）");
  const all = [];
  for (const f of files) {
    const raw = fs.readFileSync(f, "utf8");
    let part;
    try {
      part = JSON.parse(raw);
    } catch (e) {
      throw new Error(f + " 不是合法 JSON：" + (e && e.message ? e.message : e));
    }
    if (!Array.isArray(part)) throw new Error(f + " 不是数组");
    all.push(...part);
  }
  const problems = validateManifest(all);
  if (problems.length) {
    throw new Error("清单有 " + problems.length + " 处问题：\n  - " + problems.join("\n  - "));
  }
  return all;
}

/** 读清单文件。这里**抛**——文件坏了就没有「继续」这个选项。 */
function readManifest(file) {
  const raw = fs.readFileSync(file || BASE_MANIFEST, "utf8");
  let labels;
  try {
    labels = JSON.parse(raw);
  } catch (e) {
    throw new Error("清单不是合法 JSON：" + (e && e.message ? e.message : e));
  }
  const problems = validateManifest(labels);
  if (problems.length) {
    throw new Error("清单有 " + problems.length + " 处问题：\n  - " + problems.join("\n  - "));
  }
  return labels;
}

/* --- 下面是碰网络的部分。fetchImpl 可注入，测试拿它指向一个本地的真 HTTP 服务。 --- */

function apiHeaders(token) {
  const h = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ginkgoleaflab-labels-sync",
  };
  if (token) h.Authorization = "Bearer " + token;
  return h;
}

/** 拉全部标签。per_page 上限 100（官方：for most endpoints, the maximum value of
    per_page is 100），所以要翻页——十几个今天翻不动，
    但「以后不会超过 100」不是一个能靠的假设。 */
async function listLabels(opts) {
  const { api, repo, token } = opts;
  const doFetch = opts.fetchImpl || fetch;
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const url = api.replace(/\/+$/, "") + "/repos/" + repo
      + "/labels?per_page=100&page=" + page;
    const res = await doFetch(url, { headers: apiHeaders(token) });
    if (!res.ok) throw new Error("列标签失败：GitHub API 返回 " + res.status);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error("列标签失败：响应不是数组");
    out.push(...body);
    if (body.length < 100) return out;
  }
  throw new Error("列标签失败：翻了 20 页还没到头，不正常");
}

/** 同步。apply 为假时只算不写（默认），为真才真的调 POST / PATCH。 */
async function syncLabels(opts) {
  const { api, repo, token, apply } = opts;
  for (const [k, v] of [["仓库", repo], ["API 地址", api]]) {
    if (!v) throw new Error("缺少" + k);
  }
  const manifest = opts.manifest || readManifest(opts.manifestPath);
  const live = await listLabels(opts);
  const plan = diffLabels(manifest, live);

  if (!apply) return { plan, applied: [], errors: [] };
  if (!token) throw new Error("要写就得有 token（GITHUB_TOKEN），dry-run 不需要");

  const doFetch = opts.fetchImpl || fetch;
  const base = api.replace(/\/+$/, "") + "/repos/" + repo + "/labels";
  const applied = [], errors = [];

  for (const l of plan.create) {
    const res = await doFetch(base, {
      method: "POST",
      headers: { ...apiHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ name: l.name, color: l.color, description: l.description }),
    });
    if (res.ok) applied.push("建 " + l.name);
    else errors.push("建 " + l.name + " 失败：HTTP " + res.status);
  }

  for (const { want } of plan.update) {
    /* 名字要 encode——`sev/major` 里那个斜杠不 encode 就变成了另一个路径段。
       encodeURIComponent 把 / 编成 %2F，这正是要的。

       body 里**只有 color 和 description**：Labels API 的 PATCH 还认一个 new_name，
       那是改名，而改名走这条路会丢 issue 关联。别加进来。 */
    const res = await doFetch(base + "/" + encodeURIComponent(want.name), {
      method: "PATCH",
      headers: { ...apiHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ color: want.color, description: want.description }),
    });
    if (res.ok) applied.push("改 " + want.name);
    else errors.push("改 " + want.name + " 失败：HTTP " + res.status);
  }

  return { plan, applied, errors };
}

function describe(r, apply) {
  const { create, update, extra, conflicts } = r.plan;
  const lines = [];
  lines.push(apply ? "同步标签（真的写）" : "同步标签（dry-run，不写。要写加 --apply）");
  lines.push("  要建 " + create.length + " 个，要改 " + update.length + " 个");
  for (const l of create) lines.push("    + " + l.name);
  for (const { want, have } of update) {
    const bits = [];
    if (String(have.color).toLowerCase() !== want.color.toLowerCase()) {
      bits.push("颜色 " + have.color + " → " + want.color);
    }
    if ((have.description || "") !== want.description) bits.push("描述");
    lines.push("    ~ " + want.name + "（" + bits.join("、") + "）");
  }
  /* 清单里没有的**不动**，但一定要说出来——静默忽略就等于这份清单不再是真相 */
  if (extra.length) {
    lines.push("  GitHub 上有、清单里没有的 " + extra.length + " 个（**不动它们**）：");
    for (const l of extra) lines.push("    ? " + l.name);
  }
  if (conflicts.length) {
    lines.push("  只差大小写的 " + conflicts.length + " 个（**不动，交给人判**）：");
    for (const c of conflicts) lines.push("    ! 清单写 " + c.want.name + "，GitHub 上是 " + c.have.name);
  }
  if (apply) {
    lines.push("  实际做了 " + r.applied.length + " 件：" + (r.applied.join("、") || "无"));
  }
  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  /* `--manifest` 可重复：调用方按仓库点名要哪几份（基础 + 可选的那几组）。
     不给默认值——「这个仓要哪几组标签」是调用方的判断，替它猜一个是错的方向。 */
  const files = argv.reduce((acc, a, i) =>
    (a === "--manifest" && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);
  const r = await syncLabels({
    manifest: readManifests(files),
    api: process.env.GITHUB_API_URL || "https://api.github.com",
    repo: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
    apply,
  });
  console.log(describe(r, apply));
  if (r.errors.length) {
    for (const e of r.errors) console.log("::error::" + e);
    process.exit(2);
  }
}

if (require.main === module) {
  main().catch(e => {
    /* 显式失败，不静默降级：这条路上「不知道发生了什么」必须看得见，
       否则一把过期 token 会让这条流水线天天绿着而标签从没同步过。 */
    console.log("::error::标签同步失败：" + (e && e.message ? e.message : e));
    process.exit(2);
  });
}

module.exports = { validateManifest, diffLabels, readManifest, readManifests, syncLabels, describe, BASE_MANIFEST, DESC_MAX };
