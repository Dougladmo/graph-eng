# Changelog

## 1.2.0 — 2026-10-23

### Changed

- **On Claude, the advisor flow now routes by complexity by default (`--haiku-max low`).** Haiku takes the steps the planner marks `low`; everything else stays on Sonnet. `--haiku-max off` or `--executor sonnet|haiku` restore a single implementer session. Codex does not route.

### Added

- **`--haiku-max low|medium|off` in the advisor flow.** The planner marks each step `low`, `medium` or `high`; steps up to the given level go to Haiku and the rest stay on Sonnet. Consecutive steps on the same model share one session, all sessions keep the Opus advisor and share its budget of 3 calls, and a gate repair runs as one full Sonnet session.
  - Minecraft MVP benchmark (23/10): 55/55 and the game on screen in both runs; `medium` cost US$ 1.66 in 752 s, `low` US$ 1.59 in 617 s.

## 1.1.0 — 2026-10-23

### Added

- **Advisor flow (`grapheng implemente <task> --flow advisor`).** A short alternative to the graph for tasks a single implementer can carry:
  - 1 planner (Sonnet, read-only) and 1 plan review (Opus, read-only). A `REVISE` does not open another round: its notes go straight to the implementer.
  - 1 continuous implementer session (Sonnet, with `--advisor opus`) writes all the code with the whole context. Its Bash runs only `npm test` and `npm run build`, and it may consult the Opus advisor at most 3 times.
  - The supervisor's external gate (`npm test` and `npm run build`) ends the run. If it fails, the implementer gets one more session with the failure output, up to 2 sessions.
  - Cost is split into input, cache write, cache read and output, and advisor calls are counted from the session transcript.
  - Minecraft MVP benchmark (22/10): 55/55 hidden tests and the game on screen, for US$ 1.79 in 662 s, against US$ 5.97 and 1375 s for the single Opus agent.
- **`--executor haiku` in the advisor flow.** Swaps only the implementer model; planner and plan review stay the same, and Opus stays the advisor. Accepts `sonnet` (default) or `haiku`, on the Claude host only.
  - Minecraft MVP benchmark (23/10): 54/55 and the game on screen, but US$ 2.33 in 1222 s. Haiku called the advisor once (US$ 1.21 of Opus) and needed far more turns, so Sonnet stays the default.
- **Adaptive flow (tiers).** The runner triages each task before planning and picks `fast`, `standard` or `full`. Simple tasks no longer go through every review:
  - `fast`: the planner reads the code itself, with no research nodes, no design and a synthetic plan review. Implement, checks, verify, the final critic and synth always run.
  - `standard`: adds the real plan review on Opus.
  - `full`: research, design and both reviews, as before.
  - The engine can only raise the tier, never lower it. It raises it when the planner says `complex`, when the plan is over the tier's node cap, or when a `risk: high` node, a design node or a research node shows up.
  - The tier is recorded in the journal and in the published artifact. Reuse rejects an artifact with a lower tier (`reuse_tier_lower`).
  - On by default for pipeline runs. `--adaptive off` or `GRAPH_ENG_ADAPTIVE=off` restore the full flow. Changing it on resume blocks with `resume_adaptive_changed`.
- **Optional complexity classifier (Jev 1.13 via OpenRouter).**
  - Opt-in only. Configure it with `node bin/graph-run.mjs triage-config`, which reads the key from stdin into `~/.graph-eng/config.json` (0600, outside any git repo), or set `OPENROUTER_API_KEY` together with `GRAPH_ENG_TRIAGE_CLASSIFIER=on`.
  - It makes two calls with the options in reversed order. If the answers disagree, or the call times out or fails, the heuristic applies.
  - It can only raise the tier, except standard to fast at high confidence with no hard signal.
- **Research stage.**
  - On Claude, research nodes get `WebSearch` and `WebFetch`. Only the read-only researcher has web access.
  - Research nodes run in their own wider lane: twice the effort width, capped at 4.
  - A Haiku notetaker merges the findings of two or more research nodes, conflicts included, for the decomposer.

### Changed

- **Model roles on Claude.** Opus only reviews: the plan and the design.
  - Sonnet plans, researches (new `researcher` role), designs (new `designer` role) and runs the final critic.
  - Haiku implements, verifies, writes the research notes (new `notetaker` role) and synthesizes.
  - In the chess benchmark (21/10), four Opus calls were 89% of the run cost and did not improve acceptance.
- **Reasoning effort reaches the CLI.** The workflow already asked for an effort per call, but the Claude adapter dropped it. It is now passed as `--effort`.
  - Every role defaults to `medium`.
  - `--effort max` raises only the strong roles, the escalation vote and high-risk nodes to `high`.
- **No duplicate plan review in `implemente`.** The plan stage no longer reviews its research-only plan, because the tasks stage reviews the full implementation graph.
- **Polish runs only with `--effort max`.** Each polish area used to reopen verification for all of its nodes (about 6 minutes in the chess run) only to fix style.
- **Smaller graphs and a leaner critic.**
  - Planners are told to prefer 2–4 cohesive implement nodes.
  - The final critic gets a reading budget instead of re-reading the repository.

### Fixed

- **The design review now repairs a node that has several blocking items.** The repair gate expected one blocking item per node, so a FIX_LOCAL with two items on the same design node failed closed with `feedback_scope_invalid` and never tried the repair. Seen in the faturamento benchmark (21/10).
- **In the lean plan stage, implement or design nodes sketched by the planner become findings** instead of blocking the run with `plan_stage_non_research_node`. The tasks stage builds the real nodes. Seen in the chess benchmark (21/10).
- **The plan stage no longer writes done criteria about the research.** With no user criteria, the planner wrote `doneWhen` such as "each contract has its rules listed with file:line". Those criteria stay locked until the final critic, which then asked the implementation for a record that no node could write, and the run blocked with `critic_fix_incomplete` while external acceptance was 31/31. The prompt now says `doneWhen` describes the finished task, never the research. Seen in the faturamento benchmark (21/10).
- **The task decomposer gets the manifest rule.** Its prompt did not say that `files`, `inputs` and `outputs` take one file path per entry, so it listed the `data/` folder and the run blocked with `invalid_dag` before any node ran. Both planner prompts now also say "no directories". Seen in the faturamento benchmark (21/10).
- **A local plan correction can now add or remove deps of a node the reviewer named, while that node has not run.** The reviewer asked "N2 depends on N1" as FIX_LOCAL; the correction did exactly that and the run blocked with `local_plan_correction_changed_structure` before any node ran. Deps of nodes the reviewer did not name, or of nodes that already ran, stay locked. Seen in the Minecraft MVP benchmark (21/10).
- **The plan stage is told that goal and doneWhen are about the whole task, not the research stage**, with a bad and a good example. The earlier sentence was not enough: Sonnet still wrote goal "Investigation plan…" and doneWhen "the engine contract is mapped to each stub". Seen in the Minecraft MVP benchmark (21/10).
- **Each pipeline stage gets its own pool of 2 local repairs.** The pool used to carry across plan, tasks and implement, so the Minecraft benchmark blocked in the plan stage (critic plus two plan reviews) before any code ran. A stage now starts with the pool empty; the boundary carry still records what the previous stage spent, and resume resets the counter at the boundary instead of reading it as `resume_control_counters_decreased`. Structural replans still carry over.
- **Code nodes get their own repairs.** The run's pool of 2 local repairs was shared by plan, design and code, and in the Minecraft benchmark plan and design spent it before any code node failed verify, so the node stopped with no repair. An implement node now repairs up to the per-node limit (2) without touching the pool, and the budget sets aside one repair (1 executor + 2 verifier calls) per pending implement node. Research and design repairs still share the pool of 2.
- **A node the verifier rejected now says why in the block reason.** A failed node returned without a note, so the next node hit `provenance_unsealed_window:<id> (causa: sem nota registrada)`. The note now lists the verifier's issues and why repair stopped: no progress, no budget slots, or the run's local repairs used up (2/2).
- **A run blocked by the final critic now carries the reason.** The final result had no top-level `feedback`, so `run.finished` recorded `feedback: null` and the benchmark only saw `engine_blocked`.
- **Design and research nodes keep receiving the worker's memory** after moving to the new `designer` and `researcher` roles.
- **Benchmark tests no longer fail inside `.claude/worktrees/`.** Their workspaces were created inside the repository, so in a worktree under `.claude` the `CWD_PROTECTED_PATH` guard refused the writer role before the spawn. They now live in the system temp directory.
- **Agents and trusted checks no longer inherit graph-eng secrets.** Child processes used to inherit the whole environment. They now get it without `OPENROUTER_API_KEY` and without `GRAPH_ENG_*`.

- **A local plan correction no longer blocks when the reviewer names a node it left out of `affectedNodes`.** The correction may now change every node the reason names, and its prompt lists those nodes. The plan reviewer is also told that `doneWhen` is locked and that `affectedNodes` must list every node it asks to change.
  - Seen in the chess benchmark (21/10): the reviewer asked for a change to N1 but listed only N2, so the run stopped with `local_plan_correction_changed_structure`.

### Compatibility

- Checkpoints from before this release do not resume, because the engine source hash changed. Start a new run.

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
