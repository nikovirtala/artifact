# 0078. Session cookie format, keys and shared test vectors

Status: Accepted (M10)

## Context

M10 puts the viewing plane behind login. The edge function (CloudFront Functions, `cloudfront-js-2.0`) checks a session cookie on every viewer request, and the viewing Lambda signs that cookie after the OIDC callback. Both sides must agree on the format and the HMAC bit for bit, and the smoke script must be able to mint a cookie the edge accepts. The login itself needs a short-lived transaction cookie (state, nonce, PKCE verifier, return URL) that must never be usable as a session.

What the edge runtime offers decides the format:

- A `cloudfront-js-2.0` function reads its one KeyValueStore with `cf.kvs()` and `get()`, which returns a string by default and throws on a missing key ([Helper methods for key value stores](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-custom-methods.html)). `crypto.createHmac` supports `sha256`, and `digest` supports `base64url` ([JavaScript runtime 2.0 features](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-javascript-runtime-20.html)). AWS's `kvs-jwt-verify` sample verifies HMAC-SHA256 with a key read from KVS exactly this way ([aws-samples/amazon-cloudfront-functions](https://github.com/aws-samples/amazon-cloudfront-functions/tree/main/kvs-jwt-verify)) (V6).
- `crypto.timingSafeEqual` is not in the runtime's list, so the compare is written by hand (F3).
- A KVS value may be up to 1 KB and a key up to 512 bytes ([Quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)); two keys of 43 characters under 16-character names fit easily (F1).

## Decision

- **Key set** (the session secret): `{"version":1,"current":"<kid>","keys":{"<kid>":{"key":"<43 chars>","rotation":"<label>"}}}`, at most two keys (current and previous). `kid` is 16 lowercase hex characters; `key` is 32 random bytes in base64url without padding (43 characters). **The HMAC key is the UTF-8 bytes of that 43-character string** on both sides, because the edge passes the KVS string straight to `createHmac`; it is never base64-decoded. The template's placeholder `{"version":1,"current":null,"keys":{}}` is the empty set. `parseKeySet` rejects anything else with an error that names the field, never a value.
- **Session cookie** `__Secure-artifact_session=v1.<kid>.<payload>.<sig>`: `payload` is base64url of the JSON `{"sub","email","iat","exp"}` in that key order, with `exp = iat + 2592000` (30 days); `sig` is base64url HMAC-SHA256 over `v1.<kid>.<payload>`. A value is valid only if it matches `^v1\.([0-9a-f]{16})\.([A-Za-z0-9_-]{1,1024})\.([A-Za-z0-9_-]{43})$`, its `kid` names a key, the signature matches under a constant-time XOR compare, and `exp` is an integer later than now. The edge looks at nothing else; `verifySession` accepts exactly the same set. Attributes: `Domain=<view>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`.
- **Login-transaction cookie** `__Host-artifact_login=t1.<kid>.<payload>.<sig>` (`Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`, no `Domain`): payload `{"s","n","v","r","exp"}`, at most 2048 characters on verification. It is signed with a derived key, base64url(HMAC-SHA256(session key, `"artifact login transaction v1"`)), so a transaction cookie never verifies as a session cookie or the reverse, even with the prefix swapped. A cookie signed with the current or the previous `kid` is accepted.
- **Shared vectors** in `test/fixtures/session-vectors.json`: two fixed test keys, two valid session cookies (current and previous `kid`), the fourteen invalid cases (tampered payload or signature, `exp = now`, unknown `kid`, wrong prefix, missing or extra segment, uppercase `kid`, non-base64url payload, payload not JSON, `exp` missing or a string, a 42-character signature, empty), and valid and invalid transaction cookies. Invalid cases are signed correctly wherever the case allows, so each fails only for its own reason. The vectors were generated once with `signSession`/`signTransaction`; no generator is committed, and `test/runtime/session.test.ts` pins them byte for byte. The edge function's tests and the smoke script's minting lib consume the same file.

## Consequences

The edge and the Lambda cannot drift apart without a vector test failing. Rotation (ADR 0079) needs no format change: a new `kid` becomes current and the old one stays accepted until the next rotation. The test keys are fixed strings used nowhere else; real keys exist only in the session secret and the KeyValueStore.
