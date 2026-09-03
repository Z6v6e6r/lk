#!/usr/bin/env node

import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

const REPLACEMENT_BUILDER = "scripts/prepare_piter_atomic_sales_candidate.mjs";

const fail = (message) => {
  throw new Error(message);
};

const parseWorkspace = (argv) => {
  if (argv.length !== 2 || argv[0] !== "--workspace") {
    fail("Usage: node scripts/prepare_tournament_subscription_sales_candidate.mjs --workspace /absolute/external/workspace");
  }
  return argv[1];
};

verifyWorkspace(parseWorkspace(process.argv.slice(2)), { quiet: true });
fail(`Legacy tournament subscription sales builder is retired; use ${REPLACEMENT_BUILDER}. No candidate was written.`);
