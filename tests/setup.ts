import { beforeEach } from "vitest";

export const TEST_DAEMON_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeEach(() => {
  process.env.SYMPHONY_DAEMON_SECRET = TEST_DAEMON_SECRET;
});
