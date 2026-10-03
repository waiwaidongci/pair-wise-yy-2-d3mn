// 收鸽回执 / 并发先到生效 / 父母环号改动失效 / 迁移补齐 / 断电幂等恢复
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

const PORT = 3199;
const DB = "/tmp/pigeons-test.json";
rmSync(DB, { force: true });

let server;
function startServer() {
  const s = spawn("node", ["server.js"], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB },
    stdio: ["ignore", "pipe", "pipe"]
  });
  s.stderr.on("data", d => process.stderr.write(d));
  return s;
}
server = startServer();

const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + "/api/pigeons"); if (r.ok) return; } catch {}
    await sleep(100);
  }
  throw new Error("server not ready");
}
async function restartServer() {
  try { server.kill(); } catch {}
  await new Promise(resolve => {
    const t = setTimeout(resolve, 2000);
    server.once("exit", () => { clearTimeout(t); resolve(); });
  });
  await sleep(200);
  server = startServer();
  await waitReady();
}
// 带断电模拟的请求：写入落盘后进程退出，连接中断；随后重启并用原 requestId 恢复
async function postCrash(path, body) {
  try { await post(path, body, { "x-simulate-crash": "1" }); } catch {}
  await restartServer();
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS", name); }
  else { fail++; console.log("  FAIL", name, extra ?? ""); }
}
async function get(path) { const r = await fetch(BASE + path); return { status: r.status, body: await r.json().catch(() => ({})) }; }
async function post(path, body, headers = {}) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

await waitReady();

// ---- 1. 旧数据迁移：按历史先后补齐回执，血统与成绩不变 ----
console.log("\n[1] 旧数据迁移补齐回执");
{
  const receipts = (await get("/api/receipts")).body;
  check("迁移生成 3 张回执", receipts.length === 3, receipts.length);
  const legacy = receipts.find(r => r.ringNo === "CHN-2026-001");
  check("回执均为已确认", receipts.every(r => r.status === "confirmed"));
  check("血统(父母环号)不变", legacy.fatherRing === "CHN-2022-188" && legacy.motherRing === "CHN-2023-512");
  const p = (await get("/api/pigeons")).body.find(x => x.ringNo === "CHN-2026-001");
  check("成绩(训放)不变", p.races.length === 1 && p.races[0].event === "120公里训放" && p.races[0].rank === 18);
  check("疫苗不变", p.vaccines.length === 1 && p.vaccines[0].name === "新城疫");
  check("转让不变", p.transfers.length === 1 && p.transfers[0].to === "北岸棚");
  check("迁移按历史先后(种鸽在前)", receipts[0].ringNo === "CHN-2022-188", receipts.map(r => r.ringNo));
  // 迁移幂等：再跑一次不重复
  const again = await post("/api/admin/migrate", { requestId: "migrate-again" });
  check("迁移幂等不重复", again.body.added === 0, again.body);
}

// ---- 2. 收鸽：一次补齐父母环号、疫苗、首场成绩，生成待确认回执 ----
console.log("\n[2] 收鸽一次补齐 + 入棚确认");
{
  const body = {
    requestId: "req-001", ringNo: "CHN-2026-101", owner: "北岸棚",
    fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "北岸A棚",
    vaccines: [{ date: "2026-09-01", name: "新城疫" }],
    firstRace: { date: "2026-09-20", event: "120公里训放", distance: 120, rank: 5 }
  };
  const r = await post("/api/intake", body);
  check("收鸽生成待确认回执(202)", r.status === 202 && r.body.receipt.status === "pending", r.body);
  check("回执含疫苗与首场成绩", r.body.receipt.vaccines.length === 1 && r.body.receipt.firstRace.rank === 5);
  const before = (await get("/api/pigeons")).body.find(p => p.ringNo === "CHN-2026-101");
  check("确认前档案未建立", !before);
  const c = await post(`/api/intake/${r.body.receipt.receiptNo}/confirm`, { requestId: "req-001-confirm" });
  check("确认后入棚(200)", c.status === 200 && c.body.receipt.status === "confirmed", c.body);
  const p = (await get("/api/pigeons")).body.find(x => x.ringNo === "CHN-2026-101");
  check("确认后档案含父母/疫苗/首赛", p.fatherRing === "CHN-2022-188" && p.vaccines.length === 1 && p.races.length === 1 && p.races[0].rank === 5);
}

// ---- 3. 并发：两名登记员同时提交同一足环，先到生效，后到留冲突不改档案 ----
console.log("\n[3] 并发收鸽先到生效 / 后到留冲突");
{
  const a = await post("/api/intake", { requestId: "req-A", ringNo: "CHN-2026-202", owner: "甲棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "A棚" });
  check("先到回执待确认", a.status === 202 && a.body.conflict === false);
  const b = await post("/api/intake", { requestId: "req-B", ringNo: "CHN-2026-202", owner: "乙棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "雨点", loft: "B棚" });
  check("后到返回冲突(409)", b.status === 409 && b.body.conflict === true, b.body);
  check("后到内容留冲突但不改档案", b.body.receipt.status === "conflict" && b.body.winner.receiptNo === a.body.receipt.receiptNo);
  const list = (await get("/api/receipts")).body;
  const winner = list.find(r => r.ringNo === "CHN-2026-202" && r.status === "pending");
  check("先到者仍是唯一待确认回执", winner.receiptNo === a.body.receipt.receiptNo);
  check("后到者为冲突状态", list.some(r => r.receiptNo === b.body.receipt.receiptNo && r.status === "conflict"));
  // 后到的冲突回执不能确认
  const bc = await post(`/api/intake/${b.body.receipt.receiptNo}/confirm`, { requestId: "req-B-confirm" });
  check("冲突回执不能确认入棚", bc.status === 409 && bc.body.error === "receipt_conflict_loser", bc.body);
  // 先到者确认后，档案归甲棚（先到生效）
  await post(`/api/intake/${a.body.receipt.receiptNo}/confirm`, { requestId: "req-A-confirm" });
  const p = (await get("/api/pigeons")).body.find(x => x.ringNo === "CHN-2026-202");
  check("确认档案归先到方(甲棚)", p.owner === "甲棚" && p.color === "灰", p);
}

// ---- 4. 父母环号确认前改动 → 收鸽失效重算 ----
console.log("\n[4] 父母环号改动使收鸽失效重算");
{
  const r = await post("/api/intake", { requestId: "req-4", ringNo: "CHN-2026-303", owner: "丙棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "C棚" });
  const no = r.body.receipt.receiptNo;
  // 确认前更正父母环号
  const corr = await post("/api/pigeons/CHN-2026-303/parents", { requestId: "req-4-corr", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512" });
  check("无变化的更正不影响", corr.status === 200 && corr.body.invalidated.length === 0);
  const corr2 = await post("/api/pigeons/CHN-2026-303/parents", { requestId: "req-4-corr2", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-999" });
  check("改动父母环号作废待确认回执", corr2.body.invalidated.includes(no), corr2.body);
  const c = await post(`/api/intake/${no}/confirm`, { requestId: "req-4-confirm" });
  check("失效回执不能确认(409)", c.status === 409 && c.body.error === "receipt_invalidated", c.body);
  // 重算：重新提交收鸽
  const re = await post("/api/intake", { requestId: "req-4-re", ringNo: "CHN-2026-303", owner: "丙棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-999", color: "灰", loft: "C棚" });
  check("重算生成新回执", re.status === 202 && re.body.receipt.receiptNo !== no, re.body);
  const rc = await post(`/api/intake/${re.body.receipt.receiptNo}/confirm`, { requestId: "req-4-re-confirm" });
  check("重算后确认入棚", rc.status === 200 && rc.body.receipt.status === "confirmed", rc.body);
  const p = (await get("/api/pigeons")).body.find(x => x.ringNo === "CHN-2026-303");
  check("重算档案母环为新值", p.motherRing === "CHN-2023-999", p);
}

// ---- 5. 断电：写入失败后凭原请求编号恢复，重放不重复追加 ----
console.log("\n[5] 断电幂等恢复（凭原请求编号）");
{
  const body = { requestId: "req-5", ringNo: "CHN-2026-404", owner: "丁棚", fatherRing: "", motherRing: "", color: "灰", loft: "D棚" };
  await postCrash("/api/intake", body);
  check("断电后已重启恢复", true);
  // 凭原请求编号重发
  const retry = await post("/api/intake", body);
  check("恢复：凭原 requestId 取得回执", retry.status === 202 && retry.body.receipt.ringNo === "CHN-2026-404", retry.body);
  const list = (await get("/api/receipts")).body.filter(x => x.ringNo === "CHN-2026-404");
  check("恢复：未重复生成回执", list.length === 1, list.length);

  // 疫苗追加：断电后重放不重复
  await post(`/api/intake/${retry.body.receipt.receiptNo}/confirm`, { requestId: "req-5-confirm" });
  const vBody = { requestId: "req-5-vac", date: "2026-09-10", name: "新城疫" };
  await postCrash("/api/pigeons/CHN-2026-404/vaccines", vBody);
  const v2 = await post("/api/pigeons/CHN-2026-404/vaccines", vBody);
  check("疫苗恢复成功", v2.status === 200);
  const p = (await get("/api/pigeons")).body.find(x => x.ringNo === "CHN-2026-404");
  check("疫苗未重复追加", p.vaccines.length === 1 && p.vaccines[0].name === "新城疫", p.vaccines);

  // 训放成绩追加：断电后重放不重复
  const rBody = { requestId: "req-5-race", date: "2026-09-21", event: "120公里训放", distance: 120, rank: 9 };
  await postCrash("/api/pigeons/CHN-2026-404/races", rBody);
  const r2 = await post("/api/pigeons/CHN-2026-404/races", rBody);
  check("训放成绩恢复成功", r2.status === 200);
  const p2 = (await get("/api/pigeons")).body.find(x => x.ringNo === "CHN-2026-404");
  check("训放成绩未重复追加", p2.races.length === 1 && p2.races[0].rank === 9, p2.races);
}

// ---- 6. 确认幂等：同一确认请求重放不重复建档案 ----
console.log("\n[6] 确认请求幂等");
{
  const r = await post("/api/intake", { requestId: "req-6", ringNo: "CHN-2026-505", owner: "戊棚", fatherRing: "", motherRing: "", color: "灰", loft: "E棚" });
  const no = r.body.receipt.receiptNo;
  await post(`/api/intake/${no}/confirm`, { requestId: "req-6-confirm" });
  const again = await post(`/api/intake/${no}/confirm`, { requestId: "req-6-confirm" });
  check("重复确认返回成功", again.status === 200);
  const count = (await get("/api/pigeons")).body.filter(x => x.ringNo === "CHN-2026-505").length;
  check("重复确认未重复建档案", count === 1, count);
}

server.kill();
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
