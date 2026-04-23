// SpiceDB/Zed Schema Emitter for TypeSpec
// Walks the compiled TypeSpec type graph to produce SpiceDB schema output.
// Uses the TypeSpec compiler API to discover models, relations, and permissions.
//
// Output conventions:
//   - Assignable relations use t_ prefix (e.g. t_workspace, t_binding)
//   - Permissions wrap relations (e.g. permission binding = t_binding)
//   - Wildcards use "any" (e.g. any_any_any, inventory_any_any)
//   - Workspace binding is "binding"
//   - view_metadata accumulates all read-verb v2 permissions
//
// Usage: npx tsx src/spicedb-emitter.ts [schema/main.tsp] [--metadata] [--ir [outpath]] [--lenient-extensions]

import * as fs from "fs";
import { compileAndDiscover } from "./compile-and-discover.js";
import {
  generateSpiceDB,
  generateMetadata,
  generateUnifiedJsonSchemas,
  generateIR,
  path,
} from "./lib.js";
import { expandSchemaWithExtensions } from "./pipeline.js";

async function main() {
  const args = process.argv.slice(2);
  const emitMetadata = args.includes("--metadata");
  const emitUnifiedJsonSchema = args.includes("--unified-jsonschema");
  const emitIR = args.includes("--ir");
  const lenientExtensions = args.includes("--lenient-extensions");
  const mainFile =
    args.find((a) => !a.startsWith("--")) ||
    path.resolve(import.meta.dirname ?? ".", "../schema/main.tsp");
  const resolvedMain = path.resolve(mainFile);

  console.error(`Compiling ${resolvedMain}...`);

  const { resources, extensions, program } = await compileAndDiscover(resolvedMain);
  const { fullSchema, jsonSchemaFields, annotations } = expandSchemaWithExtensions(
    program,
    resources,
    { strict: !lenientExtensions },
  );

  console.error(
    `Discovered ${resources.length} resources, ${extensions.length} V1 extensions, expanded to ${fullSchema.length} resource defs.`,
  );

  if (emitIR) {
    const irIndex = args.indexOf("--ir");
    const nextArg = args[irIndex + 1];
    const outPath = nextArg && !nextArg.startsWith("--")
      ? nextArg
      : path.resolve(import.meta.dirname ?? ".", "../go-consumer/resources.json");
    const ir = generateIR(
      resolvedMain,
      fullSchema,
      extensions,
      jsonSchemaFields,
      annotations,
    );
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(ir, null, 2) + "\n");
    console.error(`Wrote IR to ${outPath}`);
  } else if (emitMetadata) {
    const metadata = generateMetadata(fullSchema, extensions);
    console.log(JSON.stringify(metadata, null, 2));
  } else if (emitUnifiedJsonSchema) {
    const schemas = generateUnifiedJsonSchemas(fullSchema, jsonSchemaFields);
    console.log(JSON.stringify(schemas, null, 2));
  } else {
    const output = generateSpiceDB(fullSchema);

    console.log("// Generated SpiceDB/Zed Schema from TypeSpec type graph");
    console.log("// Produced by walking the compiled TypeSpec program.");
    console.log("");
    console.log(output);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
