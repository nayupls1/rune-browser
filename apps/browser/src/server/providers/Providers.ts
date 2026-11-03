// The provider registry: which agents are installed and signed in, their
// models, and the driver to run a turn with. Status is probed in the
// background and pushed to the renderer on the "providers" topic.
import { Context, Effect, Layer } from "effect";
import { providerIds, type ProviderId, type ProviderStatus } from "../../shared/api";
import { topics } from "../../shared/hub";
import { Settings } from "../db/Settings";
import { Hub } from "../Hub";
import { ClaudeDriver } from "./Claude";
import { CodexDriver } from "./Codex";
import { OpenCodeDriver } from "./OpenCode";
import type { ProviderDriver } from "./Provider";

export const drivers: Record<ProviderId, ProviderDriver> = {
  claude: ClaudeDriver,
  codex: CodexDriver,
  opencode: OpenCodeDriver,
};

export interface ProvidersShape {
  /** Current status of every provider (probing ones show "checking"). */
  readonly list: Effect.Effect<ProviderStatus[]>;
  /** Probes again (one provider or all) and returns the new statuses. */
  readonly refresh: (id?: ProviderId) => Effect.Effect<ProviderStatus[]>;
  readonly driver: (id: ProviderId) => ProviderDriver;
}

export class Providers extends Context.Service<Providers, ProvidersShape>()("rune/Providers") {}

export const make = Effect.gen(function* () {
  const settings = yield* Settings;
  const hub = yield* Hub;

  const statuses = new Map<ProviderId, ProviderStatus>(
    providerIds.map((id) => [
      id,
      {
        id,
        label: drivers[id].label,
        enabled: true,
        state: "checking",
        version: null,
        binary: null,
        message: null,
        models: [],
        defaultModel: null,
      },
    ]),
  );
  const inFlight = new Map<ProviderId, Promise<void>>();

  const snapshot = () => providerIds.map((id) => statuses.get(id)!);
  const publish = () => hub.publishUnsafe({ type: "providers", topic: topics.providers, providers: snapshot() });

  const probe = (id: ProviderId) =>
    Effect.gen(function* () {
      const config = (yield* settings.get()).providers[id];
      const driver = drivers[id];
      if (!config.enabled) {
        statuses.set(id, { ...statuses.get(id)!, enabled: false, state: "disabled", message: null });
        return;
      }
      statuses.set(id, { ...statuses.get(id)!, enabled: true, state: "checking" });
      publish();
      const result = yield* driver.probe(config);
      statuses.set(id, { id, label: driver.label, enabled: true, ...result });
    }).pipe(Effect.ensuring(Effect.sync(publish)));

  /** Joins a probe that's already running instead of starting another. */
  const probeOnce = (id: ProviderId) =>
    Effect.promise(() => {
      let running = inFlight.get(id);
      if (!running) {
        running = Effect.runPromise(probe(id)).finally(() => inFlight.delete(id));
        inFlight.set(id, running);
      }
      return running;
    });

  // Probe everything once at startup, in the background.
  yield* Effect.forkDetach(Effect.forEach(providerIds, probeOnce, { concurrency: "unbounded" }));

  return {
    list: Effect.sync(snapshot),
    refresh: (id) =>
      Effect.forEach(id ? [id] : providerIds, probeOnce, { concurrency: "unbounded" }).pipe(Effect.map(snapshot)),
    driver: (id) => drivers[id],
  } satisfies ProvidersShape;
});

export const layer = Layer.effect(Providers, make);
