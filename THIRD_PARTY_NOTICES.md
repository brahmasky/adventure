# Third-party notices

Houge has no runtime dependencies. A small amount of source was ported from MIT-licensed projects; each project's copyright
notice and the MIT permission notice are reproduced below, as the licence requires.

## mu (qybaihe/mu)

- Source: https://github.com/qybaihe/mu at `faed8c364323c477399b1dc2ef1d2fa36ce51267`, file
  `packages/kyrn-judge/src/decisions/tool-injection.ts` (the package carries no licence of its own; the repository root
  `LICENSE` governs).
- Ported into: `src/decisions/entries/tool-injection.ts` (the injection question's wording and the phrase floor) and
  `src/decisions/egress.ts` (`splitPassages`, the passage splitter). Two published test passages from
  `packages/kyrn-judge/test/injection.test.ts` at the same commit are planted attacks in
  `src/decisions/injection-corpus.ts`.

```
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## hermes-jev-skills (kerpopule/hermes-jev-skills)

- Source: https://github.com/kerpopule/hermes-jev-skills (`LICENSE` read at `31f476cac49713b6bf88c00d42382542e1c36965`);
  mu credits `jevkit/webscreen.py` and `jevkit/rerank.py` as the origin of the injection question's wording and the
  instruction patterns.
- Ported into (through mu): `src/decisions/entries/tool-injection.ts`.

```
MIT License

Copyright (c) 2026 Steve Darlow

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
