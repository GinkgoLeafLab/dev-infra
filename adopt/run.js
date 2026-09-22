/* adopt.js 的「真的动盘上的东西」那一半。判定与渲染在 adopt.js 里（纯函数，有测试钉着），
   这儿只负责：问 git、读写文件、按顺序跑那几步、把结论打出来。

   **顺序是有理由的，别调**：`git subtree add` 要求索引干净（它自己的 ensure_clean），
   所以它必须跑在任何写文件的步骤**之前**；`git submodule add` 会动索引但不提交，
   所以它排在 subtree 之后、写文件之前。 */
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const OK = "✅", INFO = "ℹ️ ", BAD = "❌", DID = "🔧";

module.exports = function run(A) {
  const report = [];
  const say = (mark, title, detail) => report.push({ mark, title, detail: detail || "" });

  let o;
  try { o = A.parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(BAD + " " + e.message); process.exit(1); }
  if (o.help) { console.log(A.USAGE); process.exit(0); }

  /* ---------------------------------------------------------------- 仓库与预检 */
  const git = (args, opts = {}) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
  const tryGit = (args, opts) => { try { return { ok: true, out: git(args, opts) }; } catch (e) { return { ok: false, out: ((e.stdout || "") + (e.stderr || "")).trim() }; } };

  let root;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"],
      { cwd: o.repo || process.cwd(), encoding: "utf8" }).trim();
  } catch (e) {
    console.error(BAD + " 这儿不是一个 git 仓库（--repo 指一个仓库，或者先 git init）");
    process.exit(1);
  }
  const abs = (p) => path.join(root, p);
  const exists = (p) => fs.existsSync(abs(p));
  const readIf = (p) => (exists(p) ? fs.readFileSync(abs(p), "utf8") : null);
  const branch = tryGit(["rev-parse", "--abbrev-ref", "HEAD"]).out;
  const dirty = tryGit(["status", "--porcelain"]).out !== "";
  const doAgents = !o.noAgents;

  console.log(`仓库：${root}（分支 ${branch || "？"}）${o.check ? "  — 只体检，不写东西" : ""}`);

  /* 目标仓库是 dev-infra 自己的话，到此为止——**两种模式都停**。
     这不是洁癖：在这个仓库里那三个 caller 名字被可复用工作流本体占着，
     `--check` 会拿 caller 的形状去判本体、报一屏和事实相反的 ❌（本体当然不是
     `pull_request_target`，它是 `workflow_call`），而按那份报告去「修」正是把本体
     覆盖掉。写入模式更直接：会挂一个指回自己的子模块。
     本仓自己那一侧接的是同一套东西、形状不一样，由本仓的 self-adopt.test.js 钉着。
     **退出码是 1**：这个脚本的规矩是判不了算 ❌，给 0 会让人以为验过了。 */
  if (A.detectSelfHost({
    reviewGateYml: readIf(".github/workflows/review-gate.yml"),
    hasSharedGuard: exists("shared/guard-branch.js"),
    hasAdoptScript: exists("adopt/adopt.js"),
  })) {
    console.error(`${BAD} 这个仓库就是 dev-infra 本身：.github/workflows/review-gate.yml 是
   **可复用工作流本体**，不是 caller。这个脚本是按「那三个名字是 caller」写的，
   在这儿判出来的每一条都是反的，写入模式还会挂一个指回自己的子模块。

   本仓自己那一侧接的是同一套东西，形状不一样（caller 叫 self-*.yml，守卫入口指树里的
   shared/，没有子模块），由本仓自己的测试钉着：

     node self-adopt.test.js

   形状与逐条理由见 README「这个仓库自己也接着这套东西」。
   要体检一个**消费仓**，用 --repo 指过去。`);
    process.exit(1);
  }

  if (!o.check) {
    /* 受保护分支上不许跑：这个脚本会让 subtree 造提交，而那正是分支守卫拦的事。
       **`--check` 不受这条限制**，它一个字节都不写。 */
    if (A.PROTECTED.includes(branch)) {
      console.error(`${BAD} 现在在受保护分支 ${branch} 上。开一个特性分支再来：\n` +
        "   git switch -c chore/接入共享基础设施");
      process.exit(1);
    }
    /* **提交要有身份，而这一步会提交**（`git subtree add` 自己造那两个提交）。
       没配 user.name / user.email 的机器上（容器、CI runner、刚装好的开发机）
       git 是 `fatal: empty ident name … not allowed`——在 dev-infra 自己的 runner 上
       实测撞到过。放到这儿拦，而不是等 subtree 跑到一半：**升级那条路会先
       `git rm -r` 并提交**，在那之后失败留下的是「一个角色都没有」的那一版。
       脚本不替谁编一个身份出来：那会把一条假的作者信息写进别人的仓库历史。 */
    const ident = tryGit(["var", "GIT_COMMITTER_IDENT"]);
    if (doAgents && !ident.ok) {
      console.error(`${BAD} git 说不出提交者是谁（${ident.out.split("\n")[0]}），而接 agent 定义那一步要提交。\n` +
        "   先配上身份再来：\n" +
        "     git config user.name  \"你的名字\"\n" +
        "     git config user.email \"你的邮箱\"\n" +
        "   或者这次加 --no-agents 只接另外两层（那两层一个提交都不造）。");
      process.exit(1);
    }
    if (dirty && doAgents) {
      console.error(`${BAD} 工作区不干净，而接 agent 定义那一步（git subtree add）要求索引干净——\n` +
        "   它自己的 ensure_clean 会 die，没有 --force 之类的口子。先把手上的改动提交掉，\n" +
        "   或者这次加 --no-agents 只接另外两层。");
      process.exit(1);
    }
  }

  /* ------------------------------------------------------------------ 解析 tag */
  function remoteTags(url) {
    const r = tryGit(["ls-remote", "--tags", url]);
    if (!r.ok) throw new Error(`取不到 ${url} 的 tag：${r.out.split("\n")[0]}`);
    return A.parseLsRemote(r.out);
  }
  let infraTags = new Map(), agentsTags = new Map(), infraTag = o.infraTag, agentsTag = o.agentsTag;
  if (!o.offline) {
    try {
      infraTags = remoteTags(o.infraUrl);
      if (!infraTag) infraTag = A.pickTag(infraTags.keys());
      if (doAgents) {
        agentsTags = remoteTags(o.agentsUrl);
        if (!agentsTag) agentsTag = A.pickTag(agentsTags.keys());
      }
    } catch (e) {
      /* 取不到就停。猜一个 tag 出来、或者退回 @main，都是这个脚本明确不做的事。 */
      console.error(`${BAD} ${e.message}\n   （联不上上游就用 --offline 配 --infra-tag / --agents-tag 显式钉）`);
      process.exit(1);
    }
  }
  const mustPin = [["--infra-tag", infraTag]];
  if (doAgents) mustPin.push(["--agents-tag", agentsTag]);
  for (const [name, t] of mustPin) {
    if (!A.isImmutableTag(t)) {
      console.error(`${BAD} ${name} 给的是 ${t}，不是 vX.Y.Z 形状的不可变 tag。` +
        "\n   钉到会动的名字（@main、@v1）等于让上游一次未经本仓评审的改动当场在这里生效。");
      process.exit(1);
    }
  }

  /* 消费仓的模块系统决定守卫入口该叫 .js 还是 .cjs（理由见 adopt.js 里那段注释）。
     package.json 坏了就按最保守的来：.cjs 在两种仓库里都对。 */
  let consumerPkg = null, pkgBroken = false;
  if (exists("package.json")) {
    try { consumerPkg = JSON.parse(fs.readFileSync(abs("package.json"), "utf8")); }
    catch (e) { pkgBroken = true; consumerPkg = { type: "module" }; }
  }
  const shimRel = A.shimPathFor(consumerPkg);

  /* ---------------------------------------------------------------- 1. agent 定义 */
  if (!doAgents) {
    say(INFO, "agent 定义", "这次跳过了（--no-agents）");
  } else {
    const inHead = tryGit(["ls-tree", "--name-only", "HEAD", A.AGENTS_PREFIX + "/"]).out;
    const mdCount = inHead.split("\n").filter((l) => l.endsWith(".md")).length;
    const verRaw = readIf(A.VERSION_FILE);
    let ver = null;
    if (verRaw) { try { ver = JSON.parse(verRaw); } catch (e) { ver = "坏了"; } }

    if (o.check || mdCount > 0) {
      if (mdCount === 0) say(BAD, "agent 定义", `${A.AGENTS_PREFIX} 里一份角色定义都没有`);
      else if (ver === null) say(BAD, "agent 定义", `${A.VERSION_FILE} 不在：没有任何东西记着现在是哪个 tag，验收判据也就跑不了`);
      else if (ver === "坏了" || !ver.tag || !ver.commit) say(BAD, "agent 定义", `${A.VERSION_FILE} 读不出 tag / commit`);
      else if (o.offline) say(INFO, "agent 定义", `记着 ${ver.tag}，${mdCount} 份角色；**没比对上游内容**（--offline），这条不算验过`);
      else {
        const f = tryGit(["fetch", "--quiet", o.agentsUrl, "refs/tags/" + ver.tag]);
        if (!f.ok) say(BAD, "agent 定义", `取不到上游的 ${ver.tag}，比不了内容：${f.out.split("\n")[0]}`);
        else {
          const d = tryGit(["diff", "--quiet", "FETCH_HEAD:", "HEAD:" + A.AGENTS_PREFIX]);
          if (d.ok) say(OK, "agent 定义", `${mdCount} 份角色，和上游 ${ver.tag} 逐字节相同`);
          else say(BAD, "agent 定义", `和上游 ${ver.tag} 不一致：要么有人在本仓改了那几份（改了也传不出去、下次重接会被覆盖），` +
            `要么 ${A.VERSION_FILE} 记的 tag 是假的`);
        }
      }
    }
    /* 升级和接入是同一条路：`git rm -r` 并提交 → 重新 add → 改 VERSION。
       **只在 --force 下做**：它会造两个提交、中途失败会留下「角色全没了」那一版，
       所以必须是有人明确要求的动作，不能是脚本顺手做的。 */
    if (!o.check && o.force && mdCount > 0 && ver && ver !== "坏了" && ver.tag !== agentsTag) {
      const rm = tryGit(["rm", "-r", "--quiet", A.AGENTS_PREFIX]);
      const ci = rm.ok && tryGit(["commit", "-m", "为接 subtree 腾出 " + A.AGENTS_PREFIX]).ok;
      if (!ci) say(BAD, "agent 定义", "腾位那一步失败了，什么都没换（subtree add 的两道门就是这么设计的）");
      else {
        const r = tryGit(["subtree", "add", "--prefix=" + A.AGENTS_PREFIX, o.agentsUrl, agentsTag, "--squash"]);
        if (!r.ok) {
          say(BAD, "agent 定义", "已经把 " + A.AGENTS_PREFIX + " 删掉并提交了，但重接 " + agentsTag +
            " 失败：" + r.out.split("\n").slice(-2).join(" / ") + "。**现在这个分支上一个角色都没有**，" +
            "用 `git reset --hard HEAD~1` 退回去，别把它推上去。");
        } else {
          writeJson(abs(A.VERSION_FILE), { repo: urlToRepo(o.agentsUrl), tag: agentsTag, commit: agentsTags.get(agentsTag) || tryGit(["rev-parse", "FETCH_HEAD"]).out });
          say(DID, "agent 定义", `从 ${ver.tag} 重接到 ${agentsTag}（rm -r + 重新 add + 改 VERSION，**这三步要落在同一个 PR 里**）`);
        }
      }
    } else if (!o.check && mdCount === 0) {
      if (exists(A.AGENTS_PREFIX)) {
        say(BAD, "agent 定义", `${A.AGENTS_PREFIX} 在盘上但不在版本控制里。subtree add 的第一道门` +
          "（main() 里的 prefix already exists）会直接 die，而它没有 --force。自己把它挪走或提交掉再来。");
      } else {
        const r = tryGit(["subtree", "add", "--prefix=" + A.AGENTS_PREFIX, o.agentsUrl, agentsTag, "--squash"]);
        if (!r.ok) say(BAD, "agent 定义", "git subtree add 失败：" + r.out.split("\n").slice(-3).join(" / "));
        else {
          const sha = agentsTags.get(agentsTag) || tryGit(["rev-parse", "FETCH_HEAD"]).out;
          writeJson(abs(A.VERSION_FILE), { repo: urlToRepo(o.agentsUrl), tag: agentsTag, commit: sha });
          say(DID, "agent 定义", `subtree 接上 ${agentsTag}（它自己造了提交），并写了 ${A.VERSION_FILE}` +
            "。**这两件事必须落在同一个 PR 里**：树换了而记录停在旧 tag，比没有记录更糟。");
        }
      }
    }
  }

  /* ---------------------------------------------------------------- 2. 子模块 */
  {
    const entry = tryGit(["ls-files", "-s", "--", A.SUBMODULE_PATH]).out;
    const mode = entry.split(/\s+/)[0];
    const sha = entry.split(/\s+/)[1];
    const checkedOut = exists(A.SUBMODULE_PATH + "/shared/guard-branch.js");
    if (mode !== "160000") {
      if (o.check) say(BAD, "子模块", `${A.SUBMODULE_PATH} 不是 gitlink（树里那条 160000）——没挂上，或者挂成了普通目录`);
      else {
        const r = tryGit(["submodule", "add", o.infraUrl, A.SUBMODULE_PATH]);
        if (!r.ok) say(BAD, "子模块", "git submodule add 失败：" + r.out.split("\n").slice(-2).join(" / "));
        else {
          tryGit(["fetch", "--tags", "--quiet"], { cwd: abs(A.SUBMODULE_PATH) });
          const co = tryGit(["checkout", "--quiet", "refs/tags/" + infraTag], { cwd: abs(A.SUBMODULE_PATH) });
          if (!co.ok) say(BAD, "子模块", `挂上了，但切不到 ${infraTag}：${co.out.split("\n")[0]}`);
          else { tryGit(["add", A.SUBMODULE_PATH, ".gitmodules"]); say(DID, "子模块", `挂在 ${A.SUBMODULE_PATH}，钉在 ${infraTag}`); }
        }
      }
    } else {
      const at = [...infraTags.entries()].filter(([, s]) => s === sha).map(([n]) => n).filter(A.isImmutableTag);
      if (!checkedOut) say(BAD, "子模块", "gitlink 在，但工作树里是空的：跑一次 `git submodule update --init --recursive`（守卫这时是靠 guard-hook.js 拦着的）");
      else if (o.offline) say(INFO, "子模块", `钉在 ${sha.slice(0, 8)}；**没跟上游对 tag**（--offline）`);
      else if (!at.length) say(BAD, "子模块", `钉在 ${sha.slice(0, 8)}，那不是任何一个 vX.Y.Z tag——` +
        "升级只能靠移到一个 tag 上，钉在别处没有任何东西说得清这里跑的是哪一版");
      else if (at.includes(infraTag)) say(OK, "子模块", `钉在 ${infraTag}`);
      else say(INFO, "子模块", `钉在 ${at[0]}，上游最新是 ${infraTag}（升级是移指针 + 走 PR，脚本不替你移）`);
    }
  }

  /* ---------------------------------------------------------------- 3. 守卫入口 */
  {
    const want = A.renderShim(fs.readFileSync(path.join(__dirname, "templates", "guard-hook.js"), "utf8"));
    const other = shimRel === A.SHIM_PATH_CJS ? A.SHIM_PATH : A.SHIM_PATH_CJS;
    const got = readIf(shimRel);
    /* **扩展名不对是「装错了」，不是「没装」**：ESM 仓里那份 .js 会被当 ESM 加载，
       第一行 require 就 ReferenceError → PreToolUse 收到非零退出 + 空 stdout →
       当成 non-blocking error → **命令照常执行**。绿着的、坏的，正是这套东西最怕的形状。 */
    if (got === null && exists(other) && shimRel === A.SHIM_PATH_CJS) {
      const detail = `本仓是 \`"type": "module"\`，而守卫入口是 ${other}——它会被当成 ESM 加载，` +
        "require 当场 ReferenceError，PreToolUse 把非零退出当 non-blocking error，**命令照常执行**（守卫静默放行）。";
      if (o.check) say(BAD, "守卫入口", detail);
      else {
        write(abs(shimRel), want);
        say(DID, "守卫入口", `写了 ${shimRel}。${detail}\n      旧的那份和 ${A.SETTINGS_FILE} 里指着它的那一行要一起清掉：` +
          `\`git rm ${other}\`（脚本不替你删一个 tracked 文件）。`);
      }
    } else if (got === null) {
      if (o.check) say(BAD, "守卫入口", `${shimRel} 不在。PreToolUse 直接指进子模块的话，子模块为空时是**静默放行**`);
      else { write(abs(shimRel), want); say(DID, "守卫入口", `写了 ${shimRel}`); }
    } else if (got === want) {
      say(OK, "守卫入口", shimRel);
    } else if (o.force && !o.check) {
      write(abs(shimRel), want); say(DID, "守卫入口", `${shimRel} 覆盖成上游模板那一份（--force）`);
    } else {
      say(BAD, "守卫入口", `${shimRel} 和上游模板不一致。各仓不该各有一份不一样的守卫入口——` +
        "确认本仓这些改动真的要留，或者用 --force 覆盖回去。");
    }
  }

  /* ---------------------------------------------------------------- 4. PreToolUse */
  {
    let cur = {};
    let broken = false;
    if (exists(A.SETTINGS_FILE)) {
      try { cur = JSON.parse(fs.readFileSync(abs(A.SETTINGS_FILE), "utf8")); }
      catch (e) { broken = true; }
    }
    if (broken) say(BAD, "PreToolUse 守卫", `${A.SETTINGS_FILE} 不是合法 JSON，没动它`);
    else {
      const m = A.mergeSettings(cur, { shimPath: shimRel });
      if (m.state === "ok") say(OK, "PreToolUse 守卫", m.note);
      else if (m.state === "bad") say(BAD, "PreToolUse 守卫", m.note);
      else if (o.check) say(BAD, "PreToolUse 守卫", `${A.SETTINGS_FILE} 里没有指向 ${shimRel} 的 Bash hook：agent 经 Bash 发的 git 命令没人拦`);
      else { writeJson(abs(A.SETTINGS_FILE), m.next); say(DID, "PreToolUse 守卫", `接进 ${A.SETTINGS_FILE}${m.note ? "；" + m.note : ""}`); }
    }
  }

  /* ---------------------------------------------------------------- 5. npm 接线 */
  {
    if (!exists("package.json")) {
      say(INFO, "npm 接线", "本仓没有 package.json，所以 `prepare` 那条自动装钩子的路不存在。" +
        `每个克隆要各自跑一次 \`node ${A.SUBMODULE_PATH}/shared/setup-hooks.js\`，` +
        "而且守卫文案里建议的 npm install / npm ci 在这里补不回子模块——这条要照实告诉本仓的人。");
    } else {
      if (pkgBroken) say(BAD, "npm 接线", "package.json 不是合法 JSON，没动它");
      else {
        const m = A.mergePackageJson(consumerPkg);
        const notes = m.notes.join("；");
        if (m.state === "ok") say(OK, "npm 接线", "prepare / setup:hooks / test:guard 都在");
        else if (m.state === "info") say(INFO, "npm 接线", notes);
        else if (m.state === "bad") say(BAD, "npm 接线", notes);
        else if (o.check) say(BAD, "npm 接线", `package.json 里缺 prepare / setup:hooks / test:guard${notes ? "；" + notes : ""}`);
        else { writeJson(abs("package.json"), m.next); say(DID, "npm 接线", "补上 package.json 的脚本" + (notes ? "；" + notes : "")); }
      }
    }
  }

  /* ---------------------------------------------------------------- 6. 三份 caller */
  const wantQa = o.qa || exists(".github/workflows/qa-gate.yml");
  for (const kind of ["review-gate", "qa-gate", "labels-sync"]) {
    const file = ".github/workflows/" + kind + ".yml";
    if (kind === "qa-gate" && !wantQa) {
      say(INFO, "qa-gate", "没装（要装就加 --qa；装了还要把 `qa` 钉成必需检查、并让 labels-sync 传 qa-labels: true）");
      continue;
    }
    const got = readIf(file);
    if (got === null) {
      if (o.check) { say(BAD, kind, `${file} 不在`); continue; }
      const tpl = fs.readFileSync(path.join(__dirname, "templates", kind + ".yml"), "utf8");
      write(abs(file), A.renderCaller(tpl, { tag: infraTag, qa: wantQa }));
      say(DID, kind, `写了 ${file}，钉 ${infraTag}`);
      continue;
    }
    /* qa-labels 和「本仓到底装没装 qa-gate」一致不一致，由 lintCaller 判——
       **别在这儿自己判一遍**：这条判定曾经写在这里、拿文件原文 `got` 去 test，
       于是绕开了 lintCaller 里剥注释那一步，一行注释就能把它翻过来（实跑过）。 */
    const { problems, refs } = A.lintCaller(kind, got, { qa: wantQa });
    if (!problems.length) say(OK, kind, `${file}，钉 ${refs.join(" / ")}`);
    else say(BAD, kind, `${file}：\n      - ` + problems.join("\n      - "));
  }

  /* ------------------------------------------------------- 6.5 docs-only（只指路） */
  {
    const used = tryGit(["grep", "-l", "actions/docs-only", "--", ".github/workflows"]).ok;
    const where = `${A.SUBMODULE_PATH}/adopt/templates/docs-only-step.yml`;
    if (used) say(OK, "docs-only", "本仓已经有 workflow 在用它");
    else say(INFO, "docs-only", `没在用。它**不是 caller、是一个步骤**，跳哪几步逐仓不同，` +
      `所以脚本不动本仓的 test.yml——要用就照 ${where} 抄进去（把 __INFRA_TAG__ 换成 ${infraTag}），` +
      "记住那个 job 要 checkout 且 fetch-depth: 0。");
  }

  /* ---------------------------------------------------------------- 7. skill 存根 */
  if (o.noSkill) say(INFO, "skill 存根", "这次跳过了（--no-skill）");
  else if (exists(A.SKILL_STUB)) say(OK, "skill 存根", A.SKILL_STUB);
  else if (o.check) say(INFO, "skill 存根", `${A.SKILL_STUB} 不在（没有它照样能用，只是下次升级要自己想起来读 ${A.SUBMODULE_PATH}/adopt/SKILL.md）`);
  else { write(abs(A.SKILL_STUB), stub(A)); say(DID, "skill 存根", `写了 ${A.SKILL_STUB}`); }

  /* ---------------------------------------------------------------- 打印结论 */
  console.log("");
  for (const r of report) console.log(`${r.mark} ${r.title}${r.detail ? "：" + r.detail : ""}`);

  const bad = report.filter((r) => r.mark === BAD).length;
  console.log("\n" + "—".repeat(60));
  console.log(`第三层（仓库设置）脚本改不了，**人去网页上点**，一条都不能省：
  1. 默认分支的 ruleset：禁止直推、要求 PR
  2. 必需检查里加 \`review\`${wantQa ? "、`qa`" : ""}（**是被调用方用 API 写出来的那个名字**，
     不是 "review-gate / gate" 那种 job 名，钉错了永远等不到）
  3. 本仓自己的 test 检查也钉成必需（有的话）
  4. dev-infra 哪天改回私有，还要去它的 Settings → Actions → General → Access 放行本组织`);
  if (!o.check) {
    console.log(`\n改动都留在工作区（subtree 那两个提交除外），**脚本不提交也不推送**。
接下来：看一遍 git diff → 提交 → 开 PR → 让 code-reviewer 评审。
合并后再跑一次 \`node ${A.SUBMODULE_PATH}/adopt/adopt.js --check\` 验收。`);
  }
  process.exit(bad ? 1 : 0);

  /* -------------------------------------------------------------------- 小工具 */
  function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  function writeJson(file, obj) { write(file, JSON.stringify(obj, null, 2) + "\n"); }
  function urlToRepo(url) {
    const m = /([^/:]+\/[^/]+?)(\.git)?$/.exec(String(url));
    return m ? m[1] : String(url);
  }
};

function stub(A) {
  return `---
name: dev-infra
description: 本仓和 GinkgoLeafLab 共享开发基础设施（dev-infra / dev-agents）之间的接线——接入、升级版本号、移子模块指针、重接 agent 定义、门禁没生效时怎么查。涉及"共享基础设施""dev-infra""升级 uses""子模块指针""agent 角色定义从哪来"时用它。
---

# 共享基础设施：这个仓库这一侧

**真相在上游，不在这份文件里。** 正文是 \`${A.SUBMODULE_PATH}/adopt/SKILL.md\`（子模块里那一份），
**先读它**，再回来做事。这里只放一句这个仓库自己的话：这份存根是刻意不抄正文的——
抄一份就会和上游漂开，而漂了没有任何东西会报错。

读不到那份文件（子模块是空的）时先补上它，这条命令在分支守卫缺席时是被放行的：

\`\`\`
git submodule update --init --recursive
\`\`\`

体检本仓这一侧的全部接线：

\`\`\`
node ${A.SUBMODULE_PATH}/adopt/adopt.js --check
\`\`\`
`;
}
