"""Isolated regression fixtures; not imported or shipped by the application."""
import json
from pathlib import Path

from matching_core import db
from matching_core.config import CONFIG_DIR

DEMO_DIR = Path(__file__).parent / "fixtures" / "demo_data"


def init_db(path):
    db.init_db(path, seed=False)
    db.seed_jobs(path, [DEMO_DIR / "jobs.json"])
