# Changelog

## 1.0.0 — 2026-10-21

1.0 replaces the 0.1 engine with an **adaptive bidirectional orchestration**. The plan runs as a graph, and reviewer feedback flows back through it with four decisions, all backed by evidence:

- `FIX_LOCAL`: repair inside the affected node.
- `REPLAN`: a new plan, at most 2 per run.
- `BLOCK`: stop with a readable reason.
- `DONE`: only with passing real checks, an approving critic and the current contract identity.

### New

- **Five commands in a single runner:** `plan`, `clarify`, `tasks`, `implemente` and `init`.
  - Each repository has one plan slot and one tasks slot (the current feature).
  - Artifact reuse is checked; when it is refused, the reason goes to the journal.
- **Effort is only `--effort low|medium|max`.** The budget is counted per role (`bin/budget-policy.mjs`).
- **Roles and models fixed per host**, with no public flag:
  - Claude: Opus for planner, plan/design reviewer and critic; Haiku for executor, verifier and synth.
  - Codex: `gpt-6.1-sol` for the strong roles, `gpt-6-luna` for the operational ones.
- **Engine contracts:**
  - resuming gives no budget credit;
  - counters never go down;
  - replans are capped at 2;
  - DONE is denied without real checks, critic and current identity.
- **Trusted checks:**
  - only `node --test`, selected by the approved `inputs`, `outputs` and `files`;
  - the whole suite runs at the final gate, with concurrency 2.
- **Validated node manifests:**
  - paths must be relative to the repository;
  - an external input must exist and have a fingerprint (`external_inputs_unfingerprintable`);
  - an output must be inside `files`.
- **Provenance window with a cause:** `provenance_unsealed_window:<id> (cause: …)`.
- **runDir integrity, workspace lock and memory across runs**, selected by node and contract.
- **Isolated Claude host:**
  - `--strict-mcp-config`, `--disable-slash-commands`, `--setting-sources project,local` and `--permission-mode dontAsk`;
  - writes only inside the cwd (`Edit(./**)`);
  - a cwd under `.claude` is refused with `CWD_PROTECTED_PATH`;
  - permission denials come back in the result.
- **Real smoke test with write proof** (`write-probe.txt` with a nonce). It detects an executor that cannot write.
- **Real benchmark** (`bin/graph-benchmark.mjs`):
  - compares the normalized v1 logic with the adaptive one;
  - grades with external acceptance tests;
  - measures cost and tokens per call.
- **Portable plugin** for Claude Code (`.claude-plugin/`) and Codex (`.codex-plugin/`).

### Fixed

- The Claude executor wrote nothing: `dontAsk` without `allowedTools` denied every write.
- The smoke test gave a false PASS with a read-only worker.
- Context leaked from the user's environment into every call (about 75k tokens per turn). Isolation brought it down to about 6.5k, and the benchmark went from $88 to about $1.
- `APPROVE` with `affectedNodes` filled in was rejected: the schema now states the rule.
- Research without a shell stayed `partial` forever: research and design acceptance no longer require running commands.
- Free text in manifests turned into "input changed" (`provenance_unsealed_window`).
- A Claude error without `result` (`is_error`) lost the reason and the cost. The error now keeps subtype, messages, usage and model, and the benchmark records all of it.
- In polish, a failed area without a seal let the next one hide the real reason. The following areas now stop with the first one's reason.
- The planner could return an effort different from the one requested (`plan_effort_mismatch`). The schema only accepts the user's effort.
- A node redone by the critic's `FIX_LOCAL` did not get the critic's reason. It now gets it in the prompt.
- Without web access, research acceptance could require an external URL and stay `partial` forever. The `agentWeb` capability removes that requirement from the planner and the worker.
- Plan fixes and replans could rewrite `doneWhen` (`original_plan_criteria_changed`). `doneWhen` is now locked in the prompt and the schema on every path, and the same list in a different order is accepted.
- The critic could approve (`DONE`) answering only some of the criteria (`critic_done_evidence_invalid`). The schema now requires one item per criterion, with the text locked.
- The node verifier failed nodes for missing `npm test` evidence, which only runs at the final gate. The prompt now says the whole suite is left for the final gate and the node is judged by its local checks.
- A failed implement left the window unsealed, and polish in the other areas hid the reason behind `provenance_frontier_changed_before_window`. Polish now does not run and shows which node did not finish.
- In polish of an area with more than one node, each node was checked against the whole area's diff, and a neighbor's file counted as outside the grant. The window is now checked against the area's grant, and each node only by its own files.
- A dependent outside the area, revalidated in polish, inherited the old window's seal and its record won at the end (`node_record_stale_at_completion`). Revalidation now drops the inherited seal and seals the new window.

### Removed

- The 0.1 `effort × ceiling` flow: `manual`, `auto`, `high`, `maxAgents` and `economy`.
- The `graph-config` and `graph-resume` CLIs.
- The panel action queue: requests, listening session and the `POST /api/requests*` routes. The panel is now a live view only.
  - Removed `bin/requests.mjs`, `bin/ui/actions.mjs`, `bin/ui/commands.mjs`, `GET /api/listeners` and request consumption in `graph-watch`. The run now stops only on silence, and `events` exits right after FINISHED.
  - The artifacts drawer stays, read only (`bin/ui/artifacts.mjs`).
- The old `graph-eng:graph-eng` skill and `/graph-eng:painel` command. Use `init`.

### Benchmark

- Real run f366 (Claude): `DONE` with 10/10 external acceptance and no false DONE, in 21 calls, for $0.80. The strong model accounts for about 95% of the cost. Details in `docs/validation/graph-eng-2-benchmark.md`.

### Known limits

- The real Codex host (smoke and benchmark) has not been validated yet. Only Claude has real evidence.

## 0.1.0

First release: 0.1 engine with a web panel.
