# Third-Party Notices

本项目（学生综合素质测评管理系统 / Student Comprehensive Evaluation Management System）为**专有闭源软件**，项目自身代码保留所有权利
（所有 workspace 的 `package.json` 均声明 `"license": "UNLICENSED"`）。

本文件列出随本项目**分发产物**一同交付的第三方开源组件及其许可信息，以满足对应许可协议的通知义务。
执行 `pnpm check:licenses`（`scripts/verify-licenses.mjs`）校验本文件与已安装依赖的一致性。

## 分发产物与交付清单

| 产物 | 内容 | 本文件随包路径 |
|------|------|----------------|
| 管理端桌面安装包 `学生综合素质测评管理系统-<ver>-<profileId>-setup.exe` | Electron 应用（asar 内 `out/` + `dependencies`） | 安装后 `resources/THIRD_PARTY_NOTICES.md` |
| 微信小程序上传包 | `miniprogram/` 全部文件（含 `miniprogram_npm/` 构建产物与 shared 镜像） | `miniprogram/THIRD_PARTY_NOTICES.md` |

> `@sces/shared` 的 `@noble/*`、`node-forge` 均为其 `devDependencies`：**不进管理端安装包**
> （管理端全部使用 WebCrypto，构建产物已确认无 node-forge/portable-provider 引用）。
> 它们仅随微信小程序交付（`node-forge` 经 `scripts/patch-node-forge.mjs` 修补后进入 `miniprogram_npm`；
> `@noble/*` 原语由 `scripts/build-noble-vendor.mjs` 预打包为 `shared/src/crypto/vendor/noble.js` 随 shared 镜像进入小程序）。

### 管理端桌面安装包（按许可分类）

| 组件 | 版本 | 许可 | 通知 |
|------|------|------|------|
| Electron | ^39 | MIT（含捆绑的 Chromium/Node.js/V8 等组件，各自许可见下） | §Electron |
| electron-updater | ^6 | MIT | 通用 MIT 文本 |
| better-sqlite3 | ^12 | MIT | 通用 MIT 文本 |
| exceljs | ^4 | MIT | 通用 MIT 文本 |
| jszip | ^3 | **MIT（双许可，本项目选择 MIT）** | §JSZip |
| @tanstack/vue-table | ^8 | MIT | 通用 MIT 文本 |
| @electron-toolkit/preload、@electron-toolkit/utils | ^3 | MIT | 通用 MIT 文本 |
| @sces/shared | workspace | UNLICENSED（本项目自有） | — |

### 微信小程序上传包（按许可分类）

| 组件 | 版本 | 许可 | 通知 |
|------|------|------|------|
| node-forge | 1.4.0 | **BSD-3-Clause（双许可，本项目选择 BSD-3-Clause）** | §node-forge |
| @vant/weapp | ^1.11 | MIT | 通用 MIT 文本 |
| miniprogram-computed | ^8 | MIT | 通用 MIT 文本 |
| mobx-miniprogram | ^6 | MIT | 通用 MIT 文本 |
| mobx-miniprogram-bindings | ^6 | MIT | 通用 MIT 文本 |
| fast-deep-equal | ^3（传递） | MIT | 通用 MIT 文本 |
| rfdc | ^1（传递） | MIT | 通用 MIT 文本 |
| @noble/ciphers（vendor/noble.js 内） | ^1 | MIT | §noble |
| @noble/hashes（vendor/noble.js 内） | ^1 | MIT | §noble |
| @sces/shared（镜像） | workspace | UNLICENSED（本项目自有） | — |

---

## 双许可组件的许可选择声明

- **node-forge**（`(BSD-3-Clause OR GPL-2.0)`）：本项目依据其官方建议，**选择 BSD-3-Clause** 条款使用并分发，完整文本见 §node-forge。
- **JSZip**（`(MIT OR GPL-3.0)`）：本项目**选择 MIT** 条款使用并分发，完整文本见 §JSZip。

---

## node-forge

Copyright (c) 2010, Digital Bazaar, Inc.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * Neither the name of Digital Bazaar, Inc. nor the
      names of its contributors may be used to endorse or promote products
      derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL DIGITAL BAZAAR BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## JSZip

Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso

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

## noble（@noble/ciphers、@noble/hashes，MIT）

noble-ciphers - MIT License (c) 2023 Paul Miller (paulmillr.com)
noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com)

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

## 通用 MIT 许可文本

适用于上表标注「通用 MIT 文本」的全部 MIT 许可组件（electron-updater、better-sqlite3、
exceljs、@tanstack/vue-table、@electron-toolkit/*、@vant/weapp、miniprogram-computed、
mobx-miniprogram、mobx-miniprogram-bindings、fast-deep-equal、rfdc 等）。
各组件的具体版权行见其安装包内 `LICENSE` / `LICENSE.md` 文件。

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

## Electron 及捆绑组件

Electron 本体以 MIT 许可发布，并捆绑 Chromium、Node.js、V8 等项目，这些组件各自以
BSD、Apache-2.0、MIT 等许可发布。完整声明见 Electron 官方
`LICENSE`（`node_modules/electron/LICENSE`）与各组件上游的许可文件。
本项目未修改 Electron 及其捆绑组件。
