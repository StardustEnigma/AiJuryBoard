# AI Jury Orchestrator

## ElevenLabs TTS Integration

The orchestrator now exposes end-to-end Text-to-Speech APIs for debate messages.

### Environment variables

Set these in your root `.env` (or orchestrator runtime environment):

- `ELEVENLABS_API_KEY` (required)
- `ELEVENLABS_VOICE_ID` (optional, default: `EXAVITQu4vr4xnSDxMaL`)
- `ELEVENLABS_VOICE_ID_PROSECUTION` (optional per-agent override)
- `ELEVENLABS_VOICE_ID_DEFENSE` (optional per-agent override)
- `ELEVENLABS_VOICE_ID_DEVILS_ADVOCATE` (optional per-agent override)
- `ELEVENLABS_MODEL_ID` (optional, default: `eleven_multilingual_v2`)
- `ELEVENLABS_OUTPUT_FORMAT` (optional, default: `mp3_44100_128`)
- `ELEVENLABS_BASE_URL` (optional, default: `https://api.elevenlabs.io/v1`)
- `AUDIO_ALLOW_BROWSER_FALLBACK` (optional, default: `true`)

### Endpoints

#### `POST /audio/render`

Generates or returns cached speech for a message, and advances status to `BROADCASTABLE`.

Request body:

```json
{
  "messageId": "31",
  "text": "Debate argument text to synthesize",
  "role": "PROSECUTION",
  "voiceId": "optional_voice_id",
  "modelId": "optional_model_id"
}
```

Notes:

- If `voiceId` is provided, it takes highest priority.
- If `voiceId` is omitted and `role` is provided, the orchestrator checks role-specific env vars first.
- If no role-specific voice is configured, it falls back to `ELEVENLABS_VOICE_ID`.

Response:

```json
{
  "cached": false,
  "voiceId": "EXAVITQu4vr4xnSDxMaL",
  "modelId": "eleven_multilingual_v2",
  "audioUrl": "/audio/31-...mp3"
}
```

If ElevenLabs returns account or free-tier restrictions, the endpoint returns `fallback: "browser_tts"` and the frontend uses local browser speech synthesis automatically.

#### `GET /audio/:file`

Streams generated MP3 audio.

#### `POST /audio/spoken`

Marks a message as `SPOKEN` after playback.

Request body:

```json
{
  "messageId": "31"
}
```

### Message lifecycle

The audio pipeline uses reducer-based transitions:

`DRAFT -> VALIDATED -> BROADCASTABLE -> SPOKEN`

### Notes

- Audio files are cached in `jury-room-backend/orchestrator/logs/audio`.
- If ElevenLabs rejects requests (for example account or quota restrictions), `/audio/render` returns a JSON error with details.
