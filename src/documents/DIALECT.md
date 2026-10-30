# Documents markdown dialect

One dialect is shared by the rich editor (`ui/src/ui/components/doc-editor/`),
the Notion importers (`src/documents/notion/`) and agents. The rich editor must
round-trip every construct below losslessly (md → rich → md is a fixed point
once normalized).

| Construct | Markdown |
|---|---|
| Headings | `#`, `##`, `###` (ATX only) |
| Bold / italic / strike / code | `**b**`, `*i*`, `~~s~~`, `` `c` `` |
| Underline | `<u>text</u>` |
| Highlight | `==text==` |
| Link | `[label](https://…)` |
| Wiki link to another doc | `[[Title]]` or `[[Title\|label]]` |
| Link to doc by id | `[label](doc:<id>)` |
| Bullet list | `- item` (2-space indent per nesting level) |
| Numbered list | `1. item` (renumbered on save) |
| Checklist | `- [ ] todo` / `- [x] done` |
| Quote | `> text` |
| Callout | `> [!NOTE]` then `> body` lines. Kinds: NOTE, TIP, IMPORTANT, WARNING, CAUTION. An emoji icon may lead the first body line (`> 💡 text`) |
| Toggle | `<details><summary>Title</summary>` blank line, body markdown, blank line, `</details>` |
| Code block | fenced ```` ```lang ```` |
| Table | GFM pipe table, header row + `---` separator |
| Divider | `---` |
| Image | `![alt](url)`; local assets use `/api/documents/assets/<hash>.<ext>` |
| Embed (web) | `<iframe src="https://…"></iframe>` on its own line |
| Video / audio | `<video src="…" controls></video>` / `<audio src="…" controls></audio>` |
| File attachment | `[📎 name](url)` |
| Math block | `$$` newline TeX newline `$$` |
| Inline math | `$TeX$` |
| Frontmatter | optional leading `---\nkey: value\n---` (preserved verbatim) |
