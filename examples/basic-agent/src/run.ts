import { runBasicAgent } from "./index.js";

const result = await runBasicAgent();
console.log(JSON.stringify(result.output));
