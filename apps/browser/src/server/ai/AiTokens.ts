// Secret per-app tokens for AI requests. An app gets its token in its
// environment (RUNE_AI_TOKEN); the token is how Rune Browser knows which app asks.
import { Context, Layer } from "effect";

export interface AiTokensShape {
  /** The app's token (created on first use; new ones every server start). */
  readonly tokenFor: (appId: string) => string;
  readonly appFor: (token: string) => string | null;
  readonly revoke: (appId: string) => void;
}

export class AiTokens extends Context.Service<AiTokens, AiTokensShape>()("rune/AiTokens") {}

export const tokensLayer = Layer.sync(AiTokens, (): AiTokensShape => {
  const byApp = new Map<string, string>();
  const byToken = new Map<string, string>();
  return {
    tokenFor: (appId) => {
      let token = byApp.get(appId);
      if (!token) {
        token = `nai_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
        byApp.set(appId, token);
        byToken.set(token, appId);
      }
      return token;
    },
    appFor: (token) => byToken.get(token) ?? null,
    revoke: (appId) => {
      const token = byApp.get(appId);
      if (token) byToken.delete(token);
      byApp.delete(appId);
    },
  };
});
