#!/usr/bin/env python3
"""Render root entrypoint for KINGBOT ML signal service."""
from pathlib import Path
import runpy
import sys

service_dir = Path(__file__).parent / "ml-signal-service"
# run_path executes the target as __main__ but does not add its parent directory
# to sys.path. Add it explicitly so service.py can import model_store.py.
sys.path.insert(0, str(service_dir))
runpy.run_path(str(service_dir / "service.py"), run_name="__main__")
