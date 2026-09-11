# humanevalfix-8 Environment License

This environment has two parts, and each is licensed on its own terms.

## Part A: upstream material (MIT License, not restricted by this listing)

The function signatures, docstrings, canonical and buggy function bodies, upstream test functions
(`check`) and docstring example asserts come from **HumanEvalPack**
(https://huggingface.co/datasets/bigcode/humanevalpack, dataset revision
`9a41762f73a8cb23bb5811b73d5aab164efcf378`, MIT License). HumanEvalPack extends **OpenAI HumanEval**
(https://github.com/openai/human-eval, MIT License). This material appears in `src/hefix/`,
`tasks/*/overlay/`, `tasks/*/tests/`, `tasks/*/visible_tests/` and `solutions/`, and remains under the
MIT License. Nothing in Part B limits any right you have under the MIT License. The same upstream
material is freely available from the sources above.

HumanEval: Copyright (c) OpenAI (https://openai.com)
HumanEvalPack / OctoPack: Copyright (c) 2023 Muennighoff

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## Part B: the seller's additions (envmarket-internal-use-1.0, non-exclusive)

**Licensor:** the seller of the EnvMarket listing `humanevalfix-8`, identified by the seller address
recorded on-chain for the purchased version.
**Licensee:** the buyer address of a delivered or settled EnvMarket purchase of that version.

Part B covers everything that is not Part A: the environment driver and grader (`grader/`), the
conversion and selection script and the verification scripts (`scripts/`), task statements and the
rest of `task.json`, the choice of visible examples, the pytest wrappers and header comments added to
upstream files, `Dockerfile.runner`, and the listing documents.

1. **Grant.** The Licensor grants the Licensee a non-exclusive, non-transferable, worldwide license to
   use, run, modify and copy Part B, solely for the Licensee's internal model training and evaluation.
2. **Internal use.** Contractors and affiliates may use Part B only on the Licensee's behalf.
3. **No redistribution of Part B.** The Licensee may not redistribute, resell or sublicense Part B
   without separate written permission. This does not restrict Part A material in any way.
4. **Model outputs.** Models trained or evaluated with the environment, and their outputs, are not
   derivative works of Part B under this license.
5. **Non-exclusive.** The Licensor may license the same environment to others. There is no sale limit.
6. **Audit tasks.** The disclosed audit tasks are not part of the delivered product.
7. **Third-party runtime components.** These are used unmodified under their own licenses: pytest (MIT),
   pluggy (MIT), iniconfig (MIT), packaging (Apache-2.0 OR BSD-2-Clause) and the python:3.12-slim
   image (PSF and Debian licenses).
8. **No warranty.** The environment is provided as is. No improvement in training outcomes is promised.
   The Licensee's remedies are those of the EnvMarket dispute process for the purchased version.
