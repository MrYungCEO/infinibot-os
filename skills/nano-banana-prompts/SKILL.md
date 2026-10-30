# Nano Banana Prompt Engineering

Master image generation and editing with Google's Nano Banana (Gemini Image) models. 15 proven techniques for consistent, controllable, high-quality outputs.

## Prerequisites
- Understanding of image generation concepts (prompts, seeds, CFG scale)
- Access to Nano Banana/Gemini Image via AI Studio, API, or platform (Leonardo, etc.)

## Technique 1: Structured Prompt Hierarchy

Nano Banana weights prompt elements by order. Structure from most to least important:

```
Subject → Action → Setting → Style/Medium → Composition → Lighting → Details → Constraints
```

**Template:**
```
[Subject: who/what, count, traits, materials]
[Action: what they're doing, relationships]
[Setting: place, time, weather, environment]
[Style/Medium: photo/illustration/3D/watercolor/pixel, realism level]
[Composition: close/medium/wide shot, angle, lens, depth of field]
[Lighting/Color: soft/hard light, backlight, warm/cool, film grading]
[Quality/Details: sharpness, texture, mood]
[Constraints: no text, no watermark, no extra limbs]
```

**Example:**
```
A woman in a light trench coat standing on a rainy city street, 
wet pavement reflections, neon signs softly blurred in the distance. 
Realistic photography, 35mm lens, medium shot, shallow depth of field, 
nighttime, cool color palette, detailed skin texture, clean frame. 
No text, no watermarks, no extra people.
```

## Technique 2: Concrete Over Vague

❌ **Vague:** "better lighting" "more premium" "make it pop"
✅ **Concrete:** "soft golden hour backlight, 35mm lens, shallow depth of field, warm/cool contrast"

| Instead of | Use |
|------------|-----|
| "better quality" | "sharp focus, detailed textures, 4K resolution" |
| "nice colors" | "muted earth tones with teal shadows and warm highlights" |
| "dramatic" | "low angle shot, hard side lighting, high contrast shadows" |

## Technique 3: Character Consistency with Named References

Upload reference images and assign distinct names to maintain consistency across scenes.

```
"Keep the character Alex consistent throughout: Alex is a woman with 
shoulder-length auburn hair, wearing a vintage leather jacket and 
wire-rimmed glasses. Show Alex sitting at a café table, then Alex 
standing in a park, then Alex walking through a marketplace. 
Maintain the same clothing and hairstyle in each scene."
```

**Best practice:** Create a "character card" - a fixed description you reuse:
```
Alex: woman, shoulder-length auburn hair, green eyes, vintage leather jacket, 
wire-rimmed glasses, silver pendant necklace, fair skin with freckles.
```

## Technique 4: The Keep/Change Method (Image Editing)

When editing existing images, be explicit about what must stay and what must change.

**Template:**
```
Keep: [what must not change - face, pose, lighting direction, composition]
Change: [what to modify - background, add object, style transfer]
How: [style/strength/direction]
Constraints: [avoid side effects]
```

**Example - Change Background:**
```
Keep the person's facial features, hairstyle, pose, and outfit unchanged, 
and keep the original composition and light direction. Replace the background 
with a seaside boardwalk at dusk, warm sunset tones with slight backlight, 
and soft reflections on the ocean in the distance. Do not change the expression. 
No text or watermarks.
```

**Example - Add Object:**
```
Keep the person and original scene unchanged. Add a small desk lamp on 
the right side of the table: metal body, matte white lampshade, soft warm glow. 
Keep the original perspective and depth of field. Make the lamp shadow direction 
consistent with the existing light source. Do not block the main subject.
```

**Example - Stylize:**
```
Keep the layout of the person and the scene unchanged. Convert the image 
into a watercolor illustration: soft bleeding edges, paper texture, gentle washes. 
Colors should be brighter but not oversaturated. Do not add new elements. No text.
```

## Technique 5: Batch Generation for Exploration

Generate multiple variations at once to compare ideas side-by-side.

```
"Generate three distinct variations of a cyberpunk character portrait:
1. Neon-drenched street scene with heavy atmosphere
2. Clean corporate environment with harsh fluorescent lighting
3. Underground club with red ambient lighting and smoke"
```

For story sequences:
```
"Generate a 4-panel comic sequence showing the same character starting 
their day: 1) waking up, 2) making coffee, 3) leaving apartment, 
4) walking to work. Keep character consistency across all panels."
```

## Technique 6: Precise Text Rendering

Enclose desired text in quotes and specify typography style.

```
A vintage poster with the text "HAPPY BIRTHDAY" in bold, distressed 
sans-serif typography, cream-colored letters on deep navy background, 
letterpress texture, centered composition. No other text.
```

```
Neon signage showing "OPEN 24 HOURS" in bright pink cursive script, 
glowing against a dark brick wall, rain-slicked reflections on the pavement. 
Clean typography, no distortion.
```

## Technique 7: Aspect Ratio & Format Specification

Prompt for specific aspect ratios and formats upfront.

| Use Case | Aspect Ratio | Prompt Addendum |
|----------|--------------|-----------------|
| Social post (portrait) | 9:16 | "vertical social post format" |
| Social post (square) | 1:1 | "square Instagram format" |
| Wallpaper | 16:9 | "widescreen desktop backdrop" |
| Print | 4:3 | "standard photo print format" |
| Banner | 3:1 | "wide banner format" |

```
A serene mountain landscape at sunrise, mist rolling through valleys, 
snow-capped peaks. Cinematic widescreen backdrop, 16:9 aspect ratio, 
suitable for desktop wallpaper. Atmospheric perspective, subtle color grading.
```

## Technique 8: Camera & Film Language

Use photography/film terminology for precise control.

**Lens specifications:**
- "35mm lens" - natural perspective, documentary feel
- "85mm lens" - portrait, shallow depth of field
- "14mm wide-angle" - expansive, slight distortion
- "100mm macro" - extreme close-up detail

**Camera angles:**
- "low angle shot" - heroic, imposing
- "high angle shot" - vulnerable, overview
- "Dutch angle" - tense, uneasy
- "eye level" - neutral, conversational

**Film techniques:**
```
Dutch angle shot, shallow depth of field, anamorphic lens flares, 
cinematic color grading with teal shadows and warm highlights, 
35mm film grain texture, rule of thirds composition.
```

## Technique 9: Style Anchoring & Modifiers

Be specific about artistic style to steer away from generic outputs.

**Medium + Style combinations:**
| Medium | Style Modifiers |
|--------|-----------------|
| Photography | "editorial fashion", "documentary", "cinematic", "lomography" |
| Illustration | "Japanese flat illustration", "art nouveau", "vintage travel poster" |
| 3D | "octane render", "claymation", "low-poly", "hyperrealistic CGI" |
| Traditional | "watercolor with visible brushstrokes", "charcoal sketch", "oil painting" |

```
Clean Japanese flat illustration style, consistent line weight, 
fresh color palette with lots of negative space, not photorealistic.
```

```
Art nouveau poster style, flowing organic lines, muted gold and 
sage green palette, Alphonse Mucha influence, decorative border elements.
```

## Technique 10: Lighting as Narrative Tool

Specify lighting to control mood and focus.

**Quality of light:**
- "soft diffused lighting" - gentle, flattering
- "hard directional lighting" - dramatic shadows
- "volumetric god rays" - atmospheric, ethereal
- "neon backlighting" - cyberpunk, modern

**Time of day:**
- "golden hour" - warm, nostalgic
- "blue hour" - cool, mysterious
- "high noon" - harsh, clinical
- "magic hour sunset" - romantic, cinematic

```
Dramatic side lighting from tall windows, long shadows across the floor, 
volumetric dust particles visible in light beams, cinematic Rembrandt 
lighting on the subject's face, film noir atmosphere.
```

## Technique 11: Constraint-Based Refinement

Use negative constraints to eliminate common generation issues.

**Essential constraints:**
```
No text, no watermark, no extra limbs, no deformed hands, 
no heavy blur, no oversaturation, no cartoon style.
```

**Specificity constraints:**
```
Clean white background, no clutter, no additional objects, 
no pattern interference, no vignetting.
```

**Quality constraints:**
```
No jpeg artifacts, no oversharpening, no motion blur, 
no chromatic aberration, clean edges.
```

## Technique 12: Iterative Refinement Workflow

Start simple, lock the direction, then add detail.

**Step 1 - Direction:** 
```
A cyberpunk mercenary character portrait.
```
(Review: Good direction, good aesthetic)

**Step 2 - Detail:** 
```
A cyberpunk mercenary in tactical gear, neon city background, 
cinematic lighting, 85mm portrait lens, shallow depth of field.
```
(Review: Good, but needs more character)

**Step 3 - Polish:** 
```
A cyberpunk mercenary with visible cybernetic implants, heavy tactical 
gear with worn leather textures, standing on a rain-slicked rooftop at 
blue hour, neon signs reflecting in puddles behind. Cinematic portrait, 
85mm lens, shallow depth of field, volumetric fog, teal and orange color 
grading. Sharp focus on eyes, detailed skin textures. No text, no extra limbs.
```

**Rule:** Change only 1-2 things between iterations.

## Technique 13: Visual Knowledge & Infographics

Leverage the model's knowledge for structured visual content.

**Timelines:**
```
Create a timeline infographic showing the evolution of personal 
computing from 1975 to 2025. Include: 1975 (Altair 8800, kit computer), 
1984 (Macintosh, GUI revolution), 2007 (iPhone, mobile era), 2023 (AI integration). 
Clean modern design, horizontal layout, distinctive icons for each era, 
color-coded by decade. Infographic style, data visualization aesthetic.
```

**Processes:**
```
Create a flowchart showing the coffee brewing process: grind beans → 
heat water to 200°F → bloom grounds → pour in circles → draw down → serve. 
Clean diagram style, numbered steps, interconnected nodes, minimalist icons.
```

**Comparisons:**
```
Create a side-by-side comparison diagram: left half showing traditional 
farming methods with hand tools, right half showing precision agriculture 
with drones and sensors. Split layout with clear labels, consistent 
illustration style, educational infographic aesthetic.
```

## Technique 14: Multi-Act Story Sequences

Create visual narratives with consistent characters/settings.

**3-Act structure:**
```
Generate a 3-panel story sequence with consistent characters:
Act 1 - The Setup: Maya stands at the edge of a dark forest holding a lantern.
Act 2 - The Conflict: Maya encounters a mysterious figure among twisted trees.
Act 3 - The Resolution: Maya and the figure walk together toward a distant light.

Maintain Maya's appearance throughout: brown curls, green cloak, leather boots.
Consistent dark fairytale atmosphere across all panels. Illustrated storybook style.
```

## Technique 15: Scene Transformation Pipeline

Use the same base to generate variations efficiently.

**Starting image + transformations:**

1. **Base generation:**
```
A person sitting at a wooden desk in a cozy study, reading a book.
Warm interior lighting, bookshelves in background, medium shot, 
realistic photography style. 35mm lens.
```

2. **Keep person, change setting:**
```
Keep the person's pose, clothing, and appearance exactly the same. 
Change the setting to: a modern glass office with city skyline view, 
fluorescent office lighting, contemporary furniture, daytime.
```

3. **Keep setting, change time:**
```
Keep the study room setting exactly the same. Change the time of day 
to nighttime with rain outside the window, warm lamp light creating 
cozy contrast, darker moody atmosphere.
```

4. **Keep composition, change style:**
```
Keep the person at desk, study setting, and composition exactly the same. 
Convert to: Studio Ghibli animation style, soft watercolor backgrounds, 
whimsical lighting, painted textures.
```

## Quick Reference Templates

### Product Photography
```
[Product name] on a [surface], [material details], [lighting], 
[angle], [background], [style], [mood]. Clean composition, 
professional product photography. No text, no watermarks.
```

### Character Portrait
```
[Subject description], [clothing/accessories], [pose/action], 
[setting/environment], [lighting], [camera specs], [style], 
[quality modifiers]. Consistent character throughout.
```

### Landscape/Environment
```
[Location description], [time of day/weather], [atmosphere], 
[focal point], [lighting quality], [camera specs], [color palette], 
[mood]. Cinematic, high detail.
```

### Editing/Modification
```
Keep: [what stays the same]
Change: [what to modify]
Match: [lighting/perspective consistency requirements]
Avoid: [side effects to prevent]
```

## Common Pitfalls to Avoid

1. **Contradictory descriptors:** "minimal white background" + "dense complex textures"
2. **Overloading:** Too many competing focal points
3. **Vague modifiers:** "beautiful", "professional", "high quality" without specifics
4. **Ignoring order:** Putting critical details at the end of long prompts
5. **Forgetting constraints:** Especially important for "no text" to avoid garbled output
6. **Style drift:** Changing too many variables at once between iterations

## Resources
- [Official Nano Banana Prompt Guide](https://nanobanana.io/prompt-guide)
- [DeepMind Gemini Image Guide](https://deepmind.google/models/gemini-image/prompt-guide/)
- Leonardo.Ai Nano Banana documentation
- Google AI Studio for testing

---

*Remember: Nano Banana understands natural language. Write prompts 
as if giving directions to a creative collaborator, not as keyword lists.*
