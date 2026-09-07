# v0.2.0 beta validation

Validated on macOS, 2026-09-07. This is a compatibility report, not a quota-accuracy guarantee.

- Node 26.5.0: 33 automated checks passed.
- Node 24.19.0: the same 33 checks passed.
- Tests cover paginated and legacy discovery, active descendants, account reset boundaries, quota conservation, missing samples, offline gaps, HTTP authentication, read-only RPC restrictions, process locks, startup/exit failures, concurrent settings, manual model edits, and reminder persistence.
- A live read-only smoke test found two active root tasks and returned account quota windows. No prompts were submitted by the collector.
- Initial local discovery took roughly 0.24–0.27 seconds on the tested machine. This is an initial-scan observation, not a hardware-independent CPU or latency promise. The dashboard reports each latest local scan duration.
- Model-default write, version checking, and null-value restoration were verified against the desktop App Server using an isolated temporary CODEX_HOME. The user's real model configuration was not changed by these checks.
- The disclaimer, live session rows and three-decimal numbers were inspected in Chrome using synthetic demo data.
- The plugin manifest and skill validators passed.

The account used for the live test returned `threadUsage: null`. Per-session percentages therefore remain local-token-share estimates. There is no validation here for native Codex UI injection, an every-native-window callback, active-turn model switching, or prediction of discretionary reset gifts; those capabilities are not implemented.

To reproduce the automated tests:

```sh
cd plugins/codex-quota-monitor
node --test tests/*.test.mjs
```

Loopback network permission is needed by the HTTP tests. CI runs the same suite on Node 22.13.0 and 24.x. Test fixtures contain synthetic IDs and no private conversation data.
