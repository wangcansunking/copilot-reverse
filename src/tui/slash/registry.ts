export interface SlashContext {
  client: {
    status(): Promise<import("../../shared/control-types.js").StatusResponse>;
    restart(): Promise<void>; stop(): Promise<void>; start(): Promise<void>;
    doctor(): Promise<import("../../shared/control-types.js").DoctorCheck[]>;
    requests(): Promise<import("../../shared/control-types.js").MetricSample[]>;
  };
  quit: () => void;
}
export interface SlashCommand {
  name: string;
  describe: string;
  hidden?: boolean; // omitted from list()/help & autocomplete, but still runnable (e.g. /webiq)
  run(args: string[], ctx: SlashContext): Promise<string[]>;
}
export class Registry {
  private cmds = new Map<string, SlashCommand>();
  constructor(private ctx: SlashContext) {}
  add(cmd: SlashCommand): this { this.cmds.set(cmd.name, cmd); return this; }
  // Visible commands only — hidden ones (e.g. /webiq) are runnable but never advertised.
  list(): SlashCommand[] { return [...this.cmds.values()].filter((c) => !c.hidden); }
  async run(line: string): Promise<string[]> {
    const [name, ...args] = line.trim().split(/\s+/);
    const cmd = this.cmds.get(name);
    if (!cmd) return [`unknown command: ${name} (try /help)`];
    return cmd.run(args, this.ctx);
  }
}
