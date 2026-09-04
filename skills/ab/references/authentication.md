# Authentication and persistent profile

The default managed provider launches one dedicated headed Chrome with one fixed profile at `~/Library/Application Support/ab/chrome-profile`. Cookies, local storage, IndexedDB, service workers, and ordinary site sessions persist across Node processes and Agent tasks.

This is not the user's everyday Chrome profile. AB does not copy credentials from another browser or silently switch to a temporary profile.

When the user explicitly asks to use an already-running Chrome, connect its exact browser-level DevTools endpoint with the external provider. AB then uses the login state already present in that Chrome. Listing tabs does not attach them; acquire only the exact tab required by the task. External disconnect detaches AB sessions without closing user tabs, signing out, or shutting down Chrome.

## Reuse an existing login

List tabs first, then open the target site in the same AB profile:

```js
let tabs = await browser.tabs.list();
const candidate = tabs.find(t => t.url.startsWith("https://app.example.com/"));
let tab = candidate
  ? await browser.tabs.acquire(candidate.id)
  : await browser.tabs.open("https://app.example.com/");
await tab.ax.write("state");
```

Decide login state from rendered facts such as the account menu, sign-in form, or application shell. Do not infer authentication only from a URL, a cookie-shaped string, or an HTTP 200 response.

## First-time and expired login

If the site shows an ordinary login form, use the same AX/Locator action rules as any other form. Do not request credentials unless the task requires authentication and the persistent profile is not already signed in.

SSO can redirect the current page through several origins or open another page in a new tab or separate browser window. When a popup is an expected result, first present `browser.documentation("tabs")` and use `tab.expectPopup(action)` so absence is a real timeout. When an ordinary action unexpectedly opens another page, use its `targetChanges.opened` entry or the presented `AB_BROWSER_CHANGE`, then bind that exact `targetId` with `browser.tabs.get()`. Do not infer the result from before/after tab-list counts or array position. If the current page redirects instead, wait for the required URL or rendered fact there. In every form, verify the selected page from fresh rendered state before continuing.

If a flow requires a hardware key, biometric approval, mobile confirmation, CAPTCHA, or an action outside browser control, leave the browser at that step and tell the user exactly what is waiting. Do not attempt to defeat or outsource the challenge.

## Password managers and browser UI

AX observations describe web content, not arbitrary Chrome toolbar or password-manager UI. AB does not promise semantic control of browser chrome. If Chrome-owned UI blocks progress, report it as a browser-UI boundary rather than searching the page DOM indefinitely.

## Authentication state boundaries

Browser authentication state is durable within the selected profile, not universal:

- private/incognito state is not part of the AB contract;
- origin storage remains origin-scoped;
- session expiry, server revocation, and device challenges still apply;
- a tab remaining open does not prove its session is valid;
- disconnecting the SDK does not log the site out.

Do not export or inject cookies as a substitute for normal profile reuse unless a separate, explicitly authorized capability is added. Current AB Agent guidance exposes no cookie-management API.

## Sign-out and account changes

Signing out, changing account, modifying MFA, or accepting a new organization is persistent browser mutation. Perform it only when explicitly in scope. Closing a task-created tab is not a logout operation.
