# 花卉种苗权属防疫链

记录花卉品种授权、繁育代次、检疫结果与问题种苗的影响范围，并提供多点品种试验服务。

`contracts/propagation_batch.json` 保存公开的领域样例，用来约定外部数据的名称与层级；样例不含真实个人资料、业务凭据或生产连接信息。`contracts/variety_trial.json` 给出以该苗批为起点的试验方案样例。

执行 `npm run check` 可检查服务身份，运行 `npm test` 可核对基础契约与试验领域不变式。服务启动后，`/health` 返回项目标识。

## 多点品种试验服务

以 propagation_batch 的品种、代次和苗批为起点建立试验，覆盖以下规则：

- **播种前冻结方案**：随机区组、盲码、对照品种与观察日历由随机种子确定性生成，播种前必须冻结；冻结后站点、处理与区组设计锁定，只能带理由修订观察日历与质量门槛，历史版本保留。
- **幂等汇入**：站点离线采集的成活、花期、病害、产量与环境记录按 `record_id` 幂等汇入；重放去重，同号不同内容拒绝并提示走纠错流程。
- **方案偏离保留**：漏测（按观察日历自动检测）、换苗、越区栽种（盲码与地块分配不符时自动登记）、提前淘汰都记为方案偏离，不回改原始记录。
- **纠错受控**：只有研究负责人能纠正录入错误；原值保留在 `original_value` 与 `corrections` 中，不可删除；揭盲后主要指标锁定，非主要指标仍可纠错。
- **质量门槛与快照统计**：统计人员只用达到质量门槛（成活率、主要指标漏测次数、每处理有效小区数）的数据生成比较结果；结果携带输入快照（记录编号 + 版本 + 排除依据），相同快照重跑返回同一分析，`verify` 可在相同快照上重算复核。
- **检疫影响标记**：苗批检疫状态变化时，标出受影响的分析与推荐意见，历史结果不被重写。
- **全程追溯**：从推荐意见可追到具体地块、观察者、协议版本与排除依据。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 服务身份 |
| POST | `/trials` | 以品种、代次、苗批建立试验 |
| GET | `/trials/:id` | 查看试验全量状态 |
| POST | `/trials/:id/protocol/freeze` | 冻结或修订试验方案 |
| POST | `/trials/:id/sowing` | 登记播种（须先冻结方案） |
| POST | `/trials/:id/unblind` | 揭盲，此后主要指标锁定 |
| POST | `/trials/:id/observations` | 幂等汇入观察记录 |
| POST | `/trials/:id/observations/:rid/corrections` | 研究负责人纠正录入错误 |
| POST | `/trials/:id/deviations` | 上报方案偏离（换苗、越区、提前淘汰等） |
| POST | `/trials/:id/deviations/detect` | 按观察日历检测漏测 |
| POST | `/trials/:id/analyses` | 统计人员生成带输入快照的比较结果 |
| GET | `/trials/:id/analyses/:aid` | 查看分析结果与快照 |
| POST | `/trials/:id/analyses/:aid/verify` | 在相同快照上复核一致性 |
| POST | `/trials/:id/recommendations` | 研究负责人形成推荐意见 |
| GET | `/trials/:id/recommendations/:rid/trace` | 追溯推荐意见的全部依据 |
| POST | `/batches/:batchId/quarantine` | 登记苗批检疫状态变化并标出受影响结论 |
| GET | `/batches/:batchId/events` | 查看苗批检疫事件历史 |

角色通过请求体中的 `role` 字段声明：`research_lead`（研究负责人）、`statistician`（统计人员）。
