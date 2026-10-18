export interface TransportStatusProjection<TTransport, TSynthetic> {
  readonly transport: TTransport;
  readonly synthetic: TSynthetic | null;
}

// Posture is a policy overlay, never a replacement for transport failure. A
// Failed helper truth clears that overlay before publication/readback so a
// renderer remount cannot resurrect posture_warning/posture_blocked over the
// actionable cleanup-required state.
export function projectTransportStatus<
  TTransport extends { readonly state: string },
  TSynthetic extends { readonly state: string },
>(
  synthetic: TSynthetic | null,
  transport: TTransport,
): TransportStatusProjection<TTransport, TSynthetic> {
  return {
    transport,
    synthetic: transport.state === "failed" ? null : synthetic,
  };
}

// Coalesce the renderer's high-frequency status polling into one helper read.
// This module deliberately imports no Electron/runtime code so its concurrency
// contract can be proved deterministically in the ordinary client test lane.
export class SingleFlightStatusReader<T> {
  private inFlight: Promise<T> | null = null;

  constructor(private readonly readStatus: () => Promise<T>) {}

  read(): Promise<T> {
    if (this.inFlight) return this.inFlight;

    // Enter the slot before invoking user code. The microtask boundary converts
    // a synchronous throw into a rejected Promise without opening a second-flight
    // window for another caller in the same turn.
    const request = Promise.resolve().then(() => this.readStatus());
    this.inFlight = request;

    // Supply both handlers instead of `finally`: a detached finally-Promise would
    // itself reject and can become an unhandled rejection. Identity protects a
    // future flight from a delayed cleanup belonging to this request.
    void request.then(
      () => this.release(request),
      () => this.release(request),
    );
    return request;
  }

  private release(request: Promise<T>): void {
    if (this.inFlight === request) this.inFlight = null;
  }
}

export interface HelperAccessBlocked {
  state: "failed";
  helper_error: "caller_untrusted";
}

// A trust refusal is an expected installation problem, not a transport verdict.
// Preserve that distinction and retry without hammering the privileged helper.
export class HelperAccessStatusReader<T> {
  private retryAt = 0;
  private blocked = false;
  constructor(
    private readonly readStatus: () => Promise<T>,
    private readonly now: () => number = Date.now,
    private readonly onBlocked: () => void = () => {},
  ) {}

  async read(): Promise<T | HelperAccessBlocked> {
    if (this.now() < this.retryAt) return { state: "failed", helper_error: "caller_untrusted" };
    try {
      const status = await this.readStatus();
      this.retryAt = 0;
      this.blocked = false;
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/^caller_untrusted:/.test(message)) throw error;
      this.retryAt = this.now() + 30_000;
      if (!this.blocked) this.onBlocked();
      this.blocked = true;
      return { state: "failed", helper_error: "caller_untrusted" };
    }
  }
}
