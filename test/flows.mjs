import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server;
let base;
let tmpDir;

async function start() {
  tmpDir = await mkdtemp(join(tmpdir(), "pigeon-test-"));
  const dbFile = join(tmpDir, "pigeons.json");
  const port = 4000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [new URL("../server.js", import.meta.url).pathname], {
    env: { ...process.env, PORT: String(port), DB_FILE: dbFile }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server start timeout")), 8000);
    server.stdout.on("data", d => { if (String(d).includes("listening")) { clearTimeout(timer); resolve(); } });
    server.stderr.on("data", d => process.stderr.write(d));
  });
  return dbFile;
}
async function stop() {
  server.kill("SIGKILL");
  await rm(tmpDir, { recursive: true, force: true });
}
async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "Content-Type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  return { status: res.status, json };
}
const rid = () => "REQ-" + Math.random().toString(36).slice(2, 10);

let pass = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { console.error("  ✗", name, extra !== undefined ? JSON.stringify(extra) : ""); process.exitCode = 1; }
}
const intake = (ringNo, clerk, overrides = {}) => ({
  requestId: rid(), ringNo, owner: "北岸棚", clerk,
  fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "北岸A棚",
  vaccines: [{ date: "2026-10-01", name: "新城疫" }],
  firstRace: { date: "2026-10-02", event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18 },
  ...overrides
});

async function testConcurrentConflict() {
  console.log("1) 两名登记员同足环并发：先到生效，后到留冲突不改档案");
  const payloads = [intake("CHN-2026-C1", "登记员甲"), intake("CHN-2026-C1", "登记员乙")];
  const [a, b] = await Promise.all(payloads.map(p => call("POST", "/api/intake", p)));
  const first = a.status === 201 ? a : b;
  const second = a.status === 409 ? a : b;
  check("先到 201 生成待确认回执", first.status === 201 && first.json.receipt.status === "pending", first.json);
  check("后到 409 且指向先到回执", second.status === 409 && second.json.winnerReceiptNo === first.json.receipt.receiptNo, second.json);

  const { json: conflicts } = await call("GET", "/api/conflicts");
  check("冲突留痕保留后到整份内容（登记员乙）",
    conflicts.some(c => c.winnerReceiptNo === first.json.receipt.receiptNo && c.clerk === "登记员乙"), conflicts);

  // 甲确认入棚；乙再确认也不能改档案
  const cr = await call("POST", `/api/receipts/${first.json.receipt.receiptNo}/confirm`, { requestId: rid() });
  check("先到回执可确认入棚", cr.status === 200 && cr.json.pigeon.ringNo === "CHN-2026-C1", cr.json);
  check("确认后鸽只档案存在", cr.json.pigeon.owner === "北岸棚");

  // 新登记员再交同足环：仍是冲突，确认档案纹丝不动
  const again = await call("POST", "/api/intake", intake("CHN-2026-C1", "登记员丙", { owner: "黑棚改档", requestId: rid() }));
  check("确认后同环再交仍 409", again.status === 409, again.json);
  const { json: pigeons } = await call("GET", "/api/pigeons");
  const p = pigeons.find(x => x.ringNo === "CHN-2026-C1");
  check("后到内容未污染确认档案（鸽主不变、仅一份疫苗/成绩）",
    p.owner === "北岸棚" && p.vaccines.length === 1 && p.races.length === 1, p);
}

async function testAmendInvalidates() {
  console.log("2) 确认前父母环号改动：原收鸽失效并重算");
  const r = await call("POST", "/api/intake", intake("CHN-2026-A1", "登记员甲"));
  check("待确认回执 201", r.status === 201, r.json);
  const no = r.json.receipt.receiptNo;

  const am = await call("POST", `/api/receipts/${no}/amend-parents`, { requestId: rid(), fatherRing: "CHN-2020-007", motherRing: "CHN-2021-009" });
  check("更正返回重算回执", am.status === 200 && am.json.changed === true, am.json);
  check("原回执标记 invalid 并指向新回执", am.json.invalidated.status === "invalid" && am.json.invalidated.supersededBy === am.json.receipt.receiptNo, am.json);
  check("重算回执携带新父母环号", am.json.receipt.fatherRing === "CHN-2020-007" && am.json.receipt.motherRing === "CHN-2021-009");
  check("疫苗随重算迁移", am.json.receipt.vaccines.length === 1 && am.json.receipt.vaccines[0].name === "新城疫");
  check("首场成绩随重算迁移", am.json.receipt.firstRace && am.json.receipt.firstRace.rank === 18);

  const oldConfirm = await call("POST", `/api/receipts/${no}/confirm`, { requestId: rid() });
  check("失效回执不能再确认", oldConfirm.status === 409, oldConfirm.json);

  const cf = await call("POST", `/api/receipts/${am.json.receipt.receiptNo}/confirm`, { requestId: rid() });
  check("重算回执确认后档案使用新父母环号",
    cf.json.pigeon.fatherRing === "CHN-2020-007" && cf.json.pigeon.motherRing === "CHN-2021-009", cf.json);

  // 已确认后不允许更正
  const late = await call("POST", `/api/receipts/${am.json.receipt.receiptNo}/amend-parents`, { requestId: rid(), fatherRing: "X", motherRing: "Y" });
  check("确认后更正被拒", late.status === 409, late.json);
}

async function testPowerLossReplay() {
  console.log("3) 写入失败凭原请求编号恢复：不重复疫苗/训放/回执");
  const payload = intake("CHN-2026-P1", "登记员甲");
  const requestId = payload.requestId;

  // after-intent：意图与回执已落盘，随后“断电”
  const crashed = await call("POST", "/api/intake", payload, { "X-Simulate-Failure": "after-intent" });
  check("断电返回 503 可恢复", crashed.status === 503 && crashed.json.error === "power_loss_recoverable", crashed.json);

  // 同一请求编号重放（不带故障头）：返回原回执，不新建第二张
  const replay = await call("POST", "/api/intake", { ...payload }, {});
  check("重放 200/201 且不产生新编号", replay.status === 201 && replay.json.receipt.ringNo === "CHN-2026-P1", replay.json);
  const { json: receipts } = await call("GET", "/api/receipts");
  check("该足环只有一张回执", receipts.filter(r => r.ringNo === "CHN-2026-P1").length === 1);

  // 确认阶段断电（档案尚未落盘）再凭同一编号重放
  const cCrash = await call("POST", `/api/receipts/${replay.json.receipt.receiptNo}/confirm`, { requestId: "C-P1-2" }, { "X-Simulate-Failure": "before-commit" });
  check("确认断电 503", cCrash.status === 503, cCrash.json);
  const cReplay = await call("POST", `/api/receipts/${replay.json.receipt.receiptNo}/confirm`, { requestId: "C-P1-2" });
  check("确认重放返回档案", cReplay.status === 200, cReplay.json);

  const { json: pigeons } = await call("GET", "/api/pigeons");
  const p = pigeons.find(x => x.ringNo === "CHN-2026-P1");
  check("疫苗只追加一次", p.vaccines.length === 1, p.vaccines);
  check("首场训放只追加一次", p.races.length === 1, p.races);

  // 旧成绩/疫苗接口：同请求编号重放 + 内容去重双保险
  const raceBody = { date: "2026-10-05", event: "200公里训放", distance: 200, rank: 3 };
  const r1 = await call("POST", "/api/pigeons/CHN-2026-P1/races", raceBody, { "X-Request-Id": "RACE-P1" });
  const r2 = await call("POST", "/api/pigeons/CHN-2026-P1/races", raceBody, { "X-Request-Id": "RACE-P1" });
  const r3 = await call("POST", "/api/pigeons/CHN-2026-P1/races", raceBody); // 无编号也按内容去重
  check("训放成绩接口重放幂等", r1.status === 200 && r2.status === 200 && r3.status === 200);
  const vBody = { date: "2026-10-06", name: "鸽痘" };
  await call("POST", "/api/pigeons/CHN-2026-P1/vaccines", vBody, { "X-Request-Id": "VAC-P1" });
  await call("POST", "/api/pigeons/CHN-2026-P1/vaccines", vBody, { "X-Request-Id": "VAC-P1" });
  await call("POST", "/api/pigeons/CHN-2026-P1/vaccines", vBody);
  const { json: after } = await call("GET", "/api/pigeons");
  const pp = after.find(x => x.ringNo === "CHN-2026-P1");
  check("重放后训放成绩总数不增加（2 条）", pp.races.length === 2, pp.races.map(r => r.event));
  check("重放后疫苗总数不增加（2 条）", pp.vaccines.length === 2, pp.vaccines.map(v => v.name));

  // 冲突路径的断电：before-commit 重放不得凭空生成生效回执
  const dup = intake("CHN-2026-P1", "登记员乙", { requestId: "DUP-P1" });
  const cc = await call("POST", "/api/intake", dup, { "X-Simulate-Failure": "before-commit" });
  check("冲突写前断电 503", cc.status === 503, cc.json);
  const cc2 = await call("POST", "/api/intake", dup);
  check("重放后得到 409 冲突", cc2.status === 409, cc2.json);
}

async function testMigration() {
  console.log("4) 旧数据迁移：按历史先后补齐回执，血统成绩不变");
  const before = await call("GET", "/api/pigeons");
  const snapshot = JSON.stringify(before.json);
  const m = await call("POST", "/api/migrate", {});
  check("3 条旧档案全部补齐", m.status === 200 && m.json.migrated.length === 3, m.json);
  check("全部标记为迁移回执且已确认", m.json.migrated.every(r => r.migrated && r.status === "confirmed"));
  const order = m.json.migrated.map(r => r.ringNo);
  check("按历史先后：CHN-2026-001(2026-04-01) 早于无日期的种鸽",
    order[0] === "CHN-2026-001", order);
  check("迁移回执登记员为历史迁移", m.json.migrated.every(r => r.clerk === "历史迁移"));

  const after = await call("GET", "/api/pigeons");
  check("血统、疫苗、成绩逐字节不变", JSON.stringify(after.json) === snapshot);

  // 再跑一次迁移：幂等，不重复补
  const m2 = await call("POST", "/api/migrate", {});
  check("重复迁移跳过已有回执档案", m2.json.migrated.length === 0, m2.json);

  // 迁移后新收鸽仍正常：与已确认迁移回执冲突
  const dup = await call("POST", "/api/intake", intake("CHN-2026-001", "登记员甲"));
  check("迁移确认的足环同样先到生效、新交留冲突", dup.status === 409, dup.json);
}

async function testValidation() {
  console.log("5) 基础校验");
  const noReq = await call("POST", "/api/intake", { ringNo: "X", owner: "o", clerk: "c" });
  check("缺 requestId 拒绝", noReq.status === 400, noReq.json);
  const bad = await call("POST", "/api/intake", { requestId: rid(), ringNo: "X" });
  check("缺必填字段 400", bad.status === 400, bad.json);
  const nf = await call("POST", "/api/receipts/RCV-2026-999999/confirm", { requestId: rid() });
  check("不存在回执 404", nf.status === 404, nf.json);
}

async function main() {
  const dbFile = await start();
  try {
    await testConcurrentConflict();
    await testAmendInvalidates();
    await testPowerLossReplay();
    await testMigration();
    await testValidation();

    // 落盘文件结构检查：JSON 完整、无半截写坏的情况
    const onDisk = JSON.parse(await readFile(dbFile, "utf8"));
    console.log("6) 持久化结构");
    check("文件含 receipts/conflicts/intents 且 seq 单调",
      Array.isArray(onDisk.receipts) && Array.isArray(onDisk.conflicts) &&
      onDisk.intents.length > 0 && onDisk.seq >= onDisk.receipts.length);
    check("无 DONE 之外残留可重复执行的副作用意图数量合理",
      onDisk.intents.every(i => i.status === "DONE" || i.status === "PROCESSING"));
  } finally {
    await stop();
  }
  console.log(`\n${pass} 项通过`);
  if (process.exitCode) console.error("存在失败项");
}
main().catch(e => { console.error(e); process.exit(1); });
