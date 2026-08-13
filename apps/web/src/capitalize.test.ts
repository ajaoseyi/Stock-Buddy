import { describe, expect, it } from "vitest";
import { capitalizeFirst } from "./capitalize.js";

describe("capitalizeFirst", () => {
  it("uppercases the first letter of a lowercase string", () => {
    expect(capitalizeFirst("should i buy apple stocks")).toBe("Should i buy apple stocks");
  });

  it("leaves an already-capitalized string unchanged", () => {
    expect(capitalizeFirst("Should i buy apple stocks")).toBe("Should i buy apple stocks");
  });

  it("leaves the rest of the string untouched", () => {
    expect(capitalizeFirst("nvda vs AMD")).toBe("Nvda vs AMD");
  });

  it("handles an empty string", () => {
    expect(capitalizeFirst("")).toBe("");
  });

  it("handles a single character", () => {
    expect(capitalizeFirst("a")).toBe("A");
  });
});
