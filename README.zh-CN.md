# JevRev

<p align="center">
  <img src=".github/assets/jevrev-banner.png" alt="JevRev 字标与骷髅插画" width="620" />
</p>

<p align="center"><strong>给你 LLM 加一层决策。</strong></p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/Alex314618-create/JevRev/releases"><img alt="最新版本" src="https://img.shields.io/github/v/release/Alex314618-create/JevRev?style=flat-square&amp;color=555555&amp;labelColor=333333" /></a>
  <a href="package.json"><img alt="需要 Node.js 20 或以上版本" src="https://img.shields.io/badge/Node.js-%3E%3D20-555555?style=flat-square&amp;labelColor=333333" /></a>
  <a href="LICENSE"><img alt="MIT 许可" src="https://img.shields.io/badge/License-MIT-555555?style=flat-square&amp;labelColor=333333" /></a>
</p>

> 先把选项筛短，再一轮轮打分，最后盯着它跑完。

你的 LLM 会想方案、会写代码、会跑测试、会改错。但"这条路值不值得继续往下走"这一类判断，不该由它每一件都自己拍板。

JevRev 做的事，就是把 Jev 放到 LLM 旁边：一个语义层，负责筛掉方案、检查进度，让注意力一直留在真正值得做下去的地方。LLM 出想法、出实现；JevRev 负责在继续烧时间和 token 之前，多看一眼。

这就是 JevRev —— 不是又一个 coding agent，而是围着 agent 转的那套决策系统。

## 先看个例子

仓库自带的案例是"做一个更快的 CSV 解析器"。LLM 给出两个思路：一个用正则抄近路，看着最省事；另一个老老实实写状态机，慢一些。

纸面评比时正则领先。可一跑正确性检查，它挂了。状态机虽然慢，同样的检查却全过，最终凭证据胜出。

<picture>
  <source media="(max-width: 600px)" srcset=".github/assets/jevrev-decision-gate-mobile.svg">
  <img src=".github/assets/jevrev-decision-gate.svg" alt="纸面领先的正则捷径没通过必需的正确性检查；排名第二的状态机在两者接受同样的探针之后通过了检查，并成为最终胜出者。">
</picture>

跑完整个案例：

```bash
git clone https://github.com/Alex314618-create/JevRev.git
cd JevRev
npm install
npm run build
npm run demo:workflow
```

为了让 demo 结果稳定可复现，这里 Jev 的回答是重放的。除此之外都是真的 —— 实现、正确性检查、benchmark 采样、输出摘要，以及最终决策：

```text
Paper favorite: regex-shortcut
  correctness command: failed
  result: rejected

Evidence winner: indexed-state-machine
  correctness command: passed
Decision: winner -> integrate_winner
```

值得点开看的是[实际执行的探针](benchmarks/workflow-fixture/probe.mjs)、[demo 驱动脚本](scripts/run-workflow-demo.mjs)和[决策测试](tests/workflow-decide.test.ts)。吞吐量的实测值因机器而异；让排名反转的不是速度，而是那次必须通过的正确性检查失败了。

## 三个组成部分

<picture>
  <source media="(max-width: 600px)" srcset=".github/assets/jevrev-product-roles-mobile.svg">
  <img src=".github/assets/jevrev-product-roles.svg" alt="JevSift 负责选路径，JevLoop 负责复核单个产物，只读的 JevLong 负责观察整个会话。Probe、Evidence、Decide 是三者共用的契约。">
</picture>

### JevSift：先定做哪些

调用方的 LLM 先提出几个思路明显不同的方案。JevSift 在它们占用实现预算之前，把虚的、重复的、有风险的、性价比低的统统剔掉，再给活下来的方案各发一张范围明确的工作单。

### JevLoop：把一个产物打磨好

调用方的 agent 执行一张范围明确的工作单，把实际发生的事情记录下来，然后把这一轮交给 JevLoop。Loop 先看证据，只把那些"靠事实定不了"的窄问题抛给 Jev，最后返回下一步该干什么：继续做、修复、验证、重新规划、等人介入，或者在所有标准都被证明通过后收工。

`Probe`、`Evidence`、`Decide` 在产品里的位置就在这里：它们是 Loop 内部的运转机构，不是另外几个产品界面。

### JevLong：盯着整个会话

JevLong 观察一个长时间运行的 agent 会话，把卡住、反复失败、跑偏、工具调用出错、预算风险和整体进度报告给人。它不会背着你去干预 agent —— 不悄悄改方向、不自动重试、不替你编辑，更不会把它杀掉。

`long watch` 是实时终端仪表盘。要接脚本、要机器可读的输出，就用 `long status --format json`；`watch` 不接受 `--format`。

分工就这么简单：贵的创造性工作交给 LLM，JevRev 负责让整个流程不要一遍遍为错方向买单。

## 在 Codex 里使用

先构建 CLI，再把随仓库附带的 skill 装进 Codex：

```bash
npm install
npm run build
node scripts/install-skill.mjs --target codex
```

然后给 agent 这条指令：

```text
Use JevRev for this task. Propose materially different approaches, ask JevRev
to sift them, run only the bounded probes, record the evidence, and let JevRev
audit the next round before continuing.
```

## 命令一览

| 命令 | 在 LLM + Jev 工作流里管什么 |
| --- | --- |
| `jevrev sift` | 判断哪些提出的方案值得做一次探针 |
| `jevrev loop` | 在 agent 每一轮之后复核单个产物 |
| `jevrev long` | 观察一个长跑会话的健康状况 |

`jevrev evidence` 和 `jevrev decide` 是更底层的基础设施命令，负责记录和裁定 JevSift、JevLoop 要吃的事实数据。它们不是第四、第五个产品组件。

从源码运行时，把 `jevrev` 换成 `node dist/cli.js`：

```bash
node dist/cli.js sift --input proposals.json --replay examples/parser-jev-response.json
```

## 模型接入

不管 Jev 走云端、跑本地，还是重放，JevRev 的决策逻辑完全一样：

在 POSIX shell 里用云端 Jev：

```bash
export JEVREV_JEV_API_KEY="..."
node dist/cli.js sift --input proposals.json --provider jev
```

在 Windows 上通过 llama.cpp 跑本地 SemIf：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-semif.ps1 -Background
node dist/cli.js sift --input proposals.json --provider semif
```

重放用的预置数据不需要联网，也不需要 API key。本地模型怎么搭，见
[`docs/SEMIF_LOCAL.md`](docs/SEMIF_LOCAL.md)。

## 同一份需求，两种结果

JevRev 不只能用在代码路径上。仓库里有两个页面，用的是同一份需求：一个是常规做法直接出的初版，另一个是交给 JevRev 选完路线之后产出的证据档。

<table>
  <tr>
    <th width="50%">常规初版</th>
    <th width="50%">JevRev 路线</th>
  </tr>
  <tr>
    <td><img src=".github/assets/one-shot-showcase/direct-hero.png" alt="常规做法直接出的初版页面" /></td>
    <td><img src=".github/assets/one-shot-showcase/routed-hero.png" alt="交给 JevRev 选路线之后产出的证据档" /></td>
  </tr>
</table>

重点不是什么玄乎的视觉评分，而是：Jev 选出的这条路线，会同时改变产物的结构、证据和最终方向。
拿截图互相对比之前，先看[源页面](benchmarks/one-shot-showcase/README.md)和它们的[验证记录](benchmarks/one-shot-showcase/VALIDATION.md)。

## 延伸阅读

- [工作流指南](docs/WORKFLOW.md)
- [协议与 JSON 契约](docs/PROTOCOL.md)
- [权限模型](docs/AUTHORITY.md)
- [JevLoop 设计](docs/JEVLOOP_DESIGN.md)
- [JevLong 设计](docs/JEVLONG_DESIGN.md)
- [验收记录](docs/ACCEPTANCE.md)

## 本地开发

```bash
npm install
npm run check
npm test
npm run build
npm run demo:all
npm run demo:workflow
npm run demo:loop
npm run demo:engineering
```

需要 Node.js 20 或以上版本。JevRev 采用 MIT 许可。

[MIT](LICENSE)
