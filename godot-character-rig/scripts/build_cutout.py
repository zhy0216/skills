#!/usr/bin/env python3
"""Build a Godot 4 cutout rest rig from calibrated PNG parts; never edit images."""

import argparse
import json
import math
from pathlib import Path
import re
import struct
import sys


class RigError(ValueError):
    pass


def vector(value, label, dimensions=False):
    if not isinstance(value, list) or len(value) != 2:
        raise RigError(f"{label}: expected [x, y]")
    for n in value:
        if type(n) not in (int, float) or not math.isfinite(n):
            raise RigError(f"{label}: coordinates must be finite numbers")
        if dimensions and (type(n) is not int or n <= 0):
            raise RigError(f"{label}: dimensions must be positive integers")
    return tuple(value)


def resource_path(project, value):
    if not isinstance(value, str) or not value.startswith("res://"):
        raise RigError(f"Expected a res:// project path: {value!r}")
    if any(c in value for c in "\n\r\x00\\"):
        raise RigError(f"Invalid resource path: {value!r}")
    path = (project / value[6:]).resolve()
    if not path.is_relative_to(project):
        raise RigError(f"Resource escapes the project: {value}")
    return path


def indexed(items, label):
    if not isinstance(items, list) or not items:
        raise RigError(f"{label}: expected a nonempty list")
    result = {}
    for item in items:
        if not isinstance(item, dict):
            raise RigError(f"{label}: each entry must be an object")
        item_id = item.get("id")
        if not isinstance(item_id, str) or not re.fullmatch(r"[a-z][a-z0-9_]*", item_id):
            raise RigError(f"{label}: invalid id {item_id!r}")
        if item_id in result:
            raise RigError(f"{label}: duplicate id {item_id}")
        result[item_id] = item
    return result


def png_size(path):
    with path.open("rb") as stream:
        header = stream.read(24)
    if len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise RigError(f"Not a PNG with an IHDR header: {path}")
    return struct.unpack(">II", header[16:24])


def validate(project, data):
    if not (project / "project.godot").is_file():
        raise RigError(f"No project.godot in {project}")
    if not isinstance(data, dict) or type(data.get("schema_version")) is not int or data["schema_version"] != 1:
        raise RigError("Expected a manifest object with schema_version: 1")
    name = data.get("name", "CharacterRig")
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        raise RigError("name must be a simple Godot node name")
    vector(data.get("canvas_size"), "canvas_size", dimensions=True)
    vector(data.get("origin"), "origin")
    source = data.get("source_image")
    if source is not None and not resource_path(project, source).is_file():
        raise RigError(f"Missing source image: {source}")
    bones = indexed(data.get("bones"), "bones")
    parts = indexed(data.get("parts"), "parts")
    roots = []
    for bone_id, bone in bones.items():
        vector(bone.get("pivot"), f"bones.{bone_id}.pivot")
        if "parent" not in bone:
            raise RigError(f"bones.{bone_id}: parent is required (null for root)")
        parent = bone["parent"]
        if parent is None:
            roots.append(bone_id)
        elif not isinstance(parent, str) or parent not in bones:
            raise RigError(f"bones.{bone_id}: unknown parent {parent!r}")
    if len(roots) != 1:
        raise RigError("bones must have exactly one root")
    ordered = []
    seen = set()
    while len(ordered) < len(bones):
        ready = [bone_id for bone_id, bone in bones.items()
                 if bone_id not in seen and (bone["parent"] is None or bone["parent"] in seen)]
        if not ready:
            raise RigError("Bone hierarchy has a cycle")
        ordered.extend(ready)
        seen.update(ready)
    for part_id, part in parts.items():
        bone_id = part.get("bone")
        if not isinstance(bone_id, str) or bone_id not in bones:
            raise RigError(f"parts.{part_id}: unknown bone {bone_id!r}")
        vector(part.get("image_origin"), f"parts.{part_id}.image_origin")
        dimensions = vector(part.get("size"), f"parts.{part_id}.size", dimensions=True)
        path = resource_path(project, part.get("texture"))
        if path.suffix.lower() != ".png" or not path.is_file():
            raise RigError(f"parts.{part_id}: missing PNG {path}")
        if png_size(path) != dimensions:
            raise RigError(f"parts.{part_id}: declared size does not match PNG dimensions")
        scale = part.get("texture_scale", 1)
        if type(scale) not in (int, float) or not math.isfinite(scale) or scale <= 0:
            raise RigError(f"parts.{part_id}: texture_scale must be a positive finite number")
        z_index = part.get("z_index")
        if type(z_index) is not int or not -4096 <= z_index <= 4096:
            raise RigError(f"parts.{part_id}: z_index must be an integer from -4096 to 4096")
        if part.get("method") not in ("extracted", "generated", "hybrid"):
            raise RigError(f"parts.{part_id}: method must be extracted, generated, or hybrid")
    return bones, parts, ordered


def quote(value):
    return json.dumps(value, ensure_ascii=False)


def number(value):
    return format(value, ".12g")


def v2(value):
    return f"Vector2({number(value[0])}, {number(value[1])})"


def subtract(a, b):
    return (a[0] - b[0], a[1] - b[1])


def build_scene(data, bones, parts, ordered):
    textures = list(dict.fromkeys(part["texture"] for part in parts.values()))
    texture_ids = {path: f"Texture_{i + 1}" for i, path in enumerate(textures)}
    lines = [f'[gd_scene load_steps={len(textures) + 3} format=3]', ""]
    for texture in textures:
        lines.append(f'[ext_resource type="Texture2D" path={quote(texture)} id={quote(texture_ids[texture])}]')
    lines += ["", '[sub_resource type="Animation" id="Animation_reset"]',
              'resource_name = "RESET"', "length = 0.001"]
    paths, offsets = {}, {}
    track = 0
    for bone_id in ordered:
        bone = bones[bone_id]
        parent = bone["parent"]
        parent_path = paths[parent] if parent is not None else "Skeleton2D"
        paths[bone_id] = f"{parent_path}/bone_{bone_id}"
        offsets[bone_id] = subtract(bone["pivot"], bones[parent]["pivot"]) if parent is not None else bone["pivot"]
        for prop, value in (("position", v2(offsets[bone_id])), ("rotation", "0.0"), ("scale", "Vector2(1, 1)")):
            lines += [f'tracks/{track}/type = "value"',
                      f'tracks/{track}/path = NodePath({quote(paths[bone_id] + ":" + prop)})',
                      f'tracks/{track}/interp = 1',
                      f'tracks/{track}/keys = {{',
                      '"times": PackedFloat32Array(0),',
                      '"transitions": PackedFloat32Array(1),',
                      '"update": 0,',
                      f'"values": [{value}]', "}"]
            track += 1
    lines += ["", '[sub_resource type="AnimationLibrary" id="AnimationLibrary_default"]',
              '_data = {', '&"RESET": SubResource("Animation_reset")', '}', "",
              f'[node name={quote(data.get("name", "CharacterRig"))} type="Node2D"]', "",
              '[node name="Skeleton2D" type="Skeleton2D" parent="."]',
              f'position = {v2([-n for n in data["origin"]])}']
    for bone_id in ordered:
        bone = bones[bone_id]
        parent = bone["parent"]
        parent_path = paths[parent] if parent is not None else "Skeleton2D"
        local = offsets[bone_id]
        children = [b for b in bones.values() if b["parent"] == bone_id]
        direction = subtract(children[0]["pivot"], bone["pivot"]) if children else (16, 0)
        length = max(1, math.hypot(*direction))
        angle = math.atan2(direction[1], direction[0])
        lines += ["", f'[node name={quote("bone_" + bone_id)} type="Bone2D" parent={quote(parent_path)}]',
                  f'position = {v2(local)}',
                  f'rest = Transform2D(1, 0, 0, 1, {number(local[0])}, {number(local[1])})',
                  'auto_calculate_length_and_angle = false',
                  f'length = {number(length)}', f'bone_angle = {number(angle)}']
    for part_id, part in parts.items():
        offset = subtract(part["image_origin"], bones[part["bone"]]["pivot"])
        scale = part.get("texture_scale", 1)
        lines += ["", f'[node name={quote("part_" + part_id)} type="Sprite2D" parent={quote(paths[part["bone"]])}]',
                  f'z_index = {part["z_index"]}', 'z_as_relative = false',
                  f'position = {v2(offset)}',
                  f'scale = {v2((scale, scale))}',
                  f'texture = ExtResource({quote(texture_ids[part["texture"]])})',
                  'centered = false']
    lines += ["", '[node name="AnimationPlayer" type="AnimationPlayer" parent="."]',
              'root_node = NodePath("..")', 'libraries = {',
              '&"": SubResource("AnimationLibrary_default")', '}', ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, required=True, help="Godot project directory")
    parser.add_argument("--manifest", type=Path, required=True, help="rig.json path")
    parser.add_argument("--output", help="New res://...tscn path; existing files are never overwritten")
    parser.add_argument("--check", action="store_true", help="Validate inputs without writing a scene")
    args = parser.parse_args()
    if not args.check and not args.output:
        parser.error("--output is required unless --check is used")
    if args.check and args.output:
        parser.error("Use either --check or --output")
    try:
        project = args.project.expanduser().resolve()
        data = json.loads(args.manifest.expanduser().read_text(encoding="utf-8"))
        bones, parts, ordered = validate(project, data)
        if args.check:
            print(f"Valid manifest: {len(bones)} bones, {len(parts)} parts. Visual checks are still required.")
            return 0
        output = resource_path(project, args.output)
        if output.suffix != ".tscn":
            raise RigError("--output must end in .tscn")
        scene = build_scene(data, bones, parts, ordered)
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("x", encoding="utf-8") as stream:
            stream.write(scene)
        print(f"Created {output} ({len(bones)} bones, {len(parts)} parts, RESET only)")
        return 0
    except (OSError, ValueError, TypeError, KeyError, OverflowError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
