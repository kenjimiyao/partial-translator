import { describe, expect, it, vi } from "vitest";

import { requestTranslations } from "../src/background/openai";
import { TRANSLATION_INSTRUCTIONS } from "../src/shared/constants";

const payload = {
  page_title: "記事",
  page_url: "https://example.com/article",
  target_count: 1,
  items: [{ id: "sentence-0001", text: "これは文章です。", section_heading: "見出し" }],
};

function apiResponse(outputText: string): Response {
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: outputText }],
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("Responses API client", () => {
  it("uses the required model, privacy, reasoning, instructions, and schema parameters", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      apiResponse(
        JSON.stringify({
          translations: [{ id: "sentence-0001", english: "This is a sentence." }],
        }),
      ),
    );

    await requestTranslations("secret-key", payload, { fetchImpl: fetchMock });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "gpt-5.6-luna",
      reasoning: { effort: "none" },
      store: false,
      instructions: TRANSLATION_INSTRUCTIONS,
      text: {
        format: {
          type: "json_schema",
          strict: true,
          schema: {
            required: ["translations"],
            additionalProperties: false,
            properties: {
              translations: {
                items: {
                  required: ["id", "english"],
                  additionalProperties: false,
                },
              },
            },
          },
        },
      },
    });
    expect(body.tools).toBeUndefined();
    expect(JSON.parse(body.input)).toEqual(payload);
    expect(String((init?.headers as Record<string, string>).Authorization)).toBe(
      "Bearer secret-key",
    );
  });

  it("retries a validation failure once", async () => {
    const fetchMock = vi
      .fn(async (_input: RequestInfo | URL, _init?: RequestInit) => apiResponse(""))
      .mockResolvedValueOnce(apiResponse('{"translations":[]}'))
      .mockResolvedValueOnce(
        apiResponse(
          JSON.stringify({
            translations: [{ id: "sentence-0001", english: "This is a sentence." }],
          }),
        ),
      );

    await expect(
      requestTranslations("secret-key", payload, { fetchImpl: fetchMock }),
    ).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries malformed HTTP JSON once as an invalid response", async () => {
    const fetchMock = vi
      .fn(async (_input: RequestInfo | URL, _init?: RequestInit) => apiResponse(""))
      .mockResolvedValueOnce(
        new Response("not-json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        apiResponse(
          JSON.stringify({
            translations: [{ id: "sentence-0001", english: "This is a sentence." }],
          }),
        ),
      );

    await expect(
      requestTranslations("secret-key", payload, { fetchImpl: fetchMock }),
    ).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a JSON null response once as an invalid response", async () => {
    const fetchMock = vi
      .fn(async () => apiResponse(""))
      .mockResolvedValueOnce(
        new Response("null", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        apiResponse(
          JSON.stringify({
            translations: [{ id: "sentence-0001", english: "This is a sentence." }],
          }),
        ),
      );

    await expect(
      requestTranslations("secret-key", payload, { fetchImpl: fetchMock }),
    ).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not expose an API error response body", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('{"error":{"message":"leaked-body"}}', { status: 401 }),
    );
    await expect(
      requestTranslations("secret-key", payload, { fetchImpl: fetchMock }),
    ).rejects.not.toThrow(/leaked-body|secret-key/);
  });

  it.each([
    [401, "API_UNAUTHORIZED"],
    [429, "API_RATE_LIMITED"],
    [500, "API_ERROR"],
  ] as const)("maps HTTP %i to %s without retrying", async (status, code) => {
    const fetchMock = vi.fn(async () => new Response("private response body", { status }));

    await expect(
      requestTranslations("secret-key", payload, { fetchImpl: fetchMock }),
    ).rejects.toMatchObject({ code });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps an aborted request to a timeout without retrying", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("missing abort signal"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("request aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    await expect(
      requestTranslations("secret-key", payload, {
        fetchImpl: fetchMock,
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps an abort while reading the response body to a timeout", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const signal = init?.signal;
        return {
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => reject(new DOMException("body aborted", "AbortError")),
                { once: true },
              );
            }),
        } as Response;
      },
    );

    await expect(
      requestTranslations("secret-key", payload, {
        fetchImpl: fetchMock,
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a shared job-deadline abort to a timeout", async () => {
    const jobController = new AbortController();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("job aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    const request = requestTranslations("secret-key", payload, {
      fetchImpl: fetchMock,
      timeoutMs: 10_000,
      signal: jobController.signal,
    });
    jobController.abort();

    await expect(request).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a network failure without exposing its details", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => {
      throw new Error("private network diagnostic");
    });

    await expect(
      requestTranslations("secret-key", payload, { fetchImpl: fetchMock }),
    ).rejects.toMatchObject({
      code: "API_ERROR",
      message: expect.not.stringContaining("private network diagnostic"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
