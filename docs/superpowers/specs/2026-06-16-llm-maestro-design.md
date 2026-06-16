# llm-maestro 设计文档

> 工作名：`llm-maestro`（CLI 命令 `maestro`，可改）
> 日期：2026-06-16
> 状态：已通过 brainstorming，待写实现计划

## 1. 概述

`llm-maestro` 是一个通过 **npm CLI 启动**的本地多 provider LLM 路由器。它以反向工程 GitHub Copilot 作为核心后端，统一对外暴露 **OpenAI 兼容**与 **Anthropic 兼容**接口，让 Claude Code、Codex 及任意 OpenAI 兼容客户端通过同一个本地端点接入多个模型 provider。

与三个参考项目的区别：

- 对比 **copilot-bridge**（C# 单二进制）：我们是 npm CLI、TypeScript、带 Web Dashboard。
- 对比 **Router-Maestro**（Python/Docker）：我们用 npm 而非 Docker，并提供管理 UI 与自愈 daemon。
- 对比 **agent-maestro**（VS Code 扩展）：我们是独立 CLI，用 Web Dashboard 取代命令面板；**不做** agent 任务编排，但实现其代理 + 管理 + metrics 能力（含 PR #187 的 metrics dashboard）。

## 2. 决策汇总

| 维度 | 决策 |
|------|------|
| 后端 | 多 provider 路由：Copilot(反向) + OpenAI + Anthropic + 自定义 OpenAI 兼容端点；优先级 + 失败 fallback + 模糊模型匹配 + model 重映射 |
| 客户端接口 | OpenAI `/v1/chat/completions` + Anthropic `/v1/messages`（均含 SSE 流式） |
| 范围 | 代理 + 管理 + metrics + 自愈 daemon。**不做** VS Code agent 任务编排 |
| 启动 | `npx llm-maestro start` 或全局安装后 `maestro start` |
| 进程模型 | Supervisor（控制面，常驻）+ Worker（数据面，跑 proxy，可被重启） |
| 持久化 | SQLite（better-sqlite3）：config / 加密凭证 / 错误·重启历史 / 请求日志元数据；实时 metrics 走内存 ring buffer |
| 前端 | React + Vite + Tailwind，构建为静态资源内嵌进 npm 包，由 Supervisor 服务 |
| 语言/构建 | TypeScript 全栈；pnpm workspace 开发；发布为**单个** CLI 包（内嵌 dashboard 产物） |
| 安全 | 默认绑定 127.0.0.1；proxy 单一 server API key；Dashboard 本地 token；请求日志只存 safe headers，永不存 body |

## 3. 总体架构 / 进程模型

```
 npx llm-maestro start
        │
        ▼
┌──────────────────────────────────────────────┐
│ Supervisor 进程 (控制面, 常驻, 端口 :7890)        │
│  • 服务 Dashboard 静态资源 + REST API           │
│  • SQLite (config / creds / errors / req-log)  │
│  • 内存 metrics ring buffer + SSE 推送给浏览器    │
│  • 监控 Worker：心跳 / 退出码                     │
│  • 自愈：崩溃→指数退避重启；窗口内 N 次失败→标记      │
│            unhealthy 并停止重启，错误入库           │
└───────────────┬──────────────────────────────┘
                │ child_process IPC (process.send)
                │  ↑ 上行: metric / error / log 事件
                │  ↓ 下行: config 热更新 / reload / drain
                ▼
┌──────────────────────────────────────────────┐
│ Worker 进程 (数据面, 端口 :7891 proxy)           │
│  • OpenAI + Anthropic 兼容入站端点 (SSE)         │
│  • 管线: 入站格式 → 内部规范表示(Anthropic Messages) │
│    → 路由选 provider → provider 适配器 → 出站;     │
│    响应反向同理                                  │
│  • Providers: Copilot(反向)/OpenAI/Anthropic/   │
│    custom; 优先级 + 失败 fallback                │
└──────────────────────────────────────────────┘
```

**核心不变量**：Dashboard 与错误存储归属于 Supervisor，因此即使 Worker（proxy）崩溃，Dashboard 仍在线，可展示崩溃原因与重启历史。Worker 仅承担数据面，崩溃重启代价小、隔离性好。

## 4. 包结构（pnpm workspace，发布单包）

```
packages/
  cli/         # bin 入口: start/stop/status/auth/config/logs (commander 或 yargs)
  supervisor/  # 控制面: 进程监控 + 自愈 + REST API + SSE + SQLite
  worker/      # 数据面: HTTP 入站 + 路由 + 转换管线
  core/        # 共享: 内部规范类型 / transforms / provider 适配器接口
  providers/   # copilot(反向)/openai/anthropic/custom 适配器实现
  dashboard/   # React + Vite + Tailwind 前端
  shared/      # 跨进程 IPC 消息类型 / config schema / db schema
```

发布：构建后将 dashboard 静态产物内嵌，打成单个 npm 包，暴露一个 bin：`maestro`。

每个包职责单一、通过明确接口通信、可独立测试：

- `core` 定义内部规范表示与 `ProviderAdapter` 接口，不依赖任何具体 provider。
- `providers` 实现适配器，仅依赖 `core` 的接口。
- `worker` 组装管线，不关心 Supervisor 如何监控它。
- `supervisor` 监控 worker、服务 dashboard，不关心管线内部。
- `shared` 持有跨进程契约（IPC 消息、config schema、db schema），两侧都依赖它。

## 5. 数据面：转换管线 + 路由

### 5.1 内部规范表示
统一收敛到 **Anthropic Messages 形态**（借鉴 copilot-bridge 的 typed-pipeline）。请求与响应均经过单一中间表示，新增 provider 或 client 时不改核心。

```
入站(OpenAI|Anthropic) → 规范化 → 校验 → 路由 → provider 适配器
                                                      │
出站(OpenAI|Anthropic) ← 反规范化 ← ───────────────────┘
```

### 5.2 路由
- **模糊模型匹配**：把常见别名（如 `opus-4-6`）解析为精确模型 id。
- **优先级选择 + fallback**：按 provider 优先级选取；调用失败自动尝试下一个可用 provider。
- **model 重映射**：将客户端请求的模型名映射到目标 provider 的实际模型（如 `gpt-4o` → 某 Copilot 模型）。
- **热更新**：路由/provider 配置变更通过 IPC 下发，Worker 无需重启即可生效；不可热更的变更走优雅 drain → 重启。

### 5.3 Provider 适配器
- **Copilot（反向）**：GitHub OAuth device-code 登录 → 换取 Copilot token → 自动刷新；token 加密后存 SQLite。
- **OpenAI / Anthropic / 自定义**：标准 API key + base URL；自定义端点按 OpenAI 兼容处理。

### 5.4 流式
全链路 SSE：入站流式请求 → provider 流式响应 → 跨格式转换 → 客户端，保持背压与正确的事件帧。

## 6. 控制面：自愈 daemon

- Supervisor 通过 `child_process.fork` 启动 Worker，监听 `exit` / `disconnect` 与 IPC 心跳（周期性 ping/pong）。
- **崩溃重启**：指数退避（如 0.5s, 1s, 2s, 4s …，设上限）。
- **滑动窗口熔断**：例如 60s 内崩溃 ≥ 5 次 → 标记 `unhealthy`，停止自动重启，将崩溃序列（退出码、stderr 尾部、堆栈）写入 SQLite；Dashboard 红色告警并提供一键手动重启。
- **健康判定**：心跳超时同样视为不健康并触发重启。
- 所有崩溃 / 重启 / 熔断事件入库，构成 Dashboard 的错误追踪时间线。

## 7. Dashboard（React + Vite + Tailwind）

四个区，全部经由 Supervisor 的 REST + SSE：

1. **Overview / 健康**：Supervisor & Worker 状态、运行时长、重启次数、unhealthy 告警；一键 start/stop/restart。
2. **Metrics**（对标 agent-maestro PR #187）：active requests、QPS/吞吐率、延迟分位（p50/p95）、按 endpoint 与 model 的用量表、最近请求列表（可展开详情：safe headers、provider、模型、耗时、token 用量、状态码 —— **不存 body**）。实时数据走 SSE，内存 ring buffer 提供最近窗口。
3. **Providers / 路由管理**（取代命令面板）：增删改 provider、优先级排序、model 映射、Copilot OAuth 登录向导、连通性测试、客户端一键配置（生成 Claude Code / Codex 的 env 与配置片段）。
4. **Errors / 日志**：崩溃与重启时间线、错误详情（退出码 / stderr / 堆栈）、请求级错误（4xx/5xx/fallback 记录），可筛选。

## 8. 安全与隐私

- 默认仅绑定 `127.0.0.1`。
- proxy 需要单一 server API key（形如 `sk-rm-...`）。
- Dashboard 使用本地 token 鉴权。
- 请求日志只存 safe headers 与元数据，**永不存** prompt / response body。
- provider 凭证（含 Copilot token）加密后存 SQLite。

## 9. 数据模型（SQLite，初稿）

- `providers`：id, type, name, priority, base_url, model_map(json), enabled。
- `credentials`：provider_id, encrypted_blob, expires_at。
- `settings`：单行全局配置（bind host/port、server api key hash、自愈阈值参数）。
- `restart_events`：ts, reason, exit_code, stderr_tail, backoff_ms, marked_unhealthy。
- `request_log`：ts, endpoint, client_format, provider, model, status, latency_ms, tokens(json), safe_headers(json)。

## 10. 分期交付

- **M1 MVP**：CLI + Supervisor/Worker 双进程自愈 + 单 provider（Copilot 反向）+ OpenAI 入站 + 最小 Dashboard（健康 + 手动重启）。
- **M2**：Anthropic 入站 + 多 provider + 优先级/fallback + Provider 管理 UI + 客户端一键配置。
- **M3**：Metrics dashboard（PR #187 全套）+ 错误追踪时间线。
- **M4**：打磨（模糊匹配、热更新、连通性测试、打包发布到 npm）。

## 11. 未决 / 后续

- 工作名 `llm-maestro` 最终定名（与 npm 上已有包查重）。
- Copilot 反向工程的合规边界需在 README 中明确声明（仅用于自有订阅）。
- 是否提供 Gemini 入站（当前不做，架构预留）。
