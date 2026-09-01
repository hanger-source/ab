# Source-backed Mechanism Matrix

矩阵只写已由当前 ref 源码确认的机制。它按问题分组，不给项目做笼统排名；同一个项目可能在一个层面值得借鉴，在另一个层面正好是反例。

`Legacy baseline` 行只记录已冻结的 extension/relay/JavaScript SDK 旧实现，不代表 AB 目标架构。AB 的 Rust daemon、Unix socket、专用持久 Chrome 和 TypeScript SDK 见目标架构与实施计划。

## Existing Browser And Target Identity

| Project | Existing user browser | Public target identity | Child frame/session | Missing/stale target | Concurrency/ownership |
|---|---|---|---|---|---|
| Legacy baseline | extension connects current Chromium | Chrome tabId / TabHandle | extension CDP session manager；read path 仍有 root-session 边界 | tool error，部分动作路径语义仍需统一 | relay multi-client + debugger owner/refcount；group 不是强 lease |
| WebDriver Classic | remote end owns browser session | session + current browsing context + element reference | explicit switch-to-frame context | unknown element and stale active-document element are different errors | input state scoped by top-level browsing context |
| Playwright MCP relay | extension connects Chrome/Edge | Playwright Page over synthetic `pw-tab-N` session | tab owns real child sessionId set | Playwright page/frame lifecycle | one extension and one CDP client；attach state explicit |
| Chrome DevTools MCP | attach or launch Chrome | per-page wrapper + selected page | delegated to Puppeteer | snapshot UID detached/missing hard-fails | Puppeteer page operation scope |
| agent-browser | connect CDP or daemon-owned browser | stable non-reused `tN` + label | frameId to OOPIF session map | backend id failure triggers implicit requery；connect separately probes renderer liveness | daemon command path |
| OpenChrome | attach/launch real Chrome | targetId + registry | explicit target/session registry | ref relocation exists | ownership/lease registry + per-target queue |
| PinchTab | attach/launch Chromium instance | managed tab id + CDP target | AX fetched per frame; tab has chromedp context | ref miss hard-fails; text selectors may heuristically choose | TTL tab lock + same-tab serial/cross-tab bounded executor |
| OpenCLI | extension connects one or more existing Chrome profiles; direct CDP for Electron | cross-layer CDP targetId; tabId stays extension-local | frame list/index is explicit; direct CDP path selects one inspectable page target | identity cache miss refreshes `getTargets` then hard-fails; page wrapper may retry one navigation after dropping stale targetId | profile route + target lease + separate persistent-adapter write lease |
| Browser Harness runtime | one persistent browser-level CDP connection to existing Chrome | raw targetId plus one mutable current session | flattened page session; iframe target gets a separately attached session | stale current session silently re-attaches the first real page | one daemon connection; no per-target ownership or multi-consumer event isolation |
| mcp-chrome | extension controls current Chrome | Chrome tab/tool args | tool-specific | tool-specific | native host request map; no unified target lease found in inspected chain |
| nodriver | launch or connect remote-debugging browser | targetId-backed Tab/Element | child target gets own flattened session/Connection | Element update follows same backendNodeId; CDP miss surfaces | send lock plus concurrent pending futures; no per-command deadline |
| DrissionPage | connect existing remote-debugging Chromium | targetId-backed ChromiumTab | flatten session with session owner routing | target/session destroy cleans registry; convenience lookup may pick first match | concurrent pending queues on one receiver thread; per-command deadline |
| Karate UI | launches/attaches CDP browser in owned context | targetId + browserContextId + loader/document state | context-scoped target enumeration | stale/superseded loader is rejected by document readiness | pooled slot owns isolated browser context |
| Lightpanda | provider owns non-Chromium browser server | page session + stable frame id | current implementation has explicit browser/page sessions | old/new Page coexist until navigation commit | connection owns worker; page owns document arena |
| Obscura | provider owns independent V8/DOM/network browser server | page target + attached CDP session + stable main frame id | explicit browser contexts and per-session page routing; current frame tree is limited | navigation prunes old execution contexts and assigns fresh isolated-world ids | one OS thread and V8 lock per connection; explicit connection admission cap |
| Camoufox | provider owns patched Firefox | Juggler page target + browser context | browserId joins chrome target and content actor | either side may arrive first; registry binds by identity | browser context maps to Firefox container identity |
| Electron | application owns embedded Chromium WebContents | WebContents id + DevTools target id | stable FrameTreeNode slot + current exact RFH token + child CDP session | disposed frame and unknown target hard-fail; speculative RFH not exposed as active frame | host owns renderer/surface; Electron debugger can coexist with DevTools frontend |

Key distinction:

- stable high-level object does not remove session/frame identity;
- same-tab serialization, target ownership and debugger attachment are separate states;
- implicit target re-selection may increase success rate while reducing factual confidence.

## Embedded Host Capability Surface

| Project | Host-owned unit | Page execution / preload | Input / screenshot | Network/session | Main boundary |
|---|---|---|---|---|---|
| Electron | Chromium WebContents + WebFrameMain + BrowserContext | frame-bound execute; main/isolated world; id-scoped frame/service-worker preload | direct RenderWidgetHost input; offscreen path; target surface capture | partitioned session; typed webRequest lifecycle; DevTools client | webRequest has one listener per event and no response-body channel; extension APIs do not inherit every host ability |
| CEF | embedded Chromium browser + frame + request context | frame-bound raw JavaScript/DOM visitor; in-process DevTools protocol | host RenderWidget input; BGRA dirty-rect paint or callback-scoped native texture | frame-associated request handlers; DevTools attach/detach observer | host must own pixel copies and UI-thread lifecycle; CEF capability does not flow through a Chrome extension automatically |
| Tauri | platform WebView behind runtime dispatcher | init script for main/all frames; eval and JSON callback | focus/first-mouse are provider-specific; no common protocol input or surface screenshot API | data store/proxy/custom protocol are platform-scoped | no public target/session/document/node identity; WebView host is not an automation runtime |

Key distinction:

- sharing Chromium does not make Electron WebContents, WebView2, Chrome extension and CDP providers behaviorally equivalent;
- host-level input/surface access can work without desktop active-tab routing, but that property must not be projected onto providers that expose only extension APIs;
- a stable frame slot still needs an exact current renderer/document identity.

## Observation And Action

| Project | Primary observation | Supplement | Action engine | Wait/completion model | Main boundary |
|---|---|---|---|---|---|
| Legacy baseline | CDP DOM + AX + DOMSnapshot + layout serializer | page listener/interactive facts | DOM semantic, backend node, CDP Input and content script paths | caller `waitFor`; tool-specific waits; capture scopes | OOPIF/session coverage and action semantics must stay explicit |
| Playwright | locator-driven DOM/AX access | engine-specific protocol adapters | actionability + input dispatch | locator auto-wait, navigation/load states | usually owns/attaches full browser endpoint |
| Puppeteer | frame/world handles and locators | CDP target/session | locator/element/input | locator conditions；worker evaluate waits for workerScriptLoaded | Chrome/CDP-first |
| ChromeDriver | frame-aware WebView and DevTools client | loader/context and element reference conversion | WebDriver actions over CDP/Input | tri-state navigation tracker; dialog-aware; generation recheck | browser remote end, not a reusable locator SDK |
| WebKit WebDriver | current top-level/frame context and browser-side automation | realm/context events and structured element references | UIProcess simulated input dispatcher | page-load strategy plus context resolution; presentation-aware screenshot | provider internals differ from Chromium target/session |
| Browser Use | DOMSnapshot/AX/paint composite | clickability/visibility serializer | node scoped actor | browser/session task runtime | rich serializer can obscure source unless metadata retained |
| Stagehand | a11y snapshot + per-frame session registry | coordinate/locator resolvers | per-call selector resolution + CDP box/input | loader-aware lifecycle watcher; separate best-effort DOM/network settle | snapshot id becomes XPath, so same-node identity is not preserved |
| Page Agent | in-page DOM traversal | visibility/cursor/onclick/tabindex heuristics | direct Element DOM actions/events | caller/page logic | current document references, no protocol session identity |
| Chrome DevTools MCP | Puppeteer AX snapshot | optional extra DOM handles | Puppeteer Locator | possible navigation + 100ms DOM stability | DOM stability is not business completion |
| PinchTab | per-frame full AX tree | selector and semantic metadata | backend node/CDP operations | tool-specific timeout | fuzzy text/proximity convenience can change selected target |
| Taiko | in-page text/CSS/XPath/shadow traversal | geometric proximity | runtime object + CDP handlers | registered XHR/frame/navigation events + readyState | high-level intent requires broad heuristics |
| TestCafe | injected DOM/runtime state | real hit-test, position, motion | scroll/move/input simulation | separate action promise and request/script/unload barriers | proxy/injection architecture defines what it can observe |
| Cypress | command subject and DOM state | action coordinates, hit-test, command snapshot | staged actionability then synchronous dispatch | idempotent query retry; each action dispatches once | runner controls page and command queue; not an external-browser driver |
| Capybara | driver query result | explicit text/visibility/spatial filters | driver element action | retries only declared invalid-element errors and not-found | selector match policy remains caller-visible |
| Karate UI | CDP document/frame state | optional high-level text candidate set | CDP/DOM driver actions | explicit retry timeout plus loader-aware readiness | extension ranker fallback can hide whether custom ordering ran |
| SeleniumBase | nodriver/CDP element facade | auto CSS/XPath/text interpretation | mouse click, then hidden DOM-click fallback | fixed waits and broad exception conversion | convenience improves script success while compressing evidence |
| SikuliX | repeated screenshot of a caller-defined desktop Region | image template/OCR, similarity score and last-seen rect | OS mouse/keyboard at resolved coordinates | scan-rate polling over fresh captures | no browser/tab/frame/document/node identity; every retry may select a newly similar visual target |

Key distinction:

- AX、DOM、layout、listener、screenshot are different evidence sources;
- action sent and action effects settled are different phases;
- a universal text/proximity click helper would hide selection policy, so these mechanisms are better treated as caller-composed logic unless the contract is narrow and provable.
- an in-page `index -> Element` map reduces caller code but still needs an explicit document generation contract; otherwise a compact index hides stale identity rather than solving it.

## Network Observation Scope

| Source | Observation boundary | Identity | Completion model | Body / streaming | Main blind spot |
|---|---|---|---|---|---|
| Legacy baseline CDP capture | attached tab/target sessions | tabId + CDP request/session facts | explicit capture start/stop plus request lifecycle | response body is a separate availability state | unattached child target and capture lifecycle can make zero events ambiguous |
| Page fetch/XHR hook | one page realm and installed wrappers | caller-defined document/script marker | hook callbacks defined by page script | can inspect application-level args/results | late install, cached references, worker/frame/other transport can bypass it |
| WebDriver BiDi network | remote-end browsing contexts | request plus context/navigation scope | typed network events and subscriptions | protocol/remote-end dependent | implementation coverage differs by browser remote end |
| mitmproxy | client/server protocol connections outside browser | flow UUID + connection/protocol/message direction | headers, full body, response-or-error, WebSocket close | streaming may reorder response before full request; native flow preserves state | no inherent tab/frame/document/action identity |
| Lighthouse network recorder | attached target fan-in during gather | sessionId + targetType + request id | gatherer/target lifecycle | collector-specific body/timing data | observation is scoped to an owned gather run, not arbitrary live browser history |

Key distinction:

- no source is an authoritative complete page API list;
- a zero result is meaningful only with source, target scope, lifetime and completeness facts;
- browser-level and proxy-level network visibility do not by themselves provide action attribution.

## Session And Resource Lifecycle

| Project | Resource unit | Admission | Runtime states | Timeout ownership | Cleanup/failure |
|---|---|---|---|---|---|
| Legacy baseline | existing browser + explicit tab/group scope | relay accepts clients; no browser capacity queue | server, extension, client, pending, debugger owner | CLI/SDK/tool timeout layers | caller closes owned tabs; relay/extension reject pending on disconnect |
| Geckodriver | one WebDriver session + owned/remote/existing Firefox | one connection guarded by handler mutex | no connection, connecting, handshaking, session active, deleting | 60s connect budget with 100ms process-aware checks; command-specific WebDriver timeouts | existing browser no-op; deleted session waits for graceful shutdown, then force kill; profile/minidump cleanup follows ownership |
| ChromeDriver | WebDriver session + session thread + browser/tab/child WebView | session created before commands route to its thread | session live/quit; target attached/detached; navigation and active-page state | command, page-load and stop-loading cleanup budgets are separate | crash/disconnect marks session quit; async action retains actual child holder |
| WebKit WebDriver | one active remote-end Session + SessionHost/browser connection | reject second session unless explicit replace policy | connecting, connected, replacing/closing, disconnected; per-page action run | script/page-load/action/presentation callbacks retain own completion | remote browser ownership differs; page close cancels input and flush callbacks |
| Browserless | server-owned browser session | Limiter executing/waiting/queue limit；reconnect bypasses new-session limit | queued, launched, connected, reconnecting, closing | queue wait and execution clocks are separate | registry removal before close; unexpected disconnect propagation; serialized temp profile cleanup |
| Selenium Grid | WebDriver session on Node slot | new-session queue + Distributor slot reservation | queued, reserved, registered/routable | session pageLoad + node timeout determine proxy read timeout | failed start releases slot; SessionMap is route fact source |
| Selenoid | browser container/driver session | limit, queued, pending, used channels | startup attempt, created, idle, deleting | create attempt + session idle timeout | Drop/Create/Release transitions; DELETE unifies explicit and timeout cleanup |
| Crawlee BrowserPool | browser controller + page | limiter + per-browser page capacity | starting, active, retired, closed | launch/page operation timeout; idle retirement | post-launch/page-create failure cleanup; retired closes after pages |
| PinchTab | managed instance/tab | max tab/parallel policies | tracked tab, accessed/current, closed | create, initial navigate, operation context | per-tab state cleanup hooks; last-tab guard |
| Steel Browser | one server-owned browser + active session | single active session in inspected service | idle, live, released; per-target instrumentation sessions | launch/shutdown and plugin lifecycle | end hooks, context reset, target detach, idle browser relaunch |
| Appium | WebDriver session + inner driver | capabilities select driver; pending drivers are separate | creating, registered, active, unexpectedly closed/deleted | per-session command queue plus command-idle timeout | register after create; unexpected shutdown rejects active command; plugin chain reports handlers |
| Browsertrix Crawler | PageWorker + Page + CDPSession | explicit worker count and crawl queue | new/reused, active, crashed, closed | new-window, page task, teardown and close own deadlines | current-page event guard; same-origin reuse; worker failure isolation |
| k6 Browser | browser connection + target session inside VU/iteration | workload scheduler owns execution | connection, session, frame, navigation barrier | command context and navigation timeout are separate | session/connection done cancel pending work; metrics retain workload context |
| Vitest Browser Mode | test project + provider browser/context/page | test scheduler and project configuration | prewarming, resolving, active, closing | test/command/provider timeouts remain separate | warm instance adopted only under identical launch options; close hook owns unused instances |
| OpenCLI | browser profile + owned/borrowed target lease + command-run write lease | live profile route; write lease acquired before extension dispatch | extension worker recovering, lease active/idle/persistent, command pending/done/lost | one absolute deadline crosses client, daemon and extension; target idle timer starts after command completion | `storage.session` recovery only within one browser session; read remains available during write; stale runtime ids are never recovered across reload/restart |
| Obscura | CDP connection + connection-local browser contexts/pages | atomic max-connection reservation | accepted, active, refused, closing/draining | per-command isolate watchdog plus navigation/settle limits | slot guard releases admission on every thread exit; shutdown drains connections before persisting cookies |

Key distinction:

- allocation, execution and ownership cannot share one `busy` boolean;
- registration should happen only after resource creation succeeds;
- timeout belongs to the operation that can legitimately block, not to an arbitrary transport default;
- AB daemon owns one dedicated Chrome lifecycle but not a browser pool；client disconnect 只能回收本 client resource，不能照搬按 session 销毁 browser/profile 的 cleanup。

## Command Transport And Diagnostics

| Project | Pending correlation | Ready confirmation | Disconnect handling | Logging projection |
|---|---|---|---|---|
| Legacy baseline | relay server id + SDK request id | extension handshake/status + host process facts | relay and SDK reject pending; JSONL stage trace | large/full data to outputFile, returned summary carries path/hash/bytes |
| Geckodriver | monotonically increasing Marionette id; one in-flight command | TCP connect then gecko/protocol-v3 handshake | framing/write/decode/session errors tear down connection | strict out-of-sequence rejection plus process pid/exit status during startup |
| ChromeDriver | CDP command id to response-info map inside a serial WebDriver session thread | target/session attach plus renderer-side frame/context readiness | target crash/detach/disconnect becomes typed status and can terminate session | method/id/session plus navigation/dialog/loader/context failure stage |
| WebKit WebDriver | SessionHost pending callbacks bound to the captured Session instance | exact session id, live browser connection and resolved browsing context | browser disconnect flushes pending requests and breaks callback cycles | typed no-such-frame/no-such-window/prompt errors preserve state scope |
| Chrome Remote Interface | integer id map, optional sessionId | WebSocket open | reject all callbacks | raw protocol |
| Pydoll | integer id to Future, per-command timeout | WebSocket open and receive task alive | reader exit rejects every pending Future; dead reader triggers locked reconnect on the next command | command response resolves inline; ordered event queue and callback failures are isolated from the reader |
| WebdriverIO | WebDriver request events; BiDi integer pending map | BiDi connection and session capability | deleteSession aborts in-flight HTTP; BiDi command timeout | masked/truncated log representation, unchanged real result；network response readiness waits for optional body collector |
| Selenium BiDi | command id plus remote subscription id | WebSocket/session capability | closing connection clears listeners；subscription removed by exact id | event handler ownership retains subscription scope |
| Playwright MCP relay | CDP id/session plus extension callback map | initial tabs then `extension.initialized` | closing either side rejects/ends peer | protocol messages |
| mcp-chrome | UUID pending map over native message framing | only `SERVER_STARTED` confirms running | stdin end/error rejects all host pending; extension reconnect state separate | server status persisted separately from current port |
| TestCafe | browser connection and command state | browser ready event | heartbeat -> disconnected/aborted -> bounded restart | status/debug logger |
| Steel Browser | proxied raw CDP ids/sessionIds | browser endpoint must exist | browser disconnect invokes session cleanup | context-enriched event logger plus query/SSE/export projections |
| Appium | WebDriver sessionId routes to inner driver | session registered only after create succeeds | unexpected shutdown races the active command | queue length, plugin handled-by report and command timing history |
| Nightwatch | command node in AsyncTree | session setup precedes command traversal | parent/child command completion is explicit | node carries creation stack and callback-added context |
| Lighthouse | CDP id inside ProtocolSession | target session registered after target info/type acceptance | target crash races every command and detaches session | flattened event adds targetType and sessionId |
| Electron | debugger command id + optional child sessionId | WebContents target exists; renderer/frame readiness remains separate | target close rejects every pending command; same-WebContents RFH swap keeps DevTools session | protocol event preserves method/params/sessionId; event callbacks have explicit host lifecycle guards |
| OpenCLI | client command id + daemon pending settlers + extension journal | live profile connection and extension version handshake | same-id duplicate joins pending/replays result; post-dispatch loss becomes `command_result_unknown`; worker death becomes `command_lost` | error code distinguishes pre-dispatch, busy, unknown outcome and oversized replay result; absolute deadline stays visible |
| Obscura | CDP id and optional sessionId inside one connection-local processor | WebSocket accepted only after atomic capacity reservation | connection thread owns contexts/pages; slot guard releases capacity on close/error/panic | over-capacity is explicit HTTP 503 with reason; V8 command watchdog logs offending method and budget |

## Extension Injection And Page Realm

| Project | Document identity | Injection timing | Realm routing | Command/state evidence | Main boundary |
|---|---|---|---|---|---|
| Legacy baseline | tab/script identity; current mount status, active injections and diagnostics | persistent registration + new-document injection; runAt | MAIN via CDP early script, ISOLATED via scripting/content path | MountHandle methods, events, completion, status and diagnostics | document/frame generation evidence still needs direct source comparison |
| Automa | active tabId + frameId in each worker | sends to content bundle; message failure may trigger bundle reinjection | content script for interactions; debugger for selected operations | block/worker history and activeTabUrl | automatic reinjection and boolean attach failure hide transport cause |
| Violentmonkey | tabId + documentId/top/frame-derived frame document key | start/body/end/idle queues; prerender/BFCache；fast registration remains opt-in after regression | explicit page/content triage with realm-aware callbacks | per-script ids, injection feedback, frame cleanup and cache invalidation | automatic realm change and fast-inject mode are product policies |
| Electron session preload | WebContents/browser context plus frame or service-worker context | frame startup data ordered before commit; future worker startup rebuilds registration set | host main/isolated execution APIs remain distinct | unique preload id; duplicate registration and unknown unregister hard-fail | registration does not prove an existing document/worker executed the script |
| rebrowser-patches | frame/worker plus acquired executionContextId | new-document binding or context acquisition on first execution | binding-derived MAIN、fresh ISOLATED or brief Runtime enable/disable | patch debug logs expose mode、frame、world and context id | modes change page visibility and MAIN/worker access; patch application is not behavioral conformance |

Key distinction:

- frameId is not a document generation;
- runAt, realm and injection success are separate facts;
- a command callback must retain script, frame/document and realm ownership;
- automatic reinjection or realm switching may improve success while destroying failure evidence.

Key distinction:

- socket/Port object existence is not ready;
- disconnect must reject pending work at the layer that owns it;
- diagnostic projection may be small, but must never mutate or silently truncate the real result.

## Artifact And Workspace

| Project | Persistent evidence | Full data vs interaction result | Runtime use | Ownership |
|---|---|---|---|---|
| Legacy baseline | output JSON/text/series, tool trace, screenshot/download | function evaluate preserves complete values; large transport and runner output materialize to files with integrity metadata | runner keeps live-browser work composable without forcing large values through stdout | caller-selected output and owned tab scope |
| OpenChrome | JSONL command/event trace + atomic metadata | append body and separate metadata | diagnoses live target ownership and command execution | trace session |
| BrowserGym | per-step action timings, observation and validation info | structured observation | evaluates an action against the current environment state | BrowserContext/task episode |
| Webwright | step source files, full logs, screenshots, final script, session JSON | full log/file plus concise observation projection | workspace supports iterative live-browser scripts | workspace + explicit persistent browser session |
| Steel Browser | target/page events in storage and SSE; shared files archive | storage query/export differs from live event stream | inspects current target and page events | event carries page/target context; files are process-scoped in current source |
| Lighthouse | flattened protocol events plus gatherer artifacts | protocol stream remains separate from derived audit result | gathers DOM/network/runtime evidence across page/OOPIF/worker | every event retains targetType/sessionId; execution context uses uniqueId |
| BackstopJS | reference/test/diff images、test-pair JSON、browser/JUnit report | screenshot files are full artifacts, but timeout/error may become a placeholder image | visual regression across scenario/viewport/selector matrix | run-owned browser and scenario-owned context/page |

Key distinction:

- large evidence is a file/resource problem, not a reason to weaken inline/script capability;
- an artifact must carry source, target scope, time/generation and completeness facts before it can support conclusions.

## Evaluation And Reproducibility

| Project | Reuse boundary | Per-case reset | Outcome evidence | Recovery boundary |
|---|---|---|---|---|
| Legacy baseline | user browser/profile persists; scripts select or own tabs | independent repro scripts perform their own cleanup | tool result、trace、output file and ad hoc assertions | no unified behavioral harness or fixture matrix |
| WPT WebDriver fixtures | matching session may outlive one test; test window/context is scoped | timeout、prompt、window、frame、subscription、preload script and cookie cleanup | file/subtest status、expected、known intermittent、timeout、crash and browser pid | capability mismatch or fixture exception ends session; internal error/external timeout/crash restarts runner/browser |
| BrowserGym | one BrowserContext per episode | environment reset plus validator state restoration | action/observation/validation timings and last error | new episode/context |
| Webwright | persistent external browser can span script steps | caller-owned page cleanup and explicit disconnect/release | step source、full log、projection、screenshot and final script | ownership-aware disconnect or process/profile release |
| BackstopJS | one browser per run、one context/page per scenario view | scenario script/readiness/selector preparation precedes capture | reference/test/diff、dimension and mismatch percentage、JSON/browser/JUnit report | context closes after capture; readyEvent timeout continuing and error placeholders weaken oracle completeness |

Key distinction:

- reuse is trustworthy only when the reused layer and the reset layer are named separately;
- an empty or failed observation needs environment identity and outcome classification before it can become evidence;
- fixture cleanup may suppress recovery errors, but a product command must still report the original action outcome and cleanup outcome separately.

## Local Control Security Boundary

| Project | Listener / IPC | Client admission | Browser authority | File / ownership boundary | Main risk or tradeoff |
|---|---|---|---|---|---|
| Legacy baseline | strict loopback WebSocket with configurable port | exact `/client` and `/extension`; browser Origin rejected on client; extension Origin must match hello identity; relay run pins one provider id and SDK may require it | extension has debugger, scripting, cookies, downloads, webRequest and `<all_urls>` | borrowed/owned workspace rules; artifact basename normalization, resolved containment, operation ownership, private directory and `0600` files | loopback and Origin are not OS-user authentication; an origin-less process under the same user remains trusted, so the local control surface still has high real-profile authority |
| OpenCLI | strict `127.0.0.1` HTTP/WebSocket | command header + Origin policy + WebSocket `verifyClient`; 1 MB body limit | extension profile route or explicit Electron CDP endpoint | target/write leases and command journal preserve ownership/outcome | Electron launch uses broad remote-debugging origin allowance, so daemon admission and endpoint exposure remain separate concerns |
| Browser Harness | POSIX Unix socket or Windows loopback TCP | POSIX socket mode `0600`; Windows port file carries a random token | one existing-Chrome CDP connection | one mutable selected session; no per-target consumer lease | transport admission is stronger than target/event isolation |
| Browserless | network HTTP/WebSocket service | configured token normalized to Bearer validation | service owns launched browser/session | session registry and temp profile ownership | remote service security depends on token deployment and endpoint exposure |
| mcp-chrome | native messaging plus loopback Fastify | native manifest exact extension origin; HTTP CORS allows extension/local origins and origin-less server clients | extension owns broad browser tools | native host restricts extension entry, HTTP side remains a separate local surface | multiple transports have different admission guarantees |

Key distinction:

- loopback is an exposure reduction, not client authentication;
- extension identity, local process identity and browser tab ownership are separate boundaries;
- a path under an output directory is safe only after normalization and containment are proved, not because a default directory exists.

## Confirmed Design Filters

1. **Identity before convenience.** Any helper that can silently change tab/frame/element is weaker evidence than an explicit handle plus a clear miss.
2. **Primitive facts before authoritative interpretation.** SDK should make transport, target, timing and result facts easy to compose; it should not claim a complete page probe or universal business-ready state.
3. **Lifecycle states before generic retry.** Queue、attach、ready、active、retired、closed and disconnected have different causes and cleanup paths.
4. **Action evidence is staged.** Target resolved、input dispatched、navigation started、requests settled、DOM changed and business result appeared are not one boolean.
5. **Output projection is not data loss.** stdout can stay compact only when complete data is preserved in a discoverable artifact with integrity metadata.
6. **Daemon ownership与 client ownership 必须分开。** AB daemon 管理专用 Chrome，SDK client 只拥有自己的 observer、handle、artifact lease 等临时资源；client 断开不能关闭共享 Chrome。
7. **Protocol compatibility is not behavioral equivalence.** Lightpanda and Camoufox prove that a provider may implement CDP/Juggler/Playwright surfaces with different process, navigation and page semantics.
8. **Retry needs an error taxonomy.** Capybara's bounded recoverable-error synchronization preserves meaning; broad exception fallback such as SeleniumBase click trades away execution evidence.
9. **Embedded runtimes preserve caller context.** k6 and Vitest bind browser resources to workload/test-project lifecycle；AB client session 同样要保留 provenance，但不引入 runner 或它们的调度器。
10. **Async work retains the generation it started from.** A callback must hold the concrete session/child target/document generation it operates on; looking up a newer global current object at completion can corrupt another operation.
11. **Screenshot is a presentation fact.** Correct tab identity and image dimensions do not prove the requested pixels were presented; viewport, full-page and offscreen-element capture may require different browser-side sources and a presentation boundary.
12. **Host capability is not engine capability.** Electron、CEF and Tauri expose radically different automation surfaces over embedded web content; Chromium-based is a provider hint, not a contract for background input, debugger ownership, network visibility or screenshot behavior.

这些过滤器仍不是产品改动清单。后续候选必须从 AB 可复现摩擦出发，再选择同层源码机制做对照实验。
