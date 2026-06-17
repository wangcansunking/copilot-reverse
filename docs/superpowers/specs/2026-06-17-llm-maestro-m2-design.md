# llm-maestro M2 — Design Delta (multi-provider, fallback, encryption, hot-reload)

> Status: DRAFT — forks pending `team-lead` resolution. Owner: `architect`. Date: 2026-06-17.
> Scope: spec §8 "M2" bullet — multi-provider (OpenAI/Anthropic/custom) + priority/fallback + fuzzy match +
> provider-management UI + credential encryption + config hot-reload.
> **This document EXTENDS the M1 interface freeze (`docs/superpowers/notes/interface-freeze.md`); it does NOT
> rewrite M1 contracts.** Where M2 adds a field, it is additive/optional so M1 code keeps compiling. §-numbering
> continues the freeze (freeze ends at §8; this spec uses §9–§15). Anything that touches a frozen shape is called
> out explicitly and follows the freeze §8 change protocol.

## 9. Relationship to the M1 freeze (what stays, what extends)

The M1 canonical hub (freeze §1), the OpenAI↔canonical↔Anthropic translation (§5/§5.1/§5.4/§5.4.1), the IPC
shapes (§3), and the control-API envelope style (§2.1) are **unchanged and remain frozen**. M2 changes are
confined to four seams, all backward-compatible:

| M1 frozen shape | M2 delta | Breaking? |
|---|---|---|
| `AppConfig` (`shared/config.ts`) | add optional `providers: ProviderConfig[]` + `routing: RoutingPolicy`; keep `modelMap` | No — both optional, M1 default = single synthetic Copilot provider |
| `Router` (`worker/router.ts`) | `pick()` becomes priority+fallback aware; `resolveModel()` gains fuzzy stage | No — same method signatures; behavior widened |
| `ProviderAdapter` (`providers/types.ts`) | add optional `classifyError?(e): "retryable" \| "fatal"`; adapters gain a factory | Additive — optional member |
| `creds.ts` (plaintext) | replaced by an encrypted credential store behind the same read/write API | API-compatible; on-disk format changes (migration in §12) |
| control-types (`shared/control-types.ts`) | add `ProviderStatus`, provider CRUD request/response shapes (§14) | Additive new types |

**Invariant carried from M1:** the canonical representation stays the sole inter-format currency. Every new
provider adapter translates canonical→its-wire and back; no provider-to-provider shortcuts. A new OpenAI-shaped
provider reuses the *existing* OpenAI wire mapping already proven for Copilot.

---

## 10. Multi-provider registry + per-provider config schema

### 10.1 `ProviderConfig` (new, in `shared/config.ts`)

```ts
export type ProviderKind = "copilot" | "openai" | "anthropic" | "openai-compatible";

export interface ProviderConfig {
  id: string;                 // stable unique id, e.g. "copilot-default", "openai-main"
  kind: ProviderKind;
  enabled: boolean;
  priority: number;           // lower = tried first (see §11)
  baseUrl?: string;           // required for openai-compatible; defaults baked in for the others
  // model ids this provider can actually serve, used by routing/fuzzy-match (§13).
  models?: string[];
  // per-provider remap layered ON TOP of the global modelMap (§13.3).
  modelMap?: Record<string, string>;
  credentialRef?: string;     // key into the credential store (§12); absent for Copilot device-flow
  headers?: Record<string, string>; // extra static headers (e.g. api-version)
}

export interface RoutingPolicy {
  mode: "priority";           // M2 ships "priority"; reserved for "round-robin"/"weighted" later
  fallback: FallbackPolicy;   // §11
}
```

`AppConfig` gains (both optional, defaulted):

```ts
export interface AppConfig {
  // ...all M1 fields unchanged...
  providers?: ProviderConfig[];   // when absent, M1 behavior: one synthetic Copilot provider
  routing?: RoutingPolicy;
}
```

`defaultConfig()` stays byte-compatible: if `providers` is absent the worker synthesizes
`[{ id:"copilot-default", kind:"copilot", enabled:true, priority:0 }]` so existing single-Copilot installs are
unaffected. **This keeps the freeze §config contract intact** — `modelMap` remains the global default remap.

### 10.2 Adapter factory (new, `providers/registry.ts`)

A `buildAdapters(providers: ProviderConfig[], creds: CredentialStore): ProviderAdapter[]` factory maps each
enabled `ProviderConfig` to a `ProviderAdapter` (freeze §4 interface, unchanged). `openai` and
`openai-compatible` share one OpenAI-shaped adapter (parameterized by `baseUrl`/`headers`); `anthropic` gets a
native Anthropic adapter; `copilot` is the M1 adapter. All four emit the **same canonical chunks** — the §5.4.1
streaming contract is provider-agnostic and is reused verbatim.

> Anthropic-as-a-provider note: when the upstream provider is itself Anthropic, the adapter still goes
> canonical→Anthropic-wire (reusing §5.5 / §5.4 shapes in the *outbound* direction). This is the mirror of the
> M1 inbound translator and must reuse the same block-index discipline (§5.4.1) on the *receive* side.

---

## 11. Priority-ordered routing with fallback

### 11.1 Selection

`Router.pick(model)` (signature unchanged from freeze §4 usage) returns an **ordered candidate list** internally
and tries them in `priority` order, skipping providers whose `models`/fuzzy-match (§13) can't serve the resolved
model. M1's `pick()` returning a single adapter becomes `pickChain(model): ProviderAdapter[]`; the existing
`pick()` is kept as `pickChain(...)[0]` for any M1 caller. **No frozen signature is removed.**

### 11.2 Fallback semantics

On an error from candidate _i_, the router consults `classifyError` (§9 adapter delta) + the `FallbackPolicy`:
- **retryable** → advance to candidate _i+1_; if the chain is exhausted, surface the *last* error.
- **fatal** → surface immediately, no fallback (e.g. malformed request, auth misconfig).

Fallback only applies to the **non-streamed** path and to the **pre-first-byte** window of the streamed path.
Once the worker has written the first SSE frame downstream, it CANNOT fall over to another provider
(the client has already begun receiving a message). This is a hard rule — mid-stream provider switch would
violate the §5.4.1 single-message framing contract. A pre-first-byte stream failure is treated like a
non-streamed failure and may fall over.

```ts
export interface FallbackPolicy {
  triggerOn: FallbackTrigger[];   // see FORK B
  maxAttempts: number;            // cap chain length, default = number of eligible providers
}
```

### FORK B — fallback trigger policy → **team-lead to resolve**

Which upstream errors advance the chain vs surface to the client?

- **Option B1 — 5xx + network/timeout only.** 429 (rate-limit) surfaces to the client. Rationale: 429 means
  "slow down," not "this provider is broken"; failing over hammers the *next* provider and can cascade
  rate-limits across your whole pool. Honors `Retry-After` by surfacing it.
- **Option B2 — 5xx + network/timeout + 429.** Treat 429 as retryable and fail over to the next provider.
  Rationale: with multiple real providers, a 429 on provider A is exactly when you *want* provider B; maximizes
  successful completions for the user.

**Recommendation: B1 for M2 ship, with the trigger list config-driven so B2 is a one-line opt-in.** 429-failover
has a real cascade-amplification risk across a shared pool, and B1 is the safer default; making `triggerOn`
configurable (`["5xx","network","timeout"]` default, add `"429"` to opt in) gives B2 to power users without
baking the risk in. This is a user-facing reliability tradeoff — flagging for your call / escalation to the user.

---

## 12. Credential encryption-at-rest

### 12.1 Store API (replaces `creds.ts`, same call shape)

```ts
export interface CredentialStore {
  get(ref: string): Promise<string | null>;
  set(ref: string, secret: string): Promise<void>;
  delete(ref: string): Promise<void>;
}
```

M1's `readGhToken`/`writeGhToken` become thin wrappers over `get("copilot:gh")` / `set("copilot:gh", …)` so
`worker/index.ts` and the login flow need no logic change — only the import. Secrets live in the SQLite
`credentials` table (spec §6) as ciphertext; the plaintext `creds.json` is migrated on first M2 launch
(read plaintext → `set()` → delete file) and a doctor check reports the migration.

### FORK A — encryption scheme → **team-lead to resolve (likely → user)**

- **Option A1 — OS-native keystore (DPAPI on Windows, libsecret/Keychain elsewhere), AES fallback.** Mirrors
  copilot-bridge. Secrets are sealed by the OS user account; no app-managed master key to store. Pro: strongest
  at-rest story, key never in our files. Con: native module / platform branches, headless-Linux (no libsecret)
  needs the AES fallback anyway, harder to test in CI.
- **Option A2 — AES-256-GCM with an app-derived key from a machine-bound secret** (e.g. key file at
  `~/.llm-maestro/keyring` mode 0600, or scrypt over a machine id). Pure-JS (`node:crypto`), uniform across
  platforms, trivially testable. Con: the key sits on the same disk as the ciphertext (defense is file perms +
  machine binding, not an OS vault), so it's "encrypted at rest" but not "sealed by the OS."

**Recommendation: A2 for M2 (uniform, testable, no native deps), with the `CredentialStore` interface designed
so A1 can be added as an alternate backend in M3 without touching callers.** Rationale: A1's real security gain
is partly negated because we still need the AES fallback for headless Linux, so we'd ship *both* anyway; A2 gets
us encryption-at-rest now with zero native-module CI pain, and the interface keeps A1 as a clean future backend.
This is a security posture decision — recommend you escalate A1-vs-A2 to the user, since it's their threat model.

> Whichever wins: secrets NEVER appear in logs (freeze §7 privacy invariant extends — request log already
> bans bodies; add: never log decrypted secrets, never echo `credentialRef` values, doctor reports presence
> not value).

---

## 13. Fuzzy model matching

### 13.1 Where it sits in resolution

Resolution order in `Router.resolveModel(requested)` becomes (first hit wins):
1. **Exact** `modelMap[requested]` (M1 behavior, unchanged).
2. **Per-provider `modelMap[requested]`** during candidate evaluation (§13.3).
3. **Fuzzy** match of `requested` against the union of providers' `models[]` (FORK D).
4. **`modelMap["*"]` fallback** (M1 behavior, unchanged).

Stages 1 and 4 are exactly M1; fuzzy is inserted as stage 3 so existing exact maps always win and nothing M1
relied on changes.

### 13.3 modelMap interplay (resolves a real ambiguity)

Global `modelMap` (AppConfig) is the **client-facing alias layer**; per-provider `modelMap` is the
**provider-specific id translation**. Precedence: client request → global alias (stage 1) → choose provider
(§11) → per-provider remap to that provider's actual id (stage 2). Example: client asks `claude-opus`; global
map aliases → `opus-4-8`; router picks the Anthropic provider; its per-provider map → `claude-opus-4-8-20260101`.

### FORK D — fuzzy-match strategy → **team-lead to resolve**

- **Option D1 — normalized substring + token-set scoring (no deps).** Lowercase, strip separators
  (`-`/`_`/`.`/spaces), match `requested` tokens as a subset of a candidate id, tie-break by shortest candidate.
  `"opus-4-6"` → tokens {opus,4,6} ⊂ `claude-opus-4-6-20260101`. Pro: deterministic, dependency-free, fast,
  easy to unit-test. Con: no typo tolerance (`"ops-4-6"` misses).
- **Option D2 — edit-distance ranking (e.g. Levenshtein/Jaro-Winkler, small lib or ~40 LoC).** Score every
  candidate, pick best above a threshold. Pro: tolerates typos and minor drift. Con: needs a threshold (ambiguous
  tuning), can surprise users by silently matching the "wrong" close model; nondeterministic-feeling.

**Recommendation: D1.** For model routing, a *predictable* match is worth more than typo-tolerance — silently
serving a different model than asked (D2's failure mode) is worse than a clean "no match → modelMap['*'] /
error." D1 is deterministic and testable; if a request doesn't fuzzy-resolve it falls through to the `*` fallback
(stage 4) exactly as M1 would. Keep a config flag `fuzzy: "strict" | "off"` so users can disable it entirely.

---

## 14. Provider-management control-API + data shapes (frontend implements TUI)

I spec the control-API surface and data shapes here per the freeze §2 style (bare object for reads of a single
resource; `{ items }` wrapper for collections — consistent with §2.1's status/doctor/requests asymmetry). The
TUI (`frontend`) renders against these; the supervisor (`backend`) serves them.

### 14.1 New control-types (`shared/control-types.ts`, additive)

```ts
export interface ProviderStatus {
  id: string;
  kind: ProviderKind;
  enabled: boolean;
  priority: number;
  healthy: boolean;          // last probe result
  detail: string;            // human-readable (e.g. "ok", "401 auth", "no credential")
  hasCredential: boolean;    // presence only, never the value (freeze §7)
}
export interface ProviderUpsert {  // request body for create/update
  id: string;
  kind: ProviderKind;
  enabled: boolean;
  priority: number;
  baseUrl?: string;
  models?: string[];
  modelMap?: Record<string, string>;
  headers?: Record<string, string>;
  // secret travels in a SEPARATE field, write-only, never returned:
  credential?: string;
}
```

### 14.2 Control-API endpoints (extends freeze §2.1 table)

| Method | Path | Body / Response |
|---|---|---|
| GET | `/api/providers` | `{ providers: ProviderStatus[] }` (collection → wrapped, per §2.1) |
| POST | `/api/providers` | body `ProviderUpsert` → `{ ok: true, id }` (secret stored via §12, never echoed) |
| PUT | `/api/providers/:id` | body `ProviderUpsert` → `{ ok: true }` |
| DELETE | `/api/providers/:id` | → `{ ok: true }` |
| POST | `/api/providers/:id/test` | probe upstream → `{ ok, detail }` (doctor-style) |
| POST | `/api/reload` | apply config changes to the worker (§15) → `{ ok, applied }` |

The assistant in-process tools (freeze §6) gain matching no-arg/typed actions (`list_providers`,
`add_provider`, `test_provider`, `reload_config`) so "slash ≡ assistant" parity (spec §4) holds.

**Secret-handling rule (frozen for M2):** `credential` is write-only on `ProviderUpsert`; `ProviderStatus` and
all GET responses expose only `hasCredential: boolean`. The control API still binds `127.0.0.1` only (freeze §7).

---

## 15. Config hot-reload

Providers/routing/model-map change without bouncing the worker process (and thus without dropping the
self-heal/restart history). The supervisor owns config; the worker must adopt changes.

### FORK C — hot-reload mechanism → **team-lead to resolve**

- **Option C1 — file-watch on `config.json`.** Supervisor (or worker) watches the file; on change, re-reads,
  validates, swaps the in-memory `AppConfig`. Pro: works even if config is edited by hand outside the TUI; simple
  mental model. Con: fs-watch is flaky across platforms/editors (atomic-save rename, double-fire, partial reads),
  needs debounce + validation-or-rollback, and the *source of truth* is split between the file and the
  TUI-driven SQLite settings.
- **Option C2 — control-API push + IPC to worker.** TUI/assistant POSTs `/api/reload` (or provider CRUD auto-
  triggers it); supervisor validates, persists to SQLite, then sends a new IPC message
  `{ type: "reload-config"; config }` to the worker, which atomically swaps its `Router`/adapters. Pro: single
  source of truth (SQLite), validated before apply, transactional, no fs-watch flakiness, and it's already the
  direction the daemon is wired (freeze §3 IPC). Con: hand-editing the file won't take effect until a reload is
  triggered (acceptable — TUI is the management surface per the spec's TUI-centric pivot).

**Recommendation: C2.** It fits the existing supervisor-owns-config + IPC architecture (freeze §3), keeps SQLite
as the single source of truth, and gives validate-before-apply with clean rollback — whereas C1 reintroduces
fs-watch edge cases and a split brain between file and DB. This requires **one additive IPC message** (freeze §3
change): `SupervisorToWorker |= { type: "reload-config"; config: AppConfig }`. That's a freeze §8 change to
`shared/ipc.ts` — additive (new union member), so M1 messages are unaffected; I'll update the freeze if C2 is
blessed. The worker swap must be atomic: build the new `Router`+adapters, then replace the reference, so in-flight
requests finish on the old chain and new requests use the new one.

---

## 16. Forks summary (for `team-lead` resolution)

| Fork | Decision | Options | My rec | Likely escalate to user? |
|---|---|---|---|---|
| A | Credential encryption scheme | A1 OS-keystore / A2 AES-256-GCM app-key | **A2** | Yes (threat model) |
| B | Fallback trigger policy | B1 5xx+net only / B2 also 429 | **B1** (configurable) | Yes (reliability tradeoff) |
| C | Hot-reload mechanism | C1 file-watch / C2 control-API+IPC | **C2** | No (architecture-internal) |
| D | Fuzzy-match strategy | D1 token-set / D2 edit-distance | **D1** | No (behavior, your call) |

**Cross-fork coupling to note:** C2 (recommended) needs the additive `reload-config` IPC message; that single
freeze §3 change is the only frozen-interface touch in all of M2 — everything else is purely additive new types.
If C1 wins instead, no IPC change is needed but we inherit fs-watch handling.

## 17. What I did NOT decide (per directive)

I did not pick A/B/C/D — each has 2 options + a recommendation above, routed to you. I did make the
non-forky, freeze-consistency calls (additive-optional config fields, reuse of the canonical hub + §5.4.1
streaming contract for new providers, the control-API envelope style, the secret-write-only rule, the
no-mid-stream-failover hard rule) because those follow directly from the M1 freeze and aren't genuine forks.
After you resolve the forks (and the user weighs in on A/B), I'll fold the decisions into this spec, then write
the M2 freeze delta (§9–§15 promoted to FROZEN) before any coding begins.
