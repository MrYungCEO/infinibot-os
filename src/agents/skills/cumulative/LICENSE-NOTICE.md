# Third-party attribution

The cumulative skill system in this directory is **architecturally inspired**
by the self-improving skill loop in
[**NousResearch/hermes-agent**](https://github.com/NousResearch/hermes-agent).

`hermes-agent` is distributed under the MIT License, reproduced below in full
per its terms. No source code from `hermes-agent` is copied into this
directory; the resemblance is to the *system design* — capturing run
trajectories, distilling them into reusable skills, tracking usage, and
periodically refining skills based on accumulated outcomes — not to any
literal implementation.

InfiniBot's implementation is independently authored and integrated with
InfiniBot's existing `loadSkillsFromDir` skill loader, `CONFIG_DIR` state
layout, and provider-agnostic completion plumbing.

---

## hermes-agent — MIT License

> MIT License
>
> Copyright (c) 2025 Nous Research
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

---

If `hermes-agent` source code (or substantial verbatim chunks of it) is later
copied into this directory, this notice must be updated to:

1. Identify which files contain copied content,
2. Preserve the copyright notice on those files, and
3. Surface this `LICENSE-NOTICE.md` alongside any redistribution that includes
   them.
