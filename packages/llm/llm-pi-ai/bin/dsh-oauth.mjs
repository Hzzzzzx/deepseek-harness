#!/usr/bin/env node
/**
 * Entry point for the llm-pi-ai OAuth CLI. Imports the tsc-emitted module
 * directly so it runs from a workspace checkout without an extra build step
 * beyond `npm run build:lib:host`:
 *
 *   node packages/llm/llm-pi-ai/bin/dsh-oauth.mjs login openai-codex
 *   node packages/llm/llm-pi-ai/bin/dsh-oauth.mjs status
 *   node packages/llm/llm-pi-ai/bin/dsh-oauth.mjs logout openai-codex
 */
import { runOAuthCli } from '../lib/types/oauth-cli.js'

process.exitCode = await runOAuthCli(process.argv.slice(2))
