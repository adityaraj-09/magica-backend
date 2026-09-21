---
name: video-merge
description: Concatenate 2–100 videos in order with Magica merge_videos. Use when the user wants a single video from multiple clips.
---

# Merge videos

Load this skill when the user wants to join clips into one video.

## Tool

`merge_videos`

- `video_urls`: 2–100 HTTPS URLs, **preserved in the given order**
- `transition`: `none` (default), `fade`, or `dissolve`

## Workflow

1. Collect every clip URL from the user message or attachments.
2. Keep the user's order. Do not sort or shuffle.
3. Call `merge_videos` once with the full list.
4. Render the returned `video_url` as a generated asset.
