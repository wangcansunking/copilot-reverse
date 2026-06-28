type Listener = (event: string, data: unknown) => void;
export class EventBus {
  private listeners = new Set<Listener>();
  subscribe(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  // Isolate each listener: a throwing subscriber (e.g. an SSE write to a socket that died between
  // broadcasts) must not abort the broadcast to the others, nor escape to the process top level —
  // emit() is called synchronously from worker-message handling, so an uncaught throw here would
  // kill the in-process supervisor + TUI. A faulting listener is dropped so it isn't retried.
  emit(event: string, data: unknown): void {
    for (const fn of this.listeners) {
      try { fn(event, data); }
      catch { this.listeners.delete(fn); }
    }
  }
}
