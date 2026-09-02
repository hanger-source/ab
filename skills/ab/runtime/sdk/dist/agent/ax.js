import { ABError } from "../errors/index.js";
import {} from "../ax/index.js";
/** @internal */
export const OBSERVATION_MAX_CHARS = 24_000;
const DEFAULT_OBSERVATION_TIMEOUT_MS = 30_000;
/**
 * Agent-facing AX observation and short-ref actions.
 *
 * Actions deliberately do not capture or present post-action state. The Agent
 * chooses an explicit wait or `write()` at the next decision boundary. See
 * `docs/evidence/20260902__action-wait-observation-ownership-audit__@codex.md`.
 */
export class AX {
    #tab;
    #presenter;
    #documentation;
    #ownedStates = new Set();
    #captureShapes = new WeakMap();
    #lastPresentedState = null;
    constructor(tab, presenter, documentation) {
        this.#tab = tab;
        this.#presenter = presenter;
        this.#documentation = documentation;
    }
    /** @internal */
    static create(tab, presenter, documentation) {
        return new AX(tab, presenter, documentation);
    }
    async get(content, options = {}) {
        if (content === "screenshot" || content === "both") {
            this.#documentation.require("screenshot", `tab.ax.get(${JSON.stringify(content)})`);
        }
        if (content === "state") {
            const snapshot = snapshotOptions(options);
            const state = await captureWithConsistencyRetry(options, (attempt) => this.#tab.ax.snapshot(snapshotOptions(attempt)));
            return this.#track(state, captureShape(snapshot));
        }
        if (content === "screenshot") {
            return this.#tab.screenshot({ ...options, scale: options.scale ?? "css" });
        }
        const observation = await captureWithConsistencyRetry(options, (attempt) => this.#tab.observe({
            ax: snapshotOptions(attempt),
            screenshot: true,
            fullPage: attempt.fullPage ?? false,
            scale: attempt.scale ?? "css",
            ...(attempt.timeoutMs === undefined ? {} : { timeoutMs: attempt.timeoutMs }),
            ...(attempt.signal === undefined ? {} : { signal: attempt.signal }),
        }));
        if (observation.state) {
            this.#track(observation.state, captureShape(snapshotOptions(options)));
        }
        return observation;
    }
    async write(content, options = {}) {
        if (typeof content !== "string") {
            if (content.targetId !== this.#tab.id) {
                throw new ABError({
                    kind: "target_mismatch",
                    stage: "agent.ax.write",
                    message: `observation ${content.id} belongs to tab ${content.targetId}, not ${this.#tab.id}`,
                });
            }
            try {
                await this.#presentState(content);
            }
            catch (error) {
                await this.#releaseUnpresentedState(content);
                throw error;
            }
            await this.#replacePresentedState(content);
            return content;
        }
        if (content === "diff") {
            assertDiffWriteOptions(options);
            const baseline = this.#lastPresentedState;
            if (!baseline || baseline.disposed) {
                throw new ABError({
                    kind: "agent_observation_required",
                    stage: "agent.ax.write.diff",
                    message: `tab ${this.#tab.id} has no live successfully presented AX observation; call ax.write("state") before requesting a diff`,
                });
            }
            const shape = this.#captureShapes.get(baseline);
            if (!shape) {
                throw new ABError({
                    kind: "agent_observation_shape_required",
                    stage: "agent.ax.write.diff",
                    message: `observation ${baseline.id} was presented without an Agent capture shape; call ax.write("state") before requesting a diff`,
                });
            }
            return this.write("state", {
                ...shape,
                ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
                ...(options.signal === undefined ? {} : { signal: options.signal }),
                diffFrom: baseline,
            });
        }
        if (content === "screenshot" || content === "both") {
            this.#documentation.require("screenshot", `tab.ax.write(${JSON.stringify(content)})`);
        }
        if (content === "state") {
            const state = await this.get("state", options);
            try {
                await this.#presentState(state);
            }
            catch (error) {
                await this.#releaseUnpresentedState(state);
                throw error;
            }
            await this.#replacePresentedState(state);
            return state;
        }
        if (content === "screenshot") {
            const screenshot = await this.get("screenshot", options);
            try {
                await this.#presenter.presentImage({
                    kind: "screenshot",
                    origin: await this.#currentOrigin(),
                    screenshot,
                });
            }
            catch (error) {
                await screenshot.dispose().catch(() => undefined);
                throw error;
            }
            return screenshot;
        }
        const observation = await this.get("both", options);
        if (!observation.state || !observation.screenshot) {
            if (observation.state) {
                await observation.state.dispose().catch(() => undefined);
                this.#ownedStates.delete(observation.state);
            }
            if (observation.screenshot) {
                await observation.screenshot.dispose().catch(() => undefined);
            }
            throw new ABError({
                kind: "observation_incomplete",
                stage: "agent.ax.write",
                message: "atomic state and screenshot observation returned an incomplete result",
            });
        }
        try {
            await this.#presentState(observation.state);
            await this.#presenter.presentImage({
                kind: "screenshot",
                origin: this.#tab.url,
                screenshot: observation.screenshot,
            });
        }
        catch (error) {
            await Promise.allSettled([
                this.#releaseUnpresentedState(observation.state),
                observation.screenshot.dispose(),
            ]);
            throw error;
        }
        await this.#replacePresentedState(observation.state);
        return {
            state: observation.state,
            screenshot: observation.screenshot,
        };
    }
    click(refId, options = {}) {
        return this.#perform(refId, (ref) => ref.click(actionOptions(options)));
    }
    doubleClick(refId, options = {}) {
        return this.#perform(refId, (ref) => ref.doubleClick(actionOptions(options)));
    }
    hover(refId, options = {}) {
        return this.#perform(refId, (ref) => ref.hover(actionOptions(options)));
    }
    wheel(refId, deltaX, deltaY, options = {}) {
        return this.#perform(refId, (ref) => ref.wheel(deltaX, deltaY, actionOptions(options)));
    }
    fill(refId, value, options = {}) {
        return this.#perform(refId, (ref) => ref.fill(value, actionOptions(options)))
            .then(async (result) => {
            await this.presentTextInputOutcome(result);
            return result;
        });
    }
    type(refId, text, options = {}) {
        return this.#perform(refId, (ref) => ref.type(text, actionOptions(options)))
            .then(async (result) => {
            await this.presentTextInputOutcome(result);
            return result;
        });
    }
    press(refId, key, options = {}) {
        return this.#perform(refId, (ref) => ref.press(key, actionOptions(options)));
    }
    focus(refId, options = {}) {
        return this.#perform(refId, (ref) => ref.focus(actionOptions(options)));
    }
    clear(refId, options = {}) {
        return this.#perform(refId, (ref) => ref.clear(actionOptions(options)));
    }
    check(refId, options = {}) {
        return this.#perform(refId, (ref) => ref.check(actionOptions(options)));
    }
    uncheck(refId, options = {}) {
        return this.#perform(refId, (ref) => ref.uncheck(actionOptions(options)));
    }
    selectOption(refId, values, options = {}) {
        return this.#perform(refId, (ref) => ref.selectOption(values, actionOptions(options)));
    }
    setFiles(refId, files, options = {}) {
        return this.#perform(refId, (ref) => ref.setFiles(files, actionOptions(options)));
    }
    dragTo(sourceRefId, targetRefId, options = {}) {
        return this.#perform(sourceRefId, (source) => source.dragTo(this.#ref(targetRefId), actionOptions(options)));
    }
    scrollIntoView(refId, options = {}) {
        return this.#perform(refId, (ref) => ref.scrollIntoView(actionOptions(options)));
    }
    /** Releases every live AX observation owned by this Agent tab. The AX surface remains usable. */
    async dispose() {
        this.#pruneDisposedStates();
        const states = [...this.#ownedStates];
        this.#ownedStates.clear();
        this.#lastPresentedState = null;
        const outcomes = await Promise.allSettled(states.map((state) => state.dispose()));
        const failed = outcomes.find((outcome) => outcome.status === "rejected");
        if (failed)
            throw failed.reason;
    }
    /** Number of live AX observations currently retained by this Agent tab. */
    get liveObservations() {
        this.#pruneDisposedStates();
        return this.#ownedStates.size;
    }
    /** @internal */
    applyActionResult(result) {
        this.#tab.applyActionResult(result);
    }
    /** @internal */
    async presentTextInputOutcome(result) {
        if (result.data.field.matchesRequestedText !== false)
            return;
        await this.#presenter.presentText({
            kind: "action",
            origin: await this.#currentOrigin(),
            observationId: null,
            text: "AB input dispatch completed, but the field did not retain the requested text exactly. Inspect result.data.field.inputValue before submitting; the control may enforce maxlength or normalization.",
            untrusted: false,
        });
    }
    #ref(refId) {
        const state = this.#lastPresentedState;
        if (!state || state.disposed) {
            throw new ABError({
                kind: "agent_observation_required",
                stage: "agent.ax.ref",
                message: `tab ${this.#tab.id} has no live successfully presented AX observation; call ax.write("state") before using a short ref`,
            });
        }
        const normalized = refId.startsWith("@") ? refId.slice(1) : refId;
        const reference = state.refs().find((candidate) => candidate.id === normalized);
        if (!reference) {
            throw new ABError({
                kind: "ref_not_found",
                stage: "agent.ax.ref",
                message: `short ref ${refId} is not part of the current presented observation ${state.id}; ax.get() does not change this baseline`,
                details: {
                    observationId: state.id,
                    revision: state.revision,
                    refs: state.refs().length,
                    truncated: state.truncated,
                },
            });
        }
        return reference;
    }
    async #perform(refId, action) {
        const result = await action(this.#ref(refId));
        this.applyActionResult(result);
        return result;
    }
    async #presentState(state) {
        const text = state.diff && !state.diff.documentReplaced && !state.diff.surfaceReplaced
            ? state.diff.text || "No accessibility-tree text changed after the action."
            : state.text;
        const presentation = state.diff?.documentReplaced
            ? "document-replacement"
            : state.diff?.surfaceReplaced
                ? "surface-replacement"
                : state.diff
                    ? "incremental"
                    : "full";
        const origin = await this.#currentOrigin();
        await this.#presenter.presentText({
            kind: "ax",
            origin,
            observationId: state.id,
            text,
            untrusted: true,
            presentation,
        });
    }
    async #currentOrigin() {
        await this.#tab.refresh();
        return this.#tab.url;
    }
    async #replacePresentedState(state) {
        const previous = this.#lastPresentedState;
        this.#track(state);
        this.#lastPresentedState = state;
        if (previous && previous !== state) {
            await previous.dispose();
            this.#ownedStates.delete(previous);
        }
    }
    async #releaseUnpresentedState(state) {
        if (state === this.#lastPresentedState)
            return;
        await state.dispose().catch(() => undefined);
        this.#ownedStates.delete(state);
    }
    #track(state, shape) {
        this.#pruneDisposedStates();
        this.#ownedStates.add(state);
        if (shape)
            this.#captureShapes.set(state, shape);
        return state;
    }
    #pruneDisposedStates() {
        for (const state of this.#ownedStates) {
            if (state.disposed)
                this.#ownedStates.delete(state);
        }
    }
}
async function captureWithConsistencyRetry(options, capture) {
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_OBSERVATION_TIMEOUT_MS);
    try {
        return await capture(options);
    }
    catch (error) {
        if (!(error instanceof ABError)
            || error.kind !== "observation_consistency_error"
            || options.signal?.aborted) {
            throw error;
        }
        const remaining = Math.floor(deadline - Date.now());
        if (remaining <= 0)
            throw error;
        return capture({ ...options, timeoutMs: remaining });
    }
}
function snapshotOptions(options) {
    return {
        mode: options.mode ?? "full",
        surface: options.surface ?? "active",
        ...(options.frames === undefined ? {} : { frames: options.frames }),
        ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
        maxChars: options.maxChars ?? OBSERVATION_MAX_CHARS,
        ...(options.diffFrom === undefined ? {} : { diffFrom: options.diffFrom }),
        ...(options.includeUrls === undefined ? {} : { includeUrls: options.includeUrls }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
}
function captureShape(options) {
    return {
        mode: options.mode ?? "full",
        surface: options.surface ?? "active",
        ...(options.frames === undefined ? {} : { frames: options.frames }),
        ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
        ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }),
        ...(options.includeUrls === undefined ? {} : { includeUrls: options.includeUrls }),
    };
}
function actionOptions(options) {
    assertAgentActionOptions(options);
    return {
        ...options,
        observe: "none",
    };
}
/** @internal */
export function assertAgentActionOptions(options) {
    for (const field of ["write", "observe", "baseline", "observation"]) {
        if (Object.prototype.hasOwnProperty.call(options, field)) {
            throw new TypeError(`@hanger-source/ab/agent actions do not accept ${field}; perform the action, then wait for or observe the explicit fact needed next`);
        }
    }
}
function assertDiffWriteOptions(options) {
    const unsupported = Object.keys(options).filter((field) => field !== "timeoutMs" && field !== "signal");
    if (unsupported.length > 0) {
        throw new TypeError(`ax.write("diff") inherits the presented observation capture shape and only accepts timeoutMs or signal; received ${unsupported.join(", ")}`);
    }
}
//# sourceMappingURL=ax.js.map