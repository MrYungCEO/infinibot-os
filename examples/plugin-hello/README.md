# Hello

Hello — the example plugin the InfiniBot plugin docs walk through.

## Develop

```bash
# Load this folder straight from disk (no copy), then restart the gateway
infinibot plugins install --link .
infinibot plugins enable hello
```

Open **Setup › Plugins › Hello** to see the panel, or call the RPC `hello.greet`.

## Package and install

```bash
infinibot plugins validate .
infinibot plugins pack .            # writes hello-0.1.0.ibplugin.zip + .sha256
infinibot plugins install ./hello-0.1.0.ibplugin.zip
```

Docs: docs/plugins/getting-started.md
