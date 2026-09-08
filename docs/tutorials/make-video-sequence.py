#!/usr/bin/env python3
"""Create the local absolute-path input for the optional macOS MP4 encoder."""
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
manifest = json.loads((root / "docs/media/codex-quota-monitor-cli-tutorial.manifest.json").read_text())
frames = sorted((root / manifest["media"]["frames"]).glob("frame-*.png"))
durations = manifest["media"]["frameDurationsSeconds"]
if len(frames) != len(durations):
    raise SystemExit("Frame count does not match durations")
sequence = {"frames": [{"path": str(p), "duration": d} for p, d in zip(frames, durations)]}
Path(sys.argv[1]).write_text(json.dumps(sequence, indent=2) + "\n")
