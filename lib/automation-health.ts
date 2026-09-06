export type AutomationHealthState =
  | "healthy"
  | "warning"
  | "critical"
  | "unknown";

export type AutomationRunRecord = {
  id?: number;
  status: string;
  summary: string;
  startedAt: string;
  finishedAt?: string | null;
};

export type OperationalEvent = {
  id: string;
  kind: "failure" | "recovery";
  occurredAt: string;
  title: string;
  detail: string;
  requiresManualAction: boolean;
  action: string;
  emailStatus: "sent" | "suppressed" | "failed" | "unconfigured";
};

export type AutomationHealth = {
  state: AutomationHealthState;
  label: string;
  detail: string;
  requiresManualAction: boolean;
  action: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  nextExpectedAt: string | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
  sessionRenewed: boolean | null;
};

export const CRON_STALE_AFTER_MS = 15 * 60 * 1000;
const CRON_INTERVAL_MS = 5 * 60 * 1000;

export function deriveAutomationHealth(
  runs: AutomationRunRecord[],
  options: { now?: Date; recoveryNoticePending?: boolean } = {},
): AutomationHealth {
  const now = options.now || new Date();
  const latest = runs[0];
  const lastSuccess = runs.find((run) => run.status === "success");
  const latestSummary = parseSummary(latest?.summary);
  const consecutiveFailures = runs.findIndex((run) => run.status === "success");
  const failureCount = consecutiveFailures < 0 ? runs.length : consecutiveFailures;
  const base = {
    lastRunAt: latest?.startedAt || null,
    lastSuccessAt: lastSuccess?.finishedAt || lastSuccess?.startedAt || null,
    nextExpectedAt: latest?.startedAt
      ? new Date(timestamp(latest.startedAt) + CRON_INTERVAL_MS).toISOString()
      : null,
    lastDurationMs:
      latest?.startedAt && latest?.finishedAt
        ? Math.max(0, timestamp(latest.finishedAt) - timestamp(latest.startedAt))
        : null,
    consecutiveFailures: failureCount,
    sessionRenewed:
      typeof latestSummary.sessionRenewed === "boolean"
        ? latestSummary.sessionRenewed
        : null,
  };

  if (!latest) {
    return {
      ...base,
      state: "unknown",
      label: "暂无生产任务记录",
      detail: "尚未观察到外部 Cron 调用记录。",
      requiresManualAction: true,
      action: "检查外部 Cron 是否已启用并正确调用 /api/jobs/run。",
    };
  }

  if (now.getTime() - timestamp(latest.startedAt) >= CRON_STALE_AFTER_MS) {
    return {
      ...base,
      state: "critical",
      label: "生产 Cron 已停止",
      detail: "超过 15 分钟没有新的生产任务记录。",
      requiresManualAction: true,
      action: "恢复外部 Cron；ChatGPT 定时任务不能代替订单扫描和自动发货。",
    };
  }

  if (latest.status === "running") {
    return {
      ...base,
      state: "warning",
      label: "生产任务执行中",
      detail: "本轮尚未完成；下一轮会自动回收超时记录。",
      requiresManualAction: false,
      action: "暂时无需操作，系统会继续观察。",
    };
  }

  if (latest.status !== "success") {
    const errorText = [latest.summary, ...summaryErrors(latestSummary)].join(" ");
    const manual = requiresManualLogin(errorText);
    return {
      ...base,
      state: manual ? "critical" : "warning",
      label: manual ? "闲鱼登录需要更新" : "生产任务本轮失败",
      detail: manual
        ? "自动续期已失败，订单扫描和自动发货可能中断。"
        : "当前更像是临时网络或上游异常，系统会自动重试。",
      requiresManualAction: manual,
      action: manual
        ? "请在系统设置中重新登录闲鱼。"
        : "暂时无需操作；若连续失败，系统会升级告警。",
    };
  }

  if (options.recoveryNoticePending) {
    return {
      ...base,
      state: "warning",
      label: "业务已恢复，恢复邮件待发送",
      detail: "闲鱼会话已恢复，但恢复通知尚未成功送达。",
      requiresManualAction: false,
      action: "无需重新登录；系统会继续重试恢复通知。",
    };
  }

  return {
    ...base,
    state: "healthy",
    label: "自动任务运行正常",
    detail: "外部 Cron 正常调用，最近一轮已完成。",
    requiresManualAction: false,
    action: "无需人工操作。",
  };
}

export function deriveOperationalEvents(
  runs: AutomationRunRecord[],
): OperationalEvent[] {
  return runs.flatMap((run) => {
    const summary = parseSummary(run.summary);
    const errors = summaryErrors(summary);
    const occurredAt = run.finishedAt || run.startedAt;
    const recoveryAlerts = Number(summary.recoveryAlerts || 0);
    const sessionRenewed = summary.sessionRenewed;
    const recoveryEmailError = errors.find((error) =>
      error.startsWith("保活恢复邮件："),
    );

    if (recoveryAlerts > 0 || recoveryEmailError) {
      return [
        {
          id: `recovery-${run.id || occurredAt}`,
          kind: "recovery" as const,
          occurredAt,
          title: "闲鱼会话已恢复",
          detail: recoveryEmailError || "会话校验与自动续期已恢复正常。",
          requiresManualAction: false,
          action: "无需人工操作，订单扫描与自动发货已继续。",
          emailStatus: eventEmailStatus(summary, "recovery", errors),
        },
      ];
    }

    if (sessionRenewed !== false) return [];
    const detail = errors.find((error) => !error.includes("邮件：")) ||
      "闲鱼会话校验或自动续期未成功。";
    const manual = requiresManualLogin([run.summary, ...errors].join(" "));
    return [
      {
        id: `failure-${run.id || occurredAt}`,
        kind: "failure" as const,
        occurredAt,
        title: manual ? "闲鱼登录需要更新" : "闲鱼会话保活暂时失败",
        detail,
        requiresManualAction: manual,
        action: manual
          ? "需要人工处理：请在系统设置中重新登录闲鱼。"
          : "暂不需要人工操作，系统会在下一轮自动重试。",
        emailStatus: eventEmailStatus(summary, "failure", errors),
      },
    ];
  });
}

function timestamp(value: string) {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  return new Date(normalized).getTime();
}

function parseSummary(value?: string) {
  try {
    return JSON.parse(value || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function summaryErrors(summary: Record<string, unknown>) {
  return Array.isArray(summary.errors) ? summary.errors.map(String) : [];
}

function eventEmailStatus(
  summary: Record<string, unknown>,
  kind: "failure" | "recovery",
  errors: string[],
): OperationalEvent["emailStatus"] {
  if (Number(summary[kind === "failure" ? "failureAlerts" : "recoveryAlerts"] || 0) > 0)
    return "sent";
  if (summary.emailConfigurationRequired) return "unconfigured";
  if (
    errors.some((error) =>
      error.startsWith(kind === "failure" ? "保活失败邮件：" : "保活恢复邮件："),
    )
  )
    return "failed";
  return "suppressed";
}

function requiresManualLogin(message: string) {
  if (/请求超时|网络|HTTP 5\d\d/i.test(message)) return false;
  return /AUTH_REQUIRED|SESSION_EXPIRED|FAIL_SYS_SESSION_EXPIRED|尚未配置闲鱼会话|登录.*失效|会话.*失效/i.test(
    message,
  );
}
