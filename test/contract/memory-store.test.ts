import { createMemoryStore } from "../../src/adapters/memory-store.ts";
import { storeContract } from "./blob-store.contract.ts";

storeContract("memory", async () => {
  const store = createMemoryStore();
  return { blobs: store, pointers: store, cleanup: async () => {} };
});
