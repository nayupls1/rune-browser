// The API map for agents: the shapes of the APIs the sites in this tab's
// workspace call, learned from its web tabs (shared/endpoints.ts). It has no
// values, so it's safe to read; to get data, the website agent sends requests
// with replay_request, and an app calls the API from its server.
import { Effect, Schema } from "effect";
import { describeEndpoint } from "../../shared/endpoints";
import { Apps } from "../db/Apps";
import { Endpoints } from "../db/Endpoints";
import { dataTools } from "./output";
import type { ToolEnv } from "./tools";

export const endpointTools = Effect.fn(function* (env: ToolEnv) {
  const endpoints = yield* Endpoints;
  const apps = yield* Apps;
  const data = yield* dataTools(env);
  return [
    data(
      "api_map",
      "The API map of the user's workspace: every endpoint the sites they visit call, learned from their web tabs, with its parameters, request body and response shapes (types only, never values; credentials only by name). Without arguments: the hosts in the map. With host: that host's endpoints. With search: endpoints whose host, path, GraphQL operation or calling site contains the text.",
      Schema.Struct({
        host: Schema.optionalKey(Schema.String.annotate({ description: "An API host, e.g. api.example.com" })),
        search: Schema.optionalKey(Schema.String),
      }),
      ({ host, search }) =>
        Effect.gen(function* () {
          const workspaceId = (yield* apps.get(env.tabId))?.workspaceId;
          if (!workspaceId) return "This tab has no workspace.";
          if (host) {
            const list = yield* endpoints.endpoints(workspaceId, host.trim());
            return list.length
              ? list.map(describeEndpoint).join("\n\n")
              : `Nothing mapped for ${host} yet (the map grows as the user browses the site).`;
          }
          if (search !== undefined) {
            const list = yield* endpoints.search(workspaceId, search, 40);
            return list.length ? list.map(describeEndpoint).join("\n\n") : `No endpoints match "${search}".`;
          }
          const hosts = yield* endpoints.hosts(workspaceId);
          return hosts.length
            ? hosts
                .map(
                  (h) =>
                    `${h.host} · ${h.endpoints} endpoint${h.endpoints === 1 ? "" : "s"} · ${h.requests} requests seen · called from ${h.sites.join(", ")}`,
                )
                .join("\n")
            : "The API map is empty: it fills up as the user browses sites in web tabs (unless it's turned off in Settings).";
        }),
    ),
  ];
});
