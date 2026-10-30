# Agent Isometric Sprites

`registry.ts` exposes `getSpriteForAgent({ kind, runId, status, siblingIndex })`.
It returns a `SpriteDescriptor` with a stable SVG sheet key, accent color,
accessory, scale, animation metadata, and variant metadata.

## Agent Kinds

- `claude-coder`
- `codex-coder`
- `opencode-coder`
- `gemini-coder`
- `voice`
- `federation`
- `review`
- `mesh`
- `unknown`

## Variant Table

Same-kind parallel runs share the same base silhouette and kind palette, then
get a deterministic run variant:

| Index | Variant | Hue | Accessory |
| --- | --- | ---: | --- |
| 0 | ember scarf | 18 | scarf |
| 1 | sky cap | 198 | cap |
| 2 | mint halo | 148 | halo |
| 3 | violet visor | 268 | visor |
| 4 | gold satchel | 43 | satchel |
| 5 | rose antenna | 338 | antenna |
| 6 | lime badge | 94 | badge |
| 7 | cyan glow | 184 | glow |

When `siblingIndex` is omitted, `runId` is hashed with FNV-1a and mapped to
one of the eight variants. When `siblingIndex` is provided, indexes `0-7`
choose the table directly. Index `8+` cycles the table and returns
`variant.numericBadge` so renderers can overlay `9`, `10`, and so on.

## Hook Point

The current non-conflicting data boundary is
`ui/src/ui/components/agency-world-viz.ts:490-494`, in the `agent.spawn`
case. That code updates the local agent mirror and calls
`this.engine.addAgent(e.agent)`.

The actual Pixi composition point is
`ui/src/ui/views/agent-ops/activity-map.ts:3545-3548`, inside
`ActivityMap.addAgent`, right after the `AgentRoom` display object has been
created and before the spawn animation runs.

Suggested one-line integration:

```ts
applySprite(char.container, getSpriteForAgent({
  kind: agent.kind || agent.coderBackend || agent.agentId,
  runId: agent.sessionKey,
  status: agent.status,
  siblingIndex,
}));
```

Those line numbers may move while the parallel camera/layout work lands; the
stable landmark is the `agent.spawn` branch that calls `this.engine.addAgent`.
This sprite module intentionally does not rewrite the render loop, projection,
or camera.

## Adding A Kind

1. Add the literal to `AGENT_KINDS` in `types.ts`.
2. Add a base color in `palette.ts`.
3. Add `ui/public/assets/sprites/agents/<kind>.svg`.
4. Update `normalizeAgentKind(...)` in `registry.ts` if aliases are needed.
5. Run `node scripts/preview-sprites.mjs` and inspect `/tmp/sprite-preview.html`.
