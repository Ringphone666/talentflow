"""AI面试与平台公共数据（账号、审计）的 SQLite 存储。

人岗匹配沿用 ``matching_core.db`` 管理的独立库文件；两个库通过岗位库、人员库的编号关联。
"""
import os
from pathlib import Path

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .settings import INTERVIEW_DATA_DIR

DATA_DIR = INTERVIEW_DATA_DIR
DATA_DIR.mkdir(parents=True, exist_ok=True)
DATABASE_PATH = Path(os.getenv("TALENTFLOW_DATABASE_PATH", str(DATA_DIR / "talentflow_interview.db"))).resolve()
DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
DATABASE_URL = f"sqlite:///{DATABASE_PATH.as_posix()}"


class Base(DeclarativeBase):
    pass


engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def upgrade_schema() -> list[str]:
    """建表并为旧库补齐新增列；只做增量，不删除或改写已有数据。"""
    Base.metadata.create_all(bind=engine)
    inspector = inspect(engine)
    added: list[str] = []
    with engine.begin() as connection:
        for table in Base.metadata.sorted_tables:
            existing = {column["name"] for column in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name in existing:
                    continue
                ddl = f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {column.type.compile(engine.dialect)}'
                default = column.default.arg if column.default is not None and column.default.is_scalar else None
                if isinstance(default, bool):
                    ddl += f" DEFAULT {int(default)}"
                elif isinstance(default, (int, float)):
                    ddl += f" DEFAULT {default}"
                elif isinstance(default, str):
                    ddl += " DEFAULT '" + default.replace("'", "''") + "'"
                connection.execute(text(ddl))
                added.append(f"{table.name}.{column.name}")
    return added
