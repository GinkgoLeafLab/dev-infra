#!/usr/bin/env node
/* 给一个新仓库接上共享开发基础设施（dev-infra 的第一层 + 第二层，dev-agents 的 agent 定义），
   以及事后回头体检同一套接线（`--check`）。跑法：

     node vendor/dev-infra/adopt/adopt.js            # 接入 / 补齐
     node vendor/dev-infra/adopt/adopt.js --check    # 只体检，一个字节都不写

   ## 这个脚本的失败方向

   它是**装门的**，所以最严重的错是「报告说装好了，其实没装」——那正是这套基础设施
   通篇在防的那一类静默失效（钩子少一位可执行位、caller 少一个事件、标签没建出来，
   全都是「绿着的、坏的」）。所以：

   - **不确定一律算不通过。** 取不到上游 tag、读不出文件、判不了，一律是 ❌ 而不是
     「大概没问题」。`--check` 的退出码只在**一条 ❌ 都没有**时才是 0
   - **不覆盖已经存在的东西。** 已有文件内容不一样只报告，要覆盖得显式给 `--force`。
     消费仓的 caller 是被评审过的，脚本无权替它决定
   - **认不出的参数直接报错退出**，不当没看见：`--no-agent`（少个 s）静默被忽略的话，
     它会去动 `.claude/agents/common`，而那正是使用者刚说不要动的东西

   ## 它不做什么

   - **不提交、不推送。** 唯一的例外是 `git subtree add` 那一步——那两个提交是
     subtree 自己造的，绕不开（见 SKILL.md「为什么 agent 定义那条路要三步」）。
     其余改动留在工作区，由人/agent 自己走特性分支 → PR → 评审
   - **不改仓库设置。** 必需检查、ruleset、Environment 凭据是第三层，**只有人点得了**。
     脚本最后会把那张清单打出来，但它永远不会说那一层「已完成」
   - **不替某个仓库决定它的 `npm test` 长什么样**：把 `test:guard` 挂进去的接线逐仓不同，
     脚本只报告，不去猜

   边界与全部理由见同目录的 SKILL.md，以及本仓 README 的「adopt/」一节。 */
"use strict";

/* ------------------------------------------------------------------ 常量 */

const INFRA_URL_DEFAULT = "https://github.com/GinkgoLeafLab/dev-infra";
const AGENTS_URL_DEFAULT = "https://github.com/GinkgoLeafLab/dev-agents";

/* 布局是固定的，不做成参数：`scripts/guard-hook.js` 里那条相对路径和这里必须一致，
   两处能各自配就必然漂。setup-hooks.js 自己按 git rev-parse 算落点，所以
   **挂在别处技术上也行**——真要改，去改模板和这两个常量，别只改一个。 */
const SUBMODULE_PATH = "vendor/dev-infra";
/* 守卫入口的扩展名**跟着消费仓的模块系统走**，这不是风格问题：
   这份文件住在消费仓里（它存在的全部意义就是「检出就一定在」），所以 node 沿目录
   往上找到的第一份 package.json 是**消费仓自己**那份。消费仓是 `"type": "module"`
   时，`.js` 会被当 ESM 加载，第一行 require 就 ReferenceError——而 PreToolUse 把
   非零退出当 non-blocking error，**命令照常执行，守卫静默放行**。
   `.cjs` 这个扩展名压得过 package.json 的 type，两种仓库都成立。
   （子模块里的 shared/ 与 adopt/ 各有一份 package.json 挡这件事；消费仓里的这一份
   挡不了——往消费仓的 scripts/ 里塞一个 package.json 会把它变成一个 npm 包。） */
const SHIM_PATH = "scripts/guard-hook.js";
const SHIM_PATH_CJS = "scripts/guard-hook.cjs";
const AGENTS_PREFIX = ".claude/agents/common";
const VERSION_FILE = ".claude/agents-common.VERSION";
const SETTINGS_FILE = ".claude/settings.json";
const SKILL_STUB = ".claude/skills/dev-infra/SKILL.md";

const GUARD_REL = ["..", "vendor", "dev-infra", "shared", "guard-branch.js"];
/* dev-infra 自己那一侧的守卫入口指的是**树里**的 shared/，不是一个指回自己的子模块
   （理由见本仓 README「这个仓库自己也接着这套东西」）。放在这儿而不是那边，
   是因为它和上面那条必须成对读：两条都是「guard-hook.js 里那行 GUARD 该指哪儿」，
   分在两个文件里改一条忘一条不会有任何报错——渲染出来的入口照样能跑，
   只是指到一个不存在的路径上，而那等于守卫静默放行。self-adopt.test.js 钉着本仓那份
   逐字节等于 renderShim(模板, SELF_GUARD_REL)。 */
const SELF_GUARD_REL = ["..", "shared", "guard-branch.js"];
const SETUP_HOOKS = SUBMODULE_PATH + "/shared/setup-hooks.js";
const GUARD_TEST = SUBMODULE_PATH + "/shared/guard-branch.test.js";
const PREPARE = "git submodule update --init --recursive && node " + SETUP_HOOKS;

/* review-gate 的 PR 写锁在 v1.11.0 才有，而 v1.11.0~v1.13.0 那三版写锁的 `OK` 结论
   会在新 SHA 上写一条**绿的** `review`——「缺席即拦」当场失效，且没有任何症状
   （GinkgoLeafLab/GTO-Trainer#189）。所以这不是「建议升级」，是**钉在这个版本以下就是坏的**。 */
const REVIEW_GATE_MIN = "v1.14.0";

const PROTECTED = ["main", "master"];

/* ------------------------------------------------------- 纯函数（有测试钉着） */

const USAGE = `用法：node ${SUBMODULE_PATH}/adopt/adopt.js [选项]

  --check              只体检、不写任何东西（受保护分支上也能跑）
  --qa                 同时装 qa-gate caller，并把 labels-sync 的 qa-labels 置 true
  --no-agents          不接 ${AGENTS_PREFIX}（subtree 那条路）
  --no-skill           不在本仓装那份指向上游的 skill 存根
  --force              已存在且内容不同的文件也覆盖（默认只报告）
  --offline            不联网：不解析上游最新 tag、不做 subtree 内容比对
                       （要配合 --infra-tag / --agents-tag）
  --infra-tag <tag>    钉哪个 dev-infra tag，不给就取上游最新的 vX.Y.Z
  --agents-tag <tag>   钉哪个 dev-agents tag，同上
  --infra-url <url>    换上游地址（测试与镜像用）
  --agents-url <url>
  --repo <path>        目标仓库（默认当前目录所在的那个仓库根）
  --help

退出码：0 = 一条 ❌ 都没有；1 = 有 ❌（**判不了也算 ❌**，见文件头「失败方向」）。`;

const BOOL_FLAGS = {
  "--check": "check", "--qa": "qa", "--no-agents": "noAgents",
  "--no-skill": "noSkill", "--force": "force", "--offline": "offline",
  "--help": "help",
};
const VALUE_FLAGS = {
  "--infra-tag": "infraTag", "--agents-tag": "agentsTag",
  "--infra-url": "infraUrl", "--agents-url": "agentsUrl", "--repo": "repo",
};

function parseArgs(argv) {
  const o = {
    check: false, qa: false, noAgents: false, noSkill: false, force: false,
    offline: false, help: false, infraTag: null, agentsTag: null, repo: null,
    infraUrl: INFRA_URL_DEFAULT, agentsUrl: AGENTS_URL_DEFAULT,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOL_FLAGS[a]) { o[BOOL_FLAGS[a]] = true; continue; }
    if (VALUE_FLAGS[a]) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} 后面要跟一个值`);
      o[VALUE_FLAGS[a]] = v;
      continue;
    }
    /* 认不出就报错，**不当没看见**：静默忽略一个打错的开关，等于按使用者没要的方式跑。 */
    throw new Error(`认不出的参数：${a}\n\n${USAGE}`);
  }
  if (o.offline && (!o.infraTag || (!o.noAgents && !o.agentsTag))) {
    throw new Error("--offline 要求把 --infra-tag（以及接 agent 定义时的 --agents-tag）写明：\n" +
      "不联网就解析不出「最新的那个 tag」，而猜一个出来正是这个脚本不许做的事。");
  }
  return o;
}

/* `git ls-remote --tags <url>` 的输出 → Map(tag 名 → SHA)。
   **annotated tag 要取剥出来的那个 commit**：`refs/tags/x` 那一行是 tag 对象的 SHA，
   `refs/tags/x^{}` 才是它指向的 commit。agents-common.VERSION 里记的是「commit」，
   记成 tag 对象 SHA 的话，拿它去 `git diff` 比内容对不上，而那份记录看上去完全正常。 */
function parseLsRemote(text) {
  const m = new Map();
  for (const line of String(text).split("\n")) {
    const mm = /^([0-9a-f]{40})\s+refs\/tags\/(.+?)(\^\{\})?$/.exec(line.trim());
    if (!mm) continue;
    const [, sha, name, peeled] = mm;
    if (peeled || !m.has(name)) m.set(name, sha);   /* 剥出来的那个优先 */
  }
  return m;
}

const SEMVER = /^v(\d+)\.(\d+)\.(\d+)$/;

function cmpTag(a, b) {
  const x = SEMVER.exec(a), y = SEMVER.exec(b);
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return d;
  }
  return 0;
}

/* 只认三段式 vX.Y.Z。**`v1` 这种会动的 tag 一律不要**——上游确实还留着一个
   「挪 tag 时代」的 `v1`，钉上它等于把「未经本仓评审的改动不会生效」那条性质扔掉。
   也不做字典序排序：那会让 v1.9.0 排在 v1.14.0 后面。 */
function pickTag(names) {
  const ok = [...names].filter((n) => SEMVER.test(n)).sort(cmpTag);
  if (!ok.length) throw new Error("上游一个 vX.Y.Z 形状的 tag 都没有，接不了——去确认上游地址对不对");
  return ok[ok.length - 1];
}

function isImmutableTag(ref) { return SEMVER.test(String(ref)); }

/* 这个仓库该用哪个守卫入口文件名。`.cjs` 在两种仓库里都对，`.js` 只在 CJS 仓里对——
   所以判据只有一条：消费仓声明了 `"type": "module"` 就必须是 `.cjs`。 */
function shimPathFor(pkg) {
  return pkg && pkg.type === "module" ? SHIM_PATH_CJS : SHIM_PATH;
}

/* 目标仓库就是 dev-infra 本身吗？

   **这条判定拦的是一次真的会毁东西的误用**：在这个仓库里 `.github/workflows/review-gate.yml`
   等三个名字被**可复用工作流本体**占着，而脚本是按「那三个名字是 caller」写的——
   在这儿跑写入模式，轻则挂一个指回自己的子模块，重则拿 caller 的形状去判本体，
   报一屏和事实相反的 ❌（实跑过：本体会被判成「不是 pull_request_target」「少了 labeled」）。
   本仓自己那一侧的接线形状不一样，由本仓的 self-adopt.test.js 钉着，不归这个脚本判。

   **判据是内容，不是 remote 的 url**：镜像、fork、改过名字的克隆都还是这个仓库，
   而 url 判据在那几种情况下会悄悄判成「普通消费仓」——判错的方向正好是去动本体。
   三条同时成立才算，一个真的消费仓永远不会同时有这三样：
   本体在（review-gate.yml 里是 `workflow_call`，不是 caller 的 `pull_request_target`）、
   第二层源文件在（shared/guard-branch.js）、接入脚本自己在（adopt/adopt.js）。 */
function detectSelfHost({ reviewGateYml, hasSharedGuard, hasAdoptScript }) {
  if (!hasSharedGuard || !hasAdoptScript) return false;
  return /^\s*workflow_call:/m.test(String(reviewGateYml || ""));
}

/* 渲染出来的 caller 必须是钉死的。这个断言是「永远不会写出 @main」的那道保险：
   模板改坏、替换没命中，都在这儿当场炸，而不是等某个仓库合了才发现。 */
function assertPinned(text, where) {
  const left = text.match(/__[A-Z_]+__/g);
  if (left) throw new Error(`${where} 还剩没替换的占位符：${[...new Set(left)].join(", ")}`);
  const refs = [...text.matchAll(/uses:\s*GinkgoLeafLab\/dev-infra\/\S+?@(\S+)/g)].map((m) => m[1]);
  if (!refs.length) throw new Error(`${where} 里一行 dev-infra 的 uses: 都没有`);
  for (const r of refs) {
    if (!isImmutableTag(r)) throw new Error(`${where} 钉的是 ${r}，不是不可变 tag（vX.Y.Z）`);
  }
  return refs;
}

function renderCaller(tpl, { tag, qa }) {
  const out = tpl.replace(/__INFRA_TAG__/g, tag).replace(/__QA_LABELS__/g, qa ? "true" : "false");
  assertPinned(out, "渲染出的 caller");
  return out;
}

/* `parts` 是给 dev-infra 自己那一侧留的口子（它不挂指回自己的子模块，见 SELF_GUARD_REL）。
   默认值是消费仓那条路径，所以调用方少传一个参数拿到的仍然是原来那一份。 */
function renderShim(tpl, parts = GUARD_REL) {
  const rel = parts.map((s) => JSON.stringify(s)).join(", ");
  const out = tpl.replace(/__GUARD_REL__/g, rel);
  if (out.includes("__GUARD_REL__") || !out.includes(rel)) throw new Error("guard-hook 模板渲染没命中");
  return out;
}

/* caller 的体检。**查的全是「漏了不报错、只是那条路安静地不存在」的东西**：
   少一个事件、少半个 if、少一个权限、钉到会动的名字。查不出本仓自己加的东西，
   那不是这儿的事。 */
function lintCaller(kind, text, { qa } = {}) {
  const bad = [];
  /* **先把整行注释剥掉再判**：这些模板的注释里逐字写着 `review-passed`、`synchronize`、
     `@main` 这些词（它们正是在解释那几条），照着原文判会把「注释里提过」当成
     「接线上有」——那是这份体检最不能犯的错（漏判 = 说它装好了，其实没装）。 */
  const code = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  const has = (re) => re.test(code);
  if (!has(/^on:/m)) bad.push("没有 on: 触发器");
  else if (kind !== "labels-sync" && !has(/^\s*pull_request_target:/m)) {
    bad.push("不是 pull_request_target：定义取自默认分支这条安全地基没了，PR 能改本文件放行自己");
  }
  if (kind === "review-gate") {
    if (!has(/types:\s*\[[^\]]*labeled/)) bad.push("types 里少了 labeled：评审通过那条路不会跑");
    if (!has(/types:\s*\[[^\]]*synchronize/)) bad.push("types 里少了 synchronize：PR 写锁那条路永远不跑，而且不报错");
    if (!has(/if:[\s\S]*review-passed/)) bad.push("job 级 if 里少了 review-passed");
    if (!has(/action == 'synchronize'/)) bad.push("job 级 if 里少了 synchronize 那一半：它不是标签事件，会被整个挡在门外");
    if (!has(/statuses:\s*write/)) bad.push("少了 statuses: write，写不了 review 检查");
    if (!has(/pull-requests:\s*write/)) bad.push("少了 pull-requests: write，摘不了标签也读不了写锁评论");
  }
  if (kind === "qa-gate") {
    for (const t of ["opened", "reopened", "synchronize", "labeled", "unlabeled"]) {
      if (!has(new RegExp("types:\\s*\\[[^\\]]*" + t))) bad.push(`types 里少了 ${t}：少报告一次 qa，那个 PR 就永远停在 Expected`);
    }
    if (!has(/startsWith\(github\.event\.label\.name, 'qa-'\)/)) {
      bad.push("job 级 if 里没有 qa-* 那条：别的标签事件也会起 runner，账单前提没了");
    }
    if (!has(/statuses:\s*write/)) bad.push("少了 statuses: write");
    if (!has(/pull-requests:\s*write/)) bad.push("少了 pull-requests: write");
    if (has(/^\s*paths(-ignore)?:/m)) bad.push("有 paths / paths-ignore：必需检查被 workflow 级过滤跳过就永远 pending");
  }
  if (kind === "labels-sync") {
    if (!has(/issues:\s*write/)) bad.push("少了 issues: write（标签归在 issues 这个 scope 下）");
    if (has(/statuses:\s*write/)) bad.push("抄了隔壁的 statuses: write，这条流水线不需要");
    if (!has(/qa-labels:\s*(true|false)/)) bad.push("没有 qa-labels 这个输入");
    /* **这一条曾经住在 run.js 里，判的是文件原文**——于是它正好绕开了上面剥注释那一步：
       装了 qa-gate、`qa-labels: false`、而任何一行注释里出现 `qa-labels: true`，体检就报绿
       （实跑过）。那正是这个脚本自己定义的最严重错法：「报告说装好了，其实没装」。
       所以它搬进来了，和同源的那条（有没有 qa-labels 这一行）在同一处、共用同一份 code。
       **`qa` 不给就抛，不是跳过**：漏掉这条一致性判定的表现就是上面那句报绿，
       而「静默少一条判定」在这个脚本里是最不能容忍的失效方向。 */
    if (qa === undefined) {
      throw new Error("lintCaller('labels-sync') 必须告诉它本仓装没装 qa-gate（{ qa: true|false }）");
    }
    if (has(/qa-labels:\s*true/) !== !!qa) {
      bad.push(qa
        ? "装了 qa-gate 却没传 qa-labels: true：qa-required / qa-passed 这两个标签在本仓根本不存在，而 GitHub 对打一个不存在的标签是**静默不打**"
        : "传了 qa-labels: true 但本仓没有 qa-gate：等于建两个没有任何东西在读的标签");
    }
  }
  if (kind !== "labels-sync" && has(/contents:\s*read/)) {
    bad.push("有 contents: read：这条路上一次 checkout 都不做，给了它说明接线理解错了");
  }
  let refs = [];
  try { refs = assertPinned(code, "这份 caller"); } catch (e) { bad.push(e.message); }
  if (kind === "review-gate" && refs.length && isImmutableTag(refs[0]) && cmpTag(refs[0], REVIEW_GATE_MIN) < 0) {
    bad.push(`钉在 ${refs[0]}：${REVIEW_GATE_MIN} 以前的 review-gate 要么没有 PR 写锁，` +
      "要么写锁会把 review 写成绿的（缺席即拦当场失效，没有症状）");
  }
  return { problems: bad, refs };
}

const HOOK_ENTRY = (shimPath) => ({
  matcher: "Bash",
  hooks: [{
    type: "command",
    command: "node",
    /* ${CLAUDE_PROJECT_DIR} 而不是相对路径：hook 的工作目录不保证是仓库根。 */
    args: ["${CLAUDE_PROJECT_DIR}/" + shimPath],
    timeout: 10,
    statusMessage: "检查分支保护…",
  }],
});

function hookText(entry) { return JSON.stringify(entry); }

/* 往 .claude/settings.json 里接 PreToolUse 守卫。
   **两种「已经有别的 Bash hook」要分开对待**：
   - 指进子模块的那种是**反模式**，不是「已经装好了」：子模块为空时它非零退出，
     而 PreToolUse 把非零退出当 non-blocking error——命令照常执行。这种要报冲突，
     让人去改，脚本不替他改（那一行是他写的，可能还挂着别的东西）
   - 别的 Bash hook 可以共存（PreToolUse 是一组，任何一条 deny 就拦住），所以直接并排加一条 */
function mergeSettings(settings, { shimPath = SHIM_PATH, submodulePath = SUBMODULE_PATH } = {}) {
  const next = JSON.parse(JSON.stringify(settings || {}));
  if (!next.hooks) next.hooks = {};
  if (!Array.isArray(next.hooks.PreToolUse)) next.hooks.PreToolUse = [];
  const pre = next.hooks.PreToolUse;
  const bash = pre.filter((e) => e && (e.matcher === "Bash" || e.matcher === "*"));
  const mine = bash.find((e) => hookText(e).includes(shimPath));
  if (mine) return { next, state: "ok", note: `已经指向 ${shimPath}` };
  /* 指着另一个扩展名的那份：**不是「没装」，是装错了**，并排再加一条只会让两条都在。 */
  const wrongExt = bash.find((e) => /guard-hook\.(js|cjs)/.test(hookText(e)));
  if (wrongExt) {
    return {
      next: settings, state: "bad",
      note: `PreToolUse 指的是另一个扩展名的守卫入口，本仓要的是 ${shimPath}` +
        `（\`"type": "module"\` 的仓库里 .js 会被当 ESM 加载，require 当场 ReferenceError，` +
        "而那等于静默放行）。改那一行，别并排加一条。",
    };
  }
  const direct = bash.find((e) => hookText(e).includes(submodulePath));
  if (direct) {
    return {
      next: settings, state: "bad",
      note: `PreToolUse 里有一条**直接指进 ${submodulePath} 的** Bash hook。子模块为空时它` +
        `非零退出，而 PreToolUse 把非零退出当 non-blocking error——命令照常执行，` +
        `守卫是静默放行的。把那一条改成指向 ${shimPath}（本脚本已经把它写出来了），别并排加。`,
    };
  }
  pre.push(HOOK_ENTRY(shimPath));
  return {
    next, state: "changed",
    note: bash.length ? "本仓原来就有别的 Bash PreToolUse hook，并排加一条（任何一条 deny 都拦得住）" : "",
  };
}

/* package.json 的三条接线。**一条都不覆盖已有的**：prepare 尤其——
   很多仓库的 prepare 上挂着别的东西，替掉它是在别人的仓库里制造事故。 */
function mergePackageJson(pkg) {
  const next = JSON.parse(JSON.stringify(pkg || {}));
  if (!next.scripts) next.scripts = {};
  const s = next.scripts;
  const notes = [];
  let state = "ok";
  const want = {
    "setup:hooks": "node " + SETUP_HOOKS,
    "test:guard": "node " + GUARD_TEST,
    "prepare": PREPARE,
  };
  for (const [k, v] of Object.entries(want)) {
    if (s[k] === undefined) { s[k] = v; state = state === "bad" ? "bad" : "changed"; continue; }
    if (s[k] === v) continue;
    if (k === "prepare" && s[k].includes(SETUP_HOOKS) && s[k].includes("submodule update")) continue;
    state = "bad";
    notes.push(`scripts.${k} 已经是别的内容，没动它。自己把这一段接进去：${v}`);
  }
  /* 守卫的测试要真的进本仓的 npm test，否则那 100 多条断言在这里一次都不跑。
     怎么挂逐仓不同（有的仓是 test-all.js 的清单，有的是一串 &&），所以只报告。 */
  const test = s.test || "";
  if (!/test:guard|guard-branch\.test/.test(test)) {
    notes.push("`npm test` 里没有 test:guard：分支守卫那套断言在本仓一次都不会跑，自己把它挂进去");
    if (state === "ok") state = "info";
  }
  return { next, state, notes };
}

module.exports = {
  parseArgs, parseLsRemote, pickTag, cmpTag, isImmutableTag, assertPinned,
  renderCaller, renderShim, lintCaller, mergeSettings, mergePackageJson, shimPathFor,
  detectSelfHost,
  SUBMODULE_PATH, SHIM_PATH, SHIM_PATH_CJS, AGENTS_PREFIX, VERSION_FILE, SETTINGS_FILE,
  SKILL_STUB, PREPARE, REVIEW_GATE_MIN, PROTECTED, USAGE, GUARD_REL, SELF_GUARD_REL,
};

if (require.main === module) require("./run.js")(module.exports);
