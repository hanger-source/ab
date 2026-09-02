import assert from "node:assert/strict";

const mode = process.argv[2];
const targetId = requiredEnv("AB_TEST_TAB_ID");
const { connect } = await import(requiredEnv("AB_SKILL_CLIENT"));
const browser = await connect();

try {
  const listed = (await browser.tabs.list()).find((tab) => tab.id === targetId);
  assert(listed, `target ${targetId} must remain discoverable`);

  if (mode === "conflict") {
    assert.equal(listed.ownership, "other");
    let error;
    try {
      await browser.tabs.acquire(targetId);
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.kind, "target_in_use");
    console.log(JSON.stringify({
      mode,
      ownership: listed.ownership,
      error: { kind: error.kind, stage: error.stage },
    }));
  } else if (mode === "takeover") {
    const tab = await browser.tabs.acquire(targetId);
    assert.equal(tab.ownership, "owned");
    await tab.goto("about:blank", { waitUntil: "load" });
    await tab.close();
    console.log(JSON.stringify({ mode, ownership: tab.ownership, closed: true }));
  } else {
    throw new Error(`unknown worker mode ${mode}`);
  }
} finally {
  await browser.disconnect();
}

function requiredEnv(name) {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
}
