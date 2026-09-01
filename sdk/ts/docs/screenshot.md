# Screenshot, artifacts, and CUA

Screenshots are server-owned verified PNG artifacts with top-level `id`, `path`, `sha256`, `bytes`, `mediaType`, `encoding`, creation/expiry timestamps, image dimensions, `scale`, `cssViewport`, and `viewportId`; the same immutable descriptor is also available as `shot.artifact`. `read()` verifies bytes and hash; `dispose()` releases the artifact and private file.

Agent `ax.get/write("screenshot"|"both")` defaults to `scale: "css"`: one image pixel equals one CSS pixel. This keeps high-DPI screenshots smaller and makes screenshot coordinates directly usable by CUA. Core `tab.screenshot()` and `tab.observe()` default to `scale: "device"` for lossless device-pixel capture; request `scale: "css"` explicitly when their pixels will guide CUA.

`shot.cssViewport` always reports the live CSS `width`, `height`, `pageX`, `pageY`, and `deviceScaleFactor`. `shot.width/height` are image pixels. With viewport `scale: "css"` the two sizes match; with `scale: "device"` they may not. Never send device-image pixel coordinates directly to CUA.

Use Agent `ax.write("screenshot")` or `write("both")` when the model must see pixels. In the managed Node REPL MCP host, the Presenter verifies the artifact and returns its bytes as a standard MCP image content block. In an ordinary Node process, the Presenter prints artifact metadata and the host opens that path with its image capability. `get("screenshot")` returns the typed object without presenting it in either environment.

Coordinate input must include the exact screenshot `viewportId`. Navigation, scrolling, resizing, device scale changes, or layout changes produce a new identity. AB rejects stale coordinates instead of applying them to a different viewport.

CUA is for canvas, maps, remote desktops, or other targets whose useful identity is visual. Do not use it as an automatic fallback for ordinary semantic controls.

## Presenting pixels

The Presenter always emits an `AB_SCREENSHOT` record containing the canonical artifact and viewport identity. In the managed Node REPL it then sends the verified PNG bytes through `nodeRepl.emitImage()`, so metadata and pixels belong to one Tool result. In ordinary Node it prints only the record; open that exact path with the host image-viewing capability before reasoning about coordinates.

```js
await browser.documentation("screenshot");
await tab.ax.write("screenshot");
```

Use `write("both")` when semantic refs and pixels must represent the same transaction. Use `get()` when program code needs the object and the host will present it separately.

## Viewport versus full-page screenshots

A viewport screenshot matches the currently visible CSS viewport and is the correct input to CUA. A full-page screenshot is useful for overview and evidence but contains content outside the live viewport; coordinates from it are not a safe substitute for viewport coordinates.

After scrolling toward a region, capture a fresh viewport screenshot before clicking. Do not derive CUA coordinates by scaling a full-page image.

## Coordinate actions

```js
const shot = await tab.ax.get("screenshot");
try {
  console.log({ id: shot.id, sha256: shot.sha256, bytes: shot.bytes });
  await tab.cua.move({ x: 320, y: 180, viewportId: shot.viewportId });
  const result = await tab.cua.click({
    x: 320,
    y: 180,
    button: "left",
    clickCount: 1,
    viewportId: shot.viewportId,
    observe: "diff",
  });
  result.target.coordinate; // exact viewportId, x, and y used by Rust
  result.observation?.text; // immediate AX diff when requested
  await tab.cua.wheel({
    x: 700,
    y: 600,
    deltaY: 480,
    viewportId: shot.viewportId,
  });
  await tab.cua.drag({
    from: { x: 240, y: 310 },
    to: { x: 620, y: 310 },
    viewportId: shot.viewportId,
  });
} finally {
  await shot.dispose();
}
```

Every coordinate must be chosen from a viewport screenshot and expressed in CSS pixels within `shot.cssViewport.width/height`, paired with its exact `viewportId`. Agent screenshots already use CSS scale by default. A stale-viewport rejection is not retryable with the same coordinates; recapture and inspect again.

CUA mutations return the same `ActionResult` transaction as semantic actions. It records dispatch timing, navigation/document changes, dialog and file-chooser outcomes, and the exact coordinate identity. `observe: "diff"` requests an immediate post-action AX diff; it does not prove the page's business outcome.

A coordinate click uses the same dialog-aware pressed/released sequence as a semantic click. If its handler opens a JavaScript dialog, the result carries that exact dialog identity and any pending pointer release is retained until `accept()` or `dismiss()` completes. Do not reuse the coordinate or send more page input while the dialog is open.

`cua.drag()` uses the same ten-step CDP pointer path as semantic `dragTo()`, but binds both endpoints to one screenshot viewport identity. Use it when the source or destination exists only in pixels, such as canvas shapes. If both endpoints have semantic identities, prefer `source.dragTo(target)`.

## When visual input is justified

Use CUA for a canvas chart, map, remote desktop, streamed application, visual editor, or a visible target whose semantic state has no usable identity. If semantic state exposes a named, distinguishable control, prefer its ref or Locator because those carry document and node identity. If one bounded inspection instead confirms only unnamed visual candidates with empty identity attributes, do not keep inspecting the same empty facts: take a current viewport screenshot and deliberately choose CUA only when the intended visual control is unambiguous.

Do not use CUA to bypass an overlay, disabled control, permission prompt, or ambiguous destructive action. Those are UI facts to understand.

## Artifact ownership

`Screenshot.read()` verifies byte count and SHA-256 before returning bytes. `dispose()` releases the server-owned artifact. Keep it alive until the host has opened or copied it, then dispose it. Do not assume the private artifact path is durable after client disconnect.
