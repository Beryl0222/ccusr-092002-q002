# 花卉种苗多点品种试验服务

在不同海拔、不同设施的基地对鲜切花新品种进行多点品种比较试验。解决三类老问题：
各站点自行命名苗批、挑好苗上报导致结论无法复核；分不清环境差异还是繁育代次偏差；
检疫状态变化后历史结论被动失效且无人知道哪些推荐受影响。

零外部依赖，Node 原生 ESM + `node:test`。

## 核心机制

- **播种前冻结**：方案（参试苗批、对照、指标、观察日历、质量门槛、播种时刻）在播种时刻之前冻结；
  冻结即生成随机完全区组（RCBD）布局、全局唯一盲码和封存清单哈希，之后不可修改。
- **随机区组 + 盲码**：随机种子只由方案内容派生（可独立复算审计）；每个站点×区组内参试苗批与对照各出现一次；
  站点在揭盲前只能看到本站地块的盲码，看不到品种/苗批对应关系，无法"挑长势最好的上报"。
- **离线幂等汇入**：站点以 bundle 为单位提交成活、花期、病害、产量与环境记录；
  整包重发原样返回首次结果、不产生新事件；跨包同记录内容一致按重发跳过，内容不一致拒绝。
- **方案偏离原样留存**：漏测、换苗、越区栽种、提前淘汰作为 deviation 事件保留，不丢弃、不改成正常值；
  是否进入统计由质量门槛决定，每条排除都带原因和来源记录。
- **更正而非删除**：研究负责人可更正录入错误，原值、更正值、原因、操作者、时间全部留痕；
  **揭盲后主要指标（primary）锁定**，任何角色不得改动。
- **质量门槛 + 确定性比较**：统计人员只使用达到门槛的数据（换苗比例、环境覆盖率、越区、提前淘汰等），
  按"同区组内参试 − 对照"配对差值比较，区组吸收海拔/设施环境差异；同品种不同代次苗批分列，
  代次偏差可与环境偏差分开识别。
- **输入快照**：每份分析固定在生成时刻的事件链头哈希上，并附规范化输入快照指纹；
  评审者在同一快照上重算必然得到同一结果。
- **检疫影响标记**：苗批检疫状态变化只追加事实并**标出受影响的分析与推荐意见**，
  历史分析事件字节不变——标记影响，而不是重写历史。
- **可追溯**：一项推荐意见可追到分析快照 → 协议版本（冻结事件序号/封存哈希/随机种子）
  → 具体地块、观察者、排除依据。

## 事件溯源底座

`src/store.js` 是唯一事实来源：仅追加事件日志，每条事件含 `prev_hash` 形成 SHA-256 哈希链。
任何对历史事件的删改都会在 `GET /audit/chain` 或重启引导时被发现。当前状态由 `src/model.js`
从事件流重放得到；分析可对任意历史链头切片重放。

设置 `EVENT_LOG=数据文件.jsonl` 启动时事件顺序落盘，重启校验哈希链后恢复。

## 角色

请求头传递身份（值用账号/工号等 ASCII 标识）：

| 头 | 取值 |
|---|---|
| `X-Role` | `lead`（研究负责人）/ `site`（站点观察者）/ `statistician`（统计人员）/ `reviewer`（评审者） |
| `X-Actor` | 操作者标识 |
| `X-Site` | site 角色必填，限定只能提交本站数据 |

## HTTP 接口

| 方法 路径 | 角色 | 说明 |
|---|---|---|
| `POST /admin/varieties` `/admin/batches` `/admin/sites` | lead | 登记品种（授权最大代次）、苗批（代次、检疫状态）、站点（海拔、设施） |
| `POST /protocols` | lead | 起草方案（冻结前可修订） |
| `POST /protocols/{id}/freeze` | lead | 播种前冻结：定型区组、盲码、封存哈希 |
| `GET /protocols/{id}/sites/{site}` | — | 站点盲态作业单（揭盲前无品种信息） |
| `POST /ingest/bundles` | site | 离线批次幂等汇入（observation/environment/deviation） |
| `POST /records/correct` | lead | 更正录入错误（原值留痕；揭盲后主要指标拒绝） |
| `POST /protocols/{id}/unblind` | lead | 揭盲 |
| `POST /protocols/{id}/analyses` | statistician | 揭盲后生成带输入快照的比较结果 |
| `GET /protocols/{id}/results?head=` | statistician/reviewer/lead | 查看比较结果（可指定历史链头） |
| `POST /analyses/{id}/review` | reviewer 等 | 在分析固定快照上复算并出具一致性结论 |
| `POST /recommendations` | lead | 基于分析签发推荐意见 |
| `GET /recommendations/{id}/trace` | reviewer 等 | 推荐意见 → 地块/观察者/协议版本/排除依据/检疫影响 |
| `POST /quarantine/changes` | lead | 检疫状态变化（自动标记受影响结论） |
| `GET /audit/chain` | — | 哈希链完整性校验 |
| `GET /events?head=` | — | 事件流（可按链头切片） |
| `GET /health` | — | 服务身份 |

## 运行

```bash
npm run check          # 服务身份自检
npm test               # 26 项测试（域逻辑 + HTTP 端到端 + 持久化/防篡改）
npm start -- --port 8000
EVENT_LOG=data/events.jsonl npm start   # 带落盘与重启恢复
```

## 目录

```
contracts/  propagation_batch.json   起点样例（品种 YN-RS-26 / 苗批 PB-0042 / 代次 2）
            multi_site_trial.json    多点试验字段与流程契约
src/        util/store/model         哈希、确定性随机、事件日志、投影
            trial                    登记、方案冻结、RCBD、盲码、揭盲
            ingest                   离线幂等汇入、偏离留存、更正、检疫变更
            analysis                 质量门槛、配对比较、快照、复核、影响标记、追溯
            app/service              门面编排与 HTTP
test/                                node:test 测试
```

契约样例均为虚构数据，不含真实个人资料、业务凭据或生产连接信息。
