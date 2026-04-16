import { decodeRevert } from "../../../../../utils/decodeRevert";
import { normalizeLiveScriptId } from "./_scriptStatus";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveAttemptTimeoutMs() {
  const raw = process.env.LIVE_NETWORK_ATTEMPT_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed >= 0) {
    return Math.floor(parsed);
  }
  return 180_000;
}

function resolveRetryOnTimeout() {
  const raw = process.env.LIVE_NETWORK_RETRY_ON_TIMEOUT?.trim().toLowerCase();
  if (!raw) {
    return false;
  }
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

async function withAttemptTimeout<T>(
  label: string,
  attempt: number,
  timeoutMs: number,
  action: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            `${label} timed out after ${timeoutMs}ms on attempt ${attempt}; probable live RPC stall`,
          ) as Error & { code?: string };
          error.code = "ETIMEDOUT";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function extractRevertData(error: any): string | null {
  const data = error?.data ?? error?.error?.data ?? error?.info?.error?.data ?? error?.info?.data;
  if (typeof data === "string") {
    return data;
  }
  if (data && typeof data === "object" && typeof data.data === "string") {
    return data.data;
  }
  return null;
}

function truncate(value: string, max = 600) {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...<truncated>`;
}

function formatFailureDetails(error: any) {
  const details: string[] = [];
  const append = (label: string, value: unknown) => {
    if (value === undefined || value === null || value === "") {
      return;
    }
    details.push(`${label}: ${String(value)}`);
  };

  append("name", error?.name);
  append("message", error?.message);
  append("shortMessage", error?.shortMessage);
  append("code", error?.code);
  append("action", error?.action);
  append("reason", error?.reason);

  const revertData = extractRevertData(error);
  if (revertData) {
    append("revertData", truncate(revertData));
    append("decodedRevert", decodeRevert(revertData));
  }

  const transaction = error?.transaction;
  if (transaction) {
    append("tx.from", transaction.from);
    append("tx.to", transaction.to);
    append("tx.value", transaction.value);
    append("tx.data", truncate(String(transaction.data ?? "")));
  }

  const receipt = error?.receipt;
  if (receipt) {
    append("receipt.status", receipt.status);
    append("receipt.hash", receipt.hash);
    append("receipt.blockNumber", receipt.blockNumber);
    append("receipt.gasUsed", receipt.gasUsed);
    append("receipt.cumulativeGasUsed", receipt.cumulativeGasUsed);
    append("receipt.gasPrice", receipt.gasPrice);
    append("receipt.from", receipt.from);
    append("receipt.to", receipt.to);
  }

  if (error?.stack) {
    details.push("stack:");
    details.push(String(error.stack));
  }

  return details.join("\n");
}

function classifyFailure(error: any) {
  const message = String(error?.message ?? "");
  if (message.includes("[SSOT_DEPLOYMENT_MISMATCH]")) {
    return "deployment-ssot-mismatch";
  }
  if (isRetryableNetworkError(error)) {
    return "network-transient";
  }
  return "business-logic-or-assertion";
}

export function isRetryableNetworkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as any).code ?? "") : "";
  const retryOnTimeout = resolveRetryOnTimeout();
  if (message.includes("[SSOT_DEPLOYMENT_MISMATCH]")) {
    return false;
  }
  if (code === "ETIMEDOUT" || message.includes(" timed out after ")) {
    return retryOnTimeout;
  }
  return code === "ECONNRESET"
    || code === "-32001"
    || code === "ENOTFOUND"
    || code === "EAI_AGAIN"
    || code === "UND_ERR_CONNECT_TIMEOUT"
    || code === "UND_ERR_HEADERS_TIMEOUT"
    || code === "UND_ERR_SOCKET"
    || message.includes("ECONNRESET")
    || message.includes("ENOTFOUND")
    || message.includes("EAI_AGAIN")
    || message.includes("Headers Timeout Error")
    || message.includes("other side closed")
    || message.includes("socket hang up")
    || message.includes("Unable to complete request at this time.");
}

export async function runWithNetworkRetry(
  scriptLabel: string,
  action: () => Promise<void>,
  options?: { maxAttempts?: number; baseDelayMs?: number },
) {
  const resolvedScriptLabel = normalizeLiveScriptId(scriptLabel);
  const envAttemptsRaw = process.env.LIVE_NETWORK_MAX_ATTEMPTS?.trim();
  const envDelayRaw = process.env.LIVE_NETWORK_BASE_DELAY_MS?.trim();
  const envAttempts = envAttemptsRaw ? Number(envAttemptsRaw) : NaN;
  const envDelayMs = envDelayRaw ? Number(envDelayRaw) : NaN;

  const maxAttempts = options?.maxAttempts
    ?? (Number.isFinite(envAttempts) && envAttempts >= 1 ? Math.floor(envAttempts) : 3);
  const baseDelayMs = options?.baseDelayMs
    ?? (Number.isFinite(envDelayMs) && envDelayMs >= 0 ? Math.floor(envDelayMs) : 1500);
  const attemptTimeoutMs = resolveAttemptTimeoutMs();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (attempt > 1) {
        console.log(`  [Retry] starting attempt ${attempt}/${maxAttempts} timeoutMs=${attemptTimeoutMs <= 0 ? "disabled" : attemptTimeoutMs}`);
      }
      if (attemptTimeoutMs > 0) {
        await withAttemptTimeout(resolvedScriptLabel, attempt, attemptTimeoutMs, action);
      } else {
        await action();
      }
      return;
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableNetworkError(error)) {
        const failureCategory = classifyFailure(error);
        console.error(`\n❌ ${resolvedScriptLabel} FAILED\n`);
        console.error(`failureCategory: ${failureCategory}`);
        console.error(formatFailureDetails(error));
        process.exit(1);
      }
      console.log(`  [Retry] network error on attempt ${attempt}/${maxAttempts}: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(baseDelayMs * attempt);
    }
  }
}