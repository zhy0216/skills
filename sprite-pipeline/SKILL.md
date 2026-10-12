---
name: sprite-pipeline
description: Generate and edit 2D game sprites and animation sheets with Codex's built-in image generation, then normalize frame anchors, atlas metadata, and in-game previews. Use for sprite sheets and frame-based animation, not skeletal rigging.
---

# Sprite Pipeline

Use this skill for production 2D sprites and frame-based animation, not for generic illustrations. Preserve approved character identity, palette, scale, and anchor conventions already present in the game.

## Image Generation in Codex

Read the installed `imagegen` skill before generating or editing artwork. Use Codex's built-in `image_gen` tool (currently `image_gen.imagegen`) by default. This path does not require `OPENAI_API_KEY` or an OhMyGame installation. Follow the current tool schema; do not pin a model ID or invent API-only parameters for the built-in tool.

- Inspect local reference images with `view_image` before use. Label each input's role: character identity, approved animation frame, style reference, or edit target.
- When all input images have local paths, use `referenced_image_paths`. Otherwise use the smallest `num_last_images_to_include` that includes the required conversation images, up to the tool's limit. Never combine these mechanisms. Omit both for a new image without references.
- For transparent sprites, set `transparent_background: true` and request actual alpha, without a checkerboard, scenery, labels, or drawn grid lines. Preserve existing transparency during edits.
- Generate one coherent sheet per requested action/direction when practical. Include the approved character reference in subsequent sheets; independent frame generation can drift in identity and scale.
- Put action, facing, frame count, rows/columns, reading order, contact baseline, padding, and intended cell size in the prompt. These are requested layout constraints, not guarantees of exact output dimensions.
- For project assets, copy the selected generated output into the user's destination or the project's asset directory, following `imagegen` save-path guidance. Use the actual returned output path; do not invent a save-path tool argument. Preserve existing assets unless replacement was requested.
- If the built-in tool is unavailable or fails, explain the limitation. Use the `imagegen` CLI/API fallback only when the user explicitly chooses it; do not switch providers or request API credentials for the normal built-in workflow.

## Workflow

1. Inspect the runtime's frame size, facing convention, anchor, palette, manifest, and animation definitions.
2. Start from an approved in-game frame when one exists. Do not regenerate unrelated sprite sets for a focused change.
3. Define action, direction, frame count, slot layout, timing, loop behavior, and transparency before generation.
4. Generate or edit the whole strip or sheet with the built-in tool using the constraints above.
5. Inspect the actual output dimensions, frame count, cell boundaries, alpha, scale, and contact baseline. Correct a defective sheet with a targeted image edit; do not mark prompt requirements as verified merely because they were requested.
6. Normalize frame regions to one cell size, shared scale, and shared anchor, usually bottom-center. Prefer runtime atlas regions so the generated source pixels stay intact. Derive coordinates from the inspected output, not assumed dimensions. Pixel edits use the image tool unless the user requests another method; do not use Python image editing by default.
7. Update the asset manifest and animation metadata through stable keys when game integration is requested. Record frame order, cell dimensions or regions, anchor, timing, and loop behavior using the project's existing format.
8. Inspect a looping preview at actual game scale, including the last-to-first transition. For asset-only requests, deliver the sheet and needed layout/timing information without creating an unrelated game project.

If reference identity, frame layout, or transparency cannot be preserved reliably, state the specific remaining limitation. If repeated targeted edits do not improve the result, keep the best version and propose a simpler layout or fewer frames rather than retrying indefinitely.

## Generation Invariants

- same character identity, silhouette, outfit proportions, and palette family
- consistent facing and camera angle
- transparent background with no scenery, labels, or poster composition
- exact frame count and grid layout
- readable action silhouettes at gameplay scale
- stable feet or contact point across frames

## Quality Gates

- no frame-to-frame scale or anchor drift
- no clipped effects or unintended opaque background
- idle and transition frames connect without a visible jump
- timing matches the gameplay event
- manifest, preload, and runtime animation names agree

For Godot runtime integration, read the installed [godot-2d-animation skill](../game-dev/godot-2d-animation/SKILL.md). For other engines, use the project's existing atlas loader and animation conventions; no Phaser or OhMyGame-specific skill is required. Verify playback with available project tools and distinguish a static sheet inspection from an actual animation preview.

Report final asset paths, layout/timing metadata, generation mode and prompt, and any remaining visual issues. This skill is adapted from [OhMyGame's sprite-pipeline](https://github.com/WhiteTowerAI/ohmygame/blob/main/plugins/web-game-studio/skills/sprite-pipeline/SKILL.md).
