import { describe, expect, test } from "bun:test";
import { createCipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { encrypt } from "web-push";
import { Schema } from "effect";
import { BrowserSettings, defaultBrowserSettings } from "../src/shared/browser";
import {
  decodeBase64,
  encodeBase64Url,
  endpointFor,
  isTopic,
  newTopic,
  notificationFrom,
  NTFY_SH,
  parseNtfyLine,
  pushServerOf,
  TOPIC_LENGTH,
  validPushServer,
} from "../src/shared/push";
import { decryptPushMessage, newSubscriptionKeys, seal, unseal } from "../src/main/pushCrypto";

const b64 = (s: string) => Buffer.from(decodeBase64(s)!);

describe("push: decrypting messages (aes128gcm)", () => {
  test("RFC 8291's example message", () => {
    // RFC 8291, Appendix A.
    const keys = {
      privateKey: b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"),
      auth: b64("BTBZMqHH6r4Tts7J_aSIgg"),
    };
    const body = b64(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
    expect(decryptPushMessage(body, keys)?.toString("utf8")).toBe("When I grow up, I want to be a watermelon");
  });

  test("messages the web-push library encrypts, of every size a push can have", () => {
    const keys = newSubscriptionKeys();
    for (const payload of ["", "hi", JSON.stringify({ title: "Hello", body: "é ✓ 🎉" }), "x".repeat(3993)]) {
      const { cipherText } = encrypt(
        encodeBase64Url(keys.publicKey),
        encodeBase64Url(keys.auth),
        Buffer.from(payload),
        "aes128gcm",
      );
      expect(decryptPushMessage(cipherText, keys)?.toString("utf8")).toBe(payload);
    }
  });

  test("a message for other keys, without the auth secret, or damaged doesn't decrypt", () => {
    const keys = newSubscriptionKeys();
    const other = newSubscriptionKeys();
    const { cipherText } = encrypt(encodeBase64Url(keys.publicKey), encodeBase64Url(keys.auth), "secret", "aes128gcm");
    expect(decryptPushMessage(cipherText, other)).toBeNull();
    expect(decryptPushMessage(cipherText, { privateKey: keys.privateKey, auth: randomBytes(16) })).toBeNull();
    const damaged = Buffer.from(cipherText);
    damaged[damaged.length - 3]! ^= 1;
    expect(decryptPushMessage(damaged, keys)).toBeNull();
    expect(decryptPushMessage(cipherText.subarray(0, 40), keys)).toBeNull();
    expect(decryptPushMessage(randomBytes(200), keys)).toBeNull();
    expect(decryptPushMessage(new Uint8Array(), keys)).toBeNull();
  });

  test("aesgcm (the older encoding) isn't taken: its salt and key would be in headers ntfy doesn't pass on", () => {
    const keys = newSubscriptionKeys();
    const { cipherText } = encrypt(encodeBase64Url(keys.publicKey), encodeBase64Url(keys.auth), "old", "aesgcm");
    expect(decryptPushMessage(cipherText, keys)).toBeNull();
  });

  test("a message in several records (RFC 8188), each with its own nonce", () => {
    const keys = newSubscriptionKeys();
    const sender = createECDH("prime256v1");
    const senderKey = sender.generateKeys();
    const salt = randomBytes(16);
    const hmac = (key: Uint8Array, ...data: Uint8Array[]) => {
      const h = createHmac("sha256", key);
      for (const d of data) h.update(d);
      return h.digest();
    };
    const ikm = hmac(
      hmac(keys.auth, sender.computeSecret(keys.publicKey)),
      Buffer.concat([Buffer.from("WebPush: info\0"), keys.publicKey, senderKey, Buffer.from([1])]),
    );
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
    const rs = 40;
    const chunks = ["first part, ", "second part, ", "the end"];
    const records = chunks.map((chunk, i) => {
      const last = i === chunks.length - 1;
      const plain = Buffer.concat([Buffer.from(chunk), Buffer.from([last ? 2 : 1])]);
      const padded = last ? plain : Buffer.concat([plain, Buffer.alloc(rs - 16 - plain.length)]);
      const n = Buffer.from(nonce);
      n.writeUInt32BE((n.readUInt32BE(8) ^ i) >>> 0, 8);
      const cipher = createCipheriv("aes-128-gcm", cek, n);
      return Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
    });
    const header = Buffer.alloc(21);
    salt.copy(header);
    header.writeUInt32BE(rs, 16);
    header[20] = 65;
    const body = Buffer.concat([header, senderKey, ...records]);
    expect(decryptPushMessage(body, keys)?.toString()).toBe(chunks.join(""));
    // Records swapped: their nonces don't match anymore.
    const swapped = Buffer.concat([header, senderKey, records[1]!, records[0]!, records[2]!]);
    expect(decryptPushMessage(swapped, keys)).toBeNull();
  });

  test("sealed secrets open only with their key", () => {
    const key = randomBytes(32);
    const sealed = seal(key, { privateKey: "a", auth: "b" });
    expect(unseal(key, sealed)).toEqual({ privateKey: "a", auth: "b" });
    expect(unseal(randomBytes(32), sealed)).toBeNull();
    expect(unseal(key, "not sealed")).toBeNull();
  });
});

describe("push: topics and endpoints", () => {
  test("topics are ntfy's UnifiedPush form: up and 12 letters or digits", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const topic = newTopic((n) => randomBytes(n));
      expect(topic).toHaveLength(TOPIC_LENGTH);
      expect(topic).toMatch(/^up[A-Za-z0-9]{12}$/);
      expect(isTopic(topic)).toBe(true);
      seen.add(topic);
    }
    expect(seen.size).toBe(200);
  });

  test("bytes that would favor some letters are skipped", () => {
    // 248…255 would make the first letters likelier: skipped; 0 is "A", 61 is "9", 62 wraps around to "A".
    const bytes = [255, 250, 248, 0, 61, 62, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const topic = newTopic((n) => Uint8Array.from({ length: n }, (_, i) => bytes[i] ?? 0));
    expect(topic).toBe("upA9ABCDEFGHIJ");
  });

  test("isTopic refuses anything else", () => {
    for (const bad of ["up", "upABC", "upABCDEFGHIJK!", "xyABCDEFGHIJKL", "upABCDEFGHIJKLM", 42, null])
      expect(isTopic(bad)).toBe(false);
  });

  test("the endpoint is the topic on the server, in UnifiedPush mode", () => {
    expect(endpointFor(NTFY_SH, "upABCDEFGHIJKL")).toBe("https://ntfy.sh/upABCDEFGHIJKL?up=1");
    expect(endpointFor("https://push.example.com/ntfy", "upABCDEFGHIJKL")).toBe(
      "https://push.example.com/ntfy/upABCDEFGHIJKL?up=1",
    );
  });
});

describe("push: the setting", () => {
  test("defaults to ntfy.sh", () => {
    const b = defaultBrowserSettings();
    expect(b.push).toEqual({ service: "ntfy", server: "" });
    expect(pushServerOf(b)).toBe(NTFY_SH);
  });

  test("only the three services are valid", () => {
    const decode = Schema.decodeUnknownSync(BrowserSettings);
    expect(decode({ push: { service: "off" } }).push).toEqual({ service: "off", server: "" });
    expect(() => decode({ push: { service: "gcm" } })).toThrow();
  });

  test("your own server: https, or http on this computer only", () => {
    expect(validPushServer("https://ntfy.example.com")).toBe("https://ntfy.example.com");
    expect(validPushServer(" https://ntfy.example.com/ ")).toBe("https://ntfy.example.com");
    expect(validPushServer("https://example.com:8443/push/")).toBe("https://example.com:8443/push");
    expect(validPushServer("http://localhost:2586")).toBe("http://localhost:2586");
    expect(validPushServer("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(validPushServer("http://[::1]:80")).toBe("http://[::1]");
    for (const bad of [
      "",
      "ntfy.example.com",
      "http://ntfy.example.com",
      "http://192.168.1.2",
      "ftp://ntfy.example.com",
      "https://user:pass@ntfy.example.com",
      "https://ntfy.example.com/?x=1",
      "https://ntfy.example.com/#top",
      "javascript:alert(1)",
    ])
      expect(validPushServer(bad)).toBeNull();
  });

  test("the server in effect: ntfy.sh, yours once it's valid, none when off", () => {
    const b = defaultBrowserSettings();
    const with_ = (push: BrowserSettings["push"]) => pushServerOf({ ...b, push });
    expect(with_({ service: "off", server: "https://ntfy.example.com" })).toBeNull();
    expect(with_({ service: "custom", server: "" })).toBeNull();
    expect(with_({ service: "custom", server: "http://ntfy.example.com" })).toBeNull();
    expect(with_({ service: "custom", server: "https://ntfy.example.com/" })).toBe("https://ntfy.example.com");
    expect(with_({ service: "ntfy", server: "https://ntfy.example.com" })).toBe(NTFY_SH);
  });
});

describe("push: ntfy's stream", () => {
  const topic = "upABCDEFGHIJKL";
  test("a UnifiedPush message's binary body comes base64-encoded", () => {
    const bytes = randomBytes(300);
    const line = JSON.stringify({
      id: "WufcC36nH3pr",
      time: 1794470233,
      expires: 1794513433,
      event: "message",
      topic,
      message: bytes.toString("base64"),
      encoding: "base64",
    });
    const event = parseNtfyLine(line);
    expect(event).toMatchObject({ kind: "message", id: "WufcC36nH3pr", time: 1794470233, topic });
    expect(event?.kind === "message" && Buffer.from(event.body).equals(bytes)).toBe(true);
  });

  test("a text body is its UTF-8 bytes", () => {
    const event = parseNtfyLine(JSON.stringify({ id: "a1", time: 5, event: "message", topic, message: "héllo" }));
    expect(event?.kind === "message" && Buffer.from(event.body).toString()).toBe("héllo");
  });

  test("open and keepalive events carry the server's time", () => {
    expect(
      parseNtfyLine(JSON.stringify({ id: "x", time: 7, event: "open", topic: `${topic},upZZZZZZZZZZZZ` })),
    ).toEqual({
      kind: "open",
      time: 7,
    });
    expect(parseNtfyLine(JSON.stringify({ id: "x", time: 9, event: "keepalive", topic }))).toEqual({
      kind: "keepalive",
      time: 9,
    });
  });

  test("anything else is nothing", () => {
    const message = { id: "a1", time: 5, event: "message", topic, message: "aGk=", encoding: "base64" };
    for (const bad of [
      "",
      "not json",
      "null",
      "[]",
      JSON.stringify({ ...message, event: "poll_request" }),
      JSON.stringify({ ...message, topic: "mytopic" }),
      JSON.stringify({ ...message, id: "bad id!" }),
      JSON.stringify({ ...message, time: "5" }),
      JSON.stringify({ ...message, message: "not base64!" }),
      JSON.stringify({ ...message, encoding: "gzip" }),
      JSON.stringify({ ...message, message: "x".repeat(9000) }),
      JSON.stringify({ ...message, attachment: { name: "attachment.bin", url: "https://ntfy.sh/file/x" } }),
    ])
      expect(parseNtfyLine(bad)).toBeNull();
  });

  test("base64 in either alphabet, with or without padding", () => {
    const bytes = Uint8Array.from([251, 255, 0, 1, 2]);
    expect(decodeBase64("+/8AAQI=")).toEqual(bytes);
    expect(decodeBase64("-_8AAQI")).toEqual(bytes);
    expect(encodeBase64Url(bytes)).toBe("-_8AAQI");
    expect(decodeBase64("a")).toBeNull();
    expect(decodeBase64("ab$c")).toBeNull();
  });
});

describe("push: notifications", () => {
  test("a notification's options are checked and cut to size", () => {
    const n = notificationFrom(
      "id1",
      "Title",
      {
        body: "x".repeat(6000),
        tag: "t",
        data: '{"url":"/inbox"}',
        icon: "https://example.com/icon.png",
        badge: "javascript:alert(1)",
        dir: "sideways",
        actions: [{ action: "a", title: "A" }, { action: "b", title: "B" }, { action: "c", title: "C" }, "bad"],
        silent: true,
      },
      1000,
    );
    expect(n).toMatchObject({ id: "id1", title: "Title", tag: "t", data: '{"url":"/inbox"}', dir: "auto" });
    expect(n.body).toHaveLength(5000);
    expect(n.icon).toBe("https://example.com/icon.png");
    expect(n.badge).toBe("");
    expect(n.actions.map((a) => a.action)).toEqual(["a", "b"]);
    expect(n.silent).toBe(true);
    expect(n.timestamp).toBe(1000);
    expect(notificationFrom("id2", 42, null, 5)).toMatchObject({ title: "", body: "", data: "null", silent: null });
  });
});
