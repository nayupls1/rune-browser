// The user's settings: one JSON document, decoded with defaults on read.
import { Context, Effect, Layer, PubSub, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { decodeSettings, type Settings as SettingsValue } from "../../shared/settings";
import { orDieAll, type OrDie } from "./Db";

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<SettingsValue>();

  const read = sql<{ value: string }>`SELECT value FROM settings WHERE id = 1`.pipe(
    Effect.map((rows) => {
      try {
        return decodeSettings(rows[0] ? JSON.parse(rows[0].value) : {});
      } catch {
        return decodeSettings({});
      }
    }),
  );

  return {
    /** The user's settings, with defaults for anything unset or invalid. */
    get: () => read,
    save: (settings: SettingsValue) =>
      sql`INSERT INTO settings (id, value) VALUES (1, ${JSON.stringify(settings)})
          ON CONFLICT (id) DO UPDATE SET value = excluded.value`.pipe(
        Effect.andThen(PubSub.publish(changes, settings)),
        Effect.asVoid,
      ),
    /** Emits the settings whenever they're saved. */
    changes: () => Effect.succeed(Stream.fromPubSub(changes)),
  };
});

export class Settings extends Context.Service<Settings, OrDie<Effect.Success<typeof make>>>()("rune/Settings") {}

export const layer = Layer.effect(Settings, Effect.map(make, orDieAll));
