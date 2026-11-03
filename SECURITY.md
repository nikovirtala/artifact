# Security Policy

## Supported versions

This project is pre-1.0. Releases are published to npm as `@nikovirtala/artifact`, and the version is derived from git tags (see [RELEASING.md](RELEASING.md)). The latest published version on npm is the only supported version; please reproduce any report against it before filing.

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.

- Preferred: use GitHub's private vulnerability reporting through the repository's [Security Advisories](https://github.com/nikovirtala/artifact/security/advisories/new). This keeps the report private between you and the maintainer until a fix is ready.
- Alternatively, contact the maintainer directly:
  <!-- TODO(maintainer): add a security contact email -->
  **TODO: add security contact.**

Include the affected version, the environment (OS and Node version), steps to reproduce, and the impact you observed.

## Coordinated disclosure

- We aim to acknowledge a report within 3 business days.
- We aim to agree on a remediation plan and target date within 10 business days of acknowledgement.
- Please give us a reasonable window to ship a fix before any public disclosure, and we will credit you in the release notes unless you prefer otherwise.

## Threat model

`artifact` is a local-first tool. By default `artifact serve` binds only to the loopback address (`127.0.0.1` and `::1`), so the server is not reachable from the network. Binding to a non-loopback address with `--host` requires `ARTIFACT_TOKEN` to be set; when it is set, `/api` and `/mcp` require `Authorization: Bearer <token>` while viewing stays open. These defaults are documented in the README [Serve](README.md#serve) table. Running the server off loopback, or exposing it to untrusted networks, is outside the default threat model and is the operator's responsibility.
