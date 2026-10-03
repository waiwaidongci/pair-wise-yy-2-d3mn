import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, "data", "pigeons.json");
const port = Number(process.env.PORT || 3024);

// ---------------------------------------------------------------------------
// 初始数据：仅在数据文件缺失时写入。真正的权威状态是 append-only 事件日志，
// 档案(pigeons)与回执(receipts)都由事件日志重放(replay)得到。
// ---------------------------------------------------------------------------
const seed = {
  meta: { migrated: false, nextReceiptNo: 1 },
  events: [],
  responses: {},
  pigeons: [
    { ringNo: "CHN-2026-001", owner: "北岸棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "北岸A棚", vaccines: [{ date: "2026-04-01", name: "新城疫" }], transfers: [{ date: "2026-04-15", from: "育种棚", to: "北岸棚" }], races: [{ date: "2026-06-01", event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18 }] },
    { ringNo: "CHN-2022-188", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", vaccines: [], transfers: [], races: [] },
    { ringNo: "CHN-2023-512", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", vaccines: [], transfers: [], races: [] }
  ]
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  db.meta = db.meta || { migrated: false, nextReceiptNo: 1 };
  db.meta.nextReceiptNo = db.meta.nextReceiptNo || 1;
  db.events = Array.isArray(db.events) ? db.events : [];
  db.responses = db.responses || {};
  db.pigeons = Array.isArray(db.pigeons) ? db.pigeons : [];
  return db;
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function httpError(status, error, extra) {
  const e = new Error(error);
  e.status = status;
  e.error = error;
  if (extra) Object.assign(e, extra);
  return e;
}
function rid() { return randomUUID(); }

// ---------------------------------------------------------------------------
// 事件重放：由 append-only 事件日志推导档案与回执。
// 每个事件带唯一 requestId，重放时去重，保证疫苗/训放成绩只追加一次。
// ---------------------------------------------------------------------------
function materializeReceipt(ev) {
  return {
    receiptNo: ev.receiptNo,
    requestId: ev.requestId,
    ringNo: ev.ringNo,
    status: ev.status || "pending",
    owner: ev.owner || "",
    fatherRing: ev.fatherRing || "",
    motherRing: ev.motherRing || "",
    color: ev.color || "",
    loft: ev.loft || "",
    vaccines: Array.isArray(ev.vaccines) ? ev.vaccines.map(v => ({ ...v })) : [],
    firstRace: ev.firstRace ? { ...ev.firstRace } : null,
    parentSnapshot: ev.parentSnapshot ? { ...ev.parentSnapshot } : null,
    submittedAt: ev.at,
    confirmedAt: null,
    conflictOf: null
  };
}

function replay(events) {
  const pigeons = [];
  const receipts = [];
  const byRing = new Map();
  const seen = new Set();
  for (const ev of events) {
    if (seen.has(ev.requestId)) continue; // 幂等：同一请求编号只生效一次
    seen.add(ev.requestId);
    switch (ev.type) {
      case "IntakeSubmitted": {
        receipts.push(materializeReceipt(ev));
        break;
      }
      case "IntakeConfirmed": {
        let r = receipts.find(x => x.receiptNo === ev.receiptNo);
        if (!r) { r = materializeReceipt(ev); receipts.push(r); }
        r.status = "confirmed";
        r.confirmedAt = ev.at;
        if (!byRing.has(ev.ringNo)) {
          const p = {
            ringNo: ev.ringNo,
            owner: ev.owner || "",
            fatherRing: ev.fatherRing || "",
            motherRing: ev.motherRing || "",
            color: ev.color || "",
            loft: ev.loft || "",
            vaccines: Array.isArray(ev.vaccines) ? ev.vaccines.map(v => ({ ...v })) : [],
            transfers: [],
            races: ev.firstRace ? [{ ...ev.firstRace }] : []
          };
          byRing.set(ev.ringNo, p);
          pigeons.push(p);
        }
        break;
      }
      case "IntakeConflict": {
        const r = materializeReceipt(ev);
        r.status = "conflict";
        r.conflictOf = ev.conflictOf;
        receipts.push(r);
        break;
      }
      case "IntakeInvalidated": {
        const r = receipts.find(x => x.receiptNo === ev.receiptNo);
        if (r) r.status = "invalidated";
        break;
      }
      case "VaccineRecorded": {
        const p = byRing.get(ev.ringNo);
        if (p) p.vaccines.push({ ...ev.vaccine });
        break;
      }
      case "RaceRecorded": {
        const p = byRing.get(ev.ringNo);
        if (p) p.races.push({ ...ev.race });
        break;
      }
      case "TransferRecorded": {
        const p = byRing.get(ev.ringNo);
        if (p) { p.transfers.push({ ...ev.transfer }); p.owner = ev.transfer.to; }
        break;
      }
      case "ParentsCorrected": {
        const p = byRing.get(ev.ringNo);
        if (p) { p.fatherRing = ev.fatherRing; p.motherRing = ev.motherRing; }
        // 确认前父母环号改动：仅当与收鸽快照不一致时作废待确认回执
        for (const r of receipts) {
          if (r.ringNo === ev.ringNo && r.status === "pending") {
            const changed = ev.fatherRing !== r.parentSnapshot.fatherRing || ev.motherRing !== r.parentSnapshot.motherRing;
            if (changed) r.status = "invalidated";
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return { pigeons, receipts };
}

function refresh(db) {
  const { pigeons, receipts } = replay(db.events);
  db.pigeons = pigeons;
  db.receipts = receipts;
}
async function commit(db) {
  refresh(db);
  await saveDb(db);
}

function nextReceiptNo(db) {
  const n = db.meta.nextReceiptNo || 1;
  db.meta.nextReceiptNo = n + 1;
  return "R-" + String(n).padStart(3, "0");
}

// ---------------------------------------------------------------------------
// 旧数据迁移：缺少回执的，按历史先后补齐回执，血统与成绩保持不变。
// 幂等：只对缺少 IntakeConfirmed 事件的鸽只补一次。
// ---------------------------------------------------------------------------
function legacySortKey(p) {
  const dates = [];
  for (const v of p.vaccines || []) if (v.date) dates.push(v.date);
  for (const t of p.transfers || []) if (t.date) dates.push(t.date);
  for (const r of p.races || []) if (r.date) dates.push(r.date);
  if (dates.length) return dates.sort()[0];
  const m = /^[A-Z]+-(\d{4})-/.exec(p.ringNo);
  return m ? `${m[1]}-01-01` : "9999-12-31";
}

function migrate(db) {
  if (db.meta.migrated) return { migrated: false, added: 0 };
  const legacy = (db.pigeons || []).slice().sort((a, b) => {
    const k = legacySortKey(a).localeCompare(legacySortKey(b));
    return k !== 0 ? k : a.ringNo.localeCompare(b.ringNo);
  });
  const known = new Set(db.events.filter(e => e.type === "IntakeConfirmed").map(e => e.ringNo));
  let added = 0;
  for (const p of legacy) {
    if (known.has(p.ringNo)) continue;
    const receiptNo = nextReceiptNo(db);
    const at = "2026-01-01T00:00:00.000Z";
    db.events.push({
      requestId: `legacy:intake:${p.ringNo}`, type: "IntakeConfirmed", receiptNo, ringNo: p.ringNo, at,
      owner: p.owner || "", fatherRing: p.fatherRing || "", motherRing: p.motherRing || "",
      color: p.color || "", loft: p.loft || "", vaccines: [], firstRace: null
    });
    (p.vaccines || []).forEach((v, i) => db.events.push({
      requestId: `legacy:vaccine:${p.ringNo}:${i}`, type: "VaccineRecorded", ringNo: p.ringNo, at, vaccine: { ...v }
    }));
    (p.races || []).forEach((r, i) => db.events.push({
      requestId: `legacy:race:${p.ringNo}:${i}`, type: "RaceRecorded", ringNo: p.ringNo, at, race: { ...r }
    }));
    (p.transfers || []).forEach((t, i) => db.events.push({
      requestId: `legacy:transfer:${p.ringNo}:${i}`, type: "TransferRecorded", ringNo: p.ringNo, at, transfer: { ...t }
    }));
    added++;
  }
  db.meta.migrated = true;
  return { migrated: true, added };
}

// ---------------------------------------------------------------------------
// 幂等：凭原请求编号(requestId)继续恢复。已落库的请求直接返回原结果，
// 不重复追加事件，因此重放不会重复追加疫苗或训放成绩。
// ---------------------------------------------------------------------------
function cached(db, requestId) {
  const hit = db.responses[requestId];
  return hit ? { status: hit.status, body: hit.body } : null;
}
function remember(db, requestId, status, body) {
  db.responses[requestId] = { status, body };
}

function relation(db, ringNo) {
  const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
  if (!pigeon) return null;
  const father = db.pigeons.find(item => item.ringNo === pigeon.fatherRing) || null;
  const mother = db.pigeons.find(item => item.ringNo === pigeon.motherRing) || null;
  const children = db.pigeons.filter(item => item.fatherRing === ringNo || item.motherRing === ringNo);
  return { pigeon, father, mother, children };
}

// ---------------------------------------------------------------------------
// 收鸽：一次提交父母环号、疫苗和首场成绩，生成收鸽回执(待确认)。
// 两名登记员同时提交同一足环：先到的回执生效，后到内容留冲突、不改档案。
// ---------------------------------------------------------------------------
async function handleIntakeSubmit(db, input, requestId) {
  const ringNo = String(input.ringNo || "").trim();
  if (!ringNo) throw httpError(400, "ring_required");
  const payload = {
    owner: String(input.owner || "").trim(),
    fatherRing: String(input.fatherRing || "").trim(),
    motherRing: String(input.motherRing || "").trim(),
    color: String(input.color || "").trim(),
    loft: String(input.loft || "").trim(),
    vaccines: Array.isArray(input.vaccines) ? input.vaccines.filter(v => v && v.name).map(v => ({ date: v.date || "", name: String(v.name).trim() })) : [],
    firstRace: input.firstRace && input.firstRace.event ? {
      date: input.firstRace.date || "", event: String(input.firstRace.event).trim(),
      distance: Number(input.firstRace.distance || 0), returnTime: input.firstRace.returnTime || "",
      rank: Number(input.firstRace.rank || 0)
    } : null
  };
  const now = new Date().toISOString();
  const existing = db.receipts.filter(r => r.ringNo === ringNo);
  const blocking = existing.find(r => r.status === "pending" || r.status === "confirmed");
  const receiptNo = nextReceiptNo(db);

  if (blocking) {
    // 后到：内容留冲突，不改确认档案
    const ev = { requestId, type: "IntakeConflict", receiptNo, ringNo, at: now, status: "conflict", conflictOf: blocking.receiptNo, ...payload };
    db.events.push(ev);
    const body = { ok: true, conflict: true, receipt: materializeReceipt(ev), winner: { receiptNo: blocking.receiptNo, status: blocking.status } };
    remember(db, requestId, 409, body);
    await commit(db);
    return { status: 409, body };
  }

  // 先到（或上一份已作废后的重算）：生成待确认收鸽回执
  const ev = {
    requestId, type: "IntakeSubmitted", receiptNo, ringNo, at: now, status: "pending",
    parentSnapshot: { fatherRing: payload.fatherRing, motherRing: payload.motherRing }, ...payload
  };
  db.events.push(ev);
  const body = { ok: true, conflict: false, receipt: materializeReceipt(ev) };
  remember(db, requestId, 202, body);
  await commit(db);
  return { status: 202, body };
}

// 入棚确认：收鸽回执成为入棚凭据，档案由此建立。
async function handleIntakeConfirm(db, receiptNo, requestId) {
  const receipt = db.receipts.find(r => r.receiptNo === receiptNo);
  if (!receipt) throw httpError(404, "receipt_not_found");
  if (receipt.status === "confirmed") {
    const body = { ok: true, receipt };
    remember(db, requestId, 200, body);
    return { status: 200, body };
  }
  if (receipt.status === "conflict") throw httpError(409, "receipt_conflict_loser", { winner: receipt.conflictOf });
  if (receipt.status === "invalidated") throw httpError(409, "receipt_invalidated");

  // 确认前复核父母环号：若与收鸽时快照不一致，作废并重算
  const latestCorrection = [...db.events].reverse().find(e => e.type === "ParentsCorrected" && e.ringNo === receipt.ringNo);
  if (latestCorrection && (latestCorrection.fatherRing !== receipt.parentSnapshot.fatherRing || latestCorrection.motherRing !== receipt.parentSnapshot.motherRing)) {
    const inv = { requestId: requestId + ":invalidate", type: "IntakeInvalidated", receiptNo, ringNo: receipt.ringNo, at: new Date().toISOString() };
    db.events.push(inv);
    await commit(db);
    throw httpError(409, "receipt_invalidated");
  }

  const now = new Date().toISOString();
  const ev = {
    requestId, type: "IntakeConfirmed", receiptNo, ringNo: receipt.ringNo, at: now,
    owner: receipt.owner, fatherRing: receipt.fatherRing, motherRing: receipt.motherRing,
    color: receipt.color, loft: receipt.loft, vaccines: receipt.vaccines, firstRace: receipt.firstRace
  };
  db.events.push(ev);
  const body = { ok: true, receipt: { ...receipt, status: "confirmed", confirmedAt: now } };
  remember(db, requestId, 200, body);
  await commit(db);
  return { status: 200, body };
}

// 父母环号更正：确认前改动会作废待确认回执，需重算收鸽。
async function handleParentsCorrection(db, ringNo, input, requestId) {
  const pigeon = db.pigeons.find(p => p.ringNo === ringNo);
  const pending = db.receipts.filter(r => r.ringNo === ringNo && r.status === "pending");
  if (!pigeon && pending.length === 0) throw httpError(404, "ring_not_found");
  const fatherRing = String(input.fatherRing ?? pigeon?.fatherRing ?? "").trim();
  const motherRing = String(input.motherRing ?? pigeon?.motherRing ?? "").trim();
  const ev = { requestId, type: "ParentsCorrected", ringNo, at: new Date().toISOString(), fatherRing, motherRing };
  db.events.push(ev);
  const invalidated = pending
    .filter(r => fatherRing !== r.parentSnapshot.fatherRing || motherRing !== r.parentSnapshot.motherRing)
    .map(r => r.receiptNo);
  const body = { ok: true, ringNo, fatherRing, motherRing, invalidated };
  remember(db, requestId, 200, body);
  await commit(db);
  return { status: 200, body };
}

async function handleAppend(db, ringNo, kind, input, requestId) {
  const pigeon = db.pigeons.find(p => p.ringNo === ringNo);
  if (!pigeon) throw httpError(404, "pigeon_not_found");
  const now = new Date().toISOString();
  let ev;
  if (kind === "vaccines") {
    ev = { requestId, type: "VaccineRecorded", ringNo, at: now, vaccine: { date: input.date || now.slice(0, 10), name: String(input.name || "").trim() } };
  } else if (kind === "races") {
    ev = { requestId, type: "RaceRecorded", ringNo, at: now, race: { date: input.date || now.slice(0, 10), event: String(input.event || "").trim(), distance: Number(input.distance || 0), returnTime: input.returnTime || "", rank: Number(input.rank || 0) } };
  } else {
    ev = { requestId, type: "TransferRecorded", ringNo, at: now, transfer: { date: input.date || now.slice(0, 10), from: pigeon.owner, to: String(input.to || "").trim() } };
  }
  db.events.push(ev);
  const body = { ok: true, ringNo, kind };
  remember(db, requestId, 200, body);
  await commit(db);
  return { status: 200, body };
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------
const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>赛鸽血统环号登记站</title>
  <style>
    :root { --bg:#eff2f5; --panel:#fff; --ink:#1f2833; --muted:#697786; --line:#d3dce4; --accent:#315f83; --red:#9b3f35; --green:#2e7d4f; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:400px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button.ghost { background:#eef2f5; color:var(--ink); } button.danger { background:var(--red); }
    .toolbar { display:grid; grid-template-columns:1fr auto; gap:10px; margin-bottom:14px; } .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; }
    .card { display:grid; gap:8px; } .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.pending { background:#fff7e6; border-color:#e6c98a; } .pill.confirmed { background:#e8f5ec; border-color:#9fd4b0; } .pill.conflict { background:#fdecea; border-color:#e6a39c; } .pill.invalidated { background:#f0e6f5; border-color:#c3aed6; }
    .section { margin-top:14px; } .relation { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:14px; } .small { background:#f8fafb; border:1px solid var(--line); border-radius:8px; padding:10px; }
    .rcpt { display:flex; justify-content:space-between; gap:10px; align-items:center; padding:8px 10px; border:1px solid var(--line); border-radius:6px; margin-bottom:8px; }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .relation{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header><div><h1>赛鸽血统环号登记站</h1><div class="meta">收鸽回执为入棚确认凭据 · 先到生效 · 后到留冲突</div></div><button id="reload">刷新</button></header>
  <main>
    <div>
      <form id="intake">
        <h2>收鸽登记（一次补齐）</h2>
        <label>请求编号 requestId（重放恢复用）</label><input name="requestId" placeholder="如 req-001，留空自动生成">
        <label>足环号</label><input name="ringNo" required>
        <label>鸽主</label><input name="owner" required>
        <div class="row"><label>父鸽足环号</label><input name="fatherRing"></div>
        <div class="row"><label>母鸽足环号</label><input name="motherRing"></div>
        <div class="row"><label>羽色</label><input name="color" required></div>
        <div class="row"><label>出生棚号</label><input name="loft" required></div>
        <h2 style="margin-top:16px;">疫苗</h2>
        <div class="row"><label>日期</label><input name="vacDate"></div>
        <div class="row"><label>名称</label><input name="vacName" placeholder="新城疫"></div>
        <h2 style="margin-top:16px;">首场成绩</h2>
        <div class="row"><label>日期</label><input name="raceDate"></div>
        <div class="row"><label>赛事</label><input name="raceEvent" placeholder="120公里训放"></div>
        <div class="row"><label>距离</label><input name="raceDistance" type="number"></div>
        <div class="row"><label>名次</label><input name="raceRank" type="number"></div>
        <button style="margin-top:14px;">提交收鸽（生成回执）</button>
      </form>
      <form id="form" style="margin-top:14px;">
        <h2>快捷建档案（直接确认入棚）</h2>
        <label>足环号</label><input name="ringNo" required>
        <label>鸽主</label><input name="owner" required>
        <label>父鸽足环号</label><input name="fatherRing">
        <label>母鸽足环号</label><input name="motherRing">
        <label>羽色</label><input name="color" required>
        <label>出生棚号</label><input name="loft" required>
        <button>保存档案</button>
      </form>
    </div>
    <section>
      <div class="toolbar"><input id="search" placeholder="输入足环号查询血统"><button id="searchBtn">查询</button></div>
      <div class="panel" id="detail"></div>
      <h2 style="margin-top:18px;">收鸽回执</h2>
      <div class="panel" id="receipts"></div>
      <div class="section grid" id="cards"></div>
    </section>
  </main>
  <script>
    const form = document.querySelector("#form");
    const intake = document.querySelector("#intake");
    const cards = document.querySelector("#cards");
    const detail = document.querySelector("#detail");
    const receiptsEl = document.querySelector("#receipts");
    const search = document.querySelector("#search");
    let pigeons = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    const pill = s => '<span class="pill '+s+'">'+s+'</span>';
    function renderReceipts(list) {
      receiptsEl.innerHTML = list.length ? list.map(r =>
        '<div class="rcpt"><div><b>'+r.receiptNo+'</b> · '+r.ringNo+' '+pill(r.status)+
        '<div class="meta">'+r.owner+' · 父:'+(r.fatherRing||"未")+' 母:'+(r.motherRing||"未")+(r.conflictOf?(' · 冲突于 '+r.conflictOf):'')+'</div></div>'+
        (r.status==='pending'?'<button data-confirm="'+r.receiptNo+'">确认入棚</button>':'')+
        '</div>').join("") : '<p class="meta">暂无回执</p>';
      receiptsEl.querySelectorAll("[data-confirm]").forEach(b => b.onclick = async () => {
        const requestId = "web-confirm-" + b.dataset.confirm + "-" + Date.now();
        await api('/api/intake/'+encodeURIComponent(b.dataset.confirm)+'/confirm', { method:'POST', body: JSON.stringify({ requestId }) });
        await load();
      });
    }
    function renderCards() {
      cards.innerHTML = pigeons.map(p => '<article class="card"><h3>'+p.ringNo+'</h3><span class="pill">'+p.owner+'</span><div class="meta">'+p.color+' · '+p.loft+'</div><div>父：'+(p.fatherRing || "未登记")+'</div><div>母：'+(p.motherRing || "未登记")+'</div><label>录入转让</label><input data-to="'+p.ringNo+'" placeholder="新归属人"><button data-transfer="'+p.ringNo+'">保存转让</button><label>归巢成绩</label><input data-race="'+p.ringNo+'" placeholder="赛事/距离/名次，如200公里/200/6"><button data-score="'+p.ringNo+'">保存成绩</button></article>').join("");
      document.querySelectorAll("[data-transfer]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.transfer; const to = document.querySelector('[data-to="'+ringNo+'"]').value;
        const requestId = "web-transfer-" + ringNo + "-" + Date.now();
        await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/transfers', { method:'POST', body: JSON.stringify({ to, requestId }) }); await load();
      });
      document.querySelectorAll("[data-score]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.score; const raw = document.querySelector('[data-race="'+ringNo+'"]').value.split("/");
        const requestId = "web-race-" + ringNo + "-" + Date.now();
        await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/races', { method:'POST', body: JSON.stringify({ event: raw[0] || "未命名赛事", distance: Number(raw[1] || 0), rank: Number(raw[2] || 0), requestId }) }); await load();
      });
    }
    function renderRelation(data) {
      if (!data) { detail.innerHTML = '<h2>血统查询</h2><p class="meta">请输入足环号查看父母、子代、转让和成绩。</p>'; return; }
      const p = data.pigeon;
      detail.innerHTML = '<h2>'+p.ringNo+' 血统档案</h2><div class="relation"><div class="small"><b>父鸽</b><br>'+(data.father?.ringNo || p.fatherRing || "未登记")+'</div><div class="small"><b>本鸽</b><br>'+p.owner+' · '+p.color+'</div><div class="small"><b>母鸽</b><br>'+(data.mother?.ringNo || p.motherRing || "未登记")+'</div></div><div><b>子代</b> '+(data.children.map(c => c.ringNo).join("、") || "暂无")+'</div><div class="meta">转让：'+(p.transfers.map(t => t.from+"→"+t.to).join(" / ") || "暂无")+'</div><div class="meta">归巢：'+(p.races.map(r => r.event+" 第"+r.rank+"名").join(" / ") || "暂无")+'</div>';
    }
    async function load(){
      pigeons = await api("/api/pigeons");
      const receipts = await api("/api/receipts");
      renderCards(); renderReceipts(receipts); renderRelation(null);
    }
    document.querySelector("#searchBtn").onclick = async () => renderRelation(await api('/api/pigeons/'+encodeURIComponent(search.value)+'/relation'));
    document.querySelector("#reload").onclick = load;
    intake.onsubmit = async event => {
      event.preventDefault();
      const f = Object.fromEntries(new FormData(intake).entries());
      const body = {
        requestId: f.requestId || undefined, ringNo: f.ringNo, owner: f.owner,
        fatherRing: f.fatherRing, motherRing: f.motherRing, color: f.color, loft: f.loft,
        vaccines: (f.vacName || f.vacDate) ? [{ date: f.vacDate, name: f.vacName }] : [],
        firstRace: (f.raceEvent || f.raceDistance) ? { date: f.raceDate, event: f.raceEvent, distance: Number(f.raceDistance||0), rank: Number(f.raceRank||0) } : null
      };
      try { await api("/api/intake", { method:"POST", body: JSON.stringify(body) }); }
      catch (e) { if (!String(e.message).includes("conflict")) throw e; }
      intake.reset(); await load();
    };
    form.onsubmit = async event => {
      event.preventDefault();
      const f = Object.fromEntries(new FormData(form).entries());
      await api("/api/pigeons", { method:"POST", body: JSON.stringify({ ...f, requestId: "web-quick-" + f.ringNo + "-" + Date.now() }) });
      form.reset(); await load();
    };
    load();
  </script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let db = await loadDb();
    const migratedNow = migrate(db);
    if (migratedNow.migrated) await saveDb(db);
    refresh(db);

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && url.pathname === "/api/pigeons") return sendJson(res, 200, db.pigeons);
    if (req.method === "GET" && url.pathname === "/api/receipts") return sendJson(res, 200, db.receipts);

    // 收鸽提交：生成待确认回执
    if (req.method === "POST" && url.pathname === "/api/intake") {
      const input = await body(req);
      const requestId = input.requestId || rid();
      const cachedHit = cached(db, requestId);
      const result = cachedHit || await handleIntakeSubmit(db, input, requestId);
      if (req.headers["x-simulate-crash"] === "1") process.exit(1); // 断电：写入已落盘，凭 requestId 可恢复
      return sendJson(res, result.status, result.body);
    }

    // 入棚确认：回执成为入棚凭据
    const confirmMatch = url.pathname.match(/^\/api\/intake\/([^/]+)\/confirm$/);
    if (confirmMatch && req.method === "POST") {
      const input = await body(req);
      const requestId = input.requestId || rid();
      const cachedHit = cached(db, requestId);
      const result = cachedHit || await handleIntakeConfirm(db, decodeURIComponent(confirmMatch[1]), requestId);
      if (req.headers["x-simulate-crash"] === "1") process.exit(1);
      return sendJson(res, result.status, result.body);
    }

    // 快捷建档案：直接确认入棚（生成回执）
    if (req.method === "POST" && url.pathname === "/api/pigeons") {
      const input = await body(req);
      if (db.pigeons.some(item => item.ringNo === input.ringNo)) return sendJson(res, 409, { error: "ring_exists" });
      const requestId = input.requestId || rid();
      const receiptNo = nextReceiptNo(db);
      const now = new Date().toISOString();
      const ev = {
        requestId, type: "IntakeConfirmed", receiptNo, ringNo: input.ringNo, at: now,
        owner: input.owner || "", fatherRing: input.fatherRing || "", motherRing: input.motherRing || "",
        color: input.color || "", loft: input.loft || "", vaccines: [], firstRace: null
      };
      db.events.push(ev);
      remember(db, requestId, 201, { ok: true, receiptNo, ringNo: input.ringNo });
      await commit(db);
      return sendJson(res, 201, { ok: true, receiptNo, ringNo: input.ringNo });
    }

    // 迁移：手动触发补齐（幂等）
    if (req.method === "POST" && url.pathname === "/api/admin/migrate") {
      const input = await body(req).catch(() => ({}));
      const requestId = input.requestId || rid();
      const cachedHit = cached(db, requestId);
      if (cachedHit) return sendJson(res, cachedHit.status, cachedHit.body);
      const was = db.meta.migrated;
      db.meta.migrated = false; // 允许重跑
      const r = migrate(db);
      if (!was) db.meta.migrated = true;
      remember(db, requestId, 200, { ok: true, ...r });
      await saveDb(db);
      refresh(db);
      return sendJson(res, 200, { ok: true, ...r });
    }

    const relationMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/relation$/);
    if (relationMatch && req.method === "GET") {
      const data = relation(db, decodeURIComponent(relationMatch[1]));
      return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: "pigeon_not_found" });
    }

    // 父母环号更正（确认前改动会作废待确认回执）
    const parentsMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/parents$/);
    if (parentsMatch && req.method === "POST") {
      const input = await body(req);
      const requestId = input.requestId || rid();
      const cachedHit = cached(db, requestId);
      const result = cachedHit || await handleParentsCorrection(db, decodeURIComponent(parentsMatch[1]), input, requestId);
      if (req.headers["x-simulate-crash"] === "1") process.exit(1);
      return sendJson(res, result.status, result.body);
    }

    // 追加疫苗 / 训放成绩 / 转让：均按 requestId 幂等
    const actionMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/(transfers|races|vaccines)$/);
    if (actionMatch && req.method === "POST") {
      const input = await body(req);
      const requestId = input.requestId || rid();
      const cachedHit = cached(db, requestId);
      const result = cachedHit || await handleAppend(db, decodeURIComponent(actionMatch[1]), actionMatch[2], input, requestId);
      if (req.headers["x-simulate-crash"] === "1") process.exit(1);
      return sendJson(res, result.status, result.body);
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    const status = error.status || 500;
    sendJson(res, status, { error: error.error || error.message });
  }
});

server.listen(port, () => console.log(`Racing pigeon registry app listening on http://localhost:${port}`));
