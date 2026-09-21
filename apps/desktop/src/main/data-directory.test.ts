import { expect, it } from "vite-plus/test";
import { dataDirectory } from "./data-directory";
it("separates development, test, and production data and requires explicit test isolation", () => {
  expect(dataDirectory("/app-data", "development")).toBe("/app-data/Voice Development");
  expect(dataDirectory("/app-data", "production")).toBe("/app-data/Voice");
  expect(dataDirectory("/app-data", "test", "/test-run")).toBe("/test-run/Voice Test");
  expect(() => dataDirectory("/app-data", "test")).toThrow();
  expect(() => dataDirectory("/app-data", "test", "relative")).toThrow();
});
