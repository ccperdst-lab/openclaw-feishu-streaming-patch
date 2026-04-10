# openclaw-feishu-streaming-patch

A patch script that enables **real Feishu streaming (typewriter effect)** for [OpenClaw](https://github.com/openclaw/openclaw).

## Background

OpenClaw has full Feishu CardKit streaming infrastructure (`FeishuStreamingSession`, `onPartialReply`, etc.) but the production build has 3 bugs that prevent it from working in the default `renderMode: "auto"` configuration:

| Bug | Symptom | Fix |
|-----|---------|-----|
| `onPartialReply` missing `startStreaming()` | Streaming card never created in auto mode | Add `startStreaming()` call |
| `onReplyStart` only starts streaming for `renderMode: "card"` | No "⏳ Thinking..." placeholder in auto mode | Extend to `auto` mode |
| Multiple `final` payloads sent per reply | Duplicate messages after the streaming card | Add `streamingDidClose` flag to suppress extras |

Additionally, the reasoning/answer display is improved: reasoning is shown in a clearly labeled block quote separated from the final answer by `---`.

## How it works

OpenClaw bundles all Feishu reply logic into a single minified JS file (`monitor-*.js`). This patcher:
1. Finds that file automatically by searching for `createFeishuReplyDispatcher`
2. Creates a timestamped backup
3. Applies 6 precise string patches
4. Verifies each patch succeeded

## Usage

```bash
# Apply patch (backs up original automatically)
node patch.js

# Verify patch is applied
node patch.js --verify

# Rollback to original
node patch.js --rollback
```

After patching, restart the OpenClaw gateway:
```bash
systemctl --user restart openclaw-gateway
# or: openclaw gateway restart
```

## Compatibility

Tested with OpenClaw `2026.3.23-2`. The patcher checks for the exact strings before patching — if the target strings are not found (e.g. after an OpenClaw upgrade), it will fail safely without modifying anything.

## Re-applying after OpenClaw upgrade

After `npm update -g openclaw`, simply re-run:
```bash
node patch.js
systemctl --user restart openclaw-gateway
```

## Rollback

```bash
node patch.js --rollback
systemctl --user restart openclaw-gateway
```
