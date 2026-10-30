#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "anthropic>=0.40.0",
#     "pydantic>=2.0.0",
# ]
# ///
"""
Generate course structure and scripts using AI.

Usage:
    uv run generate_course.py --topic "Your Topic" --lessons 5 --output course.json
"""

import argparse
import json
import os
import sys
from typing import Optional
from pydantic import BaseModel


class VisualCue(BaseModel):
    timestamp_seconds: float
    duration_seconds: float
    description: str
    type: str  # "broll" | "slide" | "graphic"


class Lesson(BaseModel):
    number: int
    title: str
    script: str
    key_points: list[str]
    visual_cues: list[VisualCue]
    estimated_duration_seconds: int


class Course(BaseModel):
    title: str
    description: str
    target_audience: str
    lessons: list[Lesson]
    total_duration_minutes: int
    style: str


def generate_course_structure(
    topic: str,
    num_lessons: int,
    duration_per_lesson: int,
    style: str,
    api_key: Optional[str] = None
) -> Course:
    """Generate course structure using Claude."""
    from anthropic import Anthropic
    
    key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise ValueError("ANTHROPIC_API_KEY required")
    
    client = Anthropic(api_key=key)
    
    prompt = f"""Create a detailed course structure for: "{topic}"

Requirements:
- {num_lessons} lessons
- Each lesson ~{duration_per_lesson} minutes when spoken
- Style: {style}
- Include visual cue points for B-roll and slides

For each lesson provide:
1. Title
2. Full narration script (conversational, engaging)
3. 3-5 key points
4. Visual cues with timestamps (where to show B-roll or slides)

Output as JSON matching this schema:
{{
  "title": "Course Title",
  "description": "One paragraph description",
  "target_audience": "Who this is for",
  "lessons": [
    {{
      "number": 1,
      "title": "Lesson Title",
      "script": "Full narration script...",
      "key_points": ["Point 1", "Point 2"],
      "visual_cues": [
        {{
          "timestamp_seconds": 15,
          "duration_seconds": 5,
          "description": "Show code example",
          "type": "slide"
        }},
        {{
          "timestamp_seconds": 45,
          "duration_seconds": 8,
          "description": "Motion graphic of data flowing",
          "type": "broll"
        }}
      ],
      "estimated_duration_seconds": {duration_per_lesson * 60}
    }}
  ],
  "total_duration_minutes": {num_lessons * duration_per_lesson},
  "style": "{style}"
}}

Make the scripts engaging and natural - they will be read by an AI avatar.
Include 3-5 visual cues per lesson at natural break points.
"""

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=8000,
        messages=[{"role": "user", "content": prompt}]
    )
    
    # Extract JSON from response
    text = response.content[0].text
    
    # Find JSON in response
    start = text.find('{')
    end = text.rfind('}') + 1
    if start == -1 or end == 0:
        raise ValueError("No JSON found in response")
    
    json_str = text[start:end]
    data = json.loads(json_str)
    
    return Course(**data)


def main():
    parser = argparse.ArgumentParser(description="Generate course structure")
    parser.add_argument("--topic", "-t", required=True, help="Course topic")
    parser.add_argument("--lessons", "-l", type=int, default=5, help="Number of lessons")
    parser.add_argument("--duration", "-d", type=int, default=3, help="Minutes per lesson")
    parser.add_argument("--style", "-s", default="professional", 
                       choices=["professional", "casual", "energetic"],
                       help="Presentation style")
    parser.add_argument("--output", "-o", required=True, help="Output JSON file")
    parser.add_argument("--api-key", help="Anthropic API key (or use ANTHROPIC_API_KEY env)")
    
    args = parser.parse_args()
    
    print(f"🎬 Generating course structure for: {args.topic}")
    print(f"   Lessons: {args.lessons}, Duration: ~{args.duration} min each, Style: {args.style}")
    
    try:
        course = generate_course_structure(
            topic=args.topic,
            num_lessons=args.lessons,
            duration_per_lesson=args.duration,
            style=args.style,
            api_key=args.api_key
        )
        
        # Save to file
        with open(args.output, 'w', encoding='utf-8') as f:
            json.dump(course.model_dump(), f, indent=2, ensure_ascii=False)
        
        print(f"\n✅ Course generated: {course.title}")
        print(f"   {len(course.lessons)} lessons, ~{course.total_duration_minutes} minutes total")
        print(f"   Saved to: {args.output}")
        
        # Summary
        print("\n📚 Lesson Overview:")
        for lesson in course.lessons:
            print(f"   {lesson.number}. {lesson.title} (~{lesson.estimated_duration_seconds//60} min)")
            
    except Exception as e:
        print(f"❌ Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
