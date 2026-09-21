---
name: image-editing
description: Crop, generate, and edit images with Magica crop_image and gpt_image_2. Use when the user wants a new image, an edit of an existing image, or a crop.
---

# Image editing

Load this skill when the user wants to generate, edit, or crop images.

## Tools

- `gpt_image_2` — create a new image from a prompt, or edit when `image_url` is provided.
- `crop_image` — crop a completed image. Provide `image_url` plus exactly one complete rectangle: `crop.{x,y,width,height}`, pixel `x/y/width/height`, or percent coordinates.

## Workflow

1. If the user attached an image, pass that URL into `gpt_image_2` (edit) or `crop_image`.
2. If they want a new image, call `gpt_image_2` with only a prompt.
3. You may chain tools: generate or edit first, then crop the result URL.
4. Do not invent crop coordinates. Ask or infer a complete rectangle.

See `examples.md` for input shapes.
