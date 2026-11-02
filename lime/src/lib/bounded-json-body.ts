type BoundedBody =
  | { kind: "ok"; bytes: Uint8Array<ArrayBuffer> }
  | { kind: "too_large" | "timed_out" | "invalid" };

type BoundedJSONBody =
  | { kind: "ok"; value: unknown }
  | { kind: "too_large" | "timed_out" | "invalid" };

export async function readBoundedBody(
  request: Pick<Request, "body" | "signal">,
  options: { maxBytes: number; timeoutMs: number }
): Promise<BoundedBody> {
  if (!request.body) return { kind: "invalid" };

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    return { kind: "invalid" };
  }
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const signal = AbortSignal.any([request.signal, deadline]);
  // Grow geometrically so tiny chunks cannot amplify memory, while stalled
  // requests hold no payload buffer at all.
  let body = new Uint8Array(0);
  let size = 0;
  let reads = 0;
  let emptyReads = 0;

  const readChunk = () =>
    new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      if (signal.aborted) {
        void reader.cancel().catch(() => {});
        reject(signal.reason);
        return;
      }

      const onAbort = () => {
        void reader.cancel().catch(() => {});
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void reader.read().then(
        (result) => {
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });

  try {
    while (true) {
      const { done, value } = await readChunk();
      if (done) break;
      reads++;
      if (value.byteLength === 0 && ++emptyReads > 8192) {
        void reader.cancel().catch(() => {});
        return { kind: "too_large" };
      }
      const nextSize = size + value.byteLength;
      if (nextSize > options.maxBytes) {
        void reader.cancel().catch(() => {});
        return { kind: "too_large" };
      }
      if (nextSize > body.byteLength) {
        const capacity = Math.min(options.maxBytes, Math.max(4096, body.byteLength * 2, nextSize));
        const nextBody = new Uint8Array(capacity);
        nextBody.set(body.subarray(0, size));
        body = nextBody;
      }
      body.set(value, size);
      size = nextSize;
      if (reads % 128 === 0) {
        // A synchronously replenished stream can otherwise starve timer events.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        signal.throwIfAborted();
      }
    }

    return { kind: "ok", bytes: body.subarray(0, size) };
  } catch {
    return { kind: deadline.aborted ? "timed_out" : "invalid" };
  } finally {
    // An abort can settle our wait before the stream's pending read settles.
    try { reader.releaseLock(); } catch { /* cancellation is already in flight */ }
  }
}

export async function readBoundedJSONBody(
  request: Request,
  options: { maxBytes: number; timeoutMs: number }
): Promise<BoundedJSONBody> {
  const result = await readBoundedBody(request, options);
  if (result.kind !== "ok") return result;
  try {
    // Fetch's JSON parser accepts a UTF-8 BOM, like Request.json().
    return { kind: "ok", value: await new Response(result.bytes).json() };
  } catch {
    return { kind: "invalid" };
  }
}
