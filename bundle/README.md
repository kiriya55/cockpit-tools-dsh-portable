# Cockpit Tools DSH provider bundle

Configuration-only Cordis bundle for DSH. It adds `cockpit-tools` through the installed `@deepseek-ai/dsh-llm-pi-ai` adapter using the OpenAI Responses API. The base URL and model list are an initial snapshot; refresh `cordis.patch.yml` with the adjacent `sync-cockpit-models.mjs` script after cockpit-tools catalog changes.

The DSH credential reference is `COCKPIT_TOOLS_API_KEY`; the actual key is never included in this package. See the archive-level README for staging, installation, profile compatibility, and update instructions.
