---
name: boot-md
description: "Run BOOT.md on gateway startup"
homepage: https://infinibotos.com/docs/hooks#boot-md
metadata:
  {
    "infinibot":
      {
        "emoji": "🚀",
        "events": ["gateway:startup"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with InfiniBot" }],
      },
  }
---

# Boot Checklist Hook

Runs `BOOT.md` every time the gateway starts, if the file exists in the workspace.
