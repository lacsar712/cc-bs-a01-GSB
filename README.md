# 桥梁应变班交台

测量员先在 **高程锁定专页** 锁定跨段测点高程，再上报微应变读数；后台工人用 `FOR UPDATE SKIP LOCKED` 认领待处理队列，按 **80～220 με** 判定 **合格** 或 **越界**。

## 业务流程

1. **先锁高程**：测量员在顶栏「高程锁定」专页填跨段号与高程（米）并点锁定。每个跨段只允许锁成一笔——两人撞同一跨时另一笔当场拒绝（`UNIQUE(span_code)` + `ON CONFLICT DO NOTHING`）。
2. **再报读数**：未锁定的跨段无论从网页表单还是直连接口 `POST /api/readings` 报送，都 **整笔退回**（409），并写清尚未锁定高程。入队与高程冻结是单条 `INSERT…SELECT` 一次写完：从锁定表取高程快照随单落库，缺一边整题失败。
3. **高程随单冻结**：读数单上的高程是报送时的快照，事后改专页数字动不了旧单高程；已办结单再打开高程不变。
4. **复核员只读**：可翻锁定表、已锁清单与冻住高程，不能改锁也不能报。

专页整屏放 **待锁表 / 已锁清单 / 挡回样例** 三块，顶栏单独挂「高程锁定」入口。

## 技术栈

| 层 | 选型 |
|----|------|
| 接口 | Python Sanic + psycopg（异步连接池） |
| 工人 | `worker.py`（psycopg 同步，`FOR UPDATE SKIP LOCKED`） |
| 页面 | Mithril.js + Vite，nginx 反代 `/api` |
| 数据库 | PostgreSQL 16 |

## 端口

| 服务 | 地址 |
|------|------|
| 页面 | http://localhost:3198 |
| 接口 | http://localhost:8198 |
| PostgreSQL | localhost:54398（库名 `bridgestrain`） |

## 账号

| 用户 | 密码 | 权限 |
|------|------|------|
| surveyor | surv123456 | 测量员，可锁定高程、提交读数 |
| reviewer | rev123456 | 复核员，只读列表与锁定表 |

## 启动

```bash
cd projects/19-bridge-strain-shift
docker compose up --build
```

健康检查：`GET http://localhost:8198/api/health` → `{"status":"ok","service":"bridge-strain-shift"}`

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/login` | 登录取 JWT |
| GET | `/api/elevations` | 待锁表 + 已锁清单（登录即可） |
| POST | `/api/elevations/lock` | 锁定高程（仅测量员；重复锁定 409） |
| GET | `/api/readings` | 读数列表（含随单冻结的高程） |
| POST | `/api/readings` | 报送读数（仅测量员；未锁跨段 409 整笔退回） |

## 种子数据

| 跨段 | 微应变 | 冻结高程 | 结论 |
|------|--------|----------|------|
| 跨中S1 | 150 με | 12.5 米 | 合格 |
| 支座S2 | 40 με | 8.0 米 | 越界 |

待锁表初始含：跨中甲、支座乙、跨中丙、支座丁（跨中S1、支座S2 已随种子锁定）。

## 验收路径

1. 锁「跨中甲」高程 12 米 → 报 150 με → 进候审（pending），单上高程 12。
2. 未锁「支座乙」直接报 → 409 整笔退回，提示尚未锁定高程。
3. 工人办结后再打开该单 → 高程仍是 12。

## 本地开发（可选）

```bash
cd backend && pip install -r requirements.txt
python -m sanic api.app --host=0.0.0.0 --port=8000 --single-process
python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8198**。
