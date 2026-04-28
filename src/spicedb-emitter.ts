// Kessel Schema Emitter
// Single entry point: compiles TypeSpec, discovers resources and permissions,
// expands V1 permissions, and emits the requested output format.
//
// Usage: npx tsx src/spicedb-emitter.ts [schema/main.tsp] [--metadata] [--ir [outpath]] [--unified-jsonschema]

import * as fs from "fs";
import {
  compile,
  NodeHost,
  discoverResources,
  generateSpiceDB,
  generateMetadata,
  generateUnifiedJsonSchemas,
  generateIR,
  path,
} from "./lib.js";
import {
  discoverV1Permissions,
  discoverAnnotations,
  expandV1Permissions,
} from "./expand.js";

async function main() {
  const args = process.argv.slice(2);
  const mainFile = args.find((a) => !a.startsWith("--")) ||
    path.resolve(import.meta.dirname ?? ".", "../schema/main.tsp");
  const resolvedMain = path.resolve(mainFile);

  console.error(`Compiling ${resolvedMain}...`);

  const program = await compile(NodeHost, resolvedMain, { noEmit: true });
  const hasErrors = program.diagnostics.some((d) => d.severity === "error");
  if (hasErrors) {
    const msgs = program.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
    throw new Error(`Compilation failed:\n${msgs.join("\n")}`);
  }

  const { resources } = discoverResources(program);
  const permissions = discoverV1Permissions(program);
  const annotations = discoverAnnotations(program);
  const fullSchema = expandV1Permissions(resources, permissions);

  console.error(
    `Discovered ${resources.length} resources, ${permissions.length} V1 extensions, expanded to ${fullSchema.length} resource defs.`,
  );

  if (args.includes("--ir")) {
    const irIndex = args.indexOf("--ir");
    const nextArg = args[irIndex + 1];
    const outPath = nextArg && !nextArg.startsWith("--")
      ? nextArg
      : path.resolve(import.meta.dirname ?? ".", "../go-consumer/resources.json");
    const ir = generateIR(resolvedMain, fullSchema, permissions, annotations);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(ir, null, 2) + "\n");
    console.error(`Wrote IR to ${outPath}`);
  } else if (args.includes("--metadata")) {
    console.log(JSON.stringify(generateMetadata(fullSchema, permissions), null, 2));
  } else if (args.includes("--unified-jsonschema")) {
    console.log(JSON.stringify(generateUnifiedJsonSchemas(fullSchema), null, 2));
  } else {
    console.log("// Generated SpiceDB/Zed Schema from TypeSpec type graph");
    console.log("// Produced by walking the compiled TypeSpec program.");
    console.log("");
    console.log(generateSpiceDB(fullSchema));
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
