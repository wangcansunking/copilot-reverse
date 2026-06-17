# llm-maestro 设计文档 (v2 — TUI-centric)

> 工作名：`llm-maestro`（CLI 命令 `maestro`，可改）
> 日期：2026-06-16（v2 修订：2026-06-17）
> 状态：已通过 brainstorming（含 TUI pivot），待重写实现计划

## 0. v2 变更说明

v1 设计为「后台 daemon + Web Dashboard」。经讨论 pivot 为 **像 Claude Code 一样的交互式 CLI**：

- **砍掉 Web Dashboard** —— 所有管理/可视化收进 Ink TUI。
- `maestro` 进入交互式 REPL：slash 命令 + 自然语言对话助手。
- 对话助手用 **claude-agent-sdk**，并 **dogfood maestro 自己**（走本机 Anthropic 兼容入站 → Copilot）。
- 自愈 proxy daemon 由 TUI 自动拉起托管，错误/重启历史 + metrics 在 TUI 里看。

v1 的 proxy/路由/自愈 daemon 核心设计保留；新增 Anthropic 入站（含 tool-use 翻译）、Ink TUI、对话助手。

## 1. 概述

`llm-maestro` 是一个 **npm CLI 启动的交互式终端应用**（Ink/React-for-CLI）。运行 `maestro`：

1. 未登录 → 内联 GitHub device-code 登录；
2. 已登录 → 进入 REPL，可用 slash 命令管理，也可用自然语言让内置助手代为执行；
3. 背后是一个自愈的多-provider 代理 daemon，把 GitHub Copilot（反向）统一暴露成 **OpenAI** 与 **Anthropic** 兼容接口，供 Claude Code / Codex 等客户端接入。

与三个参考项目的关系：取 copilot-bridge 的 Copilot 反向 + typed pipeline；取 Router-Maestro 的多-provider 路由理念；取 agent-maestro 的「一键配置客户端 + 状态/doctor」能力，但**用 Ink TUI + 对话助手取代命令面板/网页**。

## 2. 决策汇总

| 维度 | 决策 |
|------|------|
| 形态 | 交互式 Ink TUI（REPL），npm 全局/`npx` 启动，bin = `maestro` |
| 主交互 | slash 命令 + 自然语言对话助手（二者等价地触发同一批 action） |
| Web Dashboard | **不做**。metrics / 错误 / 重启历史全在 TUI 面板里渲染 |
| 后端 | 多-provider 路由；M1 仅 Copilot(反向) 单 provider，多 provider/fallback 留 M2 |
| 客户端接口 | OpenAI `/v1/chat/completions` + Anthropic `/v1/messages`（均含 SSE 流式 + tool-use） |
| 对话助手 | `@anthropic-ai/claude-agent-sdk`，dogfood maestro：`ANTHROPIC_BASE_URL` 指向本机 Anthropic 入站 → Copilot |
| 助手工具 | claude-agent-sdk in-process MCP 工具（`tool()` / `createSdkMcpServer`），调用 daemon 控制 API 执行 action |
| 进程模型 | TUI 进程 ⟂ daemon。daemon = Supervisor（控制面，常驻）+ Worker（数据面，跑 proxy） |
| daemon 协同 | TUI 启动时检查并自动拉起 daemon；slash/助手经本地控制 API 操作它 |
| 自愈 | Worker 崩溃 → 指数退避重启；窗口内 N 次失败 → 标记 unhealthy 停止重启 |
| 持久化 | SQLite（better-sqlite3）：config / 加密凭证 / 错误·重启历史 / 请求日志元数据；实时 metrics 走内存 ring buffer |
| 语言/构建 | TypeScript 全栈，ESM；pnpm workspace 开发；发布单个 CLI 包 |
| 安全 | 默认绑定 127.0.0.1；proxy server API key；请求日志只存 safe headers，永不存 body |

## 3. 总体架构

```
$ maestro
┌─────────────────────────────────────────────────────────────┐
│ TUI 进程 (Ink/React)                                          │
│  ├─ 启动: 确保已登录(device-code) + 确保 daemon 在跑(自动拉起)   │
│  ├─ REPL 输入框:                                              │
│  │     "/..." → SlashRouter → 调 daemon 控制 API              │
│  │     自然语言 → Assistant(claude-agent-sdk) → tool call     │
│  │                 → 同一批 action                            │
│  ├─ 面板: /metrics /logs /status (Ink 组件渲染)               │
│  └─ Assistant 模型后端 = 本机 maestro Anthropic 入站(dogfood)  │
└───────────────┬─────────────────────────────────────────────┘
                │ 本地 HTTP 控制 API (:7890/api) + SSE
                ▼
┌─────────────────────────────────────────────────────────────┐
│ Supervisor 进程 (控制面, 常驻, :7890)                          │
│  • 控制 API: status / start / stop / restart / providers /    │
│    setup-client / doctor / metrics / logs (REST + SSE)        │
│  • SQLite (config / creds / errors / req-log)                 │
│  • 内存 metrics ring buffer                                   │
│  • 监控 Worker + 自愈(退避重启 + 熔断)                          │
└───────────────┬─────────────────────────────────────────────┘
                │ child_process IPC
                ▼
┌─────────────────────────────────────────────────────────────┐
│ Worker 进程 (数据面, proxy, :7891)                            │
│  • 入站: OpenAI /v1/chat/completions + Anthropic /v1/messages │
│  • 管线: 入站 → 内部规范(Anthropic Messages, 含 tool_use)      │
│    → 路由 → provider 适配器 → 出站; 流式 SSE 全程              │
│  • Provider: Copilot(反向, OpenAI 形状) — 含 tool-use 双向翻译 │
└─────────────────────────────────────────────────────────────┘
```

**两条数据通道要分清**：
1. **控制通道**：TUI（slash/助手工具）→ Supervisor `:7890/api` → 管理 daemon。
2. **推理通道**：助手 / 外部客户端 → Worker `:7891`（OpenAI 或 Anthropic 入站）→ Copilot。助手走 Anthropic 入站这条，即 dogfood。

## 4. 关键不变量 / 设计要点

- **Dashboard 死了也能看错误**：Supervisor 常驻并持有 SQLite 与控制 API；Worker（proxy）崩了，TUI 仍能从 Supervisor 读到崩溃原因、重启历史。
- **助手 dogfood 需要 Anthropic 入站支持 tool-use**：claude-agent-sdk 的 agent loop 通过标准 Anthropic Messages 协议下发/回收工具调用（`tool_use` / `tool_result` content blocks 与 `tools` 参数）。因此 Worker 的 `/v1/messages` 必须做 **Anthropic ↔ OpenAI 的 tool-use 双向翻译**（Copilot 是 OpenAI 形状、支持 function calling），含流式增量里的 tool_use。这是 M1 的主要难点。
- **模型名映射**：claude-agent-sdk 默认请求 `claude-*` 模型；Worker 路由层维护默认 model map（`claude-* → 某 Copilot 模型 id`），客户端请求亦可被重映射。
- **slash 与助手等价**：两者最终都调用同一组「action」（封装在 Supervisor 控制 API + TUI action 层）。助手的 in-process 工具就是这些 action 的薄包装，保证「能 slash 的都能对话完成」。

## 5. 组件分解

### 5.1 TUI（Ink）
- `app`：根组件，管理屏幕状态（REPL / 面板）、全局快捷键。
- `repl`：输入框；`/` 前缀 → SlashRouter；否则 → Assistant。
- `slash/*`：每个命令一个处理器；`registry` 提供 `/help`。命令集（M1）：
  `/login` `/logout` `/status` `/setup-claude` `/setup-codex` `/setup-status`
  `/doctor` `/providers` `/start` `/stop` `/restart` `/metrics` `/logs` `/help` `/quit`
- `panels/*`：`StatusPanel`、`MetricsPanel`（实时，SSE）、`LogsPanel`（错误/重启时间线）。
- `daemon-client`：封装对 Supervisor 控制 API 的 REST + SSE 调用。
- `bootstrap`：启动序列（确保登录 → 确保 daemon → 进入 REPL）。

### 5.2 Assistant（claude-agent-sdk）
- `assistant/runtime`：用 `query()` 跑 agent loop；`ANTHROPIC_BASE_URL=http://127.0.0.1:7891`（Anthropic 入站）、auth token = maestro server API key。
- `assistant/tools`：`createSdkMcpServer` + 一组 `tool()`，每个工具薄包 Supervisor 控制 API（如 `restart_worker`、`setup_client`、`run_doctor`、`list_providers`）。
- `assistant/stream-view`：把助手输出流式渲染到 TUI。

### 5.3 daemon（Supervisor + Worker）—— 沿用 v1
- `supervisor/db`（SQLite）、`supervisor/monitor`（退避重启 + 熔断）、`supervisor/api`（控制 REST/SSE）、`supervisor/events`（事件总线）、`supervisor/index`（接线）。
- `worker/server`（OpenAI + Anthropic 入站）、`worker/router`、`worker/index`（IPC 心跳）。

### 5.4 core / providers
- `core/canonical`：内部规范类型（messages、tools、tool_use/tool_result、流式 chunk）。
- `core/openai-inbound`、`core/anthropic-inbound`：两个入站格式 ↔ 规范，**含 tool-use 翻译**。
- `providers/copilot/*`：device-code 认证、token 交换缓存、adapter（complete/stream + function-calling 翻译）。

### 5.5 shared
- `config`、`ipc`、`paths`、`creds`、控制 API 的请求/响应类型。

## 6. 持久化（SQLite 初稿）

- `settings`：bind host/port、server api key hash、自愈阈值、默认 model map。
- `providers` / `credentials`：provider 配置与加密凭证（M1 仅 Copilot）。
- `restart_events`：ts, reason, exit_code, stderr_tail, backoff_ms, marked_unhealthy。
- `request_log`：ts, endpoint, client_format, provider, model, status, latency_ms, tokens(json), safe_headers(json)。

## 7. 安全与隐私

- 默认仅绑定 `127.0.0.1`；proxy 与控制 API 用本地 server API key。
- 请求日志只存 safe headers + 元数据，**永不存** prompt/response body。
- Copilot 凭证加密存 SQLite。
- README 声明：Copilot 反向使用社区记录的非官方端点，仅供自有订阅使用。

## 8. 里程碑（重新切分）

M1 因「助手 + Anthropic 入站」而变大，内部按 a→d 顺序推进，全部属于 M1：

- **M1a 骨架**：单包脚手架 + shared/core(OpenAI) + Copilot 反向(auth/token/adapter, complete+stream) + Worker OpenAI 入站 + Supervisor 自愈 daemon + CLI 引导 + 最小 Ink TUI（REPL + `/status` `/doctor` `/start` `/stop` `/restart` `/logs` `/quit`）+ device 登录。
- **M1b Anthropic 入站**：`/v1/messages`（非流式 + SSE）+ Anthropic↔OpenAI **tool-use 双向翻译** + 默认 model map。
- **M1c 对话助手**：claude-agent-sdk runtime（dogfood）+ in-process 工具（restart/status/doctor/setup-client/providers）+ REPL 自然语言分流 + 流式渲染。
- **M1d 管理与可视化**：`/setup-claude` `/setup-codex` `/setup-status` `/providers` + `/metrics` 面板（SSE 实时）+ `/logs` 错误/重启时间线。

### 范围决定（2026-06-17，最终）

用户确认：**只要 GitHub Copilot，和 agent-maestro 一样**，不要多 provider。因此原 M2 的多 provider 全套**取消**，产品定型为 **Copilot-only**：

- ~~M2 多 provider / 优先级 / fallback / 模糊匹配 / provider 管理 UI~~ → **不做**（YAGNI）。
- ~~凭证加密强化~~ → **非必需**（GH token 存 `~/.llm-maestro/creds.json`，0600，与 `gh` CLI / `~/.aws/credentials` 同风险级别）；除非要 OS 钥匙串级别保护，否则不做。
- ~~配置热更新子系统~~ → **不做**；配置在 TUI 启动时读一次（非阻塞）即可。

**M1 即定型产品**。下一步只剩**验收 + 发布**：本机真机 Copilot dogfood（需真订阅）→ npm publish。本地可验项（全套测试含 e2e、构建、真 daemon 控制面自愈）均已通过。

## 9. 未决 / 风险

- claude-agent-sdk 经 `ANTHROPIC_BASE_URL` 指向自建 Anthropic 端点时，对协议细节（系统提示注入、tool 结果帧、停止原因）的要求需在 M1b/M1c 用真实联调验证；先用最小 `/v1/messages` 子集打通，再按 SDK 实际行为补齐。
- tool-use 流式翻译（OpenAI `tool_calls` 增量 ↔ Anthropic `input_json_delta`）是最易出错处，需独立单测覆盖。
- Copilot 非官方端点/模型可用性可能变化；model map 设为可配置。
- 工作名 `llm-maestro` 最终定名与 npm 查重。
