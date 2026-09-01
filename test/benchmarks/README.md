# AB official benchmark integration

These adapters preserve the official task definitions and evaluators. They do not replace WebArena-Verified or VisualWebArena with AB-authored pages or scoring logic.

The browser always remains AB's local persistent headed Chrome. Benchmark websites may run locally or on an official remote environment such as the recommended WebArena/VisualWebArena AMI. This separation is intentional: the Rust daemon owns Chrome and CDP; the benchmark provisioner owns website state and reset.

## Sources and suites

- MiniWoB++ reads the official pages from `~/third-party/miniwob-plusplus` and is only a basic interaction suite.
- WebArena-Verified Hard reads the official 258-task subset and invokes the official `webarena-verified eval-tasks` evaluator against `agent_response.json` and AB's `network.har`.
- VisualWebArena reads the official 910-task JSON and input images, then invokes the official evaluator router for `url_match`, `string_match`, `program_html`, `page_image_query`, and their combinations. The evaluator attaches to the exact AB target only after the Agent finishes; Playwright and captioning dependencies belong to the independent benchmark process, never the AB product or Agent operation chain.
- AssistantBench validation is supplemental open-web coverage. It is not part of the default doctor and cannot substitute for WebArena-Verified Hard or VisualWebArena.

## Environment boundary

The official WebArena package provides a Docker backend. On macOS, the local provisioner uses the active Colima Docker context. It keeps the fast VZ virtual machine but executes the official `linux/amd64` WebArena images through Colima's QEMU binfmt handler. Rosetta is disabled for these environments because its Linux `mmap(MAP_FIXED)` behavior crashes PHP Opcache/FPM; QEMU preserves the required syscall behavior. An already running official remote environment remains supported through explicit URL and env-control pairs.

The local default is 6 CPUs, 10 GiB memory, and a 60 GiB sparse disk. Override it before the first start with `AB_COLIMA_CPUS`, `AB_COLIMA_MEMORY_GIB`, and `AB_COLIMA_DISK_GIB`. The provisioner activates the `colima` Docker context explicitly; it never silently uses Docker Desktop or another context.

The WebArena session coordinator applies the optimized images' official header authentication before navigating each owned task tab. Local defaults come from the official development images. Override them for a differently configured environment with `AB_WEBARENA_SHOPPING_ADMIN_AUTH`, `AB_WEBARENA_SHOPPING_AUTH`, and `AB_WEBARENA_REDDIT_AUTH`; each value is the credential payload expected by that image's documented auto-login header.

Configure remote WebArena sites with both the public site URL and env-control URL:

```bash
export AB_WEBARENA_SHOPPING_URL=https://shopping.example
export AB_WEBARENA_SHOPPING_ENV_CONTROL_URL=https://shopping-control.example
export AB_WEBARENA_SHOPPING_ADMIN_URL=https://admin.example
export AB_WEBARENA_SHOPPING_ADMIN_ENV_CONTROL_URL=https://admin-control.example
export AB_WEBARENA_REDDIT_URL=https://reddit.example
export AB_WEBARENA_REDDIT_ENV_CONTROL_URL=https://reddit-control.example
export AB_WEBARENA_GITLAB_URL=https://gitlab.example
export AB_WEBARENA_GITLAB_ENV_CONTROL_URL=https://gitlab-control.example
export AB_WEBARENA_WIKIPEDIA_URL=https://wikipedia.example
export AB_WEBARENA_WIKIPEDIA_ENV_CONTROL_URL=https://wikipedia-control.example
export AB_WEBARENA_MAP_URL=https://map.example
export AB_WEBARENA_MAP_ENV_CONTROL_URL=https://map-control.example
```

VisualWebArena can override its three suite-specific sites independently. Its Wikipedia tasks use the WebArena Wikipedia URL and env-control pair above:

```bash
export AB_VISUALWEBARENA_CLASSIFIEDS_URL=https://classifieds.example
export AB_VISUALWEBARENA_CLASSIFIEDS_RESET_TOKEN=...
export AB_VISUALWEBARENA_REDDIT_URL=https://reddit.example
export AB_VISUALWEBARENA_SHOPPING_URL=https://shopping.example
export AB_VISUALWEBARENA_HOMEPAGE_URL=https://homepage.example
export AB_VISUALWEBARENA_PYTHON=/absolute/path/to/visualwebarena/.venv/bin/python
```

Reddit and shopping fall back to the corresponding WebArena URLs. Classifieds reset uses the official reset endpoint and token before a session. The evaluator Python must contain the official VisualWebArena requirements and Playwright package. `page_image_query` additionally loads the official captioning model; override its official model/device selection with `AB_VISUALWEBARENA_EVAL_CAPTION_MODEL` and `AB_VISUALWEBARENA_EVAL_DEVICE`. Some official `string_match` configurations use the repository's LLM judge and therefore require whatever credentials that official evaluator requires; AB itself never consumes them.

## Commands

Inspect one suite without triggering downloads or probing unrelated suites:

```bash
bun test/benchmarks/cli.ts doctor webarena-verified-hard
bun test/benchmarks/cli.ts doctor visualwebarena
bun test/benchmarks/cli.ts list webarena-verified-hard
bun test/benchmarks/cli.ts task webarena-verified-hard 97
```

Reset/start one configured official environment:

```bash
bun test/benchmarks/cli.ts start webarena-verified-hard shopping
bun test/benchmarks/cli.ts start visualwebarena classifieds
```

Run a session coordinator before handing the task to an unfamiliar Agent:

```bash
bun test/benchmarks/miniwob-ab-session.ts click-test /absolute/output/root
bun test/benchmarks/webarena-ab-session.ts 97 /absolute/output/root
bun test/benchmarks/visualwebarena-ab-session.ts classifieds:0 /absolute/output/root
```

The forward MiniWoB++ campaign is a pressure matrix, not a replacement evaluator or a collection of AB-authored demo pages. It selects 11 official tasks across 11 interaction families: multi-target selection, disclosure navigation, heterogeneous form sequences, autocomplete plus datepicker, stateful mail and social applications, relational table reading, terminal-style keyboard input, drag and drop, hover-driven UI, and visual coordinate input.

Inspect the exact cases, run each selected task through the same coordinator above, and aggregate only the official results written by those sessions:

```bash
bun test/benchmarks/cli.ts campaign miniwob++
bun test/benchmarks/miniwob-ab-session.ts email-inbox-star-reply /absolute/output/root
bun test/benchmarks/cli.ts campaign-report miniwob++ /absolute/output/root
```

The report does not infer success from screenshots, logs, browser readiness, or AB traces. Missing `evaluation.json` is `not-run`; malformed evidence is `invalid`; a completed episode passes only when the official page result has positive raw reward. `complete: true` means every campaign case passed, not merely that every case was attempted.

The MiniWoB++ coordinator mirrors BrowserGym's episode setup before handing control to the unfamiliar Agent: it removes the human START overlay, installs the seeded episode RNG, sets BrowserGym's 1,000,000 ms page episode limit by default, calls the page's official `startEpisodeReal()`, and reads the generated intent from the running episode. The Agent therefore performs only the task; it never searches for or presses START. The coordinator never performs task actions. It waits for the page's own reward and done state, then independently writes `evaluation.json` and `network.har`. `AB_MINIWOB_SEED` and `AB_MINIWOB_EPISODE_MAX_TIME_MS` make episode generation explicit when needed; `AB_MINIWOB_AGENT_TIMEOUT_MS` is only the outer source-blind Agent deadline. Neither deadline nor a coordinator timeout can become a passing result.

When a VisualWebArena coordinator emits `SESSION_READY`, complete the task and write one JSON line to its stdin: `{"answer":""}` for action-only tasks or the requested textual answer for retrieval tasks. That answer becomes the official stop action; the coordinator does not infer it from logs or page text.

The coordinator splits the official ` |AND| ` start-page syntax and opens every official `start_url` before emitting `AB_*_SESSION_READY`. Multi-site WebArena Hard and VisualWebArena tasks therefore expose multiple tab ids, and the HAR recorder merges their independent network Resources into one evaluator input. The benchmark session also owns tabs created after the task begins, attaches a Network observer when each appears, includes the live task-owned set in cleanup, and lets VisualWebArena evaluate whichever task-owned tab is active when the Agent finishes. A dynamically discovered tab is listed in `lateAttachedTargets` and makes HAR `complete` false because requests emitted before attachment cannot be reconstructed. Pre-existing persistent-profile tabs remain outside the benchmark session. The Agent receives the task intent and installed AB Skill, not project source, declarations, task evaluation data, or benchmark implementation.

`SESSION_READY` is not success. Success exists only after the Agent response, captured HAR/final state, and official or implementation-independent evaluator produce the passing result.
