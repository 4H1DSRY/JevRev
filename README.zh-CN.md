# JevRev

<p align="center">
  <img src=".github/assets/jevrev-banner.png" alt="JevRev 字标与骷髅插画" width="620" />
</p>

<p align="center"><strong>你 LLM 身旁的决策层。</strong></p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/Alex314618-create/JevRev/releases"><img alt="最新版本" src="https://img.shields.io/github/v/release/Alex314618-create/JevRev?style=flat-square&amp;color=555555&amp;labelColor=333333" /></a>
  <a href="package.json"><img alt="需要 Node.js 20 或更高版本" src="https://img.shields.io/badge/Node.js-%3E%3D20-555555?style=flat-square&amp;labelColor=333333" /></a>
  <a href="LICENSE"><img alt="MIT 许可" src="https://img.shields.io/badge/License-MIT-555555?style=flat-square&amp;labelColor=333333" /></a>
</p>

> 先筛出短名单，再循环打分，最后盯住整场运行。

你的 LLM 能想象、能写、能测、能改。它不该把每一个廉价的路径选择都自己扛下来。

JevRev 把 Jev 放到 LLM 身边：一个语义层，负责过滤方案、检查进展，把注意力留在真正值得继续的工作上。LLM 提供广度与实现能力；JevRev 提供那「多看的一眼」——在继续消耗时间和 token 之前。

这就是 JevRev：它不是又一个 coding agent，而是围绕这个 agent 的那套决策系统。

## 看一眼它的思路

自带的案例要求做一个更快的 CSV 解析器。LLM 提出了一个很诱人的 regex 捷径，和一个更谨慎的状态机。捷径在纸面排名中胜出，随后在正确性检查中失败。状态机更慢，通过了同样的检查，成为凭证据胜出的方案。

<picture>
  <source media="(max-width: 600px)" srcset=".github/assets/jevrev-decision-gate-mobile.svg">
  <img src=".github/assets/jevrev-decision-gate.svg" alt="纸面首选的 regex 捷径未通过必需的正确性检查；排名第二的状态机在两者接受同样的探针之后通过并胜出。">
</picture>

跑完整个案例：

```bash
git clone https://github.com/Alex314618-create/JevRev.git
cd JevRev
npm install
npm run build
npm run demo:workflow
```

为保证 demo 可复现，Jev 的回答是重放的。但实现、正确性检查、benchmark 采样、输出摘要和最终决策都是真的：

```text
Paper favorite: regex-shortcut
  correctness command: failed
  result: rejected

Evidence winner: indexed-state-machine
  correctness command: passed
Decision: winner -> integrate_winner
```

可以查看[已执行的探针](benchmarks/workflow-fixture/probe.mjs)、[demo 驱动](scripts/run-workflow-demo.mjs)和[决策测试](tests/workflow-decide.test.ts)。实测吞吐量会随机型而异；真正让排名反转的，是那次必需的正确性失败。

## 三个部分

<picture>
  <source media="(max-width: 600px)" srcset=".github/assets/jevrev-product-roles-mobile.svg">
  <img src=".github/assets/jevrev-product-roles.svg" alt="JevSift 选择路径，JevLoop 审计单个产物，只读的 JevLong 观察整个会话。Probe、Evidence 和 Decide 是三者的共享契约。">
</picture>

### JevSift：挑出该做的事

宿主 LLM 提出若干个本质不同的方案。JevSift 在它们消耗实现预算之前，先剔除虚弱、重复、有风险或价值不高的路径，然后为幸存者发出范围明确的工作单。

### JevLoop：打磨单个产物

宿主 agent 执行一张范围明确的工作单，记录实际发生了什么，再把这一轮提交给 JevLoop。Loop 检查证据，只向 Jev 询问那些事实无法裁定的窄问题，然后返回下一步动作：继续、修复、验证、重新规划、等待人工，或者在所有标准都被证明后结束。

这正是 `Probe`、`Evidence`、`Decide` 在产品叙事中的位置：它们是 Loop 的工作机构，而不是另外的产品界面。

### JevLong：观察整个会话

JevLong 观察一个长跑中的 agent 会话，向人报告停滞、重复失败、偏移、工具调用问题、预算风险与进展。它不会静默地操纵、重试、编辑或终止 agent。

`long watch` 是实时的终端驾驶舱。给脚本和机器可读输出用时，请用 `long status --format json`；`watch` 不接受 `--format`。

结果是一个简单的分工：LLM 做昂贵的创造性工作，而 JevRev 阻止整个工作流反复为错误方向付费。

## 从 Codex 使用它

构建 CLI，并把随仓库附带的 skill 安装进 Codex：

```bash
npm install
npm run build
node scripts/install-skill.mjs --target codex
```

然后给宿主 agent 这条指令：

```text
Use JevRev for this task. Propose materially different approaches, ask JevRev
to sift them, run only the bounded probes, record the evidence, and let JevRev
audit the next round before continuing.
```

## 命令面

| 命令 | 在 LLM + Jev 工作流中的角色 |
| --- | --- |
| `jevrev sift` | 判断哪些提出的方案值得一次探针 |
| `jevrev loop` | 在 agent 每一轮之后审计单个产物 |
| `jevrev long` | 观察一个长跑会话的健康状况 |

`jevrev evidence` 和 `jevrev decide` 是更底层的基础设施命令。它们记录并裁定 JevSift 与 JevLoop 所消费的事实；它们不是第四、第五个产品组件。

从源码运行时，用 `node dist/cli.js` 代替 `jevrev`：

```bash
node dist/cli.js sift --input proposals.json --replay examples/parser-jev-response.json
```

## Provider

无论 Jev 是托管的、本地的还是重放的，JevRev 都保持同一条决策边界：

在 POSIX shell 中使用托管的 Jev：

```bash
export JEVREV_JEV_API_KEY="..."
node dist/cli.js sift --input proposals.json --provider jev
```

在 Windows 上通过 llama.cpp 使用本地 SemIf：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-semif.ps1 -Background
node dist/cli.js sift --input proposals.json --provider semif
```

重放夹具无需网络、无需 API key 即可工作。本地模型的搭建见
[`docs/SEMIF_LOCAL.md`](docs/SEMIF_LOCAL.md)。

## 一个 brief，两种结果

JevRev 的用处不限于代码路径。仓库里包含两个由同一份 brief 生成的页面：一个常规的初版，和一份经 JevRev 路由产出的证据卷宗。

<table>
  <tr>
    <th width="50%">常规初版</th>
    <th width="50%">JevRev 路由</th>
  </tr>
  <tr>
    <td><img src=".github/assets/one-shot-showcase/direct-hero.png" alt="常规的初版页面" /></td>
    <td><img src=".github/assets/one-shot-showcase/routed-hero.png" alt="经 JevRev 路由的证据卷宗" /></td>
  </tr>
</table>

重点不是一个玄学的视觉评分。重点是：Jev 选出的路径，能够同时改变产物的结构、证据与最终方向。
在对比这些截图之前，请先看[源页面](benchmarks/one-shot-showcase/README.md)及其[验证记录](benchmarks/one-shot-showcase/VALIDATION.md)。

## 接着读

- [工作流指南](docs/WORKFLOW.md)
- [协议与 JSON 契约](docs/PROTOCOL.md)
- [权限模型](docs/AUTHORITY.md)
- [JevLoop 设计](docs/JEVLOOP_DESIGN.md)
- [JevLong 设计](docs/JEVLONG_DESIGN.md)
- [验收记录](docs/ACCEPTANCE.md)

## 开发

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

需要 Node.js 20 或更高版本。JevRev 采用 MIT 许可。

[MIT](LICENSE)
