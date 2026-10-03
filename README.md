# 赛鸽收鸽登记站

运行：

```bash
npm start
```

访问 `http://localhost:3024`。测试：`npm test`（端到端规则 + 并发压测）。

## 业务规则

- **收鸽一次补齐**：父母环号、疫苗、首场成绩随同一份收鸽回执提交（`POST /api/intake`，须带 `requestId`）。
- **回执即入棚凭据**：回执先为 `pending`，`POST /api/receipts/:no/confirm` 后才生成鸽只档案（`confirmed`）。
- **先到生效**：两名登记员并发提交同一足环，先到回执生效，后到整份内容进入 `/api/conflicts` 留痕，绝不修改生效档案。
- **父母环号更正**：确认前更正父母环号（`POST /api/receipts/:no/amend-parents`），原回执置 `invalid` 并自动重算一张新回执，疫苗与首场成绩随迁；确认后不得更正。
- **历史迁移**：`POST /api/migrate` 为缺少回执的旧档案按历史先后（最早疫苗/转让/成绩日期）补齐 `confirmed` 回执，血统、疫苗、成绩只读不动，可重复执行。
- **断电恢复**：所有写入先记意图（`intents`）并串行执行，落盘采用临时文件 + rename 原子替换；写入失败后凭原 `requestId` 重放，返回上次结果，疫苗与训放成绩另有内容去重，不会重复追加。
  - 演练用请求头 `X-Simulate-Failure: after-intent`（数据写后断电）或 `before-commit`（落盘前断电）。
