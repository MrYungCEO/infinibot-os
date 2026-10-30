// Android Ops method names, kept dependency-free so the advertised method
// list (server-methods-list.ts) can import them without loading the service.

/** Read-scoped methods, mirrored into the gateway's scope classification. */
export const ANDROID_OPS_READ_METHODS = [
  "androidops.dashboard",
  "androidops.devices.list",
  "androidops.device.history",
  "androidops.accounts.list",
  "androidops.media.list",
  "androidops.jobs.list",
  "androidops.audit.list",
  "androidops.inbox.list",
  "androidops.provisioning.list",
  "androidops.ops.status",
  "androidops.setup.status",
];

/** Write-scoped methods. */
export const ANDROID_OPS_WRITE_METHODS = [
  "androidops.fleet.refresh",
  "androidops.device.register",
  "androidops.device.remove",
  "androidops.device.update",
  "androidops.device.control",
  "androidops.device.control.stop",
  "androidops.device.agent_control",
  "androidops.account.update",
  "androidops.account.assign",
  "androidops.accounts.import",
  "androidops.media.create",
  "androidops.media.update",
  "androidops.schedule.create",
  "androidops.job.advance",
  "androidops.job.retry",
  "androidops.job.checkpoint.resolve",
  "androidops.pipeline.tick",
  "androidops.provisioning.start",
  "androidops.provisioning.step",
  "androidops.inbox.update",
  "androidops.alert.ack",
  "androidops.backup.run",
  "androidops.seed",
];
