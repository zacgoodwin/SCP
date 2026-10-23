# Mistakes

What went wrong, why, and what now prevents it. Newest first.

## 2026-10-23: four flaky gate tests found while shipping the v3 batch

| Test | What happened | Root cause | Prevention |
|---|---|---|---|
| `oidc.test.ts`, a different test each time | About 1 run in 15 to 40 failed with a 502 "did not respond" page | Test servers took any `listen(0)` port. This machine's ephemeral range starts at 1024, so a server could land on a port fetch refuses by spec (6000, 6665-6669, ...), and undici threw `bad port` | `listenLocal()` in `server/test/helpers.ts` re-listens until fetch accepts the port; every fetched test server uses it, and a test pins the refused-port list |
| `hardening4.test.ts` password race | Failed on loaded CI runners (204, not 401) | The test assumed the admin's one scrypt finishes before the self change's two; the libuv threadpool does not order them | `Ctx.beforePasswordWrite`, a test-only hook the route awaits before its compare-and-swap write, so the test forces the interleaving it checks |
| `imports.test.ts` zip re-import hash | Hash mismatch on CI | fflate stamps the current time (2-second resolution) and the test rebuilt "the same" zip later | Hash the very bytes uploaded; never compare against a rebuilt archive |
| `imports.test.ts`, several tests across branches | A test got another test's repository tree | The fake GitHub served a zipball, a root tree and a tree id by commit sha across every repo, so two tests that picked the same `sha2()` collided | The fake resolves a sha within the repo asked for, as GitHub does, and its zipball redirect names the repo |

The pattern: a test that is green locally is not proven until it is green under load and at the clock or
port edges it silently depends on. Before calling a new test done, ask what ordering, time or shared state it
assumes, and pin that assumption in the test.
