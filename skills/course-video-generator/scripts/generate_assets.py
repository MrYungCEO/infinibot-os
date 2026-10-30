#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "httpx>=0.27.0",
#     "google-genai>=1.0.0",
#     "pillow>=10.0.0",
# ]
# ///
"""
Generate all course assets: HeyGen videos, Veo 3 B-roll, Nano Banana slides.

Usage:
    uv run generate_assets.py --input course.json --output assets/
"""

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional
import httpx


# ============== HeyGen API ==============

HEYGEN_API_BASE = "https://api.heygen.com"

async def create_heygen_video(
    client: httpx.AsyncClient,
    script: str,
    voice_id: str,
    avatar_id: Optional[str] = None,
    api_key: Optional[str] = None
) -> str:
    """Create a HeyGen avatar video and return video_id."""
    key = api_key or os.environ.get("HEYGEN_API_KEY")
    if not key:
        raise ValueError("HEYGEN_API_KEY required")
    
    headers = {"X-Api-Key": key, "Content-Type": "application/json"}
    
    # Use a stock avatar if none specified
    if not avatar_id:
        avatar_id = "Daisy-inskirt-20220818"  # Default stock avatar
    
    payload = {
        "video_inputs": [{
            "character": {
                "type": "avatar",
                "avatar_id": avatar_id,
                "avatar_style": "normal"
            },
            "voice": {
                "type": "text",
                "input_text": script,
                "voice_id": voice_id
            }
        }],
        "dimension": {"width": 1920, "height": 1080}
    }
    
    resp = await client.post(
        f"{HEYGEN_API_BASE}/v2/video/generate",
        headers=headers,
        json=payload,
        timeout=60
    )
    resp.raise_for_status()
    data = resp.json()
    
    return data["data"]["video_id"]


async def poll_heygen_video(
    client: httpx.AsyncClient,
    video_id: str,
    api_key: Optional[str] = None,
    max_wait: int = 600
) -> str:
    """Poll for HeyGen video completion and return download URL."""
    key = api_key or os.environ.get("HEYGEN_API_KEY")
    headers = {"X-Api-Key": key}
    
    start = time.time()
    while time.time() - start < max_wait:
        resp = await client.get(
            f"{HEYGEN_API_BASE}/v1/video_status.get",
            headers=headers,
            params={"video_id": video_id},
            timeout=30
        )
        resp.raise_for_status()
        data = resp.json()["data"]
        
        status = data.get("status")
        if status == "completed":
            return data["video_url"]
        elif status == "failed":
            raise Exception(f"HeyGen video failed: {data.get('error')}")
        
        await asyncio.sleep(10)
    
    raise TimeoutError(f"HeyGen video {video_id} timed out after {max_wait}s")


async def download_file(client: httpx.AsyncClient, url: str, path: Path):
    """Download a file from URL."""
    resp = await client.get(url, timeout=120, follow_redirects=True)
    resp.raise_for_status()
    path.write_bytes(resp.content)


# ============== Veo 3 API ==============

async def generate_veo3_video(
    prompt: str,
    output_path: Path,
    duration: int = 6,
    api_key: Optional[str] = None
):
    """Generate a Veo 3 motion graphics clip."""
    from google import genai
    from google.genai import types
    
    key = api_key or os.environ.get("GEMINI_API_KEY")
    if not key:
        raise ValueError("GEMINI_API_KEY required")
    
    client = genai.Client(api_key=key)
    
    # Generate video
    operation = client.models.generate_videos(
        model="veo-2.0-generate-001",
        prompt=prompt,
        config=types.GenerateVideosConfig(
            aspect_ratio="16:9",
            number_of_videos=1,
            duration_seconds=duration,
            person_generation="dont_allow"
        )
    )
    
    # Wait for completion
    while not operation.done:
        await asyncio.sleep(5)
        operation = client.operations.get(operation)
    
    # Download video
    video = operation.result.generated_videos[0]
    video_data = client.files.download(file=video.video)
    output_path.write_bytes(video_data)


# ============== Nano Banana Pro ==============

async def generate_slide_image(
    prompt: str,
    output_path: Path,
    api_key: Optional[str] = None
):
    """Generate a slide/graphic using Gemini (Nano Banana Pro)."""
    from google import genai
    from google.genai import types
    from PIL import Image
    import io
    
    key = api_key or os.environ.get("GEMINI_API_KEY")
    if not key:
        raise ValueError("GEMINI_API_KEY required")
    
    client = genai.Client(api_key=key)
    
    # Generate image
    response = client.models.generate_images(
        model="imagen-3.0-generate-002",
        prompt=prompt,
        config=types.GenerateImagesConfig(
            number_of_images=1,
            aspect_ratio="16:9"
        )
    )
    
    # Save image
    image = response.generated_images[0]
    img = Image.open(io.BytesIO(image.image.image_bytes))
    img.save(output_path)


# ============== Main Orchestrator ==============

async def generate_lesson_assets(
    lesson: dict,
    output_dir: Path,
    voice_id: str,
    avatar_id: Optional[str],
    skip_avatar: bool,
    heygen_key: str,
    gemini_key: str
):
    """Generate all assets for a single lesson."""
    lesson_num = lesson["number"]
    lesson_dir = output_dir / f"lesson_{lesson_num:02d}"
    lesson_dir.mkdir(parents=True, exist_ok=True)
    
    async with httpx.AsyncClient() as client:
        tasks = []
        
        # 1. HeyGen Avatar Video
        if not skip_avatar:
            print(f"   📹 Generating avatar video for lesson {lesson_num}...")
            video_id = await create_heygen_video(
                client=client,
                script=lesson["script"],
                voice_id=voice_id,
                avatar_id=avatar_id,
                api_key=heygen_key
            )
            
            # Poll and download
            video_url = await poll_heygen_video(client, video_id, heygen_key)
            avatar_path = lesson_dir / "avatar.mp4"
            await download_file(client, video_url, avatar_path)
            print(f"   ✅ Avatar video saved: {avatar_path}")
        
        # 2. Veo 3 B-roll clips
        broll_cues = [c for c in lesson["visual_cues"] if c["type"] == "broll"]
        for i, cue in enumerate(broll_cues):
            print(f"   🎬 Generating B-roll {i+1}/{len(broll_cues)}: {cue['description'][:50]}...")
            broll_path = lesson_dir / f"broll_{i:02d}.mp4"
            await generate_veo3_video(
                prompt=f"Cinematic motion graphic: {cue['description']}. Professional, clean, modern style. No text.",
                output_path=broll_path,
                duration=min(int(cue["duration_seconds"]), 8),
                api_key=gemini_key
            )
            print(f"   ✅ B-roll saved: {broll_path}")
        
        # 3. Slide graphics
        slide_cues = [c for c in lesson["visual_cues"] if c["type"] in ("slide", "graphic")]
        for i, cue in enumerate(slide_cues):
            print(f"   🖼️ Generating slide {i+1}/{len(slide_cues)}: {cue['description'][:50]}...")
            slide_path = lesson_dir / f"slide_{i:02d}.png"
            await generate_slide_image(
                prompt=f"Professional presentation slide: {cue['description']}. Clean, modern design, minimal text, high contrast, 16:9 aspect ratio.",
                output_path=slide_path,
                api_key=gemini_key
            )
            print(f"   ✅ Slide saved: {slide_path}")
    
    # Save lesson metadata
    meta_path = lesson_dir / "meta.json"
    meta_path.write_text(json.dumps({
        "lesson_number": lesson_num,
        "title": lesson["title"],
        "visual_cues": lesson["visual_cues"],
        "duration_seconds": lesson["estimated_duration_seconds"]
    }, indent=2))
    
    return lesson_dir


async def main_async(args):
    # Load course data
    with open(args.input, 'r', encoding='utf-8') as f:
        course = json.load(f)
    
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    heygen_key = args.heygen_key or os.environ.get("HEYGEN_API_KEY")
    gemini_key = args.gemini_key or os.environ.get("GEMINI_API_KEY")
    
    print(f"\n🎬 Generating assets for: {course['title']}")
    print(f"   {len(course['lessons'])} lessons to process\n")
    
    for lesson in course["lessons"]:
        print(f"\n📚 Lesson {lesson['number']}: {lesson['title']}")
        await generate_lesson_assets(
            lesson=lesson,
            output_dir=output_dir,
            voice_id=args.voice,
            avatar_id=args.avatar,
            skip_avatar=args.skip_avatar,
            heygen_key=heygen_key,
            gemini_key=gemini_key
        )
    
    # Save course manifest
    manifest = {
        "title": course["title"],
        "lessons": [f"lesson_{l['number']:02d}" for l in course["lessons"]],
        "total_duration_minutes": course["total_duration_minutes"]
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    
    print(f"\n✅ All assets generated in: {output_dir}")
    print(f"   Run assemble_video.py to create final video")


def main():
    parser = argparse.ArgumentParser(description="Generate course assets")
    parser.add_argument("--input", "-i", required=True, help="Course JSON from generate_course.py")
    parser.add_argument("--output", "-o", required=True, help="Output directory")
    parser.add_argument("--voice", "-v", default="1776ddbd05374fa480e92f0297bbc67e",
                       help="HeyGen voice ID (default: Melissa - Friendly)")
    parser.add_argument("--avatar", "-a", help="HeyGen avatar ID (default: stock)")
    parser.add_argument("--skip-avatar", action="store_true", help="Skip HeyGen, voice-only mode")
    parser.add_argument("--heygen-key", help="HeyGen API key")
    parser.add_argument("--gemini-key", help="Gemini API key")
    
    args = parser.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
