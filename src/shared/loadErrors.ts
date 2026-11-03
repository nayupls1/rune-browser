// What a web tab shows when its page doesn't load, like Chromium's error pages:
// "Your connection is not private" for certificate errors (with a way through,
// at your own risk), "This site can't be reached" and friends for the rest.
// Electron leaves the page blank, so the tab draws these (components/LoadError.tsx).

export interface LoadError {
  kind: "certificate" | "network";
  title: string;
  message: string;
  /** Chromium's error code as it shows it ("NET::ERR_CERT_AUTHORITY_INVALID", "ERR_NAME_NOT_RESOLVED"). */
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
