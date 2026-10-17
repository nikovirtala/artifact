# 0008. npm package name

Status: Accepted (M2)

## Question

Publish as `@nikovirtala/artifact`, or as unscoped `artifact` if it is free? The CLI binary is `artifact` either way.

## Findings

The unscoped name is taken: `npm view artifact` shows version 0.5.1, last modified 2022-06-13. `@nikovirtala/artifact` is not published yet.

## Decision

Publish as `@nikovirtala/artifact`, which is what `package.json` already uses. The quick start is `npx @nikovirtala/artifact serve`. Getting the unscoped name would mean a dispute with its owner, which v1 does not need.
