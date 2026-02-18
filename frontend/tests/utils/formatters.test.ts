import { describe, it, expect } from "vitest";
import { formatBytes } from "../../src/utils/format/bytes.ts";
import { formatDate, formatDateTime } from "../../src/utils/format/date.ts";
import { formatDuration, formatEta } from "../../src/utils/format/time.ts";

describe("formatBytes", () => {
  it('returns "0 B" for zero bytes', () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("formats bytes correctly", () => {
    expect(formatBytes(500)).toBe("500 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(1024)).toBe("1.00 KB");
    expect(formatBytes(1536)).toBe("1.50 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(1048576)).toBe("1.00 MB");
    expect(formatBytes(1572864)).toBe("1.50 MB");
  });

  it("formats gigabytes", () => {
    expect(formatBytes(1073741824)).toBe("1.00 GB");
  });

  it("formats terabytes", () => {
    expect(formatBytes(1099511627776)).toBe("1.00 TB");
  });
});

describe("formatEta", () => {
  it('returns "--" for null/undefined', () => {
    expect(formatEta(null)).toBe("--");
    expect(formatEta(undefined)).toBe("--");
  });

  it('returns "--" for negative values', () => {
    expect(formatEta(-5)).toBe("--");
  });

  it("formats seconds", () => {
    expect(formatEta(30)).toBe("30s");
    expect(formatEta(1)).toBe("1s");
  });

  it("formats minutes and seconds", () => {
    expect(formatEta(90)).toBe("1m 30s");
    expect(formatEta(125)).toBe("2m 5s");
  });

  it("formats hours and minutes", () => {
    expect(formatEta(3661)).toBe("1h 1m");
    expect(formatEta(7200)).toBe("2h 0m");
  });
});

describe("formatDuration", () => {
  it("formats sub-second durations as milliseconds", () => {
    expect(formatDuration(0.5)).toBe("500ms");
    expect(formatDuration(0.001)).toBe("1ms");
  });

  it("formats seconds with one decimal", () => {
    expect(formatDuration(5.3)).toBe("5.3s");
    expect(formatDuration(30.0)).toBe("30.0s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(90)).toBe("1m 30s");
    expect(formatDuration(125)).toBe("2m 5s");
  });
});

describe("formatDate", () => {
  it("formats a Unix epoch into a locale date string (date only)", () => {
    // 2024-01-15 10:30:00 UTC = 1705311000
    const result = formatDate(1705311000);
    // Should contain date components (locale-dependent formatting)
    expect(result).toContain("Jan");
    expect(result).toContain("15");
    expect(result).toContain("2024");
    // Should NOT contain time
    expect(result).not.toContain(":");
  });
});

describe("formatDateTime", () => {
  it('returns "-" for null/undefined', () => {
    expect(formatDateTime(null)).toBe("-");
    expect(formatDateTime(undefined)).toBe("-");
  });

  it('returns "-" for zero', () => {
    expect(formatDateTime(0)).toBe("-");
  });

  it("formats a Unix epoch into a locale datetime string", () => {
    // 2024-01-15 10:30:00 UTC = 1705311000
    const result = formatDateTime(1705311000);
    // Should contain date components (locale-dependent formatting)
    expect(result).toContain("Jan");
    expect(result).toContain("15");
    expect(result).toContain("2024");
    // Should also contain time
    expect(result).toContain(":");
  });
});
