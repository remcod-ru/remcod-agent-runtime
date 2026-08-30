import { writeFile } from "node:fs/promises";

import { generateProtocolJsonSchemas } from "../dist/index.js";

const fixtureUrl = new URL(
  "../tests/fixtures/protocol-v1.json",
  import.meta.url,
);
const contents = `${JSON.stringify(generateProtocolJsonSchemas(), null, 2)}\n`;

await writeFile(fixtureUrl, contents, "utf8");
