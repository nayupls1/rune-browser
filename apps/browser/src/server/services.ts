// All of the server's services, wired together. The HTTP server (index.ts)
// and the tests build on this.
import { Layer } from "effect";
import * as Agent from "./agent/Agent";
import * as Mcp from "./agent/Mcp";
import { ServerConfig, type ServerConfigShape } from "./Config";
import * as Bookmarks from "./bookmarks/Bookmarks";
import * as Apps from "./db/Apps";
import * as Db from "./db/Db";
import * as Endpoints from "./db/Endpoints";
import * as Network from "./db/Network";
import * as ResponseOverrides from "./db/ResponseOverrides";
import * as PageChanges from "./db/PageChanges";
import * as Settings from "./db/Settings";
import * as Sites from "./db/Sites";
import * as Visits from "./db/Visits";
import * as Workspaces from "./db/Workspaces";
import * as History from "./history/History";
import * as Hub from "./Hub";
import * as Mods from "./mods/Mods";
import * as Providers from "./providers/Providers";
import * as Scheduler from "./scheduler/Scheduler";
import * as Audit from "./security/Audit";
import * as Permissions from "./security/Permissions";
import * as Sources from "./sources/Sources";
import * as Tabs from "./Tabs";
import * as Attachments from "./agent/Attachments";
import * as ChatFiles from "./agent/ChatFiles";
import * as Jobs from "./agent/Jobs";

/** Everything but the agents: storage, security, tabs and history (enough for most tests). */
export const core = (config: ServerConfigShape) =>
  Layer.mergeAll(Tabs.layer, Mods.layer).pipe(
    Layer.provideMerge(Scheduler.layer),
    Layer.provideMerge(History.layer),
    Layer.provideMerge(Layer.mergeAll(Sources.layer, Attachments.layer, Jobs.layer)),
    Layer.provideMerge(ChatFiles.layer),
    Layer.provideMerge(Permissions.layer),
    Layer.provideMerge(Layer.mergeAll(Audit.layer, Bookmarks.layer)),
    Layer.provideMerge(
      Layer.mergeAll(
        Apps.layer,
        Workspaces.layer,
        Settings.layer,
        Sites.layer,
        PageChanges.layer,
        Network.layer,
        ResponseOverrides.layer,
        Endpoints.layer,
        Visits.layer,
        Hub.layer,
      ),
    ),
    Layer.provideMerge(Db.layer),
    Layer.provideMerge(Layer.succeed(ServerConfig, config)),
  );

export const services = (config: ServerConfigShape) =>
  Agent.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(Providers.layer, Mcp.layer(config.url))),
    Layer.provideMerge(core(config)),
  );
