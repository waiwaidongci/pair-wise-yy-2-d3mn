// 并发压测：同足环 N 个并发收鸽，必须恰好 1 张生效回执、N-1 条冲突留痕
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const N = 20;
const dir = await mkdtemp(join(tmpdir(), "pigeon-stress-"));
const port = 4700 + Math.floor(Math.random() * 200);
const srv = spawn(process.execPath, [new URL("../server.js", import.meta.url).pathname], {
  env: { ...process.env, PORT: String(port), DB_FILE: join(dir, "p.json") }
});
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("start timeout")), 5000);
  srv.stdout.on("data", d => String(d).includes("listening") && (clearTimeout(t), res()));
});
const base = `http://127.0.0.1:${port}`;
const results = await Promise.all(Array.from({ length: N }, (_, i) =>
  fetch(`${base}/api/intake`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: `S-${i}`, ringNo: "CHN-HOT-X", owner: `棚${i}`, clerk: `员${i}` })
  }).then(async r => ({ status: r.status, body: await r.json() }))
));
const wins = results.filter(r => r.status === 201);
const lost = results.filter(r => r.status === 409);
const [receipts, conflicts, pigeons] = await Promise.all([
  fetch(`${base}/api/receipts`).then(r => r.json()),
  fetch(`${base}/api/conflicts`).then(r => r.json()),
  fetch(`${base}/api/pigeons`).then(r => r.json())
]);
srv.kill("SIGKILL");
await rm(dir, { recursive: true, force: true });

const ok =
  wins.length === 1 &&
  lost.length === N - 1 &&
  lost.every(r => r.body.winnerReceiptNo === wins[0].body.receipt.receiptNo) &&
  receipts.filter(r => r.ringNo === "CHN-HOT-X").length === 1 &&
  conflicts.length === N - 1 &&
  conflicts.every(c => c.winnerReceiptNo === wins[0].body.receipt.receiptNo && c.payload) &&
  !pigeons.some(p => p.ringNo === "CHN-HOT-X"); // 未确认，档案不得生成
console.log(ok ? `✓ ${N} 并发：1 生效 / ${N - 1} 冲突，档案未受影响` : "✗ 并发结果异常");
if (!ok) {
  console.log({ wins: wins.length, lost: lost.length, receipts: receipts.length, conflicts: conflicts.length });
  process.exit(1);
}
