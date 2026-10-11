#!/usr/bin/env python3
"""Validate generated audio files, including all expected VoxCPM batch outputs."""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf


def check_audio(path: Path, sample_rate: int | None) -> dict:
    result = {"path": str(path.resolve()), "ok": False}
    try:
        with sf.SoundFile(path) as audio:
            if audio.frames == 0:
                raise ValueError("Audio has no frames")
            if sample_rate is not None and audio.samplerate != sample_rate:
                raise ValueError(
                    f"Expected {sample_rate} Hz, got {audio.samplerate} Hz"
                )
            peak = 0.0
            frames_read = 0
            for block in audio.blocks(blocksize=65536, dtype="float32", always_2d=True):
                if not np.isfinite(block).all():
                    raise ValueError("Audio contains NaN or infinite samples")
                frames_read += len(block)
                peak = max(peak, float(np.max(np.abs(block))))
            if frames_read != audio.frames:
                raise ValueError("Decoded frame count differs from file metadata")
            if peak == 0:
                raise ValueError("Audio is entirely silent")
            result.update(
                ok=True,
                sample_rate=audio.samplerate,
                channels=audio.channels,
                frames=frames_read,
                duration_seconds=round(frames_read / audio.samplerate, 3),
                peak=round(peak, 6),
            )
    except (OSError, RuntimeError, ValueError) as exc:
        result["error"] = str(exc)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="*", type=Path)
    parser.add_argument("--batch-input", type=Path, help="UTF-8 text, one nonblank line per output")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--sample-rate", type=int, help="Optional expected sample rate in Hz")
    args = parser.parse_args()

    if args.sample_rate is not None and args.sample_rate <= 0:
        parser.error("--sample-rate must be positive")
    if (args.batch_input is None) != (args.output_dir is None):
        parser.error("--batch-input and --output-dir must be provided together")
    if args.batch_input is not None:
        if args.files:
            parser.error("Use either explicit files or batch arguments")
        try:
            with args.batch_input.open(encoding="utf-8") as manifest:
                count = sum(bool(line.strip()) for line in manifest)
        except (OSError, UnicodeError) as exc:
            parser.error(str(exc))
        if count == 0:
            parser.error("Batch input has no nonblank lines")
        paths = [args.output_dir / f"output_{i:03d}.wav" for i in range(1, count + 1)]
    else:
        paths = args.files
        if not paths:
            parser.error("Provide audio files or a batch input and output directory")

    results = [check_audio(path, args.sample_rate) for path in paths]
    passed = sum(result["ok"] for result in results)
    print(json.dumps(
        {"ok": passed == len(results), "passed": passed, "expected": len(results), "files": results},
        ensure_ascii=False,
        indent=2,
    ))
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
