// The tarball CDK app (docs/decisions/0074): one generator for pack-test (b3) and the guide.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tarballAppFiles } from "../../scripts/lib/tarball-app.ts";

describe("tarballAppFiles", () => {
  it("names the class, the stack id and the files after the cdk init project", () => {
    const init = tarballAppFiles("init-app");
    assert.equal(init.stackId, "InitAppStack");
    assert.equal(init.bin.path, "bin/init-app.ts");
    assert.equal(init.stack.path, "lib/init-app-stack.ts");
    assert.match(init.bin.text, /import \{ InitAppStack \} from "\.\.\/lib\/init-app-stack";/);
    assert.match(init.bin.text, /new InitAppStack\(app, "InitAppStack", /);
    assert.match(init.stack.text, /export class InitAppStack extends Stack \{/);

    const tarball = tarballAppFiles("tarball-app");
    assert.equal(tarball.stackId, "TarballAppStack");
    assert.match(tarball.bin.text, /new TarballAppStack\(app, "TarballAppStack", /);
  });

  it("keeps the stack under 20 lines and free of domains, accounts and emails", () => {
    for (const name of ["init-app", "tarball-app"]) {
      const { bin, stack } = tarballAppFiles(name);
      assert.ok(stack.text.split("\n").filter((l) => l.trim() !== "").length < 20);
      for (const text of [bin.text, stack.text]) {
        assert.doesNotMatch(text, /\b\d{12}\b/);
        assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
        assert.doesNotMatch(text, /\b[a-z0-9-]+\.(dev|com|net|org|io)\b/);
      }
      assert.match(stack.text, /@nikovirtala\/artifact\/cdk/);
      assert.match(stack.text, /getContext\("zoneName"\)/);
      assert.match(stack.text, /getContext\("zoneId"\)/);
    }
  });
});
