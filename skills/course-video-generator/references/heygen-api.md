# HeyGen API Reference

## Authentication

All requests require the `X-Api-Key` header:
```
X-Api-Key: sk_V2_...
```

## Endpoints

### Create Video (V2)
**POST** `/v2/video/generate`

```json
{
  "video_inputs": [{
    "character": {
      "type": "avatar",
      "avatar_id": "Daisy-inskirt-20220818",
      "avatar_style": "normal"
    },
    "voice": {
      "type": "text",
      "input_text": "Your script here...",
      "voice_id": "1776ddbd05374fa480e92f0297bbc67e"
    }
  }],
  "dimension": {
    "width": 1920,
    "height": 1080
  }
}
```

**Response:**
```json
{
  "data": {
    "video_id": "abc123..."
  }
}
```

### Check Video Status
**GET** `/v1/video_status.get?video_id={video_id}`

**Response (pending):**
```json
{
  "data": {
    "status": "processing",
    "video_id": "abc123"
  }
}
```

**Response (completed):**
```json
{
  "data": {
    "status": "completed",
    "video_id": "abc123",
    "video_url": "https://...",
    "duration": 120.5
  }
}
```

### List Avatars
**GET** `/v2/avatars`

Returns available avatars including:
- Stock avatars (free)
- Custom avatars (uploaded)
- Digital twins (premium)

### List Voices
**GET** `/v2/voices`

Returns 1000+ voices across languages and styles.

## Voice Recommendations

### English - Professional
| Voice ID | Name | Style |
|----------|------|-------|
| `1776ddbd05374fa480e92f0297bbc67e` | Melissa | Friendly, warm |
| `5cb81a519c4845f2b3c3d12b9630e258` | Paul | Friendly, professional |
| `71b0aa6499f6458e8b040818a017db1f` | Nova | Clear, neutral |
| `030a414bdb8a4c49a1b04bae627fb945` | Infini | Calm, confident |

### English - Energetic
| Voice ID | Name | Style |
|----------|------|-------|
| `8bd368108ef341579cd5b0d923b01c36` | Melissa - Excited | Upbeat |
| `9aa98f478ac94b3a85272470dff2aae4` | Paul - Excited | Enthusiastic |

### Multilingual
| Voice ID | Name | Languages |
|----------|------|-----------|
| `6d5ef2eb0cb94193b90dd3cb397ae898` | Coral | 30+ languages |
| `8273e0a033074b5bb7f7c16301e1d1d5` | Shimmer | 30+ languages |

## Avatar Styles

- `normal` - Standard front-facing
- `circle` - Circular crop (for corners)
- `closeUp` - Face focus

## Credit Costs

| Avatar Type | Cost |
|-------------|------|
| Standard stock | 1 credit/minute |
| Photo avatar | 1 credit/minute |
| Avatar IV | 6 credits/minute |
| Instant avatar | 1 credit/minute |

## Rate Limits

- Free tier: 720p max, limited concurrent jobs
- Paid: 1080p/4K, higher concurrency

## Best Practices

1. **Script length**: Keep under 5000 characters per video
2. **Punctuation**: Use periods and commas for natural pacing
3. **SSML**: Not supported in basic API, use voice attributes instead
4. **Speed**: Adjust via `voice.speed` (0.5-2.0)
5. **Pitch**: Adjust via `voice.pitch` (-20 to 20)

## Error Handling

Common errors:
- `403`: Invalid API key or insufficient credits
- `400`: Invalid avatar/voice ID
- `429`: Rate limited
- `500`: Server error (retry with backoff)

## Webhook Callback (Optional)

Add `callback_url` to video generation to receive status updates:
```json
{
  "callback_url": "https://your-server.com/webhook",
  "video_inputs": [...]
}
```
