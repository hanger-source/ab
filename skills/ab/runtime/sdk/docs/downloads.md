# Downloads, uploads, and file choosers

Open download and file-chooser watchers before the triggering action. `downloadWillBegin` proves only that a download started. Wait for the completed progress event before using its artifact; interruption is a separate terminal result.

Completed downloads are adopted into AB's private ArtifactStore. `Download.suggestedFilename` carries the browser-proposed name; `Download.artifact` is the common verified `Artifact` handle carrying path, bytes, SHA-256, and media metadata. Copy to a caller-owned destination before disconnecting when the file must outlive the SDK client.

Prefer Locator or ref `setFiles()` when the input element is addressable. A file-chooser watcher is for chooser-driven flows and reports the exact frame/session/backend node. Upload paths are canonicalized and validated; AB does not invent a replacement path.

## Download lifecycle

```js
await agent.documentation("downloads");
const downloads = await tab.watchDownloads();
try {
  await tab.getByRole("link", { name: "Download report", exact: true }).click();
  const download = await downloads.waitForDownload({ timeoutMs: 15_000 });
  console.log({
    guid: download.guid,
    filename: download.suggestedFilename,
    url: download.url,
  });
  const completed = await download.waitForCompleted({ timeoutMs: 60_000 });
  if (!completed.artifact) throw new Error("completed download omitted its artifact");
  const bytes = await completed.artifact.read();
  await completed.artifact.dispose();
} finally {
  await downloads.dispose();
}
```

`waitForDownload()` returns one exact download identity at start. `waitForCompleted()` follows that guid until terminal state and rejects canceled or interrupted downloads. Do not use the suggested filename or a start event as proof that bytes are complete.

`downloads.downloads()` lists records already known to the watcher. It does not import unrelated files from the user's Downloads directory.

## Download artifacts

A completed record includes a suggested filename and a common `Artifact` handle with private canonical path, bytes, SHA-256, media type, and creation/expiry metadata. `artifact.read()` verifies byte length and digest before returning bytes. These prove AB's adopted byte identity, not the safety or semantic correctness of the file.

When the result must survive `agent.disconnect()`, copy the exact completed artifact path to an explicit caller-owned destination before disconnecting. Do not execute downloaded files. Do not silently overwrite an existing destination.

## Direct file input

Use an exact absolute path:

```js
const input = tab.getByLabel("Attachment", { exact: true });
await input.setFiles("/absolute/path/report.pdf", { write: "diff" });
```

AB canonicalizes and validates the path. A missing path is a hard input error. Do not search broad directories, infer from a page-provided filename, or substitute another file.

`setFiles([pathA, pathB])` is valid only when the page input accepts multiple files. Verify the rendered selected-file state before submission.

## Chooser-driven controls

Some controls hide the input and open a chooser after a button click. Prepare the watcher before clicking:

```js
const choosers = await tab.watchFileChoosers();
try {
  const waiting = choosers.waitForChooser({ timeoutMs: 15_000 });
  await tab.getByRole("button", { name: "Choose file", exact: true }).click();
  const chooser = await waiting;
  chooser; // exact target/frame/session/backend-node identity
} finally {
  await choosers.dispose();
}
```

The watcher observes chooser identity; it does not grant authority to upload. Prefer direct `setFiles()` whenever the input can be located semantically.

## Ordering rule

Open watcher → trigger → wait for exact start/chooser → complete the operation → verify visible application state → assert completeness when absence matters → dispose.
