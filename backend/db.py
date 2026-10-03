import os

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from rules import judge_microstrain

DSN = os.environ.get(
    "DATABASE_URL", "postgresql://app:app@localhost:54398/bridgestrain"
)

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS strain_readings (
    id serial PRIMARY KEY,
    span_code text NOT NULL,
    microstrain double precision NOT NULL,
    elevation_m double precision,
    verdict text,
    reason text,
    status text NOT NULL DEFAULT 'pending',
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);
ALTER TABLE strain_readings
    ADD COLUMN IF NOT EXISTS elevation_m double precision;
CREATE INDEX IF NOT EXISTS idx_strain_readings_status ON strain_readings (status, id);

CREATE TABLE IF NOT EXISTS span_elevation_locks (
    id serial PRIMARY KEY,
    span_code text NOT NULL UNIQUE,
    elevation_m double precision NOT NULL,
    locked_by text NOT NULL,
    locked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS span_catalog (
    span_code text PRIMARY KEY,
    sort_no integer NOT NULL DEFAULT 0
);
"""

CATALOG_SPANS = ["跨中甲", "支座乙", "跨中丙", "支座丁", "拱肋戊", "引桥己"]

# 演示数据：跨段 -> (微应变, 锁定高程 m)
SEED_SAMPLES = {
    "跨中S1": (150.0, 12.0),
    "支座S2": (40.0, 8.5),
}


async def create_pool() -> AsyncConnectionPool:
    pool = AsyncConnectionPool(
        conninfo=DSN,
        min_size=1,
        max_size=5,
        kwargs={"row_factory": dict_row},
        open=False,
    )
    await pool.open()
    return pool


async def ensure_schema(pool: AsyncConnectionPool) -> None:
    async with pool.connection() as conn:
        await conn.execute(SCHEMA_SQL)
        await conn.commit()


async def seed_if_empty(pool: AsyncConnectionPool) -> None:
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT COUNT(*) AS n FROM span_catalog")
            if (await cur.fetchone())["n"] == 0:
                for sort_no, span_code in enumerate(CATALOG_SPANS, start=1):
                    await cur.execute(
                        "INSERT INTO span_catalog (span_code, sort_no) VALUES (%s, %s)",
                        (span_code, sort_no),
                    )
            await cur.execute("SELECT COUNT(*) AS n FROM strain_readings")
            if (await cur.fetchone())["n"] > 0:
                await conn.commit()
                return
            for span_code, (microstrain, elevation_m) in SEED_SAMPLES.items():
                await cur.execute(
                    """
                    INSERT INTO span_elevation_locks
                        (span_code, elevation_m, locked_by, locked_at)
                    VALUES (%s, %s, 'surveyor', now())
                    ON CONFLICT (span_code) DO NOTHING
                    """,
                    (span_code, elevation_m),
                )
                verdict, reason = judge_microstrain(microstrain)
                await cur.execute(
                    """
                    INSERT INTO strain_readings
                        (span_code, microstrain, elevation_m, verdict, reason,
                         status, created_by, processed_at)
                    VALUES (%s, %s, %s, %s, %s, 'done', 'surveyor', now())
                    """,
                    (span_code, microstrain, elevation_m, verdict, reason),
                )
        await conn.commit()


def connect_sync():
    import psycopg

    return psycopg.connect(DSN, row_factory=dict_row)


def ensure_schema_sync(conn) -> None:
    conn.execute(SCHEMA_SQL)


def seed_if_empty_sync(conn) -> None:
    row = conn.execute("SELECT COUNT(*) AS n FROM span_catalog").fetchone()
    if row["n"] == 0:
        for sort_no, span_code in enumerate(CATALOG_SPANS, start=1):
            conn.execute(
                "INSERT INTO span_catalog (span_code, sort_no) VALUES (%s, %s)",
                (span_code, sort_no),
            )
    row = conn.execute("SELECT COUNT(*) AS n FROM strain_readings").fetchone()
    if row["n"] > 0:
        conn.commit()
        return
    for span_code, (microstrain, elevation_m) in SEED_SAMPLES.items():
        conn.execute(
            """
            INSERT INTO span_elevation_locks
                (span_code, elevation_m, locked_by, locked_at)
            VALUES (%s, %s, 'surveyor', now())
            ON CONFLICT (span_code) DO NOTHING
            """,
            (span_code, elevation_m),
        )
        verdict, reason = judge_microstrain(microstrain)
        conn.execute(
            """
            INSERT INTO strain_readings
                (span_code, microstrain, elevation_m, verdict, reason,
                 status, created_by, processed_at)
            VALUES (%s, %s, %s, %s, %s, 'done', 'surveyor', now())
            """,
            (span_code, microstrain, elevation_m, verdict, reason),
        )
    conn.commit()
