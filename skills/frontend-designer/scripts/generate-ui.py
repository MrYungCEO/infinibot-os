#!/usr/bin/env python3
"""
UI Generation Helper Script
Uses Gemini CLI to generate frontend components

Usage:
    python generate-ui.py --type hero --style modern --output hero.html
    python generate-ui.py --type component --prompt "pricing table with 3 tiers"
    python generate-ui.py --screenshot input.png --output recreated.html
"""

import argparse
import subprocess
import sys
import json
from pathlib import Path

# Component type templates
TEMPLATES = {
    "hero": """Generate a hero section with:
- Full-width background with gradient
- Centered headline and subtitle
- Two CTA buttons (primary and secondary)
- Responsive design (mobile-first)
- Tailwind CSS classes
Output only the HTML code.""",

    "features": """Generate a features section with:
- Section heading and subheading
- 3-column grid of feature cards
- Each card: icon placeholder, title, description
- Hover effects on cards
- Responsive: 1 column on mobile, 3 on desktop
- Tailwind CSS classes
Output only the HTML code.""",

    "pricing": """Generate a pricing table section with:
- 3 pricing tiers (Basic, Pro, Enterprise)
- Monthly prices with feature lists
- Highlight the middle "Pro" tier as recommended
- CTA buttons for each tier
- Responsive layout
- Tailwind CSS classes
Output only the HTML code.""",

    "testimonials": """Generate a testimonials section with:
- Section heading
- 3 testimonial cards in a row
- Each card: quote, author name, role, avatar placeholder
- Clean design with subtle shadows
- Responsive grid
- Tailwind CSS classes
Output only the HTML code.""",

    "cta": """Generate a CTA banner section with:
- Full-width gradient background
- Compelling headline
- Supporting text
- Single primary CTA button
- Centered layout
- Tailwind CSS classes
Output only the HTML code.""",

    "footer": """Generate a footer with:
- Logo and company description
- 4 columns of links (Product, Company, Resources, Legal)
- Social media icons row
- Copyright notice
- Dark background theme
- Responsive grid
- Tailwind CSS classes
Output only the HTML code.""",

    "nav": """Generate a navigation header with:
- Logo on left
- Nav links in center
- CTA button on right
- Mobile hamburger menu
- Sticky positioning
- Backdrop blur effect
- Tailwind CSS classes
Output only the HTML code.""",

    "form": """Generate a contact form with:
- Name, Email, Message fields
- Submit button with loading state
- Field validation styling
- Clean label positioning
- Tailwind CSS classes
Output only the HTML code.""",

    "card": """Generate a card component with:
- Image placeholder at top
- Title and description
- Action button or link
- Hover shadow effect
- Rounded corners
- Tailwind CSS classes
Output only the HTML code."""
}

STYLE_MODIFIERS = {
    "modern": "Use a modern, clean aesthetic with generous whitespace and subtle shadows.",
    "bold": "Use bold colors, strong typography, and high contrast.",
    "minimal": "Use a minimalist approach with lots of whitespace and simple elements.",
    "playful": "Use rounded corners, fun colors, and friendly styling.",
    "corporate": "Use a professional, trustworthy design with structured layout.",
    "dark": "Use a dark theme with appropriate contrast ratios."
}


def run_gemini(prompt: str, output_format: str = None) -> str:
    """Run Gemini CLI with the given prompt"""
    cmd = ["gemini", "--model", "gemini-2.5-pro"]
    
    if output_format:
        cmd.extend(["--output-format", output_format])
    
    cmd.append(prompt)
    
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=True
        )
        return result.stdout
    except subprocess.CalledProcessError as e:
        print(f"Error running Gemini: {e.stderr}", file=sys.stderr)
        sys.exit(1)
    except FileNotFoundError:
        print("Error: Gemini CLI not found. Install with: brew install gemini-cli", file=sys.stderr)
        sys.exit(1)


def generate_component(component_type: str, style: str = None, custom_prompt: str = None) -> str:
    """Generate a UI component"""
    
    if custom_prompt:
        prompt = f"Generate the following UI component using HTML and Tailwind CSS:\n{custom_prompt}"
    elif component_type in TEMPLATES:
        prompt = TEMPLATES[component_type]
    else:
        print(f"Unknown component type: {component_type}", file=sys.stderr)
        print(f"Available types: {', '.join(TEMPLATES.keys())}", file=sys.stderr)
        sys.exit(1)
    
    if style and style in STYLE_MODIFIERS:
        prompt += f"\n\nStyle: {STYLE_MODIFIERS[style]}"
    
    return run_gemini(prompt)


def screenshot_to_code(image_path: str) -> str:
    """Convert a UI screenshot to code"""
    prompt = f"""Analyze this UI screenshot and generate HTML + Tailwind CSS code to recreate it accurately.
Include:
- All visible layout structure
- Typography styling
- Colors and spacing
- Interactive elements
Output only the complete HTML code."""
    
    # Note: Gemini CLI image input may vary
    # This assumes the CLI accepts stdin for images
    try:
        with open(image_path, 'rb') as f:
            result = subprocess.run(
                ["gemini", "--model", "gemini-2.5-pro", prompt],
                stdin=f,
                capture_output=True,
                text=True,
                check=True
            )
        return result.stdout
    except Exception as e:
        print(f"Error processing screenshot: {e}", file=sys.stderr)
        sys.exit(1)


def generate_design_system(brand_name: str, industry: str, vibe: str) -> str:
    """Generate a complete design system"""
    prompt = f"""Generate a comprehensive design system for:
Brand: {brand_name}
Industry: {industry}
Vibe: {vibe}

Output JSON with:
1. colors (primary, secondary, neutral, semantic palettes)
2. typography (fonts, scale, weights)
3. spacing (scale)
4. borderRadius (scale)
5. shadows (scale)

Also provide CSS custom properties version."""
    
    return run_gemini(prompt, output_format="json")


def main():
    parser = argparse.ArgumentParser(description="Generate UI components with Gemini")
    parser.add_argument("--type", "-t", choices=list(TEMPLATES.keys()),
                       help="Component type to generate")
    parser.add_argument("--style", "-s", choices=list(STYLE_MODIFIERS.keys()),
                       help="Style modifier")
    parser.add_argument("--prompt", "-p",
                       help="Custom prompt for component generation")
    parser.add_argument("--screenshot",
                       help="Path to screenshot for UI recreation")
    parser.add_argument("--design-system", action="store_true",
                       help="Generate a design system")
    parser.add_argument("--brand", help="Brand name for design system")
    parser.add_argument("--industry", help="Industry for design system")
    parser.add_argument("--vibe", help="Vibe/personality for design system")
    parser.add_argument("--output", "-o",
                       help="Output file path")
    parser.add_argument("--list", "-l", action="store_true",
                       help="List available component types")
    
    args = parser.parse_args()
    
    if args.list:
        print("Available component types:")
        for name in TEMPLATES:
            print(f"  - {name}")
        return
    
    result = None
    
    if args.screenshot:
        result = screenshot_to_code(args.screenshot)
    elif args.design_system:
        if not all([args.brand, args.industry, args.vibe]):
            print("Design system requires --brand, --industry, and --vibe", file=sys.stderr)
            sys.exit(1)
        result = generate_design_system(args.brand, args.industry, args.vibe)
    elif args.type or args.prompt:
        result = generate_component(args.type, args.style, args.prompt)
    else:
        parser.print_help()
        return
    
    if args.output:
        Path(args.output).write_text(result)
        print(f"Output written to: {args.output}")
    else:
        print(result)


if __name__ == "__main__":
    main()
