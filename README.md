# 桥梁应变班交台

测量员先在高程锁定专页锁定跨段测点高程，再报送微应变读数；后台工人用 `FOR UPDATE SKIP LOCKED` 认领候审队列，按 **80～220 με** 判定 **合格** 或 **越界**。

## 业务流程

1. **锁高程**：测量员在顶栏「高程锁定」专页填跨段号与高程米数并点锁定。同一跨段至多锁成一笔，两人撞车或重复锁定当场拒（`409`）。
2. **报送**：跨段未锁定高程时，网页表单与直连接口（`POST /api/readings`）两条写口都整笔退回（`409`，写清「尚未锁定高程」）。入队与高程冻结在同一条 `INSERT ... SELECT` 里一次写完，缺一边整笔失败。
3. **冻结**：报送单带上锁定时刻的高程快照，事后改锁定数字动不了旧单高程；已办结单再打开高程不变。
4. **复核**：复核员可翻看锁定表、待锁表与冻住的高程，不能改锁也不能报送（`403`）。

高程锁定专页整屏展示：锁定表单（仅测量员）、待锁表、已锁清单、挡回样例。

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
| POST | `/api/auth/login` | 登录取 token |
| GET | `/api/elevation-locks` | 锁定表 + 待锁表（登录即可看） |
| POST | `/api/elevation-locks` | 锁定高程（仅测量员；重复锁定 409） |
| GET | `/api/readings` | 读数列表（含随单冻结的高程） |
| POST | `/api/readings` | 报送微应变（仅测量员；未锁定高程 409 整笔退回） |

## 种子数据

| 跨段 | 微应变 | 冻结高程 | 结论 |
|------|--------|----------|------|
| 跨中S1 | 150 με | 12.0 m | 合格 |
| 支座S2 | 40 με | 8.5 m | 越界 |

待锁台账：跨中甲、支座乙、跨中丙、支座丁、拱肋戊、引桥己。

## 本地开发（可选）

```bash
cd backend && pip install -r requirements.txt
python -m sanic api.app --host=0.0.0.0 --port=8000 --single-process
python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8198**。
