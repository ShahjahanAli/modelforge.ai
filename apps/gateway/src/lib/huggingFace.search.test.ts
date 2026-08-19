import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadErrorMessage,
  isRetryableDownloadError,
  searchHuggingFaceModels,
} from "./huggingFace.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("searchHuggingFaceModels", () => {
  it("looks up exact owner/repo ids and searches by library=gguf, not filter=gguf", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/models/BanglaLLM/BanglaLLama-3.2-3b-unolp-culturax-base-v0.0.1") {
        return jsonResponse({
          id: "BanglaLLM/BanglaLLama-3.2-3b-unolp-culturax-base-v0.0.1",
          downloads: 10,
          likes: 1,
          tags: ["gguf"],
        });
      }
      if (url.pathname === "/api/models") {
        expect(url.searchParams.get("library")).toBe("gguf");
        expect(url.searchParams.get("filter")).toBeNull();
        return jsonResponse([]);
      }
      return jsonResponse({ error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const models = await searchHuggingFaceModels(
      "BanglaLLM/BanglaLLama-3.2-3b-unolp-culturax-base-v0.0.1",
    );

    expect(models.map((model) => model.id)).toEqual([
      "BanglaLLM/BanglaLLama-3.2-3b-unolp-culturax-base-v0.0.1",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns an empty list for queries shorter than two characters", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchHuggingFaceModels(" ")).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("large Hub download errors", () => {
  it("treats undici 'terminated' disconnects as retryable", () => {
    const terminated = new TypeError("terminated");
    const wrapped = new TypeError("fetch failed", { cause: terminated });
    expect(isRetryableDownloadError(terminated)).toBe(true);
    expect(isRetryableDownloadError(wrapped)).toBe(true);
    expect(downloadErrorMessage(wrapped)).toContain("terminated");
  });

  it("does not retry auth or disk errors", () => {
    expect(isRetryableDownloadError(new Error("Repository is private or gated"))).toBe(false);
    expect(isRetryableDownloadError(new Error("Not enough disk space: 0.2 GB free, 4.1 GB required"))).toBe(
      false,
    );
  });
});
