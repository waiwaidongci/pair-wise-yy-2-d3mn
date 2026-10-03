import http from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_FILE
  ? (process.env.DB_FILE.startsWith("/") ? process.env.DB_FILE : join(__dirname, process.env.DB_FILE))
  : join(__dirname, "data", "pigeons.json");
const port = Number(process.env.PORT || 3024);
const today = () => new Date().toISOString().slice(0, 10);

const seed = {
  seq: 0,
  pigeons: [
    { ringNo: "CHN-2026-001", owner: "北岸棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "北岸A棚", vaccines: [{ date: "2026-04-01", name: "新城疫" }], transfers: [{ date: "2026-04-15", from: "育种棚", to: "北岸棚" }], races: [{ date: "2026-06-01", event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18 }] },
    { ringNo: "CHN-2022-188", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", vaccines: [], transfers: [], races: [] },
    { ringNo: "CHN-2023-512", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", vaccines: [], transfers: [], races: [] }
  ],
  // 收鸽回执：入棚确认凭据。状态 pending(待确认) / confirmed(已确认) / invalid(父母环号变更后失效)
  receipts: [],
  // 并发冲突：同一足环后到的登记，整份留痕，不覆盖先到档案
  conflicts: [],
  // 写入意图日志（断电恢复用）：requestId -> 阶段与最终结果，重放同一编号直接返回且不重复追加
  intents: []
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
    return structuredClone(seed);
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  db.seq ??= 0;
  db.receipts ??= [];
  db.conflicts ??= [];
  db.intents ??= [];
  for (const p of db.pigeons) for (const key of ["vaccines", "transfers", "races"]) p[key] ??= [];
  return db;
}

// 原子落盘：临时文件 + rename，杜绝写到一半断电造成档案、鸽主、成绩错位
async function saveDb(db) {
  await mkdir(dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath);
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
class SimulatedCrash extends Error {
  constructor(stage) { super(`simulated_power_loss_${stage}`); this.stage = stage; }
}

function nextReceiptNo(db) {
  db.seq += 1;
  return `RCV-2026-${String(db.seq).padStart(6, "0")}`;
}
function findActiveReceipt(db, ringNo) {
  return db.receipts.find(r => r.ringNo === ringNo && (r.status === "pending" || r.status === "confirmed")) || null;
}
function receiptView(r) {
  return r && { receiptNo: r.receiptNo, ringNo: r.ringNo, owner: r.owner, clerk: r.clerk, fatherRing: r.fatherRing, motherRing: r.motherRing, color: r.color, loft: r.loft, vaccines: r.vaccines, firstRace: r.firstRace, status: r.status, createdAt: r.createdAt, confirmedAt: r.confirmedAt, supersededBy: r.supersededBy, migrated: !!r.migrated };
}

// ---------- 收鸽业务 ----------
function normalizeIntake(input) {
  return {
    ringNo: String(input.ringNo || "").trim(),
    owner: String(input.owner || "").trim(),
    clerk: String(input.clerk || "").trim(),
    fatherRing: String(input.fatherRing || "").trim(),
    motherRing: String(input.motherRing || "").trim(),
    color: String(input.color || "").trim(),
    loft: String(input.loft || "").trim(),
    vaccines: Array.isArray(input.vaccines)
      ? input.vaccines.map(v => ({ date: v.date || today(), name: String(v.name || "").trim() })).filter(v => v.name)
      : [],
    firstRace: input.firstRace && (input.firstRace.event || input.firstRace.distance)
      ? { date: input.firstRace.date || today(), event: String(input.firstRace.event || "首场训放"), distance: Number(input.firstRace.distance || 0), returnTime: String(input.firstRace.returnTime || ""), rank: Number(input.firstRace.rank || 0) }
      : null
  };
}
function validateIntake(data) {
  for (const key of ["ringNo", "owner", "clerk"]) {
    if (!data[key]) return { key, error: `missing_${key}` };
  }
  return null;
}
function raceKey(r) { return [r.date, r.event, r.distance, r.returnTime, r.rank].join("|"); }
function vaccineKey(v) { return [v.date, v.name].join("|"); }

// 确认回执：落鸽只档案。所有追加按内容去重，重放/重复确认都不会重复疫苗或训放成绩
function applyReceipt(db, r) {
  let pigeon = db.pigeons.find(p => p.ringNo === r.ringNo);
  let created = false;
  if (!pigeon) {
    pigeon = { ringNo: r.ringNo, owner: r.owner, fatherRing: r.fatherRing, motherRing: r.motherRing, color: r.color, loft: r.loft, vaccines: [], transfers: [], races: [] };
    db.pigeons.unshift(pigeon);
    created = true;
  }
  // 父母环号以确认回执为准（确认前的更正已经过重算）
  pigeon.fatherRing = r.fatherRing;
  pigeon.motherRing = r.motherRing;
  if (r.color) pigeon.color = r.color;
  if (r.loft) pigeon.loft = r.loft;
  for (const v of r.vaccines) {
    if (!pigeon.vaccines.some(x => vaccineKey(x) === vaccineKey(v))) pigeon.vaccines.push({ ...v });
  }
  if (r.firstRace && !pigeon.races.some(x => raceKey(x) === raceKey(r.firstRace))) {
    pigeon.races.push({ ...r.firstRace });
  }
  return { pigeon, created };
}

// 处理一次收鸽登记（持锁、幂等、可恢复）
async function processIntake(db, requestId, input, headers) {
  const data = normalizeIntake(input);
  const bad = validateIntake(data);
  if (bad) return { status: 400, body: { error: bad.error } };

  // 断电恢复：同一请求编号此前可能已写过回执或冲突，原样找回，不再新建任何记录
  const ownReceipt = db.receipts.find(r => r.requestId === requestId);
  if (ownReceipt) return { status: 201, body: { receipt: receiptView(ownReceipt), replayed: true } };
  const ownConflict = db.conflicts.find(c => c.requestId === requestId);
  if (ownConflict) {
    return { status: 409, body: { error: "receipt_conflict", conflictNo: ownConflict.conflictNo, winnerReceiptNo: ownConflict.winnerReceiptNo, winnerStatus: ownConflict.winnerStatus, replayed: true } };
  }

  const winner = findActiveReceipt(db, data.ringNo);
  if (winner) {
    // 同一足环已有生效回执：后到内容整份留冲突，不改确认档案/待确认档案
    const conflictNo = nextReceiptNo(db);
    db.conflicts.push({ conflictNo, ringNo: data.ringNo, winnerReceiptNo: winner.receiptNo, winnerStatus: winner.status, requestId, clerk: data.clerk, payload: data, createdAt: today() });
    if (headers["x-simulate-failure"] === "before-commit") throw new SimulatedCrash("before-commit");
    await saveDb(db);
    return { status: 409, body: { error: "receipt_conflict", conflictNo, winnerReceiptNo: winner.receiptNo, winnerStatus: winner.status } };
  }

  const receiptNo = nextReceiptNo(db);
  const receipt = { receiptNo, ...data, status: "pending", createdAt: today(), confirmedAt: null, supersededBy: null, requestId };
  db.receipts.unshift(receipt);
  // after-intent：意图已落盘、回执尚未写定 → 客户端凭原请求编号重试，不得产生第二张回执
  await saveDb(db);
  if (headers["x-simulate-failure"] === "after-intent") throw new SimulatedCrash("after-intent");
  return { status: 201, body: { receipt: receiptView(receipt) } };
}

async function processConfirm(db, receiptNo, headers) {
  const receipt = db.receipts.find(r => r.receiptNo === receiptNo);
  if (!receipt) return { status: 404, body: { error: "receipt_not_found" } };
  if (receipt.status === "invalid") return { status: 409, body: { error: "receipt_invalid", supersededBy: receipt.supersededBy } };
  if (receipt.status === "confirmed") {
    const pigeon = db.pigeons.find(p => p.ringNo === receipt.ringNo) || null;
    return { status: 200, body: { receipt: receiptView(receipt), pigeon, replayed: true } };
  }
  // before-commit：档案与状态都未落盘时断电，重放仍凭同一编号完成确认
  if (headers["x-simulate-failure"] === "before-commit") throw new SimulatedCrash("before-commit");
  const { pigeon, created } = applyReceipt(db, receipt);
  receipt.status = "confirmed";
  receipt.confirmedAt = today();
  await saveDb(db);
  if (headers["x-simulate-failure"] === "after-intent") throw new SimulatedCrash("after-intent");
  return { status: 200, body: { receipt: receiptView(receipt), pigeon, created } };
}

// 确认前父母环号有改动 → 原收鸽失效，按新父母环号重算一张回执（疫苗、首场成绩随迁）
async function processAmendParents(db, receiptNo, input) {
  // 断电恢复：重算产物按请求编号找回，不重复失效、不重复重算
  if (input.requestId) {
    const recalced = db.receipts.find(r => r.requestId === input.requestId && r.recalculatedFrom === receiptNo);
    if (recalced) {
      const old = db.receipts.find(r => r.receiptNo === receiptNo);
      return { status: 200, body: { receipt: receiptView(recalced), invalidated: receiptView(old), changed: true, replayed: true } };
    }
  }
  const receipt = db.receipts.find(r => r.receiptNo === receiptNo);
  if (!receipt) return { status: 404, body: { error: "receipt_not_found" } };
  if (receipt.status !== "pending") {
    return { status: 409, body: { error: "receipt_not_amendable", status: receipt.status } };
  }
  const fatherRing = String(input.fatherRing || "").trim();
  const motherRing = String(input.motherRing || "").trim();
  if (fatherRing === receipt.fatherRing && motherRing === receipt.motherRing) {
    return { status: 200, body: { receipt: receiptView(receipt), changed: false } };
  }
  receipt.status = "invalid";
  const recalculated = {
    receiptNo: nextReceiptNo(db),
    ringNo: receipt.ringNo, owner: receipt.owner, clerk: receipt.clerk,
    fatherRing, motherRing,
    color: receipt.color, loft: receipt.loft,
    vaccines: receipt.vaccines.map(v => ({ ...v })),
    firstRace: receipt.firstRace ? { ...receipt.firstRace } : null,
    status: "pending", createdAt: today(), confirmedAt: null, supersededBy: null,
    requestId: input.requestId || null, recalculatedFrom: receipt.receiptNo
  };
  receipt.supersededBy = recalculated.receiptNo;
  db.receipts.unshift(recalculated);
  await saveDb(db);
  return { status: 200, body: { receipt: receiptView(recalculated), invalidated: receiptView(receipt), changed: true } };
}

// 旧数据迁移：无回执的鸽只按历史先后补齐 confirmed 回执；血统、疫苗、成绩一律只读不动
async function processMigrate(db) {
  const have = new Set(db.receipts.map(r => r.ringNo));
  const pending = db.pigeons
    .filter(p => !have.has(p.ringNo))
    .map(p => {
      const events = [...p.vaccines, ...p.transfers, ...p.races].map(e => e.date).filter(Boolean).sort();
      return { pigeon: p, earliest: events[0] || "9999-12-31" };
    })
    .sort((a, b) =>
      a.earliest.localeCompare(b.earliest) ||
      db.pigeons.indexOf(a.pigeon) - db.pigeons.indexOf(b.pigeon)
    );
  // 历史先后优先：迁移回执插到所有现存现场回执之前
  const created = [];
  const batch = pending.map(({ pigeon, earliest }) => {
    const receipt = {
      receiptNo: nextReceiptNo(db),
      ringNo: pigeon.ringNo, owner: pigeon.owner, clerk: "历史迁移",
      fatherRing: pigeon.fatherRing || "", motherRing: pigeon.motherRing || "",
      color: pigeon.color || "", loft: pigeon.loft || "",
      vaccines: pigeon.vaccines.map(v => ({ ...v })),
      firstRace: null,
      status: "confirmed",
      createdAt: earliest === "9999-12-31" ? today() : earliest,
      confirmedAt: earliest === "9999-12-31" ? today() : earliest,
      supersededBy: null, requestId: null, migrated: true
    };
    created.push(receipt);
    return receipt;
  });
  if (batch.length) {
    db.receipts.push(...batch);
    await saveDb(db);
  }
  return { status: 200, body: { migrated: batch.map(receiptView), skipped: db.pigeons.length - batch.length } };
}

// ---------- 写入失败恢复：请求意图日志 + 全局串行锁 ----------
let chain = Promise.resolve();
function locked(task) {
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
}

// 带 requestId 的可恢复执行：
//  PROCESSING → 重试时按操作类型找到已生效产物（回执/档案），返回其结果且不再追加任何内容
//  DONE       → 重放直接回上次结果（疫苗/训放成绩天然不会重复追加）
async function recoverable(reqId, kind, headers, worker) {
  return locked(async () => {
    const db = await loadDb();
    let intent = db.intents.find(i => i.requestId === reqId);
    if (!intent) {
      intent = { requestId: reqId, kind, status: "PROCESSING", startedAt: new Date().toISOString(), result: null };
      db.intents.push(intent);
      try {
        await saveDb(db);
      } catch (e) {
        // 意图都没写进去，直接报错，客户端凭同一编号原样重试即可
        throw e;
      }
    } else if (intent.status === "DONE") {
      return intent.result;
    }

    try {
      const out = await worker(db, intent);
      intent.status = "DONE";
      intent.finishedAt = new Date().toISOString();
      intent.result = out;
      await saveDb(db);
      return out;
    } catch (error) {
      if (error instanceof SimulatedCrash) {
        // 断电：意图保留 PROCESSING（after-intent 时业务数据已随各处理器落盘）
        return { status: 503, body: { error: "power_loss_recoverable", requestId: reqId, stage: error.stage } };
      }
      throw error;
    }
  });
}

function relation(db, ringNo) {
  const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
  if (!pigeon) return null;
  const father = db.pigeons.find(item => item.ringNo === pigeon.fatherRing) || null;
  const mother = db.pigeons.find(item => item.ringNo === pigeon.motherRing) || null;
  const children = db.pigeons.filter(item => item.fatherRing === ringNo || item.motherRing === ringNo);
  return { pigeon, father, mother, children };
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>赛鸽收鸽登记站</title>
  <style>
    :root { --bg:#eff2f5; --panel:#fff; --ink:#1f2833; --muted:#697786; --line:#d3dce4; --accent:#315f83; --red:#9b3f35; --green:#356b45; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; }
    main { display:grid; grid-template-columns:400px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; margin-top:10px; }
    button.ghost { background:#fff; color:var(--accent); border:1px solid var(--accent); }
    .toolbar { display:grid; grid-template-columns:1fr auto; gap:10px; margin-bottom:14px; }
    .receipts { display:grid; gap:10px; }
    .rcv { border:1px solid var(--line); border-radius:8px; padding:12px; display:grid; gap:6px; }
    .meta { color:var(--muted); font-size:13px; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; margin-right:6px; }
    .s-pending { color:#8a6d1a; border-color:#d8c178; } .s-confirmed { color:var(--green); border-color:#9cc4a8; } .s-invalid { color:var(--red); border-color:#d3a09a; }
    .conflict { border-left:4px solid var(--red); padding-left:10px; }
    .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    #log { white-space:pre-wrap; font-family:ui-monospace,Menlo,monospace; font-size:12px; max-height:260px; overflow:auto; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>赛鸽收鸽登记站</h1><div class="meta">收鸽回执即入棚确认凭据 · 先到生效 · 断电凭请求编号恢复</div></div><button class="ghost" id="reload">刷新</button></header>
  <main>
    <div style="display:grid;gap:16px;align-content:start;">
      <form id="intakeForm">
        <h2>收鸽登记（一次补齐）</h2>
        <input type="hidden" name="requestId">
        <label>足环号 *</label><input name="ringNo" required>
        <label>鸽主 *</label><input name="owner" required>
        <label>登记员 *</label><input name="clerk" required>
        <div class="row" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;"><div><label>父鸽足环号</label><input name="fatherRing"></div><div><label>母鸽足环号</label><input name="motherRing"></div></div>
        <div class="row" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;"><div><label>羽色</label><input name="color"></div><div><label>入棚棚号</label><input name="loft"></div></div>
        <label>疫苗（日期/名称，多条用|分隔）</label><input name="vaccines" placeholder="2026-10-03/新城疫|2026-10-05/鸽痘">
        <label>首场成绩（日期/赛事/距离/归巢时间/名次）</label><input name="firstRace" placeholder="2026-10-10/120公里训放/120/10:42/18">
        <div class="row"><button>提交收鸽回执</button><select id="failMode" style="width:auto;"><option value="">正常</option><option value="after-intent">断电：回执写后</option><option value="before-commit">断电：冲突写前</option></select></div>
        <div class="meta" id="reqHint"></div>
      </form>
      <div class="panel">
        <h2>旧数据迁移</h2>
        <div class="meta">缺少回执的档案按历史先后补回执，血统与成绩不变。</div>
        <button id="migrate">按历史先后补齐回执</button>
      </div>
      <div class="panel"><h2>操作日志</h2><div id="log" class="meta"></div></div>
    </div>
    <section>
      <div class="toolbar"><input id="search" placeholder="输入足环号查询血统"><button id="searchBtn" style="margin:0;">查询</button></div>
      <div class="panel" id="detail" style="margin-bottom:14px;"></div>
      <div class="panel"><h2>收鸽回执与冲突</h2><div class="receipts" id="receipts"></div></div>
    </section>
  </main>
  <script>
    const $ = s => document.querySelector(s);
    const logEl = $("#log");
    const rid = () => "REQ-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
    function log(x){ logEl.textContent = (typeof x === "string" ? x : JSON.stringify(x, null, 2)) + "\\n\\n" + logEl.textContent; }
    async function api(path, options = {}) {
      const res = await fetch(path, options.body ? { ...options, headers: { ...(options.headers||{}), "Content-Type": "application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw Object.assign(new Error(data.error || "请求失败"), { data });
      return data;
    }
    function parseList(raw) {
      return raw.split("|").map(s => s.trim()).filter(Boolean).map(part => {
        const [date, name] = part.split("/");
        return { date: date.trim(), name: (name||"").trim() };
      }).filter(v => v.name);
    }
    $("#intakeForm").onsubmit = async e => {
      e.preventDefault();
      const f = new FormData($("#intakeForm"));
      let requestId = f.get("requestId") || rid();
      $("#reqHint").textContent = "请求编号：" + requestId + "（写入失败后凭此编号重试）";
      const payload = {
        requestId,
        ringNo: f.get("ringNo"), owner: f.get("owner"), clerk: f.get("clerk"),
        fatherRing: f.get("fatherRing"), motherRing: f.get("motherRing"),
        color: f.get("color"), loft: f.get("loft"),
        vaccines: parseList(f.get("vaccines") || "")
      };
      const raceRaw = (f.get("firstRace") || "").split("/");
      if (raceRaw[0]) payload.firstRace = { date: raceRaw[0].trim(), event: (raceRaw[1]||"首场训放").trim(), distance: Number(raceRaw[2]||0), returnTime:(raceRaw[3]||"").trim(), rank: Number(raceRaw[4]||0) };
      const headers = {};
      if ($("#failMode").value) headers["X-Simulate-Failure"] = $("#failMode").value;
      try {
        const out = await api("/api/intake", { method: "POST", headers, body: JSON.stringify(payload) });
        log({ ok: true, ...out });
        $("#failMode").value = "";
        $("#intakeForm").reset();
        f.get && document.querySelector('input[name=requestId]').value = "";
      } catch (err) {
        log({ ok: false, status: err.message, detail: err.data });
        // 断电后保留原请求编号，供“恢复重试”
        document.querySelector('input[name=requestId]').value = requestId;
      }
      load();
    };
    $("#migrate").onclick = async () => { const out = await api("/api/migrate", { method: "POST" }); log(out); load(); };
    $("#reload").onclick = load;
    $("#searchBtn").onclick = async () => renderRelation(await api("/api/pigeons/" + encodeURIComponent($("#search").value) + "/relation"));
    async function actionReceipt(r, act, body) {
      try { log(await api("/api/receipts/" + r + "/" + act, { method: "POST", body: JSON.stringify(body || {}) })); }
      catch (e) { log({ error: e.message, detail: e.data }); }
      load();
    }
    function renderReceipts(rs, cs) {
      const html = rs.map(r => '<div class="rcv"><div class="row"><b>'+r.receiptNo+'</b><span class="pill s-'+r.status+'">'+({pending:"待确认",confirmed:"已入棚",invalid:"已失效"}[r.status])+'</span>'+(r.migrated?'<span class="pill">迁移补齐</span>':"")+'</div><div>'+r.ringNo+' · 鸽主 '+r.owner+' · 登记员 '+r.clerk+'</div><div class="meta">父 '+ (r.fatherRing||"未登记") +' / 母 '+(r.motherRing||"未登记")+'</div><div class="meta">疫苗 '+(r.vaccines.map(v=>v.name).join("、")||"无")+'；首场 '+(r.firstRace?r.firstRace.event+" 第"+r.firstRace.rank+"名":"无")+'</div>'+ (r.status==="pending" ? '<div class="row"><button onclick="actionReceipt(\\''+r.receiptNo+'\\',\\'confirm\\')">确认入棚</button><input id="amend-'+r.receiptNo+'" placeholder="新父环/新母环，如 CHN-x / CHN-y" style="flex:1;"><button class="ghost" onclick="amend(\\''+r.receiptNo+'\\')">更正父母环号并重算</button></div>' : r.supersededBy ? '<div class="meta">已重算为 '+r.supersededBy+'</div>' : "") + '</div>').join("");
      const conflictHtml = cs.map(c => '<div class="rcv conflict"><b>'+c.conflictNo+'</b> <span class="pill">冲突留痕</span><div class="meta">足环 '+c.ringNo+'，先到回执 '+c.winnerReceiptNo+'（'+c.winnerStatus+'），后到登记员 '+c.clerk+' 内容未写入档案</div></div>').join("");
      $("#receipts").innerHTML = html + conflictHtml;
    }
    window.actionReceipt = actionReceipt;
    window.amend = no => {
      const raw = ($("#amend-"+no).value || "").split("/");
      actionReceipt(no, "amend-parents", { fatherRing: (raw[0]||"").trim(), motherRing: (raw[1]||"").trim() });
    };
    function renderRelation(data) {
      if (!data) { $("#detail").innerHTML = '<h2>血统查询</h2><p class="meta">请输入足环号查看父母、子代和成绩。</p>'; return; }
      const p = data.pigeon;
      $("#detail").innerHTML = '<h2>'+p.ringNo+' 血统档案</h2><div><b>父鸽</b> '+(data.father?.ringNo||p.fatherRing||"未登记")+'　<b>母鸽</b> '+(data.mother?.ringNo||p.motherRing||"未登记")+'</div><div class="meta">鸽主：'+p.owner+' · '+p.color+' · '+p.loft+'</div><div class="meta">子代：'+(data.children.map(c=>c.ringNo).join("、")||"暂无")+'</div><div class="meta">疫苗：'+(p.vaccines.map(v=>v.date+" "+v.name).join(" / ")||"暂无")+'</div><div class="meta">成绩：'+(p.races.map(r=>r.event+" 第"+r.rank+"名").join(" / ")||"暂无")+'</div>';
    }
    async function load() {
      const [rs, cs] = await Promise.all([api("/api/receipts"), api("/api/conflicts")]);
      renderReceipts(rs, cs);
    }
    load();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }

    // ---------- 收鸽回执 API ----------
    if (req.method === "POST" && url.pathname === "/api/intake") {
      const input = await body(req);
      const requestId = String(input.requestId || req.headers["x-request-id"] || "").trim();
      if (!requestId) return sendJson(res, 400, { error: "missing_requestId" });
      const out = await recoverable(requestId, "intake", req.headers, db => processIntake(db, requestId, input, req.headers));
      return sendJson(res, out.status, out.body);
    }

    if (req.method === "GET" && url.pathname === "/api/receipts") {
      const db = await loadDb();
      // 现场在前、历史迁移在后；同批按编号倒序（新的在前）
      const list = [...db.receipts].sort((a, b) => Number(b.receiptNo.slice(4)) - Number(a.receiptNo.slice(4)));
      return sendJson(res, 200, list.map(receiptView));
    }
    if (req.method === "GET" && url.pathname === "/api/conflicts") {
      const db = await loadDb();
      return sendJson(res, 200, db.conflicts);
    }
    if (req.method === "POST" && url.pathname === "/api/migrate") {
      const out = await locked(async () => { const db = await loadDb(); return processMigrate(db); });
      return sendJson(res, out.status, out.body);
    }

    const rcvAction = url.pathname.match(/^\/api\/receipts\/([^/]+)\/(confirm|amend-parents)$/);
    if (rcvAction && req.method === "POST") {
      const receiptNo = decodeURIComponent(rcvAction[1]);
      const input = await body(req);
      const requestId = String(input.requestId || req.headers["x-request-id"] || "").trim();
      const kind = rcvAction[2];
      if (!requestId) {
        // 无请求编号的请求仍执行（内部以 receiptNo+action 合成编号保证可重放）
        return runRcvAction(`anon:${receiptNo}:${kind}`);
      }
      return runRcvAction(requestId);
      async function runRcvAction(rid) {
        const out = await recoverable(rid, kind, req.headers, async (db, intent) => {
          if (kind === "confirm") {
            // PROCESSING 恢复：若已确认，直接回档案，不重复追加
            return processConfirm(db, receiptNo, req.headers);
          }
          return processAmendParents(db, receiptNo, { ...input, requestId: rid });
        });
        return sendJson(res, out.status, out.body);
      }
    }

    // ---------- 既有档案 API（疫苗/成绩追加做内容去重，支持 requestId 重放） ----------
    if (req.method === "GET" && url.pathname === "/api/pigeons") {
      const db = await loadDb();
      return sendJson(res, 200, db.pigeons);
    }
    if (req.method === "POST" && url.pathname === "/api/pigeons") {
      const input = await body(req);
      const run = async db => {
        if (db.pigeons.some(item => item.ringNo === input.ringNo)) return { status: 409, body: { error: "ring_exists" } };
        const pigeon = { ...input, vaccines: [], transfers: [], races: [] };
        db.pigeons.unshift(pigeon);
        await saveDb(db);
        return { status: 201, body: pigeon };
      };
      const rid = req.headers["x-request-id"];
      const out = rid ? await recoverable(String(rid), "create-pigeon", req.headers, run) : await locked(async () => run(await loadDb()));
      return sendJson(res, out.status, out.body);
    }

    const relationMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/relation$/);
    if (relationMatch && req.method === "GET") {
      const db = await loadDb();
      const data = relation(db, decodeURIComponent(relationMatch[1]));
      return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: "pigeon_not_found" });
    }

    const actionMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/(transfers|races|vaccines)$/);
    if (actionMatch && req.method === "POST") {
      const ringNo = decodeURIComponent(actionMatch[1]);
      const input = await body(req);
      const run = async db => {
        const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
        if (!pigeon) return { status: 404, body: { error: "pigeon_not_found" } };
        if (actionMatch[2] === "transfers") {
          const transfer = { date: input.date || today(), from: pigeon.owner, to: input.to };
          pigeon.owner = input.to;
          pigeon.transfers.push(transfer);
        }
        if (actionMatch[2] === "races") {
          const entry = { date: input.date || today(), event: input.event, distance: Number(input.distance || 0), returnTime: input.returnTime || "", rank: Number(input.rank || 0) };
          // 内容去重：同一训放成绩重放不得重复追加
          if (!pigeon.races.some(x => raceKey(x) === raceKey(entry))) pigeon.races.push(entry);
        }
        if (actionMatch[2] === "vaccines") {
          const entry = { date: input.date || today(), name: input.name };
          if (!pigeon.vaccines.some(x => vaccineKey(x) === vaccineKey(entry))) pigeon.vaccines.push(entry);
        }
        await saveDb(db);
        return { status: 200, body: pigeon };
      };
      const rid = req.headers["x-request-id"];
      const out = rid ? await recoverable(String(rid), `pigeon-${actionMatch[2]}`, req.headers, run) : await locked(async () => run(await loadDb()));
      return sendJson(res, out.status, out.body);
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Racing pigeon registry app listening on http://localhost:${port}`));
