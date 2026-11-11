// What a web tab shows when its page doesn't load, like Chromium's error pages:
// "Your connection is not private" for certificate errors (with a way through,
// at your own risk), "This site can't be reached" and friends for the rest.
// Electron leaves the page blank, so the tab draws these (components/LoadError.tsx).
// A page whose process went away (it crashed, ran out of memory, was killed) gets
// Chromium's sad tab: "Aw, Snap!" with the error code and Reload.

export interface LoadError {
  kind: "certificate" | "network" | "crash";
  title: string;
  message: string;
  /** Chromium's error code as it shows it ("NET::ERR_CERT_AUTHORITY_INVALID", "ERR_NAME_NOT_RESOLVED", "SIGKILL"). */
  code: string;
  /** Certificate errors: what's wrong, shown under Advanced. */
  advanced?: string;
  /** Things to try, like Chromium lists them. */
  tips?: string[];
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

const certificateReasons: Record<string, (host: string) => string> = {
  ERR_CERT_AUTHORITY_INVALID: (host) =>
    `This server could not prove that it is ${host}; its security certificate is not trusted by your computer's operating system. This may be caused by a misconfiguration or an attacker intercepting your connection.`,
  ERR_CERT_COMMON_NAME_INVALID: (host) =>
    `This server could not prove that it is ${host}; its security certificate is from another domain. This may be caused by a misconfiguration or an attacker intercepting your connection.`,
  ERR_CERT_DATE_INVALID: (host) =>
    `This server could not prove that it is ${host}; its security certificate has expired or isn't valid yet. This may be caused by a misconfiguration, an attacker intercepting your connection, or your computer's clock being wrong.`,
  ERR_CERT_REVOKED: (host) =>
    `This server could not prove that it is ${host}; its security certificate has been revoked. This may be caused by an attacker intercepting your connection.`,
  ERR_CERT_WEAK_SIGNATURE_ALGORITHM: (host) =>
    `The security certificate of ${host} is signed using a weak signature algorithm. This may be caused by a misconfiguration or an attacker intercepting your connection.`,
};

/**
 * The error page for a failed load. `code` is Chromium's net error number (negative)
 * and `description` its name ("ERR_NAME_NOT_RESOLVED"), as Electron reports them.
 * Null for failures that aren't errors (-3: the load was replaced or stopped).
 */
export function describeLoadError(code: number, description: string, url: string): LoadError | null {
  if (code === -3) return null;
  const host = hostOf(url);
  const name = /^ERR_[A-Z0-9_]+$/.test(description) ? description : `ERR_${-code}`;
  // -200 to -299 are certificate errors.
  if (code <= -200 && code > -300) {
    return {
      kind: "certificate",
      title: "Your connection is not private",
      message: `Attackers might be trying to steal your information from ${host} (for example, passwords, messages, or credit cards).`,
      code: `NET::${name}`,
      advanced: (
        certificateReasons[name] ??
        ((h) =>
          `This server could not prove that it is ${h}; its security certificate has a problem. This may be caused by a misconfiguration or an attacker intercepting your connection.`)
      )(host),
    };
  }
  const network = (title: string, message: string, tips?: string[]): LoadError => ({
    kind: "network",
    title,
    message,
    code: name,
    tips,
  });
  switch (name) {
    case "ERR_INTERNET_DISCONNECTED":
      return network("No internet", "There is something wrong with your connection.", [
        "Checking the network cables, modem, and router",
        "Reconnecting to Wi-Fi",
      ]);
    case "ERR_NAME_NOT_RESOLVED":
      return network("This site can't be reached", `${host}'s server IP address could not be found.`, [
        "Checking the connection",
        "Checking the address for typos",
      ]);
    case "ERR_CONNECTION_REFUSED":
      return network("This site can't be reached", `${host} refused to connect.`, [
        "Checking the connection",
        "Checking the proxy and the firewall",
      ]);
    case "ERR_CONNECTION_TIMED_OUT":
    case "ERR_TIMED_OUT":
      return network("This site can't be reached", `${host} took too long to respond.`, [
        "Checking the connection",
        "Checking the proxy and the firewall",
      ]);
    case "ERR_CONNECTION_RESET":
    case "ERR_CONNECTION_CLOSED":
    case "ERR_EMPTY_RESPONSE":
      return network(
        "This site can't be reached",
        name === "ERR_EMPTY_RESPONSE" ? `${host} didn't send any data.` : "The connection was reset.",
        ["Checking the connection", "Checking the proxy and the firewall"],
      );
    case "ERR_ADDRESS_UNREACHABLE":
      return network("This site can't be reached", `${host} is unreachable.`);
    case "ERR_TOO_MANY_REDIRECTS":
      return network("This page isn't working", `${host} redirected you too many times.`, ["Clearing your cookies"]);
    case "ERR_BLOCKED_BY_CLIENT":
      return network("This page has been blocked", `${host} is blocked by an extension or a network rule.`);
    case "ERR_FILE_NOT_FOUND":
      return network("Your file couldn't be accessed", "It may have been moved, edited, or deleted.");
    case "ERR_SSL_PROTOCOL_ERROR":
    case "ERR_SSL_VERSION_OR_CIPHER_MISMATCH":
      return network("This site can't provide a secure connection", `${host} sent an invalid response.`);
    default:
      return network(
        "This site can't be reached",
        `The page at ${host} might be temporarily down or it may have moved.`,
      );
  }
}

// --- Crashed pages ("Aw, Snap!") -----------------------------------------------------------------------

/** Why a page's process went away, as Electron says (`render-process-gone`). */
export type CrashReason =
  | "clean-exit"
  | "abnormal-exit"
  | "killed"
  | "crashed"
  | "oom"
  | "launch-failed"
  | "integrity-failure"
  | "memory-eviction";

/** Signals by number, as Chromium names them on Linux and macOS (where they differ, macOS's second). */
const SIGNALS: Record<number, [string, string?]> = {
  1: ["SIGHUP"],
  2: ["SIGINT"],
  3: ["SIGQUIT"],
  4: ["SIGILL"],
  5: ["SIGTRAP"],
  6: ["SIGABRT"],
  7: ["SIGBUS", "SIGEMT"],
  8: ["SIGFPE"],
  9: ["SIGKILL"],
  10: ["SIGUSR1", "SIGBUS"],
  11: ["SIGSEGV"],
  12: ["SIGUSR2", "SIGSYS"],
  13: ["SIGPIPE"],
  14: ["SIGALRM"],
  15: ["SIGTERM"],
};

/** Windows' exit codes, by the names Chromium shows ("Error code: STATUS_ACCESS_VIOLATION"). */
const WINDOWS_STATUS: Record<number, string> = {
  1: "RESULT_CODE_KILLED",
  2: "RESULT_CODE_HUNG",
  3: "RESULT_CODE_KILLED_BAD_MESSAGE",
  0xc0000005: "STATUS_ACCESS_VIOLATION",
  0x80000003: "STATUS_BREAKPOINT",
  0xc0000409: "STATUS_STACK_BUFFER_OVERRUN",
  0xc00000fd: "STATUS_STACK_OVERFLOW",
  0xc0000374: "STATUS_HEAP_CORRUPTION",
  0xc000001d: "STATUS_ILLEGAL_INSTRUCTION",
  0xc0000142: "STATUS_DLL_INIT_FAILED",
  0xc0000017: "STATUS_NO_MEMORY",
  0xc0000602: "STATUS_FAIL_FAST_EXCEPTION",
  0xc000041d: "STATUS_FATAL_USER_CALLBACK_EXCEPTION",
  0xe0000008: "Out of Memory",
};

/** The error code Chromium's sad tab shows for a page's process that went away. */
export function crashCode(reason: CrashReason, exitCode: number, platform: string): string {
  if (reason === "oom" || reason === "memory-eviction") return "Out of Memory";
  if (platform === "win32") {
    const unsigned = exitCode >>> 0;
    return (
      WINDOWS_STATUS[unsigned] ??
      (unsigned > 0xffff ? `0x${unsigned.toString(16).toUpperCase().padStart(8, "0")}` : String(exitCode))
    );
  }
  // Linux and macOS report the process's wait status: the signal that ended it in the low bits (0x80 when it
  // dumped core), or the code it exited with in the next byte.
  if (exitCode > 0xff && (exitCode & 0x7f) === 0) return String(exitCode >> 8);
  const signal = (reason === "killed" || reason === "crashed") && SIGNALS[exitCode & 0x7f];
  if (signal) return (platform === "darwin" ? signal[1] : undefined) ?? signal[0];
  return String(exitCode);
}

/**
 * Chromium's sad tab for a page whose process went away; null when it simply ended (clean-exit:
 * the tab closed or was unloaded). `again`: it went away again soon after a reload, so it lists
 * what to try, like Chromium does then.
 */
export function describeCrash(
  reason: CrashReason,
  exitCode: number,
  platform: string,
  again = false,
): LoadError | null {
  if (reason === "clean-exit") return null;
  return {
    kind: "crash",
    title: "Aw, Snap!",
    message: "Something went wrong while displaying this webpage.",
    code: `Error code: ${crashCode(reason, exitCode, platform)}`,
    tips: again
      ? ["Closing other tabs, extensions, or apps", "Restarting Rune Browser", "Restarting your computer"]
      : undefined,
  };
}
