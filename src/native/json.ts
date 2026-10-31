import { Option, Schema } from "effect";

// One JSON boundary. Helper CLIs and the hub emit JSON text; the runtime validates it against a schema exactly once
// here and passes typed values inward. Malformed JSON and a schema mismatch both yield `None`, so the runtime maps a
// bad helper response to a typed device error instead of throwing through a parse.
export function parseJson<T>(schema: Schema.Codec<T>, text: string): Option.Option<T> {
  return Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text);
}
