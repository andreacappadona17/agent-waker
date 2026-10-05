/**
 * What a scheduler driver has to implement.
 *
 * The platform specifics of waking agent waker — a launchd LaunchAgent on
 * macOS, a systemd --user timer on Linux — sit behind this seam so a
 * new platform slots in without the core or the CLI learning its name. A
 * driver installs the schedule, describes what it finds, and removes it;
 * nothing above this line knows how.
 */

/** What to record so a tick can be launched with no shell and no user PATH. */
export interface SchedulerInstallConfig {
  /** Resolved at installation, since a job does not inherit shell settings. */
  readonly xdg?: Readonly<
    Record<
      "XDG_CONFIG_HOME" | "XDG_STATE_HOME" | "XDG_CACHE_HOME" | "XDG_DATA_HOME",
      string
    >
  >;
  /** The interpreter to run, as it exists right now. */
  readonly nodePath: string;
  /** The agent waker entry point, as it exists right now. */
  readonly entrypoint: string;
  readonly intervalSeconds: number;
  readonly logDirectory: string;
}

/** What the driver can say about the schedule it installed. */
export interface SchedulerStatus {
  readonly installed: boolean;
  readonly loaded: boolean;
  /** The scheduler's own job file: a plist on macOS, a unit on Linux. */
  readonly jobPath: string;
  readonly launcherPath: string;
  /** True when the launcher or one of its recorded paths is unusable. */
  readonly stalePath: boolean;
  readonly staleReason?: "launcher" | "node" | "entrypoint";
  readonly nodePath?: string;
  readonly entrypoint?: string;
  /** A version-specific nvm target can disappear on the next Node upgrade. */
  readonly nodeManagedByNvm?: boolean;
  readonly entrypointManagedByNvm?: boolean;
  readonly intervalSeconds?: number;
  /** Native unit definitions differ from the installed schedule or cannot be verified. */
  readonly definitionDrift?: boolean;
}

/** Install the schedule, describe it, or remove it — however the platform does. */
export interface SchedulerDriver {
  install(config: SchedulerInstallConfig): Promise<void>;
  inspect(): Promise<SchedulerStatus>;
  uninstall(): Promise<void>;
}
