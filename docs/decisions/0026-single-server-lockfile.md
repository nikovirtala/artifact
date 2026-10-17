# 0026. One server per root: `<root>/.lock`

Status: Accepted (M2)

## Context

The fs store's pointer lock is in-process (0018). Two `serve` processes on one root could interleave pointer writes.

## Decision

- On startup, before listening, `serve` creates `<root>/.lock` exclusively (`wx`) holding `{"pid", "port", "startedAt"}`.
- If it exists and its pid is alive (`process.kill(pid, 0)` succeeds or fails with `EPERM`), exit non-zero: `artifact: <root> is already served by PID <pid> on port <port>; delete <path> if stale`.
- If the pid is dead (`ESRCH`), take over: remove the file, create it again with `wx`, and print `artifact: took over stale lock from PID <pid>`. If that second create loses to another process, report "already served". An unparsable lock file is an error that names the path.
- The lock is removed on shutdown (SIGINT, SIGTERM, process exit), and only if it still holds our pid.
- The fs store rejects `.lock` as a key and skips it at the root when listing, like `.tmp/`.
- The lock is taken before the port is bound, so a second `serve` on the same root reports the lock even on another port.

## Consequences

A crash leaves the file behind, but a dead pid is detected and taken over. PID reuse can make a stale lock look alive; the message tells the user which file to delete.
