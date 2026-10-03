import math
import os
from datetime import datetime, timedelta, timezone

import jwt
from passlib.context import CryptContext
from sanic import Sanic
from sanic.response import json as sanic_json

from db import create_pool, ensure_schema, seed_if_empty

SECRET = os.environ.get("JWT_SECRET", "bridge-strain-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

USERS = {
    "surveyor": {"role": "writer", "password_hash": pwd.hash("surv123456")},
    "reviewer": {"role": "reader", "password_hash": pwd.hash("rev123456")},
}

app = Sanic("bridge-strain-shift")


def _auth_header(request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


def _decode_user(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return None
    sub = payload.get("sub")
    if sub not in USERS:
        return None
    return {"username": sub, "role": payload.get("role")}


def _require_user(request) -> dict:
    user = _decode_user(_auth_header(request))
    if not user:
        return None
    return user


def _iso(dt) -> str | None:
    if dt is None:
        return None
    return dt.isoformat()


def _parse_finite(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def _reading_out(r: dict) -> dict:
    return {
        "id": r["id"],
        "span_code": r["span_code"],
        "microstrain": r["microstrain"],
        "elevation_m": r["elevation_m"],
        "verdict": r["verdict"],
        "reason": r["reason"],
        "status": r["status"],
        "created_by": r["created_by"],
        "created_at": _iso(r["created_at"]),
        "processed_at": _iso(r["processed_at"]),
    }


def _lock_out(r: dict) -> dict:
    return {
        "id": r["id"],
        "span_code": r["span_code"],
        "elevation_m": r["elevation_m"],
        "locked_by": r["locked_by"],
        "locked_at": _iso(r["locked_at"]),
    }


@app.before_server_start
async def setup(_app, _loop):
    pool = await create_pool()
    _app.ctx.pool = pool
    await ensure_schema(pool)
    await seed_if_empty(pool)


@app.after_server_stop
async def teardown(_app, _loop):
    pool = _app.ctx.pool
    if pool:
        await pool.close()


@app.get("/api/health")
async def health(_request):
    return sanic_json({"status": "ok", "service": "bridge-strain-shift"})


@app.post("/api/auth/login")
async def login(request):
    body = request.json or {}
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    user = USERS.get(username)
    if not user or not pwd.verify(password, user["password_hash"]):
        return sanic_json({"detail": "用户名或密码错误"}, status=401)
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode(
        {"sub": username, "role": user["role"], "exp": exp},
        SECRET,
        algorithm="HS256",
    )
    return sanic_json(
        {"access_token": token, "username": username, "role": user["role"]}
    )


@app.get("/api/elevations")
async def list_elevations(request):
    """高程锁定专页数据：待锁表 + 已锁清单。测量员、复核员均可查看。"""
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT c.span_code
                FROM span_catalog c
                LEFT JOIN span_elevation_locks l ON l.span_code = c.span_code
                WHERE l.id IS NULL
                ORDER BY c.span_code
                """
            )
            pending = [r["span_code"] for r in await cur.fetchall()]
            await cur.execute(
                """
                SELECT id, span_code, elevation_m, locked_by, locked_at
                FROM span_elevation_locks
                ORDER BY id
                """
            )
            locked = [_lock_out(r) for r in await cur.fetchall()]
    return sanic_json({"pending": pending, "locked": locked})


@app.post("/api/elevations/lock")
async def lock_elevation(request):
    """测量员锁定某跨段测点高程；同一跨段只允许锁成一笔，撞车当场拒。"""
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可锁定高程，复核员只读"}, status=403)
    body = request.json or {}
    span_code = str(body.get("span_code", "")).strip()
    if not span_code:
        return sanic_json({"detail": "跨段编号不能为空"}, status=400)
    elevation_m = _parse_finite(body.get("elevation_m"))
    if elevation_m is None:
        return sanic_json({"detail": "高程必须是数字（米）"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            # UNIQUE(span_code) + ON CONFLICT DO NOTHING：两名测量员撞同一跨，
            # 至多一笔锁成，另一笔拿不到行、当场拒。
            await cur.execute(
                """
                INSERT INTO span_elevation_locks (span_code, elevation_m, locked_by, locked_at)
                VALUES (%s, %s, %s, now())
                ON CONFLICT (span_code) DO NOTHING
                RETURNING id, span_code, elevation_m, locked_by, locked_at
                """,
                (span_code, elevation_m, user["username"]),
            )
            row = await cur.fetchone()
            if row is None:
                await conn.rollback()
                return sanic_json(
                    {
                        "detail": f"跨段「{span_code}」已锁定高程，不能重复锁定；"
                        "已冻结的旧单高程不受影响"
                    },
                    status=409,
                )
            # 自由录入的跨段也补进清单，保持待锁表口径一致
            await cur.execute(
                "INSERT INTO span_catalog (span_code) VALUES (%s)"
                " ON CONFLICT (span_code) DO NOTHING",
                (span_code,),
            )
        await conn.commit()

    return sanic_json(
        {**_lock_out(row), "message": f"跨段「{span_code}」高程 {elevation_m} 米已锁定"},
        status=201,
    )


@app.get("/api/readings")
async def list_readings(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, span_code, microstrain, elevation_m, verdict, reason,
                       status, created_by, created_at, processed_at
                FROM strain_readings
                ORDER BY id DESC
                """
            )
            rows = await cur.fetchall()
    return sanic_json([_reading_out(r) for r in rows])


@app.post("/api/readings")
async def create_reading(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可提交应变读数"}, status=403)
    body = request.json or {}
    span_code = str(body.get("span_code", "")).strip()
    if not span_code:
        return sanic_json({"detail": "跨段编号不能为空"}, status=400)
    microstrain = _parse_finite(body.get("microstrain"))
    if microstrain is None:
        return sanic_json({"detail": "微应变必须是数字"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            # 入队与高程冻结一次写完：单条 INSERT...SELECT 从锁定表取高程快照。
            # 跨段未锁定时 SELECT 为空、整笔不入队，缺一边即整题失败。
            await cur.execute(
                """
                INSERT INTO strain_readings
                    (span_code, microstrain, elevation_m, status, created_by, created_at)
                SELECT %s, %s, l.elevation_m, 'pending', %s, now()
                FROM span_elevation_locks l
                WHERE l.span_code = %s
                RETURNING id, span_code, microstrain, elevation_m, verdict, reason,
                          status, created_by, created_at, processed_at
                """,
                (span_code, microstrain, user["username"], span_code),
            )
            row = await cur.fetchone()
            if row is None:
                await conn.rollback()
                return sanic_json(
                    {
                        "detail": f"跨段「{span_code}」尚未锁定测点高程，整笔退回；"
                        "请先在「高程锁定」专页完成锁定后再报送"
                    },
                    status=409,
                )
        await conn.commit()

    return sanic_json(
        {
            **_reading_out(row),
            "message": f"已入队候审，高程 {row['elevation_m']} 米已随单冻结，"
            "后台工人将认领并判定",
        },
        status=201,
    )
