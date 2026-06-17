type Listener = (event: string, data: unknown) => void;
export class EventBus {
  private listeners = new Set<Listener>();
  subscribe(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(event: string, data: unknown): void { for (const fn of this.listeners) fn(event, data); }
}
