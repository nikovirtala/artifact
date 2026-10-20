// No live reload on AWS before M11 (AppSync Events): publishes notify nobody.
import type { Notifier } from "../../core/ports.ts";

export const noopNotifier: Notifier = { notify: async () => {} };
