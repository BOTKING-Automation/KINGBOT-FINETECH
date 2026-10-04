#!/usr/bin/env python3
"""Render root entrypoint for KINGBOT ML signal service."""
from pathlib import Path
import runpy

runpy.run_path(str(Path(__file__).parent / "ml-signal-service" / "service.py"), run_name="__main__")
