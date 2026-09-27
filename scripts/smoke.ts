import { formatForLLM, runSearchQuery, parseProviderChain } from "../src/search";
const providers = parseProviderChain(process.argv[2] ?? "parallel,exa,duckduckgo");
const query = process.argv.slice(3).join(" ") || "Pi coding agent extension documentation";
try {
  const result = await runSearchQuery({ query, limit: 3 }, { providers, timeoutMs: 25000, onAttempt: id => console.error(`Trying ${id}...`) });
  console.log(formatForLLM(result.response, result.notes));
  if (result.failures.length) console.error("Earlier failures:", result.failures);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Search failed");
  process.exitCode = 1;
}
