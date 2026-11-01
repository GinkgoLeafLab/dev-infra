#!/usr/bin/env node
/* 标签竞态（GinkgoLeafLab/Tianshu#199）的回归测试。跑法：
     node .github/actions/qa-gate/gate-race.test.js

   ## 这条测试复现的是什么

   PR #199 打开时 tianshuplugin 在 300ms 内先后打上 ui-required、qa-required。
   `qa` / `ui` 是**必需检查**，所以 opened 那一跑也必须报告一次，而它拿到的
   `github.event.pull_request.labels` 是**事件创建那一刻**的快照——那一跑写了
   `ui` = success（「未标记需要 UI 评审」）。紧接着两个 labeled 事件各起一次 run，
   它们和 opened 那次在**同一个并发组**里：

     - 同一组里，新排队的 run 会取消**先前排队**的 run（`cancel-in-progress: false`
       只保证「在跑的不被砍」，排队的那次照样被挤掉）；
     - job 级 `if` 要等轮到它执行才判，之前只看得到「排队」这个状态。

   于是「打的是无关标签、注定 skip」的那次把「打的是本门标签、正要重评」的那次
   挤掉，自己再 skip 掉。实测（PR #199，head 89d6917）：

     | 工作流 | run | 结果 |
     |---|---|---|
     | ui-gate | 41285479459（opened） | success，写了 `ui` = success |
     | ui-gate | 41285482941（ui-required labeled） | **cancelled**（排队时被后面那次挤掉） |
     | ui-gate | 41285483063（qa-required labeled） | skipped（`if` 只认 ui-*） |
     | qa-gate | 41285482891（ui-required labeled） | cancelled |
     | qa-gate | 41285482991（qa-required labeled） | success，写了 `qa` = failure |

   qa 那次只是**碰巧**顺序对（相关标签的事件最后到），所以看起来是对的；把两个标签
   的先后换一下，qa 同样会被打绿。这不是「哪个门的问题」，是并发组只按 PR 号分的
   结构性问题。

   ## 修法钉在这里的两件事

   1. **并发组按「这次事件会不会真的跑判定」分成两组**（`live` / `skipped`）。
      会 skip 的 run 只能取消同类，碰不到真正要重评的那次。
   2. **判定用的标签现读**（可复用工作流里的 `live_labels` 步骤）。事件快照在
      webhook 乱序送达时同样会过期：先发生、后送达的 opened 会带着旧快照最后执行。
      现读让「没标」推出的 success 一定是执行那一刻真的没标。

   两件事都必须有：只做 1，乱序送达仍可能让旧快照最后落笔；只做 2，被挤掉的那次
   根本没机会现读。下面的模拟把两者分开验，结构断言则钉住模板里确实两条都在。 */
"use strict";

const fs = require("fs");
const path = require("path");

const { GATES, decide } = require("./qa-gate.js");

const ROOT = path.join(__dirname, "..", "..", "..");
const TPL = (n) => fs.readFileSync(path.join(ROOT, "adopt", "templates", n + ".yml"), "utf8");
const WF = (n) => fs.readFileSync(path.join(ROOT, ".github", "workflows", n + ".yml"), "utf8");
const ACT = () => fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) pass++;
  else { fail++; console.error(`  ✗ ${name}：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`); }
}
function ok(name, cond) { check(name, !!cond, true); }
const code = (t) => t.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const groupLine = (t) => (code(t).match(/^\s+group:\s*(.+)$/m) || [])[1] || "";

/* ------------------------------------------------------------------ */
/* 一、结构：两个修法都必须真的在交付物里                                */
/* ------------------------------------------------------------------ */

for (const [kind, gate] of [["qa-gate", GATES.qa], ["ui-gate", GATES.ui]]) {
  const tpl = TPL(kind);
  const g = groupLine(tpl);
  ok(`${kind} 模板：并发组按 PR 号 + 判定谓词分区`,
    g.includes("github.event.pull_request.number") &&
    g.includes(`startsWith(github.event.label.name, '${gate.name}-')`) &&
    g.includes("'skipped'") && g.includes("'live'"));
  ok(`${kind} 模板：job 级 if 里仍有同一个谓词`,
    /\|\|\s*startsWith\(github\.event\.label\.name, '/.test(code(tpl)));
  ok(`${kind} 模板：cancel-in-progress: false`,
    /cancel-in-progress:\s*false/.test(code(tpl)));

  /* 可复用工作流：判定前现读标签，并把它交给组合动作。 */
  const wf = code(WF(kind));
  ok(`${kind} 工作流：有现读标签的步骤（live_labels）`, /^\s*- id: live_labels\s*$/m.test(wf));
  ok(`${kind} 工作流：现读的是 PR 的 labels`,
    wf.includes('gh api "repos/$REPO/pulls/$PR" --jq \'.labels[].name\' | jq -R \'select(length > 0) | .\' | jq -s -c .'));
  ok(`${kind} 工作流：现读结果经 labels 输入交给判定动作`,
    wf.includes("labels: ${{ steps.live_labels.outputs.labels }}"));
}

ok("组合动作：labels 输入优先于事件快照",
  /QA_GATE_LABELS:\s*\$\{\{\s*inputs\.labels != '' && inputs\.labels \|\| toJSON\(github\.event\.pull_request\.labels\.\*\.name\)\s*\}\}/.test(ACT()));

{
  const tpl = TPL("review-gate");
  const g = groupLine(tpl);
  ok("review-gate 模板：并发组同样把 live / skipped 分开",
    g.includes("github.event.pull_request.number") &&
    g.includes("github.event.label.name == 'review-passed'") &&
    g.includes("github.event.action == 'synchronize'") &&
    g.includes("'skipped'") && g.includes("'live'"));
  ok("review-gate 模板：cancel-in-progress: false", /cancel-in-progress:\s*false/.test(code(tpl)));

  /* 本仓自己那份 caller 也是同一个形状（它不走 adopt 的渲染，单独钉着）。 */
  const self = code(WF("self-review-gate"));
  ok("self-review-gate：并发组同样分区",
    /^\s+group: review-gate-.*'live'.*'skipped'.*$/m.test(self) ||
    (groupLine(WF("self-review-gate")).includes("review-passed") &&
     groupLine(WF("self-review-gate")).includes("synchronize") &&
     groupLine(WF("self-review-gate")).includes("'skipped'")));
}

/* ------------------------------------------------------------------ */
/* 二、行为：把 GitHub 的并发语义照原样模拟一遍                          */
/* ------------------------------------------------------------------ */

/* 一次事件的时序。`labels` 是**事件创建那一刻**的快照；`t` 单位 ms。
   A 是 PR #199 的实测顺序（由两个工作流的 run 名单反推：ui-required 的 run 先建、
   qa-required 的后建，后者挤掉了前者）。
   B 把两个标签的先后对调——用来证明「qa 当时是对的」只是顺序的运气。 */
const SCENARIO_A = [
  { t: 0,   action: "opened",  label: null,          labels: [] },
  { t: 300, action: "labeled", label: "ui-required", labels: ["ui-required"] },
  { t: 591, action: "labeled", label: "qa-required", labels: ["ui-required", "qa-required"] },
];
const SCENARIO_B = [
  { t: 0,   action: "opened",  label: null,          labels: [] },
  { t: 300, action: "labeled", label: "qa-required", labels: ["qa-required"] },
  { t: 591, action: "labeled", label: "ui-required", labels: ["qa-required", "ui-required"] },
];

/* job 级 if：非标签事件全放行；标签事件只认本门前缀。和模板里的 if 同义。 */
const willRun = (gate, e) =>
  (e.action !== "labeled" && e.action !== "unlabeled") ||
  (e.label || "").startsWith(gate.name + "-");

/* 旧 / 新两种并发组。新组就是模板里那一行表达式的语义：
   会 skip 的事件进 `-skipped`，其余进 `-live`。 */
const groupOf = (gate, e, partitioned) =>
  partitioned
    ? `${gate.name}-1-${willRun(gate, e) ? "live" : "skipped"}`
    : `${gate.name}-1`;

/* `cancel-in-progress: false` 的语义：
   - 同组里有在跑的 → 新 run 排队；**先前排队的那个被取消**；
   - 同组里没在跑的 → 立刻执行；
   - 在跑的不会被取消。
   真正执行的 run 占着 runner `duration` ms，**完成时才写检查**；job 级 `if` 为 false
   的 run 记为 skipped，不写检查。`duration` 不能省：竞态的全部前提就是 opened 那次
   还在跑的时候，两个 labeled 事件先后到达。 */
function simulate(gate, events, partitioned, duration = 5000) {
  const runs = [];
  const groups = new Map();      // group -> { running, pending }
  const writes = [];             // { at, context, state, desc, run }
  const tasks = events.map((e) => ({ at: e.t, kind: "arrive", e }));
  let seq = 0;

  const complete = (run, at) => {
    run.status = "completed";
    const g = groups.get(run.group);
    g.running = null;
    drain(run.group, at);
  };

  const start = (run, now) => {
    const g = groups.get(run.group);
    run.status = "running";
    g.running = run;
    if (!run.willRun) {
      run.conclusion = "skipped";
      complete(run, now);
      return;
    }
    const d = decide(run.event.labels, run.event.action, run.event.label || "", gate);
    run.conclusion = "success";
    writes.push({ at: now + duration, context: gate.name, state: d.conclusion === "failure" ? "failure" : "success", desc: d.desc, run: run.id });
    tasks.push({ at: now + duration, kind: "complete", run });
  };

  const drain = (group, now) => {
    const g = groups.get(group);
    if (g && !g.running && g.pending) {
      const next = g.pending;
      g.pending = null;
      start(next, now);
    }
  };

  /* 同一个组同一时刻只可能有一个在跑（或者一个在跑 + 一个排队），所以这里不需要锁。 */
  const enqueue = (run, now) => {
    let g = groups.get(run.group);
    if (!g) { g = { running: null, pending: null }; groups.set(run.group, g); }
    if (g.pending) {                 // 先前排队的那次被新事件挤掉
      g.pending.conclusion = "cancelled";
      g.pending.status = "completed";
      g.pending = null;
    }
    if (g.running) {
      g.pending = run;
      run.status = "pending";
    } else {
      start(run, now);
    }
  };

  while (tasks.length) {
    tasks.sort((a, b) => a.at - b.at || (a.kind === "complete" ? -1 : 1));
    const task = tasks.shift();
    if (task.kind === "arrive") {
      const e = task.e;
      const run = {
        id: `${gate.name}-run-${++seq}`,
        event: e,
        group: groupOf(gate, e, partitioned),
        willRun: willRun(gate, e),
        status: "created",
        conclusion: null,
      };
      runs.push(run);
      enqueue(run, task.at);
    } else {
      complete(task.run, task.at);
    }
  }

  writes.sort((a, b) => a.at - b.at);
  const last = writes[writes.length - 1] || null;
  return { runs, writes, status: last };
}

/* 旧分组的结论**取决于两个标签的先后**：最后到的那个标签的 run 活下来，
   另一道门的重评被挤掉、停在 opened 的 success 上。把顺序对调，受害的门就换成另一道。
   这正是「qa 当时看起来是对的」只是运气——结构性缺陷不在某一道门里。 */
const OLD_EXPECT = {
  "A（#199 实测顺序）": { ui: "success", qa: "failure" },
  "B（两个标签对调）": { qa: "success", ui: "failure" },
};

for (const [name, events] of [["A（#199 实测顺序）", SCENARIO_A], ["B（两个标签对调）", SCENARIO_B]]) {
  for (const gate of [GATES.qa, GATES.ui]) {
    const oldR = simulate(gate, events, false);
    const newR = simulate(gate, events, true);

    /* 旧行为：一次排队被挤掉，且最终状态是那个被挤掉的门应得的反面。 */
    check(`[${name}] ${gate.name} 旧分组：有一次排队被挤掉（复现）`,
      oldR.runs.filter((r) => r.conclusion === "cancelled").length, 1);
    check(`[${name}] ${gate.name} 旧分组：最终状态是 ${OLD_EXPECT[name][gate.name]}`,
      oldR.status && oldR.status.state, OLD_EXPECT[name][gate.name]);

    /* 新行为：没有排队被挤掉，最终必须是 failure（未评审）。 */
    check(`[${name}] ${gate.name} 新分组：没有排队被挤掉`,
      newR.runs.filter((r) => r.conclusion === "cancelled").length, 0);
    check(`[${name}] ${gate.name} 新分组：最终状态是 failure（未评审）`,
      newR.status && newR.status.state, "failure");
    /* 正对照：真正重评的那次确实执行并写了检查，不是「没人写」造成的假失败。 */
    const labeled = newR.runs.find((r) => r.event.label === `${gate.name}-required`);
    check(`[${name}] ${gate.name} 新分组：本门标签的 labeled run 真的执行了`,
      !!(labeled && newR.writes.some((w) => w.run === labeled.id)), true);
    const opened = newR.runs.find((r) => r.event.action === "opened");
    check(`[${name}] ${gate.name} 新分组：opened 那次也报告了`,
      !!(opened && newR.writes.some((w) => w.run === opened.id)), true);
  }
}

/* 正对照：模拟器自己能分别出两种分组——不然上面每一条都可能只是「都返回 success」。 */
{
  const oldUi = simulate(GATES.ui, SCENARIO_A, false);
  const newUi = simulate(GATES.ui, SCENARIO_A, true);
  check("模拟器正对照：同一组事件在新旧分组下结论不同",
    oldUi.status.state !== newUi.status.state, true);
}

console.log(`\n标签竞态回归：${pass} 条通过${fail ? `，${fail} 条失败` : ""}`);
process.exit(fail ? 1 : 0);
