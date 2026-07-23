import { createLogger } from "agent-archive-core";
import { getEnv } from "./env.ts";
const logger = createLogger({
  prefix: "[acrag]",
  quiet: () => getEnv().ACRAG_QUIET,
  verbose: () => !!getEnv().ACRAG_VERBOSE,
});
export const info = logger.info;
export const warn = logger.warn;
export const error = logger.error;
export const verbose = logger.verbose;
