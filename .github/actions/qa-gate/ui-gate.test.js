/* UI 评审门禁的回归测试：node .github/actions/qa-gate/ui-gate.test.js
   （本仓 .github/workflows/test.yml 跑的就是它）

   ui 门和 qa 门**共用同一份判定脚本**（qa-gate.js 里的 GATES 表选标签名与描述），
   所以这里不重写判定，而是把「qa 门那套断言里最要命的几条」对 ui 门再做一遍，
   并钉住 ui 特有的接线：

   - 标签名 / context 名是跨系统契约，钉字面量（只比常量的话两边一起改错是全绿的）
   - **ui 的结论里不许冒出 qa**：门名接错的后果是消费仓的 head SHA 上多出一个 `qa`、
     缺一个 `ui`，PR 停在 Expected，或者更糟——写出了不该有的 `qa`
   - **qa 那一路没被碰**：不传门名 / 传空串，必须仍是 qa
   - 可复用工作流 ui-gate.yml 必须带 `gate: ui`（漏了动作按默认走 qa） */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CLI = path.join(__dirname, "qa-gate.js");
const { GATES, gateFor, decide, statusBody, ACTIONS, DESC_MAX } = require("./qa-gate.js");
const SHA = "0123456789abcdef0123456789abcdef01234567";

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) pass++;
  else { fail++; console.error(`  ✗ ${name}：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`); }
}
function ok(name, cond) { check(name, !!cond, true); }

/* —— 契约：字面量 —— */
check("ui 门的 context", GATES.ui.name, "ui");
check("ui 要评审的标签名", GATES.ui.required, "ui-required");
check("ui 放行的标签名", GATES.ui.passed, "ui-passed");
check("qa 门没被改", `${GATES.qa.name}/${GATES.qa.required}/${GATES.qa.passed}`, "qa/qa-required/qa-passed");
check("gateFor(ui) 就是 GATES.ui", gateFor("ui"), GATES.ui);
for (const bad of ["UI", "uI", "", "review", "__proto__", "constructor", undefined]) {
  let threw = false;
  try { gateFor(bad); } catch { threw = true; }
  ok(`gateFor(${JSON.stringify(bad)}) 要抛（悄悄退回 qa 会在 qa 上写出 ui 的结论）`, threw);
}

/* —— 两道门各跑同一套最要命的断言 —— */
for (const g of [GATES.qa, GATES.ui]) {
  const R = g.required, P = g.passed, tag = `[${g.name}]`;
  const D = (labels, action = "labeled", label = P) => decide(labels, action, label, g);
  const ST = (labels, action = "labeled", label = P) => statusBody(labels, action, label, "", g).status;

  check(`${tag} 没标：放行`, D([]).conclusion, "neutral");
  check(`${tag} 标了没过：failure`, D([R]).conclusion, "failure");
  check(`${tag} 标了且过了：success`, D([R, P]).conclusion, "success");
  check(`${tag} 没标但过了：success（多评不是错）`, D([P]).conclusion, "success");
  check(`${tag} 等待时 commit status 是 failure（不是 pending / success / error）`, ST([R], "opened", "").state, "failure");
  check(`${tag} 免测落到 success`, ST([], "opened", "").state, "success");
  check(`${tag} context 是门名（必需检查按它匹配）`, ST([]).context, g.name);

  /* 防过期快照：除了 labeled + 它自己的 passed，其余一律不认。
     别门的标签（qa 门看到 ui-passed，反之亦然）同样只是普通标签，不能放行。 */
  const other = g === GATES.qa ? GATES.ui : GATES.qa;
  for (const [name, action, label] of [
    ["推了新 commit", "synchronize", ""], ["PR 刚开", "opened", ""], ["PR 被重开", "reopened", ""],
    ["打的是同门的另一个标签", "labeled", R], ["摘掉同门的另一个标签", "unlabeled", R],
    ["摘掉的正是 passed", "unlabeled", P],
  ]) {
    const d = D([R, P], action, label);
    check(`${tag} ${name}：快照里的 ${P} 不算数 → failure`, d.conclusion, "failure");
    check(`${tag} ${name}：不摘标签（会撞 404）`, d.removeLabel, null);
    check(`${tag} ${name}：没标要评时照旧放行`, D([P], action, label).conclusion, "neutral");
  }
  check(`${tag} 别门的 passed（${other.passed}）不能放行本门`, D([R, other.passed], "labeled", other.passed).conclusion, "failure");
  check(`${tag} 别门的 required（${other.required}）不会让本门等待`, D([other.required]).conclusion, "neutral");
  const fresh = D([R, P], "labeled", P);
  check(`${tag} 正对照：打上 ${P} 那一下放行`, fresh.conclusion, "success");
  check(`${tag} 正对照：并摘掉 ${P}`, fresh.removeLabel, P);
  check(`${tag} 永远不摘 ${R}`, [D([R, P]), D([R])].some((d) => d.removeLabel === R), false);

  /* 描述 ≤140，且四种情况都量；描述里不许出现另一道门的名字 */
  for (const [name, labels, action, label] of [
    ["免测", [], "opened", ""], ["等待", [R], "opened", ""],
    ["通过", [R, P], "labeled", P], ["过期", [R, P], "synchronize", ""],
  ]) {
    const d = ST(labels, action, label).description;
    ok(`${tag} ${name}的描述长度 ≤ ${DESC_MAX}（实际 ${d.length}）`, d.length > 0 && d.length <= DESC_MAX);
    ok(`${tag} ${name}的描述不带别门的标签名（${other.required}/${other.passed}）`,
      !d.includes(other.required) && !d.includes(other.passed));
  }
}

/* ui 特有的措辞：免测描述按要求写明「未标记需要 UI 评审」，且不说 QA */
const uiSkip = statusBody([], "opened", "", "", GATES.ui).status.description;
ok("ui 免测描述含「未标记需要 UI 评审」", uiSkip.includes("未标记需要 UI 评审"));
for (const [name, labels, action, label] of [
  ["免测", [], "opened", ""], ["等待", ["ui-required"], "opened", ""],
  ["通过", ["ui-required", "ui-passed"], "labeled", "ui-passed"], ["过期", ["ui-required", "ui-passed"], "synchronize", ""],
]) {
  const d = statusBody(labels, action, label, "", GATES.ui).status.description;
  ok(`ui ${name}的描述里不许出现 QA / qa（接错门的明显症状）：${d}`, !/qa/i.test(d));
}

/* qa 一路的默认参数：不传门就是 qa（已有调用点一个字节不用改） */
check("decide 默认门是 qa", decide(["qa-required"], "opened", "").desc, decide(["qa-required"], "opened", "", GATES.qa).desc);
check("statusBody 默认 context 是 qa", statusBody([], "opened", "", "").status.context, "qa");
for (const a of ACTIONS) ok(`事件 ${a} 对 ui 门也被识别`, ACTIONS.includes(a));

/* —— CLI：门名走 QA_GATE_NAME —— */
function runCLI(env) {
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ui-gate-")), "out");
  fs.writeFileSync(outFile, "");
  const base = { ...process.env };
  delete base.QA_GATE_NAME;
  try {
    const stdout = execFileSync(process.execPath, [CLI], {
      env: { ...base, GITHUB_OUTPUT: outFile, QA_GATE_EVENT: "labeled", QA_GATE_LABEL: "ui-passed", QA_GATE_SHA: SHA, ...env },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, output: fs.readFileSync(outFile, "utf8") };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, stdout: e.stdout || "", output: fs.readFileSync(outFile, "utf8") };
  }
}
const both = JSON.stringify(["ui-required", "ui-passed"]);
const u = runCLI({ QA_GATE_NAME: "ui", QA_GATE_LABELS: both });
check("CLI ui：正常退出", u.code, 0);
check("CLI ui：context 是 ui", JSON.parse(u.stdout).context, "ui");
check("CLI ui：success", JSON.parse(u.stdout).state, "success");
check("CLI ui：摘的是 ui-passed", u.output.trim(), "remove_label=ui-passed");
const uStale = runCLI({ QA_GATE_NAME: "ui", QA_GATE_EVENT: "synchronize", QA_GATE_LABEL: "", QA_GATE_LABELS: both });
check("CLI ui：新推一版快照里的 ui-passed 不算 → failure", JSON.parse(uStale.stdout).state, "failure");
check("CLI ui：那条路不摘标签", uStale.output.trim(), "remove_label=");
const uWait = runCLI({ QA_GATE_NAME: "ui", QA_GATE_EVENT: "opened", QA_GATE_LABEL: "", QA_GATE_LABELS: '["ui-required"]' });
check("CLI ui：标了没过 → failure", JSON.parse(uWait.stdout).state, "failure");
/* qa 的标签对 ui 门无效：这是「门名接对了」的反向证据 */
const uQa = runCLI({ QA_GATE_NAME: "ui", QA_GATE_EVENT: "opened", QA_GATE_LABEL: "", QA_GATE_LABELS: '["qa-required"]' });
check("CLI ui：只有 qa-required → 免测（不被 qa 标签影响）", JSON.parse(uQa.stdout).state, "success");

/* qa 路径不受影响：不传、传空串、传 qa，三者等价 */
for (const [name, env] of [["不传", {}], ["空串", { QA_GATE_NAME: "" }], ["qa", { QA_GATE_NAME: "qa" }]]) {
  const r = runCLI({ ...env, QA_GATE_LABEL: "qa-passed", QA_GATE_LABELS: JSON.stringify(["qa-required", "qa-passed"]) });
  check(`CLI 门名${name}：仍是 qa 门`, JSON.parse(r.stdout).context, "qa");
  check(`CLI 门名${name}：摘 qa-passed`, r.output.trim(), "remove_label=qa-passed");
}
/* 失败方向：认不得的门名非零退出且不吐检查体 */
for (const bad of ["UI", "ui ", "review", "nope"]) {
  const r = runCLI({ QA_GATE_NAME: bad, QA_GATE_LABELS: both });
  ok(`门名 ${JSON.stringify(bad)} → 非零退出（拦住，不是退回 qa）`, r.code !== 0);
  check(`门名 ${JSON.stringify(bad)} → 不吐检查体`, r.stdout.trim(), "");
}

/* —— 接线：ui-gate.yml 与动作 —— */
{
  const dir = path.join(__dirname, "..", "..");
  const wf = fs.readFileSync(path.join(dir, "workflows", "ui-gate.yml"), "utf8");
  const act = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");
  const code = (t) => t.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  const wfc = code(wf), actc = code(act);

  ok("U1 正对照：读到的是可复用工作流（on: workflow_call）", /^on:\n\s*workflow_call:/m.test(wfc));
  const refs = (wfc.match(/^\s*uses:.*$/gm) || []);
  ok("U2 正对照：工作流里确实有 uses:", refs.length > 0);
  ok("U2 每一处引用都精确是 `$/.github/actions/qa-gate`（同仓自引用，不带 @ref、不是 ./）",
    refs.length > 0 && refs.every((l) => /uses:\s*\$\/\.github\/actions\/qa-gate\s*$/.test(l)));
  /* 变异落点：删掉 `gate: ui` 这两行，动作按默认走 qa → 这条红 */
  ok("U3 **选的是 ui 门**：uses 紧跟 `with: gate: ui`（漏了就会在消费仓写出 `qa`）",
    /uses:\s*\$\/\.github\/actions\/qa-gate\s*\n\s+with:\s*\n\s+gate:\s*ui\s*\n/.test(wfc));
  ok("U4 这条路上不许有 checkout（权限取自 caller 且只能降不能升）", !/actions\/checkout@/.test(wfc));
  ok("U5 写的是 commit status（statuses/$SHA），不是 check run",
    /gh api "repos\/\$REPO\/statuses\/\$SHA" --input "\$BODY"/.test(wfc) && !/check-runs/.test(wfc));
  ok("U6 摘的是动作吐出来的那个标签（不是写死的名字，写死就会和门名脱钩）",
    /LABEL: \$\{\{ steps\.gate\.outputs\.remove_label \}\}/.test(wfc) && /remove_label != ''/.test(wfc));
  ok("U7 工作流里没有 `qa` 门的字样残留（context / 标签名）",
    !/\bqa-(required|passed)\b/.test(wfc) && !/context.*\bqa\b/.test(wfc));

  ok("U8 动作声明了 gate 输入", /^inputs:\s*\n\s+gate:\s*$/m.test(actc));
  ok("U9 **gate 输入的默认值是 qa**（已有的 qa-gate.yml 不传它，行为必须和改造前一样）",
    /^inputs:\s*\n\s+gate:[\s\S]*?\n\s+default:\s*qa\s*\n/m.test(actc));
  ok("U10 gate 输入被放进 QA_GATE_NAME", actc.includes("QA_GATE_NAME: ${{ inputs.gate }}"));
  /* qa-gate.yml 没被改成传 gate（它就该吃默认值） */
  const qaWf = code(fs.readFileSync(path.join(dir, "workflows", "qa-gate.yml"), "utf8"));
  ok("U11 qa-gate.yml 不传 gate（吃默认 qa）", !/\bgate:\s*(ui|qa)\b/.test(qaWf));
  ok("U12 ui-gate.yml 引用的路径真的有 action.yml",
    fs.existsSync(path.join(dir, "actions", "qa-gate", "action.yml")));
}

console.log(`\nUI 门禁判定：${pass} 条通过${fail ? `，${fail} 条失败` : ""}`);
process.exit(fail ? 1 : 0);
