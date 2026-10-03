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


def _lock_json(row: dict) -> dict:
    return {
        "id": row["id"],
        "span_code": row["span_code"],
        "elevation_m": row["elevation_m"],
        "locked_by": row["locked_by"],
        "locked_at": _iso(row["locked_at"]),
    }


def _reading_json(row: dict) -> dict:
    return {
        "id": row["id"],
        "span_code": row["span_code"],
        "microstrain": row["microstrain"],
        "elevation_m": row["elevation_m"],
        "verdict": row["verdict"],
        "reason": row["reason"],
        "status": row["status"],
        "created_by": row["created_by"],
        "created_at": _iso(row["created_at"]),
        "processed_at": _iso(row["processed_at"]),
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


@app.get("/api/elevation-locks")
async def list_elevation_locks(request):
    """锁定表与待锁表：测量员与复核员都可翻看。"""
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, span_code, elevation_m, locked_by, locked_at
                FROM span_elevation_locks
                ORDER BY locked_at, id
                """
            )
            locks = await cur.fetchall()
            await cur.execute(
                """
                SELECT c.span_code
                FROM span_catalog c
                LEFT JOIN span_elevation_locks l ON l.span_code = c.span_code
                WHERE l.span_code IS NULL
                ORDER BY c.sort_no, c.span_code
                """
            )
            pending = await cur.fetchall()
    return sanic_json(
        {
            "locks": [_lock_json(r) for r in locks],
            "pending": [r["span_code"] for r in pending],
        }
    )


@app.post("/api/elevation-locks")
async def create_elevation_lock(request):
    """测量员锁定跨段高程；同一跨段至多锁成一笔，撞车当场拒。"""
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可锁定高程，复核员只读"}, status=403)
    body = request.json or {}
    span_code = str(body.get("span_code", "")).strip()
    if not span_code:
        return sanic_json({"detail": "跨段编号不能为空"}, status=400)
    try:
        elevation_m = float(body.get("elevation_m"))
    except (TypeError, ValueError):
        return sanic_json({"detail": "高程必须是数字（米）"}, status=400)
    if not math.isfinite(elevation_m):
        return sanic_json({"detail": "高程必须是有限数字（米）"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO span_elevation_locks
                    (span_code, elevation_m, locked_by, locked_at)
                VALUES (%s, %s, %s, now())
                ON CONFLICT (span_code) DO NOTHING
                RETURNING id, span_code, elevation_m, locked_by, locked_at
                """,
                (span_code, elevation_m, user["username"]),
            )
            row = await cur.fetchone()
            if row is None:
                await cur.execute(
                    """
                    SELECT id, span_code, elevation_m, locked_by, locked_at
                    FROM span_elevation_locks
                    WHERE span_code = %s
                    """,
                    (span_code,),
                )
                existing = await cur.fetchone()
        await conn.commit()

    if row is None:
        return sanic_json(
            {
                "detail": (
                    f"跨段 {span_code} 高程已锁定为 "
                    f"{existing['elevation_m']} m（{existing['locked_by']} 锁定），"
                    "不得重复锁定"
                ),
                "lock": _lock_json(existing),
            },
            status=409,
        )

    return sanic_json(
        {
            **_lock_json(row),
            "message": f"跨段 {span_code} 高程 {row['elevation_m']} m 已锁定",
        },
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
    return sanic_json([_reading_json(r) for r in rows])


@app.post("/api/readings")
async def create_reading(request):
    """报送微应变：入队与高程冻结在同一条 INSERT 里一次写完。

    跨段尚未锁定高程时 SELECT 不到锁定行，整笔不入队，直接退回。
    """
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可提交应变读数"}, status=403)
    body = request.json or {}
    span_code = str(body.get("span_code", "")).strip()
    if not span_code:
        return sanic_json({"detail": "跨段编号不能为空"}, status=400)
    try:
        microstrain = float(body.get("microstrain"))
    except (TypeError, ValueError):
        return sanic_json({"detail": "微应变必须是数字"}, status=400)
    if not math.isfinite(microstrain):
        return sanic_json({"detail": "微应变必须是有限数字"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO strain_readings
                    (span_code, microstrain, elevation_m, status, created_by, created_at)
                SELECT l.span_code, %s, l.elevation_m, 'pending', %s, now()
                FROM span_elevation_locks l
                WHERE l.span_code = %s
                RETURNING id, span_code, microstrain, elevation_m, verdict, reason,
                          status, created_by, created_at, processed_at
                """,
                (microstrain, user["username"], span_code),
            )
            row = await cur.fetchone()
        await conn.commit()

    if row is None:
        return sanic_json(
            {
                "detail": (
                    f"跨段 {span_code} 尚未锁定高程，整笔退回："
                    "请先在高程锁定专页完成锁定"
                )
            },
            status=409,
        )

    return sanic_json(
        {
            **_reading_json(row),
            "message": (
                f"已入队候审，高程 {row['elevation_m']} m 已随单冻结，"
                "后台工人将认领并判定"
            ),
        },
        status=201,
    )
